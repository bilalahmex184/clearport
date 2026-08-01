#!/usr/bin/env bun
// ============================================================================
// scripts/migrate-storage-objects.ts — Phase 6 Step 2c
// ============================================================================
// Migrates an org's document files from the OLD Supabase project's
// `documents` Storage bucket to the NEW project's `documents` bucket,
// re-keying from the broken `{user_id}/...` convention (Issue #39) to the
// corrected `{org_id}/{shipment_id}/{uuid}-{sanitized}` convention.
//
// WHAT IT DOES (high level)
//   1. Lists documents for this org from the OLD project's `documents` table
//      (id, storage_path, file_name, shipment_id).
//   2. For each document:
//      a. Builds the NEW storage key via buildStorageKey(orgId, shipmentId,
//         fileName) — the corrected org_id-scoped convention.
//      b. HEADs the NEW bucket: if the object already exists at the new key
//         AND its hash matches the OLD object's hash, skip (idempotent).
//      c. Downloads the OLD object (service-role bypasses RLS).
//      d. Uploads to the NEW bucket under the corrected key.
//      e. Re-downloads from NEW + compares SHA-256 against the original.
//         If they match, PATCHes the documents row with the new storage_path.
//         If they don't, logs an error + leaves the DB row pointing at the
//         OLD path so the operator can investigate.
//
// USAGE
//   bun run scripts/migrate-storage-objects.ts <orgId> [--dry-run]
//
// ENV
//   OLD_SUPABASE_URL, OLD_SUPABASE_SERVICE_ROLE_KEY
//   NEW_SUPABASE_URL, NEW_SUPABASE_SERVICE_ROLE_KEY
//
// PROPERTIES
//   - Reusable, resumable (idempotent per-object via HEAD + hash check).
//   - Operator-side: runs from Node/Bun, NOT in a Worker.
//   - Never logs secrets: service-role keys come from env, never echoed.
//   - Byte-for-byte integrity: SHA-256 of original vs. re-downloaded.
//   - Error isolation: a failure on one object doesn't abort the rest.
// ============================================================================

import { buildStorageKey } from '../packages/shared/src/storage';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MigrateStorageObjectsOpts {
  orgId: string;
  oldSupabaseUrl: string;
  oldServiceRoleKey: string;
  newSupabaseUrl: string;
  newServiceRoleKey: string;
  dryRun?: boolean;
}

export interface MigrateStorageObjectsResult {
  copied: number;
  verified: number;
  failed: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Document row shape (subset of fields we need)
// ---------------------------------------------------------------------------

interface DocumentRow {
  id: string;
  storage_path: string;
  file_name: string;
  shipment_id: string;
}

// ---------------------------------------------------------------------------
// Auth header helper
// ---------------------------------------------------------------------------

function authHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

// ---------------------------------------------------------------------------
// Storage REST helpers
// ---------------------------------------------------------------------------

/**
 * Check if an object exists at the given key in the NEW project's documents
 * bucket. Returns true iff the HEAD request returns 200.
 */
async function headObject(
  supabaseUrl: string,
  serviceRoleKey: string,
  key: string,
): Promise<boolean> {
  // Encode the key's path segments but preserve the slashes that separate
  // them. Supabase Storage accepts the unencoded slash in the path.
  const url = `${supabaseUrl}/storage/v1/object/documents/${key}`;
  const res = await fetch(url, {
    method: 'HEAD',
    headers: authHeaders(serviceRoleKey),
  });
  return res.status === 200;
}

/**
 * Download an object's bytes from the documents bucket.
 */
async function downloadObject(
  supabaseUrl: string,
  serviceRoleKey: string,
  key: string,
): Promise<Uint8Array> {
  const url = `${supabaseUrl}/storage/v1/object/documents/${key}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: authHeaders(serviceRoleKey),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Download ${key} failed: ${res.status} ${text}`);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Upload bytes to the documents bucket at the given key.
 * `x-upsert: true` lets us overwrite if the object somehow already exists
 * (defensive — the HEAD pre-check should normally skip this case).
 */
async function uploadObject(
  supabaseUrl: string,
  serviceRoleKey: string,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const url = `${supabaseUrl}/storage/v1/object/documents/${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(serviceRoleKey),
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    // Cast to BodyInit: lib.dom.d.ts is strict about Uint8Array vs.
    // ArrayBuffer, but fetch accepts both at runtime (Node 18+ + Bun).
    body: bytes as BodyInit,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upload ${key} failed: ${res.status} ${text}`);
  }
}

/**
 * PATCH the documents row in the NEW project with the corrected
 * storage_path. Idempotent: re-PATCHing the same value is a no-op.
 */
async function updateDocumentStoragePath(
  supabaseUrl: string,
  serviceRoleKey: string,
  documentId: string,
  newStoragePath: string,
): Promise<void> {
  const url = `${supabaseUrl}/rest/v1/documents?id=eq.${encodeURIComponent(documentId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...authHeaders(serviceRoleKey),
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ storage_path: newStoragePath }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PATCH documents ${documentId} failed: ${res.status} ${text}`);
  }
}

/**
 * List documents for this org from a Supabase project.
 */
async function listDocuments(
  supabaseUrl: string,
  serviceRoleKey: string,
  orgId: string,
): Promise<DocumentRow[]> {
  const url =
    `${supabaseUrl}/rest/v1/documents` +
    `?select=id,storage_path,file_name,shipment_id` +
    `&org_id=eq.${encodeURIComponent(orgId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...authHeaders(serviceRoleKey), Range: '0-999999' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`List documents failed: ${res.status} ${text}`);
  }
  return (await res.json()) as DocumentRow[];
}

// ---------------------------------------------------------------------------
// SHA-256 helper (exposed for testability)
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hash of `bytes` and return it as a lowercase hex
 * string. Uses the Web Crypto API (`crypto.subtle.digest`).
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer — some fetch implementations return a
  // view onto a detachable buffer that subtle.digest can't read directly.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', ab);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

export async function migrateStorageObjects(
  opts: MigrateStorageObjectsOpts,
): Promise<MigrateStorageObjectsResult> {
  const { orgId, dryRun } = opts;
  let copied = 0;
  let verified = 0;
  let failed = 0;
  const errors: string[] = [];

  // Dry-run: log the plan and exit without any API calls (no list, no HEAD,
  // no download/upload). The operator runs the real thing to see the count.
  if (dryRun) {
    console.log(
      `[dry-run] Would copy storage objects for org ${orgId} ` +
      `from ${opts.oldSupabaseUrl} → ${opts.newSupabaseUrl}.`,
    );
    console.log(
      `[dry-run] Re-keying convention: ` +
      `{user_id}/{shipment_id}/{filename} → ` +
      `{org_id}/{shipment_id}/{uuid}-{sanitized_filename}`,
    );
    return { copied: 0, verified: 0, failed: 0, errors: [] };
  }

  // 1. List documents for this org from OLD.
  const documents = await listDocuments(
    opts.oldSupabaseUrl,
    opts.oldServiceRoleKey,
    orgId,
  );
  console.log(`[migrate] Found ${documents.length} documents for org ${orgId}.`);

  // 2. For each document: download from OLD, upload to NEW, verify, update DB.
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const progressTag = `[${i + 1}/${documents.length}]`;
    try {
      // Build the NEW storage key using the corrected org_id-scoped
      // convention (Issue #39 fix).
      const newKey = buildStorageKey(orgId, doc.shipment_id, doc.file_name);

      // ---- Idempotency: HEAD the new key. If the object is already there
      //      AND its hash matches the OLD object's hash, skip (already
      //      migrated in a prior run).
      const exists = await headObject(
        opts.newSupabaseUrl,
        opts.newServiceRoleKey,
        newKey,
      );

      if (exists) {
        // Verify the existing object's hash matches what we'd expect from
        // the OLD source. This catches partial/corrupt prior migrations.
        const newBytes = await downloadObject(
          opts.newSupabaseUrl,
          opts.newServiceRoleKey,
          newKey,
        );
        const oldBytes = await downloadObject(
          opts.oldSupabaseUrl,
          opts.oldServiceRoleKey,
          doc.storage_path,
        );
        const newHash = await sha256Hex(newBytes);
        const oldHash = await sha256Hex(oldBytes);
        if (newHash === oldHash) {
          console.log(`${progressTag} [skip] ${doc.id}: already at ${newKey} (hash matches).`);
          continue;
        }
        // Hash mismatch on existing object — log + fall through to re-upload.
        const msg = `${doc.id}: existing object at ${newKey} has hash mismatch ` +
          `(old=${oldHash.slice(0, 12)}, new=${newHash.slice(0, 12)}); re-uploading.`;
        console.warn(`${progressTag} [warn] ${msg}`);
      }

      // ---- Full migration: download OLD, upload NEW, verify, PATCH DB.
      const oldBytes = await downloadObject(
        opts.oldSupabaseUrl,
        opts.oldServiceRoleKey,
        doc.storage_path,
      );
      const oldHash = await sha256Hex(oldBytes);

      await uploadObject(
        opts.newSupabaseUrl,
        opts.newServiceRoleKey,
        newKey,
        oldBytes,
        'application/octet-stream',
      );
      copied++;

      // Verify: re-download from NEW + compare SHA-256.
      const newBytes = await downloadObject(
        opts.newSupabaseUrl,
        opts.newServiceRoleKey,
        newKey,
      );
      const newHash = await sha256Hex(newBytes);

      if (newHash === oldHash) {
        verified++;
        // Update the documents row with the corrected storage_path so the
        // consumer Worker can find the file at the new key.
        await updateDocumentStoragePath(
          opts.newSupabaseUrl,
          opts.newServiceRoleKey,
          doc.id,
          newKey,
        );
        console.log(`${progressTag} [ok] ${doc.id}: copied + verified (${newKey}).`);
      } else {
        failed++;
        const msg =
          `${doc.id}: hash mismatch after upload ` +
          `(old=${oldHash.slice(0, 12)}, new=${newHash.slice(0, 12)}) ` +
          `— DB row NOT updated (storage_path still points at OLD key).`;
        errors.push(msg);
        console.error(`${progressTag} [error] ${msg}`);
        // Intentionally do NOT update the DB row: leave the old (broken)
        // storage_path so the operator can investigate the corruption.
      }

      // Progress every 25 docs.
      if ((i + 1) % 25 === 0) {
        console.log(
          `[progress] ${i + 1}/${documents.length} processed ` +
          `(copied=${copied}, verified=${verified}, failed=${failed}).`,
        );
      }
    } catch (err: any) {
      failed++;
      const msg = `${doc.id}: ${err?.message || String(err)}`;
      errors.push(msg);
      console.error(`${progressTag} [error] ${msg}`);
    }
  }

  return { copied, verified, failed, errors };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const orgId = args.find(a => !a.startsWith('--'));
  if (!orgId) {
    console.error('Usage: bun run scripts/migrate-storage-objects.ts <orgId> [--dry-run]');
    process.exit(1);
  }

  const oldUrl = process.env.OLD_SUPABASE_URL;
  const oldKey = process.env.OLD_SUPABASE_SERVICE_ROLE_KEY;
  const newUrl = process.env.NEW_SUPABASE_URL;
  const newKey = process.env.NEW_SUPABASE_SERVICE_ROLE_KEY;

  if (!oldUrl || !oldKey || !newUrl || !newKey) {
    console.error(
      'Missing required env vars: OLD_SUPABASE_URL, OLD_SUPABASE_SERVICE_ROLE_KEY, ' +
      'NEW_SUPABASE_URL, NEW_SUPABASE_SERVICE_ROLE_KEY',
    );
    process.exit(1);
  }

  const result = await migrateStorageObjects({
    orgId,
    oldSupabaseUrl: oldUrl,
    oldServiceRoleKey: oldKey,
    newSupabaseUrl: newUrl,
    newServiceRoleKey: newKey,
    dryRun,
  });

  console.log('\n============================================');
  console.log('Storage objects migration summary');
  console.log('============================================');
  console.log(`  copied:    ${result.copied}`);
  console.log(`  verified:  ${result.verified}`);
  console.log(`  failed:    ${result.failed}`);
  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    for (const e of result.errors) console.log(`  - ${e}`);
  }
  process.exit(result.failed > 0 ? 1 : 0);
}

// Run only when invoked directly (not when imported by tests).
const isMain = (() => {
  try {
    return (
      !process.env.VITEST &&
      !!process.argv[1]?.endsWith('migrate-storage-objects.ts')
    );
  } catch {
    return false;
  }
})();
if (isMain) main();

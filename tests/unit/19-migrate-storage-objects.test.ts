// ============================================================================
// 19-migrate-storage-objects.test.ts — Phase 6 Step 2c
// ============================================================================
// Unit tests for scripts/migrate-storage-objects.ts.
//
// Verifies:
//   1. Downloads from OLD + uploads to NEW.
//   2. Re-keys from {user_id}/... to {org_id}/{shipment_id}/{uuid}-{sanitized}.
//   3. Verifies byte-for-byte integrity (SHA-256 hash comparison).
//   4. Updates the documents row with the new storage_path.
//   5. Idempotent — skips objects already at the new key (HEAD + hash match).
//   6. Dry-run mode makes no API calls.
//   7. A hash mismatch is logged as an error (not silently passed).
//
// Strategy: mock `globalThis.fetch` to emulate the Supabase Storage REST API
// (HEAD/GET/POST on /storage/v1/object/documents/<key>) + the PostgREST
// documents table (GET list, PATCH update). Mock `crypto.subtle.digest` so
// we can deterministically produce matching or mismatching hashes.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrateStorageObjects } from '../../scripts/migrate-storage-objects';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = '550e8400-e29b-41d4-a716-446655440000';
const SHIPMENT_ID = 'SHIP-2026-8802';
const OLD_USER = '11111111-1111-1111-1111-111111111111';
const DOC_ID = '33333333-3333-3333-3333-333333333333';
const OLD_STORAGE_PATH = `${OLD_USER}/${SHIPMENT_ID}/invoice.pdf`;
const FILE_NAME = 'invoice.pdf';

const OLD_URL = 'https://old-supabase.test';
const NEW_URL = 'https://new-supabase.test';
const OLD_KEY = 'old-service-role-key';
const NEW_KEY = 'new-service-role-key';

const BASE_OPTS = {
  orgId: ORG_ID,
  oldSupabaseUrl: OLD_URL,
  oldServiceRoleKey: OLD_KEY,
  newSupabaseUrl: NEW_URL,
  newServiceRoleKey: NEW_KEY,
};

/** Stable test bytes — content doesn't matter, only that we can hash + compare. */
const OLD_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, ...new Array(56).fill(0x20)]);

/** The new-key format the script should produce: `{orgId}/{shipmentId}/{uuid}-{sanitized}`. */
const NEW_KEY_REGEX = new RegExp(
  `^${ORG_ID}/${SHIPMENT_ID}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-${FILE_NAME}$`,
);

// ---------------------------------------------------------------------------
// Mock fetch helper — emulates Supabase Storage + PostgREST for documents
// ---------------------------------------------------------------------------

interface MockConfig {
  /** What the HEAD request for the NEW key should return: 200 (exists) or 404 (missing). */
  headStatus?: number;
  /** Bytes returned when downloading from OLD. */
  oldBytes?: Uint8Array;
  /** Bytes returned when downloading from NEW (for verification). Defaults to oldBytes. */
  newBytesOnVerify?: Uint8Array;
  /** Whether the POST upload should succeed. Default true. */
  uploadOk?: boolean;
}

interface MockState {
  calls: Array<{ url: string; method: string; body?: any }>;
  uploadedKeys: string[];
  patchedDocs: Array<{ id: string; storage_path: string }>;
}

function makeMockFetch(cfg: MockConfig, state: MockState) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const method = (init?.method || 'GET').toUpperCase();
    state.calls.push({ url: u, method, body: init?.body });

    // --- OLD project: list documents for this org ---
    if (u.startsWith(OLD_URL) && u.includes('/rest/v1/documents') && method === 'GET') {
      const docs = [
        {
          id: DOC_ID,
          storage_path: OLD_STORAGE_PATH,
          file_name: FILE_NAME,
          shipment_id: SHIPMENT_ID,
        },
      ];
      return new Response(JSON.stringify(docs), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- OLD project: download object bytes ---
    if (u.startsWith(OLD_URL) && u.includes('/storage/v1/object/documents/') && method === 'GET') {
      const bytes = cfg.oldBytes ?? OLD_BYTES;
      return new Response(bytes, { status: 200 });
    }

    // --- NEW project: HEAD on new key ---
    if (u.startsWith(NEW_URL) && u.includes('/storage/v1/object/documents/') && method === 'HEAD') {
      const status = cfg.headStatus ?? 404;
      return new Response(null, { status });
    }

    // --- NEW project: POST upload ---
    if (u.startsWith(NEW_URL) && u.includes('/storage/v1/object/documents/') && method === 'POST') {
      if (cfg.uploadOk === false) {
        return new Response('upload failed', { status: 500 });
      }
      // Extract the new key from the URL.
      const key = u.replace(/^.*\/storage\/v1\/object\/documents\//, '');
      state.uploadedKeys.push(key);
      return new Response(JSON.stringify({ Key: key }), { status: 200 });
    }

    // --- NEW project: GET (verify re-download after upload) ---
    if (u.startsWith(NEW_URL) && u.includes('/storage/v1/object/documents/') && method === 'GET') {
      const bytes = cfg.newBytesOnVerify ?? cfg.oldBytes ?? OLD_BYTES;
      return new Response(bytes, { status: 200 });
    }

    // --- NEW project: PATCH documents row ---
    if (u.startsWith(NEW_URL) && u.includes('/rest/v1/documents') && method === 'PATCH') {
      const idMatch = u.match(/id=eq\.([^&]+)/);
      const id = idMatch ? decodeURIComponent(idMatch[1]) : '';
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      state.patchedDocs.push({ id, storage_path: body.storage_path });
      return new Response(null, { status: 204 });
    }

    return new Response('not found', { status: 404 });
  };
}

// Track the original digest so we can delegate to it for real hashing.
const realDigest = crypto.subtle.digest.bind(crypto.subtle);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrate-storage-objects (Phase 6 Step 2c)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Restore real digest by default; individual tests can spy if they want.
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (alg, data) => {
      return realDigest(alg, data as ArrayBuffer);
    });
  });

  // -------------------------------------------------------------------------
  // 1. Downloads from OLD + uploads to NEW
  // -------------------------------------------------------------------------
  it('downloads from OLD project + uploads to NEW project', async () => {
    const state: MockState = { calls: [], uploadedKeys: [], patchedDocs: [] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeMockFetch({ headStatus: 404, oldBytes: OLD_BYTES }, state),
    );

    const result = await migrateStorageObjects(BASE_OPTS);

    // Verify a GET was made to the OLD storage path.
    const oldDownload = state.calls.find(
      c => c.method === 'GET' && c.url.includes(OLD_URL) && c.url.includes(OLD_STORAGE_PATH),
    );
    expect(oldDownload).toBeDefined();

    // Verify a POST (upload) was made to the NEW project.
    const newUpload = state.calls.find(
      c => c.method === 'POST' && c.url.startsWith(NEW_URL),
    );
    expect(newUpload).toBeDefined();

    expect(result.copied).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 2. Re-keys from {user_id}/... to {org_id}/{shipment_id}/{uuid}-{sanitized}
  // -------------------------------------------------------------------------
  it('re-keys from {user_id}/... to {org_id}/{shipment_id}/{uuid}-{sanitized}', async () => {
    const state: MockState = { calls: [], uploadedKeys: [], patchedDocs: [] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeMockFetch({ headStatus: 404, oldBytes: OLD_BYTES }, state),
    );

    await migrateStorageObjects(BASE_OPTS);

    expect(state.uploadedKeys.length).toBe(1);
    const uploadedKey = state.uploadedKeys[0];

    // The OLD key started with the user_id; the NEW key must start with the org_id.
    expect(uploadedKey.startsWith(`${ORG_ID}/`)).toBe(true);
    expect(uploadedKey.startsWith(`${OLD_USER}/`)).toBe(false);

    // The NEW key must match the corrected convention.
    expect(uploadedKey).toMatch(NEW_KEY_REGEX);

    // The PATCH must have written the new key (not the old user_id-scoped path).
    expect(state.patchedDocs.length).toBe(1);
    expect(state.patchedDocs[0].storage_path).toBe(uploadedKey);
    expect(state.patchedDocs[0].storage_path).not.toBe(OLD_STORAGE_PATH);
  });

  // -------------------------------------------------------------------------
  // 3. Verifies byte-for-byte integrity (SHA-256 hash comparison)
  // -------------------------------------------------------------------------
  it('verifies byte-for-byte integrity via SHA-256 hash comparison', async () => {
    const state: MockState = { calls: [], uploadedKeys: [], patchedDocs: [] };
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (alg, data) => {
      return realDigest(alg, data as ArrayBuffer);
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeMockFetch({ headStatus: 404, oldBytes: OLD_BYTES, newBytesOnVerify: OLD_BYTES }, state),
    );

    await migrateStorageObjects(BASE_OPTS);

    // digest() should have been called at least twice:
    //   - once for the OLD bytes (pre-upload hash)
    //   - once for the NEW bytes (post-upload verification)
    expect(digestSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The first call hashed the OLD bytes; the second hashed the NEW bytes
    // (which we set to equal OLD_BYTES, so the hashes match → verified).
    const firstData = new Uint8Array(digestSpy.mock.calls[0][1] as ArrayBuffer);
    const secondData = new Uint8Array(digestSpy.mock.calls[1][1] as ArrayBuffer);
    expect(Array.from(firstData)).toEqual(Array.from(OLD_BYTES));
    expect(Array.from(secondData)).toEqual(Array.from(OLD_BYTES));
  });

  // -------------------------------------------------------------------------
  // 4. Updates the documents row with the new storage_path
  // -------------------------------------------------------------------------
  it('updates the documents row in NEW with the corrected storage_path', async () => {
    const state: MockState = { calls: [], uploadedKeys: [], patchedDocs: [] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeMockFetch({ headStatus: 404, oldBytes: OLD_BYTES }, state),
    );

    await migrateStorageObjects(BASE_OPTS);

    // A PATCH must have been made to /rest/v1/documents?id=eq.<docId>.
    const patchCall = state.calls.find(c => c.method === 'PATCH' && c.url.includes('/rest/v1/documents'));
    expect(patchCall).toBeDefined();
    expect(patchCall!.url).toContain(`id=eq.${DOC_ID}`);

    const body = JSON.parse(patchCall!.body as string);
    expect(body.storage_path).toMatch(NEW_KEY_REGEX);
  });

  // -------------------------------------------------------------------------
  // 5. Idempotent — skips objects already at the new key
  // -------------------------------------------------------------------------
  it('is idempotent — skips objects already at the new key (HEAD 200 + hash match)', async () => {
    const state: MockState = { calls: [], uploadedKeys: [], patchedDocs: [] };
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      // HEAD returns 200 (exists); NEW bytes equal OLD bytes (hash matches).
      makeMockFetch({ headStatus: 200, oldBytes: OLD_BYTES, newBytesOnVerify: OLD_BYTES }, state),
    );

    const result = await migrateStorageObjects(BASE_OPTS);

    // No upload should have happened.
    expect(state.uploadedKeys.length).toBe(0);
    const posts = state.calls.filter(c => c.method === 'POST');
    expect(posts.length).toBe(0);

    // No PATCH should have happened either (idempotent skip = no DB write).
    expect(state.patchedDocs.length).toBe(0);

    // copied/verified/failed all zero — skipped.
    expect(result.copied).toBe(0);
    expect(result.verified).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 6. Dry-run mode makes no API calls
  // -------------------------------------------------------------------------
  it('dry-run mode makes no API calls', async () => {
    const state: MockState = { calls: [], uploadedKeys: [], patchedDocs: [] };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeMockFetch({ headStatus: 404, oldBytes: OLD_BYTES }, state),
    );

    const result = await migrateStorageObjects({ ...BASE_OPTS, dryRun: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.copied).toBe(0);
    expect(result.verified).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 7. A hash mismatch is logged as an error, not silently passed
  // -------------------------------------------------------------------------
  it('hash mismatch after upload is logged as an error (not silently passed)', async () => {
    const state: MockState = { calls: [], uploadedKeys: [], patchedDocs: [] };
    // OLD bytes vs. NEW bytes differ → hash mismatch.
    const CORRUPT_NEW_BYTES = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeMockFetch(
        {
          headStatus: 404,
          oldBytes: OLD_BYTES,
          newBytesOnVerify: CORRUPT_NEW_BYTES,
        },
        state,
      ),
    );

    const result = await migrateStorageObjects(BASE_OPTS);

    // Upload happened (we tried to migrate), but verification failed.
    expect(result.copied).toBe(1);
    expect(result.verified).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/hash mismatch/i);

    // The DB row MUST NOT have been updated with the new (corrupt) path.
    expect(state.patchedDocs.length).toBe(0);
  });
});

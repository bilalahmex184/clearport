// ============================================================================
// packages/shared/src/storage.ts — Supabase Storage authorization helper
// ============================================================================
//
// WHY THIS FILE EXISTS (Issue #39)
// --------------------------------
// The legacy Supabase project had a Storage RLS policy scoped to `user_id`:
//
//     auth.uid()::text = (storage.foldername(name))[1]
//
// …but the live upload code stored files under `{org_id}/{shipment_id}/{filename}`.
// That mismatch silently broke cross-org isolation: a user in Org A could read
// a file that was "owned" by their `user_id` on paper but actually belonged to
// Org B's tenant namespace. Migration 001 moved DB RLS to `org_id` via
// `is_org_member()`, but the Storage bucket policy in migration 000 still
// scopes by `auth.uid()` — the convention fix lives here, in code, by making
// every storage key START with the org_id and validating it before any signed
// URL is minted.
//
// THE CONVENTION FIX
// ------------------
// Every storage key in ClearPort MUST follow:
//
//     {org_id}/{shipment_id}/{uuid}-{sanitizedFileName}
//
//   - `org_id`           UUID v4 (validated) — the tenant boundary.
//   - `shipment_id`      matches /^[a-zA-Z0-9_-]+$/ — no slashes, no `../`,
//                        no spaces, no special chars.
//   - `uuid`             fresh `crypto.randomUUID()` — prevents filename
//                        collisions and hides the original filename from
//                        URL scrapers.
//   - `sanitizedFileName` path separators, `..`, and non-allowlist chars
//                        stripped — defense-in-depth against path traversal
//                        in case a downstream consumer ever forgets to call
//                        `parseStorageKey` first.
//
// VALIDATION ORDER (CRITICAL — do not reorder)
// --------------------------------------------
// 1. STRUCTURE FIRST — `parseStorageKey(key)` validates the key shape and the
//    org_id / shipment_id segments BEFORE any DB query is issued. This makes
//    malformed-key attacks cheap to reject and prevents leaking org-membership
//    information through timing or error-message differences.
// 2. MEMBERSHIP SECOND — only after the key is structurally valid do we query
//    `organization_members` to confirm the caller belongs to the key's org.
//    This is the authz gate: a valid key for Org B does NOT grant access to a
//    caller from Org A.
// 3. SIGNED URL LAST — `client.storage.from('documents').createSignedUrl()`
//    is called only once both checks pass.
//
// SINGLE SOURCE OF TRUTH
// ----------------------
// This module is the ONLY place in the monorepo that constructs or parses
// storage keys. Both the Next.js app (Phase 2) and the Cloudflare Workers
// (Phase 3) import from here. Do NOT inline key construction in route
// handlers, edge functions, or workers — call `buildStorageKey` /
// `parseStorageKey` instead. Uses only Web-standard APIs (no Node `fs` /
// `path`) so it runs unchanged in Node 18+, browsers, and Workers.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Strict UUID v4 regex. Validates the canonical 8-4-4-4-12 hex format with
 * the version (4) and variant (8/9/a/b) nibbles in the correct positions.
 * Case-insensitive.
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Safe shipment_id character class: alphanumeric, underscore, hyphen only.
 * Rejects slashes, spaces, dots, and any special chars that could break out
 * of the storage key's second path segment.
 */
const SHIPMENT_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Allowlist for sanitized filenames. After stripping path separators and
 * parent-dir references, any remaining char outside this set is removed.
 */
const SAFE_FILENAME_ALLOWLIST = /[^a-zA-Z0-9._-]/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The three structured parts of a ClearPort storage key.
 * Returned by `parseStorageKey`.
 */
export interface StorageKeyParts {
  /** UUID v4 of the owning organization (the tenant boundary). */
  orgId: string;
  /** Human-readable shipment id matching /^[a-zA-Z0-9_-]+$/. */
  shipmentId: string;
  /** The third path segment: `{uuid}-{sanitizedFileName}`. */
  fileName: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Returns true iff `value` is a string matching the canonical UUID v4 format.
 *
 * Rejects:
 *   - non-strings (null / undefined cast to string at the call site)
 *   - empty strings
 *   - wrong-version UUIDs (e.g. v1, v3, v5)
 *   - non-hex characters in any nibble
 *   - wrong variant nibble (not in [89ab])
 *
 * @example
 *   isValidUUID('550e8400-e29b-41d4-a716-446655440000') // true
 *   isValidUUID('not-a-uuid')                            // false
 *   isValidUUID(null as unknown as string)               // false
 */
export function isValidUUID(value: string): boolean {
  return typeof value === 'string' && UUID_V4_REGEX.test(value);
}

/**
 * Returns true iff `value` matches the safe shipment_id character class
 * (alphanumeric + underscore + hyphen, at least one char).
 */
function isValidShipmentId(value: unknown): value is string {
  return typeof value === 'string' && SHIPMENT_ID_REGEX.test(value);
}

/**
 * Sanitize a user-supplied filename for inclusion in a storage key.
 *
 * Strips, in order:
 *   1. Path separators (`/` and `\`) — prevents segment injection.
 *   2. Parent-dir references (`..`) — prevents traversal even if a separator
 *      slips through downstream.
 *   3. Any char not in `[a-zA-Z0-9._-]` — defense-in-depth allowlist.
 *
 * Never throws. Returns the sanitized string (may be empty if the input was
 * all-special-chars).
 *
 * @example
 *   sanitizeFileName('../../../etc/passwd') // 'etcpasswd'
 *   sanitizeFileName('normal-invoice.pdf')  // 'normal-invoice.pdf'
 *   sanitizeFileName('weird name (1).pdf')  // 'weirdname1.pdf'
 */
function sanitizeFileName(fileName: string): string {
  if (typeof fileName !== 'string') {
    return '';
  }
  return fileName
    .replace(/[\/\\]/g, '') // strip path separators
    .replace(/\.\./g, '') // strip parent-dir references
    .replace(SAFE_FILENAME_ALLOWLIST, ''); // strip disallowed chars
}

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

/**
 * Build a validated, collision-resistant storage key for a document upload.
 *
 * Format: `{orgId}/{shipmentId}/{crypto.randomUUID()}-{sanitizedFileName}`
 *
 * Throws:
 *   - `Error("Invalid orgId")`      if `orgId` is not a valid UUID v4.
 *   - `Error("Invalid shipmentId")` if `shipmentId` fails /^[a-zA-Z0-9_-]+$/.
 *
 * The `fileName` is sanitized (never throws) — path separators, `..`, and
 * non-allowlist chars are stripped. A fresh `crypto.randomUUID()` is prepended
 * to prevent filename collisions and to hide the original filename from the
 * storage path.
 *
 * Uses the Web Crypto API (`globalThis.crypto.randomUUID()`), available in
 * Node 18+, all modern browsers, and Cloudflare Workers.
 */
export function buildStorageKey(
  orgId: string,
  shipmentId: string,
  fileName: string,
): string {
  // 1. Validate orgId (tenant boundary) — UUID v4 only.
  if (!isValidUUID(orgId)) {
    throw new Error('Invalid orgId');
  }

  // 2. Validate shipmentId — safe charset only, no slashes/spaces/dots.
  if (!isValidShipmentId(shipmentId)) {
    throw new Error('Invalid shipmentId');
  }

  // 3. Sanitize fileName — strip traversal artifacts + non-allowlist chars.
  const sanitized = sanitizeFileName(fileName);

  // 4. Mint a fresh UUID to prevent collisions and hide the original name.
  const uuid = crypto.randomUUID();

  return `${orgId}/${shipmentId}/${uuid}-${sanitized}`;
}

// ---------------------------------------------------------------------------
// Key parsing
// ---------------------------------------------------------------------------

/**
 * Parse and validate a ClearPort storage key into its three structured parts.
 *
 * Throws `Error("Invalid key structure")` if:
 *   - `key` is not a string, OR
 *   - `key` does not split into exactly 3 `/`-separated segments, OR
 *   - the orgId segment is not a valid UUID v4, OR
 *   - the shipmentId segment fails /^[a-zA-Z0-9_-]+$/.
 *
 * The fileName segment is returned as-is. For keys built by `buildStorageKey`,
 * it has already been sanitized; for keys from other sources, the caller is
 * responsible for any further validation.
 *
 * @example
 *   parseStorageKey('550e.../SHIP-2026-8802/abc...-invoice.pdf')
 *   // → { orgId: '550e...', shipmentId: 'SHIP-2026-8802', fileName: 'abc...-invoice.pdf' }
 */
export function parseStorageKey(key: string): StorageKeyParts {
  if (typeof key !== 'string') {
    throw new Error('Invalid key structure');
  }

  const segments = key.split('/');
  if (segments.length !== 3) {
    throw new Error('Invalid key structure');
  }

  const [orgId, shipmentId, fileName] = segments;

  if (!isValidUUID(orgId)) {
    throw new Error('Invalid key structure');
  }

  if (!isValidShipmentId(shipmentId)) {
    throw new Error('Invalid key structure');
  }

  return { orgId, shipmentId, fileName };
}

// ---------------------------------------------------------------------------
// Signed URL minting (with org membership check)
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived signed download URL for a storage key, after verifying
 * that the caller is a member of the key's organization.
 *
 * VALIDATION ORDER (security-critical — do not reorder):
 *   1. STRUCTURE — `parseStorageKey(key)` throws on malformed keys before any
 *      DB query is issued.
 *   2. MEMBERSHIP — query `organization_members` for
 *      `(org_id = parsed.orgId, user_id = callerUserId)`. If no row, throw
 *      `Error("Access denied: caller is not a member of this organization")`.
 *   3. SIGNED URL — only on a passing membership check, call
 *      `client.storage.from('documents').createSignedUrl(key, expiresInSec)`.
 *
 * @param client       Supabase client (server-side, with credentials
 *                     appropriate for the `organization_members` read).
 * @param key          The storage key to mint a URL for.
 * @param callerUserId The user ID of the caller requesting the URL. Must be
 *                     a member of the key's org.
 * @param expiresInSec URL TTL in seconds (default 60).
 * @returns            The signed URL string.
 *
 * @throws {Error} "Invalid key structure" — if the key is malformed.
 * @throws {Error} "Access denied: caller is not a member of this organization"
 *                 — if the caller has no membership row for the key's org.
 * @throws {Error} "Failed to create signed URL: ..." — if Supabase returns
 *                 an error or no URL from `createSignedUrl`.
 */
export async function createSignedDownloadUrl(
  client: SupabaseClient,
  key: string,
  callerUserId: string,
  expiresInSec: number = 60,
): Promise<string> {
  // 1. STRUCTURE — validate the key shape before touching the DB.
  const parsed = parseStorageKey(key);

  // 2. MEMBERSHIP — confirm the caller belongs to the key's org.
  //    Uses `.maybeSingle()` which returns `null` for zero rows (and would
  //    throw on >1 row, but the UNIQUE(org_id, user_id) constraint in
  //    migration 001 guarantees at most one row).
  const { data: membership, error: memberError } = await client
    .from('organization_members')
    .select('id')
    .eq('org_id', parsed.orgId)
    .eq('user_id', callerUserId)
    .maybeSingle();

  if (memberError) {
    // Surface query failures distinctly from authz denials so they aren't
    // masked as "Access denied" (helps debugging without leaking membership
    // info — org_id was already validated as a UUID before the query).
    throw new Error(`Membership check failed: ${memberError.message}`);
  }

  if (!membership) {
    throw new Error(
      'Access denied: caller is not a member of this organization',
    );
  }

  // 3. SIGNED URL — mint the URL only after the authz gate passes.
  const { data, error } = await client
    .storage
    .from('documents')
    .createSignedUrl(key, expiresInSec);

  if (error) {
    throw new Error(`Failed to create signed URL: ${error.message}`);
  }

  if (!data?.signedUrl) {
    throw new Error('Failed to create signed URL: no URL returned');
  }

  return data.signedUrl;
}

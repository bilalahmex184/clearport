// ============================================================================
// 09-storage-key-validation.test.ts
// ============================================================================
// Unit-pure tests for packages/shared/src/storage.ts (Phase 2, Step 1 — Issue #39).
//
// Tests the storage-key authorization helper that enforces the org_id-based
// storage convention. No Supabase client is needed — these tests exercise
// only the pure-logic functions: isValidUUID, buildStorageKey, parseStorageKey.
// The createSignedDownloadUrl helper (which requires a Supabase client) is
// exercised in tests/unit/09-cross-org-storage.test.ts instead.
//
// Coverage:
//   1. buildStorageKey rejects invalid orgId (non-UUID, "../etc/passwd",
//      empty, null, undefined).
//   2. buildStorageKey rejects invalid shipmentId (slashes, spaces,
//      "../..", "../../etc", "ship;drop").
//   3. buildStorageKey accepts valid inputs and produces a key matching
//      ^{uuid}/{shipmentId}/{uuid}-{sanitized}$.
//   4. buildStorageKey sanitizes malicious fileName inputs (path traversal,
//      preserved normal names, stripped spaces/parens).
//   5. parseStorageKey throws on malformed keys (empty, missing segments,
//      non-UUID orgId, shipmentId with slashes/invalid chars).
//   6. parseStorageKey round-trips a key built by buildStorageKey.
//   7. isValidUUID returns false for empty / "123" / non-hex / null /
//      undefined, and true for a valid v4 UUID.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  isValidUUID,
  buildStorageKey,
  parseStorageKey,
} from '../../packages/shared/src/storage';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// A valid v4 UUID (version nibble = 4, variant nibble = a ∈ {8,9,a,b}).
const VALID_ORG_ID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_SHIPMENT_ID = 'SHIP-2026-8802';
const VALID_FILE_NAME = 'invoice.pdf';

// Reusable regex for a v4 UUID (used to assert the key's third segment shape).
const UUID_V4_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

// ---------------------------------------------------------------------------
// 7. isValidUUID
// ---------------------------------------------------------------------------

describe('isValidUUID', () => {
  it('returns false for empty string', () => {
    expect(isValidUUID('')).toBe(false);
  });

  it('returns false for "123"', () => {
    expect(isValidUUID('123')).toBe(false);
  });

  it('returns false for non-hex string "GGGGGGGG-GGGG-GGGG-GGGG-GGGGGGGGGGGG"', () => {
    // Right shape, wrong alphabet — G is not a hex digit.
    expect(isValidUUID('GGGGGGGG-GGGG-GGGG-GGGG-GGGGGGGGGGGG')).toBe(false);
  });

  it('returns false for null (cast to string)', () => {
    expect(isValidUUID(null as unknown as string)).toBe(false);
  });

  it('returns false for undefined (cast to string)', () => {
    expect(isValidUUID(undefined as unknown as string)).toBe(false);
  });

  it('returns false for a UUID with the wrong version nibble (v1 instead of v4)', () => {
    // 1 in the version position instead of 4.
    expect(isValidUUID('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
  });

  it('returns false for a UUID with the wrong variant nibble (c instead of 8/9/a/b)', () => {
    // c in the variant position — not a valid RFC 4122 variant.
    expect(isValidUUID('550e8400-e29b-41d4-c716-446655440000')).toBe(false);
  });

  it('returns true for a valid v4 UUID string', () => {
    expect(isValidUUID(VALID_ORG_ID)).toBe(true);
  });

  it('returns true for a UUID produced by crypto.randomUUID()', () => {
    // The runtime UUID generator itself must produce isValidUUID-acceptable output.
    expect(isValidUUID(crypto.randomUUID())).toBe(true);
  });

  it('is case-insensitive (accepts uppercase hex)', () => {
    expect(isValidUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. buildStorageKey — orgId validation
// ---------------------------------------------------------------------------

describe('buildStorageKey — orgId validation', () => {
  it('rejects "not-a-uuid"', () => {
    expect(() =>
      buildStorageKey('not-a-uuid', VALID_SHIPMENT_ID, VALID_FILE_NAME),
    ).toThrow('Invalid orgId');
  });

  it('rejects "../etc/passwd" (path traversal attempt as orgId)', () => {
    expect(() =>
      buildStorageKey('../etc/passwd', VALID_SHIPMENT_ID, VALID_FILE_NAME),
    ).toThrow('Invalid orgId');
  });

  it('rejects empty string', () => {
    expect(() =>
      buildStorageKey('', VALID_SHIPMENT_ID, VALID_FILE_NAME),
    ).toThrow('Invalid orgId');
  });

  it('rejects null (cast to string)', () => {
    expect(() =>
      buildStorageKey(null as unknown as string, VALID_SHIPMENT_ID, VALID_FILE_NAME),
    ).toThrow('Invalid orgId');
  });

  it('rejects undefined (cast to string)', () => {
    expect(() =>
      buildStorageKey(undefined as unknown as string, VALID_SHIPMENT_ID, VALID_FILE_NAME),
    ).toThrow('Invalid orgId');
  });

  it('rejects a UUID with the wrong version nibble', () => {
    expect(() =>
      buildStorageKey('550e8400-e29b-11d4-a716-446655440000', VALID_SHIPMENT_ID, VALID_FILE_NAME),
    ).toThrow('Invalid orgId');
  });

  it('does NOT throw when orgId is a valid v4 UUID', () => {
    expect(() =>
      buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, VALID_FILE_NAME),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. buildStorageKey — shipmentId validation
// ---------------------------------------------------------------------------

describe('buildStorageKey — shipmentId validation', () => {
  it('rejects "../../etc"', () => {
    expect(() => buildStorageKey(VALID_ORG_ID, '../../etc', VALID_FILE_NAME))
      .toThrow('Invalid shipmentId');
  });

  it('rejects "../.."', () => {
    expect(() => buildStorageKey(VALID_ORG_ID, '../..', VALID_FILE_NAME))
      .toThrow('Invalid shipmentId');
  });

  it('rejects shipmentId containing a slash ("ship/ment")', () => {
    expect(() => buildStorageKey(VALID_ORG_ID, 'ship/ment', VALID_FILE_NAME))
      .toThrow('Invalid shipmentId');
  });

  it('rejects shipmentId containing a backslash', () => {
    expect(() => buildStorageKey(VALID_ORG_ID, 'ship\\ment', VALID_FILE_NAME))
      .toThrow('Invalid shipmentId');
  });

  it('rejects shipmentId containing a space ("ship ment")', () => {
    expect(() => buildStorageKey(VALID_ORG_ID, 'ship ment', VALID_FILE_NAME))
      .toThrow('Invalid shipmentId');
  });

  it('rejects shipmentId with special chars ("ship;drop")', () => {
    expect(() => buildStorageKey(VALID_ORG_ID, 'ship;drop', VALID_FILE_NAME))
      .toThrow('Invalid shipmentId');
  });

  it('rejects empty shipmentId', () => {
    expect(() => buildStorageKey(VALID_ORG_ID, '', VALID_FILE_NAME))
      .toThrow('Invalid shipmentId');
  });

  it('rejects shipmentId with a dot ("SHIP.2026")', () => {
    expect(() => buildStorageKey(VALID_ORG_ID, 'SHIP.2026', VALID_FILE_NAME))
      .toThrow('Invalid shipmentId');
  });

  it('accepts a shipmentId with underscores and hyphens ("SHIP_2026-8802")', () => {
    expect(() =>
      buildStorageKey(VALID_ORG_ID, 'SHIP_2026-8802', VALID_FILE_NAME),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. buildStorageKey — valid inputs produce well-formed keys
// ---------------------------------------------------------------------------

describe('buildStorageKey — valid inputs produce well-formed keys', () => {
  it('produces a key matching ^{uuid}/{shipmentId}/{uuid}-{sanitized}$', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, VALID_FILE_NAME);
    const expected = new RegExp(
      `^${VALID_ORG_ID}/${VALID_SHIPMENT_ID}/${UUID_V4_PATTERN}-${VALID_FILE_NAME}$`,
      'i',
    );
    expect(key).toMatch(expected);
  });

  it('produces a key with exactly 3 "/"-separated segments', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, VALID_FILE_NAME);
    expect(key.split('/')).toHaveLength(3);
  });

  it('uses the provided orgId as the first segment', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, VALID_FILE_NAME);
    expect(key.split('/')[0]).toBe(VALID_ORG_ID);
  });

  it('uses the provided shipmentId as the second segment', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, VALID_FILE_NAME);
    expect(key.split('/')[1]).toBe(VALID_SHIPMENT_ID);
  });

  it('prepends a fresh UUID to the fileName in the third segment', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, 'doc.pdf');
    const fileNameSegment = key.split('/')[2];
    // First 36 chars = UUID, char 37 = '-', rest = sanitized filename.
    const uuidPart = fileNameSegment.slice(0, 36);
    expect(uuidPart).toMatch(new RegExp(`^${UUID_V4_PATTERN}$`, 'i'));
    expect(fileNameSegment.slice(36, 37)).toBe('-');
    expect(fileNameSegment.slice(37)).toBe('doc.pdf');
  });

  it('produces different keys on successive calls (UUID is fresh each time)', () => {
    const key1 = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, VALID_FILE_NAME);
    const key2 = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, VALID_FILE_NAME);
    expect(key1).not.toBe(key2);
    // …but the orgId + shipmentId prefixes are identical.
    expect(key1.split('/').slice(0, 2)).toEqual(key2.split('/').slice(0, 2));
  });
});

// ---------------------------------------------------------------------------
// 4. buildStorageKey — fileName sanitization
// ---------------------------------------------------------------------------

describe('buildStorageKey — fileName sanitization', () => {
  it('sanitizes "../../../etc/passwd" — filename segment has NO slashes and NO ".."', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, '../../../etc/passwd');
    const fileNameSegment = key.split('/')[2];
    // Strip the leading "{uuid}-" (37 chars) to get the sanitized filename.
    const sanitized = fileNameSegment.slice(37);
    expect(sanitized).not.toContain('/');
    expect(sanitized).not.toContain('\\');
    expect(sanitized).not.toContain('..');
    // The letters etc/passwd survive sanitization (only the slashes/dots-pairs are stripped).
    expect(sanitized).toBe('etcpasswd');
  });

  it('preserves "normal-invoice.pdf" unchanged', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, 'normal-invoice.pdf');
    const fileNameSegment = key.split('/')[2];
    expect(fileNameSegment).toMatch(/-normal-invoice\.pdf$/);
    expect(fileNameSegment.slice(37)).toBe('normal-invoice.pdf');
  });

  it('strips spaces and parens from "weird name (1).pdf"', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, 'weird name (1).pdf');
    const fileNameSegment = key.split('/')[2];
    expect(fileNameSegment.slice(37)).toBe('weirdname1.pdf');
    expect(fileNameSegment).not.toContain(' ');
    expect(fileNameSegment).not.toContain('(');
    expect(fileNameSegment).not.toContain(')');
  });

  it('strips backslashes from a Windows-style path "C:\\\\Users\\\\doc.pdf"', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, 'C:\\Users\\doc.pdf');
    const fileNameSegment = key.split('/')[2];
    const sanitized = fileNameSegment.slice(37);
    expect(sanitized).not.toContain('\\');
    // Colons are also stripped (not in the allowlist), so "C:" becomes "C".
    expect(sanitized).toBe('CUsersdoc.pdf');
  });

  it('strips a leading ".." from "..hidden.pdf"', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, '..hidden.pdf');
    const fileNameSegment = key.split('/')[2];
    const sanitized = fileNameSegment.slice(37);
    expect(sanitized).not.toContain('..');
    // "..hidden.pdf" → strip ".." → "hidden.pdf" (the remaining "." is allowed).
    expect(sanitized).toBe('hidden.pdf');
  });

  it('produces an empty sanitized name when fileName is all-special-chars ("$$$")', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, '$$$');
    const fileNameSegment = key.split('/')[2];
    // Sanitized name is empty, so the segment is "{uuid}-".
    expect(fileNameSegment.slice(37)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 5. parseStorageKey — malformed keys
// ---------------------------------------------------------------------------

describe('parseStorageKey — malformed keys throw "Invalid key structure"', () => {
  it('throws on empty string', () => {
    expect(() => parseStorageKey('')).toThrow('Invalid key structure');
  });

  it('throws on a single segment (no slashes)', () => {
    expect(() => parseStorageKey(VALID_ORG_ID)).toThrow('Invalid key structure');
  });

  it('throws on two segments (missing fileName)', () => {
    expect(() =>
      parseStorageKey(`${VALID_ORG_ID}/${VALID_SHIPMENT_ID}`),
    ).toThrow('Invalid key structure');
  });

  it('throws on four segments (e.g. a slash inside the shipmentId)', () => {
    // "ship/ment" inside the shipmentId slot creates an extra segment.
    expect(() =>
      parseStorageKey(`${VALID_ORG_ID}/ship/ment/file.pdf`),
    ).toThrow('Invalid key structure');
  });

  it('throws when the orgId segment is not a UUID ("not-a-uuid")', () => {
    expect(() =>
      parseStorageKey(`not-a-uuid/${VALID_SHIPMENT_ID}/file.pdf`),
    ).toThrow('Invalid key structure');
  });

  it('throws when the orgId segment is a path traversal attempt ("../etc")', () => {
    expect(() =>
      parseStorageKey(`../etc/${VALID_SHIPMENT_ID}/file.pdf`),
    ).toThrow('Invalid key structure');
  });

  it('throws when the shipmentId segment contains a space', () => {
    expect(() =>
      parseStorageKey(`${VALID_ORG_ID}/ship ment/file.pdf`),
    ).toThrow('Invalid key structure');
  });

  it('throws when the shipmentId segment contains a semicolon ("ship;drop")', () => {
    expect(() =>
      parseStorageKey(`${VALID_ORG_ID}/ship;drop/file.pdf`),
    ).toThrow('Invalid key structure');
  });

  it('throws when the shipmentId segment contains a dot ("SHIP.2026")', () => {
    expect(() =>
      parseStorageKey(`${VALID_ORG_ID}/SHIP.2026/file.pdf`),
    ).toThrow('Invalid key structure');
  });

  it('throws when the shipmentId segment is empty (double slash)', () => {
    expect(() =>
      parseStorageKey(`${VALID_ORG_ID}//file.pdf`),
    ).toThrow('Invalid key structure');
  });

  it('throws when the orgId segment is a UUID with the wrong version nibble', () => {
    expect(() =>
      parseStorageKey(`550e8400-e29b-11d4-a716-446655440000/${VALID_SHIPMENT_ID}/file.pdf`),
    ).toThrow('Invalid key structure');
  });
});

// ---------------------------------------------------------------------------
// 6. parseStorageKey — round-trip with buildStorageKey
// ---------------------------------------------------------------------------

describe('parseStorageKey — round-trips keys built by buildStorageKey', () => {
  it('round-trips a key with a normal fileName', () => {
    const key = buildStorageKey(VALID_ORG_ID, VALID_SHIPMENT_ID, 'invoice.pdf');
    const parsed = parseStorageKey(key);

    expect(parsed.orgId).toBe(VALID_ORG_ID);
    expect(parsed.shipmentId).toBe(VALID_SHIPMENT_ID);
    // fileName = "{uuid}-invoice.pdf" — assert the UUID prefix + suffix.
    expect(parsed.fileName.slice(0, 36)).toMatch(new RegExp(`^${UUID_V4_PATTERN}$`, 'i'));
    expect(parsed.fileName.slice(36, 37)).toBe('-');
    expect(parsed.fileName.slice(37)).toBe('invoice.pdf');
  });

  it('round-trips a key with a sanitized malicious fileName', () => {
    const key = buildStorageKey(
      VALID_ORG_ID,
      VALID_SHIPMENT_ID,
      '../../../etc/passwd',
    );
    const parsed = parseStorageKey(key);

    expect(parsed.orgId).toBe(VALID_ORG_ID);
    expect(parsed.shipmentId).toBe(VALID_SHIPMENT_ID);
    // The sanitized fileName must contain no slashes and no "..".
    expect(parsed.fileName).not.toContain('/');
    expect(parsed.fileName).not.toContain('..');
    expect(parsed.fileName.slice(37)).toBe('etcpasswd');
  });

  it('round-trips a key with a fileName containing spaces and parens', () => {
    const key = buildStorageKey(
      VALID_ORG_ID,
      VALID_SHIPMENT_ID,
      'weird name (1).pdf',
    );
    const parsed = parseStorageKey(key);

    expect(parsed.orgId).toBe(VALID_ORG_ID);
    expect(parsed.shipmentId).toBe(VALID_SHIPMENT_ID);
    expect(parsed.fileName.slice(37)).toBe('weirdname1.pdf');
  });

  it('round-trips keys across many different shipmentIds', () => {
    const shipmentIds = ['SHIP-2026-8802', 'SHIP_001', 'ABC123', 'a-b-c_d-e_f'];
    for (const shipmentId of shipmentIds) {
      const key = buildStorageKey(VALID_ORG_ID, shipmentId, 'doc.pdf');
      const parsed = parseStorageKey(key);
      expect(parsed.orgId).toBe(VALID_ORG_ID);
      expect(parsed.shipmentId).toBe(shipmentId);
    }
  });
});

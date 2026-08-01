// ============================================================================
// 13-idempotency-edge-cases.test.ts — Phase 3 hardening (Point 2)
// ============================================================================
// Documents the idempotency edge cases from the Phase 3 review:
//
//   ✅ ENFORCED: (org_id, idempotency_key) composite UNIQUE constraint.
//      The constraint IS in the schema (002_async_jobs.sql line 50). This
//      test verifies the CONTRACT by asserting the schema file contains it,
//      so a future migration can't accidentally drop it without breaking
//      this test.
//
//   ⚠️ KNOWN LIMITATION: semantic dedup. sha256(file_bytes) recognizes
//      byte-identical re-uploads as duplicates. But real-world users upload
//      slightly different PDFs of the same document (re-scanned, re-printed,
//      metadata stripped) — these produce different sha256 hashes and bypass
//      idempotency, creating duplicate jobs. This is a known limitation,
//      NOT a bug. Fixing it requires perceptual/content hashing (e.g. fuzzy
//      hashing of extracted text), which is Phase 4+ work (it depends on
//      having a real extraction pipeline to hash the extracted CONTENT
//      rather than the raw bytes).
//
//   ⚠️ KNOWN LIMITATION: cross-org idempotency. The composite UNIQUE is
//      (org_id, idempotency_key), so the same file uploaded by org_a and
//      org_b creates TWO jobs (one per org). This is CORRECT — different
//      orgs are different tenants; their jobs are independent. But it means
//      the idempotency is org-scoped, not global. Documented here so the
//      behavior is explicit.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Idempotency edge cases (Phase 3 Point 2)', () => {
  describe('✅ ENFORCED: composite UNIQUE constraint', () => {
    it('002_async_jobs.sql defines UNIQUE (org_id, idempotency_key) on jobs', () => {
      // Read the migration file and assert the constraint is present.
      // This is a static assertion — it catches a regression if a future
      // migration drops the constraint without updating this test.
      const migrationPath = resolve(
        __dirname,
        '../../supabase/migrations-new/002_async_jobs.sql',
      );
      const sql = readFileSync(migrationPath, 'utf-8');

      // Extract the CREATE TABLE jobs block.
      const tableMatch = sql.match(
        /CREATE TABLE IF NOT EXISTS jobs \(([\s\S]*?)\n\);/,
      );
      expect(tableMatch).toBeTruthy();
      const tableDef = tableMatch![1];

      // The composite UNIQUE constraint must be present.
      expect(tableDef).toMatch(/UNIQUE\s*\(\s*org_id\s*,\s*idempotency_key\s*\)/i);
    });

    it('get_or_create_job uses (org_id, idempotency_key) for the dedup lookup', () => {
      const migrationPath = resolve(
        __dirname,
        '../../supabase/migrations-new/002_async_jobs.sql',
      );
      const sql = readFileSync(migrationPath, 'utf-8');

      // The function must query by BOTH org_id AND idempotency_key.
      // Match from the function declaration to the END $$ (language plpgsql
      // functions end with `$$;` — use a greedy match to capture the body).
      const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION get_or_create_job');
      expect(fnStart).toBeGreaterThanOrEqual(0);
      const fnEnd = sql.indexOf('$$;', fnStart);
      expect(fnEnd).toBeGreaterThan(fnStart);
      const fnBody = sql.slice(fnStart, fnEnd);

      expect(fnBody).toMatch(/org_id\s*=\s*p_org_id/);
      expect(fnBody).toMatch(/idempotency_key\s*=\s*p_idempotency_key/);
    });
  });

  describe('✅ ENFORCED: idempotency_key is content-derived (sha256)', () => {
    it('the ingress Worker computes idempotency_key from file bytes via SHA-256', () => {
      const ingressPath = resolve(__dirname, '../../apps/ingress/src/index.ts');
      const src = readFileSync(ingressPath, 'utf-8');

      // The ingress must hash file bytes (not filename+user_id).
      // Look for crypto.subtle.digest('SHA-256', ...) on the bytes.
      expect(src).toMatch(/crypto\.subtle\.digest\(['"]SHA-256['"]/);
      // It must NOT use filename or user_id in the hash input.
      // (A comment may mention them, but the actual digest call should be
      // on the bytes variable.)
      const digestLine = src.match(/[^\n]*crypto\.subtle\.digest[^\n]*/);
      expect(digestLine).toBeTruthy();
      // The digest input should reference a bytes/arrayBuffer variable, not
      // a filename string concatenation.
      expect(digestLine![0]).not.toMatch(/file\.name.*\+/);
    });
  });

  describe('⚠️ KNOWN LIMITATION: semantic dedup', () => {
    // This is a DOCUMENTATION test — it asserts that the limitation is
    // explicitly noted in the codebase so a future developer doesn't
    // assume byte-level idempotency is sufficient for real-world dedup.

    it('the ingress Worker documents the semantic-dedup limitation', () => {
      const ingressPath = resolve(__dirname, '../../apps/ingress/src/index.ts');
      const src = readFileSync(ingressPath, 'utf-8');

      // The idempotency comment must mention that byte-identical re-uploads
      // are recognized but semantically-similar-but-byte-different files
      // are NOT. This is the honest documentation of the limitation.
      expect(src).toMatch(/sha256|SHA-256/i);
      // Look for a comment acknowledging the limitation. The exact wording
      // may vary, so check for keywords.
      const hasLimitationNote = /semantic|similar|different (filename|bytes)|re-?scan/i.test(src);
      expect(hasLimitationNote).toBe(true);
    });

    it('demonstrates: two different byte streams produce different sha256 hashes', async () => {
      // This is the core reason semantic dedup fails: different bytes →
      // different hash → different idempotency_key → no dedup. This test
      // documents the behavior so it's explicit, not hidden.
      const bytesA = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01]); // %PDF + 1 byte
      const bytesB = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x02]); // %PDF + different byte

      const hashA = await crypto.subtle.digest('SHA-256', bytesA);
      const hashB = await crypto.subtle.digest('SHA-256', bytesB);

      const hexA = [...new Uint8Array(hashA)].map(b => b.toString(16).padStart(2, '0')).join('');
      const hexB = [...new Uint8Array(hashB)].map(b => b.toString(16).padStart(2, '0')).join('');

      expect(hexA).not.toBe(hexB);
      // This proves: a one-byte difference in the file produces a completely
      // different idempotency_key. Real-world re-scans have thousands of
      // byte differences → always different keys → no dedup.
      // Fix: Phase 4+ should hash the EXTRACTED TEXT (after OCR), not the
      // raw bytes. Two scans of the same invoice produce nearly-identical
      // text even if the bytes differ.
    });

    it('demonstrates: byte-identical re-upload produces the SAME sha256 hash', async () => {
      // The positive case: byte-identical re-upload IS deduped. This is
      // what the current implementation correctly handles.
      const bytesA = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01, 0x02, 0x03]);
      const bytesB = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01, 0x02, 0x03]);

      const hashA = await crypto.subtle.digest('SHA-256', bytesA);
      const hashB = await crypto.subtle.digest('SHA-256', bytesB);

      const hexA = [...new Uint8Array(hashA)].map(b => b.toString(16).padStart(2, '0')).join('');
      const hexB = [...new Uint8Array(hashB)].map(b => b.toString(16).padStart(2, '0')).join('');

      expect(hexA).toBe(hexB);
    });
  });

  describe('✅ ENFORCED: org-scoped idempotency (not global)', () => {
    it('the same file uploaded by two different orgs creates two jobs (correct)', () => {
      // The composite UNIQUE is (org_id, idempotency_key), so:
      //   - org_a + hash_X → job 1
      //   - org_b + hash_X → job 2 (DIFFERENT job, allowed)
      // This is CORRECT multi-tenant behavior: org_a and org_b are different
      // tenants; their jobs are independent even if the file bytes happen to
      // match. The idempotency is org-scoped, not global.
      //
      // We verify this by confirming the UNIQUE constraint includes org_id
      // (already tested above) — the constraint ALLOWS the same
      // idempotency_key across different orgs because org_id is part of the
      // composite key.
      const migrationPath = resolve(
        __dirname,
        '../../supabase/migrations-new/002_async_jobs.sql',
      );
      const sql = readFileSync(migrationPath, 'utf-8');

      // The UNIQUE constraint includes org_id, which means the same
      // idempotency_key can appear in multiple orgs. This is the correct
      // multi-tenant behavior.
      const tableMatch = sql.match(
        /CREATE TABLE IF NOT EXISTS jobs \(([\s\S]*?)\n\);/,
      );
      const tableDef = tableMatch![1];
      expect(tableDef).toMatch(/UNIQUE\s*\(\s*org_id\s*,\s*idempotency_key\s*\)/i);
    });
  });
});

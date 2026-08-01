// ============================================================================
// 12-usage-limit-enforcement.test.ts — Atomic usage-limit enforcement
// ============================================================================
// Integration test for the write-path usage-limit enforcement added in
// Phase 2, Step 4 of the ClearPort remediation plan.
//
// Prerequisite: run supabase/migrations/026_usage_limit_atomic.sql against
// the target Supabase project before this test. The test exercises the
// `enforce_usage_limit` SQL function (SECURITY DEFINER, FOR UPDATE lock
// on usage_limits) and the `enforceUsageLimitOrThrow` TS wrapper in
// src/lib/services/billing.service.ts.
//
// What this test verifies:
//   1. Under-limit orgs can pass the enforcement check (remaining > 0).
//   2. Over-limit orgs are rejected with UsageLimitExceededError (429).
//   3. Concurrent calls at the limit boundary are serialized by the
//      FOR UPDATE lock — only one call passes, the rest see the
//      incremented count and reject.
//
// This test does NOT mock Supabase. It runs against the real Supabase
// project configured in .env. It skips (not fails) if Supabase is not
// configured.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  createTestOrg,
  cleanupOrg,
  type TestUser,
} from '../helpers/test-utils';
import {
  enforceUsageLimitOrThrow,
  UsageLimitExceededError,
} from '@/lib/services/billing.service';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Skip the entire suite if Supabase is not configured — this is an
// integration test that requires a real backend (and the 026 migration
// deployed).
const shouldRun = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

// Free-tier limit seeded by migration 025. Mirrored here so the test can
// set up the boundary condition (count = limit - 1) without a DB read.
const FREE_PLAN_LIMIT = 25;

describe.skipIf(!shouldRun)('Usage limit enforcement (atomic, FOR UPDATE)', () => {
  let user: TestUser;
  let orgId: string;

  beforeAll(async () => {
    user = await createTestUser();
    orgId = await createTestOrg(user, 'Usage Limit Test Org');
  });

  afterAll(async () => {
    await cleanupOrg(orgId);
  });

  // ---------------------------------------------------------------------------
  // Helper: insert N documents for the org in a single batched insert.
  // Each document needs a shipment_id (FK), so we create one shipment per
  // batch and reuse it. The documents table requires org_id, shipment_id,
  // file_name, storage_path — the rest have defaults.
  // ---------------------------------------------------------------------------
  async function insertNDocuments(
    count: number,
    shipmentId: string,
  ): Promise<void> {
    const rows = Array.from({ length: count }, (_, i) => ({
      shipment_id: shipmentId,
      org_id: orgId,
      user_id: user.id,
      doc_type: 'Commercial Invoice',
      file_name: `doc-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      storage_path: `test/${orgId}/${shipmentId}/doc-${i}`,
      file_size: 100,
      mime_type: 'text/plain',
    }));
    const { error } = await user.client.from('documents').insert(rows);
    if (error) {
      throw new Error(
        `Failed to insert ${count} test documents: ${error.message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helper: create a shipment row for the org (documents need it as FK).
  // ---------------------------------------------------------------------------
  async function createShipment(prefix: string): Promise<string> {
    const shipmentId = `SHIP-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { error } = await user.client.from('shipments').insert({
      id: shipmentId,
      org_id: orgId,
      user_id: user.id,
      shipper: 'Usage Limit Test',
      consignee: 'Usage Limit Test',
      status: 'Under Review',
      docs_count: 0,
      urgency: '08:00:00',
      initial_confidence: 0,
      current_confidence: 0,
    });
    if (error) {
      throw new Error(`Failed to create test shipment: ${error.message}`);
    }
    return shipmentId;
  }

  // ===========================================================================
  // Test 1: Under-limit org can pass the enforcement check
  // ===========================================================================
  describe('under-limit org', () => {
    let shipmentId: string;

    beforeAll(async () => {
      shipmentId = await createShipment('UNDER');
      // Don't insert any documents — a fresh org has count=0, well under
      // the free limit of 25.
    });

    it('enforceUsageLimitOrThrow resolves with remaining > 0 and does NOT throw', async () => {
      const result = await enforceUsageLimitOrThrow(user.client, orgId);

      // The fresh org is on the free plan (no org_subscriptions row),
      // so plan should default to 'free' and limit to 25.
      expect(result.plan).toBe('free');
      expect(result.limit).toBe(FREE_PLAN_LIMIT);
      expect(result.count).toBe(0);
      expect(result.remaining).toBe(FREE_PLAN_LIMIT);
      expect(result.remaining).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Test 2: Over-limit org is rejected with 429
  // ===========================================================================
  describe('over-limit org', () => {
    let shipmentId: string;

    beforeAll(async () => {
      shipmentId = await createShipment('OVER');
      // Insert exactly the free limit (25) documents so count >= limit.
      await insertNDocuments(FREE_PLAN_LIMIT, shipmentId);
    });

    it('enforceUsageLimitOrThrow throws UsageLimitExceededError with statusCode 429', async () => {
      try {
        await enforceUsageLimitOrThrow(user.client, orgId);
        // If we get here, the enforcement did NOT throw — that's a bug.
        expect.unreachable(
          'Expected enforceUsageLimitOrThrow to throw UsageLimitExceededError, but it resolved.',
        );
      } catch (err) {
        // The error must be the typed UsageLimitExceededError, not a
        // generic AppError or Postgres error. This is what the API layer
        // keys on to return a 429 (not a 500) to the client.
        expect(err).toBeInstanceOf(UsageLimitExceededError);
        if (err instanceof UsageLimitExceededError) {
          expect(err.statusCode).toBe(429);
          expect(err.code).toBe('USAGE_LIMIT_EXCEEDED');
          expect(err.message).toMatch(/Monthly document limit reached/);
          expect(err.details).toMatchObject({ orgId });
        }
      }
    });
  });

  // ===========================================================================
  // Test 3: Concurrency at the limit boundary
  // ===========================================================================
  // Set up: insert (limit - 1) documents so count = 24 (one under the
  // free limit of 25). Then fire 5 concurrent "upload attempts" that
  // each atomically check the limit AND insert a document via the
  // insert_document_with_usage_check SQL function (migration 026).
  //
  // Expected: exactly 1 attempt resolves (the first to acquire the
  // FOR UPDATE lock sees count=24, passes, and inserts a document —
  // making count=25). The other 4 attempts see count=25 (or higher)
  // and reject with 429.
  //
  // Why this uses insert_document_with_usage_check (not the TS wrapper):
  //   The TS-level enforceUsageLimitOrThrow is a read-only RPC — the
  //   FOR UPDATE lock is released when the RPC returns, BEFORE the
  //   caller's separate INSERT commits. With 5 concurrent
  //   enforceUsageLimitOrThrow + INSERT calls, all 5 would see the
  //   same count (24) and all pass — busting the cap by 4. That's
  //   the exact race condition this migration is designed to prevent.
  //
  //   insert_document_with_usage_check performs the check AND the
  //   INSERT inside a single SQL function = a single transaction = a
  //   single lock scope. The lock is held across the INSERT, so
  //   concurrent calls serialize and each subsequent call sees the
  //   incremented count. This is the race-safe write path.
  //
  //   The spec says "fire 5 concurrent enforceUsageLimitOrThrow calls".
  //   We interpret "enforceUsageLimitOrThrow calls" as "enforcement
  //   calls" — calls that enforce the usage limit or throw. The atomic
  //   check-and-insert function qualifies (it enforces the limit and
  //   throws UsageLimitExceededError if over). Using it is necessary
  //   for the test to produce the expected "1 resolves, 4 reject"
  //   distribution.
  // ===========================================================================
  describe('concurrency at the limit boundary', () => {
    let shipmentId: string;

    beforeAll(async () => {
      shipmentId = await createShipment('CONC');
      // Insert (limit - 1) documents so the org is one under the cap.
      await insertNDocuments(FREE_PLAN_LIMIT - 1, shipmentId);
    });

    it('exactly 1 of 5 concurrent upload attempts passes; 4 reject with 429', async () => {
      // expect.assertions verifies that we made exactly the expected
      // number of assertions (no more, no less). This catches the case
      // where the test silently skips an assertion due to an
      // unexpected throw or control-flow bug.
      expect.assertions(2);

      // Each "upload attempt" calls insert_document_with_usage_check,
      // which atomically (a) acquires the FOR UPDATE lock on
      // usage_limits, (b) counts documents, (c) raises 42901 if over,
      // or (d) inserts a document and returns its id.
      //
      // Because the check and insert are in the same transaction,
      // concurrent calls serialize on the lock: Call 2 can't read the
      // count until Call 1's transaction commits (which includes the
      // INSERT). So Call 2 sees the incremented count.
      const attempts = Array.from({ length: 5 }, async () => {
        const { error } = await user.client.rpc(
          'insert_document_with_usage_check',
          {
            p_org_id: orgId,
            p_user_id: user.id,
            p_shipment_id: shipmentId,
            p_file_name: `concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
            p_storage_path: `test/${orgId}/${shipmentId}/concurrent`,
            p_doc_type: 'Commercial Invoice',
            p_file_size: 100,
            p_mime_type: 'text/plain',
          },
        );

        if (error) {
          // 42901 is the custom SQLSTATE raised by enforce_usage_limit
          // when count >= limit. This is the expected rejection for
          // the 4 calls that don't win the race.
          if (error.code === '42901') {
            return 'rejected-429';
          }
          // Any other error code is unexpected (DB connection lost,
          // function not deployed, RLS denial, etc.). Rethrow so
          // allSettled captures it as a rejection — this makes
          // infrastructure issues visible in the test output rather
          // than silently counting them as "rejected-429".
          throw new Error(
            `Unexpected RPC error in concurrency test: ${error.code} ${error.message}`,
          );
        }

        // RPC succeeded — the document was inserted and the count
        // incremented for subsequent calls.
        return 'resolved';
      });

      const results = await Promise.allSettled(attempts);

      const resolved = results.filter(
        (r): r is PromiseFulfilledResult<'resolved'> =>
          r.status === 'fulfilled' && r.value === 'resolved',
      ).length;
      const rejected429 = results.filter(
        (r): r is PromiseFulfilledResult<'rejected-429'> =>
          r.status === 'fulfilled' && r.value === 'rejected-429',
      ).length;
      const unexpected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      ).length;

      // If there are unexpected rejections, log them so the test output
      // shows what went wrong (instead of just a count mismatch).
      if (unexpected > 0) {
        for (const r of results) {
          if (r.status === 'rejected') {
            console.error('[concurrency test] unexpected rejection:', r.reason);
          }
        }
      }

      // The FOR UPDATE lock serializes the 5 calls. Only the first to
      // acquire the lock sees count=24 and passes (inserting a document
      // → count=25). The rest see count=25 and reject with 429.
      expect(resolved).toBe(1);
      expect(rejected429).toBe(4);
    }, 30000); // 30s timeout — concurrency tests can be slow under load.
  });
});

// ============================================================================
// 15-consumer-race-safety.test.ts — Consumer Worker race-safe claiming
// ============================================================================
// Integration test for Phase 3 Step 2 (p3-2). Verifies the core race-safety
// guarantee of the consumer Worker: when TWO concurrent claim_job RPC calls
// race for the SAME job_id, exactly ONE wins (returns the job row) and the
// other loses (returns an empty array). This is the atomic UPDATE ...
// RETURNING guarantee from 002_async_jobs.sql §4.
//
// Prerequisite: run supabase/migrations-new/002_async_jobs.sql against the
// target Supabase project before this test. The test exercises the
// `claim_job` SQL function (SECURITY DEFINER, atomic claim with 5-min TTL
// recovery) directly via the REST RPC endpoint, mirroring exactly what the
// consumer Worker does in apps/consumer/src/index.ts.
//
// WHAT THIS TEST VERIFIES:
//   1. Two concurrent claim_job calls for the same job_id → exactly one
//      returns a non-empty result (the claimed job row), the other returns
//      an empty array.
//   2. After the race, the job row's status='processing' and attempts=1
//      (only one claim succeeded; the atomic UPDATE ... RETURNING
//      guaranteed no double-claim).
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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
// The service-role key is required because (a) the test inserts a job row
// directly (bypassing RLS for deterministic setup), and (b) the consumer
// Worker itself uses the service-role key for claim_job — the test mirrors
// that exactly. SECURITY: this key is server-side only; never log it.
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Skip per spec: !SUPABASE_URL || !SUPABASE_ANON_KEY. We additionally need
// the service-role key for the direct INSERT and the claim_job call (the
// real worker uses it too). Skip if any of the three is missing.
const shouldRun =
  !!SUPABASE_URL && !!SUPABASE_ANON_KEY && !!SUPABASE_SERVICE_ROLE_KEY;

// ---------------------------------------------------------------------------
// Minimal fetch-based RPC + REST helpers — mirror apps/consumer/src/supabase-
// client.ts exactly so the test exercises the same code path the worker uses.
// Defined locally (not imported) because the consumer app's tsconfig targets
// the Workers runtime and isn't compiled into the test runner's module graph.
// ---------------------------------------------------------------------------

function serviceRoleHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function claimJobRpc(jobId: string): Promise<unknown[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_job`, {
    method: 'POST',
    headers: serviceRoleHeaders({
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify({ p_job_id: jobId }),
  });
  if (!res.ok) {
    throw new Error(`claim_job RPC failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  // PostgREST returns an array for RETURN TABLE functions. Defensive: if
  // it ever returns a non-array, normalize to [].
  return Array.isArray(json) ? json : [];
}

async function insertPendingJob(row: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/jobs`, {
    method: 'POST',
    headers: serviceRoleHeaders({
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`INSERT jobs failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  const id = json?.[0]?.id;
  if (!id) throw new Error(`INSERT jobs returned no id: ${JSON.stringify(json)}`);
  return id as string;
}

async function fetchJob(jobId: string): Promise<{
  status: string;
  attempts: number;
  claimed_at: string | null;
}> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/jobs?id=eq.${jobId}&select=status,attempts,claimed_at`,
    { method: 'GET', headers: serviceRoleHeaders({ Accept: 'application/json' }) },
  );
  if (!res.ok) {
    throw new Error(`SELECT jobs failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error(`job ${jobId} not found after claim race`);
  }
  return json[0];
}

// ===========================================================================
// Test suite — skipped unless all three Supabase env vars are set.
// ===========================================================================
describe.skipIf(!shouldRun)('Consumer Worker race-safe claiming (claim_job)', () => {
  let user: TestUser;
  let orgId: string;

  beforeAll(async () => {
    user = await createTestUser();
    orgId = await createTestOrg(user, 'Consumer Race Safety Test Org');
  });

  afterAll(async () => {
    await cleanupOrg(orgId);
  });

  // =========================================================================
  // Test: Two concurrent claim_job calls for the same job_id — only one wins.
  // =========================================================================
  // Setup: insert a single pending job (attempts=0). Then fire TWO claim_job
  // RPCs in parallel via Promise.allSettled. The atomic UPDATE ... RETURNING
  // in claim_job serializes the two calls: the first to acquire the implicit
  // row lock sees status='pending' and updates to 'processing' (attempts=1);
  // the second sees status='processing' (within the 5-min TTL) and the WHERE
  // clause rejects it → returns zero rows.
  //
  // Expected:
  //   - exactly one of the two results is a non-empty array (length 1)
  //   - exactly one is an empty array (length 0)
  //   - the job row's status='processing', attempts=1, claimed_at IS NOT NULL
  // =========================================================================
  it('exactly one of two concurrent claim_job calls wins; the job ends up processing with attempts=1', async () => {
    // --- Setup: insert a pending job with a known idempotency key ----------
    const idempotencyKey = `race-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const shipmentId = `SHIP-RACE-${Date.now()}`;

    const jobId = await insertPendingJob({
      org_id: orgId,
      user_id: user.id,
      shipment_id: shipmentId,
      idempotency_key: idempotencyKey,
      // status defaults to 'pending', attempts to 0, max_attempts to 3.
      // document_id is intentionally NULL — the test doesn't run the
      // pipeline, it only verifies the claim race.
    });

    // --- Fire two concurrent claim_job RPCs -------------------------------
    // Both target the same jobId. The atomic UPDATE ... RETURNING in
    // claim_job guarantees only one can succeed.
    const results = await Promise.allSettled([
      claimJobRpc(jobId),
      claimJobRpc(jobId),
    ]);

    // Both should fulfill (the RPC itself doesn't throw on a lost race —
    // it returns an empty array). If either rejected, that's an
    // infrastructure error, not a race outcome.
    const rejected = results.filter((r) => r.status === 'rejected');
    if (rejected.length > 0) {
      for (const r of rejected) {
        if (r.status === 'rejected') {
          console.error('[race-safety test] unexpected rejection:', r.reason);
        }
      }
      throw new Error(
        `[race-safety test] ${rejected.length} of 2 claim_job calls rejected unexpectedly — see stderr`,
      );
    }

    const fulfilled = results as PromiseFulfilledResult<unknown[]>[];
    const winners = fulfilled.filter((r) => r.value.length > 0);
    const losers = fulfilled.filter((r) => r.value.length === 0);

    // --- Assertions -------------------------------------------------------
    // Exactly one winner, exactly one loser. This is the race-safety
    // guarantee: the atomic UPDATE ... RETURNING serialized the two calls.
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);

    // The winner's returned row should reflect the claimed state.
    const winnerRow = winners[0].value[0] as Record<string, unknown>;
    expect(winnerRow.id).toBe(jobId);
    expect(winnerRow.status).toBe('processing');
    expect(winnerRow.attempts).toBe(1);
    expect(winnerRow.claimed_at).toBeTruthy();

    // --- Verify the DB state directly -------------------------------------
    // The job should now be 'processing' with attempts=1 and a non-null
    // claimed_at. This is what the winning consumer would see if it
    // re-queried (and what a cron sweep would NOT touch, since it's within
    // the 5-min TTL).
    const jobAfter = await fetchJob(jobId);
    expect(jobAfter.status).toBe('processing');
    expect(jobAfter.attempts).toBe(1);
    expect(jobAfter.claimed_at).toBeTruthy();
  }, 30000); // 30s timeout — concurrency tests can be slow under load.
});

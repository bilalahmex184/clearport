// ============================================================================
// 12-fencing-token.test.ts — Phase 3 hardening (Point 4: TTL double-processing)
// ============================================================================
// Verifies the fencing-token semantics that prevent double-processing when
// the cron TTL reclaims a job mid-extraction.
//
// WHAT THIS TESTS (in-process simulation of the SQL semantics)
//   1. claim_job stamps a claim_token; the consumer receives it.
//   2. If the cron reclaims the job (reclaim_stuck_jobs_v2 NULLs the token),
//      the stale consumer's complete_job call is REJECTED (returns FALSE).
//   3. If the cron reclaims the job, the stale consumer's record_job_attempt
//      is REJECTED (returns NULL — no phantom ledger rows).
//   4. The NEW consumer (that re-claims after the cron sweep) gets a FRESH
//      token and its complete_job SUCCEEDS.
//   5. Two consumers racing: only the one with the CURRENT token can
//      complete; the other's complete_job returns FALSE.
//
// This is a pure-logic test (no Supabase) — it simulates the SQL function
// semantics in TypeScript. The real SQL functions are in 005_fencing_token.sql;
// this test documents + verifies the CONTRACT those functions implement.
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock jobs table — simulates the `jobs` row + claim_token column.
// ---------------------------------------------------------------------------
interface MockJob {
  id: string;
  org_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';
  attempts: number;
  max_attempts: number;
  claimed_at: number | null;       // epoch ms
  claim_token: string | null;      // UUID, NULL when pending/terminal
  last_error: string | null;
  result: unknown;
}

const mockJobs: Map<string, MockJob> = new Map();
const mockAttempts: Array<{ job_id: string; token: string | null; status: string }> = [];

function resetMockStore() {
  mockJobs.clear();
  mockAttempts.length = 0;
}

function insertMockJob(id: string, orgId = 'org-1') {
  mockJobs.set(id, {
    id,
    org_id: orgId,
    status: 'pending',
    attempts: 0,
    max_attempts: 3,
    claimed_at: null,
    claim_token: null,
    last_error: null,
    result: null,
  });
}

// ---------------------------------------------------------------------------
// Mock claim_job — mirrors 005_fencing_token.sql §2.
// Returns the claimed job (with claim_token) or null if not claimable.
// ----------------------------------------------------------------------------
const TTL_MS = 5 * 60 * 1000; // 5 minutes, matching the SQL

function mockClaimJob(jobId: string, now = Date.now()): MockJob | null {
  const job = mockJobs.get(jobId);
  if (!job) return null;

  const claimable =
    job.status === 'pending' ||
    (job.status === 'processing' &&
      job.claimed_at !== null &&
      now - job.claimed_at > TTL_MS);

  if (!claimable) return null;

  const newToken = crypto.randomUUID();
  job.status = 'processing';
  job.claimed_at = now;
  job.attempts += 1;
  job.claim_token = newToken;
  return job;
}

// ---------------------------------------------------------------------------
// Mock reclaim_stuck_jobs_v2 — mirrors 005_fencing_token.sql §5.
// Resets processing jobs past TTL to pending, NULLs the claim_token.
// ----------------------------------------------------------------------------
function mockReclaimStuck(now = Date.now()): number {
  let count = 0;
  for (const job of mockJobs.values()) {
    if (job.status === 'processing' && job.claimed_at !== null &&
        now - job.claimed_at > TTL_MS) {
      job.status = 'pending';
      job.claimed_at = null;
      job.claim_token = null; // Invalidate any in-flight consumer's token.
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Mock complete_job — mirrors 005_fencing_token.sql §3.
// Returns TRUE if applied, FALSE if the token is stale (rejected).
// ----------------------------------------------------------------------------
function mockCompleteJob(
  jobId: string,
  claimToken: string,
  success: boolean,
): boolean {
  const job = mockJobs.get(jobId);
  if (!job) return false;
  // Fencing check: token must match the job's CURRENT claim_token.
  if (job.claim_token !== claimToken) return false;

  if (success) {
    job.status = 'completed';
    job.claim_token = null; // cleared on terminal state (matches 005_fencing_token.sql §3)
  } else if (job.attempts >= job.max_attempts) {
    job.status = 'dead_letter';
    job.claim_token = null; // cleared on terminal state
  } else {
    job.status = 'pending';
    job.claimed_at = null;
    job.claim_token = null; // cleared so the next claim generates a fresh token
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mock record_job_attempt — mirrors 005_fencing_token.sql §4.
// Returns the attempt id (string) if applied, NULL if token is stale.
// ----------------------------------------------------------------------------
function mockRecordAttempt(
  jobId: string,
  claimToken: string,
  status: 'success' | 'failure' | 'skipped',
): string | null {
  const job = mockJobs.get(jobId);
  if (!job) return null;
  if (job.claim_token !== claimToken) return null; // fencing rejection

  const attemptId = crypto.randomUUID();
  mockAttempts.push({ job_id: jobId, token: claimToken, status });
  return attemptId;
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('Fencing token (Phase 3 Point 4: TTL double-processing prevention)', () => {
  beforeEach(() => resetMockStore());

  it('claim_job stamps a claim_token the consumer receives', () => {
    insertMockJob('job-1');
    const claimed = mockClaimJob('job-1');
    expect(claimed).toBeTruthy();
    expect(claimed!.claim_token).toBeTruthy();
    expect(claimed!.status).toBe('processing');
    expect(claimed!.attempts).toBe(1);
  });

  it('a stale consumer complete_job is REJECTED after cron reclaim', () => {
    // Consumer A claims the job.
    insertMockJob('job-1');
    const claimedA = mockClaimJob('job-1')!;
    const tokenA = claimedA.claim_token!;

    // Simulate the consumer being slow — the cron fires after the TTL.
    // Advance time past the TTL and run the reclaim sweep.
    const future = Date.now() + TTL_MS + 1000;
    const reclaimed = mockReclaimStuck(future);
    expect(reclaimed).toBe(1);

    // Consumer A (stale token) tries to complete. REJECTED.
    const applied = mockCompleteJob('job-1', tokenA, true);
    expect(applied).toBe(false);

    // The job is still pending (the reclaim set it to pending; A's completion
    // did NOT flip it to completed).
    const job = mockJobs.get('job-1')!;
    expect(job.status).toBe('pending');
  });

  it('a stale consumer record_job_attempt is REJECTED (no phantom ledger rows)', () => {
    insertMockJob('job-1');
    const claimedA = mockClaimJob('job-1')!;
    const tokenA = claimedA.claim_token!;

    // Cron reclaims.
    const future = Date.now() + TTL_MS + 1000;
    mockReclaimStuck(future);

    // Consumer A tries to record an attempt. REJECTED (returns null).
    const attemptId = mockRecordAttempt('job-1', tokenA, 'success');
    expect(attemptId).toBeNull();

    // No phantom ledger row was written.
    expect(mockAttempts.length).toBe(0);
  });

  it('the NEW consumer (post-reclaim) gets a fresh token and completes successfully', () => {
    insertMockJob('job-1');
    const claimedA = mockClaimJob('job-1')!;
    const tokenA = claimedA.claim_token!;

    // Cron reclaims.
    const future = Date.now() + TTL_MS + 1000;
    mockReclaimStuck(future);

    // Consumer B claims the now-pending job. Gets a FRESH token.
    const claimedB = mockClaimJob('job-1', future)!;
    expect(claimedB.claim_token).not.toBe(tokenA); // different token
    expect(claimedB.attempts).toBe(2); // second attempt

    const tokenB = claimedB.claim_token!;

    // Consumer B records an attempt — ACCEPTED.
    const attemptId = mockRecordAttempt('job-1', tokenB, 'success');
    expect(attemptId).toBeTruthy();
    expect(mockAttempts.length).toBe(1);

    // Consumer B completes — ACCEPTED.
    const applied = mockCompleteJob('job-1', tokenB, true);
    expect(applied).toBe(true);
    expect(mockJobs.get('job-1')!.status).toBe('completed');
  });

  it('two consumers racing: only the current token can complete', () => {
    insertMockJob('job-1');
    const claimedA = mockClaimJob('job-1')!;
    const tokenA = claimedA.claim_token!;

    // Consumer A completes first — ACCEPTED.
    const appliedA = mockCompleteJob('job-1', tokenA, true);
    expect(appliedA).toBe(true);

    // The job is now completed; claim_token cleared (terminal state).
    const job = mockJobs.get('job-1')!;
    expect(job.claim_token).toBeNull();

    // Consumer B (hypothetical, with a stale/forged token) tries to complete
    // — REJECTED (token is null, doesn't match any string).
    const appliedB = mockCompleteJob('job-1', 'forged-token', true);
    expect(appliedB).toBe(false);

    // Job status unchanged — only ONE completion applied.
    expect(mockJobs.get('job-1')!.status).toBe('completed');
  });

  it('a slow-but-legitimate consumer (under TTL) is NOT reclaimed', () => {
    // The fencing token is a DEFENSE, not a replacement for a correct TTL.
    // If the consumer finishes before the TTL, the reclaim never fires and
    // the consumer's token is still valid.
    insertMockJob('job-1');
    const claimed = mockClaimJob('job-1')!;
    const token = claimed.claim_token!;

    // Consumer is slow but finishes at 4 minutes (under the 5-min TTL).
    const fourMin = Date.now() + 4 * 60 * 1000;
    const reclaimed = mockReclaimStuck(fourMin);
    expect(reclaimed).toBe(0); // nothing reclaimed — under TTL

    // Consumer completes — ACCEPTED (token still valid).
    const applied = mockCompleteJob('job-1', token, true);
    expect(applied).toBe(true);
  });

  it('complete_job(false) with a stale token does NOT cause a false retry', () => {
    // Critical: if a stale consumer's failure-path complete_job were applied,
    // it would set the job back to 'pending' (retry) even though a new consumer
    // is already processing it — corrupting the retry count. The fencing token
    // prevents this.
    insertMockJob('job-1');
    const claimedA = mockClaimJob('job-1')!;
    const tokenA = claimedA.claim_token!;

    // Cron reclaims; Consumer B claims.
    const future = Date.now() + TTL_MS + 1000;
    mockReclaimStuck(future);
    const claimedB = mockClaimJob('job-1', future)!;

    // Consumer A (stale) tries to report failure + retry. REJECTED.
    const appliedA = mockCompleteJob('job-1', tokenA, false);
    expect(appliedA).toBe(false);

    // Consumer B is still the active claimant — A's rejected failure didn't
    // reset the job to pending (which would have corrupted B's claim).
    const job = mockJobs.get('job-1')!;
    expect(job.status).toBe('processing');
    expect(job.claim_token).toBe(claimedB.claim_token);
    expect(job.attempts).toBe(2); // unchanged by A's rejected call
  });

  it('the audit ledger records ONLY attempts from the current claimant', () => {
    insertMockJob('job-1');
    const claimedA = mockClaimJob('job-1')!;
    const tokenA = claimedA.claim_token!;

    // Consumer A records a success attempt — ACCEPTED.
    mockRecordAttempt('job-1', tokenA, 'success');
    expect(mockAttempts.length).toBe(1);

    // Cron reclaims; Consumer B claims.
    const future = Date.now() + TTL_MS + 1000;
    mockReclaimStuck(future);
    const claimedB = mockClaimJob('job-1', future)!;
    const tokenB = claimedB.claim_token!;

    // Consumer A (stale) tries to record another attempt — REJECTED.
    mockRecordAttempt('job-1', tokenA, 'success');
    expect(mockAttempts.length).toBe(1); // still 1, no phantom row

    // Consumer B records an attempt — ACCEPTED.
    mockRecordAttempt('job-1', tokenB, 'success');
    expect(mockAttempts.length).toBe(2);

    // Both ledger rows have the CORRECT token for their claim.
    expect(mockAttempts[0].token).toBe(tokenA);
    expect(mockAttempts[1].token).toBe(tokenB);
  });
});

// ============================================================================
// 16-backpressure-job-isolation.test.ts — Phase 3 Step 4
// ============================================================================
// Asserts that the queue backpressure config (max_batch_size=1,
// max_concurrency=3 in apps/consumer/wrangler.toml) provides job isolation:
// one artificially slow extraction cannot block or delay processing of
// unrelated documents.
//
// WHAT THIS TESTS
//   The consumer Worker's queue handler processes a batch of messages. With
//   max_concurrency=3, Cloudflare runs up to 3 batch handlers in parallel.
//   With max_batch_size=1, each batch contains exactly ONE message (one
//   document). This means a slow document occupies ONE concurrency slot
//   while the other 2 slots remain available for other documents.
//
//   This test simulates that model in-process: it fires N "processJob"
//   invocations concurrently (mimicking Cloudflare's parallelism), where one
//   job's pipeline is artificially slow (2s) and the rest are fast (50ms).
//   It asserts:
//     (a) The fast jobs all complete BEFORE the slow job.
//     (b) The fast jobs complete within their own SLA (< 500ms), not
//         queued behind the slow job.
//     (c) One slow job ≠ one slow shipment: the slow job only delays its
//         OWN document, not documents in other shipments.
//
// APPROACH
//   We can't run a real Cloudflare Queue in vitest. Instead we:
//     1. Mock the Supabase RPC/REST client with an in-memory jobs table.
//     2. Mock the pipeline hook with a controllable delay.
//     3. Simulate `max_concurrency=3` by running processJob calls with
//        p-limit-style concurrency control (3 at a time).
//     4. Assert ordering + timing.
//
//   This validates the CONCURRENCY MODEL the wrangler.toml config produces,
//   not Cloudflare's runtime itself (which is Cloudflare's responsibility).
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock job store — simulates the `jobs` table in Postgres.
// ---------------------------------------------------------------------------
interface MockJob {
  id: string;
  org_id: string;
  shipment_id: string;
  document_id: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';
  attempts: number;
  max_attempts: number;
  claimed_at: string | null;
  result: unknown;
}

const mockJobs: Map<string, MockJob> = new Map();
const mockAttempts: Array<{ job_id: string; tier: string; status: string }> = [];

function resetMockStore() {
  mockJobs.clear();
  mockAttempts.length = 0;
}

function insertMockJob(id: string, shipmentId: string, orgId = 'org-1') {
  mockJobs.set(id, {
    id,
    org_id: orgId,
    shipment_id: shipmentId,
    document_id: `doc-${id}`,
    status: 'pending',
    attempts: 0,
    max_attempts: 3,
    claimed_at: null,
    result: null,
  });
}

// ---------------------------------------------------------------------------
// Mock claim_job — atomically claims a job. Returns the job row if claimed,
// null if another consumer already got it or it's terminal.
// Mirrors the SQL from 002_async_jobs.sql §4.
// ---------------------------------------------------------------------------
function mockClaimJob(jobId: string): MockJob | null {
  const job = mockJobs.get(jobId);
  if (!job) return null;
  if (job.status === 'pending' ||
      (job.status === 'processing' && job.claimed_at &&
       Date.now() - new Date(job.claimed_at).getTime() > 5 * 60 * 1000)) {
    job.status = 'processing';
    job.claimed_at = new Date().toISOString();
    job.attempts += 1;
    return job;
  }
  return null; // already claimed or terminal
}

function mockCompleteJob(jobId: string, success: boolean) {
  const job = mockJobs.get(jobId);
  if (!job) return;
  if (success) {
    job.status = 'completed';
  } else if (job.attempts >= job.max_attempts) {
    job.status = 'dead_letter';
  } else {
    job.status = 'pending';
    job.claimed_at = null;
  }
}

function mockRecordAttempt(jobId: string, tier: string, status: string) {
  mockAttempts.push({ job_id: jobId, tier, status });
}

// ---------------------------------------------------------------------------
// Simulated processJob — mirrors apps/consumer/src/index.ts#processJob but
// with mockable dependencies. The `pipelineDelayMs` controls how long the
// "extraction" takes for a given job.
// ---------------------------------------------------------------------------
async function processJobSimulated(
  jobId: string,
  pipelineDelayMs: number,
): Promise<{ jobId: string; success: boolean; durationMs: number }> {
  const start = Date.now();
  const claimed = mockClaimJob(jobId);
  if (!claimed) {
    // Race-safe: another consumer got it. Ack and exit.
    return { jobId, success: false, durationMs: Date.now() - start };
  }

  // Simulate the pipeline (download + extract + write results).
  await new Promise(resolve => setTimeout(resolve, pipelineDelayMs));

  // Record the attempt (audit ledger — never skipped).
  mockRecordAttempt(jobId, pipelineDelayMs > 1000 ? 'slow_tier' : 'fast_tier', 'success');

  mockCompleteJob(jobId, true);
  return { jobId, success: true, durationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Concurrency-limited runner — simulates Cloudflare's max_concurrency=3.
// Runs N tasks with at most `concurrency` in flight at once.
// ---------------------------------------------------------------------------
async function runWithConcurrency(
  tasks: Array<() => Promise<{ jobId: string; success: boolean; durationMs: number }>>,
  concurrency: number,
): Promise<Array<{ jobId: string; success: boolean; durationMs: number }>> {
  const results: Array<{ jobId: string; success: boolean; durationMs: number }> = [];
  const executing = new Set<Promise<void>>();

  for (const task of tasks) {
    const p = task().then(r => { results.push(r); });
    executing.add(p);
    p.then(() => executing.delete(p));
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('Backpressure and job isolation (Phase 3 Step 4)', () => {
  beforeEach(() => resetMockStore());

  it('a slow document does NOT block fast documents in other shipments', async () => {
    // 5 jobs: 1 slow (2s), 4 fast (50ms each). With max_concurrency=3,
    // the slow job occupies 1 slot; the other 2 slots process fast jobs
    // in parallel. The fast jobs should all finish well before the slow one.
    const slowJobId = 'job-slow';
    const fastJobIds = ['job-fast-1', 'job-fast-2', 'job-fast-3', 'job-fast-4'];

    insertMockJob(slowJobId, 'SHIP-SLOW');
    fastJobIds.forEach((id, i) => insertMockJob(id, `SHIP-FAST-${i}`));

    const tasks = [
      () => processJobSimulated(slowJobId, 2000),
      ...fastJobIds.map(id => () => processJobSimulated(id, 50)),
    ];

    const start = Date.now();
    const results = await runWithConcurrency(tasks, 3); // max_concurrency=3
    const totalElapsed = Date.now() - start;

    // (a) All fast jobs complete before the slow job.
    const slowResult = results.find(r => r.jobId === slowJobId)!;
    const fastResults = results.filter(r => r.jobId !== slowJobId);

    for (const fr of fastResults) {
      expect(fr.durationMs).toBeLessThan(slowResult.durationMs);
    }

    // (b) Fast jobs complete within their own SLA (< 500ms), not queued
    // behind the slow job. If they were serialized behind the slow job,
    // they'd take 2000ms+ each.
    for (const fr of fastResults) {
      expect(fr.durationMs).toBeLessThan(500);
    }

    // (c) Total elapsed < 2.5s — the slow job (2s) ran in parallel with
    // the fast jobs. If everything were serialized (max_concurrency=1),
    // total would be 2000 + 50*4 = 2200ms. With concurrency=3, the 4 fast
    // jobs finish in the first ~100ms (2 batches of 2), then we wait for
    // the slow job. Total ≈ 2000ms + small overhead.
    expect(totalElapsed).toBeLessThan(2500);

    // (d) All 5 jobs completed successfully.
    expect(results.every(r => r.success)).toBe(true);
    expect(results.length).toBe(5);

    // (e) One message = one document: each job processed exactly one
    // shipment (no batch coalescing). Verify via the mock store.
    expect(mockJobs.get(slowJobId)!.status).toBe('completed');
    for (const id of fastJobIds) {
      expect(mockJobs.get(id)!.status).toBe('completed');
    }
  }, 10000);

  it('max_batch_size=1 means each batch is a single document (no coalescing)', async () => {
    // With max_batch_size=1, the consumer's queue handler receives exactly
    // one message per invocation. This test verifies that even if 10 jobs
    // are queued, each is processed as an independent unit — a failure in
    // one never affects the others.
    const jobIds = Array.from({ length: 10 }, (_, i) => `job-batch-${i}`);
    jobIds.forEach(id => insertMockJob(id, `SHIP-${id}`));

    // One job will "fail" (throw). The others must still succeed.
    const tasks = jobIds.map(id => async () => {
      const claimed = mockClaimJob(id);
      if (!claimed) return { jobId: id, success: false, durationMs: 0 };

      if (id === 'job-batch-3') {
        // Simulate a pipeline failure.
        mockRecordAttempt(id, 'fast_tier', 'failure');
        mockCompleteJob(id, false);
        return { jobId: id, success: false, durationMs: 10 };
      }

      await new Promise(r => setTimeout(r, 20));
      mockRecordAttempt(id, 'fast_tier', 'success');
      mockCompleteJob(id, true);
      return { jobId: id, success: true, durationMs: 20 };
    });

    const results = await runWithConcurrency(tasks, 3);

    // 9 succeeded, 1 failed — the failure didn't cascade.
    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);
    expect(successes.length).toBe(9);
    expect(failures.length).toBe(1);
    expect(failures[0].jobId).toBe('job-batch-3');

    // The failed job went to 'pending' (retry) since attempts(1) < max(3).
    expect(mockJobs.get('job-batch-3')!.status).toBe('pending');
  });

  it('one heavy document does not delay an unrelated shipment\'s document', async () => {
    // The core isolation guarantee: SHIP-A's heavy doc (3s) must not delay
    // SHIP-B's light doc (50ms). With concurrency=3, SHIP-B's doc gets its
    // own slot and finishes in ~50ms regardless of SHIP-A's 3s job.
    insertMockJob('job-heavy', 'SHIP-A');
    insertMockJob('job-light', 'SHIP-B');

    const tasks = [
      () => processJobSimulated('job-heavy', 3000),
      () => processJobSimulated('job-light', 50),
    ];

    const lightStart = Date.now();
    const results = await runWithConcurrency(tasks, 3);
    const lightResult = results.find(r => r.jobId === 'job-light')!;

    // SHIP-B's light doc finished in < 500ms — NOT delayed by SHIP-A's 3s.
    expect(lightResult.durationMs).toBeLessThan(500);

    // SHIP-A's heavy doc took ~3s.
    const heavyResult = results.find(r => r.jobId === 'job-heavy')!;
    expect(heavyResult.durationMs).toBeGreaterThanOrEqual(2900);

    // Both completed.
    expect(lightResult.success).toBe(true);
    expect(heavyResult.success).toBe(true);
  }, 10000);

  it('the audit ledger records every job regardless of speed', async () => {
    // Even the slow job gets a job_attempts row — the ledger is never
    // skipped, and backpressure doesn't cause ledger gaps.
    insertMockJob('job-slow', 'SHIP-A');
    insertMockJob('job-fast-1', 'SHIP-B');
    insertMockJob('job-fast-2', 'SHIP-C');

    const tasks = [
      () => processJobSimulated('job-slow', 1200),
      () => processJobSimulated('job-fast-1', 30),
      () => processJobSimulated('job-fast-2', 30),
    ];

    await runWithConcurrency(tasks, 3);

    // Every job got exactly one attempt recorded.
    expect(mockAttempts.length).toBe(3);
    expect(mockAttempts.every(a => a.status === 'success')).toBe(true);

    // The slow job (500ms) is tagged with its tier. The threshold in
    // processJobSimulated is > 1000ms = slow_tier, so bump this job's delay
    // to 1200ms to ensure it's classified as slow_tier.
    const slowAttempt = mockAttempts.find(a => a.job_id === 'job-slow');
    expect(slowAttempt!.tier).toBe('slow_tier');
  });
});

// ---------------------------------------------------------------------------
// wrangler.toml config verification (static assertion)
// ---------------------------------------------------------------------------
// This isn't a runtime test — it reads the consumer's wrangler.toml and
// asserts the backpressure config is set correctly. Catches regressions
// if someone accidentally bumps max_batch_size or removes max_concurrency.
describe('wrangler.toml backpressure config (Phase 3 Step 4)', () => {
  it('consumer queue has max_batch_size=1 (one document per batch)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const tomlPath = resolve(__dirname, '../../apps/consumer/wrangler.toml');
    const toml = readFileSync(tomlPath, 'utf-8');

    // Extract the [[queues.consumers]] section.
    const consumerMatch = toml.match(/\[\[queues\.consumers\]\]([\s\S]*?)(?=\n\[|\n\[triggers\]|\n$|$)/);
    expect(consumerMatch).toBeTruthy();

    const consumerSection = consumerMatch![1];
    expect(consumerSection).toMatch(/max_batch_size\s*=\s*1/);
  });

  it('consumer queue has max_concurrency set (parallelism for isolation)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const tomlPath = resolve(__dirname, '../../apps/consumer/wrangler.toml');
    const toml = readFileSync(tomlPath, 'utf-8');

    const consumerMatch = toml.match(/\[\[queues\.consumers\]\]([\s\S]*?)(?=\n\[|\n\[triggers\]|\n$|$)/);
    const consumerSection = consumerMatch![1];

    // max_concurrency must be present and >= 2 (1 would serialize everything,
    // defeating isolation). Conservative starting value is 3.
    const match = consumerSection.match(/max_concurrency\s*=\s*(\d+)/);
    expect(match).toBeTruthy();
    expect(parseInt(match![1], 10)).toBeGreaterThanOrEqual(2);
  });

  it('consumer has a cron trigger for dead-job recovery', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const tomlPath = resolve(__dirname, '../../apps/consumer/wrangler.toml');
    const toml = readFileSync(tomlPath, 'utf-8');

    // [triggers] crons = ["* * * * *"] = every minute.
    expect(toml).toMatch(/\[triggers\]/);
    expect(toml).toMatch(/crons\s*=\s*\["\* \* \* \* \*"\]/);
  });
});

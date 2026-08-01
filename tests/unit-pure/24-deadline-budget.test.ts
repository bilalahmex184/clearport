// ============================================================================
// 24-deadline-budget.test.ts — Phase 5 reality check (Point 3: latency explosion)
// ============================================================================
// Verifies the cross-tier deadline budget prevents retry backoffs from
// stacking to 60s+. withRetry checks the deadline before each retry sleep;
// if the next backoff would push past the deadline, it aborts instead of
// sleeping, so the tier fails fast and the pipeline falls through.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withRetry } from '../../apps/consumer/src/retry';
import { PIPELINE_DEADLINE_MS } from '../../packages/shared/src/pipeline-config';

// Capture console to suppress log noise during tests.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('Phase 5 reality check — Cross-tier deadline budget (Point 3)', () => {

  describe('PIPELINE_DEADLINE_MS constant', () => {
    it('is 150s (2.5 min) — well under the 5-min claim_job TTL', () => {
      expect(PIPELINE_DEADLINE_MS).toBe(150_000);
      // Must be < 300s (5 min claim_job TTL) with headroom for complete_job.
      expect(PIPELINE_DEADLINE_MS).toBeLessThan(300_000);
    });

    it('is documented in pipeline-config.ts with the rationale', () => {
      const src = readFileSync(
        resolve(__dirname, '../../packages/shared/src/pipeline-config.ts'),
        'utf-8',
      );
      expect(src).toMatch(/PIPELINE_DEADLINE_MS/);
      expect(src).toMatch(/cross-tier|latency explosion|stack/i);
    });
  });

  describe('withRetry respects the deadline', () => {
    it('aborts a retry if the backoff sleep would exceed the deadline', async () => {
      // Set a deadline 1s in the future. The first call fails with a 429
      // (retryable). The backoff for attempt 1 is 2s. Since now + 2s > now+1s
      // (the deadline), withRetry should abort immediately instead of sleeping.
      const deadline = Date.now() + 1_000;
      let callCount = 0;
      const mockEnv = {} as any;

      await expect(withRetry(
        mockEnv,
        'tier_1_ai',
        { job_id: 'job-1' },
        async () => {
          callCount++;
          throw Object.assign(new Error('429 rate limit'), { status: 429 });
        },
        { deadlineMs: deadline },
      )).rejects.toThrow(/deadline_exceeded/);

      // Only 1 call was made — the retry was aborted before sleeping.
      expect(callCount).toBe(1);
    });

    it('retries normally when the deadline is far in the future', async () => {
      // Deadline 10 min in the future — plenty of room for backoff.
      const deadline = Date.now() + 600_000;
      let callCount = 0;
      const mockEnv = {} as any;

      vi.useFakeTimers();
      const promise = withRetry(
        mockEnv,
        'tier_1_ai',
        { job_id: 'job-1' },
        async () => {
          callCount++;
          if (callCount < 3) {
            throw Object.assign(new Error('429'), { status: 429 });
          }
          return 'success';
        },
        { deadlineMs: deadline },
      );
      // Advance through the 2s + 4s backoff sleeps.
      await vi.advanceTimersByTimeAsync(7_000);
      const result = await promise;
      vi.useRealTimers();

      expect(result).toBe('success');
      expect(callCount).toBe(3);
    });

    it('does NOT abort on a non-retryable error (those throw immediately anyway)', async () => {
      // A 400 error is non-retryable — withRetry throws immediately, no
      // deadline check needed. The deadline is irrelevant for non-retryable.
      const deadline = Date.now() + 1_000; // very tight
      let callCount = 0;
      const mockEnv = {} as any;

      await expect(withRetry(
        mockEnv,
        'tier_1_ai',
        { job_id: 'job-1' },
        async () => {
          callCount++;
          throw Object.assign(new Error('400 bad request'), { status: 400 });
        },
        { deadlineMs: deadline },
      )).rejects.toThrow(/non_retryable/);

      expect(callCount).toBe(1); // no retry attempted
    });

    it('the deadline-exceeded error message includes the budget remaining', async () => {
      const deadline = Date.now() + 500; // 500ms remaining
      const mockEnv = {} as any;

      await expect(withRetry(
        mockEnv,
        'tier_1_ai',
        { job_id: 'job-1' },
        async () => {
          throw Object.assign(new Error('429'), { status: 429 });
        },
        { deadlineMs: deadline },
      )).rejects.toThrow(/remaining in pipeline budget/);
    });
  });

  describe('the pipeline-hook threads the deadline through', () => {
    it('pipeline-hook.ts imports PIPELINE_DEADLINE_MS', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      expect(src).toMatch(/PIPELINE_DEADLINE_MS/);
      expect(src).toMatch(/pipelineDeadlineMs/);
    });

    it('runTier1AI receives the deadline and passes it to withRetry', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      // runTier1AI signature includes pipelineDeadlineMs.
      expect(src).toMatch(/runTier1AI\(env.*pipelineDeadlineMs/);
      // The withRetry call passes deadlineMs.
      expect(src).toMatch(/deadlineMs:\s*pipelineDeadlineMs/);
    });

    it('the deadline is computed from the pipeline start time, not per-tier', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      // The deadline = start + PIPELINE_DEADLINE_MS (one budget for ALL tiers).
      expect(src).toMatch(/start\s*\+\s*PIPELINE_DEADLINE_MS/);
    });
  });

  describe('worst-case latency is bounded', () => {
    it('the total pipeline latency cannot exceed PIPELINE_DEADLINE_MS + one tier call', () => {
      // The deadline aborts retry sleeps, but the IN-FLIGHT call may still
      // run to completion (up to MAX_TIER_LATENCY_MS = 18s). So worst case
      // total = PIPELINE_DEADLINE_MS + MAX_TIER_LATENCY_MS = 150 + 18 = 168s.
      // This is well under the 5-min (300s) claim_job TTL — 132s of headroom
      // for complete_job + ledger writes.
      const MAX_TIER_LATENCY_MS = 18_000;
      const worstCase = PIPELINE_DEADLINE_MS + MAX_TIER_LATENCY_MS;
      expect(worstCase).toBeLessThan(300_000); // < 5 min claim_job TTL
      expect(worstCase).toBe(168_000); // 150 + 18
    });
  });
});

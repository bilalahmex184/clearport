// ============================================================================
// retry.ts — Retry wrapper with error classification + exponential backoff
// ============================================================================
// WHAT THIS IS
//   A generic retry wrapper that classifies each error via classifyError and
//   retries ONLY retryable errors (429/5xx/timeout/network) with exponential
//   backoff. Non-retryable errors (400/401/404/schema_validation) throw
//   immediately — no retry budget wasted on errors that will NEVER succeed.
//
// USAGE
//   const result = await withRetry(env, 'tier_1_ai', { job_id, org_id },
//     async (attempt) => callOpenRouterExtraction(env, input, deadline),
//     { maxAttempts: 3 });
//
//   - On success: logs `tier_1_ai attempt N succeeded` and returns the result.
//   - On non-retryable error: throws `tier_1_ai failed (non_retryable:
//     client_error, status=400) — not retrying` immediately. The classification
//     is in the error message so it propagates to job_attempts.error_message.
//   - On retryable error + attempts remaining: logs `tier_1_ai attempt N
//     failed (retryable: rate_limit) — retrying in 2000ms`, sleeps, retries.
//   - On retryable error + attempts exhausted: throws `tier_1_ai failed after
//     3 attempts (retryable: rate_limit) — exhausted retries`.
//
// WHY CLASSIFY BEFORE RETRYING
//   The previous tier logic retried every error the same way — a 400 (bad
//   request) got retried 3x with backoff, wasting ~6s+ of latency on a request
//   that would NEVER succeed. A 429 (rate limit) was retried immediately with
//   no backoff, hammering the rate-limited endpoint. This wrapper fixes both:
//   non-retryable errors fail fast, retryable errors back off exponentially.
//
// LOGGING
//   Every attempt + classification is logged via the shared structured logger
//   (@clearport/shared/logger) — never console.log directly. The log line
//   includes job_id, org_id, step, latency_ms, outcome, attempt, error_class,
//   reason, statusCode (when applicable) so the reviewer can see WHY each
//   attempt failed and whether it was retried.
// ============================================================================

import type { Env } from './env';
import {
  logInfo,
  logWarn,
  logError,
  type LoggerEnv,
} from '@clearport/shared/logger';
import {
  classifyError,
  computeBackoffDelay,
  RETRY_CONFIG,
  type ErrorClass,
} from './error-classifier';
import { PIPELINE_DEADLINE_MS } from '@clearport/shared/pipeline-config';

/**
 * Context passed through to every log call. Carries the job_id + org_id so
 * the log line is correlated to the extraction job that produced it.
 */
export interface RetryContext {
  job_id?: string;
  org_id?: string;
}

/**
 * Options for withRetry. `maxAttempts` tunes the retry count; `deadlineMs`
 * is the cross-tier budget (Phase 5 reality check Point 3) — if the next
 * backoff sleep would exceed it, withRetry aborts instead of sleeping.
 */
export interface RetryOptions {
  maxAttempts?: number;
  /**
   * Absolute deadline (epoch ms). If the next retry's backoff sleep would
   * push past this deadline, withRetry throws a "deadline_exceeded" error
   * instead of sleeping. This prevents retry backoffs from stacking across
   * tiers and blowing past the claim_job TTL.
   *
   * Defaults to PIPELINE_DEADLINE_MS (150s) from now.
   */
  deadlineMs?: number;
}

/**
 * withRetry — wraps an async function with classification-driven retries.
 *
 *   const result = await withRetry(env, 'tier_1_ai', { job_id, org_id },
 *     async (attempt) => callOpenRouterExtraction(env, input, deadline),
 *     { maxAttempts: 3 });
 *
 * Behavior:
 *   - For each attempt 1..maxAttempts:
 *     - Call fn(attempt).
 *     - On success: log info + return the result.
 *     - On error: classify.
 *       - non_retryable  → log error + throw immediately (no retry).
 *       - retryable + attempts remaining → log warn + sleep backoff + retry.
 *       - retryable + attempts exhausted → log error + throw "exhausted".
 *   - Every attempt + classification is logged via the shared logger.
 */
export async function withRetry<T>(
  env: Env,
  step: string,
  context: RetryContext,
  fn: (attempt: number) => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? RETRY_CONFIG.maxAttempts;
  // Cross-tier deadline (Phase 5 Point 3). Default: PIPELINE_DEADLINE_MS from
  // now. If the caller passes a deadline (e.g. the pipeline start time +
  // PIPELINE_DEADLINE_MS), use that. Before each retry sleep, we check if
  // Date.now() + delay > deadline — if so, abort instead of sleeping.
  const deadline = options?.deadlineMs ?? (Date.now() + PIPELINE_DEADLINE_MS);
  // The shared logger accepts LoggerEnv (LOGSHIP_URL/LOG_LEVEL/SERVICE_NAME).
  // The consumer's Env may carry these as extra properties at runtime (set
  // via wrangler vars); cast so the logger can read them if present.
  const loggerEnv = env as unknown as LoggerEnv;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = Date.now();
    try {
      const result = await fn(attempt);
      const latencyMs = Date.now() - start;
      logInfo(
        loggerEnv,
        `${step} attempt ${attempt} succeeded`,
        { ...context, step, latency_ms: latencyMs },
        { attempt, outcome: 'success' },
      );
      return result;
    } catch (err) {
      lastError = err;
      const latencyMs = Date.now() - start;
      const classification = classifyError(err);
      const statusSuffix = classification.statusCode
        ? `, status=${classification.statusCode}`
        : '';
      const errorDetail = errorMessage(err);

      if (classification.class === 'non_retryable') {
        // Non-retryable: throw immediately. The classification is in the
        // message so it propagates to job_attempts.error_message.
        logError(
          loggerEnv,
          `${step} attempt ${attempt} failed (non_retryable: ${classification.reason}${statusSuffix}) — not retrying`,
          { ...context, step, latency_ms: latencyMs },
          {
            attempt,
            outcome: 'failure',
            error_class: 'non_retryable' as ErrorClass,
            reason: classification.reason,
            statusCode: classification.statusCode,
            error: errorDetail,
          },
        );
        throw new Error(
          `${step} failed (non_retryable: ${classification.reason}${statusSuffix}) — not retrying [${errorDetail}]`,
        );
      }

      // Retryable error.
      if (attempt < maxAttempts) {
        const delay = computeBackoffDelay(attempt);
        const now = Date.now();
        // Cross-tier deadline check (Phase 5 Point 3): if the next backoff
        // sleep would push past the deadline, abort NOW instead of sleeping.
        // This prevents retry backoffs from stacking across tiers and
        // blowing past the claim_job TTL. The tier fails fast, the pipeline
        // falls through to the next tier (or needs_manual_review).
        if (now + delay > deadline) {
          const remainingMs = Math.max(0, deadline - now);
          logWarn(
            loggerEnv,
            `${step} attempt ${attempt} failed (retryable: ${classification.reason}${statusSuffix}) — deadline_exceeded, aborting retry (would need ${delay}ms, ${remainingMs}ms remaining)`,
            { ...context, step, latency_ms: latencyMs },
            {
              attempt,
              outcome: 'warning',
              error_class: 'retryable' as ErrorClass,
              reason: classification.reason,
              statusCode: classification.statusCode,
              deadline_ms: deadline,
              remaining_ms: remainingMs,
              next_delay_ms: delay,
              error: errorDetail,
            },
          );
          throw new Error(
            `${step} failed — deadline_exceeded (retryable: ${classification.reason}${statusSuffix}, would need ${delay}ms but only ${remainingMs}ms remaining in pipeline budget) [${errorDetail}]`,
          );
        }
        logWarn(
          loggerEnv,
          `${step} attempt ${attempt} failed (retryable: ${classification.reason}${statusSuffix}) — retrying in ${delay}ms`,
          { ...context, step, latency_ms: latencyMs },
          {
            attempt,
            outcome: 'warning',
            error_class: 'retryable' as ErrorClass,
            reason: classification.reason,
            statusCode: classification.statusCode,
            next_delay_ms: delay,
            deadline_ms: deadline,
            remaining_ms: deadline - now,
            error: errorDetail,
          },
        );
        await sleep(delay);
        continue;
      }

      // Retryable + exhausted all attempts.
      logError(
        loggerEnv,
        `${step} attempt ${attempt} failed after ${maxAttempts} attempts (retryable: ${classification.reason}${statusSuffix}) — exhausted retries`,
        { ...context, step, latency_ms: latencyMs },
        {
          attempt,
          outcome: 'failure',
          error_class: 'retryable' as ErrorClass,
          reason: classification.reason,
          statusCode: classification.statusCode,
          error: errorDetail,
        },
      );
      throw new Error(
        `${step} failed after ${maxAttempts} attempts (retryable: ${classification.reason}${statusSuffix}) — exhausted retries [${errorDetail}]`,
      );
    }
  }

  // Defensive: the loop above either returns or throws on every path. If we
  // ever reach here, something is very wrong — surface it as a hard error.
  throw new Error(
    `${step} failed — retry loop exited unexpectedly after ${maxAttempts} attempts. ` +
    `Last error: ${errorMessage(lastError)}`,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * sleep — promise-based delay. Uses setTimeout (the one setTimeout the
 * Workers runtime provides). Resolves after `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * errorMessage — safely extract a string message from any thrown value.
 * Used so the error detail in logs/messages is always a string (never
 * '[object Object]').
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

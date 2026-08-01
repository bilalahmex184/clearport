// ============================================================================
// error-classifier.ts — Error classification for retry decisions (Phase 5 Step 3)
// ============================================================================
// WHAT THIS IS
//   A pure function that inspects any thrown value and decides whether the
//   retry loop should retry it (transient — might succeed on retry) or give
//   up immediately (will NEVER succeed on retry). The classification drives
//   the retry loop in retry.ts and is logged to job_attempts.error_message
//   so a reviewer can see WHY a tier wasn't retried.
//
// THE CLASSIFICATION (the retry loop's source of truth)
//   Retryable errors (transient — might succeed on retry):
//     - 429 Too Many Requests (rate limit)
//     - 5xx server errors (500, 502, 503, 504)
//     - Network timeouts (AbortError, fetch timeout)
//     - Network errors (ECONNRESET, ECONNREFUSED — connection dropped)
//
//   Non-retryable errors (will NEVER succeed on retry):
//     - 4xx client errors EXCEPT 429 (400 bad request, 401 auth, 403 forbidden,
//       404 not found, 422 validation error)
//     - Schema validation failures (the LLM returned malformed JSON — retrying
//       the same prompt won't help)
//     - Malformed-request errors (wrong API key format, bad endpoint)
//
// FAIL-SAFE DEFAULT
//   Unknown errors are classified as NON-retryable. The retry loop never
//   wastes budget on errors it doesn't understand — better to fall through to
//   the next tier (or dead-letter) than to hammer an unknown failure mode.
// ============================================================================

/**
 * The two possible classifications. Drives the retry loop:
 *   - 'retryable'     → retry with exponential backoff (up to maxAttempts)
 *   - 'non_retryable' → throw immediately, no retry
 */
export type ErrorClass = 'retryable' | 'non_retryable';

/**
 * The result of classifying an error. `reason` is a short machine-readable
 * slug that ends up in logs + the job_attempts.error_message column.
 */
export interface ErrorClassification {
  class: ErrorClass;
  reason: string;
  /** HTTP status code if the error came from an HTTP response. */
  statusCode?: number;
}

/**
 * RETRY_CONFIG — the retry budget. base 2s, doubling, capped at 30s, max 3
 * attempts. Tuned for the OpenRouter / Cloud Vision API calls which typically
 * recover within seconds on 429/5xx but can take longer under load.
 *
 *   attempt 1 fails → sleep 2s  → attempt 2
 *   attempt 2 fails → sleep 4s  → attempt 3
 *   attempt 3 fails → sleep 8s  → attempt 4 (if maxAttempts allowed)
 *   ...
 *   attempt 5 fails → sleep 30s (capped) → attempt 6
 *
 * The 30s cap prevents a single stuck tier from blowing the 5-min claim_job
 * TTL — after ~30s of backoff the tier falls through and the next tier tries.
 */
export const RETRY_CONFIG = {
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  maxAttempts: 3,
} as const;

/**
 * computeBackoffDelay — exponential backoff: base * 2^(attempt-1), capped at
 * maxDelayMs.
 *
 *   attempt 1 → 2s   (2_000 * 2^0)
 *   attempt 2 → 4s   (2_000 * 2^1)
 *   attempt 3 → 8s   (2_000 * 2^2)
 *   attempt 4 → 16s  (2_000 * 2^3)
 *   attempt 5 → 30s  (capped — 2_000 * 2^4 = 32_000 > 30_000)
 *
 * NOTE: this is the delay BEFORE the NEXT attempt. So `computeBackoffDelay(1)`
 * is how long we sleep after attempt 1 fails, before attempt 2.
 */
export function computeBackoffDelay(attempt: number): number {
  return Math.min(
    RETRY_CONFIG.baseDelayMs * 2 ** (attempt - 1),
    RETRY_CONFIG.maxDelayMs,
  );
}

/**
 * classifyError — inspect any thrown value and decide whether to retry.
 *
 * The order of checks matters:
 *   1. HTTP status code (most reliable — set explicitly by the upstream API)
 *   2. Timeout/abort patterns (network-level — name + message regex)
 *   3. Network error patterns (ECONNRESET etc.)
 *   4. Schema validation patterns (LLM returned malformed JSON)
 *   5. Default → non_retryable (fail safe — don't retry what you don't know)
 *
 * The function never throws — it always returns a classification. Callers
 * can safely pass any unknown value.
 */
export function classifyError(error: unknown): ErrorClassification {
  // --- 1. HTTP status code ---
  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined) {
    if (statusCode === 429) {
      return { class: 'retryable', reason: 'rate_limit', statusCode };
    }
    if (statusCode >= 500 && statusCode < 600) {
      return { class: 'retryable', reason: 'server_error', statusCode };
    }
    if (statusCode >= 400 && statusCode < 500) {
      // 4xx (except 429, handled above) — the request itself is bad; retrying
      // the same request will produce the same 4xx. Non-retryable.
      return { class: 'non_retryable', reason: 'client_error', statusCode };
    }
  }

  // --- Build a combined string for the regex checks below ---
  const name = stringProperty(error, 'name');
  const message = stringProperty(error, 'message');
  const combined = `${name} ${message}`.trim();

  // --- 2. Timeout / abort ---
  // AbortError, "Request timed out", "The operation was aborted" — all
  // transient (the upstream might respond in time on retry).
  if (/timeout|abort|timed out/i.test(combined)) {
    return { class: 'retryable', reason: 'timeout' };
  }

  // --- 3. Network error ---
  // ECONNRESET (connection reset by peer), ECONNREFUSED (service down),
  // "fetch failed" (Workers fetch() throws this on DNS/TLS errors).
  if (/ECONNRESET|ECONNREFUSED|fetch failed|network/i.test(combined)) {
    return { class: 'retryable', reason: 'network_error' };
  }

  // --- 4. Schema validation failure ---
  // The LLM returned malformed JSON or a response that failed Zod validation.
  // Retrying the SAME prompt will likely produce the SAME malformed output —
  // non-retryable. (The pipeline falls through to the next tier instead.)
  if (/schema_validation_failed|invalid json|parse error/i.test(combined)) {
    return { class: 'non_retryable', reason: 'schema_validation' };
  }

  // --- 5. Default: fail safe ---
  // Don't retry what you don't understand. The retry budget is precious —
  // better to fall through to the next tier (or dead-letter) than to hammer
  // an unknown failure mode 3 times with backoff.
  return { class: 'non_retryable', reason: 'unknown' };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * extractStatusCode — pull the HTTP status code off an error object.
 * Looks for `status` (fetch Response convention) then `statusCode` (Node
 * convention). Returns undefined if neither is a number.
 */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const obj = error as { status?: unknown; statusCode?: unknown };
  if (typeof obj.status === 'number') return obj.status;
  if (typeof obj.statusCode === 'number') return obj.statusCode;
  return undefined;
}

/**
 * stringProperty — safely read a string property off an unknown value.
 * Used to pull `error.name` and `error.message` without trusting the shape.
 */
function stringProperty(error: unknown, key: 'name' | 'message'): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

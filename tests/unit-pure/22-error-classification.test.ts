// ============================================================================
// 22-error-classification.test.ts — Phase 5 Step 3 (error classification)
// ============================================================================
// Verifies the error classifier that drives the retry loop's decisions:
//   - 429 + 5xx + timeout + network errors → retryable (transient)
//   - 4xx (except 429) + schema validation failures → non-retryable (will
//     NEVER succeed on retry)
//   - unknown errors → non-retryable (FAIL SAFE — don't retry what you don't
//     understand)
//
// Also verifies the exponential backoff schedule:
//   attempt 1 → 2s, attempt 2 → 4s, attempt 3 → 8s, attempt 5 → 30s (capped)
//
// These are PURE LOGIC tests — no network, no Workers runtime, no fake timers.
// The retry-loop behavior that USES this classifier is tested in
// 23-retry-with-classification.test.ts.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  classifyError,
  computeBackoffDelay,
  RETRY_CONFIG,
  type ErrorClass,
} from '../../apps/consumer/src/error-classifier';

// ---------------------------------------------------------------------------
// Helper: build an Error with a status code attached (matches the shape
// thrown by the tier-1 fetch wrapper in tiers.ts).
// ---------------------------------------------------------------------------
function httpError(status: number, message?: string): Error & { status: number } {
  return Object.assign(
    new Error(message || `HTTP ${status}`),
    { status },
  );
}

// ---------------------------------------------------------------------------
// Helper: build an Error with a name + message (matches AbortError,
// ECONNRESET, etc.).
// ---------------------------------------------------------------------------
function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

// ===========================================================================
// TESTS — classifyError
// ===========================================================================

describe('Phase 5 Step 3 — Error classification (retryable vs non-retryable)', () => {

  describe('retryable: HTTP status codes (transient — might succeed on retry)', () => {
    it('429 is retryable (rate_limit)', () => {
      const cls = classifyError(httpError(429, 'Too Many Requests'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('rate_limit');
      expect(cls.statusCode).toBe(429);
    });

    it('500 is retryable (server_error)', () => {
      const cls = classifyError(httpError(500, 'Internal Server Error'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('server_error');
      expect(cls.statusCode).toBe(500);
    });

    it('503 is retryable (server_error)', () => {
      const cls = classifyError(httpError(503, 'Service Unavailable'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('server_error');
      expect(cls.statusCode).toBe(503);
    });

    it('502 is retryable (server_error)', () => {
      const cls = classifyError(httpError(502, 'Bad Gateway'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('server_error');
      expect(cls.statusCode).toBe(502);
    });

    it('504 is retryable (server_error)', () => {
      const cls = classifyError(httpError(504, 'Gateway Timeout'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('server_error');
      expect(cls.statusCode).toBe(504);
    });
  });

  describe('non-retryable: HTTP 4xx (except 429) — the request itself is bad', () => {
    it('400 is non_retryable (client_error)', () => {
      const cls = classifyError(httpError(400, 'Bad Request'));
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('client_error');
      expect(cls.statusCode).toBe(400);
    });

    it('401 is non_retryable (client_error — auth failure)', () => {
      const cls = classifyError(httpError(401, 'Unauthorized'));
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('client_error');
      expect(cls.statusCode).toBe(401);
    });

    it('403 is non_retryable (client_error — forbidden)', () => {
      const cls = classifyError(httpError(403, 'Forbidden'));
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('client_error');
      expect(cls.statusCode).toBe(403);
    });

    it('404 is non_retryable (client_error — not found)', () => {
      const cls = classifyError(httpError(404, 'Not Found'));
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('client_error');
      expect(cls.statusCode).toBe(404);
    });

    it('422 is non_retryable (client_error — validation)', () => {
      const cls = classifyError(httpError(422, 'Unprocessable Entity'));
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('client_error');
      expect(cls.statusCode).toBe(422);
    });
  });

  describe('retryable: timeouts + network errors (transient)', () => {
    it('AbortError (timeout) is retryable', () => {
      // Mimics the DOMException thrown by AbortSignal.timeout().
      const cls = classifyError(namedError('AbortError', 'The operation was aborted'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('timeout');
    });

    it('"Request timed out" message is retryable (timeout)', () => {
      const cls = classifyError(new Error('Request timed out after 18000ms'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('timeout');
    });

    it('"timed out" in the message is retryable', () => {
      const cls = classifyError(new Error('The fetch operation timed out'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('timeout');
    });

    it('ECONNRESET is retryable (network_error)', () => {
      const cls = classifyError(namedError('Error', 'fetch failed: ECONNRESET'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('network_error');
    });

    it('ECONNREFUSED is retryable (network_error)', () => {
      const cls = classifyError(new Error('connect ECONNREFUSED 127.0.0.1:443'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('network_error');
    });

    it('"fetch failed" is retryable (network_error — Workers fetch() throws this)', () => {
      const cls = classifyError(new Error('fetch failed'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('network_error');
    });

    it('"network" in the message is retryable', () => {
      const cls = classifyError(new Error('network request failed'));
      expect(cls.class).toBe('retryable' as ErrorClass);
      expect(cls.reason).toBe('network_error');
    });
  });

  describe('non-retryable: schema validation failures (LLM returned malformed JSON)', () => {
    it('"schema_validation_failed" message is non_retryable', () => {
      const cls = classifyError(new Error('schema_validation_failed: missing field'));
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('schema_validation');
    });

    it('"invalid json" message is non_retryable', () => {
      const cls = classifyError(new Error('invalid json: unexpected token'));
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('schema_validation');
    });

    it('"parse error" message is non_retryable', () => {
      const cls = classifyError(new Error('parse error at line 1 column 1'));
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('schema_validation');
    });
  });

  describe('fail-safe default: unknown errors are non-retryable', () => {
    it('a generic Error with no recognizable pattern is non_retryable (unknown)', () => {
      const cls = classifyError(new Error('something completely unexpected'));
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('unknown');
    });

    it('a thrown string is non_retryable (unknown)', () => {
      const cls = classifyError('just a string');
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('unknown');
    });

    it('a thrown object with no message is non_retryable (unknown)', () => {
      const cls = classifyError({ random: 'object' });
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('unknown');
    });

    it('null is non_retryable (unknown) — does not throw', () => {
      const cls = classifyError(null);
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('unknown');
    });

    it('undefined is non_retryable (unknown) — does not throw', () => {
      const cls = classifyError(undefined);
      expect(cls.class).toBe('non_retryable' as ErrorClass);
      expect(cls.reason).toBe('unknown');
    });
  });

  describe('the classifier never throws (robustness)', () => {
    it('classifyError on a circular object does not throw', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => classifyError(circular)).not.toThrow();
      const cls = classifyError(circular);
      expect(cls.class).toBe('non_retryable' as ErrorClass);
    });
  });
});

// ===========================================================================
// TESTS — RETRY_CONFIG + computeBackoffDelay (the exponential backoff schedule)
// ===========================================================================

describe('Phase 5 Step 3 — Exponential backoff schedule', () => {

  describe('RETRY_CONFIG constants', () => {
    it('baseDelayMs is 2 seconds (2000ms)', () => {
      expect(RETRY_CONFIG.baseDelayMs).toBe(2_000);
    });

    it('maxDelayMs is 30 seconds (30000ms) — the cap', () => {
      expect(RETRY_CONFIG.maxDelayMs).toBe(30_000);
    });

    it('maxAttempts is 3', () => {
      expect(RETRY_CONFIG.maxAttempts).toBe(3);
    });
  });

  describe('computeBackoffDelay — exponential doubling, capped at maxDelayMs', () => {
    it('attempt 1 → 2s (base * 2^0)', () => {
      expect(computeBackoffDelay(1)).toBe(2_000);
    });

    it('attempt 2 → 4s (base * 2^1)', () => {
      expect(computeBackoffDelay(2)).toBe(4_000);
    });

    it('attempt 3 → 8s (base * 2^2)', () => {
      expect(computeBackoffDelay(3)).toBe(8_000);
    });

    it('attempt 4 → 16s (base * 2^3)', () => {
      expect(computeBackoffDelay(4)).toBe(16_000);
    });

    it('attempt 5 → 30s (capped — base * 2^4 = 32000 > maxDelayMs)', () => {
      expect(computeBackoffDelay(5)).toBe(30_000);
    });

    it('attempt 10 → 30s (still capped)', () => {
      expect(computeBackoffDelay(10)).toBe(30_000);
    });

    it('attempt 100 → 30s (still capped — no overflow)', () => {
      expect(computeBackoffDelay(100)).toBe(30_000);
    });
  });

  describe('the backoff curve is monotonically non-decreasing', () => {
    it('each attempt delay >= the previous attempt delay', () => {
      let prev = 0;
      for (let attempt = 1; attempt <= 10; attempt++) {
        const delay = computeBackoffDelay(attempt);
        expect(delay).toBeGreaterThanOrEqual(prev);
        prev = delay;
      }
    });
  });
});

// ============================================================================
// 23-retry-with-classification.test.ts — Phase 5 Step 3 (retry wrapper)
// ============================================================================
// Verifies withRetry — the wrapper that classifies each error via
// classifyError and retries ONLY retryable errors (429/5xx/timeout/network)
// with exponential backoff (2s, 4s, 8s, cap 30s, max 3 attempts).
// Non-retryable errors (400/401/404/schema_validation) throw immediately —
// no retry budget wasted on errors that will NEVER succeed.
//
// WHAT THIS TESTS
//   1. A 400 error is NEVER retried — fn called exactly ONCE, withRetry
//      throws with "non_retryable" + "client_error".
//   2. A 429 is retried with increasing delay (2s then 4s) — fake timers
//      verify the backoff schedule; fn(3) succeeds.
//   3. A 429 that fails 3 times exhausts retries — fn called 3x (maxAttempts),
//      withRetry throws with "exhausted retries".
//   4. A 500 is retried (server_error is retryable) — same shape as 429.
//   5. Success on attempt 1 doesn't retry — fn called once.
//   6. The retry logs include the classification ("retryable: rate_limit" /
//      "non_retryable: client_error") — verified by capturing console output.
//   7. Non-retryable errors don't sleep — a 400 throws immediately with no
//      time advanced (verified via fake timers).
//
// FAKE TIMERS
//   vi.useFakeTimers() + vi.setSystemTime(0) so Date.now() is deterministic.
//   The backoff sleeps (setTimeout) are advanced via vi.advanceTimersByTimeAsync,
//   which also flushes microtasks so withRetry progresses through the loop.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withRetry } from '../../apps/consumer/src/retry';
import type { Env } from '../../apps/consumer/src/env';

// ---------------------------------------------------------------------------
// Mock Env — withRetry only reads LOGSHIP_URL/LOG_LEVEL/SERVICE_NAME from env
// (for the shared logger). All other Env fields are stubbed. Cast through
// `unknown` to avoid providing every required field.
// ---------------------------------------------------------------------------
function createMockEnv(): Env {
  return {
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    EXTRACTION_QUEUE: {} as Env['EXTRACTION_QUEUE'],
    CIRCUIT_BREAKER_KV: {} as unknown as Env['CIRCUIT_BREAKER_KV'],
  } as unknown as Env;
}

// ---------------------------------------------------------------------------
// HTTP error helper — matches the shape thrown by tiers.ts (Error + status).
// ---------------------------------------------------------------------------
function httpError(status: number, message?: string): Error & { status: number } {
  return Object.assign(
    new Error(message || `HTTP ${status}`),
    { status },
  );
}

// ---------------------------------------------------------------------------
// Capture console output so we can assert on the structured JSON log lines.
// The shared logger calls console[level](JSON.stringify(line)) — we parse the
// JSON and collect the lines for assertion. (Same pattern as 19-logger.test.)
// ---------------------------------------------------------------------------
function captureConsole(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  const grab = (msg: unknown) => {
    if (typeof msg === 'string') {
      try { lines.push(JSON.parse(msg)); } catch { lines.push({ raw: msg }); }
    } else if (typeof msg === 'object' && msg !== null) {
      lines.push(msg as Record<string, unknown>);
    }
  };
  vi.spyOn(console, 'log').mockImplementation(grab);
  vi.spyOn(console, 'info').mockImplementation(grab);
  vi.spyOn(console, 'warn').mockImplementation(grab);
  vi.spyOn(console, 'error').mockImplementation(grab);
  return lines;
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('Phase 5 Step 3 — withRetry (classification-driven retries)', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: A 400 error is NEVER retried.
  // -------------------------------------------------------------------------
  it('a 400 error is NEVER retried (fn called exactly once)', async () => {
    captureConsole();
    const err400 = httpError(400, 'Bad Request');
    const fn = vi.fn(async () => { throw err400; });

    await expect(
      withRetry(env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 }),
    ).rejects.toThrow(/non_retryable/);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a 400 error throw message includes the classification + reason', async () => {
    captureConsole();
    const err400 = httpError(400, 'Bad Request');
    const fn = vi.fn(async () => { throw err400; });

    await expect(
      withRetry(env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 }),
    ).rejects.toThrow(/non_retryable: client_error/);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 2: A 429 is retried with increasing delay (2s then 4s).
  // -------------------------------------------------------------------------
  it('a 429 is retried with increasing delay (2s then 4s) and succeeds on attempt 3', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    captureConsole();

    const callTimes: number[] = [];
    const err429 = httpError(429, 'Too Many Requests');

    const fn = vi.fn(async (attempt: number) => {
      callTimes.push(Date.now());
      if (attempt < 3) throw err429;
      return 'success';
    });

    const promise = withRetry(
      env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 },
    );

    // Advance past sleep(2000) — fn(2) is called at t=2000.
    await vi.advanceTimersByTimeAsync(2_000);
    // Advance past sleep(4000) — fn(3) is called at t=6000 and succeeds.
    await vi.advanceTimersByTimeAsync(4_000);

    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
    // Call 1 at t=0, call 2 at t=2000 (after 2s backoff), call 3 at t=6000
    // (after 2s + 4s backoff). This verifies the exponential schedule.
    expect(callTimes).toEqual([0, 2_000, 6_000]);
  });

  // -------------------------------------------------------------------------
  // Test 3: A 429 that fails 3 times exhausts retries.
  // -------------------------------------------------------------------------
  it('a 429 that fails 3 times exhausts retries (fn called maxAttempts times)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    captureConsole();

    const err429 = httpError(429, 'Too Many Requests');
    const fn = vi.fn(async () => { throw err429; });

    const promise = withRetry(
      env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 },
    );
    // Suppress the unhandled-rejection warning that fires between the
    // advanceTimersByTimeAsync (which triggers the throw) and the
    // `await expect(promise).rejects.toThrow(...)` below.
    promise.catch(() => {});

    // Advance past both backoff sleeps (2s + 4s).
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(promise).rejects.toThrow(/exhausted retries/);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('exhausted-retries throw message includes the classification + reason', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    captureConsole();

    const err429 = httpError(429, 'Too Many Requests');
    const fn = vi.fn(async () => { throw err429; });

    const promise = withRetry(
      env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 },
    );
    promise.catch(() => {}); // suppress unhandled-rejection (see test 3)

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(promise).rejects.toThrow(/retryable: rate_limit/);
    await expect(promise).rejects.toThrow(/exhausted retries/);
  });

  // -------------------------------------------------------------------------
  // Test 4: A 500 is retried (server_error is retryable) — same shape as 429.
  // -------------------------------------------------------------------------
  it('a 500 is retried (server_error is retryable) and succeeds on attempt 3', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    captureConsole();

    const callTimes: number[] = [];
    const err500 = httpError(500, 'Internal Server Error');

    const fn = vi.fn(async (attempt: number) => {
      callTimes.push(Date.now());
      if (attempt < 3) throw err500;
      return 'recovered';
    });

    const promise = withRetry(
      env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 },
    );

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);

    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(callTimes).toEqual([0, 2_000, 6_000]);
  });

  it('a 503 that exhausts retries throws "exhausted retries" with server_error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    captureConsole();

    const err503 = httpError(503, 'Service Unavailable');
    const fn = vi.fn(async () => { throw err503; });

    const promise = withRetry(
      env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 },
    );
    promise.catch(() => {}); // suppress unhandled-rejection (see test 3)

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(promise).rejects.toThrow(/retryable: server_error/);
    await expect(promise).rejects.toThrow(/exhausted retries/);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // Test 5: Success on attempt 1 doesn't retry.
  // -------------------------------------------------------------------------
  it('success on attempt 1 does not retry (fn called once)', async () => {
    captureConsole();
    const fn = vi.fn(async () => 'first-try-success');

    const result = await withRetry(
      env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 },
    );

    expect(result).toBe('first-try-success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 6: The retry logs include the classification.
  // -------------------------------------------------------------------------
  it('the retry logs include "non_retryable: client_error" for a 400', async () => {
    const lines = captureConsole();
    const err400 = httpError(400, 'Bad Request');
    const fn = vi.fn(async () => { throw err400; });

    await expect(
      withRetry(env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 }),
    ).rejects.toThrow();

    // At least one log line must mention the classification.
    const classifiedLines = lines.filter(
      (l) => typeof l.message === 'string' && l.message.includes('non_retryable: client_error'),
    );
    expect(classifiedLines.length).toBeGreaterThanOrEqual(1);
  });

  it('the retry logs include "retryable: rate_limit" for a 429 that is retried', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const lines = captureConsole();

    const err429 = httpError(429, 'Too Many Requests');
    const fn = vi.fn(async (attempt: number) => {
      if (attempt < 2) throw err429;
      return 'ok';
    });

    const promise = withRetry(
      env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;

    expect(result).toBe('ok');

    const classifiedLines = lines.filter(
      (l) => typeof l.message === 'string' && l.message.includes('retryable: rate_limit'),
    );
    expect(classifiedLines.length).toBeGreaterThanOrEqual(1);
  });

  it('every retry log line carries the required Phase 5 structured fields', async () => {
    const lines = captureConsole();
    const err400 = httpError(400, 'Bad Request');
    const fn = vi.fn(async () => { throw err400; });

    await expect(
      withRetry(env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 }),
    ).rejects.toThrow();

    // The error log line must carry step, outcome, error_class, reason.
    const errorLine = lines.find(
      (l) => typeof l.message === 'string' && l.message.includes('non_retryable'),
    );
    expect(errorLine).toBeDefined();
    expect(errorLine!.step).toBe('tier_1_ai');
    expect(errorLine!.outcome).toBe('failure');
    expect(errorLine!.error_class).toBe('non_retryable');
    expect(errorLine!.reason).toBe('client_error');
    expect(errorLine!.statusCode).toBe(400);
    expect(errorLine!.job_id).toBe('j1');
    expect(errorLine!.org_id).toBe('o1');
  });

  // -------------------------------------------------------------------------
  // Test 7: Non-retryable errors don't sleep (no time advanced).
  // -------------------------------------------------------------------------
  it('a 400 error throws immediately with no time advanced (no sleep)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    captureConsole();

    const err400 = httpError(400, 'Bad Request');
    const fn = vi.fn(async () => { throw err400; });

    await expect(
      withRetry(env, 'tier_1_ai', { job_id: 'j1', org_id: 'o1' }, fn, { maxAttempts: 3 }),
    ).rejects.toThrow(/non_retryable/);

    expect(fn).toHaveBeenCalledTimes(1);
    // No sleep was called — Date.now() is still 0.
    expect(Date.now()).toBe(0);
  });

  it('a 401 error throws immediately with no time advanced (no sleep)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    captureConsole();

    const err401 = httpError(401, 'Unauthorized');
    const fn = vi.fn(async () => { throw err401; });

    await expect(
      withRetry(env, 'tier_1_ai', {}, fn, { maxAttempts: 3 }),
    ).rejects.toThrow(/non_retryable: client_error/);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Additional edge-case coverage.
  // -------------------------------------------------------------------------
  it('a schema_validation error is non-retryable (fn called once)', async () => {
    captureConsole();
    const fn = vi.fn(async () => {
      throw new Error('schema_validation_failed: invalid json');
    });

    await expect(
      withRetry(env, 'tier_1_ai', {}, fn, { maxAttempts: 3 }),
    ).rejects.toThrow(/non_retryable: schema_validation/);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a network error (ECONNRESET) is retried — succeeds on attempt 2', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    captureConsole();

    const fn = vi.fn(async (attempt: number) => {
      if (attempt < 2) throw new Error('fetch failed: ECONNRESET');
      return 'recovered';
    });

    const promise = withRetry(env, 'tier_1_ai', {}, fn, { maxAttempts: 3 });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a timeout (AbortError) is retried — succeeds on attempt 2', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    captureConsole();

    const timeoutErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fn = vi.fn(async (attempt: number) => {
      if (attempt < 2) throw timeoutErr;
      return 'ok';
    });

    const promise = withRetry(env, 'tier_1_ai', {}, fn, { maxAttempts: 3 });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('default maxAttempts is 3 (from RETRY_CONFIG) when options omitted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    captureConsole();

    const err429 = httpError(429);
    const fn = vi.fn(async () => { throw err429; });

    const promise = withRetry(env, 'tier_1_ai', {}, fn);
    promise.catch(() => {}); // suppress unhandled-rejection (see test 3)
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(promise).rejects.toThrow(/exhausted retries/);
    expect(fn).toHaveBeenCalledTimes(3); // default maxAttempts = 3
  });

  it('the fn receives the attempt number (1-indexed)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    captureConsole();

    const attempts: number[] = [];
    const err429 = httpError(429);
    const fn = vi.fn(async (attempt: number) => {
      attempts.push(attempt);
      if (attempt < 3) throw err429;
      return 'done';
    });

    const promise = withRetry(env, 'tier_1_ai', {}, fn, { maxAttempts: 3 });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await promise;

    expect(attempts).toEqual([1, 2, 3]);
  });
});

// ===========================================================================
// Static assertion — pipeline-hook.ts wires withRetry around the tier-1 call.
// This catches a regression if someone removes the withRetry wrapper.
// ===========================================================================
describe('Phase 5 Step 3 — pipeline-hook wires withRetry around callOpenRouterExtraction', () => {
  it('runTier1AI wraps callOpenRouterExtraction in withRetry', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
      'utf-8',
    );

    // 1. withRetry is imported.
    expect(src).toMatch(/import\s*\{\s*withRetry\s*\}\s*from\s*['"]\.\/retry['"]/);

    // 2. Inside runTier1AI, withRetry wraps callOpenRouterExtraction.
    const runTier1Start = src.indexOf('async function runTier1AI');
    expect(runTier1Start).toBeGreaterThan(-1);
    const body = src.slice(runTier1Start);
    expect(body).toMatch(/withRetry\(/);
    expect(body).toMatch(/callOpenRouterExtraction/);

    // 3. The withRetry call uses 'tier_1_ai' as the step name (so logs are
    //    correlated to tier 1).
    expect(body).toMatch(/['"]tier_1_ai['"]/);

    // 4. The context carries job_id + org_id (Phase 5 structured logging).
    expect(body).toMatch(/job_id:\s*input\.jobId/);
    expect(body).toMatch(/org_id:\s*input\.orgId/);
  });

  it('tiers.ts imports classifyError and uses it to classify HTTP errors', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/consumer/src/tiers.ts'),
      'utf-8',
    );

    expect(src).toMatch(/import\s*\{\s*classifyError\s*\}\s*from\s*['"]\.\/error-classifier['"]/);
    // classifyError is called inside callOpenRouterExtraction's catch block.
    const callStart = src.indexOf('export async function callOpenRouterExtraction');
    expect(callStart).toBeGreaterThan(-1);
    const body = src.slice(callStart);
    expect(body).toMatch(/classifyError\(/);
    // Non-retryable errors throw immediately (don't try other models).
    expect(body).toMatch(/non_retryable/);
  });
});

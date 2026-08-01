// ============================================================================
// 21-circuit-breaker.test.ts — Phase 5 Step 2 (OpenRouter circuit breaker)
// ============================================================================
// Verifies the KV-backed circuit breaker that wraps the tier-1 OpenRouter
// call. When 5 consecutive failures occur in a rolling window, the breaker
// trips: skip calling OpenRouter for 2 minutes and fall directly to the next
// tier. Auto-resets to HALF_OPEN after the cooldown; one trial request is
// allowed through; success → CLOSED, failure → back to OPEN.
//
// WHAT THIS TESTS
//   1. CLOSED state: 4 failures don't trip the breaker.
//   2. 5 consecutive failures trip the breaker (OPEN).
//   3. The 6th call is short-circuited — callOpenRouterExtraction is NEVER called.
//   4. After cooldown (2 min), transitions to HALF_OPEN.
//   5. HALF_OPEN + success → CLOSED (failures reset to 0).
//   6. HALF_OPEN + failure → back to OPEN (cooldown restarts).
//   7. Success resets the failure counter (from any state).
//   8. Static assertion: pipeline-hook checks shouldAttempt BEFORE calling
//      callOpenRouterExtraction (the gate ordering that makes the breaker
//      actually skip network calls).
//
// The KV is mocked with an in-memory Map; time is controlled via
// vi.useFakeTimers() + vi.setSystemTime(). The circuit breaker is a SOFT
// guard (KV is eventually consistent) — these tests verify the LOGIC, not
// the KV consistency model.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getCircuitState,
  recordSuccess,
  recordFailure,
  shouldAttempt,
  checkAllModelsBreaker,
  CONSECUTIVE_FAILURES_THRESHOLD,
  COOLDOWN_MS,
  CIRCUIT_PROVIDER,
  DEFAULT_MODEL_BUCKET,
} from '../../apps/consumer/src/circuit-breaker';
import type { Env } from '../../apps/consumer/src/env';

// ---------------------------------------------------------------------------
// Mock KV — in-memory Map. Matches the task spec's mock shape. The real
// Cloudflare KV is eventually consistent; this mock is strongly consistent,
// which is fine for logic tests (the consistency model is documented in the
// circuit-breaker.ts header + tested separately if needed).
// ---------------------------------------------------------------------------
function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string, _options?: { expirationTtl?: number }) {
      store.set(key, value);
    },
  } as KVNamespace;
}

// ---------------------------------------------------------------------------
// Mock Env — only CIRCUIT_BREAKER_KV is used by the circuit breaker; the
// other fields are stubbed to satisfy the Env interface. Cast through
// `unknown` to avoid having to provide every field.
// ---------------------------------------------------------------------------
function createMockEnv(kv?: KVNamespace): Env {
  return {
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    EXTRACTION_QUEUE: {} as Env['EXTRACTION_QUEUE'],
    CIRCUIT_BREAKER_KV: kv ?? createMockKV(),
  } as unknown as Env;
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('Phase 5 Step 2 — Circuit breaker for OpenRouter', () => {
  let env: Env;
  // Fixed baseline time so Date.now() is deterministic across the test.
  // 2024-01-01T00:00:00Z — well before any cooldown boundary.
  const BASE_TIME = new Date('2024-01-01T00:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    env = createMockEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1: CLOSED state — 4 failures don't trip the breaker.
  // -------------------------------------------------------------------------
  it('CLOSED state: 4 failures do not trip the breaker', async () => {
    for (let i = 0; i < 4; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER);
    }

    const status = await getCircuitState(env, CIRCUIT_PROVIDER);
    expect(status.state).toBe('closed');
    expect(status.failures).toBe(4);
    expect(status.openedAt).toBeNull();

    // shouldAttempt lets the call through.
    const decision = await shouldAttempt(env, CIRCUIT_PROVIDER);
    expect(decision.attempt).toBe(true);
    expect(decision.reason).toBe('closed');
  });

  // -------------------------------------------------------------------------
  // Test 2: 5 consecutive failures trip the breaker.
  // -------------------------------------------------------------------------
  it('5 consecutive failures trip the breaker', async () => {
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER);
    }

    const status = await getCircuitState(env, CIRCUIT_PROVIDER);
    expect(status.state).toBe('open');
    expect(status.failures).toBe(5);
    expect(status.openedAt).not.toBeNull();
    // openedAt is roughly "now" (BASE_TIME — we haven't advanced the clock).
    expect(status.openedAt).toBe(BASE_TIME);

    // shouldAttempt blocks the call.
    const decision = await shouldAttempt(env, CIRCUIT_PROVIDER);
    expect(decision.attempt).toBe(false);
    expect(decision.reason).toBe('open');
  });

  // -------------------------------------------------------------------------
  // Test 3: The 6th call is short-circuited — callOpenRouterExtraction is
  // NEVER called. This simulates the exact tier-1 flow from runTier1AI to
  // verify the breaker actually prevents the network call, not just that
  // shouldAttempt returns false.
  // -------------------------------------------------------------------------
  it('the 6th call is short-circuited without attempting the network call', async () => {
    // Trip the breaker with 5 failures.
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER);
    }

    // Mock callOpenRouterExtraction — this is what the tier-1 caller would
    // invoke. We assert it's NEVER called.
    const mockCallOpenRouter = vi.fn().mockResolvedValue(null);

    // Simulate the exact gate flow from runTier1AI:
    //   1. Check shouldAttempt.
    //   2. If attempt === false → return early (don't call OpenRouter).
    //   3. If attempt === true  → call OpenRouter, then recordSuccess/Failure.
    const { attempt, reason } = await shouldAttempt(env, CIRCUIT_PROVIDER);
    expect(attempt).toBe(false);
    expect(reason).toBe('open');

    if (attempt) {
      const result = await mockCallOpenRouter();
      if (result) {
        await recordSuccess(env, CIRCUIT_PROVIDER);
      } else {
        await recordFailure(env, CIRCUIT_PROVIDER);
      }
    }

    // The network call was NEVER made — the breaker short-circuited it.
    expect(mockCallOpenRouter).not.toHaveBeenCalled();

    // Sanity: the breaker is still OPEN (no trial went through).
    const status = await getCircuitState(env, CIRCUIT_PROVIDER);
    expect(status.state).toBe('open');
    expect(status.failures).toBe(5); // unchanged — no 6th failure recorded
  });

  // -------------------------------------------------------------------------
  // Test 4: After cooldown (2 min), transitions to HALF_OPEN.
  // -------------------------------------------------------------------------
  it('after cooldown (2 min), transitions to HALF_OPEN', async () => {
    // Trip the breaker.
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER);
    }
    expect((await getCircuitState(env, CIRCUIT_PROVIDER)).state).toBe('open');

    // Advance time PAST the cooldown (COOLDOWN_MS + 1s margin).
    vi.setSystemTime(BASE_TIME + COOLDOWN_MS + 1000);

    // getCircuitState triggers the OPEN → HALF_OPEN transition.
    const status = await getCircuitState(env, CIRCUIT_PROVIDER);
    expect(status.state).toBe('half_open');
    // Failures count is preserved (the trial hasn't resolved yet).
    expect(status.failures).toBe(5);

    // shouldAttempt lets ONE trial request through.
    const decision = await shouldAttempt(env, CIRCUIT_PROVIDER);
    expect(decision.attempt).toBe(true);
    expect(decision.reason).toBe('half_open_trial');
  });

  // -------------------------------------------------------------------------
  // Test 5: HALF_OPEN + success → CLOSED.
  // -------------------------------------------------------------------------
  it('HALF_OPEN + success → CLOSED', async () => {
    // Trip the breaker.
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER);
    }

    // Advance past cooldown → HALF_OPEN.
    vi.setSystemTime(BASE_TIME + COOLDOWN_MS + 1000);
    await getCircuitState(env, CIRCUIT_PROVIDER); // triggers transition
    expect((await getCircuitState(env, CIRCUIT_PROVIDER)).state).toBe('half_open');

    // The trial request SUCCEEDS → recordSuccess.
    await recordSuccess(env, CIRCUIT_PROVIDER);

    const status = await getCircuitState(env, CIRCUIT_PROVIDER);
    expect(status.state).toBe('closed');
    expect(status.failures).toBe(0);

    // Subsequent calls go through normally.
    const decision = await shouldAttempt(env, CIRCUIT_PROVIDER);
    expect(decision.attempt).toBe(true);
    expect(decision.reason).toBe('closed');
  });

  // -------------------------------------------------------------------------
  // Test 6: HALF_OPEN + failure → back to OPEN (cooldown restarts).
  // -------------------------------------------------------------------------
  it('HALF_OPEN + failure → back to OPEN (cooldown restarts)', async () => {
    // Trip the breaker.
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER);
    }
    const firstOpenedAt = (await getCircuitState(env, CIRCUIT_PROVIDER)).openedAt;
    expect(firstOpenedAt).toBe(BASE_TIME);

    // Advance past cooldown → HALF_OPEN.
    vi.setSystemTime(BASE_TIME + COOLDOWN_MS + 1000);
    await getCircuitState(env, CIRCUIT_PROVIDER); // triggers transition
    expect((await getCircuitState(env, CIRCUIT_PROVIDER)).state).toBe('half_open');

    // The trial request FAILS — a little time passes first so the new
    // openedAt is measurably later than the first.
    vi.setSystemTime(BASE_TIME + COOLDOWN_MS + 6000);
    await recordFailure(env, CIRCUIT_PROVIDER);

    const status = await getCircuitState(env, CIRCUIT_PROVIDER);
    expect(status.state).toBe('open');
    // Cooldown restarted: openedAt is the NEW failure time, not the original.
    expect(status.openedAt).not.toBe(firstOpenedAt);
    expect(status.openedAt).toBeGreaterThan(firstOpenedAt!);
    expect(status.openedAt).toBe(BASE_TIME + COOLDOWN_MS + 6000);

    // shouldAttempt blocks again.
    const decision = await shouldAttempt(env, CIRCUIT_PROVIDER);
    expect(decision.attempt).toBe(false);
    expect(decision.reason).toBe('open');
  });

  // -------------------------------------------------------------------------
  // Test 7: Success resets the failure counter.
  // -------------------------------------------------------------------------
  it('success resets the failure counter', async () => {
    // 3 failures (under threshold — breaker stays closed).
    for (let i = 0; i < 3; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER);
    }
    expect((await getCircuitState(env, CIRCUIT_PROVIDER)).failures).toBe(3);

    // A success resets the counter to 0.
    await recordSuccess(env, CIRCUIT_PROVIDER);

    const status = await getCircuitState(env, CIRCUIT_PROVIDER);
    expect(status.failures).toBe(0);
    expect(status.state).toBe('closed');

    // Now 4 more failures don't trip (because the counter was reset, not
    // cumulative from the original 3). This confirms the reset actually
    // zeroed the counter, not just masked it.
    for (let i = 0; i < 4; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER);
    }
    const after4More = await getCircuitState(env, CIRCUIT_PROVIDER);
    expect(after4More.state).toBe('closed');
    expect(after4More.failures).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Test 8: Static assertion — pipeline-hook checks checkAllModelsBreaker
  // BEFORE calling callOpenRouterExtraction (per-model granularity).
  //
  // The previous design had shouldAttempt at the runTier1AI level gating the
  // whole tier. The per-(provider+model) refactor (Phase 5 reality-check fix
  // p5-rc-2) MOVED the per-model shouldAttempt gate INTO callOpenRouterExtraction
  // (tiers.ts) so the model-fallback loop can skip a tripped model and try the
  // next one. runTier1AI now does ONE pre-check (checkAllModelsBreaker) that
  // short-circuits the whole tier only when EVERY model's breaker is open.
  // -------------------------------------------------------------------------
  it('static assertion: pipeline-hook checks checkAllModelsBreaker before calling OpenRouter', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
      'utf-8',
    );

    // 1. Both must be present.
    expect(src).toMatch(/checkAllModelsBreaker/);
    expect(src).toMatch(/callOpenRouterExtraction/);

    // 2. Inside runTier1AI specifically, the checkAllModelsBreaker CALL must
    //    appear BEFORE the callOpenRouterExtraction CALL. (Both names appear
    //    in COMMENTS in this function's body — the comment block above the
    //    pre-check mentions callOpenRouterExtraction to explain why we
    //    pre-check. Searching for the bare names would match the comment
    //    first and report a wrong order. We match the actual CALL EXPRESSIONS
    //    instead: `checkAllModelsBreaker(env,` and `callOpenRouterExtraction(env,`.)
    const runTier1Start = src.indexOf('async function runTier1AI');
    expect(runTier1Start).toBeGreaterThan(-1);

    const body = src.slice(runTier1Start);
    const checkAllIdx = body.indexOf('checkAllModelsBreaker(env,');
    const callOpenRouterIdx = body.indexOf('callOpenRouterExtraction(env,');
    expect(checkAllIdx).toBeGreaterThan(-1);
    expect(callOpenRouterIdx).toBeGreaterThan(-1);
    expect(checkAllIdx).toBeLessThan(callOpenRouterIdx);

    // 3. The all_models_circuit_open error code is returned when every model's
    //    breaker is open. (The old per-provider code used 'circuit_open'; the
    //    per-model refactor replaces it with 'all_models_circuit_open' to make
    //    clear that the trip is model-aggregate, not provider-global.)
    expect(src).toMatch(/errorCode:\s*['"]all_models_circuit_open['"]/);
    expect(src).toMatch(/All OpenRouter models have circuit breakers open/);

    // 4. The runTier1AI level does NOT call recordSuccess / recordFailure —
    //    those moved to callOpenRouterExtraction (tiers.ts) so they fire
    //    PER MODEL. Asserting the absence of the per-provider call shape here
    //    catches a regression where someone re-adds the old aggregate call.
    //    (The strings appear in COMMENTS explaining the move — that's fine.
    //    The regex with `env, CIRCUIT_PROVIDER)` would match an actual call
    //    site like `recordFailure(env, CIRCUIT_PROVIDER)` or
    //    `recordFailure(env, CIRCUIT_PROVIDER, model)`. We want to assert
    //    there is NO bare 2-arg call at the runTier1AI level.)
    const runTier1Body = src.slice(runTier1Start, src.indexOf('async function runTier2PdfText'));
    // No bare `recordSuccess(env, CIRCUIT_PROVIDER)` (2-arg form) — only the
    // 3-arg per-model form is allowed, and it lives in tiers.ts, not here.
    expect(runTier1Body).not.toMatch(/recordSuccess\(env,\s*CIRCUIT_PROVIDER\s*\)/);
    expect(runTier1Body).not.toMatch(/recordFailure\(env,\s*CIRCUIT_PROVIDER\s*\)/);
    // And no shouldAttempt call at the runTier1AI level — the gate moved
    // into callOpenRouterExtraction. (shouldAttempt may appear in COMMENTS
    // inside runTier1AI's body explaining the design — that's fine; we only
    // assert no actual call site, i.e. no `shouldAttempt(env,` invocation.)
    expect(runTier1Body).not.toMatch(/shouldAttempt\(env,/);

    // 5. The logWarn call includes the required Phase 5 structured fields.
    //    The first arg is the logger env (cast from Env to LoggerEnv, matching
    //    the retry.ts pattern), so we match any identifier before the message.
    expect(src).toMatch(/logWarn\(\s*\w+,\s*['"]circuit breaker open — skipping tier 1/);
    expect(src).toMatch(/step:\s*['"]circuit_breaker['"]/);
  });

  // -------------------------------------------------------------------------
  // Test 8b: Static assertion — tiers.ts (callOpenRouterExtraction) does the
  // per-model shouldAttempt gate + recordSuccess / recordFailure per model.
  // This catches a regression where someone removes the per-model gate from
  // the model-fallback loop.
  // -------------------------------------------------------------------------
  it('static assertion: tiers.ts gates each model via shouldAttempt + records per model', () => {
    const src = readFileSync(
      resolve(__dirname, '../../apps/consumer/src/tiers.ts'),
      'utf-8',
    );

    // 1. Imports the per-model breaker functions.
    expect(src).toMatch(/import\s*\{[^}]*shouldAttempt[^}]*\}\s*from\s*['"]\.\/circuit-breaker['"]/);
    expect(src).toMatch(/recordSuccess/);
    expect(src).toMatch(/recordFailure/);
    expect(src).toMatch(/CIRCUIT_PROVIDER/);

    // 2. Inside callOpenRouterExtraction's model loop, shouldAttempt is
    //    called per model (with the model arg).
    const callStart = src.indexOf('export async function callOpenRouterExtraction');
    expect(callStart).toBeGreaterThan(-1);
    const body = src.slice(callStart);
    expect(body).toMatch(/shouldAttempt\(env,\s*CIRCUIT_PROVIDER,\s*model\)/);
    expect(body).toMatch(/recordSuccess\(env,\s*CIRCUIT_PROVIDER,\s*model\)/);
    expect(body).toMatch(/recordFailure\(env,\s*CIRCUIT_PROVIDER,\s*model\)/);
  });
});

// ===========================================================================
// Sanity check: the constants match the task spec.
// ===========================================================================
describe('circuit breaker constants', () => {
  it('CONSECUTIVE_FAILURES_THRESHOLD is 5', () => {
    expect(CONSECUTIVE_FAILURES_THRESHOLD).toBe(5);
  });

  it('COOLDOWN_MS is 2 minutes (120000ms)', () => {
    expect(COOLDOWN_MS).toBe(120_000);
    expect(COOLDOWN_MS).toBe(2 * 60 * 1000);
  });

  it('CIRCUIT_PROVIDER is "openrouter"', () => {
    expect(CIRCUIT_PROVIDER).toBe('openrouter');
  });

  it('DEFAULT_MODEL_BUCKET is "default" (backward-compat bucket name)', () => {
    expect(DEFAULT_MODEL_BUCKET).toBe('default');
  });
});

// ===========================================================================
// Per-(provider+model) granularity — Phase 5 reality-check fix p5-rc-2
// ===========================================================================
// The original per-provider breaker keyed `cb:openrouter:state` tripped on
// ANY 5 failures and blackholed the whole tier — including the 72B and 8B
// fallback models that might be healthy. The per-model refactor keys
// `cb:openrouter:{model}:state` so a 32B outage localizes to the 32B model.
//
// These tests verify the per-model independence: tripping model A doesn't
// affect model B, and checkAllModelsBreaker correctly reports which models
// are open + whether any are still available.
// ===========================================================================

describe('Phase 5 reality-check fix p5-rc-2 — Per-(provider+model) circuit breaker', () => {
  let env: Env;
  const BASE_TIME = new Date('2024-01-01T00:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    env = createMockEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test P1: Model A's breaker trips but model B's stays closed.
  // -------------------------------------------------------------------------
  it('tripping model A does not trip model B (per-model independence)', async () => {
    const modelA = 'qwen/qwen3-vl-32b-instruct';
    const modelB = 'qwen/qwen2.5-vl-72b-instruct';

    // 5 failures on model A → trips A's breaker.
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER, modelA);
    }

    // Model A's breaker is OPEN.
    const decisionA = await shouldAttempt(env, CIRCUIT_PROVIDER, modelA);
    expect(decisionA.attempt).toBe(false);
    expect(decisionA.reason).toBe('open');

    // Model B's breaker is still CLOSED — never touched.
    const decisionB = await shouldAttempt(env, CIRCUIT_PROVIDER, modelB);
    expect(decisionB.attempt).toBe(true);
    expect(decisionB.reason).toBe('closed');

    // Direct state inspection confirms the KV keys are independent.
    const statusA = await getCircuitState(env, CIRCUIT_PROVIDER, modelA);
    const statusB = await getCircuitState(env, CIRCUIT_PROVIDER, modelB);
    expect(statusA.state).toBe('open');
    expect(statusA.failures).toBe(5);
    expect(statusB.state).toBe('closed');
    expect(statusB.failures).toBe(0);
    expect(statusB.openedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test P2: checkAllModelsBreaker with 3 models, 2 open → anyAvailable=true.
  // -------------------------------------------------------------------------
  it('checkAllModelsBreaker: 2 of 3 models open → anyAvailable=true, openModels=[A,B]', async () => {
    const modelA = 'modelA';
    const modelB = 'modelB';
    const modelC = 'modelC';

    // Trip A and B (5 failures each). Leave C closed.
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER, modelA);
      await recordFailure(env, CIRCUIT_PROVIDER, modelB);
    }

    const result = await checkAllModelsBreaker(env, CIRCUIT_PROVIDER, [modelA, modelB, modelC]);
    expect(result.anyAvailable).toBe(true);
    expect(result.openModels).toHaveLength(2);
    expect(result.openModels).toContain(modelA);
    expect(result.openModels).toContain(modelB);
    expect(result.openModels).not.toContain(modelC);
  });

  // -------------------------------------------------------------------------
  // Test P3: All 3 models open → anyAvailable=false.
  // -------------------------------------------------------------------------
  it('checkAllModelsBreaker: all 3 models open → anyAvailable=false, openModels=[A,B,C]', async () => {
    const modelA = 'modelA';
    const modelB = 'modelB';
    const modelC = 'modelC';

    // Trip all three.
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER, modelA);
      await recordFailure(env, CIRCUIT_PROVIDER, modelB);
      await recordFailure(env, CIRCUIT_PROVIDER, modelC);
    }

    const result = await checkAllModelsBreaker(env, CIRCUIT_PROVIDER, [modelA, modelB, modelC]);
    expect(result.anyAvailable).toBe(false);
    expect(result.openModels).toHaveLength(3);
    expect(result.openModels).toEqual(expect.arrayContaining([modelA, modelB, modelC]));
  });

  // -------------------------------------------------------------------------
  // Test P4: recordSuccess on model A doesn't reset model B's breaker.
  // -------------------------------------------------------------------------
  it('recordSuccess on model A does not reset model B', async () => {
    const modelA = 'modelA';
    const modelB = 'modelB';

    // 3 failures on each (under threshold, both closed).
    for (let i = 0; i < 3; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER, modelA);
      await recordFailure(env, CIRCUIT_PROVIDER, modelB);
    }
    expect((await getCircuitState(env, CIRCUIT_PROVIDER, modelA)).failures).toBe(3);
    expect((await getCircuitState(env, CIRCUIT_PROVIDER, modelB)).failures).toBe(3);

    // recordSuccess on A only.
    await recordSuccess(env, CIRCUIT_PROVIDER, modelA);

    // A's counter reset to 0.
    const statusA = await getCircuitState(env, CIRCUIT_PROVIDER, modelA);
    expect(statusA.failures).toBe(0);
    expect(statusA.state).toBe('closed');

    // B's counter UNCHANGED — recordSuccess on A didn't touch B.
    const statusB = await getCircuitState(env, CIRCUIT_PROVIDER, modelB);
    expect(statusB.failures).toBe(3);
    expect(statusB.state).toBe('closed');
  });

  // -------------------------------------------------------------------------
  // Test P5: HALF_OPEN transition is per-model — model A goes HALF_OPEN
  // after cooldown while model B (also tripped) stays OPEN until its own
  // cooldown elapses.
  // -------------------------------------------------------------------------
  it('HALF_OPEN transition is per-model (independent cooldowns)', async () => {
    const modelA = 'modelA';
    const modelB = 'modelB';

    // Trip A at BASE_TIME.
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER, modelA);
    }
    // Trip B 30s later (so B's cooldown elapses 30s after A's).
    vi.setSystemTime(BASE_TIME + 30_000);
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER, modelB);
    }
    expect((await getCircuitState(env, CIRCUIT_PROVIDER, modelA)).state).toBe('open');
    expect((await getCircuitState(env, CIRCUIT_PROVIDER, modelB)).state).toBe('open');

    // Advance to BASE + COOLDOWN + 1s. A's cooldown (opened at BASE) has
    // elapsed → A transitions to HALF_OPEN. B's cooldown (opened at
    // BASE+30s) has NOT yet elapsed (only 1s past A's cooldown = 29s before
    // B's) → B stays OPEN.
    vi.setSystemTime(BASE_TIME + COOLDOWN_MS + 1000);

    const statusA = await getCircuitState(env, CIRCUIT_PROVIDER, modelA);
    const statusB = await getCircuitState(env, CIRCUIT_PROVIDER, modelB);
    expect(statusA.state).toBe('half_open');
    expect(statusB.state).toBe('open');

    // shouldAttempt agrees: A allows a trial, B blocks.
    const decisionA = await shouldAttempt(env, CIRCUIT_PROVIDER, modelA);
    const decisionB = await shouldAttempt(env, CIRCUIT_PROVIDER, modelB);
    expect(decisionA.attempt).toBe(true);
    expect(decisionA.reason).toBe('half_open_trial');
    expect(decisionB.attempt).toBe(false);
    expect(decisionB.reason).toBe('open');
  });

  // -------------------------------------------------------------------------
  // Test P6: Backward compat — omitting `model` uses the 'default' bucket
  // and is fully isolated from per-model buckets.
  // -------------------------------------------------------------------------
  it('omitting model uses "default" bucket, isolated from per-model buckets', async () => {
    const modelA = 'modelA';

    // Trip the 'default' bucket (no model arg).
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER); // model defaults to 'default'
    }
    expect((await getCircuitState(env, CIRCUIT_PROVIDER)).state).toBe('open');

    // modelA's bucket is untouched.
    const statusA = await getCircuitState(env, CIRCUIT_PROVIDER, modelA);
    expect(statusA.state).toBe('closed');
    expect(statusA.failures).toBe(0);

    // shouldAttempt without model checks the 'default' bucket (open).
    const decisionDefault = await shouldAttempt(env, CIRCUIT_PROVIDER);
    expect(decisionDefault.attempt).toBe(false);
    expect(decisionDefault.reason).toBe('open');

    // shouldAttempt with modelA checks modelA's bucket (closed).
    const decisionA = await shouldAttempt(env, CIRCUIT_PROVIDER, modelA);
    expect(decisionA.attempt).toBe(true);
    expect(decisionA.reason).toBe('closed');
  });

  // -------------------------------------------------------------------------
  // Test P7: checkAllModelsBreaker with an empty models array returns
  // anyAvailable=false, openModels=[] — degenerate but well-defined.
  // -------------------------------------------------------------------------
  it('checkAllModelsBreaker: empty models array → anyAvailable=false, openModels=[]', async () => {
    const result = await checkAllModelsBreaker(env, CIRCUIT_PROVIDER, []);
    // No models means nothing is available — the tier should short-circuit.
    // (This case shouldn't happen in practice — OPENROUTER_MODELS is
    // non-empty — but the function should handle it without throwing.)
    expect(result.anyAvailable).toBe(false);
    expect(result.openModels).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test P8: checkAllModelsBreaker with all CLOSED models → anyAvailable=true,
  // openModels=[] (the happy path — tier-1 call proceeds normally).
  // -------------------------------------------------------------------------
  it('checkAllModelsBreaker: all models closed → anyAvailable=true, openModels=[]', async () => {
    const result = await checkAllModelsBreaker(env, CIRCUIT_PROVIDER, [
      'qwen/qwen3-vl-32b-instruct',
      'qwen/qwen2.5-vl-72b-instruct',
      'qwen/qwen3-vl-8b-instruct',
    ]);
    expect(result.anyAvailable).toBe(true);
    expect(result.openModels).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test P9: HALF_OPEN models count as available (anyAvailable=true) — a
  // trial request is allowed, so the tier-1 call should proceed.
  // -------------------------------------------------------------------------
  it('checkAllModelsBreaker: HALF_OPEN model counts as available', async () => {
    const modelA = 'modelA';
    const modelB = 'modelB';

    // Trip both, then advance past cooldown so both transition to HALF_OPEN.
    for (let i = 0; i < 5; i++) {
      await recordFailure(env, CIRCUIT_PROVIDER, modelA);
      await recordFailure(env, CIRCUIT_PROVIDER, modelB);
    }
    vi.setSystemTime(BASE_TIME + COOLDOWN_MS + 1000);

    const result = await checkAllModelsBreaker(env, CIRCUIT_PROVIDER, [modelA, modelB]);
    expect(result.anyAvailable).toBe(true);
    expect(result.openModels).toEqual([]);
  });
});

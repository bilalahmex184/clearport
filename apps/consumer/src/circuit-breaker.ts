// ============================================================================
// circuit-breaker.ts — Circuit breaker for OpenRouter (Tier 1) [Phase 5 Step 2]
// ============================================================================
// WHAT THIS IS
//   A KV-backed circuit breaker that wraps the OpenRouter (tier-1) call. When
//   an OpenRouter MODEL has an outage, the per-model breaker trips after
//   CONSECUTIVE_FAILURES_THRESHOLD (5) consecutive failures, and short-circuits
//   subsequent calls TO THAT MODEL for COOLDOWN_MS (2 minutes) — the tier-1
//   flow falls through to the NEXT model in OPENROUTER_MODELS instead of
//   blackholing the whole provider. Only if EVERY model's breaker is open does
//   the tier fail (errorCode: 'all_models_circuit_open').
//
// WHY PER-MODEL (not per-provider)
//   OpenRouter serves multiple Qwen VL models (32B primary, 72B fallback, 8B
//   last-resort). A 32B outage shouldn't take down 72B + 8B — the model-
//   fallback loop should be allowed to reach them. The previous per-provider
//   key (`cb:openrouter:state`) tripped on ANY 5 failures and blackholed the
//   entire tier, defeating the model-fallback design. Per-model keys
//   (`cb:openrouter:{model}:state`) localize the trip to the failing model.
//
// STATES (per model)
//   - CLOSED:     normal operation. Calls go through. Failures increment the
//                 counter; success resets it.
//   - OPEN:       tripped. Calls to THIS model are short-circuited (skip to
//                 the next model in OPENROUTER_MODELS). After COOLDOWN_MS,
//                 transitions to HALF_OPEN.
//   - HALF_OPEN:  one trial request is allowed through. On success → CLOSED.
//                 On failure → back to OPEN (cooldown restarts).
//
// KV KEYS (per provider + model)
//   cb:{provider}:{model}:state      → "closed" | "open" | "half_open"
//   cb:{provider}:{model}:failures   → count of consecutive failures (integer string)
//   cb:{provider}:{model}:opened_at  → epoch-ms when the breaker opened (for cooldown)
//
// BACKWARD COMPATIBILITY
//   The `model` parameter is optional on every public function. Omitting it
//   uses the literal bucket name 'default' — so existing callers that don't
//   know about per-model granularity (and the existing tests) keep working
//   unchanged against a single 'default' bucket. The per-model granularity
//   only kicks in when callOpenRouterExtraction passes the actual model id.
//
// CONSISTENCY
//   Cloudflare KV is eventually consistent, so the breaker is a SOFT guard —
//   under a severe outage, a few extra requests may slip through before all
//   consumer instances see the OPEN state. That's acceptable: the next tier
//   (PDF text / Tesseract) is the real fallback; the breaker just avoids
//   wasting the 18s tier-1 latency budget on a model that's down. The
//   failure counter is read-modify-write (no CAS); under concurrent failures
//   from multiple consumers the count may undercount slightly, which biases
//   toward staying CLOSED — the safe direction (we'd rather attempt one extra
//   call than trip prematurely).
// ============================================================================

import type { Env } from './env';

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Number of consecutive failures within a rolling window that trips the breaker. */
export const CONSECUTIVE_FAILURES_THRESHOLD = 5;

/** How long the breaker stays OPEN before transitioning to HALF_OPEN. */
export const COOLDOWN_MS = 120_000; // 2 minutes

/** The provider this breaker guards (tier 1 = OpenRouter). */
export const CIRCUIT_PROVIDER = 'openrouter';

/**
 * The model bucket name used when `model` is omitted. Picked to be an
 * unlikely-to-collide literal so a real model id (e.g.
 * 'qwen/qwen3-vl-32b-instruct') never accidentally maps to the same bucket
 * as a backward-compat caller.
 */
export const DEFAULT_MODEL_BUCKET = 'default';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitStatus {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
}

/**
 * Result of checking the breaker for a list of models at once. Returned by
 * `checkAllModelsBreaker` and used by runTier1AI to short-circuit the whole
 * tier when every model is open (errorCode: 'all_models_circuit_open').
 */
export interface AllModelsBreakerResult {
  /** True if at least one model's breaker is CLOSED or HALF_OPEN (worth trying). */
  anyAvailable: boolean;
  /** The models whose breakers are currently OPEN (worth skipping). */
  openModels: string[];
}

// ---------------------------------------------------------------------------
// KV key helpers — namespaced per provider AND per model so a 32B outage
// doesn't share state with 72B/8B. Future breakers (e.g. for Cloud Vision)
// can coexist in the same KV namespace without key collisions.
// ---------------------------------------------------------------------------

function stateKey(provider: string, model: string): string {
  return `cb:${provider}:${model}:state`;
}
function failuresKey(provider: string, model: string): string {
  return `cb:${provider}:${model}:failures`;
}
function openedAtKey(provider: string, model: string): string {
  return `cb:${provider}:${model}:opened_at`;
}

// ---------------------------------------------------------------------------
// getCircuitState — reads the 3 KV keys for (provider, model) and returns the
// current status. If state === 'open' and the cooldown has elapsed,
// transitions to 'half_open' (writes back to KV) and returns
// { state: 'half_open', ... }.
//
// This is the ONLY place OPEN → HALF_OPEN transitions happen. Callers that
// need a consistent view (shouldAttempt, recordFailure) go through here.
//
// `model` defaults to DEFAULT_MODEL_BUCKET ('default') for backward
// compatibility with pre-per-model callers.
// ---------------------------------------------------------------------------
export async function getCircuitState(
  env: Env,
  provider: string,
  model: string = DEFAULT_MODEL_BUCKET,
): Promise<CircuitStatus> {
  const kv = env.CIRCUIT_BREAKER_KV;
  const [stateRaw, failuresRaw, openedAtRaw] = await Promise.all([
    kv.get(stateKey(provider, model)),
    kv.get(failuresKey(provider, model)),
    kv.get(openedAtKey(provider, model)),
  ]);

  const state: CircuitState = (stateRaw as CircuitState) || 'closed';
  const failures = failuresRaw ? (parseInt(failuresRaw, 10) || 0) : 0;
  const openedAt = openedAtRaw ? (parseInt(openedAtRaw, 10) || null) : null;

  // Cooldown elapsed? Transition OPEN → HALF_OPEN. The write-back is
  // best-effort — if KV is slow, this call still returns half_open so the
  // tier-1 caller lets a trial request through. Other consumer instances
  // will see the half_open state once KV propagates.
  if (state === 'open' && openedAt !== null && Date.now() - openedAt > COOLDOWN_MS) {
    await kv.put(stateKey(provider, model), 'half_open');
    return { state: 'half_open', failures, openedAt };
  }

  return { state, failures, openedAt };
}

// ---------------------------------------------------------------------------
// recordSuccess — resets failures to 0 and state to 'closed' for the given
// (provider, model). Called when a tier-1 call to THAT model succeeds
// (OpenRouter returned a non-null response from this model). This is the
// ONLY path from HALF_OPEN → CLOSED: a successful trial request resets
// the breaker to normal operation.
//
// We don't clear openedAt — it's never read when state !== 'open', so a stale
// timestamp is harmless. Avoiding the extra write keeps this to 2 KV puts
// instead of 3 (KV writes are billed).
//
// `model` defaults to DEFAULT_MODEL_BUCKET for backward compatibility.
// ---------------------------------------------------------------------------
export async function recordSuccess(
  env: Env,
  provider: string,
  model: string = DEFAULT_MODEL_BUCKET,
): Promise<void> {
  const kv = env.CIRCUIT_BREAKER_KV;
  await Promise.all([
    kv.put(stateKey(provider, model), 'closed'),
    kv.put(failuresKey(provider, model), '0'),
  ]);
}

// ---------------------------------------------------------------------------
// recordFailure — increments the failure counter for (provider, model). If
// the counter reaches the threshold, trips the breaker (state → 'open',
// openedAt → now) FOR THAT MODEL ONLY — other models' breakers are untouched.
//
// This function handles BOTH trip paths:
//   - CLOSED → OPEN:    5 consecutive failures from a closed state.
//   - HALF_OPEN → OPEN: a trial request fails. In this case failures is
//     already >= threshold (we got to OPEN by reaching the threshold), so
//     the >= check re-trips with a fresh openedAt — cooldown restarts.
//
// Under threshold, only the counter is updated; state stays as-is (closed or
// half_open). This means a HALF_OPEN trial that succeeds resets via
// recordSuccess, while one that fails re-trips via the >= branch here.
//
// `model` defaults to DEFAULT_MODEL_BUCKET for backward compatibility.
// ---------------------------------------------------------------------------
export async function recordFailure(
  env: Env,
  provider: string,
  model: string = DEFAULT_MODEL_BUCKET,
): Promise<void> {
  const kv = env.CIRCUIT_BREAKER_KV;
  const current = await getCircuitState(env, provider, model);
  const newFailures = current.failures + 1;

  if (newFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
    const now = Date.now();
    await Promise.all([
      kv.put(stateKey(provider, model), 'open'),
      kv.put(failuresKey(provider, model), String(newFailures)),
      kv.put(openedAtKey(provider, model), String(now)),
    ]);
  } else {
    // Still under threshold — just bump the counter. State stays as-is.
    await kv.put(failuresKey(provider, model), String(newFailures));
  }
}

// ---------------------------------------------------------------------------
// shouldAttempt — the gate the tier-1 caller checks BEFORE calling a specific
// OpenRouter model. Returns:
//   - { attempt: true,  reason: 'closed' }          — normal operation, call through
//   - { attempt: true,  reason: 'half_open_trial' } — one trial request allowed
//   - { attempt: false, reason: 'open' }            — breaker tripped, skip THIS model
//
// `reason` is included in the log + ledger so operators can see WHY a model
// was skipped or marked as a trial.
//
// `model` defaults to DEFAULT_MODEL_BUCKET for backward compatibility.
// ---------------------------------------------------------------------------
export async function shouldAttempt(
  env: Env,
  provider: string,
  model: string = DEFAULT_MODEL_BUCKET,
): Promise<{ attempt: boolean; reason: string }> {
  const status = await getCircuitState(env, provider, model);
  if (status.state === 'open') {
    return { attempt: false, reason: 'open' };
  }
  if (status.state === 'half_open') {
    return { attempt: true, reason: 'half_open_trial' };
  }
  return { attempt: true, reason: 'closed' };
}

// ---------------------------------------------------------------------------
// checkAllModelsBreaker — checks the breaker for every model in `models` and
// returns whether any are still available (CLOSED or HALF_OPEN) plus the
// list of models whose breakers are OPEN.
//
// Used by runTier1AI to short-circuit the whole tier-1 call when EVERY model
// is breaker-open (errorCode: 'all_models_circuit_open'). Without this
// pre-check, callOpenRouterExtraction would loop through all models, calling
// shouldAttempt on each only to skip — wasteful (5 KV reads per skipped
// model) and noisy in the logs. The pre-check collapses that to "log once,
// return tier-failure".
//
// NOTE: the result is a SNAPSHOT. Between this call and callOpenRouterExtraction,
// a model's breaker could trip (rare — requires 5 concurrent failures in the
// ~1ms window). If that happens, callOpenRouterExtraction's per-model
// shouldAttempt check still does the right thing (skip the now-tripped model).
// The pre-check is an optimization, not a guarantee — the per-model gate
// inside callOpenRouterExtraction is the source of truth.
// ---------------------------------------------------------------------------
export async function checkAllModelsBreaker(
  env: Env,
  provider: string,
  models: string[],
): Promise<AllModelsBreakerResult> {
  const openModels: string[] = [];
  // Check models in parallel — shouldAttempt is independent per model, and
  // parallel KV reads are ~1 round-trip instead of N.
  const decisions = await Promise.all(
    models.map((model) => shouldAttempt(env, provider, model).then((d) => ({ model, ...d }))),
  );
  for (const d of decisions) {
    if (!d.attempt) {
      openModels.push(d.model);
    }
  }
  return {
    anyAvailable: openModels.length < models.length,
    openModels,
  };
}

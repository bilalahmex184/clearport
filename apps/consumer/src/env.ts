// ============================================================================
// env.ts — Typed Cloudflare Worker bindings for the consumer Worker
// ============================================================================
// SECURITY: SUPABASE_SERVICE_ROLE_KEY bypasses RLS. It is loaded from a
// Workers secret (set via `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`)
// and is NEVER logged, NEVER returned in responses, NEVER shipped to client
// builds. Server-side only — this code runs in the Worker runtime, not in
// the browser.
//
// The consumer reads from the `extraction-jobs` queue (the ingress Worker
// writes to it). The EXTRACTION_QUEUE binding is declared here for type
// completeness; the consumer does not enqueue to it, but having the type
// lets us reuse the Env interface in tests and any future producer path.
// ============================================================================

// ---------------------------------------------------------------------------
// KVNamespace shim — provides the type in environments where
// @cloudflare/workers-types isn't loaded (e.g. vitest tests run from the
// monorepo root, which uses a different tsconfig than the consumer). When
// workers-types IS loaded (consumer build via `types` in tsconfig.json),
// this declaration MERGES with the ambient global via TS interface
// declaration merging (same name + same type parameters → overloads merge,
// no conflict). The minimal { get, put } surface here is all the circuit
// breaker uses; workers-types' richer overloads remain available in prod.
// ---------------------------------------------------------------------------
declare global {
  interface KVNamespace<Key extends string = string> {
    get(key: Key | string): Promise<string | null>;
    put(
      key: Key | string,
      value: string,
      options?: { expirationTtl?: number; expiration?: number },
    ): Promise<void>;
  }
}

export interface Env {
  /** Supabase project URL, e.g. https://[ref].supabase.co. Set in [vars]. */
  SUPABASE_URL: string;

  /**
   * Supabase anon key. RLS-protected, safe to expose in clients. Used here
   * only for the queue-consumer integration test which authenticates as a
   * real user. The Worker itself uses the service-role key for all RPCs
   * (claim_job, complete_job, record_job_attempt, reclaim_stuck_jobs_v2).
   */
  SUPABASE_ANON_KEY: string;

  /**
   * Supabase service-role key. Bypasses RLS. Workers secret — never logged.
   * All RPCs from this Worker use this key because job state mutations
   * (jobs.status, job_attempts rows) are service-role-only per 002_async_jobs.sql
   * §3 (no client UPDATE/DELETE policy on `jobs`).
   */
  SUPABASE_SERVICE_ROLE_KEY: string;

  /**
   * Queue binding for `extraction-jobs`. The consumer READS from this queue
   * (configured via [[queues.consumers]] in wrangler.toml). The ingress
   * Worker writes to it. Declared here for type symmetry with the ingress
   * Worker's Env; the consumer does not call .send() on it.
   */
  EXTRACTION_QUEUE: Queue<{ job_id: string }>;

  /**
   * KV namespace for the OpenRouter circuit breaker (Phase 5 Step 2). Stores
   * the breaker state (closed/open/half_open), consecutive failure count, and
   * the timestamp the breaker opened — keyed `cb:{provider}:{state|failures|opened_at}`.
   *
   * KV is eventually consistent, so the breaker is a SOFT guard: under a
   * severe outage a few extra requests may slip through before all consumer
   * instances see the OPEN state. That's acceptable — the next tier
   * (PDF text / Tesseract) is the real fallback; the breaker just avoids
   * wasting the 18s tier-1 latency budget on a provider that's down.
   *
   * Configured via [[kv_namespaces]] in wrangler.toml. The namespace ID is
   * empty in the repo and set per-environment via
   * `wrangler kv:namespace create CIRCUIT_BREAKER_KV`.
   */
  CIRCUIT_BREAKER_KV: KVNamespace;
}

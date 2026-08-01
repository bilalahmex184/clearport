// ============================================================================
// apps/ingress/src/env.ts — Typed Worker bindings for the ClearPort ingress
// ============================================================================
// This interface describes every binding the ingress Worker expects:
//
//   - SUPABASE_URL               Non-secret — the project URL.
//   - SUPABASE_ANON_KEY          Set via `wrangler secret put`. Used in the
//                                `apikey` header for Supabase auth.getUser
//                                (the only call that takes anon, not
//                                service-role).
//   - SUPABASE_SERVICE_ROLE_KEY  Service-role key — server-side only, loaded
//                                from Workers secret, never exposed to the
//                                browser. Bypasses RLS for the org-
//                                membership check, the job RPC, the Storage
//                                upload, and the documents insert. NEVER
//                                logged. NEVER returned in any response body.
//   - EXTRACTION_QUEUE           Cloudflare Queue binding. The Worker calls
//                                `env.EXTRACTION_QUEUE.send({ job_id })` to
//                                enqueue a tiny message; the consumer Worker
//                                (separate) re-fetches the job by id.
//   - RATE_LIMIT_KV              Cloudflare KV namespace binding. The Worker
//                                reads + writes `rate_limit:{org_id}:{hour}`
//                                keys to enforce 50 extractions / hour / org
//                                (Phase 5 Step 1). KV is eventually consistent
//                                — the downstream usage-limit enforcement in
//                                billing.service.ts is the hard cap; this KV
//                                limiter is the soft guard.
//
// The `Queue<T>` and `KVNamespace` types are provided by
// @cloudflare/workers-types. We declare local fallbacks so the file compiles
// even when those types aren't installed in the consuming workspace (the
// root tsconfig excludes `apps/*` and the test harness uses vitest's module
// loader, not tsc). The fallbacks are erased at runtime.
// ============================================================================

/**
 * Cloudflare Queue producer interface. Mirrors the official
 * `@cloudflare/workers-types` `Queue<T>` shape — only the `send` method is
 * used by this Worker.
 */
export interface Queue<T = unknown> {
  send(message: T): Promise<void>;
}

/**
 * Cloudflare KV namespace interface. Mirrors the official
 * `@cloudflare/workers-types` `KVNamespace` shape — only `get` + `put` (with
 * `expirationTtl`) are used by the rate limiter. Declared locally (matching
 * the `Queue<T>` pattern above) so the file compiles whether or not
 * `@cloudflare/workers-types` is installed in the consuming workspace.
 */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

/**
 * Shape of the message this Worker enqueues. The consumer Worker (built in
 * parallel) re-fetches the job by id — the message intentionally carries
 * NOTHING but the id, so:
 *   - queue messages stay tiny (a UUID is 36 bytes),
 *   - no file content / PII ever transits the queue,
 *   - the consumer always reads the canonical job state from Postgres
 *     (no race between the queue message and the DB row).
 */
export interface ExtractionJobMessage {
  job_id: string;
}

/**
 * The full Env the Worker receives as its second argument:
 *
 *   export default {
 *     async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> { ... }
 *   };
 *
 * All values are populated by wrangler from wrangler.toml + secrets.
 */
export interface Env {
  // =======================================================================
  // OLD project credentials (Phase 6 cutover)
  // The OLD project is still authoritative for every org until the migration
  // flips them. The ingress Worker reads the use_new_pipeline flag from the
  // OLD project's organizations table to decide which project to use.
  // =======================================================================
  /** OLD Supabase project URL — the authoritative source for orgs + flags. */
  OLD_SUPABASE_URL: string;
  OLD_SUPABASE_ANON_KEY: string;
  OLD_SUPABASE_SERVICE_ROLE_KEY: string;

  // =======================================================================
  // NEW project credentials (Phase 6 cutover)
  // The NEW project (fresh account, clean schema from 001_baseline_schema.sql)
  // is where migrated orgs' data lives. The ingress Worker uses these when
  // use_new_pipeline = TRUE for the requesting org.
  // =======================================================================
  /** NEW Supabase project URL — the target of the migration. */
  NEW_SUPABASE_URL: string;
  NEW_SUPABASE_ANON_KEY: string;
  NEW_SUPABASE_SERVICE_ROLE_KEY: string;

  /**
   * Cloudflare Queue binding — the producer side of `extraction-jobs`.
   * The Worker calls `env.EXTRACTION_QUEUE.send({ job_id })` once per new
   * job. Existing / duplicate jobs (idempotent re-upload) skip the send.
   */
  EXTRACTION_QUEUE: Queue<ExtractionJobMessage>;

  /**
   * Cloudflare KV namespace — used by the org-scoped rate limiter
   * (Phase 5 Step 1). The Worker reads + writes
   * `rate_limit:{org_id}:{hour_bucket}` keys here.
   */
  RATE_LIMIT_KV: KVNamespace;
}

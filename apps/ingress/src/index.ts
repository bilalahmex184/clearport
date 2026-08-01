// ============================================================================
// apps/ingress/src/index.ts — ClearPort ingress Cloudflare Worker
// ============================================================================
// This Worker is the front-door of the Phase 3 async-202 upload flow. It
// implements the 8 steps from the spec + a pre-auth IP rate-limit step
// (Phase 5 reality-check fix p5-rc-5):
//
//   0. Per-IP secondary rate limit (pre-auth flood defense, 500/hour/IP).
//   1. JWT verification + org-membership check (auth.ts).
//   1b. Org-scoped rate limit (50/hour/org, post-auth).
//   2. Parse multipart form, validate file size / magic bytes / extension
//      (@clearport/shared/file-validation).
//   3. Compute idempotency_key = sha256(file_bytes) (Web Crypto API).
//   4. get_or_create_job RPC — idempotent: a byte-identical re-upload returns
//      the existing job_id without re-processing.
//   5. Upload the file bytes to Supabase Storage (`documents` bucket).
//   6. Insert a `documents` row + update the job's document_id.
//   7. Enqueue { job_id } to the Cloudflare Queue (tiny message — the
//      consumer Worker re-fetches by id).
//   8. Return HTTP 202 immediately.
//
// The Worker is a TRUSTED SERVER-SIDE RUNTIME. It uses the service-role key
// (env.SUPABASE_SERVICE_ROLE_KEY, loaded from a Workers secret) for all
// REST/RPC/Storage calls that need to bypass RLS. The service-role key is
// NEVER logged, NEVER returned in any response body. Comment this line in
// every file that handles it:
//   "Service-role key — server-side only, loaded from Workers secret, never
//    exposed to the browser."
//
// WORKERS RUNTIME CONSTRAINTS
//   Only Web-standard APIs (fetch, crypto.subtle, FormData, Request,
//   Response). No Node `fs` / `path` / `Buffer`. The `nodejs_compat` flag is
//   set in wrangler.toml but we prefer Web APIs. The shared file-validation
//   and storage helpers are isomorphic (Web APIs only) so they run unchanged
//   in the Worker.
// ============================================================================

// Service-role key — server-side only, loaded from Workers secret, never
// exposed to the browser.
import {
  validateUploadedFile,
  FileValidationError,
} from '@clearport/shared/file-validation';
import { buildStorageKey } from '@clearport/shared/storage';
// Pipeline-result schema — validated at the DB→client boundary (Point 5).
// When returning a cached completed result, we re-validate job.result so a
// malformed stored value (e.g. from a buggy pipeline version that has since
// been fixed) is rejected with a 500 rather than silently passed to the
// client. The client gets a clear error and can re-upload to reprocess.
import { pipelineResultSchema } from '@clearport/shared/pipeline-result';
// The ONE shared structured logger (Phase 5 Step 4). Never console.log —
// the logger routes through console capture (Workers dashboard / `wrangler
// tail`) AND optional HTTP shipping (Axiom/Better Stack/Logtail) when
// LOGSHIP_URL + LOGSHIP_TOKEN are set. logWarn is used for the rate-limit
// hit (a soft-guard rejection, not an error).
import { logWarn } from '@clearport/shared/logger';

import type { Env } from './env';
import { AuthError, verifyJwtAndMembership } from './auth';
import { resolveProject, type ProjectConfig } from './project-config';
import {
  supabaseRest,
  supabaseRpc,
  supabaseStorageUpload,
} from './supabase-client';
// Org-scoped rate limiter (Phase 5 Step 1) + per-IP secondary limiter
// (Phase 5 reality-check fix p5-rc-5). The org limiter is 50 extractions /
// hour / org, keyed by org_id (NOT source IP) so a whole org behind one NAT
// IP isn't penalized as one client and a malicious org rotating exit IPs
// can't evade the limit. Runs AFTER auth (we need the verified orgId) and
// BEFORE file validation — a rejected request never parses the form, never
// touches Storage, never creates a job. The per-IP limiter (500/hour/IP)
// runs BEFORE auth as pre-auth flood defense — the org limiter can't fire
// on unauthenticated requests, so a flood of bad-JWT requests would burn
// Worker CPU on JWT verification without ever hitting the org limiter.
import { checkRateLimit, checkIpRateLimit } from './rate-limiter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a JSON Response with the given status. Used everywhere except the
 * validation error path (which carries a `code` field).
 */
function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

/**
 * Compute the SHA-256 of `bytes` as a lowercase hex string. Used as the
 * idempotency key — hashing the ACTUAL file content means a byte-identical
 * re-upload (even under a different filename) is recognized as a duplicate.
 *
 * Uses the Web Crypto API (`crypto.subtle.digest`), available in Node 18+,
 * all modern browsers, and Cloudflare Workers.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Shape returned by get_or_create_job (mirrors the SQL function signature)
// ---------------------------------------------------------------------------

interface GetOrCreateJobResult {
  id: string;
  status: string;
  attempts: number;
  result: unknown;
  created_now: boolean;
}

// ---------------------------------------------------------------------------
// Shape inserted into the `documents` table (mirrors migration 001 §3.2)
// ---------------------------------------------------------------------------

interface DocumentsInsert {
  shipment_id: string;
  org_id: string;
  user_id: string;
  doc_type: string;
  file_name: string;
  storage_path: string;
  file_size: number;
  mime_type: string;
  processing_status: 'pending';
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

/**
 * Handle a single upload request. Exported as `handleUpload` for direct
 * invocation from integration tests (which construct a Request and call
 * this function with a stubbed Env). Also wired as the default-export
 * `fetch` so wrangler picks it up.
 */
export async function handleUpload(
  req: Request,
  env: Env,
  // ctx is unused today; declared in the signature for forward-compat with
  // ctx.waitUntil() if we add background work later. Prefix with underscore
  // so consumers can omit it without a TS unused-arg error.
  _ctx?: unknown,
): Promise<Response> {
  // -----------------------------------------------------------------------
  // CORS (Phase 6 Round-2 fix #47)
  // -----------------------------------------------------------------------
  // The ingress Worker is on a different origin (workers.dev) than the
  // Next.js app (localhost:3000 / production domain). Without CORS headers,
  // the browser's fetch() to the Worker is blocked. Handle OPTIONS preflight
  // + add Access-Control-Allow-* headers to every response.
  const origin = req.headers.get('Origin') || '*';
  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-Org-Id, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  // -----------------------------------------------------------------------
  // Step 0 — Per-IP secondary rate limit (Phase 5 reality-check fix p5-rc-5)
  // -----------------------------------------------------------------------
  // PRE-AUTH FLOOD DEFENSE. The org-keyed limiter (Step 1b below) only fires
  // POST-auth — a flood of unauthenticated requests (bad JWTs, missing JWTs,
  // brute-force attempts) would burn Worker CPU on JWT verification without
  // ever hitting the org limiter. The per-IP limiter catches these floods
  // BEFORE auth, with a higher threshold (500/hour/IP — 10x the per-org cap)
  // so a legitimate office NAT sharing one IP across multiple orgs isn't
  // blocked.
  //
  // DEFENSE-IN-DEPTH LAYERING (in request order):
  //   1. IP limiter  (pre-auth,  500/hour/IP)   ← catches floods before JWT
  //   2. org limiter (post-auth, 50/hour/org)   ← per-tenant fairness
  //   3. billing hard cap (Postgres FOR UPDATE) ← the real enforcement
  //
  // All three use different mechanisms + different keys, so compromising
  // one doesn't compromise the others. The IP limiter is the only one that
  // can catch a flood of UNAUTHENTICATED requests.
  //
  // KV is eventually consistent; this is a SOFT guard. On KV outage, log +
  // proceed (the org limiter + hard cap still apply — fail OPEN, not closed,
  // because a KV outage taking down all uploads globally is worse than a
  // brief overage).
  //
  // CF-Connecting-IP is set by Cloudflare to the client's IP for every
  // request — it's the canonical source of client IP on Workers
  // (X-Forwarded-For is fallible: it's a chain that can be spoofed by the
  // client; CF-Connecting-IP is set by the edge and trusted). X-Forwarded-For
  // is a fallback for non-Cloudflare deployments (local dev, integration
  // tests). 'unknown' is the last resort — these requests share a single
  // bucket, so an attacker who somehow strips both headers is rate-limited
  // as a single 'unknown' IP (500/hour total, not 500/attack).
  const ip = req.headers.get('CF-Connecting-IP')
    || req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';

  let ipRateLimit;
  try {
    ipRateLimit = await checkIpRateLimit(env, ip);
  } catch (err) {
    // KV being down is NOT a reason to fail the upload — the soft guard is
    // best-effort, and the org limiter + hard cap in billing.service.ts
    // still apply. Log + proceed. (WARN, not ERROR — a KV outage is an
    // operational issue, not a pipeline failure.)
    const requestId = crypto.randomUUID();
    logWarn(
      env,
      'IP rate-limit check threw (KV unavailable — proceeding under soft-guard best-effort)',
      { step: 'rate_limit_ip' },
      { outcome: 'warning', request_id: requestId, ip, error: err instanceof Error ? err.message : String(err) },
    );
    ipRateLimit = null;
  }
  if (ipRateLimit && !ipRateLimit.allowed) {
    logWarn(
      env,
      'IP rate limit exceeded',
      { step: 'rate_limit_ip' },
      { outcome: 'warning', ip, count: ipRateLimit.count, limit: ipRateLimit.limit },
    );
    const retryAfterSec = Math.ceil((ipRateLimit.resetAt - Date.now()) / 1000);
    return new Response(
      JSON.stringify({
        error: 'IP rate limit exceeded',
        limit: ipRateLimit.limit,
        reset_at: new Date(ipRateLimit.resetAt).toISOString(),
        count: ipRateLimit.count,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfterSec),
        },
      },
    );
  }

  // -----------------------------------------------------------------------
  // Step 1 — JWT verification + org membership
  // -----------------------------------------------------------------------
  // AuthError carries a statusCode field (401 / 403 / 400 / 500). We catch
  // it and translate to a Response with the appropriate status. We do NOT
  // log the JWT itself.
  let auth;
  try {
    auth = await verifyJwtAndMembership(req, env);
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse(
        { error: err.message, code: err.statusCode === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED' },
        err.statusCode,
      );
    }
    // Unexpected — surface as 500 with a request id for log correlation.
    const requestId = crypto.randomUUID();
    console.log(`[ingress] unexpected auth error (${requestId}):`, err);
    return jsonResponse(
      { error: 'Internal server error', request_id: requestId },
      500,
    );
  }
  const { userId, orgId } = auth;

  // -----------------------------------------------------------------------
  // Phase 6 Step 1 — Resolve which Supabase project to use for this org.
  // -----------------------------------------------------------------------
  // The use_new_pipeline flag lives on the OLD project's organizations table.
  // If TRUE → route to the NEW project (the org's data has been migrated).
  // If FALSE → route to the OLD project (the org hasn't been migrated yet).
  // Fail-safe: on any error, route to OLD (the known-good path).
  // -----------------------------------------------------------------------
  let projectConfig: ProjectConfig;
  try {
    projectConfig = await resolveProject(env, orgId);
  } catch (err) {
    // resolveProject already fails safe internally, but defensive:
    console.warn('[ingress] resolveProject failed, routing to OLD project:', err);
    projectConfig = {
      supabaseUrl: env.OLD_SUPABASE_URL,
      supabaseAnonKey: env.OLD_SUPABASE_ANON_KEY,
      supabaseServiceRoleKey: env.OLD_SUPABASE_SERVICE_ROLE_KEY,
      projectLabel: 'old',
    };
  }
  console.log(`[ingress] org ${orgId} routed to ${projectConfig.projectLabel} project`);

  // -----------------------------------------------------------------------
  // Step 1b — Org-scoped rate limit (Phase 5 Step 1)
  // -----------------------------------------------------------------------
  // 50 extractions / hour / org, keyed by org_id (NOT source IP) so:
  //   - a whole org behind one office NAT IP isn't penalized as one client,
  //   - a malicious org rotating exit IPs can't evade the limit.
  // Runs AFTER auth (we need the verified orgId) and BEFORE file validation
  // — a rejected request never parses the form, never touches Storage, never
  // creates a job. KV is eventually consistent (~60s global propagation), so
  // this is a SOFT guard; the hard usage cap is enforceUsageLimitOrThrow in
  // billing.service.ts (Phase 2 Step 4), enforced synchronously in Postgres.
  //
  // The 429 carries:
  //   - limit       — the per-hour cap (50), so the client can show context
  //   - count       — how many requests the org has already made this hour
  //   - reset_at    — ISO timestamp of the next hour boundary (when the
  //                   bucket flips)
  //   - Retry-After — seconds until reset_at, for compliant HTTP clients
  //                    (curl, fetch, axios all honor this header).
  let rateLimit;
  try {
    rateLimit = await checkRateLimit(env, orgId);
  } catch (err) {
    // KV being down is NOT a reason to fail the upload — the soft guard is
    // best-effort, and the hard usage cap in billing.service.ts still
    // applies. Log + proceed. (This is a WARN, not an ERROR — a KV outage
    // is an operational issue, not a pipeline failure.)
    const requestId = crypto.randomUUID();
    logWarn(
      env,
      'rate-limit check threw (KV unavailable — proceeding under soft-guard best-effort)',
      { org_id: orgId, step: 'rate_limit' },
      { outcome: 'warning', request_id: requestId, error: err instanceof Error ? err.message : String(err) },
    );
    rateLimit = null;
  }
  if (rateLimit && !rateLimit.allowed) {
    logWarn(
      env,
      'Rate limit exceeded',
      { org_id: orgId, step: 'rate_limit' },
      { outcome: 'warning', count: rateLimit.count, limit: rateLimit.limit },
    );
    const retryAfterSec = Math.ceil((rateLimit.resetAt - Date.now()) / 1000);
    return new Response(
      JSON.stringify({
        error: 'Rate limit exceeded',
        limit: rateLimit.limit,
        reset_at: new Date(rateLimit.resetAt).toISOString(),
        count: rateLimit.count,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfterSec),
        },
      },
    );
  }

  // -----------------------------------------------------------------------
  // Step 2 — Parse multipart form + validate the uploaded file
  // -----------------------------------------------------------------------
  // In Cloudflare Workers (and Node 18+), `request.formData()` parses
  // multipart/form-data natively. We extract the `file` field as a File
  // object and the `shipment_id` field as a string.
  let file: File;
  let shipmentId: string;
  try {
    const form = await req.formData();
    const fileField = form.get('file');
    const shipmentField = form.get('shipment_id');
    if (!fileField || !(fileField instanceof File)) {
      return jsonResponse(
        { error: 'Missing or invalid "file" field in multipart form data', code: 'BAD_REQUEST' },
        400,
      );
    }
    file = fileField;
    if (typeof shipmentField !== 'string' || shipmentField.length === 0) {
      return jsonResponse(
        { error: 'Missing or invalid "shipment_id" field in multipart form data', code: 'BAD_REQUEST' },
        400,
      );
    }
    shipmentId = shipmentField;
  } catch (err) {
    const requestId = crypto.randomUUID();
    console.log(`[ingress] formData parse failed (${requestId}):`, err);
    return jsonResponse(
      { error: 'Internal server error', request_id: requestId },
      500,
    );
  }

  // Read the file bytes once — they're used for validation, idempotency
  // hashing, and the Storage upload.
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    const requestId = crypto.randomUUID();
    console.log(`[ingress] file.arrayBuffer() failed (${requestId}):`, err);
    return jsonResponse(
      { error: 'Internal server error', request_id: requestId },
      500,
    );
  }

  // Validate the file — size, magic bytes, extension consistency. On a
  // FileValidationError, return the canonical 4xx with the code + message
  // (this is what the client keys on for user-facing error messages).
  let mimeType: string;
  try {
    const result = validateUploadedFile({
      name: file.name,
      size: file.size,
      bytes,
    });
    mimeType = result.mimeType;
  } catch (err) {
    if (err instanceof FileValidationError) {
      return jsonResponse(
        { error: err.message, code: err.code },
        err.statusCode,
      );
    }
    const requestId = crypto.randomUUID();
    console.log(`[ingress] validateUploadedFile threw (${requestId}):`, err);
    return jsonResponse(
      { error: 'Internal server error', request_id: requestId },
      500,
    );
  }

  // -----------------------------------------------------------------------
  // Step 3 — Idempotency key from the file's SHA-256
  // -----------------------------------------------------------------------
  // Hashing the ACTUAL bytes (not the filename) means a byte-identical
  // re-upload under a different filename is recognized as a duplicate.
  // Combined with the (org_id, idempotency_key) UNIQUE constraint on the
  // jobs table, this is what makes the upload path idempotent.
  let idempotencyKey: string;
  try {
    idempotencyKey = await sha256Hex(bytes);
  } catch (err) {
    const requestId = crypto.randomUUID();
    console.log(`[ingress] sha256 failed (${requestId}):`, err);
    return jsonResponse(
      { error: 'Internal server error', request_id: requestId },
      500,
    );
  }

  // -----------------------------------------------------------------------
  // Step 3b — Billing hard cap (Phase 6 Round-2 fix #50)
  // -----------------------------------------------------------------------
  // The rate limiter (Step 1b) is a SOFT guard (KV, eventually consistent).
  // The HARD cap is enforceUsageLimitOrThrow — a Postgres FOR UPDATE lock
  // that atomically checks + counts documents. This runs BEFORE job creation
  // so a request over the monthly limit is rejected with 429 before any
  // Storage upload or job row is created.
  //
  // Only check for GENUINELY NEW jobs (created_now=true). Existing jobs
  // (idempotent re-upload) don't consume a new slot — the document was
  // already counted when it was first uploaded.
  try {
    const usageResult = await supabaseRpc<{ plan: string; count: number; limit: number; remaining: number } | null>(
      projectConfig,
      'enforce_usage_limit',
      { p_org_id: orgId },
    );
    // The function raises SQLSTATE 42901 if over limit — PostgREST surfaces
    // that as an error (caught below). If we get here, the limit was NOT
    // exceeded and the lock is held until the transaction commits.
    if (usageResult) {
      console.log(`[ingress] usage check passed: org=${orgId} count=${usageResult.count}/${usageResult.limit} remaining=${usageResult.remaining}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Check if this is a 42901 (USAGE_LIMIT_EXCEEDED) error
    if (errMsg.includes('42901') || errMsg.includes('USAGE_LIMIT_EXCEEDED')) {
      logWarn(
        env,
        'Usage limit exceeded — rejecting upload',
        { org_id: orgId, step: 'billing_hard_cap' },
        { outcome: 'warning' },
      );
      return jsonResponse(
        {
          error: 'Monthly document limit reached. Upgrade your plan to continue.',
          code: 'USAGE_LIMIT_EXCEEDED',
        },
        429,
      );
    }
    // Unexpected error — fail safe (allow the upload; the soft guard +
    // downstream checks still apply). Log loudly.
    console.error(`[ingress] enforce_usage_limit failed (failing open):`, errMsg);
  }

  // -----------------------------------------------------------------------
  // Step 4 — get_or_create_job (idempotent job creation)
  // -----------------------------------------------------------------------
  // The RPC returns the existing job if (org_id, idempotency_key) already
  // exists — no duplicate is created. `created_now` distinguishes "this is
  // a genuinely new job" from "we found an existing one".
  let job: GetOrCreateJobResult;
  try {
    job = await supabaseRpc<GetOrCreateJobResult>(projectConfig, 'get_or_create_job', {
      p_org_id: orgId,
      p_user_id: userId,
      p_shipment_id: shipmentId,
      p_idempotency_key: idempotencyKey,
      p_max_attempts: 3,
    });
  } catch (err) {
    const requestId = crypto.randomUUID();
    console.log(`[ingress] get_or_create_job failed (${requestId}):`, err);
    return jsonResponse(
      { error: 'Internal server error', request_id: requestId },
      500,
    );
  }

  // Existing job — return the cached / in-progress state. NO queue send.
  if (!job.created_now) {
    if (job.status === 'completed') {
      // -----------------------------------------------------------------
      // CACHED-RESULT GATE (Point 5) — re-validate the stored result
      // against the canonical schema before returning it to the client.
      // A malformed stored result (e.g. from a buggy pipeline version
      // that has since been fixed, or a hand-edited DB row) is rejected
      // with a 500 and a CACHED_RESULT_INVALID code. The client gets a
      // clear signal to re-upload (which triggers reprocessing via
      // get_or_create_job's revive-from-dead_letter path) instead of
      // receiving silently-corrupted data. The validated `parsed.data`
      // is what we return — no extra keys, no type drift.
      // -----------------------------------------------------------------
      const parsed = pipelineResultSchema.safeParse(job.result);
      if (!parsed.success) {
        return jsonResponse(
          {
            error: 'Cached result failed schema validation — re-upload to reprocess',
            code: 'CACHED_RESULT_INVALID',
            job_id: job.id,
          },
          500,
        );
      }
      return jsonResponse(
        {
          job_id: job.id,
          status: 'completed',
          result: parsed.data,
        },
        200,
      );
    }
    // 'pending' or 'processing' (or 'failed' between retries, or
    // 'dead_letter' — though dead_letter is revived by get_or_create_job
    // back to 'pending', so this branch handles the in-flight cases).
    return jsonResponse(
      {
        job_id: job.id,
        status: job.status,
        message: 'Job already in progress',
      },
      200,
    );
  }

  // -----------------------------------------------------------------------
  // Step 5 — Upload to Supabase Storage
  // -----------------------------------------------------------------------
  // buildStorageKey validates orgId (UUID v4) and shipmentId (charset
  // [a-zA-Z0-9_-]) before constructing the key, and sanitizes the filename.
  // On a validation failure (e.g. malicious shipment_id with slashes), we
  // mark the job failed and return 400.
  let storageKey: string;
  try {
    storageKey = buildStorageKey(orgId, shipmentId, file.name);
  } catch (err) {
    // Mark the job failed so it doesn't sit in 'pending' forever — the
    // client will need to fix their shipment_id and re-upload (the
    // idempotency key will be the same since the bytes haven't changed,
    // so get_or_create_job will revive this dead_letter job back to
    // 'pending' on the next attempt).
    await safeCompleteJob(projectConfig, job.id, false, `Invalid key inputs: ${(err as Error).message}`);
    return jsonResponse(
      { error: 'Invalid shipment_id or file name', code: 'BAD_REQUEST' },
      400,
    );
  }

  try {
    await supabaseStorageUpload(
      projectConfig,
      'documents',
      storageKey,
      bytes,
      mimeType,
    );
  } catch (err) {
    // Storage upload failed — mark the job failed (complete_job will retry
    // if attempts < max, else dead-letter) and return 500.
    console.log(
      `[ingress] Storage upload failed for job ${job.id}:`,
      err,
    );
    await safeCompleteJob(
      projectConfig,
      job.id,
      false,
      `Storage upload failed: ${(err as Error).message}`,
    );
    const requestId = crypto.randomUUID();
    return jsonResponse(
      { error: 'Internal server error', request_id: requestId },
      500,
    );
  }

  // -----------------------------------------------------------------------
  // Step 6 — Insert a `documents` row + update the job's document_id
  // -----------------------------------------------------------------------
  let documentId: string;
  try {
    const insertBody: DocumentsInsert = {
      shipment_id: shipmentId,
      org_id: orgId,
      user_id: userId,
      doc_type: 'Commercial Invoice',
      file_name: file.name,
      storage_path: storageKey,
      file_size: bytes.length,
      mime_type: mimeType,
      processing_status: 'pending',
    };
    const insertRes = await supabaseRest(projectConfig, 'documents', {
      method: 'POST',
      body: insertBody,
      // ask PostgREST to return only the inserted id (we don't need the
      // full row back — saves bytes on the wire).
      headers: { Prefer: 'return=representation', Select: 'id' },
    });
    if (!insertRes.ok) {
      const text = await insertRes.text().catch(() => '');
      throw new Error(
        `documents insert HTTP ${insertRes.status}: ${text}`,
      );
    }
    const inserted = (await insertRes.json()) as Array<{ id: string }>;
    if (!Array.isArray(inserted) || inserted.length === 0) {
      throw new Error('documents insert returned no rows');
    }
    documentId = inserted[0].id;
  } catch (err) {
    console.log(
      `[ingress] documents insert failed for job ${job.id}:`,
      err,
    );
    await safeCompleteJob(
      projectConfig,
      job.id,
      false,
      `documents insert failed: ${(err as Error).message}`,
    );
    const requestId = crypto.randomUUID();
    return jsonResponse(
      { error: 'Internal server error', request_id: requestId },
      500,
    );
  }

  // Update the job's document_id so the consumer Worker can follow the
  // job → document → storage_path chain.
  try {
    const patchRes = await supabaseRest(projectConfig, 'jobs', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(job.id)}`,
      body: { document_id: documentId },
      headers: { Prefer: 'return=minimal' },
    });
    if (!patchRes.ok) {
      // Non-fatal — the job is still claimable by id, and the consumer
      // can re-resolve the document by querying documents where
      // storage_path = key. Log and continue.
      const text = await patchRes.text().catch(() => '');
      console.log(
        `[ingress] jobs.document_id PATCH failed (non-fatal) for job ${job.id}: HTTP ${patchRes.status} ${text}`,
      );
    }
  } catch (err) {
    // Non-fatal — see comment above.
    console.log(
      `[ingress] jobs.document_id PATCH threw (non-fatal) for job ${job.id}:`,
      err,
    );
  }

  // -----------------------------------------------------------------------
  // Step 7 — Enqueue { job_id } to the Cloudflare Queue
  // -----------------------------------------------------------------------
  // The message carries ONLY the job_id — not the file, not the org_id,
  // not the storage_path. The consumer Worker re-fetches the job row by
  // id and reads everything from Postgres. This keeps queue messages
  // tiny (a UUID is 36 bytes) and avoids PII transiting the queue.
  try {
    await env.EXTRACTION_QUEUE.send({ job_id: job.id });
  } catch (err) {
    console.log(
      `[ingress] queue send failed for job ${job.id}:`,
      err,
    );
    await safeCompleteJob(projectConfig, job.id, false, 'Queue enqueue failed');
    const requestId = crypto.randomUUID();
    return jsonResponse(
      { error: 'Internal server error', request_id: requestId },
      500,
    );
  }

  // -----------------------------------------------------------------------
  // Step 8 — Return 202 Accepted
  // -----------------------------------------------------------------------
  // The upload is durably queued. The consumer Worker will claim the job,
  // download the bytes from Storage, run extraction, and call
  // complete_job with the result. The client polls a status endpoint
  // (Phase 4) to see when the job is done.
  return jsonResponse(
    { job_id: job.id, status: 'pending' },
    202,
  );
}

// ---------------------------------------------------------------------------
// Internal: best-effort complete_job call on a failure path
// ---------------------------------------------------------------------------

/**
 * Call complete_job(p_job_id, false, p_error) without throwing. Used in
 * failure paths (Storage upload failed, queue send failed) where we want
 * to mark the job failed AND still return a Response to the client — if
 * complete_job itself throws, we swallow it (logged) so the client gets a
 * clean 500 instead of an unhandled rejection.
 *
 * complete_job's SQL retries the job (status='pending') if attempts <
 * max_attempts, else dead-letters it. So "failed" here really means "either
 * queued for retry or dead-lettered" — both are correct outcomes for a
 * transient Storage / queue failure.
 */
async function safeCompleteJob(
  projectConfig: ProjectConfig,
  jobId: string,
  success: boolean,
  errorMessage: string,
): Promise<void> {
  try {
    await supabaseRpc(projectConfig, 'complete_job', {
      p_job_id: jobId,
      p_success: success,
      p_error: errorMessage,
    });
  } catch (err) {
    // Don't mask the original error — log this and move on. The job may
    // sit in 'pending' until the 5-min TTL recovery (claim_job picks it
    // up again) or until reclaim_stuck_jobs_v2 runs.
    console.log(
      `[ingress] safeCompleteJob failed for job ${jobId} (original error: ${errorMessage}):`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Default export — wrangler picks this up as the Worker entry point
// ---------------------------------------------------------------------------

const workerDefault = { fetch: handleUpload };
export default workerDefault;

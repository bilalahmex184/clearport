// ============================================================================
// supabase-client.ts — Minimal fetch-based Supabase REST + Storage client
// ============================================================================
// WHY NOT @supabase/supabase-js?
//   Cloudflare Workers run on a Web-standards runtime. The official SDK
//   pulls in Node polyfills and adds bundle weight we don't need. For the
//   narrow set of operations the consumer performs (RPC, REST select/insert/
//   update, Storage download), raw fetch is simpler, smaller, and easier to
//   audit. Same pattern as the ingress Worker (Phase 3 Step 1).
//
// SECURITY:
//   Every call uses the service-role key (env.SUPABASE_SERVICE_ROLE_KEY),
//   which bypasses RLS. The service-role key is a Workers secret — never
//   logged, never returned in responses, never shipped to client builds.
//   The consumer MUST use the service-role key because job state mutations
//   (jobs.status, job_attempts rows) are service-role-only per 002_async_jobs.sql
//   §3 — no client UPDATE/DELETE policy exists on `jobs` by design, so
//   clients cannot tamper with job state.
// ============================================================================

import type { Env } from './env';

// ---------------------------------------------------------------------------
// Shared header builder — both apikey and Authorization point at the
// service-role key. Supabase's REST gateway requires both (apikey for the
// gateway, Authorization for PostgREST).
// ---------------------------------------------------------------------------
function serviceRoleHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// supabaseRpc — POST /rest/v1/rpc/{functionName} with a JSON body.
// Used for: claim_job, complete_job, record_job_attempt, reclaim_stuck_jobs_v2.
// PostgREST returns an array for functions that RETURN TABLE, a scalar for
// functions that RETURN a scalar (reclaim_stuck_jobs_v2 returns INTEGER),
// or an empty array when no rows match (claim_job on a non-claimable job).
// ---------------------------------------------------------------------------
export async function supabaseRpc<T = unknown>(
  env: Env,
  functionName: string,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/${functionName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: serviceRoleHeaders(env, {
      'Content-Type': 'application/json',
      // Prefer: return=representation ensures PostgREST returns the result
      // body for RPCs that return rows. Without this, some calls return 204.
      Prefer: 'return=representation',
    }),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Supabase RPC ${functionName} failed: HTTP ${res.status} ${errText.slice(0, 500)}`,
    );
  }

  // Some RPCs return void (complete_job) → 204 No Content. Parse as null.
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// supabaseRestSelect — GET /rest/v1/{table}?{query}
// `query` is the raw PostgREST query string (e.g. "id=eq.X&select=col1,col2").
// Returns the parsed JSON array (caller chooses the element type).
// ---------------------------------------------------------------------------
export async function supabaseRestSelect<T = unknown>(
  env: Env,
  table: string,
  query: string,
): Promise<T[]> {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: serviceRoleHeaders(env, { Accept: 'application/json' }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Supabase REST select ${table} failed: HTTP ${res.status} ${errText.slice(0, 500)}`,
    );
  }

  return (await res.json()) as T[];
}

// ---------------------------------------------------------------------------
// supabaseRestInsert — POST /rest/v1/{table} with an array body.
// Bulk-inserts all rows in one request. Used for batch-inserting
// document_fields after a successful extraction.
// ---------------------------------------------------------------------------
export async function supabaseRestInsert(
  env: Env,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: serviceRoleHeaders(env, {
      'Content-Type': 'application/json',
      // return=minimal → 204 No Content, no body. We don't need the inserted
      // rows back; we just need to know the insert succeeded.
      Prefer: 'return=minimal',
    }),
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Supabase REST insert ${table} failed: HTTP ${res.status} ${errText.slice(0, 500)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// supabaseRestUpdate — PATCH /rest/v1/{table}?{filter}
// `filter` is the PostgREST filter (e.g. "id=eq.{documentId}"). `body` is
// the partial row to merge. Used for PATCHing documents.processing_status
// and shipments.validation_status after a successful extraction.
// ---------------------------------------------------------------------------
export async function supabaseRestUpdate(
  env: Env,
  table: string,
  filter: string,
  body: Record<string, unknown>,
): Promise<void> {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}?${filter}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: serviceRoleHeaders(env, {
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    }),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Supabase REST update ${table} failed: HTTP ${res.status} ${errText.slice(0, 500)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// supabaseStorageDownload — GET /storage/v1/object/{bucket}/{key}
// Downloads object bytes from a private Supabase Storage bucket. Returns
// the raw bytes as a Uint8Array (the pipeline expects bytes, not text —
// PDFs and images are binary, and the magic-byte validation in
// packages/shared/src/file-validation.ts needs the raw bytes).
// ---------------------------------------------------------------------------
export async function supabaseStorageDownload(
  env: Env,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  // Encode the key — it may contain slashes (org_id/shipment_id/uuid-file),
  // which are valid path separators but we want to be defensive about any
  // other special characters in the filename segment.
  const url = `${env.SUPABASE_URL}/storage/v1/object/${bucket}/${key}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: serviceRoleHeaders(env),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Supabase Storage download ${bucket}/${key} failed: HTTP ${res.status} ${errText.slice(0, 500)}`,
    );
  }

  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

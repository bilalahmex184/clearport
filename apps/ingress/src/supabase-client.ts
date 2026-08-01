// ============================================================================
// apps/ingress/src/supabase-client.ts — Minimal fetch-based Supabase client
// ============================================================================
// Phase 6 cutover: all functions accept a ProjectConfig (from project-config.ts)
// instead of the raw Env. This makes them project-agnostic — the caller
// resolves which project to use (old vs new) via resolveProject(), then
// passes that config here. Post-cutover, only the NEW project config exists.
//
// WHY NOT @supabase/supabase-js?
//   The official SDK pulls in Node polyfills that are flaky under Cloudflare
//   Workers. The Worker only needs four calls — auth.getUser, REST CRUD,
//   RPC, Storage upload — and each is a single fetch.
// ============================================================================

import type { ProjectConfig } from './project-config';

// ---------------------------------------------------------------------------
// Shared header builders
// ---------------------------------------------------------------------------

function authHeaders(config: ProjectConfig, jwt: string): Record<string, string> {
  return {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${jwt}`,
  };
}

function serviceRoleHeaders(
  config: ProjectConfig,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// auth.getUser — GET /auth/v1/user
// ---------------------------------------------------------------------------

export interface SupabaseUser {
  id: string;
  [key: string]: unknown;
}

export async function supabaseAuthGetUser(
  config: ProjectConfig,
  jwt: string,
): Promise<SupabaseUser | null> {
  const res = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    method: 'GET',
    headers: authHeaders(config, jwt),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as Partial<SupabaseUser> & { error?: unknown };
  if (!data || data.error || !data.id) return null;
  return { id: data.id, ...data };
}

// ---------------------------------------------------------------------------
// REST CRUD — /rest/v1/{path}
// ---------------------------------------------------------------------------

export interface SupabaseRestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function supabaseRest(
  config: ProjectConfig,
  path: string,
  options: SupabaseRestOptions = {},
): Promise<Response> {
  const method = options.method ?? 'GET';
  const url = `${config.supabaseUrl}/rest/v1/${path}${
    options.query ? `?${options.query}` : ''
  }`;

  const headers: Record<string, string> = serviceRoleHeaders(config, {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...options.headers,
  });

  if (method === 'POST' || method === 'PATCH') {
    headers['Prefer'] = headers['Prefer']
      ? `${headers['Prefer']}, return=representation`
      : 'return=representation';
  }

  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  return fetch(url, init);
}

// ---------------------------------------------------------------------------
// RPC — POST /rest/v1/rpc/{functionName}
// ---------------------------------------------------------------------------

export async function supabaseRpc<T = unknown>(
  config: ProjectConfig,
  functionName: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await supabaseRest(config, `rpc/${functionName}`, {
    method: 'POST',
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase RPC ${functionName} failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Storage upload — POST /storage/v1/object/{bucket}/{key}
// ---------------------------------------------------------------------------

export async function supabaseStorageUpload(
  config: ProjectConfig,
  bucket: string,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<boolean> {
  const encodedKey = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const url = `${config.supabaseUrl}/storage/v1/object/${bucket}/${encodedKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      'Content-Type': contentType,
    },
    body: bytes as unknown as BodyInit,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase Storage upload failed (HTTP ${res.status}): ${text}`);
  }
  return true;
}

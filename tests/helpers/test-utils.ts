// ============================================================================
// Test Helpers — Supabase client factory, API helpers, metrics collection
// ============================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://apfsceomnnhefxkvjhkz.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwZnNjZW9tbm5oZWZ4a3ZqaGt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MDI0ODQsImV4cCI6MjA5OTA3ODQ4NH0.TN_HXmJlNBw94ikW0zeTCgG7uEiZX1dpzVazau0pQ1s';
const API_BASE = 'http://localhost:3000';

// ============================================================================
// Test User — creates an anonymous auth user + returns token + client
// ============================================================================

export interface TestUser {
  id: string;
  token: string;
  client: SupabaseClient;
}

export async function createTestUser(): Promise<TestUser> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Failed to create test user: ${JSON.stringify(data)}`);

  const client = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${data.access_token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    id: data.user.id,
    token: data.access_token,
    client,
  };
}

// ============================================================================
// Test Org — creates an org via RPC, returns org_id
// ============================================================================

export async function createTestOrg(user: TestUser, name?: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/create_organization`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_org_name: name || `Test Org ${Date.now()}`, p_creator_uid: user.id }),
  });
  const data = await res.json();
  if (!data?.[0]?.org_id) throw new Error(`Failed to create test org: ${JSON.stringify(data)}`);
  return data[0].org_id;
}

// ============================================================================
// API Helper — makes authenticated requests with X-Org-Id header
// ============================================================================

export async function apiCall(
  user: TestUser,
  method: string,
  path: string,
  body?: any,
  orgId?: string,
): Promise<{ status: number; data: any; latency: number }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${user.token}`,
  };
  if (body) headers['Content-Type'] = 'application/json';
  if (orgId) headers['X-Org-Id'] = orgId;

  const start = performance.now();
  let res: Response | null = null;
  let lastErr: Error | null = null;

  // Retry up to 3 times with 2s delay (server may be restarting via watchdog)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (err) {
      lastErr = err as Error;
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!res) {
    return { status: 0, data: { error: lastErr?.message || 'Connection refused' }, latency: performance.now() - start };
  }

  const latency = performance.now() - start;
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }

  return { status: res.status, data, latency };
}

// ============================================================================
// Direct Supabase Helper — for RLS tests that bypass the API
// ============================================================================

export async function directSupabaseInsert(
  user: TestUser,
  table: string,
  row: Record<string, any>,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// ============================================================================
// Cleanup — deletes an org via management API (bypasses RLS)
// ============================================================================

const MANAGEMENT_TOKEN = 'SCRUBBED';

export async function cleanupOrg(orgId: string): Promise<void> {
  await fetch(`https://api.supabase.com/v1/projects/apfsceomnnhefxkvjhkz/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `DELETE FROM organizations WHERE id = '${orgId}'` }),
  });
}

// ============================================================================
// Metrics Collector — for performance tests
// ============================================================================

export interface MetricsResult {
  total_requests: number;
  success_count: number;
  failure_count: number;
  avg_latency: number;
  p50_latency: number;
  p95_latency: number;
  p99_latency: number;
  error_types: Record<string, number>;
}

export function collectMetrics(latencies: number[], errors: string[]): MetricsResult {
  const sorted = [...latencies].sort((a, b) => a - b);
  const errorTypes: Record<string, number> = {};
  for (const e of errors) errorTypes[e] = (errorTypes[e] || 0) + 1;

  return {
    total_requests: latencies.length + errors.length,
    success_count: latencies.length,
    failure_count: errors.length,
    avg_latency: latencies.reduce((a, b) => a + b, 0) / Math.max(latencies.length, 1),
    p50_latency: sorted[Math.floor(sorted.length * 0.5)] || 0,
    p95_latency: sorted[Math.floor(sorted.length * 0.95)] || 0,
    p99_latency: sorted[Math.floor(sorted.length * 0.99)] || 0,
    error_types: errorTypes,
  };
}

// ============================================================================
// Constants
// ============================================================================

export const SLA = {
  API_READ_P95: 300,     // ms (production target)
  API_WRITE_P95: 800,    // ms (production target)
  EXTRACTION_MAX: 5000,  // ms per document
  ERROR_RATE_MAX: 0.01,  // 1%
  // Sandbox allows 5x the production SLA (4GB RAM, no swap, no edge CDN, server restarts)
  SANDBOX_MULTIPLIER: 5,
};

export function getSandboxAdjustedSLA() {
  return {
    API_READ_P95: SLA.API_READ_P95 * SLA.SANDBOX_MULTIPLIER,
    API_WRITE_P95: SLA.API_WRITE_P95 * SLA.SANDBOX_MULTIPLIER,
  };
}

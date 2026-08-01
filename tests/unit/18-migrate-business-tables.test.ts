// ============================================================================
// 18-migrate-business-tables.test.ts — Phase 6 Step 2b
// ============================================================================
// Unit tests for scripts/migrate-business-tables.ts.
//
// Verifies:
//   1. Reads the user-id-map and remaps user_id columns.
//   2. Inserts in dependency order (organizations → members → shipments).
//   3. Idempotent: re-running skips existing rows.
//   4. Dry-run mode makes no API calls.
//   5. Skips `usage_limits` (config, already seeded).
//
// Strategy: mock `globalThis.fetch` to emulate the OLD + NEW Supabase REST
// API. The script uses raw `fetch(...)`, so vi.spyOn(globalThis, 'fetch')
// intercepts every call.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { migrateBusinessTables } from '../../scripts/migrate-business-tables';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = '550e8400-e29b-41d4-a716-446655440000';
const OLD_USER = '11111111-1111-1111-1111-111111111111';
const NEW_USER = '22222222-2222-2222-2222-222222222222';
const OLD_URL = 'https://old-supabase.test';
const NEW_URL = 'https://new-supabase.test';
const OLD_KEY = 'old-service-role-key';
const NEW_KEY = 'new-service-role-key';

const BASE_OPTS = {
  orgId: ORG_ID,
  oldSupabaseUrl: OLD_URL,
  oldServiceRoleKey: OLD_KEY,
  newSupabaseUrl: NEW_URL,
  newServiceRoleKey: NEW_KEY,
  userIdMap: { [OLD_USER]: NEW_USER } as Record<string, string>,
};

// ---------------------------------------------------------------------------
// Mock fetch helper — emulates a minimal PostgREST backend
// ---------------------------------------------------------------------------

interface MockState {
  // Per-project per-table "rows" returned by GET.
  rows: Record<string, Record<string, any>[]>;
  // Track which URLs/methods were called, in order.
  calls: Array<{ url: string; method: string; body?: any }>;
  // Per-project per-table existing PKs in NEW (for idempotency test).
  existingInNew: Record<string, Set<string>>;
}

function makeMockFetch(state: MockState) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const method = (init?.method || 'GET').toUpperCase();
    state.calls.push({ url: u, method, body: init?.body });

    // --- OLD project GETs: return fixture rows for each table ---
    if (u.startsWith(OLD_URL) && method === 'GET') {
      const table = u.match(/rest\/v1\/([^?]+)/)?.[1] || '';
      const rows = state.rows[table] || [];
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- NEW project GET (existing-id check): return matching PKs ---
    if (u.startsWith(NEW_URL) && method === 'GET') {
      const table = u.match(/rest\/v1\/([^?]+)/)?.[1] || '';
      // If this is a select=id lookup (existing-id check), return the
      // existing PKs. Otherwise return [].
      const isExistingCheck = u.includes('select=');
      if (isExistingCheck) {
        const existing = state.existingInNew[table] || new Set<string>();
        const pkCol = u.match(/select=([^&]+)/)?.[1] || 'id';
        const rows = Array.from(existing).map(id => ({ [pkCol]: id }));
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- NEW project POST (upsert): accept + return empty ---
    if (u.startsWith(NEW_URL) && method === 'POST') {
      return new Response(null, { status: 201 });
    }

    // --- Default: 404 ---
    return new Response('not found', { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrate-business-tables (Phase 6 Step 2b)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Reads the user-id-map and remaps user_id columns
  // -------------------------------------------------------------------------
  it('reads the user-id-map and remaps user_id columns', async () => {
    const state: MockState = {
      rows: {
        organizations: [{ id: ORG_ID, name: 'Test Org', created_at: '2024-01-01T00:00:00Z' }],
        organization_members: [
          {
            id: 'mem-1',
            org_id: ORG_ID,
            user_id: OLD_USER, // ← old user id, should be remapped
            role: 'admin',
            created_at: '2024-01-01T00:00:00Z',
          },
        ],
        shipments: [
          {
            id: 'SHIP-1',
            org_id: ORG_ID,
            user_id: OLD_USER, // ← old user id, should be remapped
            shipper: 'Acme',
            consignee: 'Globex',
            status: 'Under Review',
            docs_count: 0,
            urgency: 'PENDING',
            initial_confidence: 0,
            current_confidence: 0,
            validation_status: 'pending',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
      },
      calls: [],
      existingInNew: {},
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeMockFetch(state));

    const result = await migrateBusinessTables(BASE_OPTS);

    // Verify the POST body for organization_members had user_id remapped.
    const memberPost = state.calls.find(
      c => c.method === 'POST' && c.url.includes('/rest/v1/organization_members'),
    );
    expect(memberPost).toBeDefined();
    const postedBody = JSON.parse(memberPost!.body as string);
    expect(postedBody[0].user_id).toBe(NEW_USER); // ← remapped
    expect(postedBody[0].user_id).not.toBe(OLD_USER);

    // Same for shipments.
    const shipmentPost = state.calls.find(
      c => c.method === 'POST' && c.url.includes('/rest/v1/shipments'),
    );
    expect(shipmentPost).toBeDefined();
    const shipmentBody = JSON.parse(shipmentPost!.body as string);
    expect(shipmentBody[0].user_id).toBe(NEW_USER);

    expect(result.errors).toEqual([]);
    expect(result.tablesMigrated.organization_members).toBe(1);
    expect(result.tablesMigrated.shipments).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Inserts in dependency order (organizations → members → shipments)
  // -------------------------------------------------------------------------
  it('inserts in dependency order (organizations before members before shipments)', async () => {
    const state: MockState = {
      rows: {
        organizations: [{ id: ORG_ID, name: 'Test Org' }],
        organization_members: [{ id: 'mem-1', org_id: ORG_ID, user_id: OLD_USER, role: 'admin' }],
        shipments: [{ id: 'SHIP-1', org_id: ORG_ID, user_id: OLD_USER }],
        documents: [],
        document_fields: [],
        exceptions: [],
        operational_rules: [],
        validation_rules: [],
        broker_templates: [],
        broker_field_mappings: [],
        org_subscriptions: [],
        audit_logs: [],
        notifications: [],
        extraction_attempts: [],
        jobs: [],
        job_attempts: [],
      },
      calls: [],
      existingInNew: {},
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeMockFetch(state));

    await migrateBusinessTables(BASE_OPTS);

    // Collect the order of POST calls (these are the inserts).
    const postOrder = state.calls
      .filter(c => c.method === 'POST')
      .map(c => c.url.match(/rest\/v1\/([^?]+)/)?.[1] || '');

    const orgIdx = postOrder.indexOf('organizations');
    const memberIdx = postOrder.indexOf('organization_members');
    const shipmentIdx = postOrder.indexOf('shipments');

    expect(orgIdx).toBeGreaterThanOrEqual(0);
    expect(memberIdx).toBeGreaterThan(orgIdx);
    expect(shipmentIdx).toBeGreaterThan(memberIdx);
  });

  // -------------------------------------------------------------------------
  // 3. Idempotent: re-running skips existing rows
  // -------------------------------------------------------------------------
  it('is idempotent — skips rows whose PK already exists in NEW', async () => {
    const state: MockState = {
      rows: {
        organizations: [{ id: ORG_ID, name: 'Test Org' }],
        organization_members: [
          { id: 'mem-1', org_id: ORG_ID, user_id: OLD_USER, role: 'admin' },
        ],
        shipments: [{ id: 'SHIP-1', org_id: ORG_ID, user_id: OLD_USER }],
        // Empty tables for the rest:
        documents: [], document_fields: [], exceptions: [],
        operational_rules: [], validation_rules: [],
        broker_templates: [], broker_field_mappings: [],
        org_subscriptions: [], audit_logs: [], notifications: [],
        extraction_attempts: [], jobs: [], job_attempts: [],
      },
      calls: [],
      // Pretend the NEW project already has these PKs (from a prior run).
      existingInNew: {
        organizations: new Set([ORG_ID]),
        organization_members: new Set(['mem-1']),
        shipments: new Set(['SHIP-1']),
      },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeMockFetch(state));

    const result = await migrateBusinessTables(BASE_OPTS);

    // No POST (upsert) calls should have been made — everything was skipped.
    const posts = state.calls.filter(c => c.method === 'POST');
    expect(posts.length).toBe(0);

    // Counts should be 0 for the tables with existing data.
    expect(result.tablesMigrated.organizations).toBe(0);
    expect(result.tablesMigrated.organization_members).toBe(0);
    expect(result.tablesMigrated.shipments).toBe(0);
    expect(result.errors).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 4. Dry-run mode makes no API calls
  // -------------------------------------------------------------------------
  it('dry-run mode makes no API calls', async () => {
    const state: MockState = { rows: {}, calls: [], existingInNew: {} };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(makeMockFetch(state));

    const result = await migrateBusinessTables({ ...BASE_OPTS, dryRun: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    // Dry-run still returns a tablesMigrated object (with zero counts).
    expect(Object.keys(result.tablesMigrated).length).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5. Skips `usage_limits` (config, already seeded)
  // -------------------------------------------------------------------------
  it('skips usage_limits (config, already seeded in NEW project)', async () => {
    const state: MockState = {
      rows: {
        organizations: [{ id: ORG_ID, name: 'Test Org' }],
        organization_members: [], shipments: [],
        documents: [], document_fields: [], exceptions: [],
        operational_rules: [], validation_rules: [],
        broker_templates: [], broker_field_mappings: [],
        org_subscriptions: [], audit_logs: [], notifications: [],
        extraction_attempts: [], jobs: [], job_attempts: [],
      },
      calls: [],
      existingInNew: {},
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeMockFetch(state));

    await migrateBusinessTables(BASE_OPTS);

    // No call should touch usage_limits — in either OLD or NEW.
    const usageLimitsCalls = state.calls.filter(c => c.url.includes('usage_limits'));
    expect(usageLimitsCalls.length).toBe(0);

    // Same for stuck_documents and cron_sweep_log (transient infra tables).
    expect(state.calls.filter(c => c.url.includes('stuck_documents')).length).toBe(0);
    expect(state.calls.filter(c => c.url.includes('cron_sweep_log')).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Bonus: error isolation — a failure on one table doesn't abort others
  // -------------------------------------------------------------------------
  it('isolates per-table errors (one failure does not abort the run)', async () => {
    const state: MockState = {
      rows: {
        organizations: [{ id: ORG_ID, name: 'Test Org' }],
        // organization_members GET will 500 (simulated below).
        organization_members: [{ id: 'mem-1', org_id: ORG_ID, user_id: OLD_USER, role: 'admin' }],
        shipments: [{ id: 'SHIP-1', org_id: ORG_ID, user_id: OLD_USER }],
        documents: [], document_fields: [], exceptions: [],
        operational_rules: [], validation_rules: [],
        broker_templates: [], broker_field_mappings: [],
        org_subscriptions: [], audit_logs: [], notifications: [],
        extraction_attempts: [], jobs: [], job_attempts: [],
      },
      calls: [],
      existingInNew: {},
    };

    // Custom mock: organization_members upsert fails with 500.
    const customFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = (init?.method || 'GET').toUpperCase();
      state.calls.push({ url: u, method, body: init?.body });

      if (u.startsWith(OLD_URL) && method === 'GET') {
        const table = u.match(/rest\/v1\/([^?]+)/)?.[1] || '';
        return new Response(JSON.stringify(state.rows[table] || []), { status: 200 });
      }
      if (u.startsWith(NEW_URL) && method === 'GET') {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (u.startsWith(NEW_URL) && method === 'POST') {
        // Fail organization_members POST specifically.
        if (u.includes('/rest/v1/organization_members')) {
          return new Response('simulated 500', { status: 500 });
        }
        return new Response(null, { status: 201 });
      }
      return new Response('not found', { status: 404 });
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(customFetch);

    const result = await migrateBusinessTables(BASE_OPTS);

    // organizations + shipments should still have been migrated.
    expect(result.tablesMigrated.organizations).toBe(1);
    expect(result.tablesMigrated.shipments).toBe(1);
    // organization_members should have failed + recorded in errors.
    expect(result.tablesMigrated.organization_members).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.includes('organization_members'))).toBe(true);
  });
});

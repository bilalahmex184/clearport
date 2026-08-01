// ============================================================================
// 17-migrate-auth-users.test.ts — Phase 6 Step 2a (auth user migration)
// ============================================================================
// Verifies the migrateAuthUsers() function in scripts/migrate-auth-users.ts:
//   1. Filters to the target org's members (not all users in the project).
//   2. Re-creates each member in the NEW project via Management API POST.
//   3. Builds the { oldUserId: newUserId } JSON map file correctly.
//   4. On re-run, skips users already migrated (idempotent — by email).
//   5. Triggers a magic-link email for each newly-migrated user.
//   6. In dry-run mode, logs what it would do without making ANY API calls.
//
// Approach: mock globalThis.fetch with vi.spyOn and route based on URL +
// method. A mutable `created` map simulates the NEW project's auth.users
// table growing as the script creates users (so a second run sees them).
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateAuthUsers } from '../../scripts/migrate-auth-users';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const OLD_REF = 'old-project-ref';
const NEW_REF = 'new-project-ref';
const OLD_URL = 'https://old.supabase.co';
const NEW_URL = 'https://new.supabase.co';
const TOKEN = 'sbp_test_management_token';
const OLD_SR = 'old-service-role-key';
const NEW_ANON = 'new-anon-key';
const ORG_ID = 'org-abc-123';

interface FixtureUser {
  id: string;
  email: string;
  created_at: string;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
}

// Three users in the OLD project. u1 + u2 belong to the target org; u3 does
// NOT (the script must not migrate u3).
const OLD_USERS: FixtureUser[] = [
  {
    id: 'old-u1',
    email: 'alice@example.com',
    created_at: '2024-01-01T00:00:00Z',
    user_metadata: { full_name: 'Alice Lee' },
    app_metadata: { role: 'admin' },
  },
  {
    id: 'old-u2',
    email: 'bob@example.com',
    created_at: '2024-02-01T00:00:00Z',
    user_metadata: { full_name: 'Bob Ng' },
    app_metadata: { role: 'operator' },
  },
  {
    id: 'old-u3',
    email: 'carol@example.com',
    created_at: '2024-03-01T00:00:00Z',
    user_metadata: { full_name: 'Carol Patel' },
    app_metadata: { role: 'viewer' },
  },
];

// Only u1 + u2 are members of the target org.
const ORG_MEMBERS = ['old-u1', 'old-u2'];

// ---------------------------------------------------------------------------
// Fetch mock factory
// ---------------------------------------------------------------------------

interface MockState {
  /** Users that exist in the NEW project. Pre-populated with `seedNew`,
   *  then grows as the script creates users (so a re-run sees them). */
  newUsers: Map<string, FixtureUser>; // keyed by email (lowercase)
  /** Pre-existing users in the NEW project (for idempotency tests). */
  seedNew: FixtureUser[];
  /** Users in the OLD project (can be overridden per test). */
  oldUsers: FixtureUser[];
  /** User IDs that are members of the target org. */
  orgMemberIds: string[];
  /** Count of /auth/v1/recover calls (magic-link emails sent). */
  recoverCalls: Array<{ email: string }>;
}

function makeMock(state: MockState): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: any, init?: any) => {
      const url: string = typeof input === 'string' ? input : input.toString();
      const method: string = init?.method ?? 'GET';

      // --- OLD project: Management API list users (paginated) ---------------
      if (
        url.includes(`/v1/projects/${OLD_REF}/auth/users`) &&
        method === 'GET'
      ) {
        return new Response(
          JSON.stringify({ users: state.oldUsers, next_page: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // --- NEW project: Management API list users (paginated) ---------------
      if (
        url.includes(`/v1/projects/${NEW_REF}/auth/users`) &&
        method === 'GET'
      ) {
        const all = [...state.seedNew, ...state.newUsers.values()];
        return new Response(
          JSON.stringify({ users: all, next_page: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // --- NEW project: Management API create user --------------------------
      if (
        url.includes(`/v1/projects/${NEW_REF}/auth/users`) &&
        method === 'POST'
      ) {
        const body = JSON.parse(init.body);
        // Simulate Supabase assigning a new UUID.
        const newId = `new-${body.email.replace(/@.*$/, '')}-${Date.now()}`;
        const created: FixtureUser = {
          id: newId,
          email: body.email,
          created_at: new Date().toISOString(),
          user_metadata: body.user_metadata ?? {},
          app_metadata: body.app_metadata ?? {},
        };
        state.newUsers.set(body.email.toLowerCase(), created);
        return new Response(JSON.stringify(created), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // --- OLD project: PostgREST organization_members query ---------------
      if (url.includes(`/rest/v1/organization_members`)) {
        const rows = state.orgMemberIds.map((uid) => ({ user_id: uid }));
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // --- NEW project: /auth/v1/recover (magic-link email) ----------------
      if (url.includes(`/auth/v1/recover`) && method === 'POST') {
        const body = JSON.parse(init.body);
        state.recoverCalls.push({ email: body.email });
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(`mock: no route for ${method} ${url}`, {
        status: 404,
      });
    },
  );
}

function freshState(overrides: Partial<MockState> = {}): MockState {
  return {
    newUsers: new Map(),
    seedNew: [],
    oldUsers: [...OLD_USERS],
    orgMemberIds: [...ORG_MEMBERS],
    recoverCalls: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Phase 6 Step 2a — Auth user migration (migrateAuthUsers)', () => {
  let outputDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let state: MockState;

  beforeEach(() => {
    outputDir = resolve(
      tmpdir(),
      `migrate-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(outputDir, { recursive: true });
    state = freshState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(outputDir, { recursive: true, force: true });
  });

  // Helper: build the standard opts with a log capture.
  function makeOpts(extra: Record<string, unknown> = {}) {
    const logs: string[] = [];
    const opts = {
      orgId: ORG_ID,
      oldProjectRef: OLD_REF,
      newProjectRef: NEW_REF,
      managementToken: TOKEN,
      oldSupabaseUrl: OLD_URL,
      oldServiceRoleKey: OLD_SR,
      newSupabaseUrl: NEW_URL,
      newAnonKey: NEW_ANON,
      outputDir,
      onLog: (m: string) => logs.push(m),
      ...extra,
    };
    return { opts, logs };
  }

  // ==========================================================================
  // 1. Filters to the target org's members (not all users)
  // ==========================================================================
  describe('org membership filtering', () => {
    it('migrates only members of the target org (u3 is NOT a member → skipped)', async () => {
      fetchSpy = makeMock(state);
      const { opts, logs } = makeOpts();

      const result = await migrateAuthUsers(opts);

      // u1 + u2 migrated; u3 was never even considered.
      expect(result.migrated).toBe(2);

      // Confirm by inspecting the create-user POST calls.
      const createCalls = fetchSpy.mock.calls.filter(
        (c) =>
          (c[0] as string).includes(`/v1/projects/${NEW_REF}/auth/users`) &&
          (c[1] as any)?.method === 'POST',
      );
      expect(createCalls.length).toBe(2);
      const createdEmails = createCalls.map(
        (c) => JSON.parse((c[1] as any).body).email,
      );
      expect(createdEmails).toContain('alice@example.com');
      expect(createdEmails).toContain('bob@example.com');
      expect(createdEmails).not.toContain('carol@example.com');

      // The org-members query used the service-role key + org_id filter.
      const memberCall = fetchSpy.mock.calls.find((c) =>
        (c[0] as string).includes(`/rest/v1/organization_members`),
      );
      expect(memberCall).toBeTruthy();
      expect((memberCall![0] as string)).toContain(
        `org_id=eq.${encodeURIComponent(ORG_ID)}`,
      );
      // Service-role key used as both apikey + Authorization (bypasses RLS).
      expect((memberCall![1] as any).headers.apikey).toBe(OLD_SR);

      // Log mentions the filter.
      expect(
        logs.some((l) => l.includes('2 exported users are members of org')),
      ).toBe(true);
    });

    it('queries organization_members with the correct org_id (not a different org)', async () => {
      fetchSpy = makeMock(state);
      const { opts } = makeOpts();

      await migrateAuthUsers(opts);

      const memberCall = fetchSpy.mock.calls.find((c) =>
        (c[0] as string).includes(`/rest/v1/organization_members`),
      );
      // The URL must filter by the EXACT orgId passed in — not a wildcard,
      // not a different org.
      expect((memberCall![0] as string)).toContain(`org_id=eq.${ORG_ID}`);
    });
  });

  // ==========================================================================
  // 2. Re-creates each user in the new project
  // ==========================================================================
  describe('user re-creation', () => {
    it('POSTs each member to the NEW project Management API with email_confirm: true', async () => {
      fetchSpy = makeMock(state);
      const { opts } = makeOpts();

      await migrateAuthUsers(opts);

      const createCalls = fetchSpy.mock.calls.filter(
        (c) =>
          (c[0] as string).includes(`/v1/projects/${NEW_REF}/auth/users`) &&
          (c[1] as any)?.method === 'POST',
      );

      for (const call of createCalls) {
        const body = JSON.parse((call[1] as any).body);
        expect(body.email_confirm).toBe(true);
        // NO password field — the user sets up access via magic-link.
        expect(body.password).toBeUndefined();
        // user_metadata + app_metadata are carried over.
        expect(body.user_metadata).toBeDefined();
        expect(body.app_metadata).toBeDefined();
      }

      // Alice's metadata carried over.
      const aliceCall = createCalls.find(
        (c) => JSON.parse((c[1] as any).body).email === 'alice@example.com',
      );
      expect(aliceCall).toBeTruthy();
      expect(JSON.parse((aliceCall![1] as any).body).user_metadata).toEqual({
        full_name: 'Alice Lee',
      });
      expect(JSON.parse((aliceCall![1] as any).body).app_metadata).toEqual({
        role: 'admin',
      });
    });

    it('uses the management token (not the service-role key) for Management API calls', async () => {
      fetchSpy = makeMock(state);
      const { opts } = makeOpts();

      await migrateAuthUsers(opts);

      const mgmtCalls = fetchSpy.mock.calls.filter((c) =>
        (c[0] as string).includes('api.supabase.com'),
      );
      expect(mgmtCalls.length).toBeGreaterThan(0);
      for (const call of mgmtCalls) {
        expect((call[1] as any).headers.Authorization).toBe(
          `Bearer ${TOKEN}`,
        );
      }
    });
  });

  // ==========================================================================
  // 3. Builds the user-id-map JSON correctly
  // ==========================================================================
  describe('user-id map file', () => {
    it('writes {oldUserId: newUserId} for each migrated user to {outputDir}/{orgId}-user-id-map.json', async () => {
      fetchSpy = makeMock(state);
      const { opts } = makeOpts();

      const result = await migrateAuthUsers(opts);

      // Map file path follows the {orgId}-user-id-map.json convention.
      expect(result.mapFile).toBe(
        resolve(outputDir, `${ORG_ID}-user-id-map.json`),
      );
      expect(existsSync(result.mapFile)).toBe(true);

      const map = JSON.parse(readFileSync(result.mapFile, 'utf8'));
      // Two entries: old-u1 → new-*, old-u2 → new-*.
      expect(Object.keys(map).length).toBe(2);
      expect(map['old-u1']).toMatch(/^new-alice/);
      expect(map['old-u2']).toMatch(/^new-bob/);
      // u3 is NOT in the map (not a member of the org).
      expect(map['old-u3']).toBeUndefined();
    });

    it('the map file path uses the orgId (so multiple orgs get separate files)', async () => {
      fetchSpy = makeMock(state);
      const { opts } = makeOpts({ orgId: 'org-different-456' });

      const result = await migrateAuthUsers(opts);

      expect(result.mapFile).toContain('org-different-456-user-id-map.json');
    });
  });

  // ==========================================================================
  // 4. Idempotent — re-run skips users already migrated (by email)
  // ==========================================================================
  describe('idempotency', () => {
    it('on re-run, skips users whose email already exists in the NEW project (no duplicate creation, no duplicate magic-link)', async () => {
      fetchSpy = makeMock(state);
      const { opts } = makeOpts();

      // Run 1: creates alice + bob, sends 2 magic-links.
      const r1 = await migrateAuthUsers(opts);
      expect(r1.migrated).toBe(2);
      expect(state.recoverCalls.length).toBe(2);

      const createCallsAfterRun1 = fetchSpy.mock.calls.filter(
        (c) =>
          (c[0] as string).includes(`/v1/projects/${NEW_REF}/auth/users`) &&
          (c[1] as any)?.method === 'POST',
      ).length;
      expect(createCallsAfterRun1).toBe(2);

      // Run 2: same org, same users. The map file already exists AND the
      // emails exist in the NEW project. Every user should be skipped.
      const r2 = await migrateAuthUsers(opts);
      expect(r2.migrated).toBe(0);
      expect(r2.skipped).toBe(2);

      // No NEW create calls on run 2 (the count didn't grow).
      const createCallsAfterRun2 = fetchSpy.mock.calls.filter(
        (c) =>
          (c[0] as string).includes(`/v1/projects/${NEW_REF}/auth/users`) &&
          (c[1] as any)?.method === 'POST',
      ).length;
      expect(createCallsAfterRun2).toBe(2); // unchanged from run 1

      // No NEW magic-link emails on run 2.
      expect(state.recoverCalls.length).toBe(2); // unchanged from run 1
    });

    it('records the EXISTING new-project user ID in the map when the email is already present', async () => {
      // Seed the NEW project with an existing user for alice's email.
      const existingAlice: FixtureUser = {
        id: 'preexisting-alice-id',
        email: 'alice@example.com',
        created_at: '2024-01-01T00:00:00Z',
        user_metadata: {},
        app_metadata: {},
      };
      state = freshState({ seedNew: [existingAlice] });
      fetchSpy = makeMock(state);
      const { opts } = makeOpts();

      const result = await migrateAuthUsers(opts);

      // Alice was skipped (email exists), Bob was migrated.
      expect(result.migrated).toBe(1);
      expect(result.skipped).toBe(1);

      // The map records the PRE-EXISTING new ID for alice (not a new one).
      const map = JSON.parse(readFileSync(result.mapFile, 'utf8'));
      expect(map['old-u1']).toBe('preexisting-alice-id');
      expect(map['old-u2']).toMatch(/^new-bob/);

      // No create call for alice.
      const createCalls = fetchSpy.mock.calls.filter(
        (c) =>
          (c[0] as string).includes(`/v1/projects/${NEW_REF}/auth/users`) &&
          (c[1] as any)?.method === 'POST',
      );
      const createdEmails = createCalls.map(
        (c) => JSON.parse((c[1] as any).body).email,
      );
      expect(createdEmails).not.toContain('alice@example.com');

      // No magic-link for alice (only bob got one).
      expect(state.recoverCalls.map((r) => r.email)).toEqual([
        'bob@example.com',
      ]);
    });
  });

  // ==========================================================================
  // 5. Triggers a magic-link email for each migrated user
  // ==========================================================================
  describe('magic-link emails', () => {
    it('POSTs to /auth/v1/recover for each newly-created user with their email', async () => {
      fetchSpy = makeMock(state);
      const { opts } = makeOpts();

      await migrateAuthUsers(opts);

      // Exactly one recover call per migrated user (u1 + u2). u3 not migrated.
      expect(state.recoverCalls.length).toBe(2);
      const emails = state.recoverCalls.map((r) => r.email).sort();
      expect(emails).toEqual(['alice@example.com', 'bob@example.com']);

      // The recover endpoint uses the NEW project's anon key (not the
      // management token, not the service-role key).
      const recoverCalls = fetchSpy.mock.calls.filter((c) =>
        (c[0] as string).includes(`/auth/v1/recover`),
      );
      for (const call of recoverCalls) {
        expect((call[0] as string)).toContain(NEW_URL);
        expect((call[1] as any).headers.apikey).toBe(NEW_ANON);
        expect((call[1] as any).headers.Authorization).toBeUndefined();
      }
    });

    it('logs "Sent magic-link to {email} (old: {oldId}, new: {newId})" for each migrated user', async () => {
      fetchSpy = makeMock(state);
      const { opts, logs } = makeOpts();

      await migrateAuthUsers(opts);

      const sentLogs = logs.filter((l) => l.startsWith('Sent magic-link to '));
      expect(sentLogs.length).toBe(2);
      for (const l of sentLogs) {
        expect(l).toMatch(/^Sent magic-link to .+ \(old: .+, new: .+\)$/);
      }
    });

    it('does NOT send a magic-link to a user who was skipped (already exists by email)', async () => {
      const existingAlice: FixtureUser = {
        id: 'preexisting-alice-id',
        email: 'alice@example.com',
        created_at: '2024-01-01T00:00:00Z',
        user_metadata: {},
        app_metadata: {},
      };
      state = freshState({ seedNew: [existingAlice] });
      fetchSpy = makeMock(state);
      const { opts } = makeOpts();

      await migrateAuthUsers(opts);

      // Alice was skipped → no magic-link. Only bob got one.
      expect(state.recoverCalls.map((r) => r.email)).toEqual([
        'bob@example.com',
      ]);
    });
  });

  // ==========================================================================
  // 6. Dry-run mode — logs what it would do, makes ZERO API calls
  // ==========================================================================
  describe('dry-run mode', () => {
    it('does NOT call fetch at all', async () => {
      fetchSpy = makeMock(state);
      const { opts } = makeOpts({ dryRun: true });

      await migrateAuthUsers(opts);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('logs what it would do (mentions export, filter, re-create, map, magic-link)', async () => {
      fetchSpy = makeMock(state);
      const { opts, logs } = makeOpts({ dryRun: true });

      await migrateAuthUsers(opts);

      const combined = logs.join('\n');
      expect(combined).toMatch(/Would export users from OLD project/);
      expect(combined).toMatch(/Would.*organization_members/);
      expect(combined).toMatch(/Would re-create each member/);
      expect(combined).toMatch(/Would write user-id map/);
      expect(combined).toMatch(/Would send magic-link/);
      expect(combined).toMatch(/\[dry-run\]/);
    });

    it('returns zeroed-out counts + the would-be map file path', async () => {
      fetchSpy = makeMock(state);
      const { opts } = makeOpts({ dryRun: true });

      const result = await migrateAuthUsers(opts);

      expect(result.migrated).toBe(0);
      expect(result.skipped).toBe(0);
      // The map file path is still computed (so the operator knows where it
      // WOULD be written) but the file is NOT created.
      expect(result.mapFile).toBe(
        resolve(outputDir, `${ORG_ID}-user-id-map.json`),
      );
      expect(existsSync(result.mapFile)).toBe(false);
    });
  });

  // ==========================================================================
  // Bonus: resumability (the map file IS the checkpoint)
  // ==========================================================================
  describe('resumability via the map file', () => {
    it('on re-run, skips users already present in the map file (no API calls for them)', async () => {
      fetchSpy = makeMock(state);
      const { opts, logs } = makeOpts();

      // Run 1: migrate alice + bob.
      await migrateAuthUsers(opts);

      // Simulate a NEW user (u3 becomes a member of the org) added before
      // re-run — like an operator inviting someone between runs.
      state.orgMemberIds.push('old-u3');

      const r2 = await migrateAuthUsers(opts);

      // u3 was migrated; u1 + u2 were loaded from the map file + skipped
      // (the "[skip] ... already in map (resumed)" path).
      expect(r2.migrated).toBe(1);
      expect(r2.skipped).toBe(2);

      // The resume log fired.
      expect(logs.some((l) => l.includes('[resume] Loaded'))).toBe(true);
      expect(
        logs.some((l) => l.includes('already in map (resumed)')),
      ).toBe(true);

      // Only ONE create call on run 2 (for u3). The total create-call count
      // across both runs is 3 (alice + bob on run 1, carol on run 2).
      const createCalls = fetchSpy.mock.calls.filter(
        (c) =>
          (c[0] as string).includes(`/v1/projects/${NEW_REF}/auth/users`) &&
          (c[1] as any)?.method === 'POST',
      );
      expect(createCalls.length).toBe(3);
      expect(JSON.parse((createCalls[2][1] as any).body).email).toBe(
        'carol@example.com',
      );
    });
  });

  // ==========================================================================
  // Bonus: input validation
  // ==========================================================================
  describe('input validation', () => {
    it('throws a clear error if the management token is missing (with the dashboard URL)', async () => {
      const { opts } = makeOpts({ managementToken: '' });

      await expect(migrateAuthUsers(opts)).rejects.toThrow(
        /SUPABASE_MANAGEMENT_TOKEN is required/,
      );
      await expect(migrateAuthUsers(opts)).rejects.toThrow(
        /supabase\.com\/dashboard\/account\/tokens/,
      );
    });

    it('throws if orgId is missing', async () => {
      const { opts } = makeOpts({ orgId: '' });
      await expect(migrateAuthUsers(opts)).rejects.toThrow(/orgId is required/);
    });
  });

  // ==========================================================================
  // Bonus: the script header documents the operator checklist
  // ==========================================================================
  describe('operator-facing documentation in the script source', () => {
    it('the script file documents that operators must communicate the password reset BEFORE running', () => {
      const src = readFileSync(
        resolve(__dirname, '../../scripts/migrate-auth-users.ts'),
        'utf8',
      );
      // The operator checklist must mention communicating the reset.
      expect(src).toMatch(/Communicate the password reset/i);
      expect(src).toMatch(/BEFORE/i);
      // Security note: never log the management token.
      expect(src).toMatch(/NEVER logs the management token/);
      // Security note: no password hashes exported.
      expect(src).toMatch(/NOT export password hashes/);
      // Reusable: test org first, then batches.
      expect(src).toMatch(/test org/);
      expect(src).toMatch(/batches/);
    });
  });
});

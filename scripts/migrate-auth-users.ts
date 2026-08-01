#!/usr/bin/env bun
// scripts/migrate-auth-users.ts
//
// ============================================================================
// Phase 6 Step 2a — Auth user migration script (cutover)
// ============================================================================
// PURPOSE
//   Supabase auth users don't port cleanly across projects: password hashes
//   are encrypted with a per-project key, so a user created in the OLD
//   project cannot log in to the NEW project with the same password (the
//   hash is unreadable). This script:
//
//     1. Exports users from the OLD project via the Management API.
//     2. Filters to members of the target org (queries organization_members).
//     3. Re-creates each user in the NEW project WITHOUT a password.
//     4. Builds a { oldUserId: newUserId } JSON map for Step 2b (business
//        tables migration) to remap foreign keys.
//     5. Triggers a magic-link / password-recovery email for each migrated
//        user so they can set up their NEW-project access.
//
//   It does NOT export password hashes (they're project-scoped and useless).
//
// REUSABLE
//   Run once for the test org, then run again for remaining orgs in batches.
//   Each run is scoped to a single orgId and emits its own map file:
//     scripts/migration-output/{orgId}-user-id-map.json
//
// IDEMPOTENT
//   Re-running for the same org is safe. For each user the script first checks
//   the NEW project's existing users by email — if the email already exists,
//   re-creation is skipped and the existing new-project user ID is recorded
//   in the map. This means a crashed run can be safely re-run.
//
// RESUMABLE
//   The user-id-map JSON file IS the checkpoint. On startup the script loads
//   any existing map file and skips users already present in it (no API
//   calls, no magic-link email). The map is re-written after EACH user, so a
//   crash mid-run loses at most one user's work. Just re-run.
//
// DRY-RUN
//   Pass --dry-run to log what the script WOULD do without making ANY API
//   calls. Use this to sanity-check the target org + env before the real run.
//
// OPERATOR CHECKLIST — DO THIS BEFORE RUNNING FOR REAL
//   1. **Communicate the password reset to your users FIRST.** After this
//      script runs, every affected user receives a magic-link email from
//      Supabase Auth for the NEW project. Their OLD password stops working
//      the moment traffic is cut over. Tell users:
//        "You'll get an email from ClearPort. Click the link to set up your
//         new login. Your old password won't work anymore."
//      Send this notice BEFORE running the script so users expect the email
//      and don't treat it as phishing.
//   2. Set every env var listed under ENV below.
//   3. Dry-run first: `bun run scripts/migrate-auth-users.ts <orgId> --dry-run`
//   4. Real run:    `bun run scripts/migrate-auth-users.ts <orgId>`
//   5. Hand the resulting map file to Step 2b (business tables migration).
//
// ENV
//   OLD_SUPABASE_REF              project ref of the OLD (source) project
//   NEW_SUPABASE_REF              project ref of the NEW (target) project
//   SUPABASE_MANAGEMENT_TOKEN     personal access token from
//                                 https://supabase.com/dashboard/account/tokens
//                                 (NOT the service-role key — this is a
//                                 separate personal token used for the
//                                 Management API)
//   OLD_SUPABASE_URL              https://<old_ref>.supabase.co
//   OLD_SUPABASE_SERVICE_ROLE_KEY service-role key for OLD project (bypasses
//                                 RLS to read organization_members)
//   NEW_SUPABASE_URL              https://<new_ref>.supabase.co
//   NEW_SUPABASE_ANON_KEY         anon key for NEW project (used to call
//                                 /auth/v1/recover to send magic-link emails)
//
// SECURITY
//   - The script NEVER logs the management token. Errors include only the
//     HTTP status + response body.
//   - The script NEVER logs a user's password. There are no passwords in
//     this flow — we deliberately force a magic-link re-auth.
//   - The script does NOT export password hashes from the OLD project.
//   - The service-role key is used ONLY for read-only PostgREST calls
//     (organization_members); it is never logged and never sent anywhere
//     except the OLD project's own REST endpoint.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Types
// ============================================================================

/** Minimal user record exported from the OLD project's auth.users. */
export interface ExportedUser {
  id: string;
  email: string;
  created_at: string;
  user_metadata: Record<string, unknown> | null;
  app_metadata: Record<string, unknown> | null;
}

/** Options accepted by migrateAuthUsers. The first 8 fields are the
 *  required operator inputs; the rest are optional extensions used for
 *  dry-run mode and test hooks. */
export interface MigrateAuthUsersOpts {
  orgId: string;
  oldProjectRef: string;
  newProjectRef: string;
  /** Management token for the OLD project's account (export users). */
  oldManagementToken: string;
  /** Management token for the NEW project's account (create users). May be the same as old if both projects are under the same account. */
  newManagementToken: string;
  oldSupabaseUrl: string;
  oldServiceRoleKey: string;
  newSupabaseUrl: string;
  newAnonKey: string;
  /** Dry-run mode: log what would happen, make ZERO API calls. */
  dryRun?: boolean;
  /** Override the output directory for the map file (defaults to
   *  scripts/migration-output). Used by tests to write to a temp dir. */
  outputDir?: string;
  /** Capture log lines (tests use this to assert behavior). Defaults to
   *  console.log when omitted. */
  onLog?: (msg: string) => void;
}

export interface MigrateResult {
  migrated: number;
  skipped: number;
  mapFile: string;
}

// ============================================================================
// Constants
// ============================================================================

const MANAGEMENT_API_BASE = 'https://api.supabase.com';
const PAGE_SIZE = 1000; // Supabase Management API max per_page for /auth/users
const MAX_PAGES = 10_000; // safety guard against infinite pagination loops

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_OUTPUT_DIR = resolve(__dirname, 'migration-output');

// ============================================================================
// CLI entry point — only runs when invoked directly via `bun run`
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const orgId = args.find((a) => !a.startsWith('-'));

  if (!orgId) {
    console.error(
      'Usage: bun run scripts/migrate-auth-users.ts <orgId> [--dry-run]',
    );
    process.exit(2);
  }

  const requiredEnv = [
    'OLD_SUPABASE_REF',
    'NEW_SUPABASE_REF',
    'OLD_SUPABASE_MANAGEMENT_TOKEN',
    'NEW_SUPABASE_MANAGEMENT_TOKEN',
    'OLD_SUPABASE_URL',
    'OLD_SUPABASE_SERVICE_ROLE_KEY',
    'NEW_SUPABASE_URL',
    'NEW_SUPABASE_ANON_KEY',
  ] as const;

  const missing = requiredEnv.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    if (missing.includes('OLD_SUPABASE_MANAGEMENT_TOKEN') || missing.includes('NEW_SUPABASE_MANAGEMENT_TOKEN')) {
      console.error(
        '  Get personal access tokens at ' +
          'https://supabase.com/dashboard/account/tokens',
      );
      console.error(
        '  (NOT the service-role key — the management token is separate)',
      );
    }
    process.exit(2);
  }

  const result = await migrateAuthUsers({
    orgId,
    oldProjectRef: process.env.OLD_SUPABASE_REF!,
    newProjectRef: process.env.NEW_SUPABASE_REF!,
    oldManagementToken: process.env.OLD_SUPABASE_MANAGEMENT_TOKEN!,
    newManagementToken: process.env.NEW_SUPABASE_MANAGEMENT_TOKEN!,
    oldSupabaseUrl: process.env.OLD_SUPABASE_URL!,
    oldServiceRoleKey: process.env.OLD_SUPABASE_SERVICE_ROLE_KEY!,
    newSupabaseUrl: process.env.NEW_SUPABASE_URL!,
    newAnonKey: process.env.NEW_SUPABASE_ANON_KEY!,
    dryRun,
    onLog: (msg) => console.log(msg),
  });

  console.log(
    `\nDone. migrated=${result.migrated} skipped=${result.skipped} ` +
      `mapFile=${result.mapFile}`,
  );
}

// ============================================================================
// migrateAuthUsers — the core, testable function
// ============================================================================
//
// Exported so the unit test (tests/unit/17-migrate-auth-users.test.ts) can
// invoke it directly with mocked fetch + a temp output dir.
//
// Steps:
//   1. Load existing map file (resumability checkpoint).
//   2. Export all users from OLD project via Management API (paginated).
//   3. Query OLD project's organization_members to find the target org's
//      user IDs; filter the exported users to just those.
//   4. List existing users in NEW project (for email-based idempotency).
//   5. For each target user:
//      a. If already in the map file → skip (resumed).
//      b. If email already exists in NEW project → record existing new ID,
//         skip re-creation (idempotent).
//      c. Otherwise → POST to NEW project's Management API to create the
//         user (no password, email_confirm: true), record new ID in map,
//         POST /auth/v1/recover to send magic-link email.
//   6. Persist the map file after each user (crash-safe).
// ============================================================================

export async function migrateAuthUsers(
  opts: MigrateAuthUsersOpts,
): Promise<MigrateResult> {
  const log = (msg: string): void => {
    (opts.onLog ?? console.log)(msg);
  };

  // --- Validate inputs -------------------------------------------------------
  if (!opts.orgId) throw new Error('orgId is required');
  if (!opts.oldManagementToken || !opts.newManagementToken) {
    throw new Error(
      'SUPABASE_MANAGEMENT_TOKEN (or OLD/NEW_SUPABASE_MANAGEMENT_TOKEN) is required. Get a personal access token at ' +
        'https://supabase.com/dashboard/account/tokens ' +
        '(NOT the service-role key — the management token is separate).',
    );
  }
  const requiredFields = [
    'oldProjectRef',
    'newProjectRef',
    'oldSupabaseUrl',
    'oldServiceRoleKey',
    'newSupabaseUrl',
    'newAnonKey',
  ] as const;
  for (const k of requiredFields) {
    if (!opts[k]) throw new Error(`${k} is required`);
  }

  const outputDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  const mapFile = resolve(outputDir, `${opts.orgId}-user-id-map.json`);

  // --- Dry-run: log + bail (zero API calls) ---------------------------------
  if (opts.dryRun) {
    log('[dry-run] NO API calls will be made.');
    log(
      `[dry-run] Would export users from OLD project (${opts.oldProjectRef}) ` +
        `via Management API GET /v1/projects/{ref}/auth/users`,
    );
    log(
      `[dry-run] Would query OLD project's organization_members for org ` +
        `${opts.orgId} and filter exported users to its members`,
    );
    log(
      `[dry-run] Would list existing users in NEW project ` +
        `(${opts.newProjectRef}) for email-based idempotency check`,
    );
    log(
      `[dry-run] Would re-create each member in NEW project via ` +
        `POST /v1/projects/{ref}/auth/users (no password, email_confirm: true)`,
    );
    log(`[dry-run] Would write user-id map to ${mapFile}`);
    log(
      `[dry-run] Would send magic-link emails via ` +
        `${opts.newSupabaseUrl}/auth/v1/recover for each newly-created user`,
    );
    return { migrated: 0, skipped: 0, mapFile };
  }

  // --- Load existing map (resumability checkpoint) ---------------------------
  let userIdMap: Record<string, string> = {};
  if (existsSync(mapFile)) {
    try {
      const parsed = JSON.parse(readFileSync(mapFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        userIdMap = { ...parsed };
        log(
          `[resume] Loaded ${Object.keys(userIdMap).length} already-mapped ` +
            `users from ${mapFile}`,
        );
      }
    } catch (err) {
      log(
        `[resume] WARN: existing map file unreadable, starting fresh: ` +
          `${(err as Error).message}`,
      );
    }
  }

  // --- Step 1: Export all users from OLD project -----------------------------
  log(
    `[step 1] Exporting users from OLD project (${opts.oldProjectRef})…`,
  );
  const oldUsers = await exportAllUsers({
    projectRef: opts.oldProjectRef,
    token: opts.oldManagementToken,
  });
  log(`[step 1] Exported ${oldUsers.length} users from OLD project`);

  // --- Step 2: Filter to target org's members --------------------------------
  log(
    `[step 2] Fetching members of org ${opts.orgId} from OLD project…`,
  );
  const memberUserIds = await fetchOrgMemberUserIds({
    supabaseUrl: opts.oldSupabaseUrl,
    serviceRoleKey: opts.oldServiceRoleKey,
    orgId: opts.orgId,
  });
  log(`[step 2] Org has ${memberUserIds.size} members`);

  const memberUserSet = memberUserIds;
  const targetUsers = oldUsers.filter((u) => memberUserSet.has(u.id));
  log(
    `[step 2] ${targetUsers.length} exported users are members of org ` +
      `${opts.orgId}`,
  );

  if (targetUsers.length === 0) {
    log(`[step 2] No users to migrate. Writing map and exiting.`);
    persistMap(mapFile, userIdMap, outputDir);
    return { migrated: 0, skipped: 0, mapFile };
  }

  // --- Step 3: List existing users in NEW project (idempotency) -------------
  log(
    `[step 3] Listing existing users in NEW project for idempotency check…`,
  );
  const newUsers = await exportAllUsers({
    projectRef: opts.newProjectRef,
    token: opts.newManagementToken,
  });
  const newEmailToId = new Map<string, string>();
  for (const u of newUsers) {
    if (u.email) newEmailToId.set(u.email.toLowerCase(), u.id);
  }
  log(
    `[step 3] NEW project has ${newEmailToId.size} existing users ` +
      `(email-indexed)`,
  );

  // --- Step 4 + 5: Re-create + build map + send magic-link -------------------
  let migrated = 0;
  let skipped = 0;

  for (const oldUser of targetUsers) {
    // Guard: skip users without an email (cannot re-create without one).
    if (!oldUser.email) {
      log(
        `[skip] User ${oldUser.id} has no email — skipping (cannot re-create ` +
          `without email)`,
      );
      skipped++;
      continue;
    }

    // Resume: skip if already in the map file (prior run completed this user).
    if (userIdMap[oldUser.id]) {
      const existingNewId = userIdMap[oldUser.id];
      log(
        `[skip] ${oldUser.email} (old: ${oldUser.id}, new: ${existingNewId}) ` +
          `— already in map (resumed)`,
      );
      skipped++;
      continue;
    }

    // Idempotent: if email already exists in NEW project, record existing ID
    // and skip re-creation. (Do NOT send another magic-link — they may have
    // already received one from a prior run or manual creation.)
    const existingByEmail = newEmailToId.get(oldUser.email.toLowerCase());
    if (existingByEmail) {
      userIdMap[oldUser.id] = existingByEmail;
      log(
        `[skip] ${oldUser.email} (old: ${oldUser.id}, new: ${existingByEmail}) ` +
          `— already exists in NEW project by email`,
      );
      skipped++;
      persistMap(mapFile, userIdMap, outputDir);
      continue;
    }

    // Re-create the user in the NEW project (NO password — magic-link will
    // be sent below so the user can set up access).
    try {
      const newUser = await createUserInNewProject({
        projectRef: opts.newProjectRef,
        token: opts.newManagementToken,
        email: oldUser.email,
        userMetadata: oldUser.user_metadata ?? {},
        appMetadata: oldUser.app_metadata ?? {},
      });

      userIdMap[oldUser.id] = newUser.id;
      newEmailToId.set(oldUser.email.toLowerCase(), newUser.id);
      log(
        `[migrated] Created ${oldUser.email} (old: ${oldUser.id}, new: ` +
          `${newUser.id})`,
      );

      // Step 5: trigger a magic-link / password-recovery email for the
      // newly-created user. This is how they set up access to the NEW
      // project (no password was set on creation).
      await sendMagicLink({
        supabaseUrl: opts.newSupabaseUrl,
        anonKey: opts.newAnonKey,
        email: oldUser.email,
      });
      log(
        `Sent magic-link to ${oldUser.email} (old: ${oldUser.id}, new: ` +
          `${newUser.id})`,
      );

      migrated++;
      // Persist after each user so a crash mid-run keeps prior progress.
      persistMap(mapFile, userIdMap, outputDir);
    } catch (err) {
      // Log + continue — one bad user shouldn't block the whole org.
      // The user is NOT in the map, so re-running will retry them.
      log(
        `[error] Failed to migrate ${oldUser.email} (old: ${oldUser.id}): ` +
          `${(err as Error).message}`,
      );
    }
  }

  log(
    `\nDone. migrated=${migrated} skipped=${skipped} mapFile=${mapFile}`,
  );
  return { migrated, skipped, mapFile };
}

// ============================================================================
// Helpers — Management API (list + create users)
// ============================================================================

/**
 * Export ALL users from a project's auth.users via the Management API.
 * Paginates through 1000-per-page until the last page is reached.
 *
 * Does NOT export password hashes — they're project-scoped and useless for
 * migration (encrypted with the source project's key).
 */
async function exportAllUsers(args: {
  projectRef: string;
  token: string;
}): Promise<ExportedUser[]> {
  const all: ExportedUser[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const url =
      `${MANAGEMENT_API_BASE}/v1/projects/${args.projectRef}/users` +
      `?per_page=${PAGE_SIZE}&page=${page}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${args.token}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Management API GET /auth/users page ${page} failed: ` +
          `${res.status} ${text}`,
      );
    }

    const body = (await res.json()) as {
      users?: Array<Record<string, unknown>>;
      next_page?: number | null;
    };

    const users = body.users ?? [];
    for (const u of users) {
      all.push({
        id: String(u.id),
        email: u.email ? String(u.email) : '',
        created_at: u.created_at ? String(u.created_at) : '',
        user_metadata:
          (u.user_metadata as Record<string, unknown> | null) ?? null,
        app_metadata:
          (u.app_metadata as Record<string, unknown> | null) ?? null,
      });
    }

    // Stop on last page: either next_page is explicitly null, or we received
    // fewer than PAGE_SIZE users (partial last page), or no users at all.
    if (users.length === 0) break;
    if (users.length < PAGE_SIZE) break;
    if (body.next_page === null || body.next_page === undefined) break;
    page = body.next_page ?? page + 1;
  }

  return all;
}

/**
 * Create a user in the NEW project via the Management API. No password is
 * set — the user will receive a magic-link email to set up their access.
 * email_confirm: true marks the email as already verified (it was verified
 * in the OLD project; we trust that).
 */
async function createUserInNewProject(args: {
  projectRef: string;
  token: string;
  email: string;
  userMetadata: Record<string, unknown>;
  appMetadata: Record<string, unknown>;
}): Promise<{ id: string }> {
  const url =
    `${MANAGEMENT_API_BASE}/v1/projects/${args.projectRef}/users`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: args.email,
      user_metadata: args.userMetadata,
      app_metadata: args.appMetadata,
      email_confirm: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Management API POST /auth/users failed for ${args.email}: ` +
        `${res.status} ${text}`,
    );
  }

  const body = (await res.json()) as { id: string };
  return { id: body.id };
}

// ============================================================================
// Helpers — PostgREST (org members)
// ============================================================================

/**
 * Query the OLD project's organization_members table (via PostgREST) to get
 * the set of user_ids that belong to the target org. Uses the service-role
 * key to bypass RLS (RLS on organization_members is org-scoped, but we need
 * to read ALL members of the target org regardless of who's calling).
 */
async function fetchOrgMemberUserIds(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  orgId: string;
}): Promise<Set<string>> {
  const url =
    `${args.supabaseUrl}/rest/v1/organization_members` +
    `?select=user_id&org_id=eq.${encodeURIComponent(args.orgId)}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: args.serviceRoleKey,
      Authorization: `Bearer ${args.serviceRoleKey}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `PostgREST GET /organization_members failed for org ${args.orgId}: ` +
        `${res.status} ${text}`,
    );
  }

  const rows = (await res.json()) as Array<{ user_id: string }>;
  return new Set(rows.map((r) => r.user_id));
}

// ============================================================================
// Helpers — magic-link (password recovery email)
// ============================================================================

/**
 * Trigger a magic-link / password-recovery email via the NEW project's Auth
 * API. The user clicks the link in the email to set up their NEW-project
 * access (since we created them without a password).
 *
 * Uses the anon key (not the service-role key) — /auth/v1/recover is a
 * public endpoint that only requires the anon key.
 */
async function sendMagicLink(args: {
  supabaseUrl: string;
  anonKey: string;
  email: string;
}): Promise<void> {
  const url = `${args.supabaseUrl}/auth/v1/recover`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: args.anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: args.email }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `/auth/v1/recover failed for ${args.email}: ${res.status} ${text}`,
    );
  }
}

// ============================================================================
// Helpers — map file persistence
// ============================================================================

/** Write the user-id map to disk as JSON. Creates the output dir if needed. */
function persistMap(
  mapFile: string,
  map: Record<string, string>,
  outputDir: string,
): void {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(mapFile, JSON.stringify(map, null, 2));
}

// ============================================================================
// Auto-run when invoked directly via `bun run scripts/migrate-auth-users.ts`.
// In vitest/Node, import.meta.main is undefined → no auto-run, so the test
// can import migrateAuthUsers without triggering main().
// ============================================================================

const __isMain =
  (import.meta as { main?: boolean }).main === true;

if (__isMain) {
  main().catch((err) => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
}

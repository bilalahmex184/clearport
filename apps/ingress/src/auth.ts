// ============================================================================
// apps/ingress/src/auth.ts — JWT verification + org-membership check
// ============================================================================
// Step 1 of the ingress flow. Every upload MUST pass through this before any
// file bytes are read, validated, or written.
//
// THE TWO CHECKS
//   1. JWT VERIFICATION — call Supabase auth.getUser with the caller's
//      Bearer token. Supabase's GoTrue server verifies the signature and
//      returns the user record. If invalid/expired/revoked → 401.
//   2. ORG MEMBERSHIP — read the `X-Org-Id` header from the request (the
//      caller's CLAIMED org). Query organization_members with the service-
//      role key (bypasses RLS so we can check membership for any org). If
//      no row → 403.
//
// WHY CHECK MEMBERSHIP SERVER-SIDE
//   The X-Org-Id header is caller-controlled — a malicious user could set
//   it to any org id. RLS on the documents table would catch a downstream
//   cross-org write, but the ingress Worker uses the service-role key
//   (which BYPASSES RLS) for the job RPC, Storage upload, and documents
//   insert. So the membership check here is the ONLY authz gate. Without
//   it, a user could upload to ANY org by setting X-Org-Id.
//
// WHY THE MEMBERSHIP QUERY USES THE SERVICE-ROLE KEY
//   If we used the caller's JWT, RLS on organization_members would only
//   show rows where the caller is already a member — which means the query
//   would return zero rows for a non-member org, which is what we want,
//   BUT it would also return zero rows on an RLS misconfiguration or a
//   token issue, blurring the 401 vs 403 distinction. The service-role
//   query is unambiguous: "does this row exist?".
//
// ERROR MODEL
//   verifyJwtAndMembership throws AuthError on any failure. The error
//   carries a `statusCode` (401 or 403) so the Worker can translate
//   directly to a Response without re-mapping. Unexpected infrastructure
//   errors (network down, Supabase 500) throw AuthError with 500.
// ============================================================================

import type { Env } from './env';
import type { ProjectConfig } from './project-config';
import { supabaseAuthGetUser, supabaseRest } from './supabase-client';

/**
 * Thrown by verifyJwtAndMembership on any auth/authz failure. The Worker's
 * top-level handler catches it and returns `new Response(body, { status:
 * e.statusCode })`.
 *
 * `statusCode` is one of:
 *   - 401 — missing/malformed/invalid JWT (unauthenticated).
 *   - 403 — JWT is valid but the caller is not a member of the claimed org.
 *   - 500 — unexpected infrastructure error during auth (network / DB down).
 */
export class AuthError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
    // Restore prototype chain after transpilation — required for
    // `instanceof AuthError` to work in bundled output.
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

/**
 * Result of a successful verifyJwtAndMembership call — the verified user id
 * and the claimed org id, both validated against the DB.
 */
export interface AuthContext {
  userId: string;
  orgId: string;
}

/**
 * Extract the Bearer token from the Authorization header. Returns null if
 * the header is missing or doesn't match `Bearer <token>`.
 */
function extractBearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization');
  if (!header) return null;
  // Case-insensitive prefix match on "Bearer".
  const match = header.match(/^\s*Bearer\s+(.+?)\s*$/i);
  return match ? match[1] : null;
}

/**
 * Verify the caller's JWT against Supabase auth.getUser AND confirm they're
 * a member of the org they're claiming via X-Org-Id.
 *
 * THROWS:
 *   - AuthError(401, "Missing Authorization header") — no Bearer token.
 *   - AuthError(401, "Invalid or expired token") — Supabase rejects JWT.
 *   - AuthError(400, "Missing X-Org-Id header") — caller didn't claim an org.
 *   - AuthError(400, "Invalid X-Org-Id header") — not a UUID.
 *   - AuthError(403, "User is not a member of organization") — no
 *     organization_members row for (org_id, user_id).
 *   - AuthError(500, "Auth service unavailable") — auth.getUser fetch threw.
 *   - AuthError(500, "Membership check failed") — REST query threw.
 *
 * @returns { userId, orgId } on success.
 */
export async function verifyJwtAndMembership(
  req: Request,
  env: Env,
): Promise<AuthContext> {
  // Phase 6: auth + membership always check against the OLD project (which
  // is authoritative for users + orgs during the transition). The project
  // selection (old vs new) for the actual upload happens AFTER this, via
  // resolveProject(env, orgId), in index.ts.
  const oldConfig: ProjectConfig = {
    supabaseUrl: env.OLD_SUPABASE_URL,
    supabaseAnonKey: env.OLD_SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: env.OLD_SUPABASE_SERVICE_ROLE_KEY,
    projectLabel: 'old',
  };

  // -----------------------------------------------------------------------
  // 1. Extract + verify the JWT.
  // -----------------------------------------------------------------------
  const jwt = extractBearerToken(req);
  if (!jwt) {
    throw new AuthError(401, 'Missing Authorization header');
  }

  let user;
  try {
    user = await supabaseAuthGetUser(oldConfig, jwt);
  } catch (err) {
    // Network / DNS / Supabase-down — surface as 500 (not 401). Don't
    // leak the error message to the client (may contain internal URLs).
    console.log('[auth] supabaseAuthGetUser threw:', err);
    throw new AuthError(500, 'Auth service unavailable');
  }
  if (!user) {
    throw new AuthError(401, 'Invalid or expired token');
  }

  // -----------------------------------------------------------------------
  // 2. Read + validate X-Org-Id.
  // -----------------------------------------------------------------------
  const orgId = req.headers.get('X-Org-Id');
  if (!orgId) {
    throw new AuthError(400, 'Missing X-Org-Id header');
  }

  // Validate org_id is a UUID before sending it to PostgREST — the
  // organization_members.org_id column is UUID, so a malformed value
  // would 400 from Postgres anyway, but we get a cleaner error path by
  // catching it here first. This also prevents a malicious caller from
  // probing the membership endpoint with arbitrary strings.
  const UUID_V4_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_V4_REGEX.test(orgId)) {
    throw new AuthError(400, 'Invalid X-Org-Id header');
  }

  // -----------------------------------------------------------------------
  // 3. Verify membership using the service-role key (bypasses RLS).
  // -----------------------------------------------------------------------
  // Query for a single row: organization_members where (org_id, user_id)
  // = (claimed org, JWT user). We only need to know existence, so `select=id`
  // + maybeSingle semantics via `limit=1`. The UNIQUE(org_id, user_id)
  // constraint guarantees at most one row.
  let res: Response;
  try {
    res = await supabaseRest(
      oldConfig,
      'organization_members',
      {
        method: 'GET',
        query: `select=id&org_id=eq.${encodeURIComponent(
          orgId,
        )}&user_id=eq.${encodeURIComponent(user.id)}&limit=1`,
      },
    );
  } catch (err) {
    console.log('[auth] membership query threw:', err);
    throw new AuthError(500, 'Membership check failed');
  }

  if (!res.ok) {
    // 4xx from PostgREST on this query is unexpected — the service-role
    // key should have full read access. Treat as 500.
    const text = await res.text().catch(() => '');
    console.log(
      `[auth] membership query HTTP ${res.status}: ${text}`,
    );
    throw new AuthError(500, 'Membership check failed');
  }

  const rows = (await res.json()) as Array<{ id: string }>;
  if (!Array.isArray(rows) || rows.length === 0) {
    // The caller's JWT is valid, but they're not a member of the claimed
    // org. This is the authz gate — without it, a user could upload to
    // any org by setting X-Org-Id (the service-role key bypasses RLS on
    // the downstream Storage + documents insert).
    throw new AuthError(403, 'User is not a member of organization');
  }

  return { userId: user.id, orgId };
}

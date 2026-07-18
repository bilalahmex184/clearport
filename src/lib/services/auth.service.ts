// ============================================================================
// ClearPort — Auth Service
// Wraps Supabase auth operations for use in route handlers / edge functions.
// The frontend (ClearPortContext) uses the singleton client from @/lib/supabase
// directly because it manages its own anonymous session; server-side code must
// instead build a per-request client bound to the user's JWT so RLS applies.
// ============================================================================

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { AppError } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';
import { type UserRole } from '@/lib/services/rbac.service';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Build a Supabase client scoped to the caller's JWT. RLS policies on every
 * table use `auth.uid()` so all queries issued through this client are
 * automatically restricted to the user's own rows.
 */
export function createUserClient(authHeader: string | null): SupabaseClient | null {
  if (!authHeader || !supabaseUrl || !supabaseAnonKey) return null;
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Resolve the authenticated user (if any) from the Authorization header.
 * Returns null for unauthenticated / invalid tokens.
 */
export async function getUser(req: Request): Promise<User | null> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;

  const client = createUserClient(authHeader);
  if (!client) return null;

  const {
    data: { user },
    error,
  } = await client.auth.getUser();

  if (error || !user) {
    if (error) {
      logger.warn('Auth: getUser failed', { error: error.message });
    }
    return null;
  }
  return user;
}

/**
 * Require an authenticated user. Throws AppError(401) when absent.
 */
export async function requireUser(req: Request): Promise<User> {
  const user = await getUser(req);
  if (!user) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
  return user;
}

/**
 * Build a Supabase client for a request that must be authenticated.
 */
export async function requireUserClient(
  req: Request,
): Promise<{ user: User; client: SupabaseClient }> {
  const user = await requireUser(req);
  const authHeader = req.headers.get('authorization');
  const client = createUserClient(authHeader);
  if (!client) {
    throw new AppError(
      'Supabase not configured',
      500,
      'SUPABASE_UNCONFIGURED',
    );
  }
  return { user, client };
}

/**
 * Best-effort user email for audit logging.
 *
 * In production (real auth), user.email is always present — the `anon-` fallback
 * only triggers for anonymous sessions (demo mode) or edge cases where the auth
 * provider didn't set an email. The fallback makes it clear in audit logs that
 * the actor was anonymous, not a real named user.
 */
export function getUserEmail(user: User): string {
  if (user.email) return user.email;
  const shortId = user.id.slice(0, 8);
  return `anon-${shortId}@clearport.local`;
}

// ============================================================================
// ORG-SCOPED RBAC
// ============================================================================

/**
 * Resolve the org_id for the current request.
 * Reads from the `X-Org-Id` header. If not provided, uses the user's first org.
 * Returns null if the user has no org memberships.
 */
export async function getOrgId(req: Request, client: SupabaseClient, user: User): Promise<string | null> {
  // Check X-Org-Id header first
  const headerOrgId = req.headers.get('x-org-id');
  if (headerOrgId) {
    // Validate that the user is a member of this org
    const { data } = await client
      .from('organization_members')
      .select('org_id')
      .eq('org_id', headerOrgId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (data) return headerOrgId;

    // User tried to access an org they're not a member of
    throw new AppError('Forbidden: not a member of this organization', 403, 'FORBIDDEN_ORG');
  }

  // No header — use the user's first org
  const { data } = await client
    .from('organization_members')
    .select('org_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  return data?.org_id || null;
}

/**
 * Get the user's role in the current org context.
 * Queries organization_members (not a hardcoded default).
 */
export async function getUserRole(client: SupabaseClient, user: User, orgId: string): Promise<UserRole | null> {
  const { data } = await client
    .from('organization_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle();

  return (data?.role as UserRole) || null;
}

/**
 * Require the user to be a member of an org with at least the specified role.
 * Returns { user, client, orgId, role } for the route handler.
 *
 * Role hierarchy: admin > operator > viewer
 * - viewer can view + export
 * - operator can also upload + edit + resolve
 * - admin can also manage rules + users + delete
 */
export async function requireOrgRole(
  req: Request,
  minRole: 'viewer' | 'operator' | 'admin',
): Promise<{ user: User; client: SupabaseClient; orgId: string; role: UserRole }> {
  const { user, client } = await requireUserClient(req);

  const orgId = await getOrgId(req, client, user);
  if (!orgId) {
    throw new AppError('No organization membership found. Please contact your administrator.', 403, 'NO_ORG_MEMBERSHIP');
  }

  const role = await getUserRole(client, user, orgId);
  if (!role) {
    throw new AppError('Forbidden: not a member of this organization', 403, 'FORBIDDEN_ORG');
  }

  // Check role hierarchy
  const roleLevel: Record<UserRole, number> = { viewer: 1, operator: 2, admin: 3 };
  if (roleLevel[role] < roleLevel[minRole]) {
    throw new AppError(`Forbidden: requires ${minRole} role or higher`, 403, 'INSUFFICIENT_ROLE');
  }

  return { user, client, orgId, role };
}

/**
 * Get all organizations the user belongs to (for org-switcher UI).
 */
export async function getUserOrgs(client: SupabaseClient, user: User): Promise<Array<{ org_id: string; org_name: string; role: UserRole }>> {
  const { data, error } = await client
    .from('organization_members')
    .select('org_id, role, organizations(id, name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  if (error || !data) return [];

  return data.map((row: any) => ({
    org_id: row.org_id,
    org_name: row.organizations?.name || 'Unknown',
    role: row.role as UserRole,
  }));
}

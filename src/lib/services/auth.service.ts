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
import { getDefaultRole, type UserRole } from '@/lib/services/rbac.service';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Build a Supabase client scoped to the caller's JWT. RLS policies on every
 * table use `auth.uid()` so all queries issued through this client are
 * automatically restricted to the user's own rows.
 *
 * Returns null if no Authorization header is present (caller decides whether
 * that's an error — see requireUser).
 */
export function createUserClient(authHeader: string | null): SupabaseClient | null {
  if (!authHeader || !supabaseUrl || !supabaseAnonKey) return null;
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Resolve the authenticated user (if any) from the Authorization header on
 * an incoming Request. Returns null for unauthenticated / invalid tokens
 * rather than throwing, so callers can layer on requireUser() when needed.
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
 * Require an authenticated user. Throws AppError(401) when absent so route
 * handlers can let the error propagate to errorResponse().
 */
export async function requireUser(req: Request): Promise<User> {
  const user = await getUser(req);
  if (!user) {
    throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  }
  return user;
}

/**
 * Build a Supabase client for a request that must be authenticated. Returns
 * both the user and the user-scoped client so the caller doesn't need to
 * re-parse the Authorization header.
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
 * Best-effort user email for audit logging. Anonymous users don't have an
 * email attached, so synthesize a stable identifier from their UUID.
 */
export function getUserEmail(user: User): string {
  if (user.email) return user.email;
  const shortId = user.id.slice(0, 8);
  return `anon-${shortId}@clearport.local`;
}

/**
 * Resolve the user's RBAC role.
 *
 * In production this would query a `user_roles` table (e.g.
 * `SELECT role FROM user_roles WHERE user_id = auth.uid()`) or read a custom
 * claim from the JWT set by an external IdP (Supabase custom claims, Auth0,
 * Okta). For now, anonymous users get the 'operator' role by default so the
 * no-login UX is preserved while the RBAC framework is in place.
 *
 * The `user` parameter is accepted (not used today) so callers don't have to
 * change their signatures once we wire up real role lookup.
 */
export function getUserRole(_user: User): UserRole {
  // TODO(production): query user_roles table or read from user.app_metadata.role
  return getDefaultRole();
}

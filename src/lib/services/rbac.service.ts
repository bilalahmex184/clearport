// ============================================================================
// ClearPort — Role-Based Access Control (RBAC) Service
// ============================================================================
//
// Three roles with descending scope:
//   - admin     : full power — upload, edit, resolve, export, manage_rules,
//                 manage_users, and delete
//   - operator  : day-to-day broker work — upload, edit, resolve, export
//                 (cannot manage rules, users, or delete shipments)
//   - viewer    : read-only + export — for auditors / external reviewers
//
// Anonymous users are mapped to `operator` by default (see getDefaultRole)
// so the no-login UX continues to work. In production, role assignment would
// come from a `user_roles` table or JWT claim set by an IdP (Okta, Auth0,
// Supabase custom claims). The lookup happens in
// `auth.service.ts#getUserRole`.
// ============================================================================

export type UserRole = 'admin' | 'operator' | 'viewer';

export const PERMISSIONS = {
  admin: ['upload', 'edit', 'resolve', 'export', 'manage_rules', 'manage_users', 'delete'],
  operator: ['upload', 'edit', 'resolve', 'export'],
  viewer: ['view', 'export'],
} as const;

/**
 * Union of every permission granted by any role. We can't just use
 * `typeof PERMISSIONS.admin[number]` because the viewer role grants 'view',
 * which isn't in the admin set — without including it here, canView(role,
 * 'view') would fail to type-check.
 */
export type Permission =
  | typeof PERMISSIONS.admin[number]
  | typeof PERMISSIONS.operator[number]
  | typeof PERMISSIONS.viewer[number];

/**
 * Core permission check — returns true if the given role grants the requested
 * permission. Used by every `can*` helper below and by route handlers.
 */
export function hasPermission(role: UserRole, permission: Permission): boolean {
  // The viewer role uses 'view' (not in the admin union) — include it via a
  // cast so TS doesn't narrow `permission` to only the admin set.
  const granted = PERMISSIONS[role] as readonly string[];
  return granted.includes(permission);
}

// ---------------------------------------------------------------------------
// Convenience helpers — keep route handlers / components self-documenting.
// ---------------------------------------------------------------------------

export function canUpload(role: UserRole): boolean {
  return hasPermission(role, 'upload');
}

export function canEdit(role: UserRole): boolean {
  return hasPermission(role, 'edit');
}

export function canResolve(role: UserRole): boolean {
  return hasPermission(role, 'resolve');
}

export function canExport(role: UserRole): boolean {
  return hasPermission(role, 'export');
}

export function canManageRules(role: UserRole): boolean {
  return hasPermission(role, 'manage_rules');
}

export function canManageUsers(role: UserRole): boolean {
  return hasPermission(role, 'manage_users');
}

export function canDelete(role: UserRole): boolean {
  return hasPermission(role, 'delete');
}

/**
 * Returns true if the role can at least view shipment data. All three roles
 * satisfy this — the helper exists so component code reads naturally.
 */
export function canView(role: UserRole): boolean {
  // admin + operator implicitly view (their permission sets cover all
  // shipment interactions); viewer has the explicit 'view' permission.
  return role === 'admin' || role === 'operator' || hasPermission(role, 'view');
}

/**
 * Returns true if the role is the admin role. Used by routes that need to
 * hard-restrict destructive operations (e.g. DELETE /api/shipments/[id]).
 */
export function isAdmin(role: UserRole): boolean {
  return role === 'admin';
}

/**
 * For now, anonymous users get the 'operator' role by default. This preserves
 * the current no-login UX (they can upload / edit / resolve / export) while
 * blocking manage_rules, manage_users, and delete.
 *
 * In production, this would be looked up from a `user_roles` table keyed by
 * the Supabase auth.uid() or from a JWT custom claim set by an external IdP.
 */
export function getDefaultRole(): UserRole {
  return 'operator';
}

/**
 * Human-readable label for display in the UI.
 */
export function roleLabel(role: UserRole): string {
  switch (role) {
    case 'admin':
      return 'Administrator';
    case 'operator':
      return 'Customs Broker';
    case 'viewer':
      return 'Auditor (View Only)';
    default:
      return role;
  }
}

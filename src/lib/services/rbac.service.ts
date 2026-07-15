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
// Role lookup is now REAL — it queries organization_members for the user's
// role in the current org context (see auth.service.ts#getUserRole).
// There is no more getDefaultRole() silent fallback.
// ============================================================================

export type UserRole = 'admin' | 'operator' | 'viewer';

export const PERMISSIONS = {
  admin: ['upload', 'edit', 'resolve', 'export', 'manage_rules', 'manage_users', 'delete'],
  operator: ['upload', 'edit', 'resolve', 'export'],
  viewer: ['view', 'export'],
} as const;

export type Permission =
  | typeof PERMISSIONS.admin[number]
  | typeof PERMISSIONS.operator[number]
  | typeof PERMISSIONS.viewer[number];

export function hasPermission(role: UserRole, permission: Permission): boolean {
  const granted = PERMISSIONS[role] as readonly string[];
  return granted.includes(permission);
}

// ---------------------------------------------------------------------------
// Convenience helpers
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

export function canView(role: UserRole): boolean {
  return role === 'admin' || role === 'operator' || hasPermission(role, 'view');
}

export function isAdmin(role: UserRole): boolean {
  return role === 'admin';
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

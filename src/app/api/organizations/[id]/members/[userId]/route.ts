// ============================================================================
// /api/organizations/[id]/members/[userId] — change role + remove member
// ============================================================================
//
// PATCH  /api/organizations/[id]/members/[userId]  { role: 'admin' | 'operator' | 'viewer' }
//   → { member }   (admin only)
//
// DELETE /api/organizations/[id]/members/[userId]
//   → { success: true }   (admin only)
//
// Notes:
//   - Admins cannot remove themselves if they are the last admin (would orphan
//     the org). We check the admin count before allowing self-removal.
//   - The acting admin can demote themselves, but if that leaves zero admins,
//     the request is rejected with 409.
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUserClient, getUserRole, getUserEmail } from '@/lib/services/auth.service';
import { errorResponse, AppError } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';

type Role = 'admin' | 'operator' | 'viewer';

const changeRoleSchema = z.object({
  role: z.enum(['admin', 'operator', 'viewer']),
});

/**
 * Count the number of admins in an org. Used to prevent the last-admin
 * self-removal / self-demotion edge case.
 */
async function countAdmins(
  client: import('@supabase/supabase-js').SupabaseClient,
  orgId: string,
): Promise<number> {
  const { count, error } = await client
    .from('organization_members')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('role', 'admin');
  if (error) {
    throw new AppError(
      `Failed to count admins: ${error.message}`,
      500,
      'DB_ERROR',
      { action: 'count admins', dbError: error.message },
    );
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// PATCH — change a member's role (admin only)
// ---------------------------------------------------------------------------

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const { user, client } = await requireUserClient(req);
    const { id: orgId, userId: targetUserId } = await params;

    const actingRole = await getUserRole(client, user, orgId);
    if (!actingRole) {
      throw new AppError(
        'Forbidden: not a member of this organization',
        403,
        'FORBIDDEN_ORG',
      );
    }
    if (actingRole !== 'admin') {
      throw new AppError(
        'Forbidden: admin role required to manage members',
        403,
        'INSUFFICIENT_ROLE',
      );
    }

    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const parsed = changeRoleSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 422 },
      );
    }

    const newRole: Role = parsed.data.role;

    // Guard: don't let the last admin demote themselves.
    if (
      actingRole === 'admin' &&
      user.id === targetUserId &&
      newRole !== 'admin'
    ) {
      const adminCount = await countAdmins(client, orgId);
      if (adminCount <= 1) {
        throw new AppError(
          'Cannot demote the last admin. Promote another member first.',
          409,
          'LAST_ADMIN',
          { orgId, targetUserId },
        );
      }
    }

    const { data: updated, error } = await client
      .from('organization_members')
      .update({ role: newRole })
      .eq('org_id', orgId)
      .eq('user_id', targetUserId)
      .select()
      .maybeSingle();

    if (error) {
      throw new AppError(
        `Failed to update member role: ${error.message}`,
        500,
        'DB_ERROR',
        { action: 'update member role', dbError: error.message },
      );
    }
    if (!updated) {
      throw new AppError('Member not found in this organization', 404, 'NOT_FOUND', {
        orgId,
        targetUserId,
      });
    }

    logger.info('Member role updated', {
      orgId,
      targetUserId,
      newRole,
      by: getUserEmail(user),
    });

    return NextResponse.json({ member: updated });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE — remove a member (admin only)
// ---------------------------------------------------------------------------

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const { user, client } = await requireUserClient(req);
    const { id: orgId, userId: targetUserId } = await params;

    const actingRole = await getUserRole(client, user, orgId);
    if (!actingRole) {
      throw new AppError(
        'Forbidden: not a member of this organization',
        403,
        'FORBIDDEN_ORG',
      );
    }
    if (actingRole !== 'admin') {
      throw new AppError(
        'Forbidden: admin role required to remove members',
        403,
        'INSUFFICIENT_ROLE',
      );
    }

    // Guard: don't let the last admin remove themselves.
    if (user.id === targetUserId) {
      const adminCount = await countAdmins(client, orgId);
      if (adminCount <= 1) {
        throw new AppError(
          'Cannot remove the last admin. Promote another member first.',
          409,
          'LAST_ADMIN',
          { orgId, targetUserId },
        );
      }
    }

    const { error, count } = await client
      .from('organization_members')
      .delete({ count: 'exact' })
      .eq('org_id', orgId)
      .eq('user_id', targetUserId);

    if (error) {
      throw new AppError(
        `Failed to remove member: ${error.message}`,
        500,
        'DB_ERROR',
        { action: 'remove member', dbError: error.message },
      );
    }
    if (!count || count === 0) {
      throw new AppError('Member not found in this organization', 404, 'NOT_FOUND', {
        orgId,
        targetUserId,
      });
    }

    logger.info('Member removed from organization', {
      orgId,
      targetUserId,
      by: getUserEmail(user),
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return errorResponse(err);
  }
}

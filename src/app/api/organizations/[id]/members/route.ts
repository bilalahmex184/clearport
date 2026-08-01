// ============================================================================
// /api/organizations/[id]/members — list + add members
// ============================================================================
//
// GET  /api/organizations/[id]/members
//   → { members: Array<{ user_id, role, created_at, email? }> }
//
// POST /api/organizations/[id]/members  { userId: string, role: 'admin' | 'operator' | 'viewer' }
//   → { member: { org_id, user_id, role, created_at } }   (admin only)
//
// Access: GET requires membership (any role). POST requires admin role.
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUserClient, getUserRole, getUserEmail } from '@/lib/services/auth.service';
import { errorResponse, AppError } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';

// ---------------------------------------------------------------------------
// GET — list members of an org
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, client } = await requireUserClient(req);
    const { id } = await params;

    // Verify membership (any role). RLS `member_read_members` would also
    // enforce this, but we surface a clearer 403 here.
    const role = await getUserRole(client, user, id);
    if (!role) {
      throw new AppError(
        'Forbidden: not a member of this organization',
        403,
        'FORBIDDEN_ORG',
      );
    }

    const { data, error } = await client
      .from('organization_members')
      .select('user_id, role, created_at, invited_by')
      .eq('org_id', id)
      .order('created_at', { ascending: true });

    if (error) {
      throw new AppError(
        `Failed to fetch members: ${error.message}`,
        500,
        'DB_ERROR',
        { action: 'fetch members', dbError: error.message },
      );
    }

    // We don't have direct access to auth.users.email via RLS, so we return
    // what we have. The frontend can display user_id (truncated) or look up
    // emails via a separate admin endpoint if needed.
    const members = (data || []).map((row: any) => ({
      user_id: row.user_id,
      role: row.role,
      created_at: row.created_at,
      invited_by: row.invited_by,
    }));

    return NextResponse.json({ members, currentUserRole: role });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST — add a member (admin only)
// ---------------------------------------------------------------------------

const addMemberSchema = z.object({
  userId: z.string().uuid('userId must be a valid UUID'),
  role: z.enum(['admin', 'operator', 'viewer']).default('viewer'),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, client } = await requireUserClient(req);
    const { id } = await params;

    const role = await getUserRole(client, user, id);
    if (!role) {
      throw new AppError(
        'Forbidden: not a member of this organization',
        403,
        'FORBIDDEN_ORG',
      );
    }
    if (role !== 'admin') {
      throw new AppError(
        'Forbidden: admin role required to add members',
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

    const parsed = addMemberSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 422 },
      );
    }

    const { data: member, error } = await client
      .from('organization_members')
      .insert({
        org_id: id,
        user_id: parsed.data.userId,
        role: parsed.data.role,
        invited_by: user.id,
      })
      .select()
      .single();

    if (error) {
      // 23505 = unique_violation (org_id, user_id) — user is already a member
      if (error.code === '23505') {
        throw new AppError(
          'User is already a member of this organization',
          409,
          'ALREADY_MEMBER',
          { orgId: id, userId: parsed.data.userId },
        );
      }
      throw new AppError(
        `Failed to add member: ${error.message}`,
        500,
        'DB_ERROR',
        { action: 'add member', dbError: error.message },
      );
    }

    logger.info('Member added to organization', {
      orgId: id,
      newMemberId: parsed.data.userId,
      newMemberRole: parsed.data.role,
      addedBy: getUserEmail(user),
    });

    return NextResponse.json({ member }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

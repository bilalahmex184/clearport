// ============================================================================
// /api/invites/accept — accept an org invite by token
// ============================================================================
//
// POST /api/invites/accept { token }
//   Requires the user to be logged in. Validates the invite (not expired,
//   not accepted, email matches the logged-in user's email), then calls
//   the accept_invite SECURITY DEFINER RPC to insert the membership at
//   the invite's role.
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUserClient, getUserEmail } from '@/lib/services/auth.service';
import { errorResponse, AppError } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';

const acceptSchema = z.object({
  token: z.string().uuid(),
});

export async function POST(req: Request) {
  try {
    const { user, client } = await requireUserClient(req);

    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    const parsed = acceptSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid token' }, { status: 422 });

    // Call the SECURITY DEFINER RPC — this is the ONLY path that can grant
    // operator/admin via self-action, because it's server-validated against
    // a real invite record, not a raw client insert.
    const { data: rpcResult, error: rpcError } = await client
      .rpc('accept_invite', {
        p_token: parsed.data.token,
        p_user_id: user.id,
      });

    if (rpcError) {
      const msg = rpcError.message || 'Unknown error';
      if (msg.includes('Invalid or expired')) {
        throw new AppError('Invalid or expired invite token', 400, 'INVITE_INVALID');
      }
      if (msg.includes('email does not match')) {
        throw new AppError('This invite was sent to a different email address. Please sign in with the email that received the invite.', 403, 'EMAIL_MISMATCH');
      }
      throw new AppError(`Failed to accept invite: ${msg}`, 500, 'INVITE_ERROR');
    }

    if (!rpcResult || rpcResult.length === 0) {
      throw new AppError('Invite acceptance returned no result', 500, 'INVITE_ERROR');
    }

    const result = rpcResult[0];

    // Audit log
    await client.from('audit_logs').insert({
      org_id: result.org_id,
      user_id: user.id,
      text: `[invite] User ${getUserEmail(user)} accepted invite and joined as ${result.role}`,
      type: 'success',
    }).catch(() => {});

    logger.info('Invite accepted', { orgId: result.org_id, userId: user.id, role: result.role });

    return NextResponse.json({
      success: true,
      orgId: result.org_id,
      orgName: result.org_name,
      role: result.role,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

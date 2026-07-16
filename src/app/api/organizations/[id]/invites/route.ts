// ============================================================================
// /api/organizations/[id]/invites — create + list invites (admin only)
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import { errorResponse, AppError } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'operator', 'viewer']),
});

// GET — list pending invites for the org (admin only)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { client, orgId } = await requireOrgRole(req, 'admin');

    if (id !== orgId) throw new AppError('Forbidden', 403, 'FORBIDDEN');

    const { data, error } = await client
      .from('org_invites')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });

    if (error) throw new AppError('Failed to fetch invites', 500, 'DB_ERROR', error.message);
    return NextResponse.json({ invites: data || [] });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST — create a new invite (admin only)
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, client, orgId } = await requireOrgRole(req, 'admin');

    if (id !== orgId) throw new AppError('Forbidden', 403, 'FORBIDDEN');

    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    const parsed = inviteSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });

    // Create the invite
    const { data, error } = await client
      .from('org_invites')
      .insert({
        org_id: orgId,
        email: parsed.data.email.toLowerCase(),
        role: parsed.data.role,
        invited_by: user.id,
      })
      .select()
      .single();

    if (error) throw new AppError('Failed to create invite', 500, 'DB_ERROR', error.message);

    // Audit log (fire-and-forget, don't block on errors)
    try {
      await client.from('audit_logs').insert({
        org_id: orgId,
        user_id: user.id,
        text: `[invite] User ${getUserEmail(user)} invited ${parsed.data.email} as ${parsed.data.role}`,
        type: 'info',
      });
    } catch {}

    logger.info('Invite created', { inviteId: data.id, orgId, email: parsed.data.email, role: parsed.data.role });

    // Build the invite URL
    const appUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace('.supabase.co', '') || 'http://localhost:3000';
    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/accept-invite?token=${data.token}`;

    return NextResponse.json({
      invite: data,
      inviteUrl,
      message: `Invite sent to ${parsed.data.email}. They will receive an email with a link to join.`,
    }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

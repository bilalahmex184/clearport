// ============================================================================
// /api/organizations — list user's orgs + create a new org
// ============================================================================
//
// GET  /api/organizations
//   → { organizations: Array<{ org_id, org_name, role }> }
//
// POST /api/organizations  { name: string }
//   → { organization: { id, name, created_at }, role: 'admin' }
//   The creator is automatically added as an admin member.
//
// NOTE: These routes use requireUser() (NOT requireOrgRole) because a brand-new
// user may not yet belong to any org — listing/creating orgs is the bootstrap
// path. Once the user has at least one membership, downstream routes can use
// requireOrgRole() with the X-Org-Id header.
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireUserClient,
  getUserOrgs,
  getUserEmail,
} from '@/lib/services/auth.service';
import { errorResponse, AppError } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';

// ---------------------------------------------------------------------------
// GET — list all orgs the current user belongs to
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const { user, client } = await requireUserClient(req);
    const organizations = await getUserOrgs(client, user);
    return NextResponse.json({ organizations });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST — create a new org via SECURITY DEFINER function (bypasses RLS chicken-and-egg)
// ---------------------------------------------------------------------------

const createOrgSchema = z.object({
  name: z.string().min(1, 'Organization name is required').max(200),
});

export async function POST(req: Request) {
  try {
    const { user, client } = await requireUserClient(req);

    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const parsed = createOrgSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 422 },
      );
    }

    // Use the SECURITY DEFINER function to create org + add creator as admin
    // This bypasses the RLS chicken-and-egg problem
    const { data: rpcResult, error: rpcErr } = await client
      .rpc('create_organization', {
        p_org_name: parsed.data.name,
        p_creator_uid: user.id,
      });

    if (rpcErr || !rpcResult || rpcResult.length === 0) {
      const msg = rpcErr?.message ?? 'Unknown error';
      throw new AppError(
        `Failed to create organization: ${msg}`,
        500,
        'DB_ERROR',
        { action: 'create organization', dbError: msg },
      );
    }

    const org = rpcResult[0];

    logger.info('Organization created', {
      orgId: org.org_id,
      orgName: org.org_name,
      createdBy: getUserEmail(user),
    });

    return NextResponse.json(
      { organization: { id: org.org_id, name: org.org_name }, role: 'admin' as const },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

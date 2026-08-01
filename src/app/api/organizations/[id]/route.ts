// ============================================================================
// /api/organizations/[id] — single-org CRUD
// ============================================================================
//
// GET    /api/organizations/[id]                → { organization, role }
// PATCH  /api/organizations/[id] { name }       → { organization }   (admin)
// DELETE /api/organizations/[id]                → { success: true }  (admin)
//
// Access: GET requires membership (any role). PATCH/DELETE require admin role
// in the org. Org context is resolved from the path param `[id]` (NOT the
// X-Org-Id header) so the caller can manage any org they admin without
// first switching the global org context.
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUserClient, getUserRole, getUserEmail } from '@/lib/services/auth.service';
import { errorResponse, AppError } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';
import type { UserRole } from '@/lib/services/rbac.service';

// ---------------------------------------------------------------------------
// GET — org details + the caller's role in this org
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, client } = await requireUserClient(req);
    const { id } = await params;

    // Fetch the org row (RLS `org_member_read` ensures we only see orgs
    // we're a member of — so a 404 here means either it doesn't exist or
    // the user isn't a member; both should produce the same response).
    const { data: org, error } = await client
      .from('organizations')
      .select('id, name, created_at')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      throw new AppError(
        `Failed to fetch organization: ${error.message}`,
        500,
        'DB_ERROR',
        { action: 'fetch organization', dbError: error.message },
      );
    }
    if (!org) {
      throw new AppError('Organization not found', 404, 'NOT_FOUND', { id });
    }

    const role = await getUserRole(client, user, id);
    if (!role) {
      // Should be unreachable (RLS would have hidden the org), but guard anyway.
      throw new AppError(
        'Forbidden: not a member of this organization',
        403,
        'FORBIDDEN_ORG',
      );
    }

    return NextResponse.json({ organization: org, role });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH — rename the org (admin only)
// ---------------------------------------------------------------------------

const updateOrgSchema = z.object({
  name: z.string().min(1, 'Name cannot be empty').max(200),
});

export async function PATCH(
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
        'Forbidden: admin role required to update organization',
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

    const parsed = updateOrgSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 422 },
      );
    }

    const { data: updated, error } = await client
      .from('organizations')
      .update({ name: parsed.data.name })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) {
      throw new AppError(
        `Failed to update organization: ${error.message}`,
        500,
        'DB_ERROR',
        { action: 'update organization', dbError: error.message },
      );
    }
    if (!updated) {
      throw new AppError('Organization not found', 404, 'NOT_FOUND', { id });
    }

    logger.info('Organization updated', {
      orgId: id,
      newName: parsed.data.name,
      by: getUserEmail(user),
    });

    return NextResponse.json({ organization: updated });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE — permanently remove the org + cascade-delete all org-scoped rows
// (FK ON DELETE CASCADE on organization_members + shipments + documents + ...)
// ---------------------------------------------------------------------------

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, client } = await requireUserClient(req);
    const { id } = await params;

    const role: UserRole | null = await getUserRole(client, user, id);
    if (!role) {
      throw new AppError(
        'Forbidden: not a member of this organization',
        403,
        'FORBIDDEN_ORG',
      );
    }
    if (role !== 'admin') {
      throw new AppError(
        'Forbidden: admin role required to delete organization',
        403,
        'INSUFFICIENT_ROLE',
      );
    }

    const { error } = await client
      .from('organizations')
      .delete()
      .eq('id', id);

    if (error) {
      throw new AppError(
        `Failed to delete organization: ${error.message}`,
        500,
        'DB_ERROR',
        { action: 'delete organization', dbError: error.message },
      );
    }

    logger.info('Organization deleted', {
      orgId: id,
      by: getUserEmail(user),
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return errorResponse(err);
  }
}

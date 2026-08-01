// ============================================================================
// /api/broker-templates/[id] — get/update/delete a single template
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import { errorResponse, AppError } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  delimiter: z.string().optional(),
  encoding: z.string().optional(),
  is_active: z.boolean().optional(),
});

// GET — get a single template with its mappings
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { client, orgId } = await requireOrgRole(req, 'viewer');

    const { data: template, error: tErr } = await client
      .from('broker_templates')
      .select('*')
      .eq('id', id)
      .eq('org_id', orgId)
      .single();
    if (tErr) throw new AppError('Template not found', 404, 'NOT_FOUND');

    const { data: mappings, error: mErr } = await client
      .from('broker_field_mappings')
      .select('*')
      .eq('template_id', id)
      .order('sort_order', { ascending: true });
    if (mErr) throw new AppError('Failed to fetch mappings', 500, 'DB_ERROR', mErr.message);

    return NextResponse.json({ template, mappings: mappings || [] });
  } catch (err) {
    return errorResponse(err);
  }
}

// PATCH — update a template (admin/operator only)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, client, orgId } = await requireOrgRole(req, 'operator');
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    const parsed = updateTemplateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });

    const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
    if (parsed.data.delimiter !== undefined) updateData.delimiter = parsed.data.delimiter;
    if (parsed.data.encoding !== undefined) updateData.encoding = parsed.data.encoding;
    if (parsed.data.is_active !== undefined) updateData.is_active = parsed.data.is_active;

    const { data, error } = await client
      .from('broker_templates')
      .update(updateData)
      .eq('id', id)
      .eq('org_id', orgId)
      .select()
      .single();
    if (error) throw new AppError('Failed to update template', 500, 'DB_ERROR', error.message);

    logger.info('Broker template updated', { templateId: id, orgId, user: getUserEmail(user) });
    return NextResponse.json({ template: data });
  } catch (err) {
    return errorResponse(err);
  }
}

// DELETE — delete a template (admin only)
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, client, orgId } = await requireOrgRole(req, 'admin');
    const { error } = await client
      .from('broker_templates')
      .delete()
      .eq('id', id)
      .eq('org_id', orgId);
    if (error) throw new AppError('Failed to delete template', 500, 'DB_ERROR', error.message);

    logger.info('Broker template deleted', { templateId: id, orgId, user: getUserEmail(user) });
    return NextResponse.json({ success: true });
  } catch (err) {
    return errorResponse(err);
  }
}

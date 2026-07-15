// ============================================================================
// /api/broker-templates/[id]/mappings — CRUD for field mappings
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import { errorResponse, AppError } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';

const mappingSchema = z.object({
  internal_field_key: z.string().min(1),
  external_field_name: z.string().min(1),
  transform: z.record(z.any()).default({}),
  is_required: z.boolean().default(false),
  sort_order: z.number().int().default(0),
});

// GET — list mappings for a template
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { client, orgId } = await requireOrgRole(req, 'viewer');

    // Verify template belongs to org
    const { data: template } = await client
      .from('broker_templates')
      .select('id')
      .eq('id', id)
      .eq('org_id', orgId)
      .single();
    if (!template) throw new AppError('Template not found', 404, 'NOT_FOUND');

    const { data, error } = await client
      .from('broker_field_mappings')
      .select('*')
      .eq('template_id', id)
      .order('sort_order', { ascending: true });
    if (error) throw new AppError('Failed to fetch mappings', 500, 'DB_ERROR', error.message);

    return NextResponse.json({ mappings: data || [] });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST — add a mapping to a template
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, client, orgId } = await requireOrgRole(req, 'operator');

    // Verify template belongs to org
    const { data: template } = await client
      .from('broker_templates')
      .select('id')
      .eq('id', id)
      .eq('org_id', orgId)
      .single();
    if (!template) throw new AppError('Template not found', 404, 'NOT_FOUND');

    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    const parsed = mappingSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });

    const { data, error } = await client
      .from('broker_field_mappings')
      .insert({
        template_id: id,
        internal_field_key: parsed.data.internal_field_key,
        external_field_name: parsed.data.external_field_name,
        transform: parsed.data.transform,
        is_required: parsed.data.is_required,
        sort_order: parsed.data.sort_order,
      })
      .select()
      .single();
    if (error) throw new AppError('Failed to create mapping', 500, 'DB_ERROR', error.message);

    logger.info('Broker mapping created', { templateId: id, mappingId: data.id, user: getUserEmail(user) });
    return NextResponse.json({ mapping: data }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT — bulk replace all mappings for a template
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, client, orgId } = await requireOrgRole(req, 'operator');

    // Verify template belongs to org
    const { data: template } = await client
      .from('broker_templates')
      .select('id')
      .eq('id', id)
      .eq('org_id', orgId)
      .single();
    if (!template) throw new AppError('Template not found', 404, 'NOT_FOUND');

    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.mappings)) {
      return NextResponse.json({ error: 'Expected { mappings: [...] }' }, { status: 400 });
    }

    // Delete existing mappings
    await client.from('broker_field_mappings').delete().eq('template_id', id);

    // Insert new mappings
    if (body.mappings.length > 0) {
      const rows = body.mappings.map((m: any, idx: number) => ({
        template_id: id,
        internal_field_key: m.internal_field_key,
        external_field_name: m.external_field_name,
        transform: m.transform || {},
        is_required: m.is_required || false,
        sort_order: m.sort_order ?? idx,
      }));
      const { error } = await client.from('broker_field_mappings').insert(rows);
      if (error) throw new AppError('Failed to replace mappings', 500, 'DB_ERROR', error.message);
    }

    logger.info('Broker mappings replaced', { templateId: id, count: body.mappings.length, user: getUserEmail(user) });
    return NextResponse.json({ success: true, count: body.mappings.length });
  } catch (err) {
    return errorResponse(err);
  }
}

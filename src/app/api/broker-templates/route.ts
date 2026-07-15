// ============================================================================
// /api/broker-templates — CRUD for broker templates
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import { errorResponse, AppError } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';

const templateSchema = z.object({
  name: z.string().min(1).max(200),
  direction: z.enum(['import', 'export']),
  delimiter: z.string().default(','),
  encoding: z.string().default('utf-8'),
});

// GET — list templates for the org
export async function GET(req: Request) {
  try {
    const { client, orgId } = await requireOrgRole(req, 'viewer');
    const { data, error } = await client
      .from('broker_templates')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true });
    if (error) throw new AppError('Failed to fetch templates', 500, 'DB_ERROR', error.message);
    return NextResponse.json({ templates: data || [] });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST — create a new template (admin/operator only)
export async function POST(req: Request) {
  try {
    const { user, client, orgId } = await requireOrgRole(req, 'operator');
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    const parsed = templateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });

    const { data, error } = await client
      .from('broker_templates')
      .insert({
        org_id: orgId,
        name: parsed.data.name,
        direction: parsed.data.direction,
        delimiter: parsed.data.delimiter,
        encoding: parsed.data.encoding,
      })
      .select()
      .single();
    if (error) throw new AppError('Failed to create template', 500, 'DB_ERROR', error.message);

    logger.info('Broker template created', { templateId: data.id, orgId, user: getUserEmail(user) });
    return NextResponse.json({ template: data }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

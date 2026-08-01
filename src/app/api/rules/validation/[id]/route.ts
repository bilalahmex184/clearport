// ============================================================================
// /api/rules/validation/[id] — update/delete a single validation rule
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import { logRulesUpdate } from '@/lib/services/audit-log.service';
import { errorResponse, AppError } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';

const updateRuleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  field_key: z.string().nullable().optional(),
  rule_type: z.enum(['confidence_threshold', 'math_check', 'cross_doc_match', 'required_field', 'regex_format']).optional(),
  config: z.record(z.string(), z.any()).optional(),
  severity: z.enum(['block', 'flag', 'warn']).optional(),
  is_active: z.boolean().optional(),
});

// PATCH — update a rule (admin only)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, client, orgId } = await requireOrgRole(req, 'admin');

    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    const parsed = updateRuleSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });

    const updateData: Record<string, any> = { updated_at: new Date().toISOString() };
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
    if (parsed.data.field_key !== undefined) updateData.field_key = parsed.data.field_key;
    if (parsed.data.rule_type !== undefined) updateData.rule_type = parsed.data.rule_type;
    if (parsed.data.config !== undefined) updateData.config = parsed.data.config;
    if (parsed.data.severity !== undefined) updateData.severity = parsed.data.severity;
    if (parsed.data.is_active !== undefined) updateData.is_active = parsed.data.is_active;

    const { data, error } = await client
      .from('validation_rules')
      .update(updateData)
      .eq('id', id)
      .eq('org_id', orgId)
      .select()
      .single();

    if (error) throw new AppError('Failed to update validation rule', 500, 'DB_ERROR', error.message);

    await logRulesUpdate(client, getUserEmail(user), { action: 'updated', ruleId: id, changes: parsed.data }).catch(() => {});
    logger.info('Validation rule updated', { ruleId: id, orgId, user: getUserEmail(user) });
    return NextResponse.json({ rule: data });
  } catch (err) {
    return errorResponse(err);
  }
}

// DELETE — delete a rule (admin only)
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, client, orgId } = await requireOrgRole(req, 'admin');

    const { error } = await client
      .from('validation_rules')
      .delete()
      .eq('id', id)
      .eq('org_id', orgId);

    if (error) throw new AppError('Failed to delete validation rule', 500, 'DB_ERROR', error.message);

    await logRulesUpdate(client, getUserEmail(user), { action: 'deleted', ruleId: id }).catch(() => {});
    logger.info('Validation rule deleted', { ruleId: id, orgId, user: getUserEmail(user) });
    return NextResponse.json({ success: true });
  } catch (err) {
    return errorResponse(err);
  }
}

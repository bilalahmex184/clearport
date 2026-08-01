// ============================================================================
// /api/rules/validation — CRUD for validation_rules (configurable rule engine)
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import { logRulesUpdate } from '@/lib/services/audit-log.service';
import { errorResponse, AppError } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';

const validationRuleSchema = z.object({
  name: z.string().min(1).max(200),
  field_key: z.string().nullable().optional(),
  rule_type: z.enum(['confidence_threshold', 'math_check', 'cross_doc_match', 'required_field', 'regex_format']),
  config: z.record(z.string(), z.any()),
  severity: z.enum(['block', 'flag', 'warn']),
  is_active: z.boolean(),
});

// GET — list all validation rules for the org
export async function GET(req: Request) {
  try {
    const { client, orgId } = await requireOrgRole(req, 'viewer');
    const { data, error } = await client
      .from('validation_rules')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true });
    if (error) throw new AppError('Failed to fetch validation rules', 500, 'DB_ERROR', error.message);
    return NextResponse.json({ rules: data || [] });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST — create a new validation rule (admin only)
export async function POST(req: Request) {
  try {
    const { user, client, orgId } = await requireOrgRole(req, 'admin');
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    const parsed = validationRuleSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });

    const { data, error } = await client
      .from('validation_rules')
      .insert({
        org_id: orgId,
        name: parsed.data.name,
        field_key: parsed.data.field_key || null,
        rule_type: parsed.data.rule_type,
        config: parsed.data.config,
        severity: parsed.data.severity,
        is_active: parsed.data.is_active,
      })
      .select()
      .single();
    if (error) throw new AppError('Failed to create validation rule', 500, 'DB_ERROR', error.message);

    await logRulesUpdate(client, getUserEmail(user), { action: 'created', ruleName: parsed.data.name, ruleType: parsed.data.rule_type }).catch(() => {});
    logger.info('Validation rule created', { ruleId: data.id, orgId, user: getUserEmail(user) });
    return NextResponse.json({ rule: data }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

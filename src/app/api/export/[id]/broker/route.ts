// ============================================================================
// /api/export/[id]/broker — export a shipment as CSV using a broker template
// ============================================================================

import { NextResponse } from 'next/server';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import { errorResponse, AppError } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';
import { applyTransform } from '@/lib/mapping/transform';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, client, orgId } = await requireOrgRole(req, 'viewer');

    const url = new URL(req.url);
    const templateId = url.searchParams.get('templateId');
    if (!templateId) {
      return NextResponse.json({ error: 'Missing templateId query parameter' }, { status: 400 });
    }

    // Fetch the template
    const { data: template, error: tErr } = await client
      .from('broker_templates')
      .select('*')
      .eq('id', templateId)
      .eq('org_id', orgId)
      .single();
    if (tErr || !template) {
      throw new AppError('Template not found', 404, 'NOT_FOUND');
    }

    // Fetch mappings
    const { data: mappings, error: mErr } = await client
      .from('broker_field_mappings')
      .select('*')
      .eq('template_id', templateId)
      .order('sort_order', { ascending: true });
    if (mErr) throw new AppError('Failed to fetch mappings', 500, 'DB_ERROR', mErr.message);

    // Fetch the shipment + fields
    const { data: shipment, error: sErr } = await client
      .from('shipments')
      .select('*')
      .eq('id', id)
      .eq('org_id', orgId)
      .single();
    if (sErr || !shipment) {
      throw new AppError('Shipment not found', 404, 'NOT_FOUND');
    }

    const { data: fields } = await client
      .from('document_fields')
      .select('field_key, extracted_value, corrected_value')
      .eq('shipment_id', id);

    // Build field map
    const fieldMap: Record<string, string> = {};
    (fields || []).forEach((f: any) => {
      fieldMap[f.field_key] = f.corrected_value || f.extracted_value || '';
    });

    // Validate required fields
    const missingRequired: string[] = [];
    for (const mapping of mappings || []) {
      if (mapping.is_required && !fieldMap[mapping.internal_field_key]) {
        missingRequired.push(`${mapping.external_field_name} (required by template "${template.name}")`);
      }
    }

    if (missingRequired.length > 0) {
      return NextResponse.json({
        error: 'Export blocked: required fields missing',
        missing: missingRequired,
        template: template.name,
      }, { status: 422 });
    }

    // Build CSV
    const delimiter = template.delimiter || ',';
    const headers = (mappings || []).map((m: any) => escapeCsv(m.external_field_name, delimiter));
    const values = (mappings || []).map((m: any) => {
      const rawValue = fieldMap[m.internal_field_key] || '';
      const transformed = applyTransform(rawValue, m.transform);
      return escapeCsv(transformed, delimiter);
    });

    // Add metadata rows
    const rows: string[] = [];
    rows.push(`# Shipment: ${shipment.id}`);
    rows.push(`# Shipper: ${shipment.shipper}`);
    rows.push(`# Consignee: ${shipment.consignee}`);
    rows.push(`# Template: ${template.name} (v${template.version})`);
    rows.push(`# Exported: ${new Date().toISOString()}`);
    rows.push('');
    rows.push(headers.join(delimiter));
    rows.push(values.join(delimiter));

    const csv = rows.join('\n');

    // Audit log
    await client.from('audit_logs').insert({
      org_id: orgId,
      user_id: user.id,
      shipment_id: id,
      text: `[export] User ${getUserEmail(user)} exported shipment ${id} via broker template "${template.name}"`,
      type: 'success',
    }).catch(() => {});

    logger.info('Broker export completed', { shipmentId: id, templateId, orgId, user: getUserEmail(user) });

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="broker_export_${id}_${template.name}.csv"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function escapeCsv(value: string, delimiter: string): string {
  if (!value) return '';
  if (value.includes(delimiter) || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

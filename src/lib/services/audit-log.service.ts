// ============================================================================
// ClearPort — Audit Log Service
// Thin wrapper around the audit_logs table. Used by every other service to
// record reviewer actions, pipeline events, and batch operations.
//
// The audit_logs table has three columns of interest: `text`, `type`,
// `shipment_id`. We can't easily ALTER the table to add `action`, `actor`,
// and `metadata` columns in a backward-compatible way, so this module
// encodes those dimensions as a structured prefix inside `text`:
//
//   "[<action>] <free-form description>"
//
// The `actor` (user email or anon ID) is included inline in the description
// so the existing audit-log UIs (Dashboard, Exception Desk) continue to
// render the logs with no schema change.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditLog, AuditLogType, DbAuditLog } from '@/lib/clearport-types';
import { mapDbToAuditLog } from '@/lib/supabase';
import { logger } from '@/lib/utils/logger';

export interface InsertAuditLogInput {
  text: string;
  type: AuditLogType;
  shipmentId?: string;
}

/**
 * Insert a single audit log entry. Never throws — audit logging is a
 * best-effort side effect and should not break the parent operation. Errors
 * are logged via the structured logger instead.
 */
export async function insertAuditLog(
  client: SupabaseClient,
  data: InsertAuditLogInput,
): Promise<void> {
  const payload = {
    id: crypto.randomUUID(),
    text: data.text,
    type: data.type,
    shipment_id: data.shipmentId ?? null,
    timestamp: new Date().toISOString(),
  };

  const { error } = await client.from('audit_logs').insert(payload);

  if (error) {
    logger.warn('AuditLogService: insert failed', {
      text: data.text,
      error: error.message,
    });
  }
}

/**
 * Fetch audit logs, optionally filtered by shipment, newest first.
 */
export async function getAuditLogs(
  client: SupabaseClient,
  options: { limit?: number; shipmentId?: string } = {},
): Promise<AuditLog[]> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));

  let query = client
    .from('audit_logs')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (options.shipmentId) {
    query = query.eq('shipment_id', options.shipmentId);
  }

  const { data, error } = await query;

  if (error) {
    logger.error('AuditLogService: fetch failed', {
      shipmentId: options.shipmentId,
      error: error.message,
    });
    return [];
  }

  return (data || []).map((row) => mapDbToAuditLog(row as DbAuditLog));
}

// ---------------------------------------------------------------------------
// Structured action helpers
// ---------------------------------------------------------------------------
//
// Every helper writes a log entry of the form:
//
//   "[<action>] <description>"
//
// where <description> embeds the actor (user email or anon ID), the shipment,
// and any field-level metadata that an auditor would need to reconstruct the
// event. The prefix makes it trivial to grep / filter logs by action type
// even though the DB has no dedicated `action` column.
//
// All helpers are best-effort: they never throw, and any DB error is logged
// via the structured logger. Callers can `await` them if they care about
// ordering, or `.catch(() => {})` if they don't.

/**
 * Format a human-readable file size for log messages.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * [upload] — fires when a document is uploaded to a shipment.
 *
 * Example text:
 *   "[upload] User anon-abc123 uploaded file invoice.pdf (124KB) to SHIP-2026-001"
 */
export async function logUpload(
  client: SupabaseClient,
  userId: string,
  shipmentId: string,
  fileName: string,
  fileSize: number,
): Promise<void> {
  const text = `[upload] User ${userId} uploaded file ${fileName} (${formatFileSize(fileSize)}) to ${shipmentId}`;
  await insertAuditLog(client, { text, type: 'info', shipmentId });
}

/**
 * [extract] — fires after Gemini extraction completes for a shipment.
 *
 * Example text:
 *   "[extract] Gemini extracted 8 fields for SHIP-2026-001 (model: gemini-2.5-pro)"
 */
export async function logExtraction(
  client: SupabaseClient,
  userId: string | null,
  shipmentId: string,
  fieldCount: number,
  model: string,
): Promise<void> {
  const actorSuffix = userId ? ` for ${userId}` : '';
  const text = `[extract] Gemini extracted ${fieldCount} field${fieldCount === 1 ? '' : 's'} for ${shipmentId}${actorSuffix} (model: ${model})`;
  await insertAuditLog(client, { text, type: 'info', shipmentId });
}

/**
 * [resolve] — fires when an exception is accepted, corrected, or rejected.
 *
 * Example text:
 *   "[resolve] User anon-abc123 Accepted exception for field 'htsCode' in SHIP-2026-001"
 *   "[resolve] User anon-abc123 Corrected field 'netWeight' from '12,450 lbs' to '14,250 lbs' in SHIP-2026-001"
 *
 * `action` should be one of: 'Accepted' | 'Corrected' | 'Rejected'.
 * `oldValue` + `newValue` are only required for 'Corrected'; they're
 * included for 'Accepted' / 'Rejected' too when provided, so auditors can
 * see exactly what was reviewed even on accept/reject.
 */
export async function logResolve(
  client: SupabaseClient,
  userId: string,
  shipmentId: string,
  fieldName: string,
  action: 'Accepted' | 'Corrected' | 'Rejected',
  oldValue?: string,
  newValue?: string,
): Promise<void> {
  let text: string;
  if (action === 'Corrected' && oldValue !== undefined && newValue !== undefined) {
    text = `[resolve] User ${userId} Corrected field '${fieldName}' from '${oldValue}' to '${newValue}' in ${shipmentId}`;
  } else {
    text = `[resolve] User ${userId} ${action} exception for field '${fieldName}' in ${shipmentId}`;
  }
  const type: AuditLogType = action === 'Rejected' ? 'warning' : 'success';
  await insertAuditLog(client, { text, type, shipmentId });
}

/**
 * [edit] — fires when a shipment field is edited directly (not via the
 * exception flow). Kept distinct from [resolve] so audits can tell broker
 * overrides apart from exception resolutions.
 *
 * Example text:
 *   "[edit] User anon-abc123 Corrected field 'netWeight' from '12,450 lbs' to '14,250 lbs' in SHIP-2026-001"
 */
export async function logEdit(
  client: SupabaseClient,
  userId: string,
  shipmentId: string,
  fieldName: string,
  oldValue: string,
  newValue: string,
): Promise<void> {
  const text = `[edit] User ${userId} Corrected field '${fieldName}' from '${oldValue}' to '${newValue}' in ${shipmentId}`;
  await insertAuditLog(client, { text, type: 'info', shipmentId });
}

/**
 * [export] — fires when a CSV / JSON audit export is generated.
 *
 * Example text:
 *   "[export] User anon-abc123 exported CSV for SHIP-2026-001"
 */
export async function logExport(
  client: SupabaseClient,
  userId: string,
  shipmentId: string,
  format: 'CSV' | 'JSON' | string,
): Promise<void> {
  const text = `[export] User ${userId} exported ${format} for ${shipmentId}`;
  await insertAuditLog(client, { text, type: 'success', shipmentId });
}

/**
 * [delete] — fires when a shipment (and its exceptions / audit trail) is
 * hard-deleted. Admin-only action.
 *
 * Example text:
 *   "[delete] User admin@clearport.corp deleted shipment SHIP-2026-001"
 */
export async function logDelete(
  client: SupabaseClient,
  userId: string,
  shipmentId: string,
): Promise<void> {
  const text = `[delete] User ${userId} deleted shipment ${shipmentId}`;
  await insertAuditLog(client, { text, type: 'warning', shipmentId });
}

/**
 * [rules] — fires when operational rules (thresholds) are updated.
 *
 * Example text:
 *   "[rules] User admin@clearport.corp updated thresholds (invoice=85, hts=90, parties=80)"
 */
export async function logRulesUpdate(
  client: SupabaseClient,
  userId: string,
  rules: { invoiceThreshold?: number; htsThreshold?: number; partiesThreshold?: number },
): Promise<void> {
  const parts: string[] = [];
  if (rules.invoiceThreshold !== undefined) parts.push(`invoice=${rules.invoiceThreshold}`);
  if (rules.htsThreshold !== undefined) parts.push(`hts=${rules.htsThreshold}`);
  if (rules.partiesThreshold !== undefined) parts.push(`parties=${rules.partiesThreshold}`);
  const text = `[rules] User ${userId} updated thresholds (${parts.join(', ')})`;
  await insertAuditLog(client, { text, type: 'info' });
}

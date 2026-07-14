// ============================================================================
// ClearPort — Audit Log Service
// Thin wrapper around the audit_logs table. Used by every other service to
// record reviewer actions, pipeline events, and batch operations.
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

// ============================================================================
// ClearPort — Auditability & Replay System
// ============================================================================
// Every critical action is logged with input, output, rules applied, timestamp,
// and actor. Logs are immutable. System supports replaying requests.
// ============================================================================

import { logger } from '@/lib/observability/logger';

// ---------------------------------------------------------------------------
// Audit Record
// ---------------------------------------------------------------------------

export interface AuditRecord {
  id: string;
  request_id: string;
  timestamp: string;
  actor: {
    type: 'user' | 'system' | 'edge_function';
    id: string;
  };
  organization_id?: string;
  action: string;
  input: Record<string, any>;
  output: Record<string, any>;
  rules_applied?: string[];
  decision?: {
    status: 'approved' | 'rejected' | 'needs_review';
    reason: string;
  };
  immutable: true; // type-level guarantee
}

// ---------------------------------------------------------------------------
// Immutable Audit Logger
// ---------------------------------------------------------------------------

/**
 * Write an audit record. This is a fire-and-forget operation that
 * inserts into the audit_logs table (which has no UPDATE/DELETE policy
 * in RLS — only INSERT + SELECT).
 */
export async function writeAuditRecord(
  client: any, // SupabaseClient
  record: Omit<AuditRecord, 'id' | 'timestamp' | 'immutable'>,
): Promise<void> {
  const fullRecord: AuditRecord = {
    ...record,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    immutable: true,
  };

  try {
    const { error } = await client.from('audit_logs').insert({
      id: fullRecord.id,
      org_id: record.organization_id,
      user_id: record.actor.id,
      shipment_id: record.input.shipment_id || null,
      text: formatAuditText(record),
      timestamp: fullRecord.timestamp,
      type: record.decision?.status === 'approved' ? 'success' : record.decision?.status === 'rejected' ? 'warning' : 'info',
    });

    if (error) {
      logger.error('Failed to write audit record', {
        error: error.message,
        action: record.action,
        request_id: record.request_id,
      });
    }
  } catch (err) {
    logger.error('Audit write threw exception', {
      error: err instanceof Error ? err.message : String(err),
      action: record.action,
    });
  }
}

function formatAuditText(record: Omit<AuditRecord, 'id' | 'timestamp' | 'immutable'>): string {
  const parts: string[] = [`[${record.action}]`];

  if (record.actor.type === 'user') {
    parts.push(`User ${record.actor.id}`);
  } else {
    parts.push(`System (${record.actor.type})`);
  }

  parts.push(`- ${record.action}`);

  if (record.input.shipment_id) {
    parts.push(`on ${record.input.shipment_id}`);
  }

  if (record.output.status) {
    parts.push(`→ ${record.output.status}`);
  }

  if (record.decision) {
    parts.push(`[${record.decision.status}: ${record.decision.reason}]`);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Replay Mechanism
// ---------------------------------------------------------------------------

/**
 * Replay a previous request by its audit record.
 * This re-executes the action with the same input, allowing verification
 * that the system produces the same output (deterministic processing).
 */
export async function replayAction(
  auditRecord: AuditRecord,
  executor: (input: Record<string, any>) => Promise<Record<string, any>>,
): Promise<{
  original_output: Record<string, any>;
  replayed_output: Record<string, any>;
  match: boolean;
  differences: string[];
}> {
  logger.info(`Replaying action: ${auditRecord.action}`, {
    request_id: auditRecord.request_id,
    audit_id: auditRecord.id,
    action: auditRecord.action,
  });

  const replayedOutput = await executor(auditRecord.input);

  // Compare outputs
  const differences: string[] = [];
  const originalKeys = Object.keys(auditRecord.output);
  const replayedKeys = Object.keys(replayedOutput);

  for (const key of new Set([...originalKeys, ...replayedKeys])) {
    const origVal = JSON.stringify(auditRecord.output[key]);
    const replayVal = JSON.stringify(replayedOutput[key]);
    if (origVal !== replayVal) {
      differences.push(`Field "${key}": original=${origVal}, replay=${replayVal}`);
    }
  }

  const match = differences.length === 0;

  logger.info(`Replay ${match ? 'matches' : 'differs'}: ${auditRecord.action}`, {
    request_id: auditRecord.request_id,
    audit_id: auditRecord.id,
    match,
    differences: differences.length,
  });

  return {
    original_output: auditRecord.output,
    replayed_output: replayedOutput,
    match,
    differences,
  };
}

// ---------------------------------------------------------------------------
// Audit Trail Query
// ---------------------------------------------------------------------------

export interface AuditTrailQuery {
  request_id?: string;
  user_id?: string;
  organization_id?: string;
  shipment_id?: string;
  action?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
}

/**
 * Query audit trail with filters.
 */
export async function queryAuditTrail(
  client: any, // SupabaseClient
  query: AuditTrailQuery,
): Promise<any[]> {
  let q = client.from('audit_logs').select('*');

  if (query.shipment_id) q = q.eq('shipment_id', query.shipment_id);
  if (query.user_id) q = q.eq('user_id', query.user_id);
  if (query.organization_id) q = q.eq('org_id', query.organization_id);
  if (query.start_date) q = q.gte('timestamp', query.start_date);
  if (query.end_date) q = q.lte('timestamp', query.end_date);

  q = q.order('timestamp', { ascending: false }).limit(query.limit || 50);

  const { data, error } = await q;

  if (error) {
    logger.error('Failed to query audit trail', { error: error.message, query });
    return [];
  }

  return data || [];
}

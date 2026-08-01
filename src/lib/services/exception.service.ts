// ============================================================================
// ClearPort — Exception Service
// Resolves single exceptions and batch-accepts high-confidence ones.
//
// Business rules (mirrors the deployed update-exception / batch-accept edge
// functions so the service layer can act as a drop-in replacement when route
// handlers replace the edge-function transport):
//
//   1. Validate status ∈ {Accepted, Corrected, Rejected}; require
//      correctedValue when status='Corrected'.
//   2. Push a new ExceptionHistoryEntry onto the FRONT of the history array.
//   3. Update the exception row (status, resolved_at, resolved_by, history,
//      corrected_value when Corrected).
//   4. Sync the linked document_field (is_flagged=false, reviewer_action,
//      corrected_value when Corrected).
//   5. Recompute shipment.current_confidence =
//        initial_confidence + round((resolved/total) * 30), capped at 100.
//      If no exceptions remain unresolved → flip shipment.status to 'Approved'.
//   6. Write an audit_logs entry.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Exception,
  ReviewerAction,
  ExceptionStatus,
  ExceptionHistoryEntry,
  DbException,
  ShipmentStatus,
} from '@/lib/clearport-types';
import { mapDbToException } from '@/lib/supabase';
import { logger } from '@/lib/utils/logger';
import { AppError } from '@/lib/errors';
import { insertAuditLog } from '@/lib/services/audit-log.service';

const CONFIDENCE_BOOST = 30; // total headroom reserved for resolving exceptions

function isSchemaNotDeployed(message: string): boolean {
  return (
    message.includes('PGRST205') ||
    message.includes('42P01') ||
    message.includes('does not exist')
  );
}

function wrapDbError(action: string, message: string): AppError {
  if (isSchemaNotDeployed(message)) {
    return new AppError(
      'Schema not deployed. Run supabase/schema.sql in Supabase SQL Editor.',
      500,
      'SCHEMA_NOT_DEPLOYED',
      { action, dbError: message },
    );
  }
  return new AppError(`Failed to ${action}`, 500, 'DB_ERROR', message);
}

/**
 * Recompute shipment.current_confidence and, if all exceptions are resolved,
 * flip status to 'Approved'. Returns the new confidence + status so callers
 * can include them in their response payload.
 */
async function recomputeShipmentState(
  client: SupabaseClient,
  shipmentId: string,
): Promise<{ confidence: number; status: ShipmentStatus }> {
  // Fetch shipment + its exceptions in parallel.
  const [shipmentRes, exceptionsRes] = await Promise.all([
    client
      .from('shipments')
      .select('id, initial_confidence, current_confidence, status')
      .eq('id', shipmentId)
      .maybeSingle(),
    client
      .from('exceptions')
      .select('id, status')
      .eq('shipment_id', shipmentId),
  ]);

  if (shipmentRes.error) {
    throw wrapDbError('recompute shipment (fetch shipment)', shipmentRes.error.message);
  }
  if (!shipmentRes.data) {
    throw new AppError(`Shipment not found: ${shipmentId}`, 404, 'NOT_FOUND', {
      shipmentId,
    });
  }

  const initial = (shipmentRes.data.initial_confidence as number) ?? 0;
  const allExceptions = (exceptionsRes.data || []) as Array<{
    id: string;
    status: ExceptionStatus;
  }>;

  const total = allExceptions.length;
  const resolved = allExceptions.filter((e) => e.status !== 'Unresolved').length;

  const boost = total === 0 ? 0 : Math.round((resolved / total) * CONFIDENCE_BOOST);
  const newConfidence = Math.min(100, initial + boost);
  const allResolved = total > 0 && resolved === total;

  const currentStatus = shipmentRes.data.status as ShipmentStatus;
  const newStatus: ShipmentStatus = allResolved
    ? 'Approved'
    : currentStatus === 'Approved'
      ? 'Under Review' // got un-resolved somehow — demote
      : currentStatus;

  const { error } = await client
    .from('shipments')
    .update({
      current_confidence: newConfidence,
      status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', shipmentId);

  if (error) {
    throw wrapDbError('recompute shipment (update)', error.message);
  }

  return { confidence: newConfidence, status: newStatus };
}

// ---------------------------------------------------------------------------
// List exceptions for a shipment
// ---------------------------------------------------------------------------

export async function getExceptions(
  client: SupabaseClient,
  shipmentId: string,
): Promise<Exception[]> {
  const { data, error } = await client
    .from('exceptions')
    .select('*')
    .eq('shipment_id', shipmentId)
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('ExceptionService: fetch exceptions failed', {
      shipmentId,
      error: error.message,
    });
    throw wrapDbError('fetch exceptions', error.message);
  }

  return (data || []).map((row) => mapDbToException(row as DbException));
}

// ---------------------------------------------------------------------------
// Resolve a single exception
// ---------------------------------------------------------------------------

export interface UpdateExceptionInput {
  status: ReviewerAction;
  correctedValue?: string;
  resolvedBy: string;
}

export interface UpdateExceptionResult {
  exception: Exception;
  shipmentStatus: ShipmentStatus;
  shipmentConfidence: number;
}

export async function updateException(
  client: SupabaseClient,
  exceptionId: string,
  input: UpdateExceptionInput,
  orgId?: string,
): Promise<UpdateExceptionResult> {
  const { status, correctedValue, resolvedBy } = input;

  // Validation: Corrected requires a value.
  if (status === 'Corrected' && (!correctedValue || !correctedValue.trim())) {
    throw new AppError(
      'correctedValue is required when status is "Corrected"',
      422,
      'VALIDATION_ERROR',
      { exceptionId, status },
    );
  }

  // 1. Fetch the exception (scoped to the current org when orgId is given).
  let fetchQuery = client.from('exceptions').select('*').eq('id', exceptionId);
  if (orgId) {
    fetchQuery = fetchQuery.eq('org_id', orgId);
  }
  const { data: existing, error: fetchErr } = await fetchQuery.maybeSingle();

  if (fetchErr) {
    logger.error('ExceptionService: fetch exception failed', {
      exceptionId,
      error: fetchErr.message,
    });
    throw wrapDbError('fetch exception', fetchErr.message);
  }
  if (!existing) {
    throw new AppError(`Exception not found: ${exceptionId}`, 404, 'NOT_FOUND', {
      exceptionId,
    });
  }

  const existingRow = existing as DbException;

  // 2. Build history entry — push to FRONT of the array.
  const oldValue =
    existingRow.corrected_value ||
    existingRow.cross_doc_value ||
    existingRow.extracted_value ||
    existingRow.original_value ||
    '';
  const newValue = correctedValue || existingRow.extracted_value || oldValue;

  const historyEntry: ExceptionHistoryEntry = {
    user: resolvedBy,
    oldValue,
    newValue,
    timestamp: new Date().toISOString(),
    action: status,
  };

  const nextHistory = [historyEntry, ...(existingRow.history || [])];

  // 3. Update the exception row.
  const patch: Record<string, unknown> = {
    status,
    resolved_at: new Date().toISOString(),
    resolved_by: resolvedBy,
    history: nextHistory,
  };
  if (status === 'Corrected' && correctedValue !== undefined) {
    patch.corrected_value = correctedValue;
  }

  const { data: updated, error: updateErr } = await client
    .from('exceptions')
    .update(patch)
    .eq('id', exceptionId)
    .select()
    .single();

  if (updateErr) {
    logger.error('ExceptionService: update exception failed', {
      exceptionId,
      error: updateErr.message,
    });
    throw wrapDbError('update exception', updateErr.message);
  }

  const updatedRow = updated as DbException;
  const mapped = mapDbToException(updatedRow);

  // 4. Sync the linked document_field (if any).
  if (updatedRow.field_id) {
    const fieldPatch: Record<string, unknown> = {
      is_flagged: false,
      reviewer_action: status,
      updated_at: new Date().toISOString(),
    };
    if (status === 'Corrected' && correctedValue !== undefined) {
      fieldPatch.corrected_value = correctedValue;
    }

    const { error: fieldErr } = await client
      .from('document_fields')
      .update(fieldPatch)
      .eq('id', updatedRow.field_id);

    if (fieldErr) {
      // Non-fatal — the exception itself was updated successfully.
      logger.warn('ExceptionService: failed to sync document_field', {
        exceptionId,
        fieldId: updatedRow.field_id,
        error: fieldErr.message,
      });
    }
  }

  // 5. Recompute shipment confidence + status.
  const shipmentState = await recomputeShipmentState(client, updatedRow.shipment_id);

  // 6. Audit log.
  const actionVerb =
    status === 'Accepted'
      ? 'Accepted'
      : status === 'Corrected'
        ? `Corrected to "${correctedValue || ''}"`
        : 'Rejected';
  await insertAuditLog(client, {
    text: `${resolvedBy} ${actionVerb} exception on ${updatedRow.field_name} (${updatedRow.shipment_id})`,
    type: status === 'Rejected' ? 'warning' : 'success',
    shipmentId: updatedRow.shipment_id,
  }).catch((err) => {
    logger.warn('ExceptionService: audit log insert failed', {
      exceptionId,
      error: err?.message ?? String(err),
    });
  });

  logger.info('ExceptionService: resolved exception', {
    exceptionId,
    status,
    shipmentId: updatedRow.shipment_id,
    shipmentStatus: shipmentState.status,
  });

  return {
    exception: mapped,
    shipmentStatus: shipmentState.status,
    shipmentConfidence: shipmentState.confidence,
  };
}

// ---------------------------------------------------------------------------
// Batch-accept high-confidence exceptions
// ---------------------------------------------------------------------------

export interface BatchAcceptResult {
  acceptedCount: number;
  threshold: number;
  shipmentStatus: ShipmentStatus;
  shipmentConfidence: number;
}

export async function batchAcceptExceptions(
  client: SupabaseClient,
  shipmentId: string,
  threshold: number,
  resolvedBy: string,
  orgId?: string,
): Promise<BatchAcceptResult> {
  // 1. Fetch unresolved exceptions for the shipment (scoped to the org).
  let fetchQuery = client
    .from('exceptions')
    .select('*')
    .eq('shipment_id', shipmentId)
    .eq('status', 'Unresolved');
  if (orgId) {
    fetchQuery = fetchQuery.eq('org_id', orgId);
  }
  const { data: unresolved, error: fetchErr } = await fetchQuery.order(
    'created_at',
    { ascending: true },
  );

  if (fetchErr) {
    logger.error('ExceptionService: batch fetch failed', {
      shipmentId,
      error: fetchErr.message,
    });
    throw wrapDbError('fetch exceptions for batch', fetchErr.message);
  }

  if (!unresolved || unresolved.length === 0) {
    logger.info('ExceptionService: batch no-op (no unresolved exceptions)', {
      shipmentId,
    });
    const state = await recomputeShipmentState(client, shipmentId);
    return {
      acceptedCount: 0,
      threshold,
      shipmentStatus: state.status,
      shipmentConfidence: state.confidence,
    };
  }

  // 2. Filter by confidence >= threshold.
  const toAccept = (unresolved as DbException[]).filter(
    (e) => e.confidence >= threshold,
  );

  if (toAccept.length === 0) {
    logger.info('ExceptionService: batch no-op (none above threshold)', {
      shipmentId,
      threshold,
      totalUnresolved: unresolved.length,
    });
    const state = await recomputeShipmentState(client, shipmentId);
    return {
      acceptedCount: 0,
      threshold,
      shipmentStatus: state.status,
      shipmentConfidence: state.confidence,
    };
  }

  // 3. Accept each — reuses the single-exception path so history + field sync
  //    + audit logs are handled consistently.
  let accepted = 0;
  for (const exc of toAccept) {
    try {
      await updateException(client, exc.id, {
        status: 'Accepted',
        resolvedBy,
      });
      accepted += 1;
    } catch (err) {
      logger.warn('ExceptionService: batch item failed', {
        exceptionId: exc.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Recompute shipment state (also handled per-update, but a final pass
  //    guarantees the shipment reflects the last accepted count).
  const state = await recomputeShipmentState(client, shipmentId);

  // 5. Single batch-level audit log entry.
  await insertAuditLog(client, {
    text: `Batch action: Approved ${accepted} high-confidence exception(s) (>= ${threshold}%) in ${shipmentId}`,
    type: 'success',
    shipmentId,
  }).catch((err) => {
    logger.warn('ExceptionService: batch audit log insert failed', {
      shipmentId,
      error: err?.message ?? String(err),
    });
  });

  logger.info('ExceptionService: batch accept complete', {
    shipmentId,
    accepted,
    threshold,
    shipmentStatus: state.status,
  });

  return {
    acceptedCount: accepted,
    threshold,
    shipmentStatus: state.status,
    shipmentConfidence: state.confidence,
  };
}

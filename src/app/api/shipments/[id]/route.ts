// ============================================================================
// /api/shipments/[id] — single-shipment CRUD
// ============================================================================
//
// GET    /api/shipments/[id]                → { shipment: ShipmentEntry }   (viewer)
// PATCH  /api/shipments/[id]  { shipper?, consignee?, status?, urgency? }
//                                            → { shipment: DbShipment }     (operator)
// DELETE /api/shipments/[id]                → { success: true }             (admin)
//
// In Next.js 16, dynamic-route params are a Promise and must be awaited.
// All queries are filtered by the active org_id from `requireOrgRole()`.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import {
  getShipmentById,
  updateShipment,
  deleteShipment,
} from '@/lib/services/shipment.service';
import { logDelete } from '@/lib/services/audit-log.service';
import { updateShipmentSchema } from '@/lib/validators/shipment.validator';
import { errorResponse } from '@/lib/errors';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';

// ---------------------------------------------------------------------------
// GET — full shipment detail (fields + exceptions + documents)
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { client, orgId, role } = await requireOrgRole(req, 'viewer');
    const { id } = await params;

    const shipment = await getShipmentById(client, id, orgId);
    if (!shipment) {
      throw new AppError(`Shipment not found: ${id}`, 404, 'NOT_FOUND', { id, orgId });
    }

    logger.debug('Shipment detail fetched', { shipmentId: id, orgId, role });
    return NextResponse.json({ shipment });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH — partial update (allowlisted columns only — see updateShipment)
// ---------------------------------------------------------------------------

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, client, orgId, role } = await requireOrgRole(req, 'operator');
    const { id } = await params;

    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const parsed = updateShipmentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 422 },
      );
    }

    // Map camelCase input → snake_case DB columns expected by updateShipment.
    const patch: Record<string, unknown> = {};
    if (parsed.data.shipper !== undefined) patch.shipper = parsed.data.shipper;
    if (parsed.data.consignee !== undefined) patch.consignee = parsed.data.consignee;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.urgency !== undefined) patch.urgency = parsed.data.urgency;
    if (parsed.data.validation_status !== undefined) patch.validation_status = parsed.data.validation_status;
    if (parsed.data.last_validated_at !== undefined) patch.last_validated_at = parsed.data.last_validated_at;
    if (parsed.data.pipeline_trace_id !== undefined) patch.pipeline_trace_id = parsed.data.pipeline_trace_id;

    // Scope the update by orgId so a cross-org PATCH returns 404 instead of
    // silently no-op'ing.
    const shipment = await updateShipment(client, id, patch, orgId);

    logger.info('Shipment updated via API', {
      shipmentId: id,
      orgId,
      role,
      user: getUserEmail(user),
    });

    return NextResponse.json({ shipment });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE — cascading cleanup happens at the DB level via FK ON DELETE CASCADE
// ---------------------------------------------------------------------------

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, client, orgId, role } = await requireOrgRole(req, 'admin');
    const { id } = await params;

    // Scope the delete by orgId so a cross-org DELETE returns 404.
    await deleteShipment(client, id, orgId);

    // Audit the destructive action BEFORE the FK cascade wipes the audit_logs
    // rows for this shipment. (Best-effort — the delete already succeeded.)
    await logDelete(client, getUserEmail(user), id).catch((err) => {
      logger.warn('shipments DELETE: audit log failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info('Shipment deleted via API', {
      shipmentId: id,
      orgId,
      role,
      user: getUserEmail(user),
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return errorResponse(err);
  }
}

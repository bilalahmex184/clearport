// ============================================================================
// /api/shipments/[id] — single-shipment CRUD
// ============================================================================
//
// GET    /api/shipments/[id]                → { shipment: ShipmentEntry }
// PATCH  /api/shipments/[id]  { shipper?, consignee?, status?, urgency? }
//                                            → { shipment: DbShipment }
// DELETE /api/shipments/[id]                → { success: true }
//
// In Next.js 16, dynamic-route params are a Promise and must be awaited.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireUserClient, getUserRole, getUserEmail } from '@/lib/services/auth.service';
import { canEdit, isAdmin } from '@/lib/services/rbac.service';
import {
  getShipmentById,
  updateShipment,
  deleteShipment,
} from '@/lib/services/shipment.service';
import { logDelete } from '@/lib/services/audit-log.service';
import { updateShipmentSchema } from '@/lib/validators/shipment.validator';
import { errorResponse } from '@/lib/utils/error-handler';
import { AppError } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';

// ---------------------------------------------------------------------------
// GET — full shipment detail (fields + exceptions + documents)
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { client } = await requireUserClient(req);
    const { id } = await params;

    const shipment = await getShipmentById(client, id);
    if (!shipment) {
      throw new AppError(`Shipment not found: ${id}`, 404, 'NOT_FOUND', { id });
    }

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
    const { user, client } = await requireUserClient(req);
    const { id } = await params;

    // RBAC: editing shipment metadata requires the 'edit' permission.
    const role = getUserRole(user);
    if (!canEdit(role)) {
      return NextResponse.json(
        { error: 'Insufficient permissions', code: 'FORBIDDEN' },
        { status: 403 },
      );
    }

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

    const shipment = await updateShipment(client, id, patch);
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
    const { user, client } = await requireUserClient(req);
    const { id } = await params;

    // RBAC: hard-delete is admin-only. operator/viewer get 403 so they
    // can't accidentally purge a shipment + its exceptions + audit trail.
    const role = getUserRole(user);
    if (!isAdmin(role)) {
      return NextResponse.json(
        { error: 'Insufficient permissions: admin role required', code: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    await deleteShipment(client, id);

    // Audit the destructive action BEFORE the FK cascade wipes the audit_logs
    // rows for this shipment. (Best-effort — the delete already succeeded.)
    await logDelete(client, getUserEmail(user), id).catch((err) => {
      logger.warn('shipments DELETE: audit log failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return errorResponse(err);
  }
}

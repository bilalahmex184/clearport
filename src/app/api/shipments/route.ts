// ============================================================================
// /api/shipments — list (paginated) + create
// ============================================================================
//
// GET  /api/shipments?page=1&limit=20
//   → { data: ShipmentEntry[], pagination: { page, limit, total, totalPages } }
//   (RBAC: viewer — filtered by the active org from X-Org-Id header)
//
// POST /api/shipments  { shipper, consignee, docsCount?, urgency? }
//   → { shipment: DbShipment }
//   (RBAC: operator — new shipment is created in the active org)
//
// All queries go through a user-scoped Supabase client (RLS enforced) and
// are additionally filtered by the active org_id from `requireOrgRole()`.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import {
  getShipments,
  createShipment,
  type CreateShipmentInput,
} from '@/lib/services/shipment.service';
import {
  createShipmentSchema,
} from '@/lib/validators/shipment.validator';
import { paginationSchema } from '@/lib/validators/pagination.validator';
import { errorResponse } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';

// ---------------------------------------------------------------------------
// GET — paginated list (viewer)
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const { client, orgId, role } = await requireOrgRole(req, 'viewer');

    const url = new URL(req.url);
    const parsed = paginationSchema.safeParse({
      page: url.searchParams.get('page') ?? 1,
      limit: url.searchParams.get('limit') ?? 20,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid pagination params', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const result = await getShipments(client, {
      page: parsed.data.page,
      limit: parsed.data.limit,
      orgId,
    });

    logger.debug('Shipments list fetched', {
      orgId,
      role,
      page: parsed.data.page,
      total: result.pagination.total,
    });

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST — create a new shipment row (operator)
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  try {
    const { user, client, orgId, role } = await requireOrgRole(req, 'operator');

    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const parsed = createShipmentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 422 },
      );
    }

    // Generate a human-friendly shipment ID client-side (matches the
    // SHIP-YYYY-XXXX pattern used by the upload pipeline).
    const shipmentId = `SHIP-${new Date().getFullYear()}-${Math.floor(
      1000 + Math.random() * 9000,
    )}`;

    const input: CreateShipmentInput = {
      id: shipmentId,
      shipper: parsed.data.shipper,
      consignee: parsed.data.consignee,
      docsCount: parsed.data.docsCount,
      urgency: parsed.data.urgency,
      // Scope the new shipment to the active org so it shows up in the
      // org-filtered GET /api/shipments list.
      orgId,
    };

    const shipment = await createShipment(client, input);

    logger.info('Shipment created via API', {
      shipmentId: shipment.id,
      orgId,
      role,
      user: getUserEmail(user),
    });

    return NextResponse.json({ shipment }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

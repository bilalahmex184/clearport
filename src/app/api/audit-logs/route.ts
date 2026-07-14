// ============================================================================
// /api/audit-logs — fetch audit log entries
// ============================================================================
//
// GET /api/audit-logs?limit=50&shipmentId=SHIP-XXXX
//   → { logs: AuditLog[] }
//
// If `shipmentId` is provided, logs are filtered to that shipment only.
// Limit is capped at 200 (matches audit-log.service default).
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUserClient } from '@/lib/services/auth.service';
import { getAuditLogs } from '@/lib/services/audit-log.service';
import { errorResponse } from '@/lib/utils/error-handler';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  shipmentId: z.string().min(1).optional(),
});

export async function GET(req: Request) {
  try {
    const { client } = await requireUserClient(req);

    const url = new URL(req.url);
    const parsed = querySchema.safeParse({
      limit: url.searchParams.get('limit') ?? 50,
      shipmentId: url.searchParams.get('shipmentId') ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid query params', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const logs = await getAuditLogs(client, {
      limit: parsed.data.limit,
      shipmentId: parsed.data.shipmentId,
    });

    return NextResponse.json({ logs });
  } catch (err) {
    return errorResponse(err);
  }
}

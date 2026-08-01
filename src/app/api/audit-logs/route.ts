// ============================================================================
// /api/audit-logs — fetch audit log entries with date/type filtering
// ============================================================================
//
// GET /api/audit-logs?limit=50&shipmentId=SHIP-XXXX&type=success&startDate=2026-01-01&endDate=2026-12-31
//   → { logs: AuditLog[] }
//   (RBAC: viewer)
//
// Filters:
//   - shipmentId: filter to a specific shipment
//   - type: filter by log type (info, success, warning, error)
//   - startDate: ISO date string (inclusive)
//   - endDate: ISO date string (inclusive)
// ============================================================================

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOrgRole } from '@/lib/services/auth.service';
import { getAuditLogs } from '@/lib/services/audit-log.service';
import { errorResponse } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  shipmentId: z.string().min(1).optional(),
  type: z.enum(['info', 'success', 'warning', 'error']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export async function GET(req: Request) {
  try {
    const { client, orgId, role } = await requireOrgRole(req, 'viewer');

    const url = new URL(req.url);
    const parsed = querySchema.safeParse({
      limit: url.searchParams.get('limit') ?? 50,
      shipmentId: url.searchParams.get('shipmentId') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
      startDate: url.searchParams.get('startDate') ?? undefined,
      endDate: url.searchParams.get('endDate') ?? undefined,
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
      orgId,
    });

    // Apply additional filters (type + date range) in-memory since the service
    // function doesn't natively support them yet — this is fine for <200 rows.
    let filtered = logs;
    if (parsed.data.type) {
      filtered = filtered.filter(l => l.type === parsed.data.type);
    }
    if (parsed.data.startDate) {
      const start = new Date(parsed.data.startDate).getTime();
      filtered = filtered.filter(l => new Date(l.timestamp).getTime() >= start);
    }
    if (parsed.data.endDate) {
      const end = new Date(parsed.data.endDate).getTime();
      filtered = filtered.filter(l => new Date(l.timestamp).getTime() <= end);
    }

    logger.debug('Audit logs fetched', {
      orgId,
      role,
      count: filtered.length,
      filters: { type: parsed.data.type, startDate: parsed.data.startDate, endDate: parsed.data.endDate },
    });

    return NextResponse.json({ logs: filtered });
  } catch (err) {
    return errorResponse(err);
  }
}

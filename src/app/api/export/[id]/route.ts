// ============================================================================
// /api/export/[id] — CSV export of a shipment's audit data
// ============================================================================
//
// GET /api/export/[id]
//   → 200 OK, Content-Type: text/csv
//      Content-Disposition: attachment; filename="ClearPort_Audit_<id>.csv"
//
// Generates the CSV locally (does NOT call the export-csv edge function) so
// the route handler is self-contained. The format mirrors the edge function:
//   1. Metadata header block (Shipment ID, Shipper, Consignee, Status, ...)
//   2. Fields section (Field Key, Field Label, Value, Source, Confidence, ...)
//   3. Exceptions section (Exception ID, Field Name, Reason, Confidence, ...)
//
// Values are RFC 4180-escaped (wrapped in double quotes when they contain a
// comma, quote, newline, or CR; inner quotes doubled) and lines are joined
// with CRLF for Excel compatibility.
// ============================================================================

import { requireUserClient } from '@/lib/services/auth.service';
import { getShipmentById } from '@/lib/services/shipment.service';
import { logExport } from '@/lib/services/audit-log.service';
import { errorResponse, AppError } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';
import type { ShipmentEntry } from '@/lib/clearport-types';

const CRLF = '\r\n';

/**
 * Escape a single CSV cell per RFC 4180. Numbers and booleans are stringified
 * first; null/undefined become empty strings.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}

function buildCsv(shipment: ShipmentEntry, exportedBy: string): string {
  const lines: string[] = [];
  const now = new Date();
  const exportedAt = now.toISOString();
  const createdAt = shipment.createdAt || exportedAt;

  // --- Metadata header block ---
  lines.push(csvRow(['ClearPort Audit Export']));
  lines.push(csvRow(['Shipment ID', shipment.id]));
  lines.push(csvRow(['Shipper', shipment.shipper]));
  lines.push(csvRow(['Consignee', shipment.consignee]));
  lines.push(csvRow(['Status', shipment.status]));
  lines.push(csvRow(['Created At', createdAt]));
  lines.push(csvRow(['Initial Confidence', shipment.initialConfidence]));
  lines.push(csvRow(['Current Confidence', shipment.currentConfidence]));
  lines.push(csvRow(['Exported At', exportedAt]));
  lines.push(csvRow(['Exported By', exportedBy]));
  lines.push(''); // blank line separator

  // --- Fields section ---
  lines.push(csvRow([
    'Field Key',
    'Field Label',
    'Value',
    'Source Document',
    'Confidence',
    'Flagged',
    'Status',
  ]));
  for (const f of shipment.fields) {
    const exc = shipment.exceptions.find((e) => e.id === f.exceptionId);
    const status = exc ? exc.status : 'SECURE';
    lines.push(csvRow([
      f.key,
      f.label,
      f.value,
      f.sourceDoc,
      f.confidence,
      f.isFlagged ? 'YES' : 'NO',
      status,
    ]));
  }

  lines.push(''); // blank line separator

  // --- Exceptions section ---
  lines.push(csvRow([
    'Exception ID',
    'Field Name',
    'Reason',
    'Confidence',
    'Status',
    'Resolved By',
  ]));
  for (const e of shipment.exceptions) {
    lines.push(csvRow([
      e.id,
      e.fieldName,
      e.reason,
      e.confidence,
      e.status,
      e.resolvedBy || '',
    ]));
  }

  return lines.join(CRLF);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, client } = await requireUserClient(req);
    const { id } = await params;

    const shipment = await getShipmentById(client, id);
    if (!shipment) {
      throw new AppError(`Shipment not found: ${id}`, 404, 'NOT_FOUND', { id });
    }

    const exportedBy = user.email || `anon-${user.id.slice(0, 8)}@clearport.local`;
    const csv = buildCsv(shipment, exportedBy);
    const filename = `ClearPort_Audit_${id}.csv`;

    // Best-effort structured audit log entry — uses the new logExport helper
    // so the log line follows the "[export] User X exported CSV for Y" format
    // that auditors can grep / filter on.
    await logExport(client, exportedBy, id, 'CSV').catch((err) => {
      logger.warn('export: audit log insert failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

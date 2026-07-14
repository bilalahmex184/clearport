// ============================================================================
// /api/exceptions/batch-accept — batch-accept high-confidence exceptions
// ============================================================================
//
// POST /api/exceptions/batch-accept
//   body: { shipmentId: string, threshold?: number }
//   →    { acceptedCount, threshold, shipmentStatus, shipmentConfidence }
//
// If `threshold` is omitted, the service falls back to the shipment owner's
// operational_rules.invoice_threshold (and ultimately to 80 if no rules row
// exists yet).
// ============================================================================

import { NextResponse } from 'next/server';
import { requireUserClient, getUserEmail } from '@/lib/services/auth.service';
import {
  batchAcceptExceptions,
} from '@/lib/services/exception.service';
import { batchAcceptSchema } from '@/lib/validators/exception.validator';
import { errorResponse } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';

// ---------------------------------------------------------------------------
// Resolve the effective threshold: body > operational_rules.invoice_threshold > 80
// ---------------------------------------------------------------------------

async function resolveThreshold(
  client: import('@supabase/supabase-js').SupabaseClient,
  explicit?: number,
): Promise<number> {
  if (typeof explicit === 'number') return explicit;

  const { data, error } = await client
    .from('operational_rules')
    .select('invoice_threshold')
    .maybeSingle();

  if (error) {
    // Non-fatal — fall back to the hard-coded default.
    logger.warn('batch-accept: could not load operational_rules', {
      error: error.message,
    });
    return 80;
  }
  if (data?.invoice_threshold != null) return data.invoice_threshold;
  return 80;
}

export async function POST(req: Request) {
  try {
    const { user, client } = await requireUserClient(req);

    const body = await req.json().catch(() => null);
    if (!body) {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 },
      );
    }

    const parsed = batchAcceptSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 422 },
      );
    }

    const threshold = await resolveThreshold(client, parsed.data.threshold);
    const resolvedBy = getUserEmail(user);

    const result = await batchAcceptExceptions(
      client,
      parsed.data.shipmentId,
      threshold,
      resolvedBy,
    );

    logger.info('Batch-accept via API', {
      shipmentId: parsed.data.shipmentId,
      acceptedCount: result.acceptedCount,
      threshold,
    });

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

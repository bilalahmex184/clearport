// ============================================================================
// /api/exceptions/[id] — resolve a single exception
// ============================================================================
//
// PATCH /api/exceptions/[id]
//   body: { status: 'Accepted' | 'Corrected' | 'Rejected', correctedValue?: string }
//   →    { exception, shipmentStatus, shipmentConfidence }
//   (RBAC: operator)
//
// The service layer handles:
//   - validating that 'Corrected' requires a correctedValue
//   - pushing a new ExceptionHistoryEntry onto the FRONT of the history array
//   - syncing the linked document_field (is_flagged=false, reviewer_action, ...)
//   - recomputing shipment.current_confidence
//   - flipping shipment.status to 'Approved' when all exceptions resolved
//   - writing an audit_logs entry
// ============================================================================

import { NextResponse } from 'next/server';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import {
  updateException,
  type UpdateExceptionInput,
} from '@/lib/services/exception.service';
import { updateExceptionSchema } from '@/lib/validators/exception.validator';
import { errorResponse } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';

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

    const parsed = updateExceptionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 422 },
      );
    }

    const input: UpdateExceptionInput = {
      status: parsed.data.status,
      correctedValue: parsed.data.correctedValue,
      resolvedBy: getUserEmail(user),
    };

    // Scope the lookup by orgId so an exception outside the active org
    // returns 404 instead of leaking data across orgs.
    const result = await updateException(client, id, input, orgId);

    logger.info('Exception resolved via API', {
      exceptionId: id,
      status: parsed.data.status,
      shipmentStatus: result.shipmentStatus,
      orgId,
      role,
      user: getUserEmail(user),
    });

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

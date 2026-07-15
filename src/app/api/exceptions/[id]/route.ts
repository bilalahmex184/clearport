// ============================================================================
// /api/exceptions/[id] — resolve a single exception
// ============================================================================
//
// PATCH /api/exceptions/[id]
//   body: { status: 'Accepted' | 'Corrected' | 'Rejected', correctedValue?: string }
//   →    { exception, shipmentStatus, shipmentConfidence }
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
import { requireUserClient, getUserEmail, getUserRole } from '@/lib/services/auth.service';
import { canResolve } from '@/lib/services/rbac.service';
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
    const { user, client } = await requireUserClient(req);
    const { id } = await params;

    // RBAC: resolving an exception (accept / correct / reject) requires the
    // 'resolve' permission. viewer role gets 403.
    const role = getUserRole(user);
    if (!canResolve(role)) {
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

    const result = await updateException(client, id, input);

    logger.info('Exception resolved via API', {
      exceptionId: id,
      status: parsed.data.status,
      shipmentStatus: result.shipmentStatus,
    });

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

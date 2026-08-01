// ============================================================================
// /api/documents/[id]/extraction-trace — tier-by-tier extraction audit trail
// ============================================================================
//
// GET /api/documents/[id]/extraction-trace
//   → {
//       attempts: ExtractionAttempt[],
//       document: { id, processing_status, extraction_source },
//     }
//   (RBAC: viewer)
//
// Returns every extraction_attempts row for the document, ordered by
// created_at ASC (oldest first), plus the parent document's final outcome
// (processing_status + extraction_source) so the UI can show the timeline
// alongside the verdict.
//
// The document is verified to belong to the caller's org via the org-scoped
// RLS policy on documents (the userClient query returns null for cross-org
// document IDs). We additionally scope by org_id explicitly as defense in
// depth.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireOrgRole } from '@/lib/services/auth.service';
import { errorResponse, AppError } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';

export interface ExtractionAttempt {
  id: string;
  document_id: string;
  org_id: string;
  pipeline_trace_id: string;
  tier: number;
  tier_name: string;
  status: 'success' | 'failure' | 'skipped';
  fields_extracted: number | null;
  error_code: string | null;
  error_message: string | null;
  latency_ms: number | null;
  created_at: string;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { client, orgId } = await requireOrgRole(req, 'viewer');
    const { id: documentId } = await params;

    // Fetch the document — RLS restricts to the caller's org, and we also
    // scope by org_id explicitly as defense in depth. We only need the
    // final-outcome columns here; the attempts are fetched separately below.
    const { data: doc, error: docErr } = await client
      .from('documents')
      .select('id, org_id, processing_status, extraction_source')
      .eq('id', documentId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (docErr) {
      logger.error('extraction-trace: document lookup failed', {
        documentId,
        orgId,
        error: docErr.message,
      });
      throw new AppError(
        'Failed to fetch document',
        500,
        'DB_ERROR',
        docErr.message,
      );
    }
    if (!doc) {
      throw new AppError(
        `Document not found: ${documentId}`,
        404,
        'NOT_FOUND',
        { documentId, orgId },
      );
    }

    // Fetch all extraction_attempts rows for this document. RLS on
    // extraction_attempts (org_members_read_own_attempts) restricts to the
    // caller's org, so a cross-org documentId cannot leak attempts even
    // though we don't filter by org_id here.
    const { data: attempts, error: attemptsErr } = await client
      .from('extraction_attempts')
      .select(
        'id, document_id, org_id, pipeline_trace_id, tier, tier_name, status, fields_extracted, error_code, error_message, latency_ms, created_at',
      )
      .eq('document_id', documentId)
      .order('created_at', { ascending: true });

    if (attemptsErr) {
      // extraction_attempts table may not be deployed yet (migration 017 not
      // run). Return an empty attempts array with a debug note rather than
      // 500'ing the whole endpoint — the UI handles an empty array cleanly.
      logger.warn('extraction-trace: attempts query failed', {
        documentId,
        orgId,
        error: attemptsErr.message,
      });
      return NextResponse.json({
        attempts: [],
        document: {
          id: doc.id,
          processing_status: doc.processing_status,
          extraction_source: doc.extraction_source,
        },
      });
    }

    return NextResponse.json({
      attempts: (attempts || []) as ExtractionAttempt[],
      document: {
        id: doc.id,
        processing_status: doc.processing_status,
        extraction_source: doc.extraction_source,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

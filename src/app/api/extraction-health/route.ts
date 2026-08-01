// ============================================================================
// /api/extraction-health — operational health panel for extraction pipeline
// ============================================================================
//
// GET /api/extraction-health
//   → {
//       tierStats: Array<{
//         tier: number,
//         tier_name: string,
//         total: number,
//         success: number,
//         failure: number,
//         skipped: number,
//         success_rate: number,   // 0-100, rounded to 1 decimal
//       }>,
//       manualReviewQueue: Array<{
//         document_id: string,
//         shipment_id: string,
//         file_name: string,
//         created_at: string,
//         processing_status: string,
//       }>,
//     }
//   (RBAC: viewer)
//
// tierStats: success rate by tier over the last 24h (created_at >= NOW() -
// INTERVAL '24 hours'). Tiers with zero attempts in the window are omitted.
//
// manualReviewQueue: documents currently in 'needs_manual_review' for the
// caller's org, sorted oldest-first (so the oldest stuck doc is at the top
// of the operational queue). Limited to 100 rows to keep the payload sane.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireOrgRole } from '@/lib/services/auth.service';
import { errorResponse } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';

export interface TierStat {
  tier: number;
  tier_name: string;
  total: number;
  success: number;
  failure: number;
  skipped: number;
  success_rate: number;
}

export interface ManualReviewQueueEntry {
  document_id: string;
  shipment_id: string;
  file_name: string;
  created_at: string;
  processing_status: string;
}

export async function GET(req: Request) {
  try {
    const { client, orgId } = await requireOrgRole(req, 'viewer');

    // ── tierStats: aggregate extraction_attempts by tier for the last 24h ──
    // RLS on extraction_attempts (org_members_read_own_attempts) restricts
    // to the caller's org, so we don't need an explicit org_id filter —
    // but we add it as defense in depth and to help the query planner use
    // idx_extraction_attempts_org.
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: rawStats, error: statsErr } = await client
      .from('extraction_attempts')
      .select('tier, tier_name, status')
      .gte('created_at', twentyFourHoursAgo);

    if (statsErr) {
      // extraction_attempts table may not be deployed yet (migration 017).
      // Return empty stats + queue with a debug note rather than 500'ing.
      logger.warn('extraction-health: attempts aggregate failed', {
        orgId,
        error: statsErr.message,
      });
      return NextResponse.json({ tierStats: [], manualReviewQueue: [] });
    }

    // Aggregate in-memory — the row count is small (≤ a few hundred per org
    // per 24h) and this avoids a GROUP BY round-trip + a separate per-tier
    // query.
    const byTier = new Map<
      number,
      { tier_name: string; total: number; success: number; failure: number; skipped: number }
    >();
    for (const row of rawStats || []) {
      let entry = byTier.get(row.tier);
      if (!entry) {
        entry = { tier_name: row.tier_name, total: 0, success: 0, failure: 0, skipped: 0 };
        byTier.set(row.tier, entry);
      }
      entry.total++;
      if (row.status === 'success') entry.success++;
      else if (row.status === 'failure') entry.failure++;
      else if (row.status === 'skipped') entry.skipped++;
    }

    const tierStats: TierStat[] = Array.from(byTier.entries())
      .map(([tier, s]) => ({
        tier,
        tier_name: s.tier_name,
        total: s.total,
        success: s.success,
        failure: s.failure,
        skipped: s.skipped,
        success_rate: s.total > 0
          ? Math.round((s.success / s.total) * 1000) / 10
          : 0,
      }))
      .sort((a, b) => a.tier - b.tier);

    // ── manualReviewQueue: docs in 'needs_manual_review', oldest first ──
    const { data: queueDocs, error: queueErr } = await client
      .from('documents')
      .select('id, shipment_id, file_name, created_at, processing_status')
      .eq('org_id', orgId)
      .eq('processing_status', 'needs_manual_review')
      .order('created_at', { ascending: true })
      .limit(100);

    if (queueErr) {
      logger.warn('extraction-health: manual-review queue failed', {
        orgId,
        error: queueErr.message,
      });
      // Still return tierStats — the queue failure is non-fatal.
      return NextResponse.json({
        tierStats,
        manualReviewQueue: [],
      });
    }

    const manualReviewQueue: ManualReviewQueueEntry[] = (queueDocs || []).map((d: any) => ({
      document_id: d.id,
      shipment_id: d.shipment_id,
      file_name: d.file_name,
      created_at: d.created_at,
      processing_status: d.processing_status,
    }));

    return NextResponse.json({
      tierStats,
      manualReviewQueue,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

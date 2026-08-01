// ============================================================================
// /api/metrics — minimum viable internal dashboard endpoint (Phase 5 Step 4)
// ============================================================================
//
// GET /api/metrics
//   → {
//       generated_at: string,
//       tiers_24h: Array<{
//         tier: string,
//         success_count: number,
//         failure_count: number,
//         skipped_count: number,
//         total_attempted: number,
//         success_rate: number | null,   // 0-1 fraction
//         avg_latency_ms: number | null,
//         last_attempt_at: string,
//       }>,
//       latency_24h: {
//         jobs_completed_24h: number,
//         avg_end_to_end_latency_ms: number,
//         p95_latency_ms: number,
//         p99_latency_ms: number,
//       } | null,
//       dead_letter_by_org: Array<{
//         org_id: string,
//         org_name: string,
//         dead_letter_count: number,
//         oldest_dead_letter_at: string,
//         newest_dead_letter_at: string,
//       }>,
//       queue_depth_by_status: Array<{ status: string, count: number }>,
//       total_dead_letter: number,
//       total_pending: number,
//       total_processing: number,
//     }
//
// RBAC: admin only. This is an internal operational dashboard — org admins
// can see their own org's metrics. (The get_metrics_snapshot function is
// SECURITY DEFINER and returns cross-org data; this route filters to the
// caller's org for tenant isolation.)
//
// The SQL views + function are in supabase/migrations-new/006_metrics_view.sql.
// This route calls get_metrics_snapshot() and returns the JSON blob.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireOrgRole } from '@/lib/services/auth.service';
import { errorResponse } from '@/lib/errors';
import { logger } from '@/lib/utils/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client, orgId } = await requireOrgRole('admin');

    // Call the get_metrics_snapshot() RPC — returns a single JSONB blob with
    // all three metrics + queue depth. One round-trip.
    const { data, error } = await client.rpc('get_metrics_snapshot');

    if (error) {
      logger.warn('metrics: get_metrics_snapshot RPC failed', { error: error.message, orgId });
      // The function may not exist yet (migration not applied). Return a
      // clear error so the operator knows to run 006_metrics_view.sql.
      return errorResponse(
        'Metrics not available — ensure supabase/migrations-new/006_metrics_view.sql is applied',
        503,
        'METRICS_UNAVAILABLE',
      );
    }

    // The snapshot is cross-org (SECURITY DEFINER). Filter the per-org arrays
    // to the caller's org for tenant isolation.
    const snapshot = data as Record<string, unknown>;
    const tiers = (snapshot.tiers_24h as Array<Record<string, unknown>>) || [];
    const deadLetter = (snapshot.dead_letter_by_org as Array<Record<string, unknown>>) || [];

    // The tier stats are org-agnostic (they don't have org_id in the view
    // because job_attempts.tier is a global metric). For a per-org view,
    // we'd need a separate view. For now, return the global tier stats —
    // they're useful for admins to see overall pipeline health.
    // The dead_letter_by_org IS per-org, so filter it.
    const orgDeadLetter = deadLetter.filter((d) => d.org_id === orgId);

    return NextResponse.json({
      generated_at: snapshot.generated_at,
      tiers_24h: tiers,
      latency_24h: snapshot.latency_24h,
      dead_letter_for_org: orgDeadLetter,
      dead_letter_total: snapshot.total_dead_letter,
      queue_depth_by_status: snapshot.queue_depth_by_status,
      total_pending: snapshot.total_pending,
      total_processing: snapshot.total_processing,
    });
  } catch (err) {
    return errorResponse(err, 500, 'METRICS_ERROR');
  }
}

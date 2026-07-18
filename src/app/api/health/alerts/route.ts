// ============================================================================
// /api/health/alerts — operational alert endpoint (S6)
// ============================================================================
//
// GET /api/health/alerts
//   → {
//       alerts: Array<{
//         type: string,            // 'dead_letter_job' | 'low_extraction_success_rate'
//         severity: 'critical' | 'high' | 'medium',
//         message: string,
//         createdAt: string,       // ISO timestamp
//       }>,
//     }
//   (RBAC: viewer — every authenticated org member can see alerts; the
//    AlertBanner.tsx client further gates display to admin/operator only
//    so viewers don't see ops alerts in their UI.)
//
// ALERT CONDITIONS (the "one real, working alert"):
//   1. dead_letter_job — any row in `processing_jobs` with status='dead_letter'
//      for the caller's org. These are jobs the queue (§3) permanently gave
//      up on after exhausting retries; they need a human to investigate and
//      re-queue or discard them.
//
//   2. low_extraction_success_rate — any tier in `extraction_attempts` whose
//      success rate (success / (success + failure)) over the last hour
//      dropped below 50%, with a minimum of 5 attempts in the window (so we
//      don't fire on a single bad luck failure). Per-tier, so the dashboard
//      can show "Gemini Vision" vs "Tesseract" vs "PDF text-layer" health
//      separately.
//
// GRACEFUL DEGRADATION:
//   The `processing_jobs` table is created by a parallel task (§3) and may
//   not exist when this route is first deployed. If the query fails (table
//   missing, RLS error, etc.), we log a warning and return an empty alerts
//   array with a 200 status — never 500. The dashboard banner simply shows
//   nothing until the table is ready.
//
//   Same for `extraction_attempts` (migration 017) — though that one is
//   already deployed, we still guard against schema drift.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireOrgRole } from '@/lib/services/auth.service';
import { errorResponse } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';

export interface Alert {
  type: string;
  severity: 'critical' | 'high' | 'medium';
  message: string;
  createdAt: string;
}

const NOW_ISO = () => new Date().toISOString();

// Thresholds for the low-success-rate alert.
const SUCCESS_RATE_WINDOW_HOURS = 1;
const SUCCESS_RATE_THRESHOLD = 0.5; // 50%
const MIN_ATTEMPTS_FOR_ALERT = 5; // ignore low-volume tiers (single bad luck)

export async function GET(req: Request) {
  try {
    const { client, orgId } = await requireOrgRole(req, 'viewer');

    const alerts: Alert[] = [];

    // ── 1. dead_letter jobs in processing_jobs ───────────────────────────
    // The table may not exist yet (parallel §3 task). Guard with try/catch —
    // a 42P01 (undefined_table) Postgres error comes back as a Supabase
    // `error` object, not a throw, so we check `error` and continue.
    try {
      const { data: deadLetterRows, error: dlErr } = await client
        .from('processing_jobs')
        .select('id, status, created_at, updated_at')
        .eq('org_id', orgId)
        .eq('status', 'dead_letter')
        .order('updated_at', { ascending: false })
        .limit(100);

      if (dlErr) {
        // Most likely "relation processing_jobs does not exist" (42P01) —
        // the parallel §3 migration hasn't run yet. Log and continue with
        // an empty alerts array; do NOT crash.
        logger.warn('health/alerts: processing_jobs query failed (table missing?)', {
          orgId,
          error: dlErr.message,
          code: (dlErr as { code?: string }).code,
        });
      } else if (deadLetterRows && deadLetterRows.length > 0) {
        alerts.push({
          type: 'dead_letter_job',
          severity: 'critical',
          message: `${deadLetterRows.length} processing job${deadLetterRows.length === 1 ? '' : 's'} in dead_letter status — manual intervention required (oldest: ${deadLetterRows[deadLetterRows.length - 1]?.updated_at ?? 'unknown'})`,
          createdAt: NOW_ISO(),
        });
      }
    } catch (err) {
      // Defensive: any unexpected error in the dead-letter check shouldn't
      // break the whole alert endpoint.
      logger.warn('health/alerts: dead_letter check threw', {
        orgId,
        error: String((err as Error)?.message || err),
      });
    }

    // ── 2. low extraction success rate per tier (last 1h) ───────────────
    // Pull all attempts in the window for the org and aggregate in-memory.
    // (Same pattern as /api/extraction-health.) RLS already restricts to
    // this org, but the org_id filter helps the query planner.
    try {
      const oneHourAgo = new Date(Date.now() - SUCCESS_RATE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

      const { data: attemptRows, error: attemptsErr } = await client
        .from('extraction_attempts')
        .select('tier, tier_name, status')
        .eq('org_id', orgId)
        .gte('created_at', oneHourAgo);

      if (attemptsErr) {
        // extraction_attempts may not be deployed yet either. Same guard.
        logger.warn('health/alerts: extraction_attempts query failed (table missing?)', {
          orgId,
          error: attemptsErr.message,
          code: (attemptsErr as { code?: string }).code,
        });
      } else if (attemptRows && attemptRows.length > 0) {
        // Aggregate per tier. Skipped attempts don't count against success
        // rate (they're not real failures — the tier just declined to run).
        const byTier = new Map<number, { tier_name: string; success: number; failure: number }>();
        for (const row of attemptRows) {
          let entry = byTier.get(row.tier);
          if (!entry) {
            entry = { tier_name: row.tier_name, success: 0, failure: 0 };
            byTier.set(row.tier, entry);
          }
          if (row.status === 'success') entry.success++;
          else if (row.status === 'failure') entry.failure++;
          // 'skipped' rows don't count toward success or failure
        }

        for (const [tier, s] of byTier.entries()) {
          const total = s.success + s.failure;
          if (total < MIN_ATTEMPTS_FOR_ALERT) continue; // low volume — ignore
          const successRate = s.success / total;
          if (successRate < SUCCESS_RATE_THRESHOLD) {
            const pct = Math.round(successRate * 100);
            alerts.push({
              type: 'low_extraction_success_rate',
              severity: 'high',
              message: `Tier ${tier} (${s.tier_name}) success rate dropped to ${pct}% in the last hour (${s.success}/${total} attempts)`,
              createdAt: NOW_ISO(),
            });
          }
        }
      }
    } catch (err) {
      logger.warn('health/alerts: extraction success-rate check threw', {
        orgId,
        error: String((err as Error)?.message || err),
      });
    }

    // Always 200 — even with zero alerts. The dashboard polls this every 60s
    // and shows a banner only when alerts.length > 0.
    return NextResponse.json({ alerts });
  } catch (err) {
    // Auth errors (401/403) and other AppErrors flow through errorResponse,
    // which also forwards to Sentry (S6) so unauthenticated attempts aren't
    // spammed — only real auth failures get captured.
    return errorResponse(err);
  }
}

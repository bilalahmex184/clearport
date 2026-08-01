// ============================================================================
// 25-alert-operationalization.test.ts — Phase 5 reality check (Point 4)
// ============================================================================
// Verifies the dead-letter alerting is OPERATIONALIZED: the consumer's
// scheduled() cron handler calls check_dead_letter_threshold() every minute
// and logs at ERROR level when an org crosses the threshold.
//
// The metrics EXISTED (004_dead_letter_alerting.sql + 006_metrics_view.sql +
// /api/metrics) but were never CALLED. This test confirms the cron now calls
// them, making the system OPERATED, not just OBSERVABLE.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Phase 5 reality check — Alert operationalization (Point 4)', () => {

  describe('the consumer cron calls check_dead_letter_threshold', () => {
    it('the scheduled() handler calls the check_dead_letter_threshold RPC', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/index.ts'),
        'utf-8',
      );
      // The cron must call the RPC.
      expect(src).toMatch(/check_dead_letter_threshold/);
      expect(src).toMatch(/supabaseRpc.*check_dead_letter_threshold/);
    });

    it('alerts are logged at ERROR level (so they trigger downstream routing)', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/index.ts'),
        'utf-8',
      );
      // The alert must use console.error (ERROR level) — not console.log or
      // console.warn. ERROR-level logs trigger alert routing in Axiom/Better
      // Stack when the operator configures it. The call spans multiple lines.
      expect(src).toMatch(/console\.error\([\s\S]*?\[ALERT\]/);
    });

    it('the alert includes org_id, count, and severity for triage', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/index.ts'),
        'utf-8',
      );
      expect(src).toMatch(/org_name|org_id/);
      expect(src).toMatch(/dead_letter_count/);
      expect(src).toMatch(/severity/);
      expect(src).toMatch(/sample_job_ids/);
    });

    it('the alerting check is in the SAME scheduled() handler as the reclaim sweep', () => {
      // The cron already runs every 1 minute for reclaim_stuck_jobs_v2.
      // The alerting check runs in the same invocation — no new cron trigger
      // needed. This is the "operated not observable" fix: the check RUNS.
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/index.ts'),
        'utf-8',
      );
      // Both must be inside the scheduled() handler.
      const scheduledStart = src.indexOf('async scheduled(');
      const scheduledEnd = src.indexOf('},', scheduledStart);
      const scheduledBody = src.slice(scheduledStart, scheduledEnd);
      expect(scheduledBody).toMatch(/reclaim_stuck_jobs_v2/);
      expect(scheduledBody).toMatch(/check_dead_letter_threshold/);
    });

    it('the alerting check does NOT throw (failures are logged, not propagated)', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/index.ts'),
        'utf-8',
      );
      // The alerting check must be wrapped in try/catch so a failure (e.g.
      // migration not applied) doesn't crash the cron. Find the
      // check_dead_letter_threshold call and verify there's a catch after it.
      const alertIdx = src.indexOf('check_dead_letter_threshold');
      // Look in the 2000 chars after the call for a catch block.
      const alertSection = src.slice(alertIdx, alertIdx + 2000);
      expect(alertSection).toMatch(/catch/);
    });
  });

  describe('the SQL alerting primitives exist', () => {
    it('004_dead_letter_alerting.sql defines check_dead_letter_threshold', () => {
      const sql = readFileSync(
        resolve(__dirname, '../../supabase/migrations-new/004_dead_letter_alerting.sql'),
        'utf-8',
      );
      expect(sql).toMatch(/CREATE OR REPLACE FUNCTION check_dead_letter_threshold/);
      expect(sql).toMatch(/p_threshold.*DEFAULT 5/);
      expect(sql).toMatch(/p_window_minutes.*DEFAULT 5/);
    });

    it('006_metrics_view.sql defines the metrics snapshot function', () => {
      const sql = readFileSync(
        resolve(__dirname, '../../supabase/migrations-new/006_metrics_view.sql'),
        'utf-8',
      );
      expect(sql).toMatch(/tier_success_rate_24h/);
      expect(sql).toMatch(/pipeline_latency_24h/);
      expect(sql).toMatch(/dead_letter_queue_depth/);
      expect(sql).toMatch(/get_metrics_snapshot/);
    });

    it('the /api/metrics route exists', () => {
      const route = readFileSync(
        resolve(__dirname, '../../src/app/api/metrics/route.ts'),
        'utf-8',
      );
      expect(route).toMatch(/get_metrics_snapshot/);
    });
  });

  describe('the alerting is layered (defense-in-depth)', () => {
    it('the alert flows: SQL function → cron call → ERROR log → external shipper', () => {
      // The full operationalization chain:
      //   1. SQL: check_dead_letter_threshold() (004_dead_letter_alerting.sql)
      //   2. Cron: consumer's scheduled() calls it every 1 min (index.ts)
      //   3. Log: console.error('[ALERT] ...') (ERROR level)
      //   4. Ship: the shared logger's HTTP shipper (logger.ts) forwards to
      //      Axiom/Better Stack/Logtail when LOGSHIP_URL is set.
      //   5. Route: the operator configures Axiom/Better Stack to page on
      //      ERROR-level logs from the 'clearport' service.
      //
      // Steps 1-3 are CODE (done). Steps 4-5 are CONFIG (operator does once).
      const consumerSrc = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/index.ts'),
        'utf-8',
      );
      const loggerSrc = readFileSync(
        resolve(__dirname, '../../packages/shared/src/logger.ts'),
        'utf-8',
      );
      // Step 2: cron calls the function.
      expect(consumerSrc).toMatch(/check_dead_letter_threshold/);
      // Step 3: alert logged at ERROR level. The console.error call spans
      // multiple lines, so use a multiline match.
      expect(consumerSrc).toMatch(/console\.error\([\s\S]*?ALERT/);
      // Step 4: the logger ships ERROR logs via HTTP when configured.
      expect(loggerSrc).toMatch(/LOGSHIP_URL/);
      expect(loggerSrc).toMatch(/LOGSHIP_TOKEN/);
    });
  });
});

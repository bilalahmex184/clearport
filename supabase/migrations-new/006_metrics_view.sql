-- ============================================================================
-- 006_metrics_view.sql — Minimum viable internal dashboard queries
-- ============================================================================
-- PURPOSE (Phase 5 Step 4)
--   The spec asks for "a lightweight metrics endpoint or dashboard query (even
--   a simple SQL view over jobs + job_attempts) exposing: success rate by tier
--   over the last 24h, average end-to-end latency, and the current dead_letter
--   queue depth. This is the minimum viable internal dashboard — it does not
--   need to be fancy, it needs to exist and be checked."
--
--   This migration provides the SQL primitives. The /api/metrics route in the
--   Next.js app queries these views + functions and returns JSON for the
--   internal dashboard.
--
-- PREREQUISITES
--   - 002_async_jobs.sql (jobs + job_attempts tables)
--   - 004_dead_letter_alerting.sql (dead_letter_alerts view, used for depth)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. VIEW tier_success_rate_24h — success rate by tier over the last 24h
-- ---------------------------------------------------------------------------
-- One row per tier (e.g. "1_ai_openrouter", "2_pdf_text_layer", ...).
-- `success_rate` is the fraction of attempts with status='success' out of
-- all non-skipped attempts (skipped is not a failure — it means the tier
-- wasn't reached because an earlier tier succeeded).
CREATE OR REPLACE VIEW tier_success_rate_24h AS
SELECT
  tier,
  COUNT(*) FILTER (WHERE status = 'success') AS success_count,
  COUNT(*) FILTER (WHERE status = 'failure') AS failure_count,
  COUNT(*) FILTER (WHERE status = 'skipped') AS skipped_count,
  COUNT(*) FILTER (WHERE status IN ('success', 'failure')) AS total_attempted,
  CASE
    WHEN COUNT(*) FILTER (WHERE status IN ('success', 'failure')) = 0 THEN NULL
    ELSE COUNT(*) FILTER (WHERE status = 'success')::FLOAT
         / COUNT(*) FILTER (WHERE status IN ('success', 'failure'))
  END AS success_rate,
  AVG(latency_ms) FILTER (WHERE status = 'success' AND latency_ms IS NOT NULL) AS avg_latency_ms,
  MAX(created_at) AS last_attempt_at
FROM job_attempts
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY tier
ORDER BY tier;

-- ---------------------------------------------------------------------------
-- §2. VIEW pipeline_latency_24h — average end-to-end latency
-- ---------------------------------------------------------------------------
-- One row total: the average time from job creation to completion for jobs
-- that completed in the last 24h. `updated_at - created_at` is the wall-clock
-- duration the job spent in the pipeline (including queue wait + all tiers).
CREATE OR REPLACE VIEW pipeline_latency_24h AS
SELECT
  COUNT(*) AS jobs_completed_24h,
  ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000)) AS avg_end_to_end_latency_ms,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000
  )) AS p95_latency_ms,
  ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000
  )) AS p99_latency_ms,
  MIN(updated_at - created_at) AS min_duration,
  MAX(updated_at - created_at) AS max_duration
FROM jobs
WHERE status = 'completed'
  AND updated_at > NOW() - INTERVAL '24 hours';

-- ---------------------------------------------------------------------------
-- §3. VIEW dead_letter_queue_depth — current dead_letter count by org
-- ---------------------------------------------------------------------------
-- The dead_letter queue depth, grouped by org so the dashboard can show
-- which orgs have stuck jobs. Joins to organizations for the org name.
CREATE OR REPLACE VIEW dead_letter_queue_depth AS
SELECT
  j.org_id,
  o.name AS org_name,
  COUNT(*) AS dead_letter_count,
  MIN(j.updated_at) AS oldest_dead_letter_at,
  MAX(j.updated_at) AS newest_dead_letter_at
FROM jobs j
JOIN organizations o ON o.id = j.org_id
WHERE j.status = 'dead_letter'
GROUP BY j.org_id, o.name
ORDER BY dead_letter_count DESC;

-- ---------------------------------------------------------------------------
-- §4. FUNCTION get_metrics_snapshot() — the one-call dashboard query
-- ---------------------------------------------------------------------------
-- Returns a single JSON object with all three metrics + the current claim
-- queue depth. This is what /api/metrics calls — one round-trip, one JSON
-- blob, done.
CREATE OR REPLACE FUNCTION get_metrics_snapshot()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tiers JSONB;
  v_latency JSONB;
  v_dead_letter JSONB;
  v_queue_depth JSONB;
BEGIN
  -- Success rate by tier (last 24h)
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_tiers
  FROM (
    SELECT tier, success_count, failure_count, skipped_count,
           total_attempted, success_rate, avg_latency_ms, last_attempt_at
    FROM tier_success_rate_24h
  ) t;

  -- End-to-end latency (last 24h)
  SELECT row_to_json(p) INTO v_latency FROM pipeline_latency_24h p;

  -- Dead letter queue depth (current)
  SELECT COALESCE(jsonb_agg(row_to_json(d)), '[]'::jsonb) INTO v_dead_letter
  FROM (
    SELECT org_id, org_name, dead_letter_count, oldest_dead_letter_at, newest_dead_letter_at
    FROM dead_letter_queue_depth
  ) d;

  -- Current queue depth (pending + processing jobs, by status)
  SELECT COALESCE(jsonb_agg(row_to_json(q)), '[]'::jsonb) INTO v_queue_depth
  FROM (
    SELECT status, COUNT(*) AS count
    FROM jobs
    WHERE status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')
    GROUP BY status
  ) q;

  RETURN jsonb_build_object(
    'generated_at', NOW(),
    'tiers_24h', v_tiers,
    'latency_24h', v_latency,
    'dead_letter_by_org', v_dead_letter,
    'queue_depth_by_status', v_queue_depth,
    'total_dead_letter', (SELECT COUNT(*) FROM jobs WHERE status = 'dead_letter'),
    'total_pending', (SELECT COUNT(*) FROM jobs WHERE status = 'pending'),
    'total_processing', (SELECT COUNT(*) FROM jobs WHERE status = 'processing')
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- §5. Comments
-- ---------------------------------------------------------------------------
COMMENT ON VIEW tier_success_rate_24h IS
  'Success rate by extraction tier over the last 24h. success_rate = success / (success + failure); skipped is excluded. Phase 5 Step 4 dashboard.';
COMMENT ON VIEW pipeline_latency_24h IS
  'Average + p95 + p99 end-to-end pipeline latency for jobs completed in the last 24h. Phase 5 Step 4 dashboard. The p99 feeds back into the claim_job TTL threshold (002_async_jobs.sql).';
COMMENT ON VIEW dead_letter_queue_depth IS
  'Current dead_letter queue depth by org. Non-zero count means jobs exhausted max_attempts — investigate via dead_letter_alerts (004_dead_letter_alerting.sql).';
COMMENT ON FUNCTION get_metrics_snapshot IS
  'One-call metrics snapshot for the internal dashboard. Returns tier success rates, latency percentiles, dead_letter depth, and queue depth as a single JSON blob. Called by /api/metrics.';

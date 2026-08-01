-- ============================================================================
-- 004_dead_letter_alerting.sql — Dead-letter alerting view + threshold fn
-- ============================================================================
-- PURPOSE
--   Stopgap for Point 3 of the Phase 3 review: "Retry logic needs
--   observability guard." The retry logic in complete_job()
--   (002_async_jobs.sql §6) silently moves jobs to 'dead_letter' when
--   attempts >= max_attempts. Without alerting, a spike of dead-letters —
--   say 5 in 1 minute — is invisible until a customer complains about a
--   stuck shipment. Silent degradation is the worst failure mode for a
--   B2B customs SaaS: brokers miss filings and incur demurrage.
--
--   This migration provides SQL primitives to surface that silent
--   degradation NOW, without waiting for Phase 5. The full alerting
--   pipeline (alertmanager / Slack webhook / PagerDuty) is Phase 5.
--   Phase 5 just needs to:
--     1. Add a cron job (pg_cron or the existing consumer Worker's
--        scheduled() handler at apps/consumer/src/index.ts, which already
--        calls reclaim_stuck_jobs_v2() every minute — adding a
--        check_dead_letter_threshold() call in the SAME handler is the
--        natural integration point).
--     2. When the function returns rows, route them: WARNING rows to a
--        Slack webhook, CRITICAL rows to PagerDuty.
--   Until Phase 5 wires the delivery, operators can query the view and
--   function manually from the Supabase SQL editor:
--     SELECT * FROM dead_letter_alerts;
--     SELECT * FROM check_dead_letter_threshold();
--     SELECT * FROM detect_failure_patterns();
--
-- PREREQUISITES
--   - 001_baseline_schema.sql (defines organizations)
--   - 002_async_jobs.sql (defines jobs + job_attempts + complete_job)
--
-- RELATIONSHIP TO EXISTING ALERTING
--   /api/health/alerts (route) already surfaces per-org dead_letter jobs
--   to authenticated users in the AlertBanner — but it's a pull model,
--   scoped to the caller's org, with no spike detection and no push
--   delivery. This migration adds the cross-org SPIKE detection that the
--   route can't do (RLS scopes it to one org) and the threshold logic
--   that an external cron can poll. The route and this view are
--   complementary: the route tells a user "your job died," this view
--   tells an operator "5 jobs just died in 1 minute — something systemic
--   is wrong."
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. VIEW dead_letter_alerts — orgs with dead-letter spikes (last 5 min)
-- ---------------------------------------------------------------------------
-- One row per org that has at least one job in 'dead_letter' status whose
-- updated_at falls in the last 5 minutes. updated_at is the transition
-- timestamp: complete_job() sets updated_at = NOW() when it moves a job to
-- dead_letter, so filtering on updated_at = "when did this job die."
--
-- Why 5 minutes: matches the reclaim TTL (002 §4) and the cron sweep
-- cadence (003). 5 minutes is sensitive enough to catch real incidents
-- but not so noisy that a single bad job fires a spike alert.
--
-- Sample columns: up to 5 job IDs and 5 last_error strings, ordered by
-- updated_at DESC (most recent first) — enough for triage without
-- bloating the row. Postgres array slicing via [1:5] returns at most 5
-- elements (and gracefully returns fewer if the group is smaller).
--
-- HAVING COUNT(*) >= 1 is structurally redundant (the WHERE + GROUP BY
-- already exclude zero-count orgs) but kept for explicit documentation:
-- the view is for SURFACING, not zero-count noise.
--
-- security_invoker = true (PG 15+) makes the view run with the CALLER's
-- privileges and RLS context, not the view owner's. Without it, the view
-- would run as `postgres` (the migration user) and bypass RLS — exposing
-- every org's dead-letters to any authenticated client via PostgREST.
-- With it:
--   - authenticated client → RLS on jobs/organizations applies → sees
--     only their own org (safe to expose via a future admin UI)
--   - service-role (Worker cron) → BYPASSRLS → sees all orgs ✓
--   - postgres (pg_cron / SQL editor) → owner, bypasses RLS → sees all ✓
CREATE OR REPLACE VIEW dead_letter_alerts
WITH (security_invoker = true) AS
SELECT
  j.org_id,
  o.name AS org_name,
  COUNT(*)::INT AS dead_letter_count,
  MIN(j.updated_at) AS first_dead_letter_at,
  MAX(j.updated_at) AS last_dead_letter_at,
  to_jsonb((array_agg(j.id ORDER BY j.updated_at DESC))[1:5]) AS sample_job_ids,
  to_jsonb((array_agg(j.last_error ORDER BY j.updated_at DESC))[1:5]) AS sample_errors
FROM jobs j
JOIN organizations o ON o.id = j.org_id
WHERE j.status = 'dead_letter'
  AND j.updated_at > NOW() - INTERVAL '5 minutes'
GROUP BY j.org_id, o.name
HAVING COUNT(*) >= 1;

COMMENT ON VIEW dead_letter_alerts IS
  'Phase 5 stopgap (Point 3 of Phase 3 review: "Retry logic needs '
  'observability guard"). Surfaces orgs with at least one dead_letter job in '
  'the last 5 minutes, with up to 5 sample job IDs and error strings (most '
  'recent first) for triage. The full alerting pipeline (alertmanager / Slack '
  'webhook / PagerDuty) is Phase 5; until then, operators query this view '
  'manually from the SQL editor. security_invoker = true: an authenticated '
  'client querying the view sees only their own org (RLS on jobs/organizations '
  'applies); the service-role (cron / Worker) and postgres (SQL editor) bypass '
  'RLS and see all orgs. Complementary to /api/health/alerts, which is per-org '
  'pull only and has no spike detection.';

-- ---------------------------------------------------------------------------
-- §2. FUNCTION check_dead_letter_threshold — cron-callable threshold check
-- ---------------------------------------------------------------------------
-- Returns rows for orgs whose dead-letter count in the window EXCEEDS the
-- threshold. Each row carries a severity:
--   'CRITICAL' if count >= p_threshold * 2
--   'WARNING'  if count >= p_threshold
-- (HAVING COUNT(*) >= p_threshold guarantees every returned row has a
-- non-null severity — the CASE never falls through.)
--
-- Intended to be called by a cron job EVERY MINUTE. The natural
-- integration point is the existing consumer Worker's scheduled() handler
-- (apps/consumer/src/index.ts) which already runs every 1 minute and
-- calls reclaim_stuck_jobs_v2() — adding a check_dead_letter_threshold()
-- call in the same handler is a one-line change. Alternatively, a pg_cron
-- job can call it directly (mirroring the pattern in 003_pg_cron_*).
--
-- When the function returns ANY rows, an alert should fire. Phase 5 wires
-- the actual alert delivery (Slack for WARNING, PagerDuty for CRITICAL);
-- for now the function exists so operators can run it manually to inspect
-- current state.
--
-- Parameters are tunable without a code change:
--   p_threshold (default 5)      — alert when an org has >= this many
--                                  dead_letters in the window
--   p_window_minutes (default 5) — lookback window in minutes
-- Not SECURITY DEFINER: RLS on jobs/organizations applies based on the
-- caller, mirroring the view's security_invoker=true model. An
-- authenticated client calling this via PostgREST sees only their own
-- org's row (if it exceeds threshold) — safe, and actually useful for an
-- org admin self-checking. The cron (service-role) and operators
-- (postgres) bypass RLS and see ALL orgs, which is the intended use case
-- for spike detection across the whole tenant base.
CREATE OR REPLACE FUNCTION check_dead_letter_threshold(
  p_threshold INT DEFAULT 5,
  p_window_minutes INT DEFAULT 5
)
RETURNS TABLE(
  org_id UUID,
  org_name TEXT,
  dead_letter_count INT,
  first_dead_letter_at TIMESTAMPTZ,
  last_dead_letter_at TIMESTAMPTZ,
  sample_job_ids JSONB,
  sample_errors JSONB,
  severity TEXT
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_window INTERVAL := make_interval(mins => p_window_minutes);
BEGIN
  RETURN QUERY
  SELECT
    j.org_id,
    o.name AS org_name,
    COUNT(*)::INT AS dead_letter_count,
    MIN(j.updated_at) AS first_dead_letter_at,
    MAX(j.updated_at) AS last_dead_letter_at,
    to_jsonb((array_agg(j.id ORDER BY j.updated_at DESC))[1:5]) AS sample_job_ids,
    to_jsonb((array_agg(j.last_error ORDER BY j.updated_at DESC))[1:5]) AS sample_errors,
    CASE
      WHEN COUNT(*) >= p_threshold * 2 THEN 'CRITICAL'::TEXT
      WHEN COUNT(*) >= p_threshold     THEN 'WARNING'::TEXT
    END AS severity
  FROM jobs j
  JOIN organizations o ON o.id = j.org_id
  WHERE j.status = 'dead_letter'
    AND j.updated_at > NOW() - v_window
  GROUP BY j.org_id, o.name
  HAVING COUNT(*) >= p_threshold;
END;
$$;

COMMENT ON FUNCTION check_dead_letter_threshold IS
  'Phase 5 stopgap (Point 3 of Phase 3 review). Returns orgs whose '
  'dead_letter count in the last p_window_minutes minutes exceeds '
  'p_threshold, with severity CRITICAL (>= 2x threshold) or WARNING '
  '(>= threshold). Intended to be called by a cron job every minute '
  '(pg_cron or the consumer Worker scheduled() handler — see '
  'apps/consumer/src/index.ts, which already calls reclaim_stuck_jobs_v2() '
  'on the same cadence). When it returns rows, an alert should fire. Phase '
  '5 wires the actual alert delivery (alertmanager / Slack webhook / '
  'PagerDuty); for now operators query it manually. Threshold and window '
  'are parameterized so alerting sensitivity is tunable without a code '
  'change. NOT SECURITY DEFINER — RLS applies based on caller: cron '
  '(service-role, BYPASSRLS) and operators (postgres) see all orgs; an '
  'authenticated client sees only their own org. Same security model as '
  'the dead_letter_alerts view (security_invoker=true).';

-- ---------------------------------------------------------------------------
-- §3. FUNCTION detect_failure_patterns — leading-indicator pattern detection
-- ---------------------------------------------------------------------------
-- Scans the job_attempts ledger for failure patterns that typically PRECEDE
-- dead-letter spikes. By the time a job is in dead_letter, it's already too
-- late — but a tier that's been failing repeatedly for the last hour is a
-- strong predictor that dead_letters are about to spike. This function
-- gives operators LEADING indicators, complementing the LAGGING indicator
-- in §2 (which fires only after jobs are already dead).
--
-- Patterns:
--   repeated_tier_failure — same tier failing >= 3 times for an org in the
--                           window. Suggests a vendor issue (model down,
--                           rate-limited, prompt regression).
--   burst_failures        — >= 10 total failures across all tiers for an
--                           org in the window. Suggests a systemic issue
--                           (upload surge, bad batch of documents,
--                           downstream service down).
--   slow_tier_then_fail   — any tier with avg latency_ms > 30000 (30s) AND
--                           status='failure' in the window. A slow tier
--                           that also fails is a strong signal of a vendor
--                           issue (timeouts cascade into errors).
--
-- Parameters:
--   p_org_id (default NULL)       — scope to one org; NULL scans all orgs
--   p_window_minutes (default 60) — lookback window (default 1h; longer
--                                   than the alerting window because
--                                   patterns develop over time, not in
--                                   5-minute spikes)
--
-- Returns one row per (pattern, org_id, tier) match. tier is NULL for
-- burst_failures (it's an org-wide pattern, not a single tier).
-- Same security model as check_dead_letter_threshold: NOT SECURITY
-- DEFINER, RLS applies based on caller. An authenticated client calling
-- this sees only their own org's failure patterns (useful for an org
-- admin); service-role (cron) and postgres (operators) see all orgs.
CREATE OR REPLACE FUNCTION detect_failure_patterns(
  p_org_id UUID DEFAULT NULL,
  p_window_minutes INT DEFAULT 60
)
RETURNS TABLE(
  pattern TEXT,
  org_id UUID,
  tier TEXT,
  count INT,
  detail JSONB
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_window INTERVAL := make_interval(mins => p_window_minutes);
BEGIN
  -- Pattern 1: repeated_tier_failure
  -- Same org + tier failing >= 3 times in the window. The sample_errors
  -- array (up to 5, most recent first, NULLs filtered) gives the operator
  -- the actual error strings to triage without a second query.
  RETURN QUERY
  SELECT
    'repeated_tier_failure'::TEXT AS pattern,
    ja.org_id,
    ja.tier,
    COUNT(*)::INT AS count,
    jsonb_build_object(
      'window_minutes', p_window_minutes,
      'failure_count', COUNT(*)::INT,
      'sample_errors', COALESCE(
        to_jsonb(
          (array_agg(ja.error_message ORDER BY ja.created_at DESC)
            FILTER (WHERE ja.error_message IS NOT NULL))[1:5]
        ),
        '[]'::jsonb
      )
    ) AS detail
  FROM job_attempts ja
  WHERE ja.status = 'failure'
    AND ja.created_at > NOW() - v_window
    AND (p_org_id IS NULL OR ja.org_id = p_org_id)
  GROUP BY ja.org_id, ja.tier
  HAVING COUNT(*) >= 3;

  -- Pattern 2: burst_failures
  -- >= 10 total failures across ALL tiers for an org. tier is NULL because
  -- the pattern is org-wide. tiers_affected tells the operator whether
  -- it's one tier melting down (likely vendor) or all tiers (likely
  -- upstream of the pipeline — upload surge, bad batch).
  RETURN QUERY
  SELECT
    'burst_failures'::TEXT AS pattern,
    ja.org_id,
    NULL::TEXT AS tier,
    COUNT(*)::INT AS count,
    jsonb_build_object(
      'window_minutes', p_window_minutes,
      'total_failures', COUNT(*)::INT,
      'tiers_affected', COUNT(DISTINCT ja.tier)::INT
    ) AS detail
  FROM job_attempts ja
  WHERE ja.status = 'failure'
    AND ja.created_at > NOW() - v_window
    AND (p_org_id IS NULL OR ja.org_id = p_org_id)
  GROUP BY ja.org_id
  HAVING COUNT(*) >= 10;

  -- Pattern 3: slow_tier_then_fail
  -- Avg latency > 30s AND status='failure' for the tier in the window.
  -- A tier that's both slow AND failing is a vendor issue (timeouts
  -- cascading into errors). HAVING AVG(latency_ms) > 30000 is the actual
  -- threshold; the WHERE latency_ms IS NOT NULL just excludes rows where
  -- latency was never recorded (e.g., a tier that errored before timing).
  RETURN QUERY
  SELECT
    'slow_tier_then_fail'::TEXT AS pattern,
    ja.org_id,
    ja.tier,
    COUNT(*)::INT AS count,
    jsonb_build_object(
      'window_minutes', p_window_minutes,
      'avg_latency_ms', AVG(ja.latency_ms)::INT,
      'max_latency_ms', MAX(ja.latency_ms)::INT,
      'failure_count', COUNT(*)::INT
    ) AS detail
  FROM job_attempts ja
  WHERE ja.status = 'failure'
    AND ja.latency_ms IS NOT NULL
    AND ja.created_at > NOW() - v_window
    AND (p_org_id IS NULL OR ja.org_id = p_org_id)
  GROUP BY ja.org_id, ja.tier
  HAVING AVG(ja.latency_ms) > 30000;
END;
$$;

COMMENT ON FUNCTION detect_failure_patterns IS
  'Phase 5 stopgap (Point 3 of Phase 3 review). Detects failure patterns in '
  'the job_attempts ledger that typically precede dead-letter spikes: '
  'repeated_tier_failure (same org+tier failing >= 3x), burst_failures '
  '(>= 10 total failures across all tiers for an org), slow_tier_then_fail '
  '(avg latency_ms > 30s AND status=failure). Leading indicators '
  'complementing the lagging check_dead_letter_threshold() — by the time a '
  'job hits dead_letter it is too late; these patterns fire first. '
  'p_org_id NULL scans all orgs; p_window_minutes default 60 (patterns '
  'develop over time, longer than the 5-minute alerting window). The full '
  'pattern-dashboard integration is Phase 5; for now operators query it '
  'manually. NOT SECURITY DEFINER — same RLS-applies-to-caller model as '
  'check_dead_letter_threshold and the dead_letter_alerts view.';

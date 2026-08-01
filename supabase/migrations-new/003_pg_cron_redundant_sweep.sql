-- ============================================================================
-- 003_pg_cron_redundant_sweep.sql — Redundant dead-job recovery sweep
-- ============================================================================
-- PURPOSE (Phase 3, Step 3)
--   The Cloudflare Worker cron (apps/consumer/wrangler.toml, every 1 minute)
--   is the PRIMARY dead-job recovery sweep: it calls reclaim_stuck_jobs_v2()
--   to reset 'processing' jobs past the 5-minute TTL back to 'pending'.
--
--   This migration adds a SECONDARY sweep inside Postgres itself via pg_cron,
--   running the SAME query on a DIFFERENT schedule (every 2 minutes). This is
--   belt-and-suspenders: this is the ONE place in the whole pipeline where
--   "it ran twice by accident" is far less bad than "it never ran." If the
--   Worker cron is misconfigured, if Cloudflare has an outage, or if the
--   Worker's scheduled() handler silently fails, the pg_cron job still
--   catches stuck jobs.
--
--   The two sweeps are idempotent and non-conflicting: reclaim_stuck_jobs_v2
--   uses `WHERE status = 'processing' AND claimed_at < now() - interval '5 min'`
--   — once a job is reset to 'pending', neither sweep touches it again until
--   a consumer re-claims it.
--
-- PREREQUISITES
--   - 002_async_jobs.sql (defines reclaim_stuck_jobs_v2)
--   - pg_cron extension (must be enabled in the Supabase dashboard:
--     Database → Extensions → enable "pg_cron"). The CREATE EXTENSION below
--     is idempotent but may require superuser — on Supabase, run it via the
--     SQL editor if the migration fails in CI.
--
-- SCHEDULE RATIONALE
--   Worker cron: every 1 minute (primary — fast detection).
--   pg_cron:     every 2 minutes (secondary — redundant backstop).
--   The pg_cron runs LESS often intentionally: if both ran every 1 minute
--   and the Worker was healthy, pg_cron would always find zero stuck jobs
--   (the Worker already reset them). Running at 2 minutes means pg_cron
--   only does work when the Worker has been down for 2+ minutes — which is
--   exactly when we want the backstop to kick in.
-- ============================================================================

-- §1. Enable pg_cron (idempotent — may require superuser on some setups).
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- §2. Grant the postgres role permission to use cron (Supabase uses the
--      postgres role for migrations). On Supabase, pg_cron is already
--      available to the postgres user by default; this is a no-op safety.
GRANT USAGE ON SCHEMA extensions TO postgres;

-- §3. Schedule the redundant sweep. cron.schedule() is idempotent in
--      spirit but NOT in name — calling it twice with the same job name
--      creates two schedules. We unschedule first (IF EXISTS) to make this
--      migration re-runnable.
--
--      The cron expression '*/2 * * * *' = every 2 minutes.
--      The job calls reclaim_stuck_jobs_v2() (from 002_async_jobs.sql),
--      which resets stuck 'processing' jobs to 'pending'. The function
--      returns the count of reset jobs; we log it to a cron audit table
--      (§4 below) so operators can see the backstop firing.
DO $$
BEGIN
  -- Unschedule any existing version of this job (idempotent re-run).
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'clearport_redundant_stuck_sweep'
  ) THEN
    PERFORM cron.unschedule('clearport_redundant_stuck_sweep');
  END IF;

  -- Schedule the sweep. The SQL runs as the migrations user (postgres),
  -- which has access to reclaim_stuck_jobs_v2 (SECURITY DEFINER, public schema).
  PERFORM cron.schedule(
    jobname := 'clearport_redundant_stuck_sweep',
    schedule := '*/2 * * * *',
    command := $cmd$
      SELECT clearport_redundant_sweep_with_logging();
    $cmd$
  );

  EXCEPTION WHEN OTHERS THEN
    -- If pg_cron isn't available (e.g., local dev without the extension),
    -- log and continue — the Worker cron is the primary sweep anyway.
    RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END $$;

-- §4. Audit table — records every pg_cron sweep run. This lets operators
--      see how often the backstop fires (ideally never, if the Worker cron
--      is healthy). A non-zero count here is a signal the Worker cron may
--      be down.
CREATE TABLE IF NOT EXISTS cron_sweep_log (
  id BIGSERIAL PRIMARY KEY,
  sweep_source TEXT NOT NULL DEFAULT 'pg_cron',
  jobs_reset INTEGER NOT NULL DEFAULT 0,
  reset_job_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE cron_sweep_log ENABLE ROW LEVEL SECURITY;
-- Service-role only — no client policy. This is infra logging, not user data.

-- §5. Wrapper function that calls reclaim_stuck_jobs_v2() AND logs the
--      result to cron_sweep_log. This is what the cron job calls (§3).
--      SECURITY DEFINER so the cron job (running as postgres) can insert
--      into cron_sweep_log even with RLS enabled.
CREATE OR REPLACE FUNCTION clearport_redundant_sweep_with_logging()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_count INTEGER;
  v_reset_ids JSONB;
BEGIN
  -- Call the same reclaim function the Worker cron calls.
  SELECT reclaim_stuck_jobs_v2() INTO v_count;

  -- Capture which job IDs were reset (for the audit log). This mirrors
  -- the Worker's scheduled() handler behavior of logging each reset job.
  SELECT COALESCE(jsonb_agg(id), '[]'::jsonb) INTO v_reset_ids
  FROM jobs
  WHERE status = 'pending'
    AND claimed_at IS NULL
    AND attempts > 0
    AND updated_at > NOW() - INTERVAL '1 minute';

  -- Log the sweep result. Even a zero-count run is logged so operators
  -- can confirm the backstop is alive (a table with zero recent rows
  -- means pg_cron itself is down).
  INSERT INTO cron_sweep_log (sweep_source, jobs_reset, reset_job_ids)
  VALUES ('pg_cron', v_count, v_reset_ids);

  RETURN v_count;
END;
$$;

-- §6. Comment
COMMENT ON TABLE cron_sweep_log IS
  'Audit log for the pg_cron redundant dead-job sweep (Phase 3 Step 3). '
  'Each row = one sweep run. jobs_reset > 0 means the primary Worker cron '
  'missed stuck jobs — investigate Worker health. A table with NO recent '
  'rows means pg_cron itself is down. The Worker cron (every 1 min) is '
  'primary; this pg_cron (every 2 min) is the backstop.';
COMMENT ON FUNCTION clearport_redundant_sweep_with_logging IS
  'Called by pg_cron every 2 minutes. Runs reclaim_stuck_jobs_v2() (same as '
  'the Worker cron) and logs the result to cron_sweep_log. Belt-and-suspenders: '
  'the one place where "ran twice by accident" << "never ran".';

-- ============================================================================
-- 021_reconcile_stuck_jobs.sql — Reconcile stuck processing_jobs rows
-- ============================================================================
-- If the worker is killed mid-job (crash, OOM, deploy, restart), the job it
-- was holding stays in 'processing' status forever. This migration adds a
-- reconciliation function that finds jobs stuck in 'processing' for >5 minutes
-- and either resets them to 'queued' (if under max_attempts) or moves them to
-- 'dead_letter' (if attempts exhausted).
--
-- Follows the same pg_cron pattern as migration 013 (stuck document
-- reconciliation).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- reclaim_stuck_jobs() — find and reclaim abandoned processing_jobs rows
-- ---------------------------------------------------------------------------
-- Called by pg_cron every 5 minutes. Finds rows where:
--   status = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes'
--
-- For each stuck job:
--   - If attempts < max_attempts: reset to 'queued' (a healthy worker picks
--     it up on its next poll)
--   - If attempts >= max_attempts: move to 'dead_letter' with an error_history
--     entry noting it was reclaimed after a worker timeout
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reclaim_stuck_jobs()
RETURNS TABLE(reclaimed_count INTEGER, dead_lettered_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_stuck RECORD;
  v_reclaimed INTEGER := 0;
  v_dead_lettered INTEGER := 0;
  v_new_status TEXT;
  v_history_entry JSONB;
BEGIN
  FOR v_stuck IN
    SELECT id, attempts, max_attempts, error_history
    FROM processing_jobs
    WHERE status = 'processing'
      AND claimed_at IS NOT NULL
      AND claimed_at < NOW() - INTERVAL '5 minutes'
  LOOP
    -- Build the error_history entry for this reclamation
    v_history_entry := jsonb_build_object(
      'attempt', v_stuck.attempts,
      'error', 'Job reclaimed after worker timeout (stuck in processing for >5 minutes)',
      'timestamp', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'reclaimed', true
    );

    -- Decide: retry or dead-letter
    IF v_stuck.attempts >= v_stuck.max_attempts THEN
      v_new_status := 'dead_letter';
      v_dead_lettered := v_dead_lettered + 1;
    ELSE
      v_new_status := 'queued';
      v_reclaimed := v_reclaimed + 1;
    END IF;

    -- Update the job: reset status, append to error_history, clear claimed_at
    UPDATE processing_jobs
    SET
      status = v_new_status,
      error_history = v_stuck.error_history || v_history_entry,
      claimed_at = NULL,
      updated_at = NOW()
    WHERE id = v_stuck.id;
  END LOOP;

  -- Return counts for logging/monitoring
  reclaimed_count := v_reclaimed;
  dead_lettered_count := v_dead_lettered;
  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Schedule the reconciliation via pg_cron (every 5 minutes)
-- ---------------------------------------------------------------------------
-- Follows the same pattern as migration 013's stuck-document reconciliation.
-- Uses the same cron schedule convention (every N minutes).
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'reclaim-stuck-jobs',
  '*/5 * * * *',
  $$SELECT reclaim_stuck_jobs();$$
);

-- Comment for documentation
COMMENT ON FUNCTION reclaim_stuck_jobs() IS
  'Finds processing_jobs stuck in processing for >5 min and resets to queued (retry) or dead_letter (exhausted). Scheduled via pg_cron every 5 min.';

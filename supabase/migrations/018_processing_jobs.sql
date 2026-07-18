-- ============================================================================
-- 018_processing_jobs.sql — Durable queue for extraction/validation pipeline
-- ============================================================================
-- Decouples upload from extraction. Instead of the upload request path
-- synchronously invoking the extract-document edge function, the upload path
-- writes a 'queued' row to processing_jobs. A standalone worker process
-- (mini-services/worker/) polls this table, claims jobs via
-- SELECT ... FOR UPDATE SKIP LOCKED (race-free), runs the extraction pipeline,
-- and updates the job + shipment status on completion.
--
-- Dead-letter path: after max_attempts (3 by default), a job moves to
-- 'dead_letter' status with full failure history. The /api/health/alerts
-- endpoint surfaces dead_letter jobs as a critical alert.
-- ============================================================================

CREATE TABLE IF NOT EXISTS processing_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id TEXT NOT NULL,
  document_id UUID,  -- NULL for shipment-level jobs (extraction across all docs)
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('extraction', 'validation')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  trace_id TEXT NOT NULL,
  content_hash TEXT,  -- for idempotency: SHA-256 of (shipment_id + document_ids + file hashes)
  error_history JSONB DEFAULT '[]'::jsonb,  -- [{attempt, error, timestamp}]
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient polling + status queries
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status ON processing_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_shipment ON processing_jobs(shipment_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_org ON processing_jobs(org_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_content_hash ON processing_jobs(content_hash) WHERE content_hash IS NOT NULL;

-- Enable RLS — org-scoped like all other tables
ALTER TABLE processing_jobs ENABLE ROW LEVEL SECURITY;

-- Members can read their org's jobs (for status visibility in the UI)
CREATE POLICY "org_members_read_own_jobs" ON processing_jobs
  FOR SELECT TO authenticated
  USING (is_org_member(org_id, auth.uid()));

-- Members can insert jobs for their org (the upload path creates these)
CREATE POLICY "org_members_insert_own_jobs" ON processing_jobs
  FOR INSERT TO authenticated
  WITH CHECK (is_org_member(org_id, auth.uid()));

-- Members can update their org's jobs (worker claims/completions)
CREATE POLICY "org_members_update_own_jobs" ON processing_jobs
  FOR UPDATE TO authenticated
  USING (is_org_member(org_id, auth.uid()));

-- ---------------------------------------------------------------------------
-- claim_next_job() — atomic job claim using FOR UPDATE SKIP LOCKED
-- ---------------------------------------------------------------------------
-- Called by the worker process. Atomically selects the oldest 'queued' job,
-- marks it as 'processing', increments attempts, and returns the full job row.
-- FOR UPDATE SKIP LOCKED ensures multiple worker instances don't double-claim.
-- SECURITY DEFINER so it can run with the service role (bypassing RLS for the
-- atomic update-with-return).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_next_job(p_worker_id TEXT DEFAULT 'default')
RETURNS TABLE(
  id UUID, shipment_id TEXT, document_id UUID, org_id UUID, job_type TEXT,
  status TEXT, attempts INTEGER, max_attempts INTEGER, trace_id TEXT,
  content_hash TEXT, error_history JSONB, created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_job RECORD;
BEGIN
  -- Atomically claim the oldest queued job
  SELECT * INTO v_job
  FROM processing_jobs
  WHERE status = 'queued'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN;  -- no jobs available
  END IF;

  -- Mark as processing
  UPDATE processing_jobs
  SET
    status = 'processing',
    attempts = attempts + 1,
    claimed_at = NOW(),
    updated_at = NOW()
  WHERE id = v_job.id
  RETURNING
    id, shipment_id, document_id, org_id, job_type, status, attempts,
    max_attempts, trace_id, content_hash, error_history, created_at
  INTO
    id, shipment_id, document_id, org_id, job_type, status, attempts,
    max_attempts, trace_id, content_hash, error_history, created_at;

  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- complete_job(p_job_id UUID, p_success BOOLEAN, p_error TEXT)
-- ---------------------------------------------------------------------------
-- Marks a job as completed (success) or failed (error). On failure, if
-- attempts < max_attempts, the job goes back to 'queued' for retry. If
-- attempts >= max_attempts, the job moves to 'dead_letter'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION complete_job(
  p_job_id UUID,
  p_success BOOLEAN,
  p_error TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_job RECORD;
  v_new_status TEXT;
  v_history JSONB;
BEGIN
  SELECT * INTO v_job FROM processing_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_success THEN
    v_new_status := 'completed';
    v_history := v_job.error_history;
  ELSE
    -- Append error to history
    v_history := v_job.error_history || jsonb_build_object(
      'attempt', v_job.attempts,
      'error', COALESCE(p_error, 'Unknown error'),
      'timestamp', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );

    -- Check if we should dead-letter or retry
    IF v_job.attempts >= v_job.max_attempts THEN
      v_new_status := 'dead_letter';
    ELSE
      v_new_status := 'queued';  -- retry
    END IF;
  END IF;

  UPDATE processing_jobs
  SET
    status = v_new_status,
    error_history = v_history,
    completed_at = CASE WHEN p_success THEN NOW() ELSE NULL END,
    updated_at = NOW()
  WHERE id = p_job_id;
END;
$$;

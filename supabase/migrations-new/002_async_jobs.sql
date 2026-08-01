-- ============================================================================
-- 002_async_jobs.sql — Durable async job queue + per-tier attempt ledger
-- ============================================================================
-- PURPOSE
--   The extraction pipeline must be durable: uploads return 202 instantly,
--   a worker claims the job, runs extraction across multiple tiers
--   (AI / regex / manual), and records each tier's outcome. This migration
--   defines the `jobs` table (idempotent queue) + `job_attempts` table
--   (per-tier audit ledger, the successor to extraction_attempts from
--   migration 017) + the claim/complete functions with a 5-minute TTL
--   auto-recovery for crashed workers.
--
-- RELATIONSHIP TO EXISTING TABLES
--   - `processing_jobs` (migration 018) is kept for backward compat with
--     the live worker. `jobs` is the new canonical queue: it adds
--     `idempotency_key` (dedup) and `status` values tuned for the async-202
--     flow (`pending` not `queued`). New code uses `jobs`.
--   - `job_attempts` generalizes `extraction_attempts` (migration 017):
--     instead of one row per *tier* it's one row per *attempt* per *tier*,
--     so retries within a tier are all recorded. `tier` is a TEXT label
--     (e.g. 'openrouter_qwen3_vl_32b', 'tesseract_fallback') rather than
--     an integer, so new extractors don't need a migration to be recorded.
--
-- RUNS AFTER
--   001_baseline_schema.sql (needs organizations + is_org_member).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. jobs — the durable, idempotent queue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,                       -- no FK: auth.users lives in auth schema
  shipment_id TEXT NOT NULL,
  document_id UUID,
  -- Idempotency: (org_id, idempotency_key) UNIQUE means a retried upload
  -- with the same key returns the existing job instead of creating a
  -- duplicate. The client generates the key as SHA-256(shipment_id + file hash).
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  last_error TEXT,
  result JSONB,                                -- pipeline output (fields, confidence, decision)
  claimed_at TIMESTAMPTZ,                       -- set when a worker claims; used for TTL
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, idempotency_key)
);

-- Optimization: index for claiming pending jobs (oldest first) and for
-- sweeping stuck 'processing' jobs past the 5-minute TTL.
CREATE INDEX IF NOT EXISTS idx_jobs_claimable
  ON jobs (status, created_at, claimed_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_jobs_dead_sweep
  ON jobs (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_jobs_org_shipment
  ON jobs (org_id, shipment_id);

-- ---------------------------------------------------------------------------
-- §2. job_attempts — per-tier, per-attempt audit ledger
-- ---------------------------------------------------------------------------
-- One row per (job, attempt, tier). For a job that retried 3 times across
-- 2 tiers, this table holds up to 6 rows — the full forensic history.
-- Written exclusively by the worker via service-role; org members read-only.
CREATE TABLE IF NOT EXISTS job_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  attempt_number INT NOT NULL,                  -- matches jobs.attempts at the time
  tier TEXT NOT NULL,                           -- e.g. 'openrouter_qwen3_vl_32b', 'tesseract_fallback'
  status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'skipped')),
  fields_extracted INT,
  latency_ms INT,
  error_message TEXT,
  result JSONB,                                 -- tier-specific output for debugging
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_job_attempts_org_tier ON job_attempts(org_id, tier, status);

-- ---------------------------------------------------------------------------
-- §3. RLS — org-scoped read for members; writes via service-role only
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_members_read_jobs" ON jobs;
CREATE POLICY "org_members_read_jobs" ON jobs
  FOR SELECT TO authenticated
  USING (is_org_member(org_id, auth.uid()));

-- Members can INSERT jobs for their own org (the upload path creates these).
DROP POLICY IF EXISTS "org_members_insert_jobs" ON jobs;
CREATE POLICY "org_members_insert_jobs" ON jobs
  FOR INSERT TO authenticated
  WITH CHECK (is_org_member(org_id, auth.uid()));

-- UPDATE/DELETE: service-role only (the worker claims/completes). No client
-- policy = clients cannot mutate job state, preventing status tampering.

DROP POLICY IF EXISTS "org_members_read_job_attempts" ON job_attempts;
CREATE POLICY "org_members_read_job_attempts" ON job_attempts
  FOR SELECT TO authenticated
  USING (is_org_member(org_id, auth.uid()));

-- ---------------------------------------------------------------------------
-- §4. claim_job(p_job_id) — atomic claim with 5-minute TTL auto-recovery
-- ---------------------------------------------------------------------------
-- The worker calls this to claim a specific pending job. The WHERE clause
-- accepts EITHER a 'pending' job OR a 'processing' job whose claimed_at is
-- older than 5 minutes — the latter is the TTL recovery: a worker that
-- crashed mid-extraction leaves the job in 'processing' forever without it.
-- The atomic UPDATE ... RETURNING means two workers racing for the same job
-- can't both win.
--
-- Security: SECURITY DEFINER so the worker (service-role) can update status
-- atomically. Runs with SET search_path = public to avoid schema injection.
CREATE OR REPLACE FUNCTION claim_job(p_job_id UUID)
RETURNS TABLE(
  id UUID, org_id UUID, user_id UUID, shipment_id TEXT, document_id UUID,
  idempotency_key TEXT, status TEXT, attempts INT, max_attempts INT,
  result JSONB, claimed_at TIMESTAMPTZ, created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
BEGIN
  UPDATE jobs
  SET
    status = 'processing',
    claimed_at = v_now,
    attempts = attempts + 1,
    updated_at = v_now
  WHERE id = p_job_id
    AND (
      status = 'pending'
      OR (status = 'processing' AND claimed_at < v_now - INTERVAL '5 minutes')
    )
  RETURNING
    id, org_id, user_id, shipment_id, document_id, idempotency_key,
    status, attempts, max_attempts, result, claimed_at, created_at
  INTO
    id, org_id, user_id, shipment_id, document_id, idempotency_key,
    status, attempts, max_attempts, result, claimed_at, created_at;

  IF id IS NULL THEN
    -- Job not claimable: already being processed (within TTL) or in a
    -- terminal state. Return empty result set.
    RETURN;
  END IF;

  RETURN NEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- §5. claim_next_pending_job() — claim the oldest pending job (no id needed)
-- ---------------------------------------------------------------------------
-- Used by the worker's poll loop. Equivalent to claim_job but picks the
-- oldest pending job itself. FOR UPDATE SKIP LOCKED prevents two worker
-- instances from grabbing the same job.
CREATE OR REPLACE FUNCTION claim_next_pending_job()
RETURNS TABLE(
  id UUID, org_id UUID, user_id UUID, shipment_id TEXT, document_id UUID,
  idempotency_key TEXT, status TEXT, attempts INT, max_attempts INT,
  result JSONB, claimed_at TIMESTAMPTZ, created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_id UUID;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- Find the oldest claimable job (pending OR stuck-processing).
  SELECT id INTO v_target_id
  FROM jobs
  WHERE status = 'pending'
     OR (status = 'processing' AND claimed_at < v_now - INTERVAL '5 minutes')
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_target_id IS NULL THEN
    RETURN;  -- no claimable jobs
  END IF;

  -- Reuse claim_job for the atomic update.
  PERFORM claim_job(v_target_id);

  -- Return the now-claimed row.
  RETURN QUERY
  SELECT id, org_id, user_id, shipment_id, document_id, idempotency_key,
         status, attempts, max_attempts, result, claimed_at, created_at
  FROM jobs
  WHERE id = v_target_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- §6. complete_job(p_job_id, p_success, p_error, p_result)
-- ---------------------------------------------------------------------------
-- Marks a job completed or failed. On failure: if attempts < max_attempts,
-- the job goes back to 'pending' for retry (claimed_at cleared so it's
-- immediately claimable); otherwise it moves to 'dead_letter' (terminal,
-- surfaced in /api/health/alerts).
CREATE OR REPLACE FUNCTION complete_job(
  p_job_id UUID,
  p_success BOOLEAN,
  p_error TEXT DEFAULT NULL,
  p_result JSONB DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_new_status TEXT;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_success THEN
    v_new_status := 'completed';
  ELSIF v_job.attempts >= v_job.max_attempts THEN
    v_new_status := 'dead_letter';
  ELSE
    v_new_status := 'pending';  -- retry: clear claimed_at so it's immediately claimable
  END IF;

  UPDATE jobs
  SET
    status = v_new_status,
    last_error = CASE WHEN p_success THEN NULL ELSE p_error END,
    result = CASE WHEN p_success THEN COALESCE(p_result, result) ELSE result END,
    claimed_at = CASE WHEN v_new_status = 'pending' THEN NULL ELSE claimed_at END,
    updated_at = NOW()
  WHERE id = p_job_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- §7. record_job_attempt(...) — append a tier outcome to the ledger
-- ---------------------------------------------------------------------------
-- Called by the worker after each tier runs (success/failure/skipped).
-- Separate from complete_job because a single job may run multiple tiers
-- before completing — each tier gets its own audit row.
CREATE OR REPLACE FUNCTION record_job_attempt(
  p_job_id UUID,
  p_org_id UUID,
  p_attempt_number INT,
  p_tier TEXT,
  p_status TEXT,
  p_fields_extracted INT DEFAULT NULL,
  p_latency_ms INT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_result JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_status NOT IN ('success', 'failure', 'skipped') THEN
    RAISE EXCEPTION 'Invalid attempt status: %', p_status;
  END IF;
  INSERT INTO job_attempts (
    job_id, org_id, attempt_number, tier, status,
    fields_extracted, latency_ms, error_message, result
  ) VALUES (
    p_job_id, p_org_id, p_attempt_number, p_tier, p_status,
    p_fields_extracted, p_latency_ms, p_error_message, p_result
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- §8. reclaim_stuck_jobs() — sweep all jobs past the TTL (cron-callable)
-- ---------------------------------------------------------------------------
-- A cron job (pg_cron or external) should call this every minute. It resets
-- any 'processing' job past the 5-minute TTL back to 'pending' so a crashed
-- worker doesn't permanently block the queue.
CREATE OR REPLACE FUNCTION reclaim_stuck_jobs_v2()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE jobs
  SET status = 'pending', claimed_at = NULL, updated_at = NOW()
  WHERE status = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- §9. get_or_create_job(...) — idempotent job creation
-- ---------------------------------------------------------------------------
-- The upload path calls this. If a job with the same (org_id, idempotency_key)
-- already exists, it returns the existing job (whether pending/processing/
-- completed). This makes the upload idempotent: a client retry after a
-- network blip doesn't create a duplicate extraction.
CREATE OR REPLACE FUNCTION get_or_create_job(
  p_org_id UUID,
  p_user_id UUID,
  p_shipment_id TEXT,
  p_document_id UUID DEFAULT NULL,
  p_idempotency_key TEXT,
  p_max_attempts INT DEFAULT 3
)
RETURNS TABLE(
  id UUID, status TEXT, attempts INT, result JSONB, created_now BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing RECORD;
  v_new_id UUID;
BEGIN
  -- Try to find an existing job with the same idempotency key.
  SELECT id, status, attempts, result INTO v_existing
  FROM jobs
  WHERE org_id = p_org_id AND idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    -- Return the existing job. The client can poll its status.
    -- 'dead_letter' jobs are revived: reset to pending so a retry can
    -- actually attempt again (the operator explicitly re-uploaded).
    IF v_existing.status = 'dead_letter' THEN
      UPDATE jobs
      SET status = 'pending', attempts = 0, last_error = NULL,
          claimed_at = NULL, updated_at = NOW()
      WHERE id = v_existing.id;
      RETURN QUERY SELECT v_existing.id, 'pending'::TEXT, 0, NULL::JSONB, FALSE;
    ELSE
      RETURN QUERY SELECT v_existing.id, v_existing.status, v_existing.attempts,
                          v_existing.result, FALSE;
    END IF;
    RETURN;
  END IF;

  -- No existing job — create one.
  INSERT INTO jobs (org_id, user_id, shipment_id, document_id, idempotency_key, max_attempts)
  VALUES (p_org_id, p_user_id, p_shipment_id, p_document_id, p_idempotency_key, p_max_attempts)
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT v_new_id, 'pending'::TEXT, 0, NULL::JSONB, TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- §10. Comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE jobs IS
  'Durable async extraction queue. (org_id, idempotency_key) UNIQUE makes '
  'uploads idempotent. Workers claim via claim_job/claim_next_pending_job; '
  'crashed workers are auto-recovered after 5 minutes (claimed_at TTL).';
COMMENT ON TABLE job_attempts IS
  'Per-tier, per-attempt audit ledger. Successor to extraction_attempts: '
  'one row per (job, attempt, tier). Written by service-role only; org '
  'members read-only. Forensic record of every extraction attempt.';
COMMENT ON FUNCTION claim_job IS
  'Atomic claim with 5-minute TTL recovery. Accepts pending jobs AND '
  'processing jobs whose claimed_at is > 5 min old (crashed worker recovery).';
COMMENT ON FUNCTION get_or_create_job IS
  'Idempotent job creation. Returns existing job for the same idempotency_key, '
  'reviving dead_letter jobs back to pending on re-upload.';

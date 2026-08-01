-- ============================================================================
-- 005_fencing_token.sql — Prevent double-processing when cron TTL fires mid-extraction
-- ============================================================================
-- THE PROBLEM (Point 4 from the Phase 3 review)
--   claim_job's TTL clause is: `status='processing' AND claimed_at < now() -
--   interval '5 minutes'`. If a consumer is legitimately still extracting
--   at the 5-minute mark (Phase 4's real pipeline may exceed this on large
--   PDFs), the cron sweep reclaims the job → a SECOND consumer claims it →
--   BOTH consumers run the pipeline → double-processing: duplicate
--   document_fields rows, duplicate job_attempts, conflicting complete_job
--   calls. This is the "real risk once extraction starts" the review
--   flagged.
--
--   The 5-minute TTL is a GUESS (Phase 4 measures p99 and tunes it). But no
--   matter what TTL we pick, there's always a window where a slow-but-
--   legitimate consumer overlaps with a cron-reclaimed job. We need a
--   defense that works INDEPENDENT of the TTL value.
--
-- THE FIX: fencing tokens
--   1. claim_job stamps a `claim_token` (UUID) on the job when it claims.
--      The consumer receives this token in the RETURNING row.
--   2. complete_job + record_job_attempt take a `p_claim_token` parameter.
--      They verify the token matches the job's CURRENT claim_token BEFORE
--      writing. If the cron reclaimed the job, the claim_token changed —
--      the stale consumer's write is REJECTED (0 rows affected).
--   3. The stale consumer sees the rejection and exits WITHOUT writing
--      results. No double-processing.
--
--   This is the "fencing token" pattern (Martin Kleppmann, Distributed
--   Systems): the token is a monotonic per-claim unique value that makes
--   stale writes detectable. It works regardless of TTL value — even if
--   the TTL is too aggressive, the worst case is a wasted extraction (the
--   stale consumer's work is discarded), NOT duplicate writes.
--
-- COST
--   One UUID column + one token-equality check per write. Negligible vs.
--   the pipeline latency it protects.
--
-- PREREQUISITES
--   - 002_async_jobs.sql (defines jobs, claim_job, complete_job,
--     record_job_attempt). This migration REPLACES those functions.
-- ============================================================================

-- §1. Add claim_token column to jobs.
--      NULL when status='pending' (never claimed) or after complete_job
--      (terminal). Set by claim_job, checked by complete_job +
--      record_job_attempt.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claim_token UUID;

-- Index for the fencing check (complete_job looks up by id + claim_token).
-- The PK on id already covers this, but an explicit composite index makes
-- the intent clear and the query plan obvious.
CREATE INDEX IF NOT EXISTS idx_jobs_id_claim_token
  ON jobs (id, claim_token)
  WHERE claim_token IS NOT NULL;

-- §2. claim_job(p_job_id) — REPLACEMENT with fencing token.
--      Now stamps a fresh claim_token (gen_random_uuid) on claim. The
--      consumer receives this token and must pass it to complete_job +
--      record_job_attempt. If the cron reclaims the job, a NEW token is
--      stamped — the old consumer's token is now stale.
CREATE OR REPLACE FUNCTION claim_job(p_job_id UUID)
RETURNS TABLE(
  id UUID, org_id UUID, user_id UUID, shipment_id TEXT, document_id UUID,
  idempotency_key TEXT, status TEXT, attempts INT, max_attempts INT,
  result JSONB, claimed_at TIMESTAMPTZ, created_at TIMESTAMPTZ,
  claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_new_token UUID := gen_random_uuid();
BEGIN
  UPDATE jobs
  SET
    status = 'processing',
    claimed_at = v_now,
    attempts = attempts + 1,
    claim_token = v_new_token,
    updated_at = v_now
  WHERE id = p_job_id
    AND (
      status = 'pending'
      OR (status = 'processing' AND claimed_at < v_now - INTERVAL '5 minutes')
    )
  RETURNING
    id, org_id, user_id, shipment_id, document_id, idempotency_key,
    status, attempts, max_attempts, result, claimed_at, created_at,
    claim_token
  INTO
    id, org_id, user_id, shipment_id, document_id, idempotency_key,
    status, attempts, max_attempts, result, claimed_at, created_at,
    claim_token;

  IF id IS NULL THEN
    -- Job not claimable: already being processed (within TTL) or terminal.
    RETURN;
  END IF;

  RETURN NEXT;
END;
$$;

-- §3. complete_job(p_job_id, p_claim_token, p_success, p_error, p_result)
--      REPLACEMENT with fencing token verification.
--
--      The WHERE clause now requires claim_token = p_claim_token. If the
--      cron reclaimed the job (new token), this UPDATE affects 0 rows —
--      the stale consumer's completion is silently dropped. The consumer
--      detects this via the returned row count and exits without error
--      (its work is discarded, but no duplicate writes happened).
--
--      Returns BOOLEAN: TRUE if the completion was applied, FALSE if the
--      token was stale (rejected). The consumer logs the rejection but
--      does NOT treat it as a failure (no retry, no dead-letter — the
--      NEW consumer that won the reclaim is handling the job).
CREATE OR REPLACE FUNCTION complete_job(
  p_job_id UUID,
  p_claim_token UUID,
  p_success BOOLEAN,
  p_error TEXT DEFAULT NULL,
  p_result JSONB DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_new_status TEXT;
  v_rows_affected INT;
BEGIN
  -- Lock the row FOR UPDATE and verify the token in one step. If the token
  -- doesn't match (cron reclaimed), v_job is NULL and we return FALSE.
  SELECT * INTO v_job
  FROM jobs
  WHERE id = p_job_id AND claim_token = p_claim_token
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Fencing rejection: the token is stale. The job was reclaimed by the
    -- cron sweep and a different consumer is now (or will be) processing
    -- it. This consumer's completion is dropped — no duplicate writes.
    RETURN FALSE;
  END IF;

  IF p_success THEN
    v_new_status := 'completed';
  ELSIF v_job.attempts >= v_job.max_attempts THEN
    v_new_status := 'dead_letter';
  ELSE
    v_new_status := 'pending';
  END IF;

  UPDATE jobs
  SET
    status = v_new_status,
    last_error = CASE WHEN p_success THEN NULL ELSE p_error END,
    result = CASE WHEN p_success THEN COALESCE(p_result, result) ELSE result END,
    claimed_at = CASE WHEN v_new_status = 'pending' THEN NULL ELSE claimed_at END,
    -- Clear the token on terminal/pending states so a stale token can't
    -- accidentally match a future claim (claim_job generates a fresh UUID).
    claim_token = CASE WHEN v_new_status IN ('completed', 'dead_letter', 'pending')
                       THEN NULL ELSE claim_token END,
    updated_at = NOW()
  WHERE id = p_job_id AND claim_token = p_claim_token;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RETURN v_rows_affected > 0;
END;
$$;

-- §4. record_job_attempt(...) — REPLACEMENT with fencing token verification.
--      The audit ledger must NOT record attempts from a stale consumer
--      (that would pollute the ledger with phantom attempts). The token
--      check ensures only the CURRENT claimant can write attempt rows.
--
--      Returns UUID (the attempt row id) or NULL if the token was stale.
CREATE OR REPLACE FUNCTION record_job_attempt(
  p_job_id UUID,
  p_claim_token UUID,
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
  v_job_exists BOOLEAN;
BEGIN
  IF p_status NOT IN ('success', 'failure', 'skipped') THEN
    RAISE EXCEPTION 'Invalid attempt status: %', p_status;
  END IF;

  -- Fencing check: verify the token matches the job's current claim.
  SELECT EXISTS(
    SELECT 1 FROM jobs WHERE id = p_job_id AND claim_token = p_claim_token
  ) INTO v_job_exists;

  IF NOT v_job_exists THEN
    -- Stale token — the job was reclaimed. Do NOT write the attempt row;
    -- a phantom ledger entry from a stale consumer would be misleading.
    RETURN NULL;
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

-- §5. reclaim_stuck_jobs_v2() — REPLACEMENT: stamps a NULL token on reclaim
--      so any in-flight stale consumer's token immediately becomes invalid.
--      (claim_job generates a fresh token when the next consumer claims.)
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
  SET status = 'pending',
      claimed_at = NULL,
      -- Invalidate any in-flight consumer's token. Their next
      -- complete_job / record_job_attempt call will be rejected.
      claim_token = NULL,
      updated_at = NOW()
  WHERE status = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- §6. claim_next_pending_job() — REPLACEMENT to return the claim_token.
CREATE OR REPLACE FUNCTION claim_next_pending_job()
RETURNS TABLE(
  id UUID, org_id UUID, user_id UUID, shipment_id TEXT, document_id UUID,
  idempotency_key TEXT, status TEXT, attempts INT, max_attempts INT,
  result JSONB, claimed_at TIMESTAMPTZ, created_at TIMESTAMPTZ,
  claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_id UUID;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  SELECT id INTO v_target_id
  FROM jobs
  WHERE status = 'pending'
     OR (status = 'processing' AND claimed_at < v_now - INTERVAL '5 minutes')
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_target_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM claim_job(v_target_id);

  RETURN QUERY
  SELECT id, org_id, user_id, shipment_id, document_id, idempotency_key,
         status, attempts, max_attempts, result, claimed_at, created_at,
         claim_token
  FROM jobs
  WHERE id = v_target_id;
END;
$$;

-- §7. Comments
COMMENT ON COLUMN jobs.claim_token IS
  'Fencing token (UUID) stamped by claim_job. complete_job + record_job_attempt '
  'verify this token before writing, preventing double-processing when the cron '
  'TTL reclaims a job mid-extraction. NULL on pending/terminal states.';
COMMENT ON FUNCTION complete_job IS
  'Fencing-protected completion: returns FALSE if p_claim_token is stale '
  '(job was reclaimed). The stale consumer discards its work; no duplicate writes.';
COMMENT ON FUNCTION record_job_attempt IS
  'Fencing-protected ledger write: returns NULL if p_claim_token is stale. '
  'Prevents phantom attempt rows from a consumer whose claim was reclaimed.';

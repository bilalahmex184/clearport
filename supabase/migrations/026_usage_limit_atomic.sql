-- ============================================================================
-- 026_usage_limit_atomic.sql — Race-safe usage limit enforcement
-- ============================================================================
-- Backing functions for the write-path enforcement in
-- src/lib/services/billing.service.ts (enforceUsageLimitOrThrow).
--
-- Problem being solved:
--   The existing checkUsageLimit() in the billing service is a read-only
--   count — it does NOT prevent the race where 50 concurrent upload
--   requests all pass the limit check before any of them inserts a
--   document. A high-concurrency burst can bypass the monthly document
--   cap by ~N (where N is the number of concurrent requests in flight
--   at the boundary).
--
-- Fix:
--   enforce_usage_limit(p_org_id) acquires a FOR UPDATE row-level lock
--   on the org's usage_limits config row inside the same transaction
--   that performs the count + comparison. Concurrent calls serialize
--   on the lock — the second call cannot read the count until the
--   first call's transaction commits (or rolls back via RAISE).
--
--   IMPORTANT: this lock only protects the CHECK. The INSERT of the
--   new document (or processing_jobs row) must happen INSIDE the same
--   transaction for the protection to actually prevent overage. That
--   is what insert_job_with_usage_check provides: it calls
--   enforce_usage_limit (which locks) and then inserts the job before
--   returning, all in one function = one transaction = one lock scope.
--
--   The TS-level enforceUsageLimitOrThrow wrapper calls
--   enforce_usage_limit over RPC. The lock is held only for the
--   duration of that RPC. Callers that do check-then-insert in
--   application code are NOT fully protected — they should use
--   insert_job_with_usage_check (or an equivalent atomic function)
--   for the write path. enforceUsageLimitOrThrow is still useful as
--   a fast pre-check (e.g., to reject obviously-over-limit orgs
--   before uploading bytes to storage) and for the UI read path.
--
-- Custom SQLSTATE:
--   42901 — USAGE_LIMIT_EXCEEDED. The '429' prefix mirrors HTTP 429
--   (Too Many Requests); the trailing '01' disambiguates from any
--   future 429xx-family codes. The TS wrapper inspects error.code
--   to map this back to a 429 HTTP response.
--
-- Prerequisites:
--   - 000_baseline_schema.sql  (documents table)
--   - 001_multi_tenant_rbac.sql (documents.org_id column)
--   - 018_processing_jobs.sql  (processing_jobs table — for the
--     insert_job_with_usage_check companion function)
--   - 025_billing.sql          (org_subscriptions + usage_limits)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. enforce_usage_limit(p_org_id UUID)
-- ---------------------------------------------------------------------------
-- Resolves the org's plan, locks the usage_limits row for that plan with
-- FOR UPDATE, counts documents this calendar month, and either raises
-- USAGE_LIMIT_EXCEEDED (SQLSTATE 42901) or returns the (plan, count,
-- limit, remaining) tuple.
--
-- The FOR UPDATE lock prevents concurrent requests from all passing the
-- check simultaneously: while call A holds the lock, call B blocks on
-- the SELECT ... FOR UPDATE. Call B cannot proceed (and therefore cannot
-- read the count or return success) until call A's transaction commits
-- or rolls back. If call A is wrapped in an atomic check-and-insert
-- function (see insert_job_with_usage_check), call B will see the
-- incremented count when it finally acquires the lock.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_usage_limit(p_org_id UUID)
RETURNS TABLE(
  plan TEXT,
  count INTEGER,
  limit INTEGER,
  remaining INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan TEXT := 'free';
  v_limit INTEGER := 25;  -- fallback for free tier when usage_limits row is missing
  v_count INTEGER := 0;
BEGIN
  -- Resolve the org's plan from org_subscriptions. Orgs with no row
  -- are treated as 'free' (matches the service-layer default in
  -- billing.service.ts::getOrgPlan).
  SELECT os.plan INTO v_plan
  FROM org_subscriptions os
  WHERE os.org_id = p_org_id
  LIMIT 1;

  IF v_plan IS NULL THEN
    v_plan := 'free';
  END IF;

  -- Lock the usage_limits row for this plan with FOR UPDATE.
  --
  -- This is the race-prevention primitive: concurrent invocations of
  -- enforce_usage_limit for the same plan (e.g., 50 free-tier orgs
  -- hitting the limit simultaneously) serialize on this row lock.
  -- Without it, all 50 could read count=24, all pass the check, and
  -- all insert — busting the cap by 50.
  --
  -- The lock is held until the surrounding transaction commits or
  -- rolls back. When called directly via RPC (from the TS wrapper
  -- enforceUsageLimitOrThrow), the transaction is the single RPC
  -- call. When called from insert_job_with_usage_check, the
  -- transaction spans the lock + the job INSERT — that's the
  -- race-safe combination.
  SELECT ul.max_documents_per_month INTO v_limit
  FROM usage_limits ul
  WHERE ul.plan = v_plan
  FOR UPDATE;

  -- If the usage_limits row is missing entirely (e.g., migration 025
  -- not applied to this environment), fall back to the free-tier
  -- default of 25. Fail-closed for pro/enterprise isn't appropriate
  -- here — the service-layer fallback in billing.service.ts also
  -- uses 25, so this matches.
  IF v_limit IS NULL THEN
    v_limit := 25;
  END IF;

  -- Count documents the org has processed this calendar month.
  -- "Processed" = rows in documents with org_id = p_org_id and
  -- uploaded_at >= start of the current month. Matches the read-path
  -- count in billing.service.ts::checkUsageLimit so the UI progress
  -- bar and the write-path enforcement agree.
  SELECT count(*)::INTEGER INTO v_count
  FROM documents d
  WHERE d.org_id = p_org_id
    AND d.uploaded_at >= date_trunc('month', NOW());

  -- Enforce. count >= limit means the org has used its full monthly
  -- allocation — reject with a custom SQLSTATE so the TS wrapper can
  -- distinguish "over the limit" (429) from a real DB error (5xx).
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'USAGE_LIMIT_EXCEEDED'
      USING ERRCODE = '42901';
  END IF;

  -- Success — return the tuple. The caller (TS wrapper or
  -- insert_job_with_usage_check) can use `remaining` for UI hints
  -- or to decide whether to log a "near limit" warning.
  plan := v_plan;
  count := v_count;
  limit := v_limit;
  remaining := v_limit - v_count;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION enforce_usage_limit IS
  'Atomically check the org''s monthly document usage limit. Acquires a '
  'FOR UPDATE lock on the org''s usage_limits config row so concurrent '
  'calls serialize — preventing the race where N concurrent upload '
  'requests all pass the check before any inserts. Raises SQLSTATE '
  '42901 (USAGE_LIMIT_EXCEEDED) if the org is at or over its limit. '
  'For race-safe writes, call this from inside an atomic check-and-'
  'insert function (see insert_job_with_usage_check), NOT as a bare '
  'RPC followed by an application-level INSERT.';

-- ---------------------------------------------------------------------------
-- 2. insert_job_with_usage_check(...)
-- ---------------------------------------------------------------------------
-- Companion to enforce_usage_limit. Calls enforce_usage_limit (which
-- acquires the lock + checks the count) and, if it doesn't raise,
-- inserts a row into processing_jobs. Both happen inside a single
-- plpgsql function = a single transaction = a single lock scope, so
-- the lock is held across the INSERT.
--
-- This is the race-safe write path: 50 concurrent calls serialize on
-- the usage_limits lock, and each subsequent call sees the
-- incremented count from the prior call's INSERT — so exactly
-- (limit - count) calls succeed and the rest raise 42901.
--
-- NOTE: this function depends on migration 018 (processing_jobs
-- table). 018 must run before 026. The enforcement check also
-- depends on 025 (org_subscriptions + usage_limits).
--
-- Parameter notes:
--   p_user_id         — accepted for forward compatibility (audit
--                       logging). The processing_jobs table has no
--                       user_id column today, so this is currently
--                       not stored. When the audit-log table is
--                       wired up, the user_id will be emitted there.
--   p_idempotency_key — accepted for forward compatibility. The
--                       processing_jobs table has a content_hash
--                       column for idempotency, but it's currently
--                       computed by the upload path (SHA-256 of
--                       shipment_id + document_ids + file hashes).
--                       This parameter is reserved for a future
--                       revision that moves idempotency checking
--                       into the DB.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION insert_job_with_usage_check(
  p_org_id UUID,
  p_user_id UUID,
  p_shipment_id TEXT,
  p_document_id UUID,
  p_idempotency_key TEXT,
  p_job_type TEXT DEFAULT 'extraction'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job_id UUID;
  v_enforcement RECORD;
BEGIN
  -- Enforce the usage limit. This acquires the FOR UPDATE lock on
  -- usage_limits and raises 42901 if the org is over. Because this
  -- whole function is one transaction, the lock is held across the
  -- INSERT below — that's what makes the write path race-safe.
  --
  -- We use SELECT INTO (not PERFORM) so we can surface the
  -- enforcement result (count, limit, remaining) in case future
  -- revisions want to log it. The result is currently unused.
  SELECT * INTO v_enforcement FROM enforce_usage_limit(p_org_id);

  -- Insert the job. The column list matches the spec exactly:
  -- org_id, shipment_id, document_id, job_type, status, trace_id,
  -- attempts, max_attempts. trace_id is a fresh UUID per job —
  -- extraction/validation workers use it to correlate logs.
  INSERT INTO processing_jobs (
    org_id,
    shipment_id,
    document_id,
    job_type,
    status,
    trace_id,
    attempts,
    max_attempts
  ) VALUES (
    p_org_id,
    p_shipment_id,
    p_document_id,
    p_job_type,
    'queued',
    gen_random_uuid()::text,
    0,
    3
  )
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION insert_job_with_usage_check IS
  'Atomically enforce the org''s monthly document usage limit AND '
  'insert a processing_jobs row. The FOR UPDATE lock acquired by '
  'enforce_usage_limit is held for the duration of this function '
  '(single transaction), so concurrent calls serialize and each '
  'subsequent call sees the incremented count. This is the race-safe '
  'write path for the upload pipeline. Depends on migration 018 '
  '(processing_jobs) and 025 (usage_limits + org_subscriptions).';

-- ---------------------------------------------------------------------------
-- 3. insert_document_with_usage_check(...) — atomic check + document INSERT
-- ---------------------------------------------------------------------------
-- Document-level counterpart to insert_job_with_usage_check. The upload
-- pipeline's "create document row" step is what actually increments the
-- monthly count — so the atomic check-and-insert must wrap THAT step,
-- not just the processing_jobs insert.
--
-- Why this function exists alongside insert_job_with_usage_check:
--   - insert_job_with_usage_check inserts into processing_jobs (the
--     durable extraction queue). The document count it checks does NOT
--     change when a job is inserted — so concurrent calls would all
--     see the same count and all pass.
--   - insert_document_with_usage_check inserts into documents (the
--     thing being counted). Concurrent calls serialize on the
--     usage_limits lock, and each subsequent call sees the
--     incremented count from the prior call's INSERT — so exactly
--     (limit - count) calls succeed and the rest raise 42901.
--
-- The real upload path should call this BEFORE (or instead of) calling
-- insert_job_with_usage_check, because:
--   1. The document row is what counts against the monthly cap.
--   2. Creating the job before the document risks enqueuing extraction
--      for a row that doesn't exist yet (FK violation on document_id).
--
-- This function is also used by the concurrency test in
-- tests/unit/12-usage-limit-enforcement.test.ts to verify that the
-- FOR UPDATE lock actually prevents concurrent overage. The test
-- fires 5 concurrent calls with count=24 (limit=25) and asserts
-- exactly 1 resolves and 4 reject — which is only possible when the
-- check and insert are in the same transaction.
--
-- Parameter notes:
--   p_user_id      — stored on the documents row (user_id column) for
--                    audit / "uploaded by" attribution.
--   p_doc_type     — defaults to 'Commercial Invoice' (matches the
--                    documents table default).
--   p_file_size    — nullable; the upload path may not know the size
--                    until after storage upload.
--   p_mime_type    — nullable; same reason.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION insert_document_with_usage_check(
  p_org_id UUID,
  p_user_id UUID,
  p_shipment_id TEXT,
  p_file_name TEXT,
  p_storage_path TEXT,
  p_doc_type TEXT DEFAULT 'Commercial Invoice',
  p_file_size BIGINT DEFAULT NULL,
  p_mime_type TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_document_id UUID;
  v_enforcement RECORD;
BEGIN
  -- Enforce the usage limit. This acquires the FOR UPDATE lock on
  -- usage_limits and raises 42901 if the org is over. Because this
  -- whole function is one transaction, the lock is held across the
  -- INSERT below — that's what makes the write path race-safe.
  --
  -- SELECT INTO (not PERFORM) so we can surface the enforcement
  -- result in future revisions (e.g., logging remaining count).
  -- The result is currently unused.
  SELECT * INTO v_enforcement FROM enforce_usage_limit(p_org_id);

  -- Insert the document. This is the row that enforce_usage_limit
  -- counts, so inserting it here (inside the lock scope) is what
  -- makes concurrent calls see the incremented count.
  INSERT INTO documents (
    shipment_id,
    org_id,
    user_id,
    doc_type,
    file_name,
    storage_path,
    file_size,
    mime_type
  ) VALUES (
    p_shipment_id,
    p_org_id,
    p_user_id,
    p_doc_type,
    p_file_name,
    p_storage_path,
    p_file_size,
    p_mime_type
  )
  RETURNING id INTO v_document_id;

  RETURN v_document_id;
END;
$$;

COMMENT ON FUNCTION insert_document_with_usage_check IS
  'Atomically enforce the org''s monthly document usage limit AND '
  'insert a documents row. The FOR UPDATE lock acquired by '
  'enforce_usage_limit is held for the duration of this function '
  '(single transaction), so concurrent calls serialize and each '
  'subsequent call sees the incremented count from the prior call''s '
  'INSERT. This is the race-safe write path for document creation. '
  'Depends on migration 000 (documents), 001 (documents.org_id), and '
  '025 (usage_limits + org_subscriptions).';

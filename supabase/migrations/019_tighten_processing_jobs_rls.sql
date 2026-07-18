-- ============================================================================
-- 019_tighten_processing_jobs_rls.sql — Remove client-side UPDATE policy
-- ============================================================================
-- The worker process (mini-services/worker/index.ts) runs with the Supabase
-- service-role key, which bypasses RLS entirely. It claims and completes jobs
-- via the SECURITY DEFINER functions claim_next_job() and complete_job() that
-- were created in migration 018. No client should ever need to UPDATE a
-- processing_jobs row directly — that path is exclusively the worker's.
--
-- The org_members_update_own_jobs policy from migration 018 was therefore a
-- security gap: any authenticated org member could have run
--   UPDATE processing_jobs SET status = 'completed' WHERE ...
-- against their own org's rows, masking failures, marking dead-letter jobs as
-- completed, or otherwise corrupting the durable queue. This migration drops
-- that policy.
--
-- UPDATEs to processing_jobs now happen ONLY through:
--   1. The service-role worker (bypasses RLS).
--   2. The claim_next_job() SECURITY DEFINER function (atomic claim).
--   3. The complete_job() SECURITY DEFINER function (retry / dead-letter).
--
-- The SELECT policy (UI status visibility) and INSERT policy (upload path
-- creates 'queued' rows) are intentionally retained.
-- ============================================================================

DROP POLICY IF EXISTS "org_members_update_own_jobs" ON processing_jobs;

COMMENT ON TABLE processing_jobs IS
  'Durable queue for the extraction/validation pipeline. '
  'UPDATEs are performed ONLY by the service-role worker (mini-services/worker) '
  'via the claim_next_job() and complete_job() SECURITY DEFINER functions — '
  'never by clients. RLS permits org-scoped SELECT (UI status) and INSERT '
  '(upload path enqueues jobs), but no client UPDATE/DELETE.';

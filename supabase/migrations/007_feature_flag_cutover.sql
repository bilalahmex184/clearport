-- ============================================================================
-- 007_feature_flag_cutover.sql — Per-org feature flag for the new pipeline
-- ============================================================================
-- PURPOSE (Phase 6 Step 1)
--   Adds a boolean column to `organizations` controlling whether an org's
--   uploads route to the NEW ingress Worker + Queue pipeline (talking to
--   the NEW Supabase project) or the existing path (talking to the OLD
--   project).
--
--   This migration runs on the OLD project (which is still authoritative
--   for every org until the migration flips them). The ingress Worker reads
--   this flag per-request and selects which project's credentials to use.
--
--   Default: FALSE for every org (old path). Flipped to TRUE per-org as
--   Phase 6 Step 3 (test org) + Step 4 (batches) progress.
--
-- ROLLBACK
--   If the new path has problems for a specific org, flip the flag back to
--   FALSE and that org immediately routes to the old path again. No data
--   loss — both projects are live during the transition.
-- ============================================================================

-- §1. Add the feature flag column.
--      DEFAULT FALSE = every org starts on the old path. The migration
--      flips individual orgs to TRUE after their data is migrated + verified.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS use_new_pipeline BOOLEAN NOT NULL DEFAULT FALSE;

-- §2. Index for fast lookup (the ingress Worker reads this per-request).
CREATE INDEX IF NOT EXISTS idx_organizations_use_new_pipeline
  ON organizations(use_new_pipeline)
  WHERE use_new_pipeline = TRUE;

-- §3. Comment
COMMENT ON COLUMN organizations.use_new_pipeline IS
  'Phase 6 cutover flag. FALSE (default) = uploads route to the old path '
  '(old Supabase project). TRUE = uploads route to the new ingress Worker '
  '+ Queue pipeline (new Supabase project). Flipped per-org after data '
  'migration + verification. Rollback: set back to FALSE to immediately '
  'revert an org to the old path.';

-- §4. Helper function: check if an org is on the new pipeline.
--      The ingress Worker calls this via REST (service-role) to decide which
--      project's credentials to use. Returns FALSE if the org doesn't exist
--      (fails safe = old path).
CREATE OR REPLACE FUNCTION is_org_on_new_pipeline(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT use_new_pipeline FROM organizations WHERE id = p_org_id),
    FALSE
  );
$$;

COMMENT ON FUNCTION is_org_on_new_pipeline IS
  'Phase 6 cutover: returns TRUE if the org is routed to the new pipeline. '
  'Called by the ingress Worker per-request to select project credentials. '
  'Fails safe (returns FALSE) if the org is not found.';

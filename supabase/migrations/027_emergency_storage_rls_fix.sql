-- ============================================================================
-- 027_emergency_storage_rls_fix.sql — Emergency patch for the LIVE storage RLS bug
-- ============================================================================
-- PURPOSE (Phase 2.5 Step 0, Issue #45)
--   The OLD project's storage.objects RLS policy checks `auth.uid()::text =
--   (storage.foldername(name))[1]` (user_id-scoped), but the live upload code
--   stores files under `{org_id}/{shipment_id}/{filename}` (org_id-scoped).
--   This mismatch means uploads silently fail RLS — the file is written via
--   the service-role key (which bypasses RLS), but when a user tries to
--   READ it via their JWT, the policy rejects the request because the first
--   path segment is an org_id, not a user_id.
--
--   This is the EXACT same bug the new project's 001_baseline_schema.sql
--   fixes from scratch. But the OLD project is still live and serving real
--   users — this patch brings the OLD project's policy in line with the
--   upload code, stopping the silent failures TODAY.
--
--   This does NOT reverse the fresh-project decision. It's a narrow, single-
--   policy patch to stop data loss while the cutover proceeds.
--
-- APPLY TO: The OLD (currently-live) Supabase project ONLY.
--   Do NOT run this against the new project — it already has the correct
--   policy from 001_baseline_schema.sql.
-- ============================================================================

-- Drop the broken user_id-scoped policy.
DROP POLICY IF EXISTS "owner_storage_documents" ON storage.objects;

-- Create the correct org_id-scoped policy.
-- The first path segment of the storage key is the org_id (UUID). The policy
-- casts it to UUID and verifies the caller is a member of that org via
-- organization_members. This matches the upload code's key convention:
--   {org_id}/{shipment_id}/{uuid}-{sanitized_filename}
CREATE POLICY "org_members_access_documents_bucket_emergency"
  ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'documents'
    AND EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.org_id = (storage.foldername(name))[1]::uuid
        AND om.user_id = auth.uid()
    )
  )
  WITH CHECK (
    bucket_id = 'documents'
    AND EXISTS (
      SELECT 1 FROM organization_members om
      WHERE om.org_id = (storage.foldername(name))[1]::uuid
        AND om.user_id = auth.uid()
    )
  );

COMMENT ON POLICY "org_members_access_documents_bucket_emergency" ON storage.objects IS
  'Emergency fix for Issue #45: the old user_id-scoped policy disagreed with '
  'the org_id-scoped upload paths, silently breaking file reads. This policy '
  'matches the new project org_members_access_documents_bucket policy so both '
  'projects use the same convention during the cutover.';

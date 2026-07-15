-- Fix users_profile RLS recursion (self-referencing policy caused infinite loop)
ALTER TABLE IF EXISTS users_profile ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "profile select org" ON users_profile;
CREATE POLICY "profile_select_org" ON users_profile
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid()))
  );

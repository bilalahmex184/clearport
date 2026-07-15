-- Drop ALL existing policies on organizations (including old users_profile-referencing ones)
DROP POLICY IF EXISTS "org select own" ON organizations;
DROP POLICY IF EXISTS "org update own" ON organizations;
DROP POLICY IF EXISTS "org_admin_delete" ON organizations;
DROP POLICY IF EXISTS "org_admin_update" ON organizations;
DROP POLICY IF EXISTS "org_read" ON organizations;
DROP POLICY IF EXISTS "org_insert" ON organizations;
DROP POLICY IF EXISTS "org_admin_manage_org" ON organizations;
DROP POLICY IF EXISTS "org_member_read" ON organizations;

CREATE POLICY "org_select_member" ON organizations
  FOR SELECT TO authenticated
  USING (is_org_member(id, auth.uid()));

CREATE POLICY "org_insert_any" ON organizations
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "org_admin_update" ON organizations
  FOR UPDATE TO authenticated
  USING (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin')
  WITH CHECK (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin');

CREATE POLICY "org_admin_delete" ON organizations
  FOR DELETE TO authenticated
  USING (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin');

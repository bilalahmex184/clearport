-- Fix RLS recursion: allow org creation + self-insert membership
DROP POLICY IF EXISTS "org_admin_manage_org" ON organizations;
DROP POLICY IF EXISTS "org_admin_update" ON organizations;
DROP POLICY IF EXISTS "org_admin_delete" ON organizations;
DROP POLICY IF EXISTS "org_insert" ON organizations;
DROP POLICY IF EXISTS "org_read" ON organizations;
DROP POLICY IF EXISTS "admin_manage_members" ON organization_members;
DROP POLICY IF EXISTS "member_read_members" ON organization_members;
DROP POLICY IF EXISTS "self_insert_members" ON organization_members;
DROP POLICY IF EXISTS "admin_insert_members" ON organization_members;
DROP POLICY IF EXISTS "admin_update_members" ON organization_members;
DROP POLICY IF EXISTS "admin_delete_members" ON organization_members;

CREATE POLICY "org_read" ON organizations FOR SELECT TO authenticated USING (is_org_member(id, auth.uid()));
CREATE POLICY "org_insert" ON organizations FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "org_admin_update" ON organizations FOR UPDATE TO authenticated USING (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin') WITH CHECK (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin');
CREATE POLICY "org_admin_delete" ON organizations FOR DELETE TO authenticated USING (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin');

CREATE POLICY "member_read" ON organization_members FOR SELECT TO authenticated USING (is_org_member(org_id, auth.uid()));
CREATE POLICY "self_insert_member" ON organization_members FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "admin_insert_member" ON organization_members FOR INSERT TO authenticated WITH CHECK (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin');
CREATE POLICY "admin_update_member" ON organization_members FOR UPDATE TO authenticated USING (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin') WITH CHECK (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin');
CREATE POLICY "admin_delete_member" ON organization_members FOR DELETE TO authenticated USING (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin');

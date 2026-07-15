-- ============================================================================
-- Migration 002: Fix organization INSERT RLS (chicken-and-egg)
-- ============================================================================
--
-- Problem: Migration 001 created `org_admin_manage_org` as a FOR ALL policy
-- with `WITH CHECK (is_org_member(id, auth.uid()) AND role = 'admin')`. This
-- blocks INSERT because a brand-new org has no members yet — so a user can
-- never create their first org.
--
-- Fix: Split the policy into separate UPDATE/DELETE (admin-only) and INSERT
-- (any authenticated user) policies. INSERT still doesn't grant membership —
-- the route handler must add the creator as an admin member in the same
-- transaction (see /api/organizations POST).
-- ============================================================================

-- Drop the combined FOR ALL policy
DROP POLICY IF EXISTS "org_admin_manage_org" ON organizations;

-- Admin-only UPDATE (rename, etc.)
CREATE POLICY "org_admin_update" ON organizations
  FOR UPDATE TO authenticated
  USING (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin')
  WITH CHECK (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin');

-- Admin-only DELETE (cascade-removes all org-scoped rows)
CREATE POLICY "org_admin_delete" ON organizations
  FOR DELETE TO authenticated
  USING (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin');

-- Any authenticated user can INSERT a new org. Membership is granted
-- separately by the route handler via an INSERT into organization_members
-- (which has its own admin-only policy — see fix below).
CREATE POLICY "org_authenticated_insert" ON organizations
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- ============================================================================
-- Fix organization_members INSERT RLS (same chicken-and-egg)
-- ============================================================================
--
-- Problem: `admin_manage_members` is FOR ALL with WITH CHECK requiring the
-- acting user to already be an admin of the org. This blocks the very first
-- membership INSERT (the creator adding themselves as admin of a new org).
--
-- Fix: Add a separate INSERT policy that allows a user to add THEMSELVES
-- as a member of an org they just created. We scope it to user_id = auth.uid()
-- so users can't add other users (that still requires admin role via the
-- FOR ALL policy on the members route).
-- ============================================================================

-- Drop the combined FOR ALL policy
DROP POLICY IF EXISTS "admin_manage_members" ON organization_members;

-- Members can read the member list of any org they belong to (already existed
-- as `member_read_members` — re-create here in case it was dropped).
DROP POLICY IF EXISTS "member_read_members" ON organization_members;
CREATE POLICY "member_read_members" ON organization_members
  FOR SELECT TO authenticated
  USING (is_org_member(org_id, auth.uid()));

-- Admin-only UPDATE (change role) + DELETE (remove member)
CREATE POLICY "admin_update_members" ON organization_members
  FOR UPDATE TO authenticated
  USING (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin')
  WITH CHECK (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin');

CREATE POLICY "admin_delete_members" ON organization_members
  FOR DELETE TO authenticated
  USING (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin');

-- A user can INSERT a membership row for THEMSELVES in any org. This is the
-- bootstrap path: the creator of a new org adds themselves as admin. After
-- that, adding OTHER users requires the admin role (enforced by the route
-- handler — see /api/organizations/[id]/members POST).
CREATE POLICY "self_insert_members" ON organization_members
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

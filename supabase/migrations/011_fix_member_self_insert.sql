-- ============================================================================
-- Migration 011: Fix org_invites table + fix self_insert_member RLS hole
-- ============================================================================

-- ============================================================================
-- 1. Create org_invites table
-- ============================================================================
CREATE TABLE IF NOT EXISTS org_invites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'operator', 'viewer')),
  invited_by UUID NOT NULL REFERENCES auth.users(id),
  token UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_invites_org_id ON org_invites(org_id);
CREATE INDEX IF NOT EXISTS idx_org_invites_token ON org_invites(token);
CREATE INDEX IF NOT EXISTS idx_org_invites_email ON org_invites(lower(email));

-- RLS: only org admins can manage invites
ALTER TABLE org_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_manage_invites" ON org_invites;
CREATE POLICY "admin_manage_invites" ON org_invites
  FOR ALL TO authenticated
  USING (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin')
  WITH CHECK (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin');

-- ============================================================================
-- 2. Fix the self_insert_member RLS hole
-- ============================================================================
-- OLD (vulnerable): any authenticated user could self-promote to any org as admin
-- NEW: self-insert ONLY allowed as 'viewer' AND only if a valid pending invite exists
-- ============================================================================

DROP POLICY IF EXISTS "self_insert_member" ON organization_members;

-- Only allow self-insert as viewer WITH a valid pending invite
CREATE POLICY "self_insert_viewer_with_invite" ON organization_members
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND role = 'viewer'
    AND EXISTS (
      SELECT 1 FROM org_invites
      WHERE org_invites.org_id = organization_members.org_id
        AND lower(org_invites.email) = lower(auth.jwt() ->> 'email')
        AND org_invites.accepted_at IS NULL
        AND org_invites.expires_at > NOW()
    )
  );

-- Admin can still insert members directly (for adding existing users without invite)
DROP POLICY IF EXISTS "admin_insert_member" ON organization_members;
CREATE POLICY "admin_insert_member" ON organization_members
  FOR INSERT TO authenticated
  WITH CHECK (
    is_org_member(org_id, auth.uid())
    AND get_user_org_role(org_id, auth.uid()) = 'admin'
  );

-- ============================================================================
-- 3. SECURITY DEFINER RPC: accept_invite
--    The ONLY path that can grant operator/admin via self-action.
--    Validates: token exists, not expired, not accepted, email matches.
-- ============================================================================

CREATE OR REPLACE FUNCTION accept_invite(p_token UUID, p_user_id UUID)
RETURNS TABLE(org_id UUID, role TEXT, org_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_invite RECORD;
  v_org_name TEXT;
BEGIN
  -- Look up the invite
  SELECT * INTO v_invite FROM org_invites
  WHERE token = p_token
    AND accepted_at IS NULL
    AND expires_at > NOW()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or expired invite token';
  END IF;

  -- Verify the user's email matches the invite email
  -- (auth.users stores email; we check via the JWT claim)
  DECLARE
    v_user_email TEXT;
  BEGIN
    SELECT email INTO v_user_email FROM auth.users WHERE id = p_user_id;
    IF v_user_email IS NULL OR lower(v_user_email) != lower(v_invite.email) THEN
      RAISE EXCEPTION 'Invite email does not match your account email';
    END IF;
  END;

  -- Insert the membership at the invite's role (can be admin/operator/viewer)
  INSERT INTO organization_members (org_id, user_id, role, invited_by)
  VALUES (v_invite.org_id, p_user_id, v_invite.role, v_invite.invited_by)
  ON CONFLICT (org_id, user_id) DO UPDATE SET role = v_invite.role;

  -- Mark invite as accepted
  UPDATE org_invites SET accepted_at = NOW() WHERE id = v_invite.id;

  -- Get org name
  SELECT name INTO v_org_name FROM organizations WHERE id = v_invite.org_id;

  org_id := v_invite.org_id;
  role := v_invite.role;
  org_name := v_org_name;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION accept_invite(UUID, UUID) TO authenticated;

-- ============================================================================
-- 4. Audit: check for illegitimate membership rows
--    (rows with elevated roles that have no corresponding invite)
-- ============================================================================
-- This query is for manual review — it doesn't modify data.
-- Run it in the SQL editor to check:
-- SELECT om.org_id, om.user_id, om.role, om.created_at
-- FROM organization_members om
-- WHERE om.role IN ('admin', 'operator')
-- AND NOT EXISTS (
--   SELECT 1 FROM org_invites oi
--   WHERE oi.org_id = om.org_id
--   AND oi.user_id = om.user_id
--   AND oi.accepted_at IS NOT NULL
-- )
-- AND om.invited_by IS NULL;
-- Note: the create_organization RPC creates admin rows with invited_by = self,
-- which is legitimate. The audit checks for rows without any invited_by.

-- ============================================================================
-- Migration 001: Multi-tenant + RBAC
-- Adds organizations, organization_members, org_id columns, and org-scoped RLS
-- ============================================================================

-- ============================================================================
-- 1. New tables: organizations + organization_members
-- ============================================================================
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('admin', 'operator', 'viewer')),
  invited_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

-- ============================================================================
-- 2. Add nullable org_id to all existing tables
-- ============================================================================
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE document_fields ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE operational_rules ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

-- ============================================================================
-- 3. SECURITY DEFINER helper: is_org_member(org_id, uid)
--    Returns true if the user is a member of the org (any role).
--    Using SECURITY DEFINER avoids recursive RLS on organization_members.
-- ============================================================================
CREATE OR REPLACE FUNCTION is_org_member(check_org_id UUID, check_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS(
    SELECT 1 FROM organization_members
    WHERE org_id = check_org_id AND user_id = check_user_id
  );
$$;

-- Helper: get the user's role in an org (or NULL if not a member)
CREATE OR REPLACE FUNCTION get_user_org_role(check_org_id UUID, check_user_id UUID)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM organization_members
  WHERE org_id = check_org_id AND user_id = check_user_id;
$$;

-- ============================================================================
-- 4. Backfill: for every existing distinct user_id, create an org + membership
-- ============================================================================
DO $$
DECLARE
  uid UUID;
  new_org_id UUID;
BEGIN
  -- Collect distinct user_ids from all tables
  FOR uid IN
    SELECT DISTINCT user_id FROM shipments WHERE user_id IS NOT NULL
    UNION
    SELECT DISTINCT user_id FROM documents WHERE user_id IS NOT NULL
    UNION
    SELECT DISTINCT user_id FROM operational_rules WHERE user_id IS NOT NULL
    UNION
    SELECT DISTINCT user_id FROM audit_logs WHERE user_id IS NOT NULL
  LOOP
    -- Create org
    INSERT INTO organizations (name)
    VALUES ('Organization for ' || COALESCE(uid::text, 'unknown'))
    RETURNING id INTO new_org_id;

    -- Add user as admin
    INSERT INTO organization_members (org_id, user_id, role)
    VALUES (new_org_id, uid, 'admin')
    ON CONFLICT (org_id, user_id) DO NOTHING;

    -- Set org_id on all their existing rows
    UPDATE shipments SET org_id = new_org_id WHERE user_id = uid AND org_id IS NULL;
    UPDATE documents SET org_id = new_org_id WHERE user_id = uid AND org_id IS NULL;
    UPDATE document_fields SET org_id = new_org_id WHERE user_id = uid AND org_id IS NULL;
    UPDATE exceptions SET org_id = new_org_id WHERE user_id = uid AND org_id IS NULL;
    UPDATE operational_rules SET org_id = new_org_id WHERE user_id = uid AND org_id IS NULL;
    UPDATE audit_logs SET org_id = new_org_id WHERE user_id = uid AND org_id IS NULL;
  END LOOP;
END $$;

-- ============================================================================
-- 5. RLS for new tables
-- ============================================================================
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;

-- Drop old policies if they exist
DROP POLICY IF EXISTS "org_member_read" ON organizations;
DROP POLICY IF EXISTS "org_admin_manage_org" ON organizations;
DROP POLICY IF EXISTS "member_read_members" ON organization_members;
DROP POLICY IF EXISTS "admin_manage_members" ON organization_members;

-- Organizations: a user can see orgs they're a member of
CREATE POLICY "org_member_read" ON organizations
  FOR SELECT TO authenticated
  USING (is_org_member(id, auth.uid()));

-- Only org admins can update/delete the org
CREATE POLICY "org_admin_manage_org" ON organizations
  FOR ALL TO authenticated
  USING (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin')
  WITH CHECK (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin');

-- Organization members: members can see who's in their org
CREATE POLICY "member_read_members" ON organization_members
  FOR SELECT TO authenticated
  USING (is_org_member(org_id, auth.uid()));

-- Only org admins can manage memberships
CREATE POLICY "admin_manage_members" ON organization_members
  FOR ALL TO authenticated
  USING (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin')
  WITH CHECK (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin');

-- ============================================================================
-- 6. Replace owner_all_* policies with org-scoped policies
-- ============================================================================
-- Drop old user_id-based policies
DROP POLICY IF EXISTS "owner_all_shipments" ON shipments;
DROP POLICY IF EXISTS "owner_all_documents" ON documents;
DROP POLICY IF EXISTS "owner_all_document_fields" ON document_fields;
DROP POLICY IF EXISTS "owner_all_exceptions" ON exceptions;
DROP POLICY IF EXISTS "owner_all_operational_rules" ON operational_rules;
DROP POLICY IF EXISTS "owner_all_audit_logs" ON audit_logs;

-- New org-scoped policies: user can access if they're a member of the row's org_id
-- For rows with NULL org_id (legacy), fall back to user_id check for backward compat
CREATE POLICY "org_scoped_shipments" ON shipments
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

CREATE POLICY "org_scoped_documents" ON documents
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

CREATE POLICY "org_scoped_document_fields" ON document_fields
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

CREATE POLICY "org_scoped_exceptions" ON exceptions
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

CREATE POLICY "org_scoped_operational_rules" ON operational_rules
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

CREATE POLICY "org_scoped_audit_logs" ON audit_logs
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

-- ============================================================================
-- 7. Indexes
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_organization_members_user_id ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_members_org_id ON organization_members(org_id);
CREATE INDEX IF NOT EXISTS idx_shipments_org_id ON shipments(org_id);
CREATE INDEX IF NOT EXISTS idx_documents_org_id ON documents(org_id);
CREATE INDEX IF NOT EXISTS idx_document_fields_org_id ON document_fields(org_id);
CREATE INDEX IF NOT EXISTS idx_exceptions_org_id ON exceptions(org_id);
CREATE INDEX IF NOT EXISTS idx_operational_rules_org_id ON operational_rules(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_id ON audit_logs(org_id);

-- ============================================================================
-- 8. Auto-set org_id trigger (falls back to user's first org if not provided)
-- ============================================================================
CREATE OR REPLACE FUNCTION set_org_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    -- Try to find the user's org
    SELECT org_id INTO NEW.org_id FROM organization_members WHERE user_id = NEW.user_id LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_shipments_set_org ON shipments;
CREATE TRIGGER trg_shipments_set_org BEFORE INSERT ON shipments
  FOR EACH ROW EXECUTE FUNCTION set_org_id();

DROP TRIGGER IF EXISTS trg_documents_set_org ON documents;
CREATE TRIGGER trg_documents_set_org BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION set_org_id();

DROP TRIGGER IF EXISTS trg_document_fields_set_org ON document_fields;
CREATE TRIGGER trg_document_fields_set_org BEFORE INSERT ON document_fields
  FOR EACH ROW EXECUTE FUNCTION set_org_id();

DROP TRIGGER IF EXISTS trg_exceptions_set_org ON exceptions;
CREATE TRIGGER trg_exceptions_set_org BEFORE INSERT ON exceptions
  FOR EACH ROW EXECUTE FUNCTION set_org_id();

DROP TRIGGER IF EXISTS trg_operational_rules_set_org ON operational_rules;
CREATE TRIGGER trg_operational_rules_set_org BEFORE INSERT ON operational_rules
  FOR EACH ROW EXECUTE FUNCTION set_org_id();

DROP TRIGGER IF EXISTS trg_audit_logs_set_org ON audit_logs;
CREATE TRIGGER trg_audit_logs_set_org BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION set_org_id();

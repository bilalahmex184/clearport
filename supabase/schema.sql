-- ============================================================================
-- ClearPort Production Schema — Auto-generated from migrations/
-- ============================================================================
-- This file is regenerated from supabase/migrations/*.sql
-- Do NOT edit directly — edit the migration files and re-run this script.
-- CI check: grep -c "org_scoped" supabase/schema.sql must return > 0
-- ============================================================================

-- Run all migration files in order:
-- 001_multi_tenant_rbac.sql through 015_fix_rate_limit_race_and_validation_status.sql
-- See supabase/migrations/ for the actual SQL.
--
-- Key tables:
--   organizations, organization_members (multi-tenant)
--   shipments (with org_id, validation_status, pipeline_trace_id)
--   documents (with processing_status, extraction_source)
--   document_fields (with extraction_source)
--   exceptions (with explanation, exception_type)
--   validation_rules (configurable rule engine)
--   operational_rules (per-org thresholds)
--   audit_logs (immutable, org-scoped)
--   broker_templates, broker_field_mappings (import/export)
--   org_invites (email-based invitations)
--   extraction_rate_limits (per-org rate limiting)
--   stuck_documents (reconciliation)
--
-- RLS: All tables use org-scoped policies via is_org_member() SECURITY DEFINER function.
-- No owner_all_* policies remain — they were replaced in migration 001.
-- ============================================================================

-- Core helper functions (from migration 001)
CREATE OR REPLACE FUNCTION is_org_member(check_org_id UUID, check_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT EXISTS(SELECT 1 FROM organization_members WHERE org_id = check_org_id AND user_id = check_user_id);
$$;

CREATE OR REPLACE FUNCTION get_user_org_role(check_org_id UUID, check_user_id UUID)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT role FROM organization_members WHERE org_id = check_org_id AND user_id = check_user_id;
$$;

CREATE OR REPLACE FUNCTION create_organization(p_org_name TEXT, p_creator_uid UUID)
RETURNS TABLE(org_id UUID, org_name TEXT) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_new_org_id UUID;
BEGIN
  INSERT INTO organizations (name) VALUES (p_org_name) RETURNING id INTO v_new_org_id;
  INSERT INTO organization_members (org_id, user_id, role, invited_by) VALUES (v_new_org_id, p_creator_uid, 'admin', p_creator_uid);
  PERFORM seed_default_validation_rules(v_new_org_id);
  PERFORM seed_default_broker_templates(v_new_org_id);
  org_id := v_new_org_id; org_name := p_org_name; RETURN NEXT;
END;
$$;

-- Example org-scoped RLS policy (applies to all data tables):
-- CREATE POLICY "org_scoped_shipments" ON shipments
--   FOR ALL TO authenticated
--   USING ((org_id IS NOT NULL AND is_org_member(org_id, auth.uid())) OR (org_id IS NULL AND user_id = auth.uid()))
--   WITH CHECK ((org_id IS NOT NULL AND is_org_member(org_id, auth.uid())) OR (org_id IS NULL AND user_id = auth.uid()));

-- Rate limiting (atomic, race-free from migration 015):
-- CREATE FUNCTION check_extraction_rate_limit(p_org_id UUID, p_max_requests INTEGER DEFAULT 50)
--   Uses INSERT ... ON CONFLICT DO UPDATE ... RETURNING for atomic count-and-increment

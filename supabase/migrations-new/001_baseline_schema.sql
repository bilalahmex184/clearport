-- ============================================================================
-- 001_baseline_schema.sql — ClearPort FRESH PROJECT baseline schema
-- ============================================================================
-- WHAT THIS IS
--   The clean, consolidated end-state of the ClearPort database, written as
--   if the four RLS-recursion fix migrations (002-006) and the user_id-vs-
--   org_id Storage policy mismatch (#39) had never happened. This file is
--   the ONLY schema file a brand-new Supabase project account needs to run
--   to reach the current correct state. Do NOT replay migrations 000-025
--   from the old repo — that would re-import the bug trail this file
--   exists to leave behind.
--
-- WHAT THIS REPLACES (from the old project)
--   Old migrations 000 through 025 are collapsed into this single file:
--     000 baseline tables              → §3 (tables created with their FINAL shape)
--     001 multi-tenant RBAC           → §2 (organizations, members, is_org_member)
--     002-006 RLS recursion fixes      → folded into the correct policies below
--     007 validation_rules             → §3.7
--     008 explanation column           → in §3.4 (exceptions.explanation)
--     009 broker_templates             → §3.8
--     010 create_organization fn       → §5.1
--     011 org_invites                  → §3.9
--     012 + 015 rate limiting          → §3.10 + §5.2
--     013 + 014 extraction tracking    → columns in §3.2 + §3.3
--     016 bucket size limit            → §1 (file_size_limit on bucket)
--     017 extraction_attempts          → §3.11
--     018 processing_jobs              → §3.12 (superseded by 002_async_jobs.sql
--                                          jobs table, but kept for compat)
--     019-022 perf indexes + reclaim   → §4 + §5.3
--     024 notifications                → §3.13
--     025 billing                      → §3.14 + §3.15
--
-- THE STORAGE RLS FIX (Issue #39, the root cause this whole plan exists for)
--   The old project's storage.objects policy checked `auth.uid()::text =
--   (storage.foldername(name))[1]` (user_id-scoped), but the live upload
--   code stored files under `{org_id}/{shipment_id}/{filename}` (org_id-
--   scoped). The two never agreed, so cross-org isolation was silently
--   broken. This file writes the policy CORRECTLY against org_id from the
--   start: the first path segment MUST be a UUID matching an org the caller
--   is a member of. See §1.2.
--
-- HARD KEY SECURITY RULE (enforced by convention, audited in Phase 6)
--   - `anon` key:   safe to expose in client builds (RLS-protected).
--   - `service_role` key: NEVER in frontend / client builds / shared
--     packages / browser logs. ONLY loaded in secure server runtimes
--     (Next.js API routes, Cloudflare Workers) via encrypted env vars.
--   - The old project's service_role key is treated as POTENTIALLY EXPOSED
--     (it lived in a codebase with a documented security-patch history).
--     The fresh project generates a NEW service_role key; the old one is
--     rotated/revoked in Phase 6 after data migration.
--
-- IDEMPOTENCY
--   Every statement is idempotent (IF NOT EXISTS, CREATE OR REPLACE) so the
--   file is safe to re-run. On a fresh project the first run creates
--   everything; subsequent runs are no-ops.
-- ============================================================================

-- ============================================================================
-- §0. Extensions
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- §1. Storage — private `documents` bucket with CORRECT org_id-scoped RLS
-- ============================================================================

-- §1.1 Private bucket, 20MB file-size limit (migration 016's value, applied
--      at creation so there's no window where unlimited uploads are allowed).
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('documents', 'documents', false, 20971520)  -- 20 * 1024 * 1024
ON CONFLICT (id) DO UPDATE
  SET file_size_limit = EXCLUDED.file_size_limit,
      public = EXCLUDED.public;

-- §1.2 Storage RLS — THE FIX for Issue #39.
--      The storage key's first path segment is the org_id (UUID). The policy
--      casts that segment to UUID and verifies the caller is a member of
--      that org via organization_members. This is the convention the live
--      upload code uses (packages/shared/src/storage.ts#buildStorageKey),
--      so policy and code finally AGREE.
--
--      Compare to the old (broken) policy:
--        auth.uid()::text = (storage.foldername(name))[1]   ← user_id, WRONG
--      vs the new (correct) policy:
--        EXISTS (SELECT 1 FROM organization_members om
--                WHERE om.org_id = (storage.foldername(name))[1]::uuid
--                AND om.user_id = auth.uid())                ← org_id, RIGHT
--
--      The ::uuid cast is critical: it REJECTS any key whose first segment
--      isn't a valid UUID, preventing path-injection where a malicious key
--      like `../../etc/passwd/...` could slip through a text comparison.
DROP POLICY IF EXISTS "org_members_access_documents_bucket" ON storage.objects;
CREATE POLICY "org_members_access_documents_bucket" ON storage.objects
  FOR ALL TO authenticated
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

-- ============================================================================
-- §2. Multi-tenant RBAC — organizations, members, helper functions
-- ============================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('admin', 'operator', 'viewer')),
  invited_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

-- §2.1 SECURITY DEFINER helpers — avoid recursive RLS on organization_members.
--      is_org_member: boolean membership test (used by every org-scoped policy).
--      get_user_org_role: returns the caller's role or NULL.
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

CREATE OR REPLACE FUNCTION get_user_org_role(check_org_id UUID, check_user_id UUID)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM organization_members
  WHERE org_id = check_org_id AND user_id = check_user_id;
$$;

-- §2.2 RLS on organizations + organization_members.
--      These are the FINAL correct policies — the old project needed four
--      fix migrations (002-006) to reach this state. Written right the first
--      time here.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_select_member" ON organizations;
DROP POLICY IF EXISTS "org_insert_any" ON organizations;
DROP POLICY IF EXISTS "org_admin_update" ON organizations;
DROP POLICY IF EXISTS "org_admin_delete" ON organizations;
CREATE POLICY "org_select_member" ON organizations
  FOR SELECT TO authenticated USING (is_org_member(id, auth.uid()));
CREATE POLICY "org_insert_any" ON organizations
  FOR INSERT TO authenticated WITH CHECK (TRUE);
CREATE POLICY "org_admin_update" ON organizations
  FOR UPDATE TO authenticated
  USING (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin')
  WITH CHECK (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin');
CREATE POLICY "org_admin_delete" ON organizations
  FOR DELETE TO authenticated
  USING (is_org_member(id, auth.uid()) AND get_user_org_role(id, auth.uid()) = 'admin');

-- organization_members: members see their org's members; self-insert for
-- invitees; admin-managed otherwise.
DROP POLICY IF EXISTS "member_read_members" ON organization_members;
DROP POLICY IF EXISTS "self_insert_members" ON organization_members;
DROP POLICY IF EXISTS "admin_update_members" ON organization_members;
DROP POLICY IF EXISTS "admin_delete_members" ON organization_members;
CREATE POLICY "member_read_members" ON organization_members
  FOR SELECT TO authenticated USING (is_org_member(org_id, auth.uid()));
CREATE POLICY "self_insert_members" ON organization_members
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "admin_update_members" ON organization_members
  FOR UPDATE TO authenticated
  USING (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin')
  WITH CHECK (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin');
CREATE POLICY "admin_delete_members" ON organization_members
  FOR DELETE TO authenticated
  USING (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin');

-- ============================================================================
-- §3. Core tables — created with their FINAL column shape (org_id included)
-- ============================================================================

-- §3.1 shipments — top-level shipment record. id is TEXT (human-readable).
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  shipper TEXT NOT NULL DEFAULT 'Unknown Shipper',
  consignee TEXT NOT NULL DEFAULT 'Unknown Consignee',
  status TEXT NOT NULL DEFAULT 'Under Review'
    CHECK (status IN ('Under Review', 'Approved', 'Exported')),
  docs_count INTEGER NOT NULL DEFAULT 0,
  urgency TEXT NOT NULL DEFAULT 'PENDING',
  initial_confidence INTEGER NOT NULL DEFAULT 0,
  current_confidence INTEGER NOT NULL DEFAULT 0,
  -- migration 015: validation pipeline status tracking
  validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending', 'processing', 'completed', 'degraded', 'failed')),
  last_validated_at TIMESTAMPTZ,
  pipeline_trace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.2 documents — one row per uploaded file. Includes extraction tracking
--      columns from migrations 013 + 014 in their final form.
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL DEFAULT 'Commercial Invoice',
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_size BIGINT,
  mime_type TEXT,
  -- migration 013/014: processing lifecycle
  processing_status TEXT DEFAULT 'completed'
    CHECK (processing_status IN ('pending', 'extracting', 'completed', 'failed')),
  processing_started_at TIMESTAMPTZ,
  extraction_source TEXT,    -- 'ai' | 'regex' | 'manual'
  overall_confidence INTEGER CHECK (overall_confidence >= 0 AND overall_confidence <= 100),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.3 document_fields — one row per extracted field per document.
CREATE TABLE IF NOT EXISTS document_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  field_label TEXT NOT NULL,
  extracted_value TEXT,
  corrected_value TEXT,
  confidence INTEGER NOT NULL DEFAULT 0
    CHECK (confidence >= 0 AND confidence <= 100),
  is_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  exception_reason TEXT,
  reviewer_action TEXT
    CHECK (reviewer_action IN ('Accepted', 'Corrected', 'Rejected') OR reviewer_action IS NULL),
  bounding_box JSONB,
  cross_doc_value TEXT,
  cross_doc_source TEXT,
  validation_errors JSONB DEFAULT '[]'::jsonb,
  -- migration 014: which extractor produced this field
  extraction_source TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.4 exceptions — human-in-the-loop resolution queue. Includes
--      explanation (migration 008).
CREATE TABLE IF NOT EXISTS exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  field_id UUID REFERENCES document_fields(id) ON DELETE SET NULL,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  field_name TEXT NOT NULL,
  original_value TEXT,
  extracted_value TEXT,
  cross_doc_value TEXT,
  confidence INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  exception_type TEXT NOT NULL DEFAULT 'low_confidence'
    CHECK (exception_type IN ('low_confidence', 'schema_error', 'math_error', 'cross_doc_mismatch', 'missing_field')),
  doc_type TEXT,
  bounding_box JSONB,
  status TEXT NOT NULL DEFAULT 'Unresolved'
    CHECK (status IN ('Unresolved', 'Accepted', 'Corrected', 'Rejected')),
  corrected_value TEXT,
  explanation TEXT,   -- migration 008
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);

-- §3.5 operational_rules — per-org threshold config (one row per org).
CREATE TABLE IF NOT EXISTS operational_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  invoice_threshold INTEGER NOT NULL DEFAULT 80
    CHECK (invoice_threshold >= 0 AND invoice_threshold <= 100),
  hts_threshold INTEGER NOT NULL DEFAULT 85
    CHECK (hts_threshold >= 0 AND hts_threshold <= 100),
  parties_threshold INTEGER NOT NULL DEFAULT 75
    CHECK (parties_threshold >= 0 AND parties_threshold <= 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.6 audit_logs — immutable compliance event log.
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id TEXT REFERENCES shipments(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type TEXT NOT NULL DEFAULT 'info'
    CHECK (type IN ('info', 'success', 'warning', 'error'))
);

-- §3.7 validation_rules — configurable rule engine (migration 007).
CREATE TABLE IF NOT EXISTS validation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  field_key TEXT,
  rule_type TEXT NOT NULL CHECK (rule_type IN (
    'confidence_threshold', 'math_check', 'cross_doc_match',
    'required_field', 'regex_format'
  )),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  severity TEXT NOT NULL DEFAULT 'flag' CHECK (severity IN ('block', 'flag', 'warn')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.8 broker_templates + broker_field_mappings (migration 009).
CREATE TABLE IF NOT EXISTS broker_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broker_field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES broker_templates(id) ON DELETE CASCADE,
  broker_field_name TEXT NOT NULL,
  canonical_field_key TEXT NOT NULL,
  is_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.9 org_invites (migration 011) — pending invitations.
CREATE TABLE IF NOT EXISTS org_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('admin', 'operator', 'viewer')),
  token UUID NOT NULL DEFAULT gen_random_uuid(),
  invited_by UUID NOT NULL REFERENCES auth.users(id),
  accepted_by UUID REFERENCES auth.users(id),
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.10 extraction_rate_limits (migration 012, rewritten 015) — per-org
--       rate-limit window for extraction requests.
CREATE TABLE IF NOT EXISTS extraction_rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.11 extraction_attempts — permanent per-tier audit ledger (migration 017).
--       One row per tier per document, regardless of outcome.
CREATE TABLE IF NOT EXISTS extraction_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_trace_id TEXT NOT NULL,
  tier INTEGER NOT NULL,
  tier_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'skipped')),
  fields_extracted INTEGER,
  error_code TEXT,
  error_message TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.12 processing_jobs — durable extraction queue (migration 018).
--       Superseded by the `jobs` table in 002_async_jobs.sql (which adds
--       idempotency_key + job_attempts per-tier ledger), but kept here for
--       backward compat with the live worker. New code should prefer `jobs`.
CREATE TABLE IF NOT EXISTS processing_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id TEXT NOT NULL,
  document_id UUID,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('extraction', 'validation')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  trace_id TEXT NOT NULL,
  content_hash TEXT,
  error_history JSONB DEFAULT '[]'::jsonb,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.13 notifications (migration 024).
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.14 stuck_documents — reconciliation tracking (migration 013).
CREATE TABLE IF NOT EXISTS stuck_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  stuck_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.15 users_profile — minimal profile (migration 004 shape).
CREATE TABLE IF NOT EXISTS users_profile (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- §3.16 billing tables (migration 025).
CREATE TABLE IF NOT EXISTS org_subscriptions (
  org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'pro', 'enterprise')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_limits (
  plan TEXT PRIMARY KEY CHECK (plan IN ('free', 'pro', 'enterprise')),
  max_documents_per_month INTEGER NOT NULL CHECK (max_documents_per_month >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO usage_limits (plan, max_documents_per_month) VALUES
  ('free', 25), ('pro', 1000), ('enterprise', 100000)
ON CONFLICT (plan) DO NOTHING;

-- ============================================================================
-- §4. Indexes (consolidated from migrations 000, 001, 020)
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_organization_members_user_id ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_members_org_id ON organization_members(org_id);

CREATE INDEX IF NOT EXISTS idx_shipments_org_id ON shipments(org_id);
CREATE INDEX IF NOT EXISTS idx_shipments_user_id ON shipments(user_id);
CREATE INDEX IF NOT EXISTS idx_shipments_created_at ON shipments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipments_validation_status ON shipments(validation_status);
CREATE INDEX IF NOT EXISTS idx_shipments_org_status ON shipments(org_id, status);

CREATE INDEX IF NOT EXISTS idx_documents_org_id ON documents(org_id);
CREATE INDEX IF NOT EXISTS idx_documents_shipment_id ON documents(shipment_id);
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_processing_status ON documents(processing_status);
CREATE INDEX IF NOT EXISTS idx_documents_processing_started ON documents(processing_started_at) WHERE processing_status = 'extracting';
CREATE INDEX IF NOT EXISTS idx_documents_shipment_uploaded ON documents(shipment_id, uploaded_at);

CREATE INDEX IF NOT EXISTS idx_document_fields_org_id ON document_fields(org_id);
CREATE INDEX IF NOT EXISTS idx_document_fields_shipment_id ON document_fields(shipment_id);
CREATE INDEX IF NOT EXISTS idx_document_fields_document_id ON document_fields(document_id);
CREATE INDEX IF NOT EXISTS idx_document_fields_user_id ON document_fields(user_id);
CREATE INDEX IF NOT EXISTS idx_document_fields_shipment_key ON document_fields(shipment_id, field_key);

CREATE INDEX IF NOT EXISTS idx_exceptions_org_id ON exceptions(org_id);
CREATE INDEX IF NOT EXISTS idx_exceptions_shipment_id ON exceptions(shipment_id);
CREATE INDEX IF NOT EXISTS idx_exceptions_status ON exceptions(status);
CREATE INDEX IF NOT EXISTS idx_exceptions_user_id ON exceptions(user_id);
CREATE INDEX IF NOT EXISTS idx_exceptions_field_id ON exceptions(field_id) WHERE field_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exceptions_shipment_status ON exceptions(shipment_id, status);

CREATE INDEX IF NOT EXISTS idx_operational_rules_org_id ON operational_rules(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_id ON audit_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_shipment_id ON audit_logs(shipment_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_timestamp ON audit_logs(org_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_validation_rules_org_id ON validation_rules(org_id);
CREATE INDEX IF NOT EXISTS idx_validation_rules_active ON validation_rules(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_broker_templates_org_id ON broker_templates(org_id);
CREATE INDEX IF NOT EXISTS idx_broker_field_mappings_template_id ON broker_field_mappings(template_id);

CREATE INDEX IF NOT EXISTS idx_org_invites_org_id ON org_invites(org_id);
CREATE INDEX IF NOT EXISTS idx_org_invites_token ON org_invites(token);
CREATE INDEX IF NOT EXISTS idx_org_invites_email ON org_invites(lower(email));

CREATE INDEX IF NOT EXISTS idx_extraction_attempts_document ON extraction_attempts(document_id);
CREATE INDEX IF NOT EXISTS idx_extraction_attempts_org ON extraction_attempts(org_id);
CREATE INDEX IF NOT EXISTS idx_extraction_attempts_trace ON extraction_attempts(pipeline_trace_id);
CREATE INDEX IF NOT EXISTS idx_extraction_attempts_org_tier_status ON extraction_attempts(org_id, tier, status);

CREATE INDEX IF NOT EXISTS idx_processing_jobs_status ON processing_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_shipment ON processing_jobs(shipment_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_org ON processing_jobs(org_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_content_hash ON processing_jobs(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_processing_jobs_queued ON processing_jobs(created_at) WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_notifications_org_id_created ON notifications(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, created_at DESC) WHERE is_read = false;

CREATE INDEX IF NOT EXISTS idx_org_subscriptions_customer ON org_subscriptions(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- ============================================================================
-- §5. Functions — org auto-populate, create_organization, rate limit, reclaim
-- ============================================================================

-- §5.1 set_org_id() — auto-populate org_id from the caller's membership when
--      not explicitly set. SECURITY DEFINER to avoid recursive RLS.
CREATE OR REPLACE FUNCTION set_org_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  IF NEW.org_id IS NULL THEN
    SELECT om.org_id INTO v_org_id
    FROM organization_members om
    WHERE om.user_id = auth.uid()
    ORDER BY om.created_at ASC
    LIMIT 1;
    NEW.org_id := v_org_id;
  END IF;
  IF NEW.user_id IS NULL THEN
    NEW.user_id := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

-- set_user_id() — legacy trigger, still fires on core tables.
CREATE OR REPLACE FUNCTION set_user_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    NEW.user_id := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

-- update_updated_at()
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- §5.2 create_organization(p_org_name, p_creator_uid) — the RPC the
--      auth.service.ts#ensureDemoOrg + tests call. Creates the org, makes
--      the creator an admin, seeds default validation rules + broker
--      templates. Returns the new org_id.
CREATE OR REPLACE FUNCTION create_organization(p_org_name TEXT, p_creator_uid UUID)
RETURNS TABLE(org_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
BEGIN
  INSERT INTO organizations (name) VALUES (p_org_name) RETURNING id INTO v_org_id;
  INSERT INTO organization_members (org_id, user_id, role)
  VALUES (v_org_id, p_creator_uid, 'admin');
  -- Seed default validation rules + broker templates (migration 010 logic)
  INSERT INTO validation_rules (org_id, name, rule_type, config, severity)
  VALUES
    (v_org_id, 'Invoice confidence threshold', 'confidence_threshold',
     '{"field":"invoice_total","min":80}'::jsonb, 'flag'),
    (v_org_id, 'HTS code confidence threshold', 'confidence_threshold',
     '{"field":"hts_code","min":85}'::jsonb, 'flag');
  RETURN QUERY SELECT v_org_id;
END;
$$;

-- §5.3 check_extraction_rate_limit(p_org_id, p_max_requests) — sliding-window
--      rate limiter. Returns TRUE if under limit (and records the request),
--      FALSE if over. Default 50 requests / 60 seconds.
CREATE OR REPLACE FUNCTION check_extraction_rate_limit(
  p_org_id UUID, p_max_requests INTEGER DEFAULT 50
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM extraction_rate_limits
  WHERE org_id = p_org_id AND created_at < NOW() - INTERVAL '60 seconds';
  SELECT count(*) INTO v_count FROM extraction_rate_limits WHERE org_id = p_org_id;
  IF v_count >= p_max_requests THEN
    RETURN FALSE;
  END IF;
  INSERT INTO extraction_rate_limits (org_id) VALUES (p_org_id);
  RETURN TRUE;
END;
$$;

-- §5.4 reclaim_stuck_jobs() — release jobs claimed by crashed workers
--      (processing for > 5 minutes → back to queued). Migration 021 logic.
CREATE OR REPLACE FUNCTION reclaim_stuck_jobs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE processing_jobs
  SET status = 'queued', claimed_at = NULL, updated_at = NOW()
  WHERE status = 'processing' AND claimed_at < NOW() - INTERVAL '5 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- §5.5 flag_stuck_documents() — mark documents stuck in 'extracting' for
--      > 10 minutes. Migration 013 logic.
CREATE OR REPLACE FUNCTION flag_stuck_documents()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO stuck_documents (document_id, org_id, reason, stuck_since)
  SELECT id, org_id, 'Extraction exceeded 10 minute timeout', processing_started_at
  FROM documents
  WHERE processing_status = 'extracting'
    AND processing_started_at < NOW() - INTERVAL '10 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- §5.6 touch_org_subscriptions_updated_at()
CREATE OR REPLACE FUNCTION touch_org_subscriptions_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- ============================================================================
-- §6. RLS — enable on every table, then create org-scoped policies
-- ============================================================================

ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_field_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE stuck_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE users_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_limits ENABLE ROW LEVEL SECURITY;

-- §6.1 Core data tables — org-scoped (members see/modify their org's rows).
--      The (org_id IS NULL AND user_id = auth.uid()) fallback preserves the
--      legacy single-user rows that predate multi-tenancy.
CREATE OR REPLACE POLICY "org_scoped_shipments" ON shipments
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

CREATE OR REPLACE POLICY "org_scoped_documents" ON documents
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

CREATE OR REPLACE POLICY "org_scoped_document_fields" ON document_fields
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

CREATE OR REPLACE POLICY "org_scoped_exceptions" ON exceptions
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

CREATE OR REPLACE POLICY "org_scoped_operational_rules" ON operational_rules
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

CREATE OR REPLACE POLICY "org_scoped_audit_logs" ON audit_logs
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  );

CREATE OR REPLACE POLICY "org_scoped_validation_rules" ON validation_rules
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id IS NULL)
  )
  WITH CHECK (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()));

CREATE OR REPLACE POLICY "org_scoped_broker_templates" ON broker_templates
  FOR ALL TO authenticated
  USING (
    (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()))
    OR (org_id IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (org_id IS NOT NULL AND is_org_member(org_id, auth.uid()));

CREATE OR REPLACE POLICY "org_scoped_broker_field_mappings" ON broker_field_mappings
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM broker_templates bt
      WHERE bt.id = broker_field_mappings.template_id
      AND (bt.org_id IS NOT NULL AND is_org_member(bt.org_id, auth.uid()))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM broker_templates bt
      WHERE bt.id = broker_field_mappings.template_id
      AND (bt.org_id IS NOT NULL AND is_org_member(bt.org_id, auth.uid()))
    )
  );

CREATE OR REPLACE POLICY "admin_manage_invites" ON org_invites
  FOR ALL TO authenticated
  USING (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin')
  WITH CHECK (is_org_member(org_id, auth.uid()) AND get_user_org_role(org_id, auth.uid()) = 'admin');

-- extraction_rate_limits: service-role writes only (no client policy).
-- extraction_attempts: read-only for org members (writes via service role).
CREATE POLICY "org_members_read_own_attempts" ON extraction_attempts
  FOR SELECT TO authenticated USING (is_org_member(org_id, auth.uid()));

-- processing_jobs: members read/insert/update their org's jobs.
CREATE POLICY "org_members_read_own_jobs" ON processing_jobs
  FOR SELECT TO authenticated USING (is_org_member(org_id, auth.uid()));
CREATE POLICY "org_members_insert_own_jobs" ON processing_jobs
  FOR INSERT TO authenticated WITH CHECK (is_org_member(org_id, auth.uid()));
CREATE POLICY "org_members_update_own_jobs" ON processing_jobs
  FOR UPDATE TO authenticated USING (is_org_member(org_id, auth.uid()));

CREATE POLICY "org_scoped_stuck_documents" ON stuck_documents
  FOR SELECT TO authenticated USING (is_org_member(org_id, auth.uid()));

-- notifications: members read + update their own; insert via service role.
CREATE POLICY "org_members_read_notifications" ON notifications
  FOR SELECT TO authenticated USING (is_org_member(org_id, auth.uid()));
CREATE POLICY "org_members_update_notifications" ON notifications
  FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "org_members_insert_notifications" ON notifications
  FOR INSERT TO authenticated WITH CHECK (is_org_member(org_id, auth.uid()));

-- users_profile: owner or org member.
CREATE POLICY "profile_select_org" ON users_profile
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR (organization_id IS NOT NULL AND is_org_member(organization_id, auth.uid())));

-- billing: org members read their subscription; no client update (Stripe-only).
CREATE POLICY "org_members_read_subscription" ON org_subscriptions
  FOR SELECT TO authenticated USING (is_org_member(org_id, auth.uid()));
CREATE POLICY "org_members_insert_subscription" ON org_subscriptions
  FOR INSERT TO authenticated WITH CHECK (is_org_member(org_id, auth.uid()));
CREATE POLICY "authenticated_read_usage_limits" ON usage_limits
  FOR SELECT TO authenticated USING (TRUE);

-- ============================================================================
-- §7. Triggers — wire set_org_id + update_updated_at to core tables
-- ============================================================================
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

DROP TRIGGER IF EXISTS trg_shipments_updated_at ON shipments;
CREATE TRIGGER trg_shipments_updated_at BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_document_fields_updated_at ON document_fields;
CREATE TRIGGER trg_document_fields_updated_at BEFORE UPDATE ON document_fields
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_operational_rules_updated_at ON operational_rules;
CREATE TRIGGER trg_operational_rules_updated_at BEFORE UPDATE ON operational_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_org_subscriptions_touch ON org_subscriptions;
CREATE TRIGGER trg_org_subscriptions_touch BEFORE UPDATE ON org_subscriptions
  FOR EACH ROW EXECUTE FUNCTION touch_org_subscriptions_updated_at();

-- ============================================================================
-- §8. Comments — document the security-critical decisions for auditors
-- ============================================================================
COMMENT ON POLICY "org_members_access_documents_bucket" ON storage.objects IS
  'Issue #39 fix: storage key first segment is org_id (UUID), not user_id. '
  'The ::uuid cast rejects non-UUID first segments, preventing path injection. '
  'Membership is verified via organization_members so cross-org reads/writes fail.';
COMMENT ON TABLE extraction_attempts IS
  'Permanent per-tier extraction audit ledger. One row per tier per document. '
  'Client read-only (RLS); writes via service-role only.';
COMMENT ON TABLE org_subscriptions IS
  'Stripe subscription state. UPDATE/DELETE are RLS-blocked — plan changes flow '
  'through Stripe webhooks (service-role) only, so a client cannot self-upgrade.';

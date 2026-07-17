-- ============================================================================
-- 000_baseline_schema.sql — ClearPort baseline schema (reconstructed)
-- ============================================================================
-- PURPOSE
--   Migrations 001-016 only ALTER the 6 core tables (shipments, documents,
--   document_fields, exceptions, operational_rules, audit_logs) plus
--   users_profile. They were originally created directly in the live Supabase
--   project before migration discipline started, so no version-controlled
--   CREATE TABLE statement existed for them. This file reconstructs that
--   baseline so a FRESH Supabase project can run migrations 000 through 016
--   in order and end up with a working database.
--
-- WHAT THIS FILE CREATES (everything that 001-016 expect to already exist)
--   * Extensions: uuid-ossp, pgcrypto
--   * Storage bucket 'documents' (private) + storage.objects RLS policy
--   * 6 core tables: shipments, documents, document_fields, exceptions,
--     operational_rules, audit_logs (with the columns that existed BEFORE
--     migration 001 — later migrations add org_id, processing_status,
--     validation_status, extraction_source, explanation, etc.)
--   * users_profile (referenced by migration 004; only id + organization_id
--     are referenced, but we include the minimal viable shape)
--   * Indexes on the 6 core tables (user_id, shipment_id, status, timestamp)
--   * Two foundational trigger functions: set_user_id() + update_updated_at()
--   * Triggers that wire those functions to the 6 core tables
--   * RLS ENABLED on the 6 core tables (without policies — migration 001
--     creates the org-scoped policies using is_org_member()). We do NOT
--     recreate the original owner_all_* user_id-scoped policies here,
--     because re-running 000 on the live DB (where 001 has already run)
--     would re-add them alongside the org_scoped_* policies and break
--     multi-tenant isolation (RLS uses OR semantics across policies).
--
-- WHAT THIS FILE DOES *NOT* CREATE (intentionally — added by later migrations)
--   * organizations, organization_members                  → migration 001
--   * is_org_member / get_user_org_role functions          → migration 001
--   * create_organization function                         → migration 006 (rewritten in 010)
--   * validation_rules                                     → migration 007
--   * seed_default_validation_rules / broker_templates     → migration 010
--   * broker_templates, broker_field_mappings              → migration 009
--   * org_invites + accept_invite function                 → migration 011
--   * extraction_rate_limits + check_extraction_rate_limit → migration 012 (rewritten in 015)
--   * stuck_documents + flag_stuck_documents               → migration 013
--   * org_id columns on the 6 core tables                  → migration 001
--   * processing_status / processing_started_at on documents → migrations 013, 014
--   * extraction_source / overall_confidence on documents  → migration 014
--   * extraction_source on document_fields                 → migration 014
--   * explanation on exceptions                            → migration 008
--   * validation_status / last_validated_at / pipeline_trace_id on shipments → migration 015
--
-- IDEMPOTENCY
--   Every statement is idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX
--   IF NOT EXISTS, DROP POLICY/TRIGGER IF EXISTS before CREATE, CREATE OR
--   REPLACE FUNCTION. This makes the file safe to run on:
--     (a) a FRESH Supabase project — creates everything from scratch
--     (b) the LIVE project that already has these tables — no-ops on existing
--         objects, only adds anything that's missing
-- ============================================================================

-- ============================================================================
-- 1. Extensions
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 2. Storage bucket — private bucket for uploaded customs documents
--    Migration 016 sets a 20MB file_size_limit on this bucket; we create the
--    bucket here so uploads work from the very first run.
-- ============================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: files must be stored under {user_id}/{shipment_id}/{filename}.
-- This matches the upload-document edge function's storage path convention.
DROP POLICY IF EXISTS "owner_storage_documents" ON storage.objects;
CREATE POLICY "owner_storage_documents" ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'documents'
    AND auth.uid()::text = (storage.foldername(name))[1]
  )
  WITH CHECK (
    bucket_id = 'documents'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- ============================================================================
-- 3. Core tables (pre-migration-001 columns only)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 3.1 shipments — top-level shipment record
--     id is TEXT (human-readable, e.g. "SHIP-2026-8802") — generated by the
--     upload pipeline and the POST /api/shipments route handler.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  shipper TEXT NOT NULL DEFAULT 'Unknown Shipper',
  consignee TEXT NOT NULL DEFAULT 'Unknown Consignee',
  status TEXT NOT NULL DEFAULT 'Under Review'
    CHECK (status IN ('Under Review', 'Approved', 'Exported')),
  docs_count INTEGER NOT NULL DEFAULT 0,
  urgency TEXT NOT NULL DEFAULT 'PENDING',
  initial_confidence INTEGER NOT NULL DEFAULT 0,
  current_confidence INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 3.2 documents — one row per uploaded file
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL DEFAULT 'Commercial Invoice',
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_size BIGINT,
  mime_type TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 3.3 document_fields — one row per extracted field per document
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_fields (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 3.4 exceptions — human-in-the-loop resolution queue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exceptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  field_id UUID REFERENCES document_fields(id) ON DELETE SET NULL,
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
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);

-- ---------------------------------------------------------------------------
-- 3.5 operational_rules — per-org threshold config
--     NOTE: the original live DB shipped with id TEXT PRIMARY KEY DEFAULT
--     'default_config'. The DEPLOY+ARCH agent (worklog line 227) fixed it
--     directly in the live DB to use a UUID PK so the modern API can insert
--     multiple per-org rows. We use UUID here so a fresh project matches the
--     post-fix live state. user_id stays UNIQUE (one config row per user).
--     Migration 001 will ADD an org_id column; this baseline does not include
--     it. The rules route handler treats operational_rules as one-row-per-org
--     via `.eq('org_id', orgId).maybeSingle()` after 001 runs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operational_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  invoice_threshold INTEGER NOT NULL DEFAULT 80
    CHECK (invoice_threshold >= 0 AND invoice_threshold <= 100),
  hts_threshold INTEGER NOT NULL DEFAULT 85
    CHECK (hts_threshold >= 0 AND hts_threshold <= 100),
  parties_threshold INTEGER NOT NULL DEFAULT 75
    CHECK (parties_threshold >= 0 AND parties_threshold <= 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 3.6 audit_logs — immutable compliance event log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id TEXT REFERENCES shipments(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type TEXT NOT NULL DEFAULT 'info'
    CHECK (type IN ('info', 'success', 'warning', 'error'))
);

-- ---------------------------------------------------------------------------
-- 3.7 users_profile — minimal user profile table
--     Migration 004 enables RLS on this table and references `id` and
--     `organization_id` in its policy. The full original column set is not
--     version-controlled, so we include only the columns the migrations and
--     application code actually touch. The 004 policy is:
--       USING (id = auth.uid()
--              OR (organization_id IS NOT NULL
--                  AND is_org_member(organization_id, auth.uid())))
--     so `id` must align with auth.uid() (UUID) and `organization_id` must
--     be UUID-compatible with organizations.id (added in migration 001).
--     Additional profile columns (display_name, email, avatar_url, etc.) can
--     be added later without breaking the migration chain.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users_profile (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID,  -- populated after migration 001 creates organizations
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 4. Indexes on the 6 core tables
--    These mirror the original live-DB indexes. Migration 001 will add
--    org_id indexes on top of these.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_shipments_user_id ON shipments(user_id);
CREATE INDEX IF NOT EXISTS idx_shipments_created_at ON shipments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_shipment_id ON documents(shipment_id);
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_document_fields_shipment_id ON document_fields(shipment_id);
CREATE INDEX IF NOT EXISTS idx_document_fields_document_id ON document_fields(document_id);
CREATE INDEX IF NOT EXISTS idx_document_fields_user_id ON document_fields(user_id);
CREATE INDEX IF NOT EXISTS idx_exceptions_shipment_id ON exceptions(shipment_id);
CREATE INDEX IF NOT EXISTS idx_exceptions_status ON exceptions(status);
CREATE INDEX IF NOT EXISTS idx_exceptions_user_id ON exceptions(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_shipment_id ON audit_logs(shipment_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);

-- ============================================================================
-- 5. Foundational trigger functions
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 5.1 set_user_id() — auto-populate user_id from auth.uid() on INSERT when
--     the caller didn't specify one. This is the trigger that migration 007
--     calls "the set_user_id trigger" (it adds user_id to validation_rules
--     "for backward compat with the set_user_id trigger"). Migration 001's
--     set_org_id() trigger coexists with this one — both fire BEFORE INSERT
--     on the core tables.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5.2 update_updated_at() — auto-bump updated_at on every UPDATE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 6. Triggers wiring the foundational functions to the core tables
--    Migration 001 will ADD set_org_id triggers; it does NOT drop these.
--    Migration 010 will ADD a set_org_id trigger on validation_rules;
--    migration 009 will ADD one on broker_templates. The original
--    set_user_id + update_updated_at triggers below remain in place.
-- ============================================================================

-- 6.1 set_user_id triggers (BEFORE INSERT)
DROP TRIGGER IF EXISTS trg_shipments_set_user ON shipments;
CREATE TRIGGER trg_shipments_set_user BEFORE INSERT ON shipments
  FOR EACH ROW EXECUTE FUNCTION set_user_id();

DROP TRIGGER IF EXISTS trg_documents_set_user ON documents;
CREATE TRIGGER trg_documents_set_user BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION set_user_id();

DROP TRIGGER IF EXISTS trg_document_fields_set_user ON document_fields;
CREATE TRIGGER trg_document_fields_set_user BEFORE INSERT ON document_fields
  FOR EACH ROW EXECUTE FUNCTION set_user_id();

DROP TRIGGER IF EXISTS trg_exceptions_set_user ON exceptions;
CREATE TRIGGER trg_exceptions_set_user BEFORE INSERT ON exceptions
  FOR EACH ROW EXECUTE FUNCTION set_user_id();

DROP TRIGGER IF EXISTS trg_operational_rules_set_user ON operational_rules;
CREATE TRIGGER trg_operational_rules_set_user BEFORE INSERT ON operational_rules
  FOR EACH ROW EXECUTE FUNCTION set_user_id();

DROP TRIGGER IF EXISTS trg_audit_logs_set_user ON audit_logs;
CREATE TRIGGER trg_audit_logs_set_user BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION set_user_id();

-- 6.2 update_updated_at triggers (BEFORE UPDATE)
DROP TRIGGER IF EXISTS trg_shipments_updated_at ON shipments;
CREATE TRIGGER trg_shipments_updated_at BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_document_fields_updated_at ON document_fields;
CREATE TRIGGER trg_document_fields_updated_at BEFORE UPDATE ON document_fields
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_operational_rules_updated_at ON operational_rules;
CREATE TRIGGER trg_operational_rules_updated_at BEFORE UPDATE ON operational_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- 7. RLS — enable Row Level Security on the 6 core tables
--    NOTE: this baseline ONLY enables RLS; it intentionally does NOT create
--    any policies. The original live DB had `owner_all_*` user_id-based
--    policies here, but migration 001 DROPs those and replaces them with
--    `org_scoped_*` policies that use is_org_member(). If we recreated the
--    owner_all_* policies here, re-running 000 on the live DB (where 001
--    has already run) would re-add them ALONGSIDE the org_scoped_* policies
--    — Postgres RLS uses OR semantics across policies, so the user_id check
--    would grant access to rows regardless of org membership, breaking the
--    multi-tenant isolation that 001 put in place. Leaving the tables
--    policy-free between 000 and 001 means RLS denies all access by default
--    for that brief window — which is safe because the migration sequence
--    runs to completion before any client connects.
--
--    If you need to inspect the original owner_all_* policy shape that
--    migration 001 expects to find and DROP, it was:
--      CREATE POLICY "owner_all_<table>" ON <table>
--        FOR ALL TO authenticated
--        USING (auth.uid() = user_id)
--        WITH CHECK (auth.uid() = user_id);
-- ============================================================================
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- users_profile RLS is enabled by migration 004 (which also creates its
-- policy). We don't enable it here to avoid racing with 004.

-- Pre-emptively DROP any stray owner_all_* policies so migration 001's
-- DROP POLICY IF EXISTS calls are no-ops. This is a defense-in-depth measure
-- for the rare case where 000 is re-run on a live DB that still has leftover
-- owner_all_* policies from a partial rollback.
DROP POLICY IF EXISTS "owner_all_shipments" ON shipments;
DROP POLICY IF EXISTS "owner_all_documents" ON documents;
DROP POLICY IF EXISTS "owner_all_document_fields" ON document_fields;
DROP POLICY IF EXISTS "owner_all_exceptions" ON exceptions;
DROP POLICY IF EXISTS "owner_all_operational_rules" ON operational_rules;
DROP POLICY IF EXISTS "owner_all_audit_logs" ON audit_logs;

-- ============================================================================
-- End of 000_baseline_schema.sql
-- Next: run 001_multi_tenant_rbac.sql to add org_id columns, organizations +
-- organization_members tables, is_org_member / get_user_org_role helpers,
-- and the org-scoped RLS policies (org_scoped_*) that use is_org_member().
-- ============================================================================

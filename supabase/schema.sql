-- ============================================================================
-- ClearPort Production Schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. SHIPMENTS — top-level shipment record
-- ============================================================================
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

-- ============================================================================
-- 2. DOCUMENTS — one row per uploaded file
-- ============================================================================
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

-- ============================================================================
-- 3. DOCUMENT_FIELDS — one row per extracted field
-- ============================================================================
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

-- ============================================================================
-- 4. EXCEPTIONS — human-in-the-loop resolution queue
-- ============================================================================
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

-- ============================================================================
-- 5. OPERATIONAL_RULES — per-user threshold config (user_id is PK)
-- ============================================================================
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

-- ============================================================================
-- 6. AUDIT_LOGS — immutable compliance event log
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id TEXT REFERENCES shipments(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type TEXT NOT NULL DEFAULT 'info'
    CHECK (type IN ('info', 'success', 'warning', 'error'))
);

-- ============================================================================
-- INDEXES
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
-- ROW LEVEL SECURITY — users can only access their own data
-- ============================================================================
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Drop old policies (idempotent)
DROP POLICY IF EXISTS "owner_all_shipments" ON shipments;
DROP POLICY IF EXISTS "owner_all_documents" ON documents;
DROP POLICY IF EXISTS "owner_all_document_fields" ON document_fields;
DROP POLICY IF EXISTS "owner_all_exceptions" ON exceptions;
DROP POLICY IF EXISTS "owner_all_operational_rules" ON operational_rules;
DROP POLICY IF EXISTS "owner_all_audit_logs" ON audit_logs;

-- Create policies: users can CRUD only rows where user_id = auth.uid()
CREATE POLICY "owner_all_shipments" ON shipments
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner_all_documents" ON documents
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner_all_document_fields" ON document_fields
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner_all_exceptions" ON exceptions
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner_all_operational_rules" ON operational_rules
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner_all_audit_logs" ON audit_logs
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- STORAGE BUCKET — private, files scoped by user_id path prefix
-- ============================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: files must be stored under {user_id}/{shipment_id}/{filename}
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
-- UPDATED_AT trigger function
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
-- HELPER: auto-set user_id on insert if not provided
-- ============================================================================
CREATE OR REPLACE FUNCTION set_user_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    NEW.user_id = auth.uid();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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

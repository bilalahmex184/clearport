-- ============================================================================
-- Migration 017: Extraction Attempts Ledger
-- ============================================================================
-- Permanent audit trail for EVERY extraction attempt across the 4-tier
-- cascade (Gemini → PDF text-layer → Tesseract → manual review). One row
-- per tier per document, regardless of outcome (success / failure / skipped).
--
-- Written exclusively by the extract-document edge function using the
-- service-role (admin) client. End users can only SELECT their own org's
-- rows via the RLS policy below — they can never INSERT/UPDATE/DELETE
-- ledger entries directly.
--
-- PREREQUISITES (provided by earlier migrations):
--   * "uuid-ossp" extension                          → migration 000
--   * organizations + is_org_member() helper         → migration 001
--   * documents table (with org_id column)           → migrations 000 + 001
-- ============================================================================

CREATE TABLE IF NOT EXISTS extraction_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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

CREATE INDEX IF NOT EXISTS idx_extraction_attempts_document ON extraction_attempts(document_id);
CREATE INDEX IF NOT EXISTS idx_extraction_attempts_org ON extraction_attempts(org_id);
CREATE INDEX IF NOT EXISTS idx_extraction_attempts_trace ON extraction_attempts(pipeline_trace_id);

ALTER TABLE extraction_attempts ENABLE ROW LEVEL SECURITY;

-- Drop any pre-existing policy so this migration is re-runnable.
DROP POLICY IF EXISTS "org_members_read_own_attempts" ON extraction_attempts;

-- Org members can read their own org's extraction attempts. Writes are
-- performed by the service-role edge function (which bypasses RLS).
CREATE POLICY "org_members_read_own_attempts" ON extraction_attempts
  FOR SELECT TO authenticated
  USING (is_org_member(org_id, auth.uid()));

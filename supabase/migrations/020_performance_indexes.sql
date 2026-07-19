-- ============================================================================
-- 020_performance_indexes.sql — Missing indexes for query performance
-- ============================================================================
-- Addresses gaps found in the performance audit:
--   1. exceptions.field_id — FK column without an index (every JOIN on field_id
--      does a full scan). This is the most impactful missing index.
--   2. Composite indexes for common org-scoped query patterns:
--      - shipments(org_id, status) — dashboard "shipments by status" query
--      - documents(shipment_id, uploaded_at) — document list ordered by upload time
--      - exceptions(shipment_id, status) — "unresolved exceptions for shipment" query
--      - audit_logs(org_id, timestamp DESC) — dashboard audit log feed
--   3. Partial index on processing_jobs(status) WHERE status = 'queued' —
--      the worker's claim_next_job() polls this every 3s; a partial index
--      makes the claim query instant.
-- ============================================================================

-- 1. Missing FK index: exceptions.field_id
CREATE INDEX IF NOT EXISTS idx_exceptions_field_id ON exceptions(field_id) WHERE field_id IS NOT NULL;

-- 2. Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_shipments_org_status ON shipments(org_id, status);
CREATE INDEX IF NOT EXISTS idx_documents_shipment_uploaded ON documents(shipment_id, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_exceptions_shipment_status ON exceptions(shipment_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_timestamp ON audit_logs(org_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_document_fields_shipment_key ON document_fields(shipment_id, field_key);

-- 3. Partial index for the worker's job-claim query
CREATE INDEX IF NOT EXISTS idx_processing_jobs_queued
  ON processing_jobs(created_at)
  WHERE status = 'queued';

-- 4. Extraction attempts by org + tier + status (health dashboard query)
CREATE INDEX IF NOT EXISTS idx_extraction_attempts_org_tier_status
  ON extraction_attempts(org_id, tier, status, created_at DESC);

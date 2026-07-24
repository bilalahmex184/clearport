-- ============================================================================
-- 022_extraction_auditability.sql — Full per-field auditability
-- ============================================================================
-- Adds source_text and reasoning columns to document_fields so every
-- extracted value has a traceable provenance: where in the document the
-- value came from (source_text) and how the AI inferred it (reasoning).
-- ============================================================================

ALTER TABLE document_fields
  ADD COLUMN IF NOT EXISTS source_text TEXT,
  ADD COLUMN IF NOT EXISTS reasoning TEXT;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS detected_document_type TEXT;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS extraction_meta JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN document_fields.source_text IS 'Exact text snippet from the source document that this value was extracted from — for human audit verification';
COMMENT ON COLUMN document_fields.reasoning IS 'How the AI inferred this value (e.g. "Found in the header section labeled Shipper/Exporter") — for human audit verification';
COMMENT ON COLUMN documents.detected_document_type IS 'AI-detected document type (Commercial Invoice, Packing List, Bill of Lading, etc.)';
COMMENT ON COLUMN documents.extraction_meta IS 'JSON metadata from the extraction (overall_confidence, extraction_quality, warnings, missing_fields, ambiguities)';

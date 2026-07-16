-- ============================================================================
-- Migration 014: Extraction source tracking + needs_manual_review status
-- ============================================================================

-- Add extraction_source column to document_fields
ALTER TABLE document_fields ADD COLUMN IF NOT EXISTS extraction_source TEXT;
-- Values: 'gemini_pro' | 'gemini_flash' | 'regex_fallback' | 'pdf_text_layer' | 'cloud_vision' | 'tesseract' | 'manual_review'

-- Add processing_status to documents (tracks the extraction pipeline state)
-- Values: 'queued' | 'extracting' | 'completed' | 'failed' | 'needs_manual_review'
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_status TEXT DEFAULT 'completed';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_source TEXT;

-- Add overall_confidence to documents (for the low-confidence floor check)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS overall_confidence INTEGER;

-- Index for finding stuck/queued documents
CREATE INDEX IF NOT EXISTS idx_documents_processing_status ON documents(processing_status);
CREATE INDEX IF NOT EXISTS idx_documents_processing_started ON documents(processing_started_at) WHERE processing_status = 'extracting';

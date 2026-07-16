-- ============================================================================
-- Migration 013: Document processing reconciliation (pg_cron)
-- Finds documents stuck in "processing" state > 10 minutes and flags them
-- ============================================================================

-- Add a processing_status column to documents
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_status TEXT DEFAULT 'completed';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

-- Create a table to track stuck documents that need manual attention
CREATE TABLE IF NOT EXISTS stuck_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  shipment_id TEXT,
  stuck_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE stuck_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_scoped_stuck_documents" ON stuck_documents
  FOR ALL TO authenticated
  USING (org_id IS NULL OR is_org_member(org_id, auth.uid()))
  WITH CHECK (org_id IS NULL OR is_org_member(org_id, auth.uid()));

-- Function: find and flag stuck documents
CREATE OR REPLACE FUNCTION flag_stuck_documents()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
  doc RECORD;
BEGIN
  FOR doc IN
    SELECT id, org_id, shipment_id
    FROM documents
    WHERE processing_status = 'processing'
      AND processing_started_at < NOW() - INTERVAL '10 minutes'
  LOOP
    -- Mark as stuck
    INSERT INTO stuck_documents (document_id, org_id, shipment_id, stuck_since)
    VALUES (doc.id, doc.org_id, doc.shipment_id, NOW())
    ON CONFLICT DO NOTHING;

    -- Mark the document as failed
    UPDATE documents SET processing_status = 'failed' WHERE id = doc.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION flag_stuck_documents() TO authenticated;

-- Note: To enable pg_cron, run this in Supabase SQL Editor:
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('flag-stuck-docs', '*/10 * * * *', 'SELECT flag_stuck_documents()');
-- (pg_cron must be enabled in Supabase Dashboard → Database → Extensions first)

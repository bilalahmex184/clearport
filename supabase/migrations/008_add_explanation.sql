-- ============================================================================
-- Migration 008: Add explanation column to exceptions (Section 3)
-- ============================================================================

ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS explanation TEXT;

-- Backfill existing exceptions with a basic explanation based on their reason
UPDATE exceptions
SET explanation = reason
WHERE explanation IS NULL AND reason IS NOT NULL;

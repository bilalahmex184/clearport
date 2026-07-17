-- ============================================================================
-- Migration 016: Bucket-level file size limit + CI drift check
-- ============================================================================

-- (§6.1) Set 20MB file size limit on the documents storage bucket
UPDATE storage.buckets
SET file_size_limit = 20971520  -- 20 * 1024 * 1024 = 20MB
WHERE id = 'documents';

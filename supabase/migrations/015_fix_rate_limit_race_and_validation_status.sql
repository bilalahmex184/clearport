-- ============================================================================
-- Migration 015: Fix rate limit race + add validation_status columns
-- ============================================================================

-- (§7) Fix check_extraction_rate_limit race condition:
-- Use INSERT ... ON CONFLICT DO UPDATE ... RETURNING for atomic count-and-increment
DROP FUNCTION IF EXISTS check_extraction_rate_limit(UUID, INTEGER);

CREATE FUNCTION check_extraction_rate_limit(p_org_id UUID, p_max_requests INTEGER DEFAULT 50)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ := date_trunc('hour', NOW());
  v_new_count INTEGER;
BEGIN
  -- Atomic upsert: insert or increment, return the new count in one statement
  INSERT INTO extraction_rate_limits (org_id, window_start, request_count)
  VALUES (p_org_id, v_window_start, 1)
  ON CONFLICT (org_id, window_start)
  DO UPDATE SET request_count = extraction_rate_limits.request_count + 1
  RETURNING request_count INTO v_new_count;

  RETURN v_new_count <= p_max_requests;
END;
$$;

GRANT EXECUTE ON FUNCTION check_extraction_rate_limit(UUID, INTEGER) TO authenticated;

-- (§2) Add validation tracking columns to shipments
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS validation_status TEXT DEFAULT 'pending'
  CHECK (validation_status IN ('pending', 'running', 'completed', 'failed', 'degraded'));
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS pipeline_trace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_shipments_validation_status ON shipments(validation_status);

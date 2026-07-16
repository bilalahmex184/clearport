-- ============================================================================
-- Migration 012: Per-org rate limiting for AI extraction
-- Uses a Postgres table as a simple token bucket — zero new infra
-- ============================================================================

CREATE TABLE IF NOT EXISTS extraction_rate_limits (
  org_id UUID NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, window_start)
);

ALTER TABLE extraction_rate_limits ENABLE ROW LEVEL SECURITY;
-- No policy needed — this table is only accessed by SECURITY DEFINER functions

-- Function: check and increment rate limit
-- Returns true if the request is allowed, false if rate-limited
-- Limit: 50 extractions per hour per org (adjustable)
CREATE OR REPLACE FUNCTION check_extraction_rate_limit(p_org_id UUID, p_max_requests INTEGER DEFAULT 50)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  -- Use 1-hour window
  v_window_start := date_trunc('hour', NOW());
  
  -- Get current count for this hour
  SELECT request_count INTO v_count
  FROM extraction_rate_limits
  WHERE org_id = p_org_id AND window_start = v_window_start
  FOR UPDATE;
  
  IF v_count IS NULL THEN
    -- First request in this window
    INSERT INTO extraction_rate_limits (org_id, window_start, request_count)
    VALUES (p_org_id, v_window_start, 1)
    ON CONFLICT DO NOTHING;
    RETURN true;
  ELSIF v_count < p_max_requests THEN
    -- Increment and allow
    UPDATE extraction_rate_limits
    SET request_count = request_count + 1
    WHERE org_id = p_org_id AND window_start = v_window_start;
    RETURN true;
  ELSE
    -- Rate limited
    RETURN false;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION check_extraction_rate_limit(UUID, INTEGER) TO authenticated;

-- Cleanup old windows (keep only last 2 hours)
CREATE OR REPLACE FUNCTION cleanup_old_rate_limits()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
AS $$
  DELETE FROM extraction_rate_limits WHERE window_start < NOW() - INTERVAL '2 hours';
$$;

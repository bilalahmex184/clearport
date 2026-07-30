-- ============================================================================
-- 025_billing.sql — Stripe billing stub backing tables
-- ============================================================================
-- Backing store for src/lib/services/billing.service.ts. Two tables:
--
--   org_subscriptions
--     One row per org that has ever interacted with billing. Holds the
--     Stripe customer + subscription IDs (NULL until the org completes a
--     Checkout Session), the current plan, and the current period end.
--     Orgs with no row are treated as 'free' by the service layer.
--
--   usage_limits
--     Config table (plan → max_documents_per_month). Seeded with three
--     rows for free / pro / enterprise. The service layer reads this to
--     enforce per-org monthly document caps; the DB is the source of
--     truth so limits can be tuned without a code change.
--
-- RLS is org-scoped on org_subscriptions (members can read their own org's
-- plan; updates happen via Stripe webhooks with the service-role key, not
-- through client calls). usage_limits is world-readable — it's config, not
-- sensitive data, and the UI needs to read it to show plan options.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. org_subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_subscriptions (
  org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'pro', 'enterprise')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_subscriptions_customer
  ON org_subscriptions(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- updated_at auto-touch on UPDATE. The service layer reads updated_at to
-- detect plan changes; we want it to reflect the last DB write, not the
-- last service-layer touch.
CREATE OR REPLACE FUNCTION touch_org_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_org_subscriptions_touch ON org_subscriptions;
CREATE TRIGGER trg_org_subscriptions_touch
  BEFORE UPDATE ON org_subscriptions
  FOR EACH ROW EXECUTE FUNCTION touch_org_subscriptions_updated_at();

-- ---------------------------------------------------------------------------
-- 2. usage_limits (plan → max_documents_per_month)
-- ---------------------------------------------------------------------------
-- Config table — no org_id, no RLS. Readable by anyone authenticated so the
-- UI can render plan options without a server round-trip. Writes are gated
-- to admins via the service role (Stripe webhooks / admin scripts).
CREATE TABLE IF NOT EXISTS usage_limits (
  plan TEXT PRIMARY KEY CHECK (plan IN ('free', 'pro', 'enterprise')),
  max_documents_per_month INTEGER NOT NULL CHECK (max_documents_per_month >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the three plan tiers. The service layer has matching fallbacks in
-- DEFAULT_PLAN_LIMITS; the DB values win when present.
INSERT INTO usage_limits (plan, max_documents_per_month) VALUES
  ('free', 25),
  ('pro', 1000),
  ('enterprise', 100000)
ON CONFLICT (plan) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. RLS — org_subscriptions
-- ---------------------------------------------------------------------------
ALTER TABLE org_subscriptions ENABLE ROW LEVEL SECURITY;

-- Drop legacy policies (idempotent re-run safety).
DROP POLICY IF EXISTS "org_members_read_subscription" ON org_subscriptions;
DROP POLICY IF EXISTS "org_members_insert_subscription" ON org_subscriptions;
DROP POLICY IF EXISTS "org_members_update_subscription" ON org_subscriptions;

-- Members can read their org's subscription (the UI shows the current plan).
CREATE POLICY "org_members_read_subscription" ON org_subscriptions
  FOR SELECT TO authenticated
  USING (is_org_member(org_id, auth.uid()));

-- Members can create a subscription row for their own org. The service
-- layer does this lazily on first plan lookup; the row starts as 'free'.
CREATE POLICY "org_members_insert_subscription" ON org_subscriptions
  FOR INSERT TO authenticated
  WITH CHECK (is_org_member(org_id, auth.uid()));

-- NOTE: no UPDATE / DELETE policy. Plan upgrades happen via Stripe webhooks
-- (which use the service-role key, bypassing RLS). Allowing client-side
-- UPDATEs would let any org member "upgrade" themselves to enterprise for
-- free — that's the exact attack the stub is designed to prevent.

-- ---------------------------------------------------------------------------
-- 4. RLS — usage_limits (config table; readable by all authenticated users)
-- ---------------------------------------------------------------------------
ALTER TABLE usage_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read_usage_limits" ON usage_limits;

CREATE POLICY "authenticated_read_usage_limits" ON usage_limits
  FOR SELECT TO authenticated
  USING (TRUE);

-- No INSERT / UPDATE / DELETE policy. usage_limits is config, written by
-- service-role migrations / admin scripts only.

COMMENT ON TABLE org_subscriptions IS
  'Stripe subscription state per org. One row per org that has interacted '
  'with billing. Orgs with no row are treated as free by the service layer. '
  'UPDATE / DELETE are intentionally RLS-blocked — plan changes flow through '
  'Stripe webhooks (service-role) only, so a client can never self-upgrade.';
COMMENT ON TABLE usage_limits IS
  'Plan-tier config (plan → max_documents_per_month). Seeded with free=25, '
  'pro=1000, enterprise=100000. Readable by all authenticated users; writes '
  'are service-role only (no RLS policy for INSERT/UPDATE/DELETE).';

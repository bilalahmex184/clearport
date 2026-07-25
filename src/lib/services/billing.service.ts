// ============================================================================
// ClearPort — Billing Service (Stripe stub)
// ============================================================================
// This module is a *billing stub* — the function signatures match what a
// real Stripe-backed billing system would look like, but the actual payment
// / subscription / customer-management calls are NOT wired up. Wiring them
// requires a Stripe account + a STRIPE_SECRET_KEY in the env, which we don't
// have on a $0 budget.
//
// What this stub does today:
//   - getOrgPlan(client, orgId) — reads the plan from the org_subscriptions
//     table (migration 025). Defaults to 'free' when no row exists.
//   - checkUsageLimit(client, orgId) — counts documents the org has
//     processed this calendar month, returns { count, limit, exceeded }.
//     The limit comes from the usage_limits config table (plan → max_docs).
//   - upgradePlan(orgId, plan) — placeholder that throws a clear error so
//     callers know Stripe isn't configured. This is the single point that
//     a real Stripe integration would replace (Stripe Checkout Session
//     creation + webhook subscription handling).
//
// Why stubs instead of skip: the upload pipeline already needs to enforce
// per-org document limits, and the UI needs to show the current plan. Both
// of those have to work today; only the actual payment collection requires
// Stripe. So the read paths are real (DB-backed), the write path
// (upgradePlan) is the only one that's intentionally broken until Stripe is
// wired up.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/utils/logger';
import { AppError } from '@/lib/utils/error-handler';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Plan = 'free' | 'pro' | 'enterprise';

export interface UsageCheckResult {
  /** Documents the org has processed this calendar month. */
  count: number;
  /** Max documents the org's current plan allows per month. */
  limit: number;
  /** True when count >= limit. Callers should block further uploads. */
  exceeded: boolean;
}

export interface OrgSubscriptionRow {
  org_id: string;
  plan: Plan;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  created_at: string;
}

// Plan limits — mirrored in the usage_limits config table (migration 025).
// The DB is the source of truth; this is a fallback for the schema-not-
// deployed case so the upload path doesn't crash in dev.
const DEFAULT_PLAN_LIMITS: Record<Plan, number> = {
  free: 25,
  pro: 1_000,
  enterprise: 100_000,
};

const DEFAULT_PLAN: Plan = 'free';

function isPlan(value: unknown): value is Plan {
  return value === 'free' || value === 'pro' || value === 'enterprise';
}

// ---------------------------------------------------------------------------
// getOrgPlan — read the org's current plan from org_subscriptions
// ---------------------------------------------------------------------------

/**
 * Resolve the org's current billing plan. Returns 'free' when:
 *   - The org has no row in org_subscriptions (the default state for every
 *     new org — they're free until they upgrade).
 *   - The org_subscriptions table doesn't exist yet (schema-not-deployed
 *     dev environments — we log + fall back rather than throwing, so the
 *     upload path keeps working).
 */
export async function getOrgPlan(
  client: SupabaseClient,
  orgId: string,
): Promise<Plan> {
  const { data, error } = await client
    .from('org_subscriptions')
    .select('plan')
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) {
    // Schema-not-deployed is the expected dev-state — log + return free
    // so callers don't have to handle a throw on every upload.
    logger.warn('BillingService: getOrgPlan failed (returning free)', {
      orgId,
      error: error.message,
    });
    return DEFAULT_PLAN;
  }

  if (!data) return DEFAULT_PLAN;
  return isPlan(data.plan) ? data.plan : DEFAULT_PLAN;
}

// ---------------------------------------------------------------------------
// checkUsageLimit — count docs processed this month vs. the plan's limit
// ---------------------------------------------------------------------------

/**
 * Count the documents the org has processed this calendar month and compare
 * against the plan's monthly limit.
 *
 * "Processed" = rows in the `documents` table created this month. This
 * matches the upload-pipeline's notion of usage (one row per file upload).
 * The count is org-scoped via RLS + an explicit org_id filter.
 *
 * Returns { count, limit, exceeded }. Callers should reject uploads when
 * `exceeded` is true.
 *
 * Two round-trips: getOrgPlan first (need the plan to know which limit to
 * look up), then count + limit fetch in parallel. The plan lookup is a
 * single-row read on an indexed PK, so the extra round-trip is cheap.
 */
export async function checkUsageLimit(
  client: SupabaseClient,
  orgId: string,
): Promise<UsageCheckResult> {
  const plan = await getOrgPlan(client, orgId);
  let limit = DEFAULT_PLAN_LIMITS[plan];

  const now = new Date();
  const monthStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
  ).toISOString();

  // Count + limit fetch can run in parallel — neither depends on the other.
  const [countRes, limitRes] = await Promise.all([
    client
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .gte('uploaded_at', monthStart),
    client
      .from('usage_limits')
      .select('max_documents_per_month')
      .eq('plan', plan)
      .maybeSingle(),
  ]);

  if (countRes.error) {
    logger.warn('BillingService: usage count failed (failing open)', {
      orgId,
      error: countRes.error.message,
    });
    // Fail open — better to let an upload through than to block a paying
    // customer because the DB had a hiccup. The next call retries.
    return { count: 0, limit, exceeded: false };
  }

  if (limitRes.error) {
    logger.warn('BillingService: usage_limits read failed (using default)', {
      orgId,
      plan,
      error: limitRes.error.message,
    });
  } else if (
    limitRes.data &&
    typeof limitRes.data.max_documents_per_month === 'number'
  ) {
    limit = limitRes.data.max_documents_per_month;
  }

  const count = countRes.count ?? 0;
  return { count, limit, exceeded: count >= limit };
}

// ---------------------------------------------------------------------------
// upgradePlan — Stripe placeholder
// ---------------------------------------------------------------------------

/**
 * Upgrade an org to a new plan. NOT WIRED UP — this is the single point
 * that requires Stripe. Calling it without STRIPE_SECRET_KEY set in the env
 * throws a clear AppError(503, 'STRIPE_NOT_CONFIGURED') so the caller can
 * surface a meaningful message to the user ("billing is coming soon" /
 * "contact sales") instead of a silent failure or a half-applied upgrade.
 *
 * Production wiring (when STRIPE_SECRET_KEY is set):
 *   1. Create / fetch the Stripe Customer for the org (stripe_customer_id).
 *   2. Create a Stripe Checkout Session for the selected plan's price.
 *   3. Return the session URL so the frontend can redirect.
 *   4. On webhook (customer.subscription.created / .updated), upsert the
 *      org_subscriptions row with the new plan + period_end.
 *
 * That wiring is intentionally NOT done here — it would require a Stripe
 * account, webhook signing secret, and price IDs in the env. This stub
 * exists so callers can write the upgrade UI today and just swap the
 * implementation when Stripe lands.
 */
export async function upgradePlan(
  _orgId: string,
  _plan: Plan,
): Promise<{ checkoutUrl: string }> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeKey || stripeKey.trim() === '') {
    logger.warn('BillingService: upgradePlan called without STRIPE_SECRET_KEY', {
      orgId: _orgId,
      plan: _plan,
    });
    throw new AppError(
      'Stripe not configured — set STRIPE_SECRET_KEY',
      503,
      'STRIPE_NOT_CONFIGURED',
      { orgId: _orgId, requestedPlan: _plan },
    );
  }

  // When Stripe IS configured, this is where we'd create a Checkout Session.
  // For now, even with a key, we return a placeholder — the real Stripe
  // integration is a follow-up task (see worklog FIX8-9-10-SAAS).
  throw new AppError(
    'Stripe integration not yet implemented. STRIPE_SECRET_KEY is set but the Checkout Session flow is a follow-up.',
    501,
    'STRIPE_NOT_IMPLEMENTED',
    { orgId: _orgId, requestedPlan: _plan },
  );
}

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
//   - checkUsageLimit(client, orgId) — READ path. Counts documents the
//     org has processed this calendar month, returns { count, limit,
//     exceeded }. Used by the UI to render the usage progress bar. NOT
//     race-safe — see enforceUsageLimitOrThrow for the write path.
//   - enforceUsageLimitOrThrow(client, orgId) — WRITE path. Calls the
//     enforce_usage_limit SQL function (migration 026), which acquires
//     a FOR UPDATE lock on the org's usage_limits row inside the same
//     transaction that performs the count + comparison. Throws
//     UsageLimitExceededError (HTTP 429) when the org is at or over
//     its monthly cap. Race-safe against concurrent enforcement calls.
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
import { AppError } from '@/lib/errors';

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

/**
 * Result of an atomic usage-limit enforcement check (write path).
 * Mirrors the row returned by the `enforce_usage_limit` SQL function
 * (migration 026). The `remaining` field is useful for surfacing a
 * "N documents left this month" hint to the user before they hit the
 * wall.
 */
export interface UsageEnforcementResult {
  plan: Plan;
  count: number;
  limit: number;
  remaining: number;
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
// UsageLimitExceededError — typed error for the 429 path
// ---------------------------------------------------------------------------

/**
 * Thrown by enforceUsageLimitOrThrow when an org has hit its monthly
 * document cap. Maps to HTTP 429 (Too Many Requests). The code
 * 'USAGE_LIMIT_EXCEEDED' matches the message raised by the
 * enforce_usage_limit SQL function (migration 026) so the client can
 * pattern-match on either the error.code or the HTTP status.
 *
 * Carries { orgId, count, limit } in `details` so the caller can
 * surface "you've used 25 of 25 documents" in the upgrade prompt
 * without a follow-up DB read.
 */
export class UsageLimitExceededError extends AppError {
  constructor(orgId: string, count: number, limit: number) {
    super(
      `Monthly document limit reached (${count}/${limit}). Upgrade your plan to continue.`,
      429,
      'USAGE_LIMIT_EXCEEDED',
      { orgId, count, limit },
    );
  }
}

// ---------------------------------------------------------------------------
// enforceUsageLimitOrThrow — atomic write-path enforcement
// ---------------------------------------------------------------------------
//
// DISTINCTION FROM checkUsageLimit:
//   checkUsageLimit (above) is the READ path. It counts documents and
//   returns { count, limit, exceeded } so the UI can render a progress
//   bar ("12 / 25 documents this month"). It is NOT race-safe — 50
//   concurrent upload requests can all read count=24, all see
//   exceeded=false, and all proceed to insert, blowing past the cap by
//   up to 50.
//
//   enforceUsageLimitOrThrow (below) is the WRITE path. It calls the
//   enforce_usage_limit SQL function (migration 026), which acquires a
//   FOR UPDATE lock on the org's usage_limits config row inside the
//   same transaction that performs the count + comparison. Concurrent
//   calls serialize on the lock, so the second call cannot read the
//   count until the first call's transaction commits.
//
//   IMPORTANT CAVEAT: when called as a bare RPC (as this wrapper does),
//   the lock is held only for the duration of the RPC. If the caller
//   then does an application-level INSERT (e.g., a separate
//   `client.from('documents').insert(...)`), that INSERT is NOT
//   protected by the lock — the race window re-opens between the RPC
//   return and the INSERT commit. For a fully race-safe write path,
//   callers should use the insert_job_with_usage_check SQL function
//   (also migration 026), which performs the check AND the INSERT
//   inside a single transaction.
//
//   This wrapper is still useful as:
//     - A fast pre-check before uploading bytes to storage (reject
//       obviously-over-limit orgs before the upload).
//     - The UI read path (when combined with checkUsageLimit for the
//       progress bar).
//     - The error path for non-upload endpoints that need to enforce
//       the limit (e.g., a "process this shipment" action).
// ---------------------------------------------------------------------------

/**
 * Atomically enforce the org's monthly document usage limit using a
 * server-side FOR UPDATE lock. Throws UsageLimitExceededError (HTTP 429)
 * if the org is at or over its limit. Call this inside the upload path
 * BEFORE creating any document row or storage upload.
 *
 * This is the race-safe replacement for the read-only checkUsageLimit.
 * The lock is held inside the Postgres function for the duration of the
 * enforcement check, preventing concurrent requests from all passing.
 */
export async function enforceUsageLimitOrThrow(
  client: SupabaseClient,
  orgId: string,
): Promise<UsageEnforcementResult> {
  const { data, error } = await client.rpc('enforce_usage_limit', {
    p_org_id: orgId,
  });

  if (error) {
    // 42901 is the custom SQLSTATE raised by enforce_usage_limit when
    // count >= limit. Map it to a typed 429 error so the API layer's
    // errorResponse() can return a proper 429 to the client.
    //
    // For ANY other error code (DB connection lost, function not
    // deployed, RLS denial, etc.), we rethrow rather than fail open.
    // Failing open on an unexpected error would silently bypass the
    // usage cap — the exact bug this enforcement is meant to prevent.
    // Surface the error so it shows up in logs and Sentry.
    if (error.code === '42901') {
      // The RPC error doesn't carry the count/limit values back
      // (RAISE EXCEPTION discards the function's RETURN values).
      // We pass 0/0 as placeholders; the message is still actionable
      // ("upgrade your plan"). If the caller needs exact numbers for
      // the UI, they can call checkUsageLimit separately (it's cheap).
      throw new UsageLimitExceededError(orgId, 0, 0);
    }

    logger.error('BillingService: enforce_usage_limit RPC failed', {
      orgId,
      errorCode: error.code,
      errorMessage: error.message,
    });
    throw new AppError(
      `Usage limit enforcement check failed: ${error.message}`,
      500,
      'USAGE_ENFORCEMENT_ERROR',
      { orgId, errorCode: error.code },
    );
  }

  // The RPC returns an array of rows (PostgREST convention for
  // set-returning functions). enforce_usage_limit returns exactly one
  // row on success. Normalize to a single object.
  const row = Array.isArray(data) ? data[0] : data;

  if (!row) {
    // Should not happen — the function either returns a row or raises.
    // Treat as an unexpected error (fail closed, not open).
    logger.error('BillingService: enforce_usage_limit returned no row', {
      orgId,
      data,
    });
    throw new AppError(
      'Usage limit enforcement check returned no result',
      500,
      'USAGE_ENFORCEMENT_ERROR',
      { orgId },
    );
  }

  return {
    plan: isPlan(row.plan) ? row.plan : DEFAULT_PLAN,
    count: Number(row.count) || 0,
    limit: Number(row.limit) || 0,
    remaining: Number(row.remaining) || 0,
  };
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

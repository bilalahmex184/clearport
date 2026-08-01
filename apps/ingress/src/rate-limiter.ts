// ============================================================================
// apps/ingress/src/rate-limiter.ts — org-scoped + per-IP rate limiters (KV)
// ============================================================================
// Two layered rate limiters using Cloudflare KV:
//
//   1. checkRateLimit       — org-scoped, 50/hour/org, runs POST-auth.
//   2. checkIpRateLimit     — IP-scoped, 500/hour/IP, runs PRE-auth.
//                             (Phase 5 reality-check fix p5-rc-5.)
//
// Both reuse the same RATE_LIMIT_KV namespace — the IP-keyed keys use a
// distinct prefix (`rate_limit_ip:` vs `rate_limit:`) so the two counters
// never collide. No new KV binding needed.
//
// Key:    rate_limit:{org_id}:{hour_bucket}     (org limiter)
//         rate_limit_ip:{ip}:{hour_bucket}      (IP limiter)
// Value:  count (number of requests in this hour bucket)
// TTL:    3600s (1 hour — KV auto-expires the key)
//
// The hour bucket is `Math.floor(Date.now() / 3_600_000)` — a sliding hour
// window aligned to epoch hours. This means the limit resets at the top of
// the next hour, not 60 minutes after the first request. Simpler + cheaper
// than a true sliding window (which would need a sorted set per org).
//
// KV is eventually consistent (writes propagate within ~60s globally). For
// rate limiting this is acceptable — a brief overage during propagation is
// not a security issue (the downstream usage-limit enforcement in
// billing.service.ts is the hard cap). KV is chosen over Durable Objects
// because it's simpler + cheaper and the consistency tradeoff is acceptable
// for "50/hour" (not "50/second").
//
// WHY ORG_ID IS THE PRIMARY KEY (NOT SOURCE IP) — POST-AUTH LIMITER
//   - A whole org sharing one office NAT IP shouldn't be penalized as a
//     single abusive client.
//   - A single malicious org rotating exit IPs shouldn't evade the limit.
//   Keying by org_id (the authenticated tenant from the JWT) closes both
//   holes. Auth happens BEFORE the org rate-limit check, so orgId is always
//   known + trusted by the time we read it here.
//
// WHY A SECONDARY PER-IP LIMITER IS NEEDED — PRE-AUTH FLOOD DEFENSE
//   The org-keyed limiter only fires POST-auth. A flood of unauthenticated
//   requests (bad JWTs, missing JWTs, brute-force attempts) would burn
//   Worker CPU on JWT verification without ever hitting the org limiter.
//   The per-IP limiter catches these floods BEFORE auth, with a higher
//   threshold (500/hour/IP — 10x the per-org cap) so a legitimate office
//   NAT sharing one IP across multiple orgs isn't blocked.
//
// LAYERING (defense-in-depth, in request order):
//   IP limiter (pre-auth, 500/hour/IP)         ← catches floods before JWT
//   org limiter (post-auth, 50/hour/org)        ← per-tenant fairness
//   billing hard cap (Postgres FOR UPDATE)      ← the real enforcement
//   All three use different mechanisms + different keys, so compromising
//   one doesn't compromise the others.
//
// SOFT GUARD, NOT HARD CAP
//   Both limiters are soft guards against runaway / abusive upload patterns.
//   The HARD cap on usage is `enforceUsageLimitOrThrow` in billing.service.ts
//   (Phase 2 Step 4) — that one is enforced synchronously in Postgres with
//   row locks, not eventually consistent. The KV limiters exist so a tight
//   feedback loop (429 in <50ms) catches abuse before it even reaches the
//   job-creation / Storage path; the billing cap exists so billing is
//   always correct regardless of KV consistency.
// ============================================================================

import type { Env } from './env';

/**
 * Maximum extractions allowed per org per hour. Tunable via this constant —
 * not a magic number. The original design (Phase 5 Step 1) calls for 50.
 */
export const RATE_LIMIT_PER_HOUR = 50;

/**
 * Per-IP secondary rate limit (Phase 5 reality-check fix p5-rc-5).
 *
 * 500 extractions / hour / IP — 10x the per-org limit. A whole office
 * sharing one NAT IP shouldn't be blocked (50/org × multiple orgs behind
 * one IP = legit traffic well under 500), but a single IP doing 500+ is
 * abuse (e.g. an attacker rotating orgs but stuck on one exit, or a
 * misconfigured client in a tight loop).
 *
 * Runs BEFORE auth (pre-auth flood defense) on the same RATE_LIMIT_KV
 * namespace — no new binding needed. The hard cap on usage stays in
 * billing.service.ts (Postgres FOR UPDATE); this is defense-in-depth for
 * the pre-auth window where the org-keyed limiter can't fire yet.
 */
export const IP_RATE_LIMIT_PER_HOUR = 500;

/**
 * The hour-bucket window length in seconds. Also used as the KV TTL so the
 * key auto-expires at the end of the window — no cleanup cron needed.
 */
export const RATE_LIMIT_WINDOW_SECONDS = 3600;

/** The hour-bucket size in milliseconds (1 hour). */
const HOUR_MS = RATE_LIMIT_WINDOW_SECONDS * 1000;

/**
 * Compute the epoch-aligned hour bucket for a given timestamp. All requests
 * within the same wall-clock hour share a bucket; the bucket flips over at
 * the top of the next hour.
 *
 * Exposed (and pure) so tests can drive it without going through KV.
 */
export function hourBucketFor(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / HOUR_MS);
}

/**
 * Compute the epoch-ms timestamp at which the CURRENT hour bucket resets —
 * i.e. the start of the next epoch-aligned hour. Exposed so the Worker can
 * build a `Retry-After` header from it.
 */
export function resetAtFor(nowMs: number = Date.now()): number {
  return (hourBucketFor(nowMs) + 1) * HOUR_MS;
}

/** The shape returned by checkRateLimit. The Worker uses this to build its 429. */
export interface RateLimitResult {
  /** Whether this request is allowed under the limit. */
  allowed: boolean;
  /** The request count in this hour bucket AFTER this call (1-indexed when allowed). */
  count: number;
  /** The configured limit (50). Echoed for the client + logs. */
  limit: number;
  /** Epoch-ms timestamp at which the bucket resets (start of next hour). */
  resetAt: number;
}

/**
 * Check (and increment) the org's hourly extraction count in KV.
 *
 *   - If the count is already >= RATE_LIMIT_PER_HOUR, returns
 *     `{ allowed: false, count, limit, resetAt }` WITHOUT incrementing
 *     (rejected requests don't consume a slot).
 *   - If the count is < RATE_LIMIT_PER_HOUR, increments + writes back with
 *     a TTL of RATE_LIMIT_WINDOW_SECONDS, returns
 *     `{ allowed: true, count: count + 1, limit, resetAt }`.
 *
 * KV read-modify-write is NOT atomic. Under concurrent bursts from the same
 * org, two in-flight requests can both read count=49 and both write count=50
 * — net result: 51 requests slip through instead of 50. This is acceptable
 * (see the "soft guard" comment above) and self-corrects within the
 * eventual-consistency window. The billing.service.ts cap is the hard backstop.
 */
export async function checkRateLimit(
  env: Env,
  orgId: string,
): Promise<RateLimitResult> {
  const now = Date.now();
  const bucket = hourBucketFor(now);
  const resetAt = (bucket + 1) * HOUR_MS;
  const key = `rate_limit:${orgId}:${bucket}`;

  // Read the current count. KV stores strings; missing key → 0.
  const raw = await env.RATE_LIMIT_KV.get(key);
  const currentCount = raw === null ? 0 : Number.parseInt(raw, 10);
  // Defensive: a corrupted value shouldn't crash the request path. Treat
  // NaN as 0 (allow this request, write a clean value back).
  const safeCount = Number.isFinite(currentCount) ? currentCount : 0;

  if (safeCount >= RATE_LIMIT_PER_HOUR) {
    return {
      allowed: false,
      count: safeCount,
      limit: RATE_LIMIT_PER_HOUR,
      resetAt,
    };
  }

  const newCount = safeCount + 1;
  await env.RATE_LIMIT_KV.put(key, String(newCount), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });

  return {
    allowed: true,
    count: newCount,
    limit: RATE_LIMIT_PER_HOUR,
    resetAt,
  };
}

// ---------------------------------------------------------------------------
// checkIpRateLimit — per-IP secondary rate limiter (Phase 5 reality-check fix
// p5-rc-5). Same KV pattern as checkRateLimit, but:
//   - keyed `rate_limit_ip:{ip}:{hourBucket}` (separate namespace from the
//     org-keyed limiter so the two counters don't collide),
//   - limit is IP_RATE_LIMIT_PER_HOUR (500, 10x the per-org cap),
//   - runs BEFORE auth (pre-auth flood defense — see apps/ingress/src/index.ts).
//
// LAYERING (defense-in-depth):
//   IP limiter (pre-auth, 500/hour/IP)         ← catches floods before JWT
//   org limiter (post-auth, 50/hour/org)        ← per-tenant fairness
//   billing hard cap (Postgres FOR UPDATE)      ← the real enforcement
//
// All three use different mechanisms + different keys, so compromising one
// doesn't compromise the others. The IP limiter is the only one that can
// catch a flood of UNAUTHENTICATED requests (the org limiter needs the
// verified orgId from the JWT, the billing cap needs the org row in
// Postgres — both require auth first).
//
// KV read-modify-write is NOT atomic (same caveat as checkRateLimit). Under
// concurrent bursts from one IP, two in-flight requests can both read
// count=499 and both write count=500 — net 501 slip through. Self-corrects
// within the eventual-consistency window; the org limiter + billing hard
// cap are the backstops.
//
// Reuses RATE_LIMIT_KV (no new binding). The IP-keyed keys live in the same
// namespace as the org-keyed keys but with a distinct prefix
// (`rate_limit_ip:` vs `rate_limit:`), so there's no collision.
// ---------------------------------------------------------------------------
export async function checkIpRateLimit(
  env: Env,
  ip: string,
): Promise<RateLimitResult> {
  const now = Date.now();
  const bucket = hourBucketFor(now);
  const resetAt = (bucket + 1) * HOUR_MS;
  // Distinct prefix from the org-keyed limiter (`rate_limit:`) so the two
  // counters never collide even if an org_id happened to look like an IP.
  const key = `rate_limit_ip:${ip}:${bucket}`;

  const raw = await env.RATE_LIMIT_KV.get(key);
  const currentCount = raw === null ? 0 : Number.parseInt(raw, 10);
  const safeCount = Number.isFinite(currentCount) ? currentCount : 0;

  if (safeCount >= IP_RATE_LIMIT_PER_HOUR) {
    return {
      allowed: false,
      count: safeCount,
      limit: IP_RATE_LIMIT_PER_HOUR,
      resetAt,
    };
  }

  const newCount = safeCount + 1;
  await env.RATE_LIMIT_KV.put(key, String(newCount), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });

  return {
    allowed: true,
    count: newCount,
    limit: IP_RATE_LIMIT_PER_HOUR,
    resetAt,
  };
}

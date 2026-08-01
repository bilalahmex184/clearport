// ============================================================================
// 20-rate-limiter.test.ts — Phase 5 Step 1 (org-scoped rate limiting on ingress)
// ============================================================================
// Verifies the org-scoped rate limiter (apps/ingress/src/rate-limiter.ts):
//
//   - 50 extractions / hour / org, keyed by org_id (NOT source IP).
//   - The 51st request in an hour window is rejected (allowed: false).
//   - The hour bucket is epoch-aligned — it resets at the top of the next
//     hour, NOT 60 minutes after the first request.
//   - The count is scoped per org (org_a's 50 requests don't affect org_b).
//   - resetAt is the start of the next epoch-aligned hour.
//   - The ingress Worker calls checkRateLimit AFTER auth + BEFORE file
//     validation (static assertion on the source).
//
// MOCKING CLOUDFLARE KV
//   Real Cloudflare KV isn't available in vitest (it needs a Worker runtime
//   + a real namespace id). We mock it with an in-memory Map that implements
//   the same KVNamespace interface the Env declares (get + put with
//   expirationTtl). The TTL is ignored — the bucket-reset test mocks
//   Date.now() instead, which is the actual mechanism the rate limiter uses
//   to compute the bucket.
//
// ⚠️ KV IS EVENTUALLY CONSISTENT — THE HARD CAP IS IN billing.service.ts
//   This rate limiter is a SOFT guard. KV writes propagate globally within
//   ~60s, so under a burst from a single org, two in-flight requests can
//   both read count=49 and both write count=50 — net 51 requests slip
//   through instead of 50. This is acceptable: the HARD cap on usage is
//   `enforceUsageLimitOrThrow` in billing.service.ts (Phase 2 Step 4),
//   enforced synchronously in Postgres with row locks (not eventually
//   consistent). The KV limiter exists for fast feedback (429 in <50ms on
//   runaway abuse) — it is NOT the source of truth for billing. If billing
//   accuracy ever depended on this limiter being exact, that would be a
//   bug; the test below asserts the limiter source explicitly documents
//   billing.service.ts as the hard cap so a future reader doesn't mistake
//   this for the enforcement boundary.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  checkRateLimit,
  checkIpRateLimit,
  RATE_LIMIT_PER_HOUR,
  IP_RATE_LIMIT_PER_HOUR,
  RATE_LIMIT_WINDOW_SECONDS,
  hourBucketFor,
  resetAtFor,
} from '../../apps/ingress/src/rate-limiter';
import type { Env, KVNamespace } from '../../apps/ingress/src/env';

// ---------------------------------------------------------------------------
// Mock KV — an in-memory Map that implements the KVNamespace interface the
// Env declares. The TTL is ignored (the bucket-reset test mocks Date.now).
// ---------------------------------------------------------------------------

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(
      key: string,
      value: string,
      _options?: { expirationTtl?: number },
    ) {
      store.set(key, value);
    },
  } as KVNamespace;
}

/**
 * Build a minimal Env with just the RATE_LIMIT_KV binding populated. The
 * rate limiter only touches env.RATE_LIMIT_KV, so the other fields can be
 * stubbed. `as unknown as Env` because Env requires non-optional Supabase
 * + Queue fields the rate limiter doesn't use.
 */
function makeEnv(kv: KVNamespace): Env {
  return { RATE_LIMIT_KV: kv } as unknown as Env;
}

// Fixed "now" for deterministic tests — an arbitrary epoch ms that lands
// cleanly inside an hour bucket. All tests that don't mock Date.now run at
// the real wall-clock time; tests that DO mock it (bucket reset) restore
// afterwards.
const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z

describe('Phase 5 Step 1 — org-scoped rate limiter (50 extractions/hour/org)', () => {
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    originalDateNow = Date.now;
  });
  afterEach(() => {
    Date.now = originalDateNow;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1 — the first 50 requests are allowed (count 1..50).
  // -------------------------------------------------------------------------
  describe('Test 1 — the first 50 requests are allowed', () => {
    it('returns allowed:true with monotonically increasing count 1..50', async () => {
      Date.now = () => FIXED_NOW;
      const env = makeEnv(createMockKV());
      const orgId = 'org-aaa';

      for (let i = 1; i <= RATE_LIMIT_PER_HOUR; i++) {
        const result = await checkRateLimit(env, orgId);
        expect(result.allowed).toBe(true);
        expect(result.count).toBe(i);
        expect(result.limit).toBe(50);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Test 2 — the 51st request is rejected (allowed: false).
  // -------------------------------------------------------------------------
  describe('Test 2 — the 51st request is rejected', () => {
    it('returns allowed:false after 50 allowed requests', async () => {
      Date.now = () => FIXED_NOW;
      const env = makeEnv(createMockKV());
      const orgId = 'org-bbb';

      // Burn through the 50 allowed requests.
      for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
        const r = await checkRateLimit(env, orgId);
        expect(r.allowed).toBe(true);
      }

      // The 51st is rejected.
      const result = await checkRateLimit(env, orgId);
      expect(result.allowed).toBe(false);
      expect(result.count).toBe(50);
      expect(result.limit).toBe(50);
    });

    it('a rejected request does NOT increment the count (slot is preserved)', async () => {
      Date.now = () => FIXED_NOW;
      const env = makeEnv(createMockKV());
      const orgId = 'org-bbb-2';

      for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
        await checkRateLimit(env, orgId);
      }
      // Rejected requests don't consume a slot.
      const first = await checkRateLimit(env, orgId);
      const second = await checkRateLimit(env, orgId);
      expect(first.allowed).toBe(false);
      expect(second.allowed).toBe(false);
      expect(first.count).toBe(50);
      expect(second.count).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3 — the count is keyed by org_id (no cross-org interference).
  // -------------------------------------------------------------------------
  describe('Test 3 — the count is keyed by org_id', () => {
    it('50 requests from org_a do not affect org_b (org_b first → allowed, count 1)', async () => {
      Date.now = () => FIXED_NOW;
      const env = makeEnv(createMockKV());

      // Exhaust org_a's quota.
      for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
        const r = await checkRateLimit(env, 'org_a');
        expect(r.allowed).toBe(true);
      }
      // org_a is now blocked.
      const orgaBlocked = await checkRateLimit(env, 'org_a');
      expect(orgaBlocked.allowed).toBe(false);

      // org_b is unaffected — its first request is allowed with count 1.
      const orgbFirst = await checkRateLimit(env, 'org_b');
      expect(orgbFirst.allowed).toBe(true);
      expect(orgbFirst.count).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Test 4 — the hour bucket resets at the next epoch-aligned hour.
  // -------------------------------------------------------------------------
  describe('Test 4 — the hour bucket resets', () => {
    it('after time advances to the next hour bucket, the count resets to 0', async () => {
      // Hour 0 (FIXED_NOW). Burn the quota.
      Date.now = () => FIXED_NOW;
      const kv = createMockKV();
      const env = makeEnv(kv);
      const orgId = 'org-ccc';

      for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
        await checkRateLimit(env, orgId);
      }
      const blocked = await checkRateLimit(env, orgId);
      expect(blocked.allowed).toBe(false);

      // Advance exactly one hour bucket. The key changes
      // (rate_limit:org-ccc:N → rate_limit:org-ccc:N+1), so KV returns null
      // for the new key — count starts at 0 again.
      Date.now = () => FIXED_NOW + RATE_LIMIT_WINDOW_SECONDS * 1000;

      const after = await checkRateLimit(env, orgId);
      expect(after.allowed).toBe(true);
      expect(after.count).toBe(1);
    });

    it('the bucket key actually changes when the hour flips (no stale key reuse)', async () => {
      const hour0 = FIXED_NOW;
      const hour1 = FIXED_NOW + RATE_LIMIT_WINDOW_SECONDS * 1000;
      expect(hourBucketFor(hour0)).not.toBe(hourBucketFor(hour1));
      expect(hourBucketFor(hour1) - hourBucketFor(hour0)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Test 5 — resetAt is the start of the next epoch-aligned hour.
  // -------------------------------------------------------------------------
  describe('Test 5 — resetAt is the start of the next hour', () => {
    it('resetAt = (floor(now/3_600_000) + 1) * 3_600_000', async () => {
      Date.now = () => FIXED_NOW;
      const env = makeEnv(createMockKV());

      const result = await checkRateLimit(env, 'org-ddd');
      const expected = (Math.floor(FIXED_NOW / 3_600_000) + 1) * 3_600_000;
      expect(result.resetAt).toBe(expected);
    });

    it('resetAtFor helper matches the inline computation', () => {
      // Multiple timestamps across multiple hours to ensure the helper
      // agrees with the canonical formula everywhere, not just at one point.
      const samples = [
        FIXED_NOW,
        FIXED_NOW + 1_800_000, // +30min — still same hour
        FIXED_NOW + 3_600_000, // +1h — next hour
        FIXED_NOW + 3_599_999, // +59:59.999 — still same hour
        Date.UTC(2024, 0, 1, 0, 0, 0), // midnight UTC, clean boundary
        Date.UTC(2024, 0, 1, 0, 59, 59, 999),
      ];
      for (const ts of samples) {
        const expected = (Math.floor(ts / 3_600_000) + 1) * 3_600_000;
        expect(resetAtFor(ts)).toBe(expected);
      }
    });

    it('resetAt is always in the future (strictly > now)', async () => {
      Date.now = () => FIXED_NOW;
      const env = makeEnv(createMockKV());
      const result = await checkRateLimit(env, 'org-eee');
      expect(result.resetAt).toBeGreaterThan(FIXED_NOW);
    });
  });

  // -------------------------------------------------------------------------
  // Test 6 — KV is eventually consistent; the hard cap is in billing.service.ts.
  // -------------------------------------------------------------------------
  describe('Test 6 — KV is eventually consistent (the hard cap is in billing.service.ts)', () => {
    // This is a documentation test. The rate limiter is a SOFT guard, NOT a
    // hard cap. KV is eventually consistent (~60s global propagation), so a
    // burst of concurrent requests from one org can slip through 51 (or a
    // few more) before the writes propagate. The HARD cap — the one billing
    // actually depends on — is `enforceUsageLimitOrThrow` in
    // billing.service.ts (Phase 2 Step 4), enforced synchronously in
    // Postgres with row locks (not eventually consistent).
    //
    // This test asserts the rate-limiter source explicitly documents the
    // hard cap location, so a future reader doesn't mistake this limiter
    // for the enforcement boundary.
    it('the rate-limiter source documents billing.service.ts as the hard cap', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/rate-limiter.ts'),
        'utf-8',
      );
      expect(src).toMatch(/billing\.service\.ts/);
      expect(src).toMatch(/enforceUsageLimitOrThrow/);
      // The "soft guard" framing must be present so the tradeoff is explicit.
      expect(src).toMatch(/soft guard/i);
    });

    it('the rate-limiter source documents KV eventual consistency', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/rate-limiter.ts'),
        'utf-8',
      );
      expect(src).toMatch(/eventually consistent/i);
    });

    it('a non-numeric KV value is treated as 0 (does not crash the request path)', async () => {
      // Simulates a corrupted KV value (e.g. a bad deploy wrote garbage).
      // The limiter must NOT throw — it should treat the value as 0 and
      // allow the request, writing a clean value back. A crash here would
      // fail OPEN (since the ingress Worker's catch proceeds), but the
      // cleaner behavior is to fail CLOSED-ish: treat as 0, allow this
      // request, write a clean value. The hard cap in billing.service.ts
      // still applies either way.
      Date.now = () => FIXED_NOW;
      const kv = createMockKV();
      // Pre-seed a corrupt value at the key the limiter will read.
      const key = `rate_limit:org-ggg:${hourBucketFor(FIXED_NOW)}`;
      await kv.put(key, 'not-a-number');
      const env = makeEnv(kv);

      const result = await checkRateLimit(env, 'org-ggg');
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(1); // treated NaN as 0, wrote 1 back
      // The clean value was written back.
      expect(await kv.get(key)).toBe('1');
    });
  });

  // -------------------------------------------------------------------------
  // Test 7 — static assertion: the ingress Worker calls checkRateLimit BEFORE
  // validateUploadedFile in the source.
  // -------------------------------------------------------------------------
  describe('Test 7 — ingress Worker calls checkRateLimit BEFORE validateUploadedFile', () => {
    it('checkRateLimit(env, orgId) call appears before the validateUploadedFile({...}) call', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/index.ts'),
        'utf-8',
      );

      // The CALL sites (not the imports). The import of validateUploadedFile
      // appears above the import of checkRateLimit, so we must search for
      // the actual invocations.
      //   - checkRateLimit(env, orgId) — the call in Step 1b
      //   - validateUploadedFile({     — the call in Step 2
      const rlCallIdx = src.indexOf('checkRateLimit(env, orgId)');
      const validateCallIdx = src.indexOf('validateUploadedFile({');

      expect(rlCallIdx).toBeGreaterThan(-1);
      expect(validateCallIdx).toBeGreaterThan(-1);
      expect(rlCallIdx).toBeLessThan(validateCallIdx);
    });

    it('the rate-limit block is between auth and file validation in the source', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/index.ts'),
        'utf-8',
      );

      // Markers (in expected source order):
      //   1. const { userId, orgId } = auth;        — end of Step 1 (auth)
      //   2. checkRateLimit(env, orgId)             — Step 1b (rate limit)
      //   3. validateUploadedFile({                 — Step 2 (file validation)
      const authEnd = src.indexOf('const { userId, orgId } = auth;');
      const rlCall = src.indexOf('checkRateLimit(env, orgId)');
      const validateCall = src.indexOf('validateUploadedFile({');

      expect(authEnd).toBeGreaterThan(-1);
      expect(rlCall).toBeGreaterThan(authEnd);
      expect(validateCall).toBeGreaterThan(rlCall);
    });

    it('the 429 response carries Retry-After + reset_at + count + limit', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/index.ts'),
        'utf-8',
      );
      // The task spec requires these four fields on the 429 body / headers.
      expect(src).toMatch(/status:\s*429/);
      expect(src).toMatch(/Retry-After/);
      expect(src).toMatch(/reset_at/);
      expect(src).toMatch(/count/);
      expect(src).toMatch(/limit/);
    });

    it('the rate-limit hit is logged via logWarn (the shared logger), not console.log', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/index.ts'),
        'utf-8',
      );
      expect(src).toMatch(/import\s*\{[^}]*logWarn[^}]*\}\s*from\s*['"]@clearport\/shared\/logger['"]/);
      // The rate-limit-hit log call must use logWarn with the documented context.
      expect(src).toMatch(/logWarn\([\s\S]*?step:\s*['"]rate_limit['"]/);
    });
  });

  // -------------------------------------------------------------------------
  // Sanity — the exported constants match the spec.
  // -------------------------------------------------------------------------
  describe('exported constants', () => {
    it('RATE_LIMIT_PER_HOUR is 50', () => {
      expect(RATE_LIMIT_PER_HOUR).toBe(50);
    });
    it('RATE_LIMIT_WINDOW_SECONDS is 3600', () => {
      expect(RATE_LIMIT_WINDOW_SECONDS).toBe(3600);
    });
  });
});

// ===========================================================================
// Per-IP secondary rate limiter — Phase 5 reality-check fix p5-rc-5
// ===========================================================================
// The org-keyed limiter (above) only fires POST-auth. A flood of
// UNAUTHENTICATED requests (bad JWTs, missing JWTs, brute-force attempts)
// would burn Worker CPU on JWT verification without ever hitting the org
// limiter. The per-IP limiter (500/hour/IP) catches these floods BEFORE
// auth, with a higher threshold so a legitimate office NAT sharing one IP
// across multiple orgs isn't blocked.
//
// Layering (in request order):
//   IP limiter  (pre-auth,  500/hour/IP)   ← catches floods before JWT
//   org limiter (post-auth, 50/hour/org)   ← per-tenant fairness
//   billing hard cap (Postgres FOR UPDATE) ← the real enforcement
// ===========================================================================

describe('Phase 5 reality-check fix p5-rc-5 — Per-IP secondary rate limiter (500/hour/IP)', () => {
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    originalDateNow = Date.now;
  });
  afterEach(() => {
    Date.now = originalDateNow;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test IP-1 — the first 500 requests from one IP are allowed.
  // -------------------------------------------------------------------------
  describe('Test IP-1 — the first 500 requests from one IP are allowed', () => {
    it('returns allowed:true with monotonically increasing count 1..500', async () => {
      Date.now = () => FIXED_NOW;
      const env = makeEnv(createMockKV());
      const ip = '203.0.113.42';

      for (let i = 1; i <= IP_RATE_LIMIT_PER_HOUR; i++) {
        const result = await checkIpRateLimit(env, ip);
        expect(result.allowed).toBe(true);
        expect(result.count).toBe(i);
        expect(result.limit).toBe(500);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Test IP-2 — the 501st request from the same IP is rejected.
  // -------------------------------------------------------------------------
  describe('Test IP-2 — the 501st request from the same IP is rejected', () => {
    it('returns allowed:false after 500 allowed requests', async () => {
      Date.now = () => FIXED_NOW;
      const env = makeEnv(createMockKV());
      const ip = '198.51.100.7';

      // Burn through the 500 allowed requests.
      for (let i = 0; i < IP_RATE_LIMIT_PER_HOUR; i++) {
        const r = await checkIpRateLimit(env, ip);
        expect(r.allowed).toBe(true);
      }

      // The 501st is rejected.
      const result = await checkIpRateLimit(env, ip);
      expect(result.allowed).toBe(false);
      expect(result.count).toBe(500);
      expect(result.limit).toBe(500);
    });

    it('a rejected IP request does NOT increment the count (slot is preserved)', async () => {
      Date.now = () => FIXED_NOW;
      const env = makeEnv(createMockKV());
      const ip = '198.51.100.8';

      for (let i = 0; i < IP_RATE_LIMIT_PER_HOUR; i++) {
        await checkIpRateLimit(env, ip);
      }
      // Rejected requests don't consume a slot.
      const first = await checkIpRateLimit(env, ip);
      const second = await checkIpRateLimit(env, ip);
      expect(first.allowed).toBe(false);
      expect(second.allowed).toBe(false);
      expect(first.count).toBe(500);
      expect(second.count).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // Test IP-3 — different IPs have independent counters.
  // -------------------------------------------------------------------------
  describe('Test IP-3 — different IPs have independent counters', () => {
    it('500 requests from IP-A do not affect IP-B (IP-B first → allowed, count 1)', async () => {
      Date.now = () => FIXED_NOW;
      const env = makeEnv(createMockKV());

      const ipA = '203.0.113.10';
      const ipB = '203.0.113.20';

      // Exhaust IP-A's quota.
      for (let i = 0; i < IP_RATE_LIMIT_PER_HOUR; i++) {
        const r = await checkIpRateLimit(env, ipA);
        expect(r.allowed).toBe(true);
      }
      // IP-A is now blocked.
      const ipABlocked = await checkIpRateLimit(env, ipA);
      expect(ipABlocked.allowed).toBe(false);

      // IP-B is unaffected — its first request is allowed with count 1.
      const ipBFirst = await checkIpRateLimit(env, ipB);
      expect(ipBFirst.allowed).toBe(true);
      expect(ipBFirst.count).toBe(1);
    });

    it('the IP-keyed KV keys do not collide with the org-keyed limiter keys', async () => {
      // Even if an org_id happened to look like an IP (unlikely but
      // theoretically possible if someone passed the wrong field), the
      // distinct prefixes (`rate_limit:` vs `rate_limit_ip:`) keep the
      // counters separate. This is the key-collision safety guarantee.
      Date.now = () => FIXED_NOW;
      const env = makeEnv(createMockKV());

      // Same string used as both an org_id and an IP — would collide if
      // the prefixes weren't distinct.
      const collisionString = '203.0.113.99';
      await checkRateLimit(env, collisionString);
      await checkIpRateLimit(env, collisionString);

      // Both counters should be 1 (independent), not 2 (shared).
      const orgResult = await checkRateLimit(env, collisionString);
      const ipResult = await checkIpRateLimit(env, collisionString);
      expect(orgResult.count).toBe(2); // 1 + 1
      expect(ipResult.count).toBe(2); // 1 + 1 (separate counter)
    });
  });

  // -------------------------------------------------------------------------
  // Test IP-4 — the IP limiter uses the SAME KV namespace (no new binding).
  // -------------------------------------------------------------------------
  describe('Test IP-4 — IP limiter uses the same RATE_LIMIT_KV namespace', () => {
    it('the rate-limiter source documents that the IP limiter reuses RATE_LIMIT_KV (no new binding)', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/rate-limiter.ts'),
        'utf-8',
      );
      // The IP limiter must explicitly document that it reuses RATE_LIMIT_KV
      // (no new binding) so a future reader doesn't think a separate
      // RATE_LIMIT_IP_KV is needed.
      expect(src).toMatch(/RATE_LIMIT_KV/);
      expect(src).toMatch(/no new binding/i);
    });

    it('checkIpRateLimit reads + writes to env.RATE_LIMIT_KV (not a separate binding)', async () => {
      Date.now = () => FIXED_NOW;
      const kv = createMockKV();
      const env = makeEnv(kv);
      const ip = '203.0.113.50';

      await checkIpRateLimit(env, ip);

      // The key is `rate_limit_ip:{ip}:{hourBucket}` and lives in the
      // same KV namespace. Read it back directly from the mock to confirm.
      const key = `rate_limit_ip:${ip}:${hourBucketFor(FIXED_NOW)}`;
      expect(await kv.get(key)).toBe('1');
    });

    it('the IP limiter uses the rate_limit_ip: prefix (distinct from rate_limit:)', async () => {
      Date.now = () => FIXED_NOW;
      const kv = createMockKV();
      const env = makeEnv(kv);

      await checkIpRateLimit(env, '203.0.113.60');
      await checkRateLimit(env, 'org-xyz');

      // Two distinct keys in the KV — no collision.
      const ipKey = `rate_limit_ip:203.0.113.60:${hourBucketFor(FIXED_NOW)}`;
      const orgKey = `rate_limit:org-xyz:${hourBucketFor(FIXED_NOW)}`;
      expect(await kv.get(ipKey)).toBe('1');
      expect(await kv.get(orgKey)).toBe('1');
    });
  });

  // -------------------------------------------------------------------------
  // Test IP-5 — static assertion: the ingress calls checkIpRateLimit BEFORE
  // checkRateLimit (pre-auth flood defense runs before the post-auth org
  // limiter).
  // -------------------------------------------------------------------------
  describe('Test IP-5 — ingress calls checkIpRateLimit BEFORE checkRateLimit', () => {
    it('the checkIpRateLimit call appears before the checkRateLimit call in index.ts', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/index.ts'),
        'utf-8',
      );

      // Find the CALL sites (not the import line, which mentions both).
      const ipCallIdx = src.indexOf('checkIpRateLimit(env, ip)');
      const orgCallIdx = src.indexOf('checkRateLimit(env, orgId)');

      expect(ipCallIdx).toBeGreaterThan(-1);
      expect(orgCallIdx).toBeGreaterThan(-1);
      expect(ipCallIdx).toBeLessThan(orgCallIdx);
    });

    it('the IP limiter runs BEFORE the JWT verification (verifyJwtAndMembership)', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/index.ts'),
        'utf-8',
      );

      // verifyJwtAndMembership is the auth call in Step 1. The IP limiter
      // must run BEFORE it (pre-auth flood defense).
      const ipCallIdx = src.indexOf('checkIpRateLimit(env, ip)');
      const authCallIdx = src.indexOf('verifyJwtAndMembership(req, env)');

      expect(ipCallIdx).toBeGreaterThan(-1);
      expect(authCallIdx).toBeGreaterThan(-1);
      expect(ipCallIdx).toBeLessThan(authCallIdx);
    });

    it('the IP-extraction logic reads CF-Connecting-IP first, X-Forwarded-For as fallback', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/index.ts'),
        'utf-8',
      );
      // CF-Connecting-IP is the canonical source on Cloudflare (set by the
      // edge, trusted). X-Forwarded-For is a fallback for non-Cloudflare
      // deployments (its chain can be spoofed by the client).
      expect(src).toMatch(/CF-Connecting-IP/);
      expect(src).toMatch(/X-Forwarded-For/);
      // The 'unknown' fallback shares a single bucket so an attacker who
      // strips both headers is rate-limited as one IP (500/hour total).
      expect(src).toMatch(/['"]unknown['"]/);
    });

    it('the IP 429 response carries Retry-After + reset_at + count + limit', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/index.ts'),
        'utf-8',
      );
      // The IP 429 body must mirror the org 429 body shape (limit, reset_at,
      // count) + a Retry-After header for compliant HTTP clients.
      expect(src).toMatch(/IP rate limit exceeded/);
      expect(src).toMatch(/Retry-After/);
      expect(src).toMatch(/reset_at/);
      expect(src).toMatch(/count/);
      expect(src).toMatch(/limit/);
    });

    it('the IP limiter fail-open path is logged via logWarn (KV outage → proceed)', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/index.ts'),
        'utf-8',
      );
      // KV outage on the IP limiter must log + proceed (fail open), matching
      // the org limiter's pattern. The hard cap in billing.service.ts is the
      // backstop. Logged at WARN (operational issue, not a pipeline failure).
      expect(src).toMatch(/IP rate-limit check threw/);
      expect(src).toMatch(/step:\s*['"]rate_limit_ip['"]/);
    });

    it('the IP limiter documents the defense-in-depth layering in a comment', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/ingress/src/index.ts'),
        'utf-8',
      );
      // The layering comment must mention all three layers so a future reader
      // understands the IP limiter is defense-in-depth, not the primary
      // enforcement boundary.
      expect(src).toMatch(/IP limiter/);
      expect(src).toMatch(/org limiter/);
      expect(src).toMatch(/billing hard cap/);
      expect(src).toMatch(/defense-in-depth/i);
    });
  });

  // -------------------------------------------------------------------------
  // Sanity — the IP limiter exported constant matches the spec.
  // -------------------------------------------------------------------------
  describe('IP limiter exported constants', () => {
    it('IP_RATE_LIMIT_PER_HOUR is 500 (10x the per-org cap)', () => {
      expect(IP_RATE_LIMIT_PER_HOUR).toBe(500);
      expect(IP_RATE_LIMIT_PER_HOUR).toBe(RATE_LIMIT_PER_HOUR * 10);
    });
  });
});

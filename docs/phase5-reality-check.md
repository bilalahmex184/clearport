# Phase 5 Reality Check — Known Tradeoffs

## Point 1: KV Consistency Risk (acknowledged, not fixable)

### The tradeoff
Cloudflare KV is **eventually consistent**. The system uses KV for:
- Rate limiting (`RATE_LIMIT_KV` — org-keyed + IP-keyed counters)
- Circuit breaker state (`CIRCUIT_BREAKER_KV` — per-provider+model)

### What this means in practice
- **Rate limit can be bypassed briefly under concurrency**: two requests hitting different KV edge locations within the ~60s propagation window may both read the old count and both pass. Under a burst, the limit may be exceeded by a few requests.
- **Circuit breaker may lag across regions**: one region may trip the breaker (5 failures → OPEN) while another region's consumer still sees CLOSED and attempts the call. The breaker is a SOFT guard, not a hard gate.

### Why this is acceptable (the mitigation layering)
The KV-backed mechanisms are **soft guards** — they exist to provide fast feedback (429 in <50ms, breaker skip in <1ms) and reduce waste, NOT to be the hard enforcement boundary. The hard caps are:

| Concern | Soft guard (KV, eventually consistent) | Hard cap (Postgres, strongly consistent) |
|---------|----------------------------------------|------------------------------------------|
| Usage limit | Rate limiter (50/hour/org, KV) | `enforceUsageLimitOrThrow` (Postgres `FOR UPDATE` lock, Phase 2 Step 4) |
| Job double-processing | Circuit breaker (skip OpenRouter) | Fencing token (`claim_job` + `complete_job`, Phase 3 Point 4) |
| Job stuck | — | `reclaim_stuck_jobs_v2` (Postgres, Phase 3 Step 3) |

The hard caps are **strongly consistent** (Postgres `FOR UPDATE` row locks). A KV bypass at most lets a few extra requests through to the Postgres layer, where the `FOR UPDATE` lock serializes them. The user sees a 429 from Postgres instead of from KV — same outcome, slightly later in the stack.

### When to upgrade to Durable Objects
If the KV consistency tradeoff proves insufficient in production (measurable abuse during propagation windows), the rate limiter + circuit breaker can be ported to **Cloudflare Durable Objects**, which provide strong per-key consistency. The migration is mechanical (same interface, different backing store) because the current code is already isolated in `rate-limiter.ts` + `circuit-breaker.ts`. The trigger to upgrade: if `/api/metrics` shows the rate limiter being bypassed by >5% under load, or if the circuit breaker's per-model tracking proves too laggy to catch real outages fast enough.

### Point 5: Fail-open rate limiting (the abuse window)
The rate limiter **fails open** on KV outage (logs a warning, proceeds). This is the correct UX tradeoff — a KV outage is operational, not a reason to block legitimate uploads. The abuse window during a KV outage is real but bounded:
- The **per-IP limiter** (500/hour/IP, added in the reality-check fix) provides a secondary defense-in-depth layer that catches pre-auth floods even when the org-keyed limiter is unavailable.
- The **billing hard cap** (Postgres `FOR UPDATE`) is the real enforcement and is unaffected by KV outages.
- An attacker exploiting the KV outage window is still capped by the Postgres-layer `enforceUsageLimitOrThrow` — they can't exceed the monthly document limit, only the per-hour burst limit.

The layering: **IP limiter** (pre-auth, 500/h, catches floods) → **org limiter** (post-auth, 50/h, per-tenant) → **billing hard cap** (Postgres, per-month, the real enforcement). Three different mechanisms, three different keys, three different consistency models.

---

## Point 3: Latency explosion risk (fixed)

### The fix
`PIPELINE_DEADLINE_MS = 150_000` (2.5 min) is the cross-tier budget. `withRetry` checks the deadline before each retry sleep; if the next backoff would exceed it, the retry is aborted and the tier fails fast. This bounds the worst-case total pipeline latency to `PIPELINE_DEADLINE_MS + MAX_TIER_LATENCY_MS = 150 + 18 = 168s`, well under the 5-min (300s) `claim_job` TTL.

### What this prevents
Without the deadline, retry backoffs could stack:
- Tier 1: 3 retries × 18s call + (2s + 4s) backoff = ~60s
- Tier 3: 3 retries × 15s call + (2s + 4s) backoff = ~51s
- Tier 4: 3 retries × 25s call + (2s + 4s) backoff = ~81s
- Total: ~192s, with p95 quietly hitting 60s+ on a bad day.

With the deadline, the pipeline aborts at 150s and routes to `needs_manual_review` — the operator sees it on the dashboard (`/api/metrics` → dead_letter depth) and the worker frees up sooner.

### Tuning
Once Phase 5's `/api/metrics` shows real p95/p99 latency, tune `PIPELINE_DEADLINE_MS` to ~2× p99. The current 150s is a conservative guess; the real value will likely be 60-90s for a healthy pipeline.

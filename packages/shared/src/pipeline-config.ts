// ============================================================================
// pipeline-config.ts — Named constants for the extraction pipeline
// ============================================================================
// Phase 4 Step 5: the 30% minimum-viable threshold is a NAMED CONSTANT here,
// not a magic number buried in a conditional. Same for the per-tier latency
// budget and the OpenRouter model fallback list.
// ============================================================================

// ---------------------------------------------------------------------------
// Step 5: Minimum viable extraction rule.
// If more than this fraction of expected fields for the detected document
// type are missing or unverified, the job's overall status is
// needs_manual_review rather than completed, regardless of individual field
// confidences. 0.30 = 30%.
//
// Rationale: a document with 70% of fields present but all at 95% confidence
// is usable; a document with 60% of fields MISSING is not — the missing
// fields might be the critical ones (container number, B/L number). The 30%
// threshold is the point where "too much is unknown to auto-approve" kicks in.
// ---------------------------------------------------------------------------
export const MINIMUM_VIABLE_EXTRACTION_THRESHOLD = 0.30;

// ---------------------------------------------------------------------------
// Per-tier wall-clock budget. ~18s per tier (ported from the Deno edge
// function; re-measured for the Workers runtime — Cloudflare Workers have
// similar cold-start + fetch characteristics). The claim_job TTL is 5 min,
// so all 5 tiers fit comfortably (5 × 18s = 90s << 300s).
//
// Phase 5's metrics will tune this; for now 18s is safe.
// ---------------------------------------------------------------------------
export const MAX_TIER_LATENCY_MS = 18_000;

// ---------------------------------------------------------------------------
// OpenRouter model fallback list (Qwen VL models — primary 32B for speed,
// 72B fallback for quality, 8B last resort for cost).
// The consumer tries each in order until one succeeds.
// ---------------------------------------------------------------------------
export const OPENROUTER_MODELS = [
  'qwen/qwen3-vl-32b-instruct',
  'qwen/qwen2.5-vl-72b-instruct',
  'qwen/qwen3-vl-8b-instruct',
] as const;

// ---------------------------------------------------------------------------
// Verbatim-anchor check threshold (Step 3). 85% similarity between the
// LLM-claimed source snippet and the raw text. Below this, the field's
// confidence is forced down regardless of what the model claimed.
// ---------------------------------------------------------------------------
export const VERBATIM_ANCHOR_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// Model disagreement threshold (Step 3 supplementary). 80% similarity
// between primary and secondary extraction values. Below this, a
// model_disagreement exception is raised (severity MINOR — it's a signal).
// ---------------------------------------------------------------------------
export const MODEL_DISAGREEMENT_THRESHOLD = 0.80;

// ---------------------------------------------------------------------------
// Phase 5 reality check (Point 3): Cross-tier deadline budget.
//
// The total wall-clock budget for the ENTIRE pipeline (all 5 tiers + all
// retries + all backoff sleeps). This is a HARD ceiling: if the pipeline
// exceeds it, the current tier is aborted and the pipeline falls through
// to the next tier (or to needs_manual_review if no tiers remain).
//
// WHY THIS EXISTS
//   Without a cross-tier budget, retry backoffs can stack:
//     Tier 1: 3 retries × 18s call + (2s + 4s) backoff = ~60s
//     Tier 3: 3 retries × 15s call + (2s + 4s) backoff = ~51s
//     Tier 4: 3 retries × 25s call + (2s + 4s) backoff = ~81s
//     Total: ~192s — and p95 could quietly hit 60s+ on a bad day.
//   The 5-min claim_job TTL would eventually catch this, but only after
//   wasting 5 minutes. The cross-tier budget fails faster (at 150s) so
//   the job goes to needs_manual_review sooner, the worker frees up, and
//   the operator sees the problem on the dashboard.
//
// VALUE RATIONALE
//   150s = 2.5 minutes. This is:
//     - Well under the 5-min claim_job TTL (300s) — leaves 150s of headroom
//       for the fencing-protected complete_job + ledger writes.
//     - Above the expected p99 for a healthy pipeline (Phase 5 metrics will
//       confirm; initial estimate: ~30-40s for a clean AI extraction, ~60s
//       for a fallback through tiers 2-4).
//     - Tunable: once Phase 5's /api/metrics shows real p95/p99, tune this
//       to ~2× p99 (documented in the worklog as a follow-up).
//
// LAYERING
//   MAX_TIER_LATENCY_MS (18s) is the per-call timeout handed to fetch().
//   PIPELINE_DEADLINE_MS (150s) is the cross-tier budget that withRetry
//   checks before each retry attempt. If the remaining budget is < the
//   next backoff delay, withRetry aborts instead of sleeping.
// ---------------------------------------------------------------------------
export const PIPELINE_DEADLINE_MS = 150_000;

// ============================================================================
// pipeline-hook.ts — The real 5-tier extraction pipeline (Phase 4 Step 2)
// ============================================================================
// WHAT THIS IS
//   The consumer Worker (src/index.ts) calls `runExtractionPipeline(env, input,
//   claimedJob)` after it has claimed a job and downloaded the file bytes.
//   This file is the BRAIN — it runs the 5-tier fallback chain, then applies
//   the deterministic validators (Step 4), the verbatim-anchor check (Step 3),
//   and the minimum-viable extraction rule (Step 5).
//
//   This REPLACES the Phase 3 stub. The stub returned HOLD with zero fields;
//   this implementation actually extracts.
//
// THE 5-TIER FALLBACK CHAIN (ported from supabase/functions/extract-document)
//   Tier 1: AI vision extraction via OpenRouter (Qwen VL models)
//   Tier 2: PDF embedded text-layer extraction (regex on the text layer)
//   Tier 3: Cloud Vision OCR (if GOOGLE_CLOUD_VISION_API_KEY is set — optional)
//   Tier 4: Tesseract OCR (self-hosted, via the /api/internal/ocr route)
//   Tier 5: needs_manual_review — never silent zero
//
//   Each tier records a job_attempts row (success/failure/skipped) so the
//   audit ledger captures the full cascade. The chain falls through on
//   failure (not exception — exceptions are caught per-tier and recorded).
//
// POST-EXTRACTION VALIDATION (the deterministic ground truth)
//   After ANY tier produces fields:
//     1. mapToCanonicalSchema (Step 1) — normalize LLM key variants to canonical
//     2. runDeterministicValidation (Step 4) — math checks, format validators,
//        cross-doc reconciliation. NEVER let the LLM compute totals.
//     3. runVerbatimAnchorCheck (Step 3) — fuzzy-match LLM-claimed source
//        snippets against raw text. Force confidence down on mismatch.
//        This is the anti-hallucination anchor that doesn't ask the LLM
//        anything.
//     4. applyMinimumViableRule (Step 5) — if >30% of required fields are
//        missing/unverified, decision = needs_manual_review.
//
// WALL-CLOCK BUDGET
//   ~18s per tier (re-measured for the Workers runtime; was 18s in Deno).
//   The claim_job TTL is 5 minutes — plenty of headroom for all 5 tiers.
//   Phase 5's metrics will tune this; for now the 5-min TTL is safe.
// ============================================================================

import type { Env } from './env';
import { supabaseRpc } from './supabase-client';
import {
  mapToCanonicalSchema,
  llmResponseSchema,
  REQUIRED_FIELDS_BY_DOC_TYPE,
  thresholdFor,
  type CanonicalField,
  type DocType,
} from '@clearport/shared/extraction-schema';
import {
  runDeterministicValidation,
  type ValidationException,
} from '@clearport/shared/deterministic-validators';
import {
  runVerbatimAnchorCheck,
  type VerbatimAnchorResult,
} from '@clearport/shared/verbatim-anchor';
import {
  MINIMUM_VIABLE_EXTRACTION_THRESHOLD,
  MAX_TIER_LATENCY_MS,
  OPENROUTER_MODELS,
  PIPELINE_DEADLINE_MS,
} from '@clearport/shared/pipeline-config';
import { extractPdfTextLayer, callOpenRouterExtraction, callCloudVisionOCR, callTesseractOCR } from './tiers';
import { withRetry } from './retry';
// Per-(provider+model) circuit breaker (Phase 5 reality-check fix p5-rc-2).
// The breaker is now keyed `cb:openrouter:{model}:state` so a 32B outage
// blackholes ONLY the 32B model — the 72B and 8B fallbacks stay reachable.
// runTier1AI does ONE pre-check (checkAllModelsBreaker) to short-circuit the
// whole tier when EVERY model's breaker is open; the per-model shouldAttempt
// gate + recordSuccess/recordFailure live INSIDE callOpenRouterExtraction
// (tiers.ts), so the model-fallback loop can skip a tripped model and try
// the next one instead of failing the whole tier.
import { checkAllModelsBreaker, CIRCUIT_PROVIDER } from './circuit-breaker';
import { logWarn, type LoggerEnv } from '@clearport/shared/logger';

// ---------------------------------------------------------------------------
// PipelineInput — what the consumer passes to the pipeline after claiming
// the job and downloading the file.
// ---------------------------------------------------------------------------
export interface PipelineInput {
  jobId: string;
  documentId: string;
  shipmentId: string;
  orgId: string;
  userId: string;
  fileBytes: Uint8Array;
  fileName: string;
  mimeType: string;
}

export interface PipelineField {
  field_key: string;
  field_label: string;
  extracted_value: string;
  confidence: number; // 0-100
  extraction_source: string; // 'ai' | 'pdf_text_layer' | 'cloud_vision' | 'tesseract' | 'manual'
  source?: string;
  source_verified?: boolean;
  category?: string;
}

export interface PipelineException {
  field_key: string;
  reason: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  exception_type?: 'low_confidence' | 'source_not_verified' | 'model_disagreement' | 'math_error' | 'cross_doc_mismatch' | 'missing_field' | 'schema_error';
}

export interface PipelineResult {
  fields: PipelineField[];
  overall_confidence: number; // 0-100
  decision: 'APPROVED' | 'HOLD' | 'BLOCK' | 'REJECT' | 'needs_manual_review';
  exceptions: PipelineException[];
  pipeline_trace_id: string;
  document_type?: DocType;
  raw_text?: string;
}

export interface ClaimedJob {
  id: string;
  org_id: string;
  user_id: string;
  shipment_id: string;
  document_id: string | null;
  idempotency_key: string;
  status: string;
  attempts: number;
  max_attempts: number;
  result: unknown;
  claimed_at: string | null;
  created_at: string;
  claim_token: string; // fencing token (005_fencing_token.sql)
}

// ---------------------------------------------------------------------------
// TierAttemptResult — what each tier returns. `rawText` is the text the tier
// produced (for downstream regex + verbatim-anchor). `fields` is the mapped
// canonical fields (empty if the tier failed).
// ---------------------------------------------------------------------------
interface TierAttemptResult {
  tierName: string;
  success: boolean;
  fields: CanonicalField[];
  rawText: string | null;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
  documentType?: DocType;
}

// ===========================================================================
// runExtractionPipeline — the main entry point. Runs the 5-tier cascade,
// then applies deterministic validation, verbatim-anchor, and the
// minimum-viable rule. Records every tier to the job_attempts ledger.
// ===========================================================================
export async function runExtractionPipeline(
  env: Env,
  input: PipelineInput,
  claimedJob: ClaimedJob,
): Promise<PipelineResult> {
  const pipelineTraceId = crypto.randomUUID();
  const start = Date.now();

  let extractedFields: CanonicalField[] = [];
  let rawText: string | null = null;
  let documentType: DocType = 'unknown';
  let winningTier = '';

  // =======================================================================
  // TIER 1: AI vision extraction via OpenRouter (Qwen VL models)
  // =======================================================================
  // Cross-tier deadline (Phase 5 Point 3): the total budget for ALL tiers +
  // all retries + all backoff sleeps. withRetry checks this before each
  // retry sleep; if exceeded, the tier fails fast and the pipeline falls
  // through to the next tier (or needs_manual_review). Prevents the worst
  // case of 60s+ p95 latency from stacked retry backoffs.
  const pipelineDeadlineMs = start + PIPELINE_DEADLINE_MS;
  const tier1 = await runTier1AI(env, input, pipelineDeadlineMs);
  await recordTierAttempt(env, claimedJob, 1, tier1, pipelineTraceId);
  if (tier1.success && tier1.fields.length > 0) {
    extractedFields = tier1.fields;
    rawText = tier1.rawText;
    documentType = tier1.documentType || 'unknown';
    winningTier = tier1.tierName;
  }

  // =======================================================================
  // TIER 2: PDF text-layer extraction (if Tier 1 failed and it's a PDF)
  // =======================================================================
  if (extractedFields.length === 0 && input.mimeType === 'application/pdf') {
    const tier2 = await runTier2PdfText(input);
    await recordTierAttempt(env, claimedJob, 2, tier2, pipelineTraceId);
    if (tier2.success && tier2.rawText) {
      rawText = tier2.rawText;
      // Tier 2 produces TEXT, not fields — run regex on it to get fields.
      // (Imported from tiers.ts to keep this file focused on orchestration.)
      const { regexExtract } = await import('./regex-fallback');
      const regexFields = regexExtract(tier2.rawText);
      if (regexFields.length > 0) {
        extractedFields = mapToCanonicalSchema(regexFields as unknown as Record<string, unknown>[]);
        winningTier = tier2.tierName;
      }
    }
  } else {
    await recordTierAttempt(env, claimedJob, 2, {
      tierName: 'pdf_text_layer', success: false, fields: [], rawText: null,
      latencyMs: 0, errorMessage: extractedFields.length > 0 ? 'Not needed — Tier 1 succeeded' : 'Not a PDF',
    }, pipelineTraceId);
  }

  // =======================================================================
  // TIER 3: Cloud Vision OCR (optional — gated behind API key)
  // =======================================================================
  if (extractedFields.length === 0 && !rawText && input.mimeType !== 'application/pdf') {
    const tier3 = await runTier3CloudVision(env, input);
    await recordTierAttempt(env, claimedJob, 3, tier3, pipelineTraceId);
    if (tier3.success && tier3.rawText) {
      rawText = tier3.rawText;
      const { regexExtract } = await import('./regex-fallback');
      const regexFields = regexExtract(tier3.rawText);
      if (regexFields.length > 0) {
        extractedFields = mapToCanonicalSchema(regexFields as unknown as Record<string, unknown>[]);
        winningTier = tier3.tierName;
      }
    }
  } else {
    await recordTierAttempt(env, claimedJob, 3, {
      tierName: 'cloud_vision', success: false, fields: [], rawText: null,
      latencyMs: 0,
      errorMessage: extractedFields.length > 0 ? 'Not needed' : rawText ? 'Text already available' : 'PDF not supported by Cloud Vision',
    }, pipelineTraceId);
  }

  // =======================================================================
  // TIER 4: Tesseract OCR (self-hosted)
  // =======================================================================
  if (extractedFields.length === 0 && !rawText) {
    const tier4 = await runTier4Tesseract(env, input);
    await recordTierAttempt(env, claimedJob, 4, tier4, pipelineTraceId);
    if (tier4.success && tier4.rawText) {
      rawText = tier4.rawText;
      const { regexExtract } = await import('./regex-fallback');
      const regexFields = regexExtract(tier4.rawText);
      if (regexFields.length > 0) {
        extractedFields = mapToCanonicalSchema(regexFields as unknown as Record<string, unknown>[]);
        winningTier = tier4.tierName;
      }
    }
  } else {
    await recordTierAttempt(env, claimedJob, 4, {
      tierName: 'tesseract', success: false, fields: [], rawText: null,
      latencyMs: 0, errorMessage: extractedFields.length > 0 ? 'Not needed' : 'Text already available',
    }, pipelineTraceId);
  }

  // =======================================================================
  // TIER 5: needs_manual_review (never silent zero)
  // =======================================================================
  if (extractedFields.length === 0) {
    await recordTierAttempt(env, claimedJob, 5, {
      tierName: 'manual_review', success: false, fields: [], rawText: null,
      latencyMs: 0, errorMessage: 'All tiers exhausted — routed to manual review',
    }, pipelineTraceId);

    // Return needs_manual_review — the system NEVER silently reports zero.
    return {
      fields: [],
      overall_confidence: 0,
      decision: 'needs_manual_review',
      exceptions: [{
        field_key: '_document',
        reason: 'All extraction tiers failed — manual review required',
        severity: 'CRITICAL',
        exception_type: 'missing_field',
      }],
      pipeline_trace_id: pipelineTraceId,
      document_type: 'unknown',
      raw_text: rawText || undefined,
    };
  }

  // =======================================================================
  // POST-EXTRACTION VALIDATION (the deterministic ground truth)
  // =======================================================================

  // --- Step 4: Deterministic validators (math, format, cross-doc) -------
  // NEVER let the LLM compute totals, sums, or date comparisons.
  const deterministicExceptions = runDeterministicValidation(extractedFields);

  // --- Step 3: Verbatim-anchor check (the anti-hallucination anchor) ----
  // For every field with a `source` snippet, fuzzy-match it against the raw
  // text. If no match, force confidence down + flag source_not_verified.
  const anchorResult: VerbatimAnchorResult = rawText
    ? runVerbatimAnchorCheck(extractedFields, rawText)
    : { verified: [], unverified: [], exceptions: [] };

  // Apply the anchor's effective confidence adjustments to the fields.
  const fieldsWithAnchor: PipelineField[] = extractedFields.map((f) => {
    const unverified = anchorResult.unverified.find((u) => u.field_key === f.field_key);
    const verified = anchorResult.verified.includes(f.field_key);
    return {
      field_key: f.field_key,
      field_label: f.field_label,
      extracted_value: f.value,
      confidence: unverified ? unverified.effective_confidence : f.confidence,
      extraction_source: winningTier || 'unknown',
      source: f.source,
      source_verified: verified || (unverified ? false : undefined),
      category: f.category,
    };
  });

  // --- Combine all exceptions -------------------------------------------
  const allExceptions: PipelineException[] = [
    ...deterministicExceptions.map((e: ValidationException) => ({
      field_key: e.field_key,
      reason: e.reason,
      severity: e.severity,
      exception_type: e.exception_type,
    })),
    ...anchorResult.exceptions.map((e) => ({
      field_key: e.field_key,
      reason: e.reason,
      severity: e.severity,
      exception_type: 'source_not_verified' as const,
    })),
  ];

  // --- Low-confidence exceptions (fields below their category threshold) ---
  for (const f of fieldsWithAnchor) {
    const threshold = thresholdFor(f.field_key);
    if (f.confidence < threshold) {
      allExceptions.push({
        field_key: f.field_key,
        reason: `Confidence ${f.confidence}% below threshold ${threshold}%${f.source_verified === false ? ' (source not verified)' : ''}`,
        severity: f.confidence < 50 ? 'CRITICAL' : 'MAJOR',
        exception_type: f.source_verified === false ? 'source_not_verified' : 'low_confidence',
      });
    }
  }

  // --- Step 5: Minimum viable extraction rule ---------------------------
  // If >30% of expected fields for the detected doc type are missing or
  // unverified, decision = needs_manual_review regardless of field confidences.
  const requiredFields = REQUIRED_FIELDS_BY_DOC_TYPE[documentType] || [];
  const presentKeys = new Set(fieldsWithAnchor.map((f) => f.field_key));
  const missingCount = requiredFields.filter((k) => !presentKeys.has(k)).length;
  const missingRatio = requiredFields.length > 0 ? missingCount / requiredFields.length : 0;
  const needsManualReview = missingRatio > MINIMUM_VIABLE_EXTRACTION_THRESHOLD;

  // --- Compute overall confidence + decision ----------------------------
  const overallConfidence = fieldsWithAnchor.length > 0
    ? Math.round(fieldsWithAnchor.reduce((sum, f) => sum + f.confidence, 0) / fieldsWithAnchor.length)
    : 0;

  let decision: PipelineResult['decision'];
  if (needsManualReview) {
    decision = 'needs_manual_review';
  } else if (allExceptions.some((e) => e.severity === 'CRITICAL')) {
    decision = 'BLOCK';
  } else if (allExceptions.some((e) => e.severity === 'MAJOR')) {
    decision = 'HOLD';
  } else if (overallConfidence >= 85) {
    decision = 'APPROVED';
  } else {
    decision = 'HOLD';
  }

  const totalLatency = Date.now() - start;
  console.log(
    `[pipeline] job=${input.jobId} tier=${winningTier} fields=${fieldsWithAnchor.length} ` +
    `conf=${overallConfidence} decision=${decision} missing=${missingRatio.toFixed(2)} ` +
    `exceptions=${allExceptions.length} latency=${totalLatency}ms`,
  );

  return {
    fields: fieldsWithAnchor,
    overall_confidence: overallConfidence,
    decision,
    exceptions: allExceptions,
    pipeline_trace_id: pipelineTraceId,
    document_type: documentType,
    raw_text: rawText || undefined,
  };
}

// ===========================================================================
// Tier implementations — each returns a TierAttemptResult, never throws.
// ===========================================================================

async function runTier1AI(env: Env, input: PipelineInput, pipelineDeadlineMs: number): Promise<TierAttemptResult> {
  const start = Date.now();

  // --- Per-(provider+model) circuit breaker pre-check (Phase 5 reality-check fix) ---
  // Before calling OpenRouter, check whether EVERY model's breaker is open.
  // If at least one model is CLOSED or HALF_OPEN, we proceed to
  // callOpenRouterExtraction — its model-fallback loop will call
  // shouldAttempt PER MODEL and skip the open ones, trying only the
  // available ones. recordSuccess / recordFailure are also called per model
  // INSIDE callOpenRouterExtraction, so each model's breaker is tracked
  // independently.
  //
  // If ALL models are breaker-open, we short-circuit the whole tier with
  // errorCode 'all_models_circuit_open' — no fetch attempt, no withRetry
  // wrap. The 18s tier-1 latency budget is preserved for the next tier
  // (PDF text / Cloud Vision / Tesseract). The recordTierAttempt call in
  // runExtractionPipeline still fires for this tier, so the audit ledger
  // captures the skip — operators can see in the ledger that tier 1 was
  // deliberately skipped, not that it failed silently.
  //
  // The pre-check is a SNAPSHOT — between this and callOpenRouterExtraction,
  // a model's breaker could trip (rare). If that happens, the per-model
  // shouldAttempt gate inside callOpenRouterExtraction still does the right
  // thing (skip the now-tripped model). The pre-check is an optimization to
  // avoid 3 wasted KV reads + log noise when every model is already known
  // to be open.
  const models = [...OPENROUTER_MODELS];
  const { anyAvailable, openModels } = await checkAllModelsBreaker(env, CIRCUIT_PROVIDER, models);
  if (!anyAvailable) {
    const loggerEnv = env as unknown as LoggerEnv;
    logWarn(loggerEnv, 'circuit breaker open — skipping tier 1 (all models tripped)',
      { job_id: input.jobId, org_id: input.orgId, step: 'circuit_breaker' },
      { provider: 'openrouter', open_models: openModels, reason: 'all_models_circuit_open' });
    return {
      tierName: 'ai_openrouter',
      success: false,
      fields: [],
      rawText: null,
      latencyMs: Date.now() - start,
      errorCode: 'all_models_circuit_open',
      errorMessage: `All OpenRouter models have circuit breakers open — skipping tier 1 (models: ${openModels.join(', ')})`,
    };
  }

  // At least one model is available — proceed with the tier-1 call.
  // callOpenRouterExtraction's model-fallback loop will skip any models
  // whose breakers tripped between the pre-check and the call.

  try {
    // --- Phase 5 Step 3: retry with error classification --------------
    // Wrap callOpenRouterExtraction in withRetry so a 429/5xx/timeout is
    // retried with exponential backoff (2s, 4s, cap 30s, max 3 attempts)
    // while a 400/401/404/schema_validation throws immediately — no retry
    // budget wasted on errors that will NEVER succeed. The classification
    // (retryable vs non_retryable + the reason slug) is in the thrown error
    // message, which propagates to TierAttemptResult.errorMessage below and
    // thus to job_attempts.error_message in the audit ledger.
    //
    // NOTE: recordSuccess / recordFailure are called PER MODEL inside
    // callOpenRouterExtraction (tiers.ts), not here. The winning model gets
    // recordSuccess; each failing model gets recordFailure. withRetry's
    // retries multiply the per-model recordFailure calls (3 attempts × 3
    // models = 9 recordFailure calls in the worst case), which is correct
    // — each model has genuinely failed N times, and the per-model breaker
    // should reflect that. The runTier1AI-level catch below does NOT call
    // recordFailure (the per-model recording already happened).
    const result = await withRetry(
      env,
      'tier_1_ai',
      { job_id: input.jobId, org_id: input.orgId },
      async () => callOpenRouterExtraction(env, input, MAX_TIER_LATENCY_MS),
      // Pass the cross-tier deadline (Phase 5 Point 3) so withRetry aborts
      // a retry sleep that would push past the pipeline budget, rather than
      // stacking backoffs across tiers + blowing the claim_job TTL.
      { deadlineMs: pipelineDeadlineMs },
    );
    if (!result) {
      // Provider not configured (no API key) OR all models' breakers were
      // open at callOpenRouterExtraction time (race with the pre-check
      // above). No model was attempted, so no recordFailure to call —
      // either there's nothing to record (not configured) or the breaker
      // is already tripped (recording more failures wouldn't change state).
      return {
        tierName: 'ai_openrouter', success: false, fields: [], rawText: null,
        latencyMs: Date.now() - start,
        errorMessage: 'OpenRouter not configured or all available models were breaker-open at call time',
      };
    }

    // The winning model's recordSuccess was already called inside
    // callOpenRouterExtraction (BEFORE this return). We do NOT call
    // recordSuccess here — the per-model recording is the source of truth.

    // --- Step 1: Parse the LLM response through the Zod schema ----------
    // On validation failure, treat as a tier FAILURE (not silent coercion).
    // Log the Zod error detail to the ledger so reviewers can see why.
    // (The breaker already recorded success for this model — Zod failure is
    // a quality issue, not an outage signal, so it doesn't trip the breaker.)
    const parsed = llmResponseSchema.safeParse(result.response);
    if (!parsed.success) {
      const errorDetail = JSON.stringify(parsed.error.issues).slice(0, 2000);
      return {
        tierName: 'ai_openrouter', success: false, fields: [], rawText: null,
        latencyMs: Date.now() - start,
        errorCode: 'schema_validation_failed',
        errorMessage: `LLM response failed Zod validation: ${errorDetail}`,
        documentType: 'unknown',
      };
    }

    // --- Map to canonical schema (Step 1 reconciliation) ----------------
    const canonicalFields = mapToCanonicalSchema(
      parsed.data.fields.map((f) => ({
        field_key: f.field_key,
        field_label: f.field_label,
        value: f.value,
        confidence: f.confidence,
        source: f.source,
        source_location: f.source_location,
        line_items_array: f.line_items_array,
      })),
    );

    // Classify document type from the LLM's response.
    const docType = classifyDocType(parsed.data.document_type);

    return {
      tierName: 'ai_openrouter',
      success: canonicalFields.length > 0,
      fields: canonicalFields,
      rawText: result.rawText || null,
      latencyMs: Date.now() - start,
      documentType: docType,
    };
  } catch (err) {
    // withRetry threw — either non-retryable (4xx non-429, schema_validation)
    // or retryable exhausted (429/5xx/network after maxAttempts). The error
    // message includes the classification (e.g. "tier_1_ai failed
    // (non_retryable: client_error, status=400) — not retrying") so the
    // reviewer can see WHY the tier wasn't retried (or why retries were
    // exhausted).
    //
    // NOTE: we do NOT call recordFailure here. Each model that failed
    // during callOpenRouterExtraction's loop already had recordFailure
    // called for it (per-model granularity). Calling recordFailure again
    // here would double-count: withRetry's 3 attempts × 3 models = up to
    // 9 per-model recordFailure calls already happened; one more at this
    // level (with no model context) would either land in the 'default'
    // bucket (a phantom 4th model that doesn't exist) or require picking
    // an arbitrary model to blame. Both are wrong. The per-model recording
    // inside callOpenRouterExtraction is the source of truth.
    return {
      tierName: 'ai_openrouter', success: false, fields: [], rawText: null,
      latencyMs: Date.now() - start,
      errorCode: 'exception',
      errorMessage: err instanceof Error ? err.message.slice(0, 2000) : String(err),
    };
  }
}

async function runTier2PdfText(input: PipelineInput): Promise<TierAttemptResult> {
  const start = Date.now();
  try {
    const text = extractPdfTextLayer(input.fileBytes);
    return {
      tierName: 'pdf_text_layer',
      success: !!text,
      fields: [],
      rawText: text,
      latencyMs: Date.now() - start,
      errorMessage: text ? undefined : 'No embedded text layer in PDF',
    };
  } catch (err) {
    return {
      tierName: 'pdf_text_layer', success: false, fields: [], rawText: null,
      latencyMs: Date.now() - start,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runTier3CloudVision(env: Env, input: PipelineInput): Promise<TierAttemptResult> {
  const start = Date.now();
  try {
    const result = await callCloudVisionOCR(env, input.fileBytes, input.mimeType);
    return {
      tierName: 'cloud_vision',
      success: !!result.text,
      fields: [],
      rawText: result.text,
      latencyMs: Date.now() - start,
      errorCode: result.errorCode,
      errorMessage: result.text ? undefined : result.reason,
    };
  } catch (err) {
    return {
      tierName: 'cloud_vision', success: false, fields: [], rawText: null,
      latencyMs: Date.now() - start,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runTier4Tesseract(env: Env, input: PipelineInput): Promise<TierAttemptResult> {
  const start = Date.now();
  try {
    const result = await callTesseractOCR(env, input.fileBytes, input.mimeType);
    return {
      tierName: 'tesseract',
      success: !!result.text,
      fields: [],
      rawText: result.text,
      latencyMs: Date.now() - start,
      errorCode: result.errorCode,
      errorMessage: result.text ? undefined : result.reason,
    };
  } catch (err) {
    return {
      tierName: 'tesseract', success: false, fields: [], rawText: null,
      latencyMs: Date.now() - start,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

// ===========================================================================
// recordTierAttempt — writes one job_attempts row per tier (the audit ledger).
// Uses the fencing token (005_fencing_token.sql) so a stale consumer's ledger
// writes are rejected if the cron reclaimed the job.
// ===========================================================================
async function recordTierAttempt(
  env: Env,
  claimedJob: ClaimedJob,
  tierNumber: number,
  result: TierAttemptResult,
  pipelineTraceId: string,
): Promise<void> {
  try {
    await supabaseRpc(env, 'record_job_attempt', {
      p_job_id: claimedJob.id,
      p_claim_token: claimedJob.claim_token,
      p_org_id: claimedJob.org_id,
      p_attempt_number: claimedJob.attempts,
      p_tier: `${tierNumber}_${result.tierName}`,
      p_status: result.success ? 'success' : 'failure',
      p_fields_extracted: result.fields.length,
      p_latency_ms: result.latencyMs,
      p_error_message: result.errorMessage || null,
      p_result: {
        tier: tierNumber,
        tier_name: result.tierName,
        pipeline_trace_id: pipelineTraceId,
        error_code: result.errorCode || null,
        document_type: result.documentType || null,
      },
    });
  } catch (err) {
    // The ledger write itself failed (DB down, or fencing rejection because
    // the cron reclaimed the job). Log loudly but don't crash the pipeline —
    // the extraction still proceeds, and complete_job's fencing will catch
    // a stale claim at the end.
    console.error(
      `[pipeline] failed to record tier ${tierNumber} attempt to ledger:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ===========================================================================
// classifyDocType — map the LLM's document_type string to our DocType enum.
// ===========================================================================
function classifyDocType(llmType?: string): DocType {
  if (!llmType) return 'unknown';
  const t = llmType.toLowerCase().replace(/[\s-]/g, '_');
  if (t.includes('invoice')) return 'commercial_invoice';
  if (t.includes('bill_of_lading') || t.includes('bol')) return 'bill_of_lading';
  if (t.includes('packing')) return 'packing_list';
  if (t.includes('certificate') || t.includes('origin')) return 'certificate_of_origin';
  return 'unknown';
}

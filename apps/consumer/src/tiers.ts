// ============================================================================
// tiers.ts — The 4 extraction tier implementations (Tier 5 is manual review)
// ============================================================================
// Each function returns a result object, NEVER throws. The pipeline-hook
// orchestrator catches failures and falls through to the next tier.
//
// Workers-compatible: uses fetch() (Web API), no Node SDKs. The OpenRouter
// call uses a raw fetch rather than the `openai` npm package to avoid Node
// polyfill issues in the Workers runtime.
// ============================================================================

import type { Env } from './env';
import { OPENROUTER_MODELS } from '@clearport/shared/pipeline-config';
import { classifyError } from './error-classifier';
// Per-(provider+model) circuit breaker (Phase 5 reality-check fix p5-rc-2).
// shouldAttempt gates EACH model independently — a 32B breaker tripped by a
// 32B-specific outage doesn't block the 72B / 8B fallbacks. recordSuccess /
// recordFailure are called per model so each breaker tracks its own model's
// health, not the aggregate provider's. CIRCUIT_PROVIDER ('openrouter') is
// the provider half of the KV key (`cb:openrouter:{model}:state`).
import {
  shouldAttempt,
  recordSuccess,
  recordFailure,
  CIRCUIT_PROVIDER,
} from './circuit-breaker';
import { logInfo, type LoggerEnv } from '@clearport/shared/logger';

// ---------------------------------------------------------------------------
// Tier 1: AI vision extraction via OpenRouter (Qwen VL models)
// ---------------------------------------------------------------------------
export interface OpenRouterResult {
  response: unknown;       // the parsed JSON the LLM returned
  rawText?: string;        // if the LLM was given text (PDF text layer), echo it
  model: string;
}

export async function callOpenRouterExtraction(
  env: Env,
  input: { fileBytes: Uint8Array; fileName: string; mimeType: string },
  deadlineMs: number,
): Promise<OpenRouterResult | null> {
  const apiKey = (env as unknown as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
  if (!apiKey || apiKey.length < 10) {
    return null; // not configured — tier fails silently, falls through
  }

  // Build the prompt. For images (PNG/JPEG/TIFF), send as a vision message
  // with base64 image content. For PDFs, extract the text layer first and
  // send as text (Qwen VL doesn't accept PDF binary directly).
  const isImage = input.mimeType.startsWith('image/');
  const isPdf = input.mimeType === 'application/pdf';

  let textContent = '';
  if (isPdf) {
    const pdfText = extractPdfTextLayer(input.fileBytes);
    if (pdfText) textContent = pdfText;
  }

  const prompt = buildExtractionPrompt();

  const deadline = Date.now() + deadlineMs;
  // lastError is the most recent RETRYABLE error from a model attempt. If all
  // models fail with retryable errors, we throw this so withRetry (at the
  // runTier1AI level) can retry the whole model-fallback sequence with
  // exponential backoff. Non-retryable errors (4xx non-429, schema_validation)
  // throw immediately — no point trying other models with the same bad request.
  let lastError: unknown = null;

  for (const model of OPENROUTER_MODELS) {
    if (Date.now() >= deadline) break;

    // --- Per-model circuit breaker gate (Phase 5 reality-check fix) -------
    // Check THIS model's breaker before calling it. If open (5+ consecutive
    // failures for THIS model in the cooldown window), skip to the next model
    // — the 32B being down shouldn't blackhole 72B / 8B. The pre-check in
    // runTier1AI (checkAllModelsBreaker) already short-circuits the whole
    // tier when EVERY model is open; reaching here means at least one model
    // was available at pre-check time, but a model may have tripped since.
    const { attempt, reason } = await shouldAttempt(env, CIRCUIT_PROVIDER, model);
    if (!attempt) {
      // Breaker open for this model — skip silently. The pre-check in
      // runTier1AI already logged the tier-skip case; per-model skips are
      // expected behavior during a partial outage and don't need a log line
      // (the model-fallback success/failure log downstream is sufficient).
      continue;
    }

    // HALF_OPEN trial for this model — log at INFO so operators can see the
    // breaker testing whether THIS specific model has recovered. (CLOSED is
    // the normal path — no log here to avoid noise.)
    if (reason === 'half_open_trial') {
      const loggerEnv = env as unknown as LoggerEnv;
      logInfo(loggerEnv, 'circuit breaker half-open — trial request for model',
        { step: 'circuit_breaker' },
        { provider: 'openrouter', model, reason: 'half_open_trial' });
    }

    try {
      const messages = isImage
        ? [
            { role: 'user', content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${bufToBase64(input.fileBytes)}` } },
            ]},
          ]
        : [
            { role: 'user', content: `${prompt}\n\n--- DOCUMENT TEXT ---\n${textContent || '(no text layer — extract from the image if attached)'}` },
          ];

      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://clearport.app',
          'X-Title': 'ClearPort Customs Compliance',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 4000,
          temperature: 0.0,
        }),
        signal: AbortSignal.timeout(deadlineMs),
      });

      if (!res.ok) {
        // Throw an error carrying the HTTP status. The catch below classifies
        // via classifyError: 4xx (non-429) is non_retryable → re-throw
        // immediately (no point trying other models with the same request);
        // 429/5xx is retryable → record + try the next model.
        const body = await res.text();
        throw Object.assign(
          new Error(`OpenRouter ${model} returned ${res.status}: ${body}`.slice(0, 500)),
          { status: res.status },
        );
      }

      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        // 200 OK but no content — recordFailure for THIS model (it's
        // degraded, not healthy) and try the next model. A different model
        // might produce content. If all models fail this way, lastError is
        // thrown at the end of the loop and withRetry classifies it as
        // non_retryable (schema_validation).
        await recordFailure(env, CIRCUIT_PROVIDER, model);
        lastError = new Error(
          `OpenRouter ${model} returned no content (schema_validation_failed)`,
        );
        continue;
      }

      const parsed = parseJSONResponse(content);
      if (!parsed) {
        // 200 OK but non-JSON content — recordFailure for THIS model and try
        // the next model (different model might return valid JSON).
        await recordFailure(env, CIRCUIT_PROVIDER, model);
        lastError = new Error(
          `OpenRouter ${model} returned non-JSON content (schema_validation_failed: invalid json)`,
        );
        continue;
      }

      // Success — recordSuccess for THIS model. This resets that model's
      // failure counter and, if it was HALF_OPEN, closes the breaker. We
      // record success BEFORE returning (i.e. before the Zod schema
      // validation in runTier1AI) because the breaker tracks PROVIDER
      // health (did OpenRouter respond with HTTP 200 + a parseable body?),
      // not extraction quality (did the LLM give a schema-valid answer?).
      // A Zod failure is a model-quality issue, not an outage signal.
      await recordSuccess(env, CIRCUIT_PROVIDER, model);
      return { response: parsed, rawText: textContent || undefined, model };
    } catch (err) {
      // Classify the error to decide whether to try the next model or
      // propagate immediately. This catches BOTH fetch-thrown errors
      // (network/timeout) AND the HTTP-status errors thrown above.
      const cls = classifyError(err);
      // Record failure for THIS model regardless of retryable/non-retryable
      // — the model failed to produce a usable response, and its breaker
      // should reflect that. For non-retryable, we re-throw after recording
      // (no point trying other models with the same bad request). For
      // retryable, we record + continue to the next model.
      await recordFailure(env, CIRCUIT_PROVIDER, model);
      if (cls.class === 'non_retryable') {
        // 4xx (non-429) or schema_validation — propagate immediately so
        // withRetry doesn't waste budget retrying the same bad request.
        throw err;
      }
      // Retryable (429, 5xx, network, timeout) — record + try the next model.
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }

  // All models failed with retryable errors (429/5xx/network/timeout). Throw
  // the last one so withRetry (at the runTier1AI level) can classify it and
  // retry the whole model-fallback sequence with exponential backoff.
  if (lastError) {
    throw lastError;
  }

  // No models were tried (deadline already expired on entry) — return null
  // so the tier falls through silently to the next tier.
  return null;
}

// ---------------------------------------------------------------------------
// Tier 2: PDF text-layer extraction
// Extracts embedded text from PDF files that have a real text layer (not
// scanned images). Looks for text in parentheses within BT...ET blocks.
// Ported from the edge function's extractPdfTextLayer.
// ---------------------------------------------------------------------------
export function extractPdfTextLayer(fileBytes: Uint8Array): string | null {
  try {
    // Check if it's actually a PDF
    const header = new TextDecoder().decode(fileBytes.slice(0, 5));
    if (header !== '%PDF-') return null;

    // Extract text from PDF content streams — text in parentheses within
    // BT...ET blocks. latin1 decode to preserve byte fidelity.
    const text = new TextDecoder('latin1').decode(fileBytes);
    const textMatches: string[] = [];
    const textRegex = /\(([^)]+)\)/g;
    let match;
    while ((match = textRegex.exec(text)) !== null) {
      const t = match[1];
      // Filter out non-text content (binary data, short strings)
      if (t.length > 2 && /[a-zA-Z]/.test(t) && !/\\[nrt]/.test(t)) {
        textMatches.push(t);
      }
    }

    if (textMatches.length < 3) return null; // not enough text to be useful
    const result = textMatches.join('\n');
    return result.length > 50 ? result : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier 3: Cloud Vision OCR (optional — gated behind GOOGLE_CLOUD_VISION_API_KEY)
// Handles IMAGE mime types only; PDFs are skipped (use async batch for PDFs).
// ---------------------------------------------------------------------------
export interface CloudVisionResult {
  text: string | null;
  errorCode?: string;
  reason?: string;
}

export async function callCloudVisionOCR(
  env: Env,
  fileBytes: Uint8Array,
  mimeType: string,
): Promise<CloudVisionResult> {
  const apiKey = (env as unknown as { GOOGLE_CLOUD_VISION_API_KEY?: string }).GOOGLE_CLOUD_VISION_API_KEY;
  if (!apiKey) {
    return {
      text: null,
      errorCode: 'NOT_CONFIGURED',
      reason: 'Cloud Vision API key not set — falls through to Tesseract',
    };
  }
  if (mimeType === 'application/pdf') {
    return {
      text: null,
      errorCode: 'SKIPPED_PDF',
      reason: 'Cloud Vision images:annotate does not support PDFs — falls through to Tesseract',
    };
  }

  try {
    const base64 = bufToBase64(fileBytes);
    const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
        }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { text: null, errorCode: 'API_ERROR', reason: `Cloud Vision returned ${res.status}` };
    }

    const data = await res.json() as {
      responses?: Array<{
        fullTextAnnotation?: { text?: string };
        error?: { message?: string };
      }>;
    };
    const text = data.responses?.[0]?.fullTextAnnotation?.text;
    if (text) return { text };
    const errMsg = data.responses?.[0]?.error?.message || 'Cloud Vision returned no text';
    return { text: null, errorCode: 'NO_TEXT', reason: errMsg };
  } catch (err) {
    return {
      text: null,
      errorCode: 'FETCH_FAILED',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Tier 4: Tesseract OCR (self-hosted via the /api/internal/ocr route)
// Calls the Next.js app's OCR endpoint which runs tesseract.js. Returns null
// silently when not configured — Tier 5 (manual review) is the safety net.
// ---------------------------------------------------------------------------
export interface TesseractResult {
  text: string | null;
  errorCode?: string;
  reason?: string;
}

export async function callTesseractOCR(
  env: Env,
  fileBytes: Uint8Array,
  mimeType: string,
): Promise<TesseractResult> {
  const ocrUrl = (env as unknown as { OCR_SERVICE_URL?: string }).OCR_SERVICE_URL;
  const ocrSecret = (env as unknown as { INTERNAL_OCR_SECRET?: string }).INTERNAL_OCR_SECRET;
  if (!ocrUrl || !ocrSecret) {
    return {
      text: null,
      errorCode: 'NOT_CONFIGURED',
      reason: 'OCR service not configured (OCR_SERVICE_URL or INTERNAL_OCR_SECRET missing) — falls through to manual review',
    };
  }

  try {
    const res = await fetch(ocrUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OCR-Secret': ocrSecret,
      },
      body: JSON.stringify({
        file: bufToBase64(fileBytes),
        mimeType,
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      return { text: null, errorCode: 'HTTP_ERROR', reason: `OCR route returned ${res.status}` };
    }

    const data = await res.json() as { text?: string; error?: string };
    if (data.text) return { text: data.text };
    return { text: null, errorCode: 'NO_TEXT', reason: data.error || 'Tesseract returned no text' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('timed out') || msg.includes('abort')) {
      return { text: null, errorCode: 'TIMEOUT', reason: 'OCR service timed out (tesseract.js exceeded 25s)' };
    }
    return { text: null, errorCode: 'FETCH_FAILED', reason: msg };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// bufToBase64 — Web-standard base64 encoding of a Uint8Array.
// Workers don't have `Buffer.from(arr).toString('base64')`, so use the
// manual byte-to-base64 conversion.
export function bufToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// parseJSONResponse — handles markdown fences, thinking prefixes, embedded
// JSON objects. Returns null if no valid JSON can be extracted.
function parseJSONResponse(output: string): unknown | null {
  if (!output) return null;
  let cleaned = output.trim();

  // Strip markdown code fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Find the outermost JSON object
  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    cleaned = cleaned.slice(objStart, objEnd + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // Second try: sometimes the LLM wraps JSON in prose. Try to find any
    // {...} block and parse it.
    const anyMatch = cleaned.match(/\{[\s\S]*\}/);
    if (anyMatch) {
      try {
        return JSON.parse(anyMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// buildExtractionPrompt — the extraction instruction sent to the LLM.
// Matches the live ai-extract.ts prompt (single-pass: classify + extract +
// validate), with the anti-hallucination emphasis.
function buildExtractionPrompt(): string {
  return `You are ClearPort's Document Extraction Engine. Extract structured data from customs/logistics documents.

ANTI-HALLUCINATION (CRITICAL): Only extract values actually printed in the document. Never infer. For every field, include a "source" field with the EXACT verbatim text snippet from the document that the value was extracted from. If you cannot find a verbatim source, set confidence to 0.

NORMALIZATION: Dates ISO-8601 (YYYY-MM-DD). Currency "amount CODE" (e.g. "12500.00 USD"). Addresses comma-delimited. Line items as structured array.

CLASSIFY: commercial_invoice, bill_of_lading, packing_list, certificate_of_origin, unknown

Extract ALL fields present: shipper_name, shipper_address, consignee_name, consignee_address, notify_party, bl_number, carrier_ref, container_number, container_numbers, seal_number, seal_numbers, vessel_name, voyage_number, port_of_loading, port_of_discharge, port_of_entry, goods_description, hs_codes, quantity, net_weight, gross_weight, weight_unit, incoterms, freight_terms, invoice_number, invoice_date, due_date, payment_date, shipment_date, shipped_on_board_date, delivery_date, currency, unit_price, total_value, subtotal, discount, tax, country_of_origin, carrier, line_items, payment_status.

Validate internally: sum(line_items)=subtotal, subtotal+tax-discount=total_value, delivery_date >= shipment_date, net_weight <= gross_weight.

CONFIDENCE RUBRIC: 0.90-1.0 = clear, unambiguous, directly stated. 0.70-0.89 = readable, minor ambiguity. 0.50-0.69 = inferred from context. 0.00-0.49 = best guess from limited info.

OUTPUT (strict JSON only, no markdown, no prose):
{
  "document_type": "commercial_invoice | bill_of_lading | packing_list | certificate_of_origin | unknown",
  "classification_confidence": 0.0,
  "fields": [
    { "field_key": "shipper_name", "field_label": "Shipper/Exporter", "value": "string or null", "confidence": 0.0-1.0, "source": "EXACT verbatim snippet from the document" }
  ],
  "fields_expected_but_absent": ["fields that could not be found"],
  "exceptions": [
    { "field_key": "...", "reason": "...", "severity": "CRITICAL|MAJOR|MINOR" }
  ],
  "overall_status": "...",
  "current_confidence": 0.0
}`;
}

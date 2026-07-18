// ============================================================================
// Edge Function: extract-document
// Purpose: First-pass Gemini extraction — OCR + structured customs field
//          extraction from one or all documents in a shipment.
// Input: JSON `{ shipmentId, documentId? }`
// Output: Extracted fields written to `document_fields`, shipper/consignee
//         propagated up to the shipment row.
// ============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { GoogleGenAI } from "npm:@google/genai@2";
import { regexExtract } from "./lib/regex-extract.ts";
import { getGeminiClient, bufToBase64, callGeminiExtraction } from "./lib/gemini.ts";

// --- CORS -------------------------------------------------------------------
const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") || "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonRes(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// --- Client helpers ---------------------------------------------------------
function createUserClient(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
}

function createAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );
}

async function getUser(client: any) {
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user) return null;
  return user;
}

// --- Field schema (must match shared clearport-types) ----------------------
const FIELD_DEFINITIONS: Array<{
  key: string;
  label: string;
}> = [
  { key: "invoiceNo", label: "Commercial Invoice #" },
  { key: "invoiceDate", label: "Invoice Date" },
  { key: "shipper", label: "Shipper/Exporter" },
  { key: "consignee", label: "Consignee/Importer" },
  { key: "consigneeAddress", label: "Consignee Address" },
  { key: "declaredValue", label: "Total Declared Value" },
  { key: "htsCode", label: "HTS Code" },
  { key: "netWeight", label: "Net Weight" },
  { key: "grossWeight", label: "Gross Weight" },
  { key: "portOfEntry", label: "Port of Entry" },
  { key: "carrier", label: "Carrier" },
  { key: "billOfLading", label: "Bill of Lading #" },
  { key: "countryOfOrigin", label: "Country of Origin" },
];


// --- PDF text-layer extraction (Tier 2) ---------------------------------------
// Extracts embedded text from PDF files that have a real text layer
// (not scanned images). Uses a simple regex-based approach to find text
// between BT/ET markers in the PDF content stream.
function extractPdfTextLayer(arrayBuffer: ArrayBuffer): string | null {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    // Check if it's actually a PDF
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    if (header !== '%PDF-') return null;

    // Extract text from PDF content streams
    // Look for text in parentheses within BT...ET blocks
    const text = new TextDecoder('latin1').decode(bytes);
    const textMatches: string[] = [];

    // Match text in parentheses (PDF text objects)
    const textRegex = /\(([^)]+)\)/g;
    let match;
    while ((match = textRegex.exec(text)) !== null) {
      const t = match[1];
      // Filter out non-text content (binary data, short strings)
      if (t.length > 2 && /[a-zA-Z]/.test(t) && !/\\[nrt]/.test(t)) {
        textMatches.push(t);
      }
    }

    if (textMatches.length < 3) return null; // Not enough text to be useful

    // Join and clean up
    const result = textMatches.join('\n');
    return result.length > 50 ? result : null;
  } catch {
    return null;
  }
}

// --- Cloud Vision OCR (Tier 3) ----------------------------------------------
// Google Cloud Vision API — DOCUMENT_TEXT_DETECTION. Independent hosted OCR
// vendor with a generous free monthly quota. Called as a plain HTTPS POST to
// https://vision.googleapis.com/v1/images:annotate?key=<API_KEY> — no local
// compute, no SDK, no Deno-side rasterizer required.
//
// Limitation: Cloud Vision's images:annotate endpoint only accepts images
// (PNG/JPEG/TIFF/etc.). PDFs require async batch processing (files:annotate
// with a GCS URI), which is heavier-weight than we need at this tier. For
// PDFs, this function returns SKIPPED_PDF and the cascade falls through to
// Tier 4 (Tesseract via the Node route, which has pdftoppm to rasterize the
// PDF first).
//
// Gated behind GOOGLE_CLOUD_VISION_API_KEY — if missing, returns
// NOT_CONFIGURED and the cascade falls through to Tier 4 without crashing.
//
// 15s per-call timeout via AbortSignal.timeout — fits within the 18s
// wall-clock budget with margin for upstream tiers. Uses fetch() (available
// globally in Deno) rather than node:https.
//
// (P15-style) Structured result so the extraction_attempts ledger records the
// ACTUAL failure reason instead of a one-size-fits-all generic string.
// A reviewer can tell "key not configured" apart from "PDF not supported"
// apart from "API error" apart from "OCR ran but couldn't read the image."
interface CloudVisionResult {
  text: string | null;
  /** Machine-readable error code for the ledger (e.g. "NOT_CONFIGURED", "SKIPPED_PDF", "API_ERROR", "FETCH_FAILED") */
  errorCode?: string;
  /** Human-readable reason explaining why OCR didn't produce text */
  reason?: string;
}

async function callCloudVisionOCR(
  arrayBuffer: ArrayBuffer,
  mimeType: string,
): Promise<CloudVisionResult> {
  const apiKey = Deno.env.get("GOOGLE_CLOUD_VISION_API_KEY");
  if (!apiKey) {
    return {
      text: null,
      errorCode: "NOT_CONFIGURED",
      reason: "Cloud Vision API key not set (GOOGLE_CLOUD_VISION_API_KEY missing) — falls through to Tesseract",
    };
  }
  if (mimeType === "application/pdf") {
    return {
      text: null,
      errorCode: "SKIPPED_PDF",
      reason: "Cloud Vision images:annotate does not support PDFs directly (use async batch processing for PDFs) — falls through to Tesseract (Node route has pdftoppm)",
    };
  }
  try {
    const base64 = bufToBase64(arrayBuffer);
    const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
        }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      console.error(`[extract-document] Cloud Vision HTTP ${res.status}: ${errText}`);
      return {
        text: null,
        errorCode: `HTTP_${res.status}`,
        reason: `Cloud Vision returned HTTP ${res.status}: ${errText.substring(0, 200)}`,
      };
    }
    const body = await res.json();
    const firstResponse = body?.responses?.[0];
    if (firstResponse?.error) {
      const errMsg = firstResponse.error.message || JSON.stringify(firstResponse.error);
      return {
        text: null,
        errorCode: "API_ERROR",
        reason: `Cloud Vision API error: ${errMsg}`,
      };
    }
    const text: string | null = firstResponse?.fullTextAnnotation?.text ?? null;
    if (!text || text.trim().length === 0) {
      return {
        text: null,
        errorCode: "EMPTY_TEXT",
        reason: "Cloud Vision returned no text (blank or illegible image)",
      };
    }
    return { text: text.trim() };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (/timed out|timeout|abort/i.test(errMsg)) {
      return {
        text: null,
        errorCode: "FETCH_TIMEOUT",
        reason: `Cloud Vision call timed out: ${errMsg}`,
      };
    }
    return {
      text: null,
      errorCode: "FETCH_FAILED",
      reason: `Cloud Vision call failed: ${errMsg}`,
    };
    // never throw — Tier 4 Tesseract is the safety net
  }
}

// --- Tesseract OCR (Tier 4) ------------------------------------------------
// Self-hosted tesseract.js running in a separate Node.js API route
// (/api/internal/ocr) inside the Next.js app. The edge function (Deno) can't
// host tesseract.js directly, so it base64-encodes the file and ships it over
// HTTPS to the Node route, which runs OCR and returns the text.
//
// Config: set OCR_SERVICE_URL + INTERNAL_OCR_SECRET as Supabase secrets. If
// either is missing, this function returns null and the cascade falls through
// to Tier 5 (needs_manual_review) — it NEVER throws.
//
// The 25s timeout here is longer than the edge function's 18s wall-clock
// budget on purpose: the budget will kick in first if needed, which is the
// correct behaviour (budget is the global ceiling, the per-call timeout is
// the local safety net for misconfigured / hung services).
// (P15) Structured result so the extraction_attempts ledger records the
// ACTUAL failure reason instead of a one-size-fits-all generic string.
// A reviewer looking at the ledger should be able to tell "unsupported
// document type" apart from "OCR service was down" apart from "OCR ran
// but genuinely couldn't read this image."
interface TesseractResult {
  text: string | null;
  /** Machine-readable error code for the ledger (e.g. "415", "408", "FETCH_FAILED") */
  errorCode?: string;
  /** Human-readable reason explaining why OCR didn't produce text */
  reason?: string;
}

async function tesseractOCR(arrayBuffer: ArrayBuffer, mimeType: string): Promise<TesseractResult> {
  const ocrUrl = Deno.env.get("OCR_SERVICE_URL");
  const secret = Deno.env.get("INTERNAL_OCR_SECRET");
  if (!ocrUrl || !secret) {
    return {
      text: null,
      errorCode: "MISCONFIGURED",
      reason: "OCR service not configured (OCR_SERVICE_URL or INTERNAL_OCR_SECRET missing) — falls through to manual review",
    };
  }
  try {
    const res = await fetch(ocrUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": secret },
      body: JSON.stringify({ data: bufToBase64(arrayBuffer), mimeType }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      // Map HTTP status to a clear, distinct reason for the ledger
      let reason: string;
      let errorCode: string;
      if (res.status === 401) {
        errorCode = "401";
        reason = "OCR service rejected the shared secret — INTERNAL_OCR_SECRET mismatch between edge function and Next.js app";
      } else if (res.status === 415) {
        errorCode = "415";
        reason = `Unsupported document type for OCR (${mimeType}) — pdftoppm not installed or mime type not supported`;
      } else if (res.status === 408) {
        errorCode = "408";
        reason = "OCR service timed out (tesseract.js exceeded 25s internal limit)";
      } else if (res.status === 422) {
        errorCode = "422";
        const errBody = await res.json().catch(() => ({}));
        reason = `OCR preprocessing failed: ${errBody.detail || res.statusText}`;
      } else if (res.status >= 500) {
        errorCode = String(res.status);
        const errBody = await res.json().catch(() => ({}));
        reason = `OCR service error (${res.status}): ${errBody.detail || errBody.error || res.statusText}`;
      } else {
        errorCode = String(res.status);
        reason = `OCR service returned HTTP ${res.status}: ${res.statusText}`;
      }
      console.error(`[extract-document] OCR service returned ${res.status}: ${reason}`);
      return { text: null, errorCode, reason };
    }
    const body = await res.json();
    const text: string | null = body.text || null;
    if (!text) {
      return {
        text: null,
        errorCode: "EMPTY_TEXT",
        reason: "OCR ran successfully but recognized no text (blank or illegible image)",
      };
    }
    return { text };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Distinguish timeout (AbortSignal) from other fetch failures
    if (/timed out|timeout|abort/i.test(errMsg)) {
      return {
        text: null,
        errorCode: "FETCH_TIMEOUT",
        reason: `OCR service call timed out: ${errMsg}`,
      };
    }
    return {
      text: null,
      errorCode: "FETCH_FAILED",
      reason: `OCR service call failed: ${errMsg}`,
    };
    // never throw — Tier 5 manual-review is the safety net
  }
}

// --- Extraction Attempts Ledger (fire-and-forget) ---------------------------
// Best-effort audit-trail writer. NEVER throws, NEVER consumes wall-clock
// budget — called with `void recordAttempt(...)` so it runs in the background.
// The extraction_attempts table is RLS-locked to SELECT-only for authenticated
// users; only the service-role (admin) client can INSERT. A failure here (e.g.
// table not deployed, transient DB error) is logged to console.warn and
// swallowed so it can never abort the extraction pipeline.
async function recordAttempt(
  admin: any,
  params: {
    document_id: string;
    org_id: string;
    pipeline_trace_id: string;
    tier: number;
    tier_name: string;
    status: 'success' | 'failure' | 'skipped';
    fields_extracted?: number | null;
    error_code?: string | null;
    error_message?: string | null;
    latency_ms?: number | null;
  },
): Promise<void> {
  try {
    await admin.from('extraction_attempts').insert({
      document_id: params.document_id,
      org_id: params.org_id,
      pipeline_trace_id: params.pipeline_trace_id,
      tier: params.tier,
      tier_name: params.tier_name,
      status: params.status,
      fields_extracted: params.fields_extracted ?? null,
      error_code: params.error_code ?? null,
      error_message: params.error_message ?? null,
      latency_ms: params.latency_ms ?? null,
    });
  } catch (err) {
    console.warn(
      '[extract-document] ledger write failed (tier',
      params.tier,
      'status',
      params.status,
      '):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// --- Main handler with 5-tier extraction fallback chain ----------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Verify JWT
    const userClient = createUserClient(req);
    if (!userClient) return jsonRes({ error: "Missing Authorization header" }, 401);
    const user = await getUser(userClient);
    if (!user) return jsonRes({ error: "Unauthorized — invalid JWT" }, 401);

    // 1b. Rate limit check — 50 extractions per hour per org
    // Get the user's org from organization_members
    const { data: orgMember } = await userClient
      .from("organization_members")
      .select("org_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    if (orgMember?.org_id) {
      const { data: allowed, error: rlError } = await userClient.rpc("check_extraction_rate_limit", {
        p_org_id: orgMember.org_id,
        p_max_requests: 50,
      });
      if (rlError || allowed === false) {
        return jsonRes(
          { error: "Rate limit exceeded. Maximum 50 extractions per hour per organization. Please try again later." },
          429,
        );
      }
    }

    // 2. Parse JSON body
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return jsonRes({ error: "Invalid JSON body" }, 400);
    }
    const { shipmentId, documentId } = body;
    if (!shipmentId) {
      return jsonRes({ error: "Missing 'shipmentId'" }, 400);
    }

    // 3. Fetch documents for shipment (include org_id for ledger writes)
    let docQuery = userClient
      .from("documents")
      .select("id, shipment_id, doc_type, file_name, storage_path, mime_type, org_id")
      .eq("shipment_id", shipmentId);

    if (documentId) {
      docQuery = docQuery.eq("id", documentId);
    }

    const { data: docs, error: docsErr } = await docQuery.order("uploaded_at", {
      ascending: true,
    });

    if (docsErr) {
      console.error("[extract-document] docs query error:", docsErr);
      return jsonRes(
        { error: "Failed to fetch documents", detail: docsErr.message },
        500
      );
    }
    if (!docs || docs.length === 0) {
      return jsonRes(
        { error: "No documents found for this shipment" },
        404
      );
    }

    const admin = createAdminClient();
    const ai = getGeminiClient();

    if (!ai) {
      console.warn(
        "[extract-document] GEMINI_API_KEY not set — using mock extraction"
      );
    }

    // 3b. Resolve / mint the pipeline_trace_id for this invocation. The
    // validation chain may have already stamped one on the shipment — reuse
    // it so all ledger rows for this shipment share a single trace. If absent,
    // mint a fresh UUID and persist it (fire-and-forget) for downstream
    // consumers (cross-validate, flag-exceptions, etc.).
    let pipelineTraceId: string = crypto.randomUUID();
    try {
      const { data: shipmentRow } = await userClient
        .from("shipments")
        .select("id, pipeline_trace_id")
        .eq("id", shipmentId)
        .maybeSingle();
      if (shipmentRow?.pipeline_trace_id) {
        pipelineTraceId = shipmentRow.pipeline_trace_id;
      } else {
        // Persist the freshly-minted trace_id so the rest of the pipeline
        // (and the extraction-trace UI) can join on it. Fire-and-forget.
        void admin
          .from("shipments")
          .update({ pipeline_trace_id: pipelineTraceId })
          .eq("id", shipmentId)
          .then(({ error }: any) => {
            if (error) {
              console.warn('[extract-document] failed to persist pipeline_trace_id:', error.message);
            }
          });
      }
    } catch (err) {
      // Non-fatal — keep the freshly-minted UUID. Ledger writes will still
      // work, they just won't join to the shipment row's trace_id.
      console.warn('[extract-document] shipment trace_id lookup failed:', err instanceof Error ? err.message : String(err));
    }

    // ─── GLOBAL WALL-CLOCK BUDGET ───
    // 18 seconds total across ALL documents and ALL tiers. If we blow past it,
    // every remaining document is dropped straight to needs_manual_review with
    // a clear "extraction timeout" message — never a silent multi-minute retry.
    // The budget is shared across the whole shipment so a single huge PDF can't
    // starve the rest. Configurable via EXTRACTION_BUDGET_MS env (for tests).
    const BUDGET_MS = Number(Deno.env.get("EXTRACTION_BUDGET_MS") || 18000);
    const deadline = Date.now() + BUDGET_MS;
    let budgetExhausted = false;
    const budgetRemaining = () => deadline - Date.now();

    const allFields: any[] = [];
    const perDocResults: any[] = [];
    let latestShipper: string | null = null;
    let latestConsignee: string | null = null;
    let geminiDebug: any = null;
    // Track whether extraction failed completely for ANY document so we can
    // return a clear error response at the end (rather than silently succeeding
    // with zero fields).
    let totalExtractionFailures = 0;
    const failureDetails: any[] = [];

    // 4. Process each document through the 5-tier extraction fallback chain
    for (const doc of docs) {
      let extracted: any[] = [];
      let usedModel: string | null = null;
      let rawAiResponse: string | null = null;
      let extractionSource: string = "none";
      let extractionTier: number = 0;
      let docBudgetExhausted = false;

      // ── Global budget check before starting this document ──
      if (budgetRemaining() <= 500) {
        budgetExhausted = true;
        docBudgetExhausted = true;
        console.warn(`[extract-document] BUDGET EXHAUSTED before doc ${doc.file_name} (${budgetRemaining()}ms left) — routing to manual review`);
      }

      // Mark document as 'extracting'
      await admin.from("documents").update({
        processing_status: "extracting",
        processing_started_at: new Date().toISOString(),
      }).eq("id", doc.id);

      // 4a. Download the file from Storage
      const { data: fileData, error: downloadErr } = await admin.storage
        .from("documents")
        .download(doc.storage_path);

      if (downloadErr || !fileData) {
        console.error("[extract-document] file download failed for", doc.storage_path, downloadErr);
        await admin.from("documents").update({ processing_status: "failed" }).eq("id", doc.id);
        perDocResults.push({ documentId: doc.id, file_name: doc.file_name, status: "download_failed", fields: [] });
        continue;
      }

      const ab = await fileData.arrayBuffer();
      const base64 = bufToBase64(ab);
      const mimeType = doc.mime_type || "application/octet-stream";

      // Extract raw text for text-based files (used by regex fallback)
      let rawText: string | undefined;
      if (mimeType.startsWith("text/")) {
        try { rawText = new TextDecoder().decode(ab); } catch {}
      }

      // Resolve this document's org_id for ledger writes. Prefer the
      // document's org_id (set by the trg_documents_set_org trigger); fall
      // back to the caller's org membership. If neither is available (legacy
      // data), skip ledger writes for this doc — extraction still proceeds.
      const docOrgId: string | null = (doc as any).org_id || orgMember?.org_id || null;

      // ─── TIER 1: Gemini Vision (primary) ───
      if (!ai || docBudgetExhausted) {
        // Tier 1 skipped — Gemini not configured OR budget exhausted before
        // we even started this document.
        if (docOrgId) {
          void recordAttempt(admin, {
            document_id: doc.id,
            org_id: docOrgId,
            pipeline_trace_id: pipelineTraceId,
            tier: 1,
            tier_name: 'gemini_vision',
            status: 'skipped',
            error_message: !ai
              ? 'GEMINI_API_KEY not set'
              : 'Budget exhausted before Tier 1',
          });
        }
      } else {
        extractionTier = 1;
        const t1Start = Date.now();
        const geminiResult = await callGeminiExtraction(ai, mimeType, base64, rawText, deadline);
        const t1Latency = Date.now() - t1Start;
        extracted = geminiResult.fields;
        geminiDebug = geminiResult.debug;
        usedModel = geminiResult.model;
        rawAiResponse = geminiResult.rawResponse;
        if (geminiResult.budgetExhausted) {
          docBudgetExhausted = true;
          budgetExhausted = true;
          console.warn(`[extract-document] BUDGET EXHAUSTED during Gemini cascade for ${doc.file_name} — dropping to manual review`);
        }
        if (extracted.length > 0) {
          extractionSource = usedModel || "gemini";
        }
        // Ledger: success (with fields_extracted + model + latency) or failure.
        if (docOrgId) {
          if (extracted.length > 0) {
            void recordAttempt(admin, {
              document_id: doc.id,
              org_id: docOrgId,
              pipeline_trace_id: pipelineTraceId,
              tier: 1,
              tier_name: 'gemini_vision',
              status: 'success',
              fields_extracted: extracted.length,
              latency_ms: t1Latency,
              // No dedicated `model` column — store the model identifier in
              // error_message so the trace UI can surface it. Prefixed with
              // `model:` to distinguish from real error messages.
              error_message: `model:${usedModel || 'gemini'}`,
            });
          } else {
            const errMsg = (geminiDebug?.errors && geminiDebug.errors.length > 0)
              ? geminiDebug.errors.join('; ')
              : 'No fields extracted from any Gemini model';
            const isBudget = geminiResult.budgetExhausted;
            void recordAttempt(admin, {
              document_id: doc.id,
              org_id: docOrgId,
              pipeline_trace_id: pipelineTraceId,
              tier: 1,
              tier_name: 'gemini_vision',
              status: 'failure',
              latency_ms: t1Latency,
              error_code: isBudget ? 'budget_exhausted' : 'no_fields',
              error_message: errMsg,
            });
          }
        }
      }

      // ─── TIER 2: PDF text-layer extraction (if Gemini failed and it's a PDF) ───
      if (extracted.length > 0 || docBudgetExhausted || mimeType !== "application/pdf") {
        // Tier 2 not reached — either Tier 1 already succeeded, budget is
        // exhausted, or this isn't a PDF. Record as skipped.
        if (docOrgId) {
          const skipReason = extracted.length > 0
            ? 'Not needed — Tier 1 succeeded'
            : docBudgetExhausted
              ? 'Budget exhausted'
              : 'Not a PDF';
          void recordAttempt(admin, {
            document_id: doc.id,
            org_id: docOrgId,
            pipeline_trace_id: pipelineTraceId,
            tier: 2,
            tier_name: 'pdf_text_layer',
            status: 'skipped',
            error_message: skipReason,
          });
        }
      } else {
        extractionTier = 2;
        console.log("[extract-document] Tier 2: trying PDF text-layer extraction");
        const t2Start = Date.now();
        const pdfText = extractPdfTextLayer(ab);
        const t2Latency = Date.now() - t2Start;
        if (pdfText) {
          rawText = pdfText; // Use the extracted PDF text for regex
          console.log("[extract-document] PDF text-layer found, running regex on it");
        }
        if (docOrgId) {
          void recordAttempt(admin, {
            document_id: doc.id,
            org_id: docOrgId,
            pipeline_trace_id: pipelineTraceId,
            tier: 2,
            tier_name: 'pdf_text_layer',
            status: pdfText ? 'success' : 'failure',
            latency_ms: t2Latency,
            error_message: pdfText ? null : 'No embedded text layer in PDF',
          });
        }
      }

      // ─── TIER 3: Cloud Vision OCR (hosted, free monthly quota) ───
      // Independent OCR vendor — plain HTTPS POST to vision.googleapis.com,
      // no local compute. Handles IMAGE mime types only (PNG/JPEG/TIFF/etc.);
      // PDFs are skipped here (Cloud Vision images:annotate doesn't support
      // PDFs — async batch is heavier than this tier warrants) and routed to
      // Tier 4 (Tesseract via Node route which has pdftoppm to rasterize).
      // Gated behind GOOGLE_CLOUD_VISION_API_KEY — if missing, skipped silently.
      const tier3NotReached = extracted.length > 0 || docBudgetExhausted || !!rawText || budgetRemaining() <= 500 || mimeType === "application/pdf";
      if (tier3NotReached) {
        // Tier 3 not reached — earlier tier succeeded, budget exhausted,
        // text already available from Tier 2, budget too low, or this is a
        // PDF (Cloud Vision images:annotate doesn't support PDFs directly).
        if (docOrgId) {
          const skipReason = extracted.length > 0
            ? 'Not needed — earlier tier succeeded'
            : docBudgetExhausted
              ? 'Budget exhausted'
              : rawText
                ? 'Not needed — text already available from Tier 2'
                : mimeType === 'application/pdf'
                  ? 'PDF not supported by Cloud Vision images:annotate (use async batch for PDFs)'
                  : 'Budget remaining too low for OCR';
          void recordAttempt(admin, {
            document_id: doc.id,
            org_id: docOrgId,
            pipeline_trace_id: pipelineTraceId,
            tier: 3,
            tier_name: 'cloud_vision',
            status: 'skipped',
            error_message: skipReason,
          });
        }
      } else {
        extractionTier = 3;
        console.log("[extract-document] Tier 3: trying Cloud Vision OCR");
        const t3Start = Date.now();
        const cloudVisionResult = await callCloudVisionOCR(ab, mimeType);
        const t3Latency = Date.now() - t3Start;
        if (cloudVisionResult.text) {
          rawText = cloudVisionResult.text;
          console.log("[extract-document] Cloud Vision produced text, running regex on it");
        }
        if (docOrgId) {
          void recordAttempt(admin, {
            document_id: doc.id,
            org_id: docOrgId,
            pipeline_trace_id: pipelineTraceId,
            tier: 3,
            tier_name: 'cloud_vision',
            status: cloudVisionResult.text ? 'success' : 'failure',
            latency_ms: t3Latency,
            error_code: cloudVisionResult.errorCode || null,
            // (P15-style) Use the actual failure reason from callCloudVisionOCR,
            // not a one-size-fits-all generic string. A reviewer can now tell
            // "key not configured" apart from "PDF not supported" apart from
            // "API error" apart from "OCR ran but couldn't read the image."
            error_message: cloudVisionResult.text ? null : (cloudVisionResult.reason || 'Cloud Vision OCR returned no text'),
          });
        }
      }

      // ─── TIER 4: Tesseract OCR (self-hosted, free) ───
      // Calls the /api/internal/ocr Node route which runs tesseract.js.
      // Returns null silently when OCR_SERVICE_URL/INTERNAL_OCR_SECRET are
      // unset or the service is unreachable — Tier 5 is the safety net.
      const tier4NotReached = extracted.length > 0 || docBudgetExhausted || !!rawText || budgetRemaining() <= 500;
      if (tier4NotReached) {
        // Tier 4 not reached — Tier 1/2/3 already produced text, budget is
        // exhausted, or remaining budget is too small for OCR.
        if (docOrgId) {
          const skipReason = extracted.length > 0
            ? 'Not needed — earlier tier succeeded'
            : docBudgetExhausted
              ? 'Budget exhausted'
              : rawText
                ? 'Not needed — text already available from Tier 2/3'
                : 'Budget remaining too low for OCR';
          void recordAttempt(admin, {
            document_id: doc.id,
            org_id: docOrgId,
            pipeline_trace_id: pipelineTraceId,
            tier: 4,
            tier_name: 'tesseract_ocr',
            status: 'skipped',
            error_message: skipReason,
          });
        }
      } else {
        extractionTier = 4;
        console.log("[extract-document] Tier 4: trying Tesseract OCR");
        const t4Start = Date.now();
        const tesseractResult = await tesseractOCR(ab, mimeType);
        const t4Latency = Date.now() - t4Start;
        if (tesseractResult.text) {
          rawText = tesseractResult.text;
          console.log("[extract-document] Tesseract produced text, running regex on it");
        }
        if (docOrgId) {
          void recordAttempt(admin, {
            document_id: doc.id,
            org_id: docOrgId,
            pipeline_trace_id: pipelineTraceId,
            tier: 4,
            tier_name: 'tesseract_ocr',
            status: tesseractResult.text ? 'success' : 'failure',
            latency_ms: t4Latency,
            error_code: tesseractResult.errorCode || null,
            // (P15) Use the actual failure reason from tesseractOCR, not a
            // one-size-fits-all generic string. A reviewer can now tell
            // "unsupported mime type" apart from "service down" apart from
            // "OCR ran but couldn't read the image."
            error_message: tesseractResult.text ? null : (tesseractResult.reason || 'Tesseract OCR returned no text'),
          });
        }
      }

      // ─── Regex extraction on whatever text we have (works for Tiers 2, 3, 4) ───
      if (extracted.length === 0 && !docBudgetExhausted && rawText) {
        console.log(`[extract-document] Running regex extraction (tier ${extractionTier})`);
        extracted = regexExtract(rawText);
        if (extracted.length > 0) {
          extractionSource = extractionTier === 2 ? "pdf_text_layer" :
                             extractionTier === 3 ? "cloud_vision" :
                             extractionTier === 4 ? "tesseract" : "regex_fallback";
        }
      }

      // ─── TIER 5: Mark as 'needs_manual_review' — NEVER silent zero ───
      // This branch handles BOTH (a) all tiers genuinely failing and (b) the
      // wall-clock budget being exhausted. In the budget case we use a clear
      // "extraction timeout" reason so the user knows WHY it was dropped.
      if (extracted.length === 0 || docBudgetExhausted) {
        extractionTier = 5;
        extractionSource = docBudgetExhausted ? "timeout_manual_review" : "needs_manual_review";

        const reviewReason = docBudgetExhausted
          ? `Extraction timed out after ${BUDGET_MS / 1000}s wall-clock budget — the document could not be processed within the time limit. Please review manually.`
          : `All extraction tiers failed for ${doc.file_name}. Document requires manual review.`;

        // Ledger: Tier 5 is always a failure (reaching here means every
        // upstream tier failed or the budget was exhausted).
        if (docOrgId) {
          void recordAttempt(admin, {
            document_id: doc.id,
            org_id: docOrgId,
            pipeline_trace_id: pipelineTraceId,
            tier: 5,
            tier_name: 'needs_manual_review',
            status: 'failure',
            error_code: docBudgetExhausted ? 'budget_exhausted' : 'all_tiers_failed',
            error_message: reviewReason,
          });
        }

        // Mark the document for manual review
        await admin.from("documents").update({
          processing_status: "needs_manual_review",
          extraction_source: extractionSource,
        }).eq("id", doc.id);

        // Create an exception for manual review
        await userClient.from("exceptions").insert({
          shipment_id: shipmentId,
          org_id: orgMember?.org_id || null,
          user_id: user.id,
          field_key: "_document",
          field_name: docBudgetExhausted
            ? `Extraction timeout — manual review required: ${doc.file_name}`
            : `Document needs manual review: ${doc.file_name}`,
          original_value: "",
          extracted_value: "",
          confidence: 0,
          reason: reviewReason,
          exception_type: "missing_field",
          doc_type: doc.doc_type || "Unknown",
          status: "Unresolved",
          history: [],
        }).then(({ error }: any) => {
          if (error) console.warn("[extract-document] failed to create manual review exception:", error.message);
        });

        totalExtractionFailures++;
        failureDetails.push({
          documentId: doc.id,
          file_name: doc.file_name,
          reason: reviewReason,
          budgetExhausted: docBudgetExhausted,
          tiersTried: [1, 2, 3, 4],
          modelsTried: geminiDebug?.modelsTried || [],
          errors: geminiDebug?.errors || [],
        });

        perDocResults.push({
          documentId: doc.id,
          file_name: doc.file_name,
          doc_type: doc.doc_type,
          status: docBudgetExhausted ? "timeout_manual_review" : "needs_manual_review",
          extractionSource,
          extractionTier: 5,
          fieldsCount: 0,
          fields: [],
        });

        // Audit log the manual review flag
        await userClient.from("audit_logs").insert({
          shipment_id: shipmentId,
          user_id: user.id,
          text: docBudgetExhausted
            ? `[extraction] Document ${doc.file_name} dropped to manual review — ${BUDGET_MS / 1000}s wall-clock budget exhausted`
            : `[extraction] Document ${doc.file_name} marked for manual review — all 5 tiers failed`,
          type: "warning",
        }).then(({ error }: any) => { if (error) console.warn("[extract-document] audit log failed:", error.message); });

        continue;
      }

      // ─── Success: mark document as completed ───
      await admin.from("documents").update({
        processing_status: "completed",
        extraction_source: extractionSource,
      }).eq("id", doc.id);

      // 4a-bis. Persist raw AI response to audit_logs for compliance/debug.
      // We truncate to 500 chars to avoid bloating the audit log.
      if (rawAiResponse) {
        const truncated = rawAiResponse.length > 500
          ? rawAiResponse.substring(0, 500) + `…(+${rawAiResponse.length - 500} chars)`
          : rawAiResponse;
        await userClient.from("audit_logs").insert({
          shipment_id: shipmentId,
          user_id: user.id,
          text: `Gemini raw response (model: ${usedModel}, fields: ${extracted.length}) — doc ${doc.file_name}: ${truncated}`,
          type: "info",
        }).then(({ error: alErr }: any) => {
          if (alErr) {
            console.warn("[extract-document] audit_log insert failed for raw response:", alErr.message);
          }
        });
      }

      // 4a-ter. If Gemini AND regex both returned nothing, record the failure.
      // We still proceed to write whatever fields we DID get (likely none for
      // this doc), and continue with the next document. We surface the
      // aggregate failure at the end of the response.
      if (extracted.length === 0) {
        totalExtractionFailures++;
        failureDetails.push({
          documentId: doc.id,
          file_name: doc.file_name,
          reason: "no fields extracted from any model or regex",
          modelsTried: geminiDebug?.modelsTried || [],
          errors: geminiDebug?.errors || [],
        });
        perDocResults.push({
          documentId: doc.id,
          file_name: doc.file_name,
          doc_type: doc.doc_type,
          status: "extraction_failed",
          fieldsCount: 0,
          fields: [],
        });
        continue;
      }

      // 4b. Normalize + write to document_fields
      const writtenFields: any[] = [];
      for (const f of extracted) {
        const key = String(f.field_key || "").trim();
        const value = String(f.extracted_value ?? "").trim();
        if (!key || !value) continue;

        // Map label if missing
        const def = FIELD_DEFINITIONS.find((d) => d.key === key);
        const label = String(f.field_label || def?.label || key);
        const conf = Math.max(
          0,
          Math.min(100, Number(f.confidence ?? 70) || 70)
        );

        const insertRow = {
          document_id: doc.id,
          shipment_id: shipmentId,
          user_id: user.id,
          field_key: key,
          field_label: label,
          extracted_value: value,
          confidence: conf,
          is_flagged: false,
          validation_errors: [],
          bounding_box: f.bounding_box || null,
          extraction_source: extractionSource,
        };

        const { data: inserted, error: insErr } = await userClient
          .from("document_fields")
          .insert(insertRow)
          .select("id, field_key, field_label, extracted_value, confidence")
          .single();

        if (insErr) {
          console.warn(
            "[extract-document] field insert failed:",
            key,
            insErr.message
          );
          continue;
        }

        writtenFields.push(inserted);
        allFields.push(inserted);

        // Track shipper / consignee for shipment row update
        if (key === "shipper" && !latestShipper) latestShipper = value;
        if (key === "consignee" && !latestConsignee) latestConsignee = value;
      }

      perDocResults.push({
        documentId: doc.id,
        file_name: doc.file_name,
        doc_type: doc.doc_type,
        status: "extracted",
        extractionSource,
        model: usedModel,
        fieldsCount: writtenFields.length,
        fields: writtenFields,
      });
    }

    // 5. Update shipment shipper / consignee if extracted
    const shipUpdate: any = {};
    if (latestShipper) shipUpdate.shipper = latestShipper;
    if (latestConsignee) shipUpdate.consignee = latestConsignee;

    if (Object.keys(shipUpdate).length > 0) {
      const { error: shipUpdErr } = await userClient
        .from("shipments")
        .update(shipUpdate)
        .eq("id", shipmentId);
      if (shipUpdErr) {
        console.warn(
          "[extract-document] shipment shipper/consignee update failed:",
          shipUpdErr
        );
      }
    }

    // 6. Audit log
    await userClient.from("audit_logs").insert({
      shipment_id: shipmentId,
      user_id: user.id,
      text: `Gemini extraction completed for ${docs.length} document(s) — ${allFields.length} fields extracted.`,
      type: "success",
    });

    // 7. Respond — the response mirrors ExtractDocumentResponse shape.
    // If ALL models failed AND regex returned nothing for every document,
    // return a clear error instead of silently succeeding with 0 fields.
    const totalDocsAttempted = docs.length;
    if (
      ai &&
      allFields.length === 0 &&
      totalExtractionFailures === totalDocsAttempted &&
      totalDocsAttempted > 0
    ) {
      // Every document failed extraction — surface a clear, actionable error.
      await userClient.from("audit_logs").insert({
        shipment_id: shipmentId,
        user_id: user.id,
        text: `Extraction failed: all models unavailable across ${totalDocsAttempted} document(s).`,
        type: "error",
      });

      return jsonRes(
        {
          success: false,
          error: "Extraction failed: all models unavailable",
          details: {
            documentsAttempted: totalDocsAttempted,
            failures: failureDetails,
            debug: geminiDebug,
          },
        },
        502
      );
    }

    return jsonRes({
      success: true,
      shipmentId,
      documentId: documentId || docs[0]?.id,
      fields: allFields.map((f) => ({
        field_key: f.field_key,
        field_label: f.field_label,
        extracted_value: f.extracted_value,
        confidence: f.confidence,
        bounding_box: f.bounding_box || null,
      })),
      documents: perDocResults,
      shipper: latestShipper || undefined,
      consignee: latestConsignee || undefined,
      geminiUsed: !!ai,
      debug: geminiDebug,
      // Surface the wall-clock budget exhaustion so the frontend can show a
      // clear "extraction timed out" message instead of a generic failure.
      budgetExhausted,
      budgetMs: BUDGET_MS,
      ...(totalExtractionFailures > 0
        ? {
            partialFailure: {
              failedDocuments: totalExtractionFailures,
              totalDocuments: totalDocsAttempted,
              details: failureDetails,
              budgetExhausted,
            },
          }
        : {}),
    });
  } catch (err: any) {
    console.error("[extract-document] unhandled error:", err);
    return jsonRes(
      { error: "Internal server error", detail: String(err?.message || err) },
      500
    );
  }
});

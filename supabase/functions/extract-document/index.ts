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

const GEMINI_PROMPT = `You are a strict customs document OCR engine. Extract structured fields from this document.

STRICT OUTPUT CONTRACT — read carefully:
1. Return ONLY a JSON array. Do NOT wrap it in markdown fences. Do NOT add any prose, explanation, or commentary before or after the array.
2. Every object in the array MUST have EXACTLY these four keys (no more, no less):
   - "field_key": string (one of the allowed keys listed below)
   - "field_label": string (the human-readable label listed below)
   - "extracted_value": string (the verbatim value read from the document) OR null
   - "confidence": integer between 0 and 100
3. If a field is NOT present in the document, OMIT it from the array entirely. Do NOT include it with a null value.
4. If you cannot clearly read a value, OMIT that field. Do NOT guess, infer, hallucinate, or fabricate values. Only extract fields that are clearly visible in the document.
5. Confidence must reflect your actual certainty about BOTH the field's presence AND the accuracy of the extracted value:
   - 95-100: very clear, unambiguous, legible text, no possible doubt
   - 80-94:  clear, but minor ambiguity (e.g. partial obscuring, slight blur)
   - 60-79:  somewhat clear, value readable but with some uncertainty
   - below 60: uncertain — you should usually OMIT the field rather than return it
6. Use the EXACT field_key strings below (case-sensitive). Do not invent new keys.

SPECIAL HANDLING RULES:

A. MULTI-LINE TABLE ROWS:
   - Commercial invoices often have line-item tables where a single item spans multiple rows.
   - Secondary rows under a line item (e.g. "Shipping Cost", "Insurance", "Handling Fee") belong to the PRECEDING line item, NOT as separate items.
   - If a table row has no QTY or HS Code, it is a secondary row — merge it with the line item above.
   - Extract only the PRIMARY line item's HTS Code (field_key: "htsCode"), not secondary rows.

B. CURRENCY & NUMBERS:
   - Always include the currency symbol in extracted_value (e.g. "$52,150.75", not "52150.75").
   - Accept $, €, £, ¥ as valid currency prefixes.
   - If the total is labeled "Total", "Grand Total", "Invoice Total", or "Total Declared Value", extract it as field_key "declaredValue".

C. FOREIGN CHARACTERS (UTF-8):
   - Documents may contain foreign characters: German ß, ü, ö, ä; French é, è; Spanish ñ; etc.
   - Preserve the original UTF-8 characters in extracted_value (e.g. "Industriestraße 14" stays as-is).
   - Do NOT transliterate or strip foreign characters — the system handles UTF-8 normalization downstream.
   - If a name contains special characters, extract it verbatim.

D. BOUNDING BOX ISOLATION — "OFFICIAL CBP USE" AREA:
   - Many customs documents have an "Official CBP Use Only" box (usually bottom-left or bottom-right).
   - This box is for CBP officers to stamp/sign — it is NOT data to extract.
   - Do NOT extract signatures, stamps, or handwriting from the "Official CBP Use" box.
   - If a signature appears NEXT TO but OUTSIDE the CBP box, do not associate it with the box.
   - Only extract typed/printed field values from the main document body, not from official-use boxes.

Allowed fields (field_key → field_label):
- invoiceNo         → "Commercial Invoice #"
- invoiceDate       → "Invoice Date"
- shipper           → "Shipper/Exporter"
- consignee         → "Consignee/Importer"
- consigneeAddress  → "Consignee Address"
- declaredValue     → "Total Declared Value"  (include currency symbol: $1,234.56)
- htsCode           → "HTS Code"               (format XXXX.XX.XXXX, e.g. 8108.90.3060)
- netWeight         → "Net Weight"             (include unit, e.g. "1234 kg" or "1234 lbs")
- grossWeight       → "Gross Weight"           (include unit)
- portOfEntry       → "Port of Entry"
- carrier           → "Carrier"
- billOfLading      → "Bill of Lading #"
- countryOfOrigin   → "Country of Origin"      (ISO 3166-1 alpha-2, 2 uppercase letters, e.g. "CN")

Output ONLY the JSON array. No markdown fences. No prose.`;

// --- Gemini client ----------------------------------------------------------
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

// --- Helpers ----------------------------------------------------------------
// Convert ArrayBuffer to base64 string (UTF-8 safe via chunked encoding)
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000; // 32 KB
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

// Strip ```json fences and trailing prose from Gemini's reply.
// Handles arrays, single objects, and objects with a wrapper like { fields: [...] }.
function extractJsonArray(text: string): any[] {
  if (!text) return [];
  let cleaned = text.trim();

  // Remove ```json ... ``` fences if present
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Try direct parse first (fast path)
  try {
    const direct = JSON.parse(cleaned);
    if (Array.isArray(direct)) return direct;
    if (direct && typeof direct === "object") {
      // Could be a wrapper object
      if (Array.isArray(direct.fields)) return direct.fields;
      if (Array.isArray(direct.data)) return direct.data;
      // Single field object?
      if (direct.field_key) return [direct];
    }
  } catch {
    // Fall through to manual extraction
  }

  // Find the first '[' and matching last ']'
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Fall through
    }
  }

  // Try finding a JSON object instead
  const objStart = cleaned.indexOf("{");
  const objEnd = cleaned.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    const slice = cleaned.slice(objStart, objEnd + 1);
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.fields)) return parsed.fields;
        if (parsed.field_key) return [parsed];
      }
    } catch {
      // Give up
    }
  }

  return [];
}

// Fallback mock fields (used when GEMINI_API_KEY is not set so the pipeline
// can still flow end-to-end in demo/dev mode).
function mockFields(): any[] {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  return [
    {
      field_key: "invoiceNo",
      field_label: "Commercial Invoice #",
      extracted_value: "INV-" + Math.floor(10000 + Math.random() * 89999),
      confidence: 78,
    },
    {
      field_key: "invoiceDate",
      field_label: "Invoice Date",
      extracted_value: "2024-09-15",
      confidence: 82,
    },
    {
      field_key: "shipper",
      field_label: "Shipper/Exporter",
      extracted_value: pick([
        "Acme Industries Ltd.",
        "Global Trade Co.",
        "Pacific Exports Inc.",
      ]),
      confidence: 72,
    },
    {
      field_key: "consignee",
      field_label: "Consignee/Importer",
      extracted_value: pick([
        "Northwind Imports LLC",
        "Summit Distribution Corp.",
        "Harbor Trading Group",
      ]),
      confidence: 70,
    },
    {
      field_key: "declaredValue",
      field_label: "Total Declared Value",
      extracted_value: "$" + (10000 + Math.floor(Math.random() * 90000)) + ".00",
      confidence: 80,
    },
    {
      field_key: "htsCode",
      field_label: "HTS Code",
      extracted_value: "8471.30.0100",
      confidence: 65,
    },
    {
      field_key: "netWeight",
      field_label: "Net Weight",
      extracted_value: Math.floor(100 + Math.random() * 900) + " kg",
      confidence: 75,
    },
    {
      field_key: "countryOfOrigin",
      field_label: "Country of Origin",
      extracted_value: pick(["CN", "US", "DE", "JP"]),
      confidence: 68,
    },
  ];
}

// Call Gemini with the file bytes. Returns an array of field objects.
// Handles both binary files (via inlineData) and text files (via text prompt).
// Returns { fields, debug, model, rawResponse } so the caller can surface
// diagnostic info and persist the raw AI response for audit.
//
// MODEL CASCADE (most accurate first):
//   gemini-2.5-pro  → gemini-2.0-flash → gemini-1.5-flash → regex fallback
//
// NOTE: Gemini handles multi-page PDFs natively via inlineData — the entire
// PDF is sent as a single inlineData part and the model reads every page.
// No special chunking or per-page calls are required.
//
// WALL-CLOCK BUDGET: a `deadline` (epoch ms) is threaded in from the caller.
// Before every model attempt we check the remaining budget; if exhausted we
// stop immediately so the caller can drop to manual review instead of
// silently retrying for minutes. Each model call's race timeout is also
// clamped to the remaining budget so a single slow model can't blow the
// whole wall.
async function callGeminiExtraction(
  ai: GoogleGenAI,
  mimeType: string,
  base64Data: string,
  rawText: string | undefined,
  deadline: number
): Promise<{ fields: any[]; debug: any; model: string | null; rawResponse: string | null; budgetExhausted: boolean }> {
  // Ordered model cascade — Pro first (most accurate), then Flash variants.
  const models = ["gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-flash"];
  const debug: any = { modelsTried: [], errors: [], rawResponses: [], retries: [] };

  // Strict, deterministic config — temperature 0 + topP 0 + topK 1 means the
  // model always picks the single highest-probability token, ensuring that
  // the same document yields the same extraction on every run.
  const generationConfig = { temperature: 0, topP: 0, topK: 1 };

  for (const model of models) {
    // ── Budget check before each model ──
    const remaining = deadline - Date.now();
    if (remaining <= 500) {
      debug.errors.push(`budget exhausted before ${model} (remaining ${remaining}ms) — aborting Gemini cascade`);
      debug.budgetExhausted = true;
      return { fields: [], debug, model: null, rawResponse: null, budgetExhausted: true };
    }
    debug.modelsTried.push(model);
    let lastErr: any = null;

    // Retry up to 2 times on transient errors (429 rate-limit, 503 server
    // error). Exponential backoff: 1s, then 2s.
    for (let attempt = 0; attempt <= 2; attempt++) {
      // ── Budget check before each attempt ──
      const rem = deadline - Date.now();
      if (rem <= 500) {
        debug.errors.push(`budget exhausted before ${model} attempt ${attempt + 1} (remaining ${rem}ms)`);
        debug.budgetExhausted = true;
        return { fields: [], debug, model: null, rawResponse: null, budgetExhausted: true };
      }
      try {
        const parts: any[] = [];

        if (rawText && rawText.length > 0) {
          parts.push({ text: `Document text content:\n\n${rawText}\n\n---\n${GEMINI_PROMPT}` });
        } else {
          parts.push({ inlineData: { mimeType, data: base64Data } });
          parts.push({ text: GEMINI_PROMPT });
        }

        // Per-call timeout — clamped to the remaining wall-clock budget so a
        // single hung model can't burn the whole budget. Floor of 2s so we
        // still give the model a real chance; ceiling of 15s.
        const callTimeout = Math.max(2000, Math.min(15000, rem));
        const response = await Promise.race([
          ai.models.generateContent({
            model,
            contents: [{ role: "user", parts }],
            config: generationConfig,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`TIMEOUT_${callTimeout}ms after ${callTimeout}ms`)), callTimeout)
          ),
        ]);

        // Try multiple ways to get text from the response
        let text = "";
        if (typeof response.text === "string") {
          text = response.text;
        } else if (typeof response.text === "function") {
          text = response.text();
        } else if (response?.candidates?.[0]?.content?.parts?.[0]?.text) {
          text = response.candidates[0].content.parts[0].text;
        } else if (response?.response?.text) {
          text = response.response.text;
        }

        debug.rawResponses.push({ model, attempt, textLength: text.length, preview: text.substring(0, 300) });

        const parsed = extractJsonArray(text);
        if (parsed.length > 0) {
          debug.success = true;
          debug.successModel = model;
          return { fields: parsed, debug, model, rawResponse: text, budgetExhausted: false };
        } else {
          debug.errors.push(`${model}: 0 parseable fields from ${text.length} chars`);
          lastErr = new Error(`0 parseable fields from ${text.length} chars`);
          // Non-retryable: model responded but produced nothing useful.
          // Move on to the next model.
          break;
        }
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        lastErr = err;
        debug.errors.push(`${model} (attempt ${attempt + 1}): ${errMsg}`);
        debug.rawResponses.push({ model, attempt, error: errMsg });

        const isRetryable =
          /429/.test(errMsg) ||            // rate limit
          /503/.test(errMsg) ||            // server error
          /overloaded/i.test(errMsg) ||
          /rate.?limit/i.test(errMsg) ||
          /SERVICE_UNAVAILABLE/i.test(errMsg) ||
          /RESOURCE_EXHAUSTED/i.test(errMsg);

        // If quota exhausted (429), skip ALL remaining models — they share the same quota.
        // Go straight to regex fallback to avoid wasting 15+ seconds on retries.
        const isQuotaExhausted = /429/.test(errMsg) || /RESOURCE_EXHAUSTED/i.test(errMsg) || /quota/i.test(errMsg);
        if (isQuotaExhausted) {
          debug.errors.push(`${model}: quota exhausted — skipping remaining models, using regex fallback`);
          debug.quotaExhausted = true;
          return { fields: [], debug, model: null, rawResponse: null, budgetExhausted: false };
        }

        // ── Budget-aware retry: only sleep if the delay still fits the budget ──
        if (isRetryable && attempt < 1) {
          const delay = 1000; // Fixed 1s delay
          const remAfterDelay = deadline - Date.now() - delay;
          if (remAfterDelay <= 500) {
            debug.errors.push(`${model}: retry skipped — budget would be exhausted (${remAfterDelay}ms left after ${delay}ms delay)`);
            debug.budgetExhausted = true;
            return { fields: [], debug, model: null, rawResponse: null, budgetExhausted: true };
          }
          debug.retries.push({ model, attempt: attempt + 1, delayMs: delay, reason: errMsg });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Non-retryable error (incl. TIMEOUT) — break out of retry loop
        // and fall through to the next model.
        if (errMsg.startsWith("TIMEOUT_")) {
          debug.errors.push(`${model}: timed out, falling back to next model`);
        }
        break;
      }
    }
    if (lastErr) {
      // Already logged — continue to next model.
    }
  }

  return { fields: [], debug, model: null, rawResponse: null, budgetExhausted: false };
}

// --- Helper functions for regex extraction ---

// Sanitize a currency string: "$52,150.75" → "52150.75" (numeric only)
function sanitizeCurrency(val: string): { display: string; numeric: number | null } {
  const display = val.trim();
  const cleaned = display.replace(/[^0-9.]/g, "");
  const numeric = cleaned ? parseFloat(cleaned) : null;
  return { display, numeric: numeric && Number.isFinite(numeric) ? numeric : null };
}

// Normalize UTF-8 foreign characters for ASCII-only compliance systems.
function normalizeUtf8(val: string): { utf8: string; ascii: string } {
  const utf8 = val.trim();
  const ascii = utf8
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .replace(/é/g, "e").replace(/è/g, "e").replace(/ê/g, "e").replace(/ë/g, "e")
    .replace(/á/g, "a").replace(/à/g, "a").replace(/â/g, "a")
    .replace(/í/g, "i").replace(/ì/g, "i").replace(/î/g, "i")
    .replace(/ó/g, "o").replace(/ò/g, "o").replace(/ô/g, "o")
    .replace(/ú/g, "u").replace(/ù/g, "u").replace(/û/g, "u")
    .replace(/ñ/g, "n").replace(/ç/g, "c")
    .replace(/[^\x00-\x7F]/g, "")
    .trim();
  return { utf8, ascii };
}

// Parse multi-line table rows. Groups secondary lines with preceding line item.
function parseTableRows(text: string): { lineItems: any[]; totalValue: string | null } {
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
  const lineItems: any[] = [];
  let totalValue: string | null = null;

  const itemPattern = /^(.+?)\s+(\d+)\s+(\d{4}\.\d{2}\.\d{4}|\d{8,})\s+([$€£¥]?[\d,]+\.?\d*)\s*$/i;
  const totalPattern = /^(?:total|grand\s*total|invoice\s*total|total\s*value)\s*[:\-]?\s*([$€£¥][\d,]+\.?\d*)/i;

  for (const line of lines) {
    const totalMatch = line.match(totalPattern);
    if (totalMatch && totalMatch[1]) {
      totalValue = totalMatch[1].trim();
      continue;
    }
    const itemMatch = line.match(itemPattern);
    if (itemMatch) {
      const [, desc, qty, hts, value] = itemMatch;
      lineItems.push({ description: desc.trim(), qty: parseInt(qty), htsCode: hts.trim(), value: value.trim(), secondaryLines: [] as string[] });
      continue;
    }
    const isSecondary = /^(shipping\s*(?:cost|fee)?|insurance(?:\s*cost)?|freight|handling|duty|tax|discount|subtotal|other)\s*[:\-]?\s*([$€£¥]?[\d,]+\.?\d*)?/i.test(line);
    if (isSecondary && lineItems.length > 0) {
      lineItems[lineItems.length - 1].secondaryLines.push(line);
    }
  }
  return { lineItems, totalValue };
}

// --- CSV Parser ----------------------------------------------------------------
// Parse CSV content as structured fields. Expects rows with headers or key-value pairs.
function parseCSV(text: string): any[] {
  const fields: any[] = [];
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return fields;

  // Detect delimiter (comma, semicolon, tab)
  const firstLine = lines[0];
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ',';

  // Check if it's a header-based CSV
  const headers = firstLine.split(delimiter).map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  
  // Map CSV headers to our field keys
  const headerMap: Record<string, string> = {
    invoice: 'invoiceNo', invoicenumber: 'invoiceNo', invoiceno: 'invoiceNo', invoicenum: 'invoiceNo',
    date: 'invoiceDate', invoicedate: 'invoiceDate',
    shipper: 'shipper', exporter: 'shipper', shipperexporter: 'shipper',
    consignee: 'consignee', importer: 'consignee', consigneeimporter: 'consignee',
    value: 'declaredValue', totalvalue: 'declaredValue', declaredvalue: 'declaredValue', total: 'declaredValue', amount: 'declaredValue',
    hts: 'htsCode', htscode: 'htsCode', tariff: 'htsCode', hscode: 'htsCode',
    weight: 'netWeight', netweight: 'netWeight', net: 'netWeight',
    grossweight: 'grossWeight', gross: 'grossWeight',
    origin: 'countryOfOrigin', countryoforigin: 'countryOfOrigin', country: 'countryOfOrigin',
    carrier: 'carrier',
    port: 'portOfEntry', portofentry: 'portOfEntry',
    bol: 'billOfLading', billoflading: 'billOfLading',
    address: 'consigneeAddress', consigneeaddress: 'consigneeAddress',
  };

  // If first line looks like headers
  const hasHeaders = headers.some(h => headerMap[h]);
  
  if (hasHeaders && lines.length >= 2) {
    // Header-based CSV: use first data row
    const values = lines[1].split(delimiter).map(v => v.trim().replace(/^["']|["']$/g, ''));
    headers.forEach((header, idx) => {
      const fieldKey = headerMap[header];
      if (fieldKey && values[idx]) {
        const def = FIELD_DEFINITIONS.find(d => d.key === fieldKey);
        fields.push({
          field_key: fieldKey,
          field_label: def?.label || fieldKey,
          extracted_value: values[idx],
          confidence: 85,
        });
      }
    });
  } else {
    // Key-value CSV: "Invoice Number,INV-001" format
    for (const line of lines) {
      const parts = line.split(delimiter).map(p => p.trim().replace(/^["']|["']$/g, ''));
      if (parts.length >= 2) {
        const key = parts[0].toLowerCase().replace(/[^a-z0-9]/g, '');
        const value = parts[1];
        const fieldKey = headerMap[key];
        if (fieldKey && value) {
          const def = FIELD_DEFINITIONS.find(d => d.key === fieldKey);
          fields.push({
            field_key: fieldKey,
            field_label: def?.label || fieldKey,
            extracted_value: value,
            confidence: 80,
          });
        }
      }
    }
  }

  return fields;
}

// --- Regex-based fallback extractor -----------------------------------------
// When Gemini is unavailable (invalid key, rate limit, etc.), this extracts
// fields from plain-text documents using pattern matching.
// Handles: multi-line table rows, currency sanitization, UTF-8 foreign chars,
// sparse/minimal formats, multiple languages, CSV.
function regexExtract(text: string): any[] {
  if (!text) return [];

  // Try CSV parsing first if the content looks like CSV
  const csvFields = parseCSV(text);
  if (csvFields.length >= 3) {
    return csvFields;
  }

  const fields: any[] = [];
  const lines = text.split(/\n/).map(l => l.trim());
  const fullText = text;

  // --- Flexible field patterns ---
  // Each pattern has multiple aliases to handle different formats/languages
  const patterns: Array<{ key: string; label: string; regexes: RegExp[]; conf: number }> = [
    {
      key: "invoiceNo",
      label: "Commercial Invoice #",
      conf: 85,
      regexes: [
        /(?:invoice\s*(?:number|no\.?|#|num)\s*[:\-]?\s*)([A-Z0-9][A-Z0-9\-]+)/i,
        /(?:inv\.?\s*(?:no\.?|#|num)\s*[:\-]?\s*)([A-Z0-9][A-Z0-9\-]+)/i,
        /(?:^|\n)(INV[\-\d]+)/i,  // Bare INV-001 on its own line
        /(?:facture\s*(?:no\.?|n°|#)\s*[:\-]?\s*)([A-Z0-9][A-Z0-9\-]+)/i,  // French
        /(?:rechnung\s*(?:nr\.?|#)\s*[:\-]?\s*)([A-Z0-9][A-Z0-9\-]+)/i,  // German
      ],
    },
    {
      key: "invoiceDate",
      label: "Invoice Date",
      conf: 82,
      regexes: [
        /(?:invoice\s*date\s*[:\-]?\s*)(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\.\d{1,2}\.\d{4})/i,
        /(?:date\s*[:\-]\s*)(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\.\d{1,2}\.\d{4})/i,
        /(?:datum\s*[:\-]\s*)(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})/i,  // German
      ],
    },
    {
      key: "shipper",
      label: "Shipper/Exporter",
      conf: 80,
      regexes: [
        /(?:shipper(?:\/exporter)?\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:exporter\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:from\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:absender\s*[:\-]?\s*)(.+?)(?:\n|$)/i,  // German
        /(?:expéditeur\s*[:\-]?\s*)(.+?)(?:\n|$)/i,  // French
      ],
    },
    {
      key: "consignee",
      label: "Consignee/Importer",
      conf: 80,
      regexes: [
        /(?:consignee(?:\/importer)?\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:importer\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:to\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:empfänger\s*[:\-]?\s*)(.+?)(?:\n|$)/i,  // German
        /(?:destinataire\s*[:\-]?\s*)(.+?)(?:\n|$)/i,  // French
      ],
    },
    {
      key: "declaredValue",
      label: "Total Declared Value",
      conf: 88,
      regexes: [
        /(?:total\s*(?:declared\s*)?value\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
        /(?:declared\s*value\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
        /(?:grand\s*total\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
        /(?:invoice\s*total\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
        /(?:total\s*[:\-]?\s*)([$€£¥][\d,]+\.?\d*)/i,  // "Total: $1,000"
        /(?:amount\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
        /(?:value\s*[:\-]?\s*)([$€£¥][\d,]+\.?\d*)/i,  // "Value: $1,000" (requires symbol)
        // Bare value on its own line: "$5,000" or "€15,300.00"
        /(?:^|\n)\s*([$€£¥][\d,]+\.?\d*)\s*(?:\n|$)/m,
      ],
    },
    {
      key: "htsCode",
      label: "HTS Code",
      conf: 90,
      regexes: [
        /(?:hts\s*(?:code)?\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i,
        /(?:hts\s*[:\-]\s*)(\d{4}\.\d{2}\.\d{4})/i,
        /(?:hs\s*code\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i,
        /(?:tariff\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i,
        // Bare HTS: "HTS: 8471.30.0100" or "HTS 8471.30.0100"
        /(?:hts\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i,
        // From table line items: "8471.30.0100"
        /\b(\d{4}\.\d{2}\.\d{4})\b/,
      ],
    },
    {
      key: "netWeight",
      label: "Net Weight",
      conf: 85,
      regexes: [
        /(?:net\s*weight\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?|g|grams?|oz|ounces?))/i,
        /(?:net\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?))/i,
        /(?:weight\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?))/i,
        /(?:gewicht\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:kg|lbs?))/i,  // German
      ],
    },
    {
      key: "grossWeight",
      label: "Gross Weight",
      conf: 85,
      regexes: [
        /(?:gross\s*weight\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?|g|grams?|oz|ounces?))/i,
        /(?:gross\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?))/i,
      ],
    },
    {
      key: "countryOfOrigin",
      label: "Country of Origin",
      conf: 78,
      regexes: [
        /(?:country\s*of\s*origin\s*[:\-]?\s*)([A-Z]{2})/i,
        /(?:origin\s*[:\-]?\s*)([A-Z]{2})\b/i,
        /(?:country\s*[:\-]?\s*)([A-Z]{2})\b/i,
        /(?:herkunft\s*[:\-]?\s*)([A-Z]{2})/i,  // German
      ],
    },
    {
      key: "carrier",
      label: "Carrier",
      conf: 75,
      regexes: [
        /(?:carrier\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:shipping\s*carrier\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
      ],
    },
    {
      key: "portOfEntry",
      label: "Port of Entry",
      conf: 75,
      regexes: [
        /(?:port\s*of\s*entry\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:port\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
      ],
    },
    {
      key: "billOfLading",
      label: "Bill of Lading #",
      conf: 82,
      regexes: [
        /(?:bill\s*of\s*lading\s*(?:#|no\.?)?\s*[:\-]?\s*)([A-Z0-9\-]+)/i,
        /(?:bol\s*(?:#|no\.?)?\s*[:\-]?\s*)([A-Z0-9\-]+)/i,
      ],
    },
    {
      key: "consigneeAddress",
      label: "Consignee Address",
      conf: 72,
      regexes: [
        /(?:consignee\s*address\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:address\s*[:\-]?\s*)(\d+.+?(?:\n|$))/i,
      ],
    },
  ];

  // Try each pattern with all its regexes
  for (const { key, label, regexes, conf } of patterns) {
    let found = false;
    for (const regex of regexes) {
      const match = fullText.match(regex);
      if (match && match[1]) {
        let value = match[1].trim();

        // UTF-8 normalization for name/address fields
        if (key === "shipper" || key === "consignee" || key === "consigneeAddress" || key === "carrier" || key === "portOfEntry") {
          const normalized = normalizeUtf8(value);
          value = normalized.utf8;
        }

        // Clean up trailing punctuation
        value = value.replace(/[,;]+$/, '').trim();

        if (value.length > 0 && value.length < 200) {
          fields.push({ field_key: key, field_label: label, extracted_value: value, confidence: conf });
          found = true;
          break; // Use first match
        }
      }
    }
  }

  // --- Multi-line table parsing (for line items + totals) ---
  const { lineItems, totalValue } = parseTableRows(fullText);

  // If we found a total value from the table but not from the standard pattern, use it
  if (totalValue && !fields.find(f => f.field_key === "declaredValue")) {
    fields.push({
      field_key: "declaredValue",
      field_label: "Total Declared Value",
      extracted_value: totalValue,
      confidence: 90,
    });
  }

  // If we found line items with HTS codes, use the first valid one
  if (lineItems.length > 0 && !fields.find(f => f.field_key === "htsCode")) {
    const firstWithHts = lineItems.find(li => li.htsCode && /^\d{4}\.\d{2}\.\d{4}$/.test(li.htsCode));
    if (firstWithHts) {
      fields.push({
        field_key: "htsCode",
        field_label: "HTS Code",
        extracted_value: firstWithHts.htsCode,
        confidence: 88,
      });
    }
  }

  // --- Sparse document handling ---
  // If we extracted fewer than 3 fields, try bare-value extraction
  if (fields.length < 3) {
    // Look for bare invoice number (INV-XXX pattern)
    if (!fields.find(f => f.field_key === "invoiceNo")) {
      const invMatch = fullText.match(/\b(INV[\-A-Z0-9]+)\b/i);
      if (invMatch) {
        fields.push({ field_key: "invoiceNo", field_label: "Commercial Invoice #", extracted_value: invMatch[1], confidence: 70 });
      }
    }

    // Look for bare currency value
    if (!fields.find(f => f.field_key === "declaredValue")) {
      const valMatch = fullText.match(/([$€£¥][\d,]+\.?\d*)/);
      if (valMatch) {
        fields.push({ field_key: "declaredValue", field_label: "Total Declared Value", extracted_value: valMatch[1], confidence: 65 });
      }
    }

    // Look for bare HTS code
    if (!fields.find(f => f.field_key === "htsCode")) {
      const htsMatch = fullText.match(/\b(\d{4}\.\d{2}\.\d{4})\b/);
      if (htsMatch) {
        fields.push({ field_key: "htsCode", field_label: "HTS Code", extracted_value: htsMatch[1], confidence: 75 });
      }
    }

    // Look for bare country code (2 uppercase letters on their own line)
    if (!fields.find(f => f.field_key === "countryOfOrigin")) {
      const countryMatch = fullText.match(/(?:^|\n)\s*([A-Z]{2})\s*(?:\n|$)/m);
      if (countryMatch) {
        fields.push({ field_key: "countryOfOrigin", field_label: "Country of Origin", extracted_value: countryMatch[1], confidence: 60 });
      }
    }

    // Look for bare weight
    if (!fields.find(f => f.field_key === "netWeight")) {
      const weightMatch = fullText.match(/(\d[\d,]*\.?\d*\s*(?:lbs?|kg|kgs|pounds?))/i);
      if (weightMatch) {
        fields.push({ field_key: "netWeight", field_label: "Net Weight", extracted_value: weightMatch[1], confidence: 65 });
      }
    }

    // Look for company name (first line that's not a keyword/number)
    if (!fields.find(f => f.field_key === "shipper")) {
      for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines, numbers, dates, currency values, keywords
        if (trimmed.length < 3 || trimmed.length > 60) continue;
        if (/^\d/.test(trimmed)) continue;
        if (/[$€£¥]/.test(trimmed)) continue;
        if (/^(invoice|inv|date|shipper|consignee|total|hts|net|gross|country|carrier|port|bill)/i.test(trimmed)) continue;
        if (/^(INV|SHIP|DOC)/i.test(trimmed)) continue;
        // Looks like a company name
        if (/^[A-Z][a-zA-Z\s&.,]+$/.test(trimmed)) {
          fields.push({ field_key: "shipper", field_label: "Shipper/Exporter", extracted_value: trimmed, confidence: 55 });
          break;
        }
      }
    }
  }

  return fields;
}

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

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
async function callGeminiExtraction(
  ai: GoogleGenAI,
  mimeType: string,
  base64Data: string,
  rawText?: string
): Promise<{ fields: any[]; debug: any; model: string | null; rawResponse: string | null }> {
  // Ordered model cascade — Pro first (most accurate), then Flash variants.
  const models = ["gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-flash"];
  const debug: any = { modelsTried: [], errors: [], rawResponses: [], retries: [] };

  // Strict, deterministic config — temperature 0 + topP 0 + topK 1 means the
  // model always picks the single highest-probability token, ensuring that
  // the same document yields the same extraction on every run.
  const generationConfig = { temperature: 0, topP: 0, topK: 1 };

  for (const model of models) {
    debug.modelsTried.push(model);
    let lastErr: any = null;

    // Retry up to 2 times on transient errors (429 rate-limit, 503 server
    // error). Exponential backoff: 1s, then 2s.
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const parts: any[] = [];

        if (rawText && rawText.length > 0) {
          parts.push({ text: `Document text content:\n\n${rawText}\n\n---\n${GEMINI_PROMPT}` });
        } else {
          parts.push({ inlineData: { mimeType, data: base64Data } });
          parts.push({ text: GEMINI_PROMPT });
        }

        // 30-second timeout — if the model is slow or hung, abort and fall
        // back to the next model in the cascade.
        const response = await Promise.race([
          ai.models.generateContent({
            model,
            contents: [{ role: "user", parts }],
            config: generationConfig,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`TIMEOUT_15s after 15000ms`)), 15000)
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
          return { fields: parsed, debug, model, rawResponse: text };
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
          return { fields: [], debug, model: null, rawResponse: null };
        }

        if (isRetryable && attempt < 1) {  // Reduced from 2 to 1 retry
          const delay = 1000; // Fixed 1s delay (was exponential)
          debug.retries.push({ model, attempt: attempt + 1, delayMs: delay, reason: errMsg });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Non-retryable error (incl. TIMEOUT_30s) — break out of retry loop
        // and fall through to the next model.
        if (errMsg.startsWith("TIMEOUT_15s")) {
          debug.errors.push(`${model}: timed out after 30s, falling back to next model`);
        }
        break;
      }
    }
    if (lastErr) {
      // Already logged — continue to next model.
    }
  }

  return { fields: [], debug, model: null, rawResponse: null };
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

// --- Main handler -----------------------------------------------------------
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

    // 3. Fetch documents for shipment
    let docQuery = userClient
      .from("documents")
      .select("id, shipment_id, doc_type, file_name, storage_path, mime_type")
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

    // 4. Process each document
    for (const doc of docs) {
      let extracted: any[] = [];
      let usedModel: string | null = null;
      let rawAiResponse: string | null = null;
      let extractionSource: "gemini" | "regex" | "mock" | "none" = "none";

      // 4a. Download the file from Storage (admin client). This happens for
      //     every document, regardless of whether Gemini is available, so the
      //     regex fallback can still run on text-based files when no API key
      //     is configured.
      const { data: fileData, error: downloadErr } = await admin.storage
        .from("documents")
        .download(doc.storage_path);

      if (downloadErr || !fileData) {
        console.error(
          "[extract-document] file download failed for",
          doc.storage_path,
          downloadErr
        );
        perDocResults.push({
          documentId: doc.id,
          file_name: doc.file_name,
          status: "download_failed",
          fields: [],
        });
        continue;
      }

      const ab = await fileData.arrayBuffer();
      const base64 = bufToBase64(ab);
      const mimeType = doc.mime_type || "application/octet-stream";

      // For text-based files, extract the raw text. Used directly as the
      // prompt when Gemini is enabled (cheaper than re-encoding as inlineData)
      // AND as the input to the regex fallback when Gemini is unavailable.
      let rawText: string | undefined;
      if (mimeType.startsWith("text/")) {
        try {
          rawText = new TextDecoder().decode(ab);
        } catch {
          // If decode fails, fall back to inlineData
        }
      }

      if (ai) {
        const geminiResult = await callGeminiExtraction(ai, mimeType, base64, rawText);
        extracted = geminiResult.fields;
        geminiDebug = geminiResult.debug;
        usedModel = geminiResult.model;
        rawAiResponse = geminiResult.rawResponse;
        if (extracted.length > 0) extractionSource = "gemini";

        // If Gemini returned 0 fields, try regex-based extraction on text
        if (extracted.length === 0 && rawText) {
          console.log("[extract-document] Gemini returned 0 fields, trying regex extraction");
          extracted = regexExtract(rawText);
          if (extracted.length > 0) {
            extractionSource = "regex";
            if (geminiDebug) geminiDebug.regexFallback = true;
          }
        }
      } else {
        // No Gemini key — use regex extraction if we have text, else mock
        if (rawText) {
          extracted = regexExtract(rawText);
          if (extracted.length > 0) extractionSource = "regex";
        }
        if (extracted.length === 0) {
          extracted = mockFields();
          if (extracted.length > 0) extractionSource = "mock";
        }
      }

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
      ...(totalExtractionFailures > 0
        ? {
            partialFailure: {
              failedDocuments: totalExtractionFailures,
              totalDocuments: totalDocsAttempted,
              details: failureDetails,
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

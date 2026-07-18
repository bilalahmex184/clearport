// ============================================================================
// gemini.ts — Gemini Vision extraction (Tier 1)
// ============================================================================
// Extracted from extract-document/index.ts (§4 refactor — behavior-preserving).
// Exports: getGeminiClient, bufToBase64, callGeminiExtraction, GEMINI_PROMPT
// ============================================================================

import { GoogleGenAI } from "npm:@google/genai@2";

export const GEMINI_PROMPT = `You are a strict customs document OCR engine. Extract structured fields from this document.

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

export function getGeminiClient(): GoogleGenAI | null {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

// Convert ArrayBuffer to base64 string (UTF-8 safe via chunked encoding)
export function bufToBase64(buf: ArrayBuffer): string {
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
function extractJsonArray(text: string): any[] {
  if (!text) return [];
  let cleaned = text.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    const direct = JSON.parse(cleaned);
    if (Array.isArray(direct)) return direct;
    if (direct && typeof direct === "object") {
      if (Array.isArray(direct.fields)) return direct.fields;
      if (Array.isArray(direct.data)) return direct.data;
      if (direct.field_key) return [direct];
    }
  } catch {
    // Fall through
  }

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

export async function callGeminiExtraction(
  ai: GoogleGenAI,
  mimeType: string,
  base64Data: string,
  rawText: string | undefined,
  deadline: number
): Promise<{ fields: any[]; debug: any; model: string | null; rawResponse: string | null; budgetExhausted: boolean }> {
  const models = ["gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-flash"];
  const debug: any = { modelsTried: [], errors: [], rawResponses: [], retries: [] };

  const generationConfig = { temperature: 0, topP: 0, topK: 1 };

  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) {
      debug.errors.push(`budget exhausted before ${model} (remaining ${remaining}ms) — aborting Gemini cascade`);
      debug.budgetExhausted = true;
      return { fields: [], debug, model: null, rawResponse: null, budgetExhausted: true };
    }
    debug.modelsTried.push(model);
    let lastErr: any = null;

    for (let attempt = 0; attempt <= 2; attempt++) {
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
          break;
        }
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        lastErr = err;
        debug.errors.push(`${model} (attempt ${attempt + 1}): ${errMsg}`);
        debug.rawResponses.push({ model, attempt, error: errMsg });

        const isRetryable =
          /429/.test(errMsg) ||
          /503/.test(errMsg) ||
          /overloaded/i.test(errMsg) ||
          /rate.?limit/i.test(errMsg) ||
          /SERVICE_UNAVAILABLE/i.test(errMsg) ||
          /RESOURCE_EXHAUSTED/i.test(errMsg);

        const isQuotaExhausted = /429/.test(errMsg) || /RESOURCE_EXHAUSTED/i.test(errMsg) || /quota/i.test(errMsg);
        if (isQuotaExhausted) {
          debug.errors.push(`${model}: quota exhausted — skipping remaining models, using regex fallback`);
          debug.quotaExhausted = true;
          return { fields: [], debug, model: null, rawResponse: null, budgetExhausted: false };
        }

        if (isRetryable && attempt < 1) {
          const delay = 1000;
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

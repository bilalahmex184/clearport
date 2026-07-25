// ============================================================================
// gemini.ts — Gemini Vision extraction (Tier 1)
// ============================================================================
// Extracted from extract-document/index.ts (§4 refactor — behavior-preserving).
// Exports: getGeminiClient, bufToBase64, callGeminiExtraction, GEMINI_PROMPT
// ============================================================================

import { GoogleGenAI } from "npm:@google/genai@2";

export const GEMINI_PROMPT = `You are a production-grade document extraction engine specialized in messy, low-quality OCR text from customs documents.

Your job is to:
1. Correct OCR errors in the input text
2. Extract structured data with per-field confidence
3. Ensure numerical accuracy
4. Flag uncertainty
5. Never fail completely — partial output with low confidence is always better than no output

OCR ERROR CORRECTION (CRITICAL):
The input text comes from OCR and may contain these errors — fix them before extracting:
- Fix broken words: "inv0ice" → "invoice", "sh1pper" → "shipper", "0r1gin" → "origin"
- Fix number splits: "5 2,150" → "52,150", "1 234.56" → "1234.56"
- Fix currency splits: "$ 52,150" → "$52,150"
- Remove random symbols/noise characters that aren't part of any field
- Merge lines that were incorrectly split by OCR

MULTI-PASS REASONING:
Step 1: Read the raw OCR text and mentally correct obvious errors
Step 2: Identify which fields are present and where
Step 3: Extract each field value from the corrected text
Step 4: Validate internally (do totals match? are dates realistic?)
Step 5: Assign confidence based on OCR quality + extraction certainty

OUTPUT FORMAT (STRICT JSON ONLY):
Return ONLY valid JSON — no markdown, no explanations, no extra text.

{
  "document_type": "Commercial Invoice | Packing List | Bill of Lading | Certificate of Origin | Unknown",
  "fields": {
    "invoiceNo": { "value": "string or null", "confidence": 0.0-1.0, "source": "exact text snippet from document", "reasoning": "how value was inferred" },
    "invoiceDate": { "value": "YYYY-MM-DD or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." },
    "shipper": { "value": "string or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." },
    "consignee": { "value": "string or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." },
    "consigneeAddress": { "value": "string or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." },
    "declaredValue": { "value": "number or null", "currency": "USD|EUR|GBP|JPY|CNY or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." },
    "htsCode": { "value": "XXXX.XX.XXXX or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." },
    "netWeight": { "value": "string with unit (e.g. '1234 kg') or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." },
    "grossWeight": { "value": "string with unit or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." },
    "portOfEntry": { "value": "string or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." },
    "carrier": { "value": "string or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." },
    "billOfLading": { "value": "string or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." },
    "countryOfOrigin": { "value": "ISO 3166-1 alpha-2 (2 uppercase letters) or null", "confidence": 0.0-1.0, "source": "...", "reasoning": "..." }
  },
  "meta": {
    "overall_confidence": 0.0-1.0,
    "extraction_quality": "high | medium | low",
    "warnings": ["list of any issues encountered"],
    "missing_fields": ["fields that could not be extracted"],
    "ambiguities": ["fields where multiple interpretations were possible"]
  }
}

NORMALIZATION RULES:
- Dates → ISO format (YYYY-MM-DD)
- Currency → numeric value + ISO currency code (e.g. 52150.75 USD)
- HTS Code → format XXXX.XX.XXXX
- Country → 2-letter ISO code (CN, US, DE, etc.)
- Weights → include unit (kg, lbs)
- Text → trimmed, no leading/trailing whitespace

CONFIDENCE RUBRIC:
- 0.90-1.0: Clear, unambiguous, directly stated, OCR quality is high
- 0.70-0.89: Readable but minor ambiguity (partial obscuring, OCR artifact)
- 0.50-0.69: Inferred from context, OCR errors corrected with medium certainty
- 0.00-0.49: Best guess from limited information, OCR severely degraded

VALIDATION (perform internally before returning):
- If line items are present: sum(quantity × unit_price) should ≈ subtotal
- subtotal + tax should ≈ total_amount
- Dates should not be in the future
- Net weight should not exceed gross weight
- If any of these fail, add to warnings and lower confidence

Return ONLY the JSON object. No markdown fences. No prose.`;

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

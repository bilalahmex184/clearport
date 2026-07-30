// ============================================================================
// ai-extract.ts — Single-pass AI extraction via OpenRouter (Qwen models)
// ============================================================================
// This is the ONLY AI extraction path in the live upload flow. It calls
// OpenRouter's OpenAI-compatible API, which routes to Qwen VL models.
// There is NO Google Gemini involvement anywhere in this file.
//
// Environment variable: OPENROUTER_API_KEY (the ONLY key this path uses)
// ============================================================================

import OpenAI from 'openai';
import { logger } from '@/lib/utils/logger';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Qwen VL models tried in order (32B primary for speed, 72B fallback for quality)
const MODELS = [
  'qwen/qwen3-vl-32b-instruct',
  'qwen/qwen2.5-vl-72b-instruct',
  'qwen/qwen3-vl-8b-instruct',
];

/**
 * Returns true if the AI extraction provider (OpenRouter) is configured.
 * This is the function the upload flow checks before attempting AI extraction.
 * If this returns false, the pipeline silently falls back to regex — which
 * is a degraded mode, not a crash. Callers should log a warning when this
 * returns false so the operator knows AI extraction is disabled.
 */
export function isAIProviderConfigured(): boolean {
  return !!OPENROUTER_API_KEY && OPENROUTER_API_KEY.length > 10;
}

export function isProxyConfigured(): boolean { return false; }

// --- Types ---

export interface AIExtractedField {
  field_key: string;
  field_label: string;
  extracted_value: string;
  confidence: number; // 0-100
  source_location?: { page: number; text_anchor: string; approx_position: string };
  line_items_array?: any[];
}

export interface AIExtractionResult {
  fields: AIExtractedField[];
  model: string | null;
  overallConfidence: number | null;
  warnings: string[];
  documentType?: string;
  classificationConfidence?: number;
  exceptions?: any[];
  overallStatus?: string;
}

// --- Extraction prompt (single-pass: classify + extract + validate) ---

const EXTRACTION_PROMPT = `You are ClearPort's Document Extraction Engine. Extract structured data from customs/logistics documents.
ANTI-HALLUCINATION: Only extract values actually printed. Never infer.
NORMALIZATION: Dates ISO-8601. Currency "amount CODE". Addresses comma-delimited. Line items as structured array.
CLASSIFY: COMMERCIAL_INVOICE, BILL_OF_LADING, PACKING_LIST, CERTIFICATE_OF_ORIGIN, ISF_FILING, ENTRY_SUMMARY, ARRIVAL_NOTICE, OTHER_UNRECOGNIZED
Extract ALL fields: shipper_name, shipper_address, consignee_name, consignee_address, notify_party, bill_of_lading_number, carrier_ref, container_numbers, container_number, seal_numbers, seal_number, vessel_name, voyage_number, port_of_loading, port_of_discharge, port_of_entry, goods_description, hs_codes, quantity, net_weight, gross_weight, weight_unit, incoterms, freight_terms, invoice_number, invoice_date, due_date, payment_date, shipment_date, shipped_on_board_date, delivery_date, currency, unit_price, total_value, subtotal, discount, tax, country_of_origin, carrier, line_items[], payment_status.
Validate: sum(line_items)=subtotal, delivery_date<shipment_date->CRITICAL, net_weight>gross_weight->CRITICAL.
OUTPUT (strict JSON): { "document_type":"...", "classification_confidence":0.0, "fields":[{field_key,field_label,value,confidence,source_location:{page,text_anchor,approx_position}}], "fields_expected_but_absent":[], "exceptions":[{exception_id,field_name,reason,severity,confidence,status}], "overall_status":"...", "current_confidence":0.0 }`;

// --- OpenAI-compatible client (singleton) ---

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: OPENROUTER_API_KEY!,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': 'https://clearport.app',
        'X-Title': 'ClearPort Customs Compliance',
      },
    });
  }
  return _client;
}

// --- API call with exponential backoff ---

async function callOpenRouter(
  model: string,
  prompt: string,
  deadline: number,
): Promise<{ output: string | null; ok: boolean; error?: string }> {
  let delay = 2000; // 2s, 4s
  for (let attempt = 0; attempt < 2; attempt++) {
    if (deadline - Date.now() <= 1000) {
      return { output: null, ok: false, error: 'budget exhausted' };
    }
    try {
      const response = await getClient().chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
        temperature: 0.0,
      });
      const content = response.choices?.[0]?.message?.content;
      if (content) {
        return { output: typeof content === 'string' ? content : JSON.stringify(content), ok: true };
      }
      return { output: null, ok: false, error: 'no content in response' };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (/429|rate/i.test(errMsg) && attempt < 1) {
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      return { output: null, ok: false, error: errMsg.slice(0, 200) };
    }
  }
  return { output: null, ok: false, error: 'max retries exceeded' };
}

// --- JSON parser (handles fences, thinking prefixes, embedded objects) ---

function parseJSONResponse(output: string): any {
  if (!output) return null;
  let cleaned = output.trim();
  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    cleaned = cleaned.slice(objStart, objEnd + 1);
  }
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      return JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
    } catch {
      return null;
    }
  }
}

// --- Main entry point ---

/**
 * Extract structured customs fields from text using AI via OpenRouter.
 *
 * Tries models in order (32B → 72B → 8B). Returns the first successful
 * extraction. If all models fail or return 0 fields, returns empty result
 * and the caller falls back to regex extraction.
 *
 * @param text - Raw document text (from PDF extraction or text file)
 * @param deadline - Epoch ms by which the call must complete (default: now + 30s)
 */
export async function callAIExtraction(
  text: string,
  deadline: number = Date.now() + 30000,
): Promise<AIExtractionResult> {
  if (!isAIProviderConfigured()) {
    return { fields: [], model: null, overallConfidence: null, warnings: ['OPENROUTER_API_KEY not configured — AI extraction disabled'] };
  }
  if (!text?.trim()) {
    return { fields: [], model: null, overallConfidence: null, warnings: ['empty input text'] };
  }

  const warnings: string[] = [];
  const prompt = `Document text:\n\n${text}\n\n---\n${EXTRACTION_PROMPT}`;

  for (const model of MODELS) {
    if (deadline - Date.now() <= 2000) {
      warnings.push('budget exhausted');
      break;
    }

    logger.info('Calling OpenRouter (single-pass)', { model, textLength: text.length });

    const result = await callOpenRouter(model, prompt, deadline);

    if (result.ok && result.output) {
      const parsed = parseJSONResponse(result.output);
      if (parsed?.fields?.length > 0) {
        logger.info('AI extraction succeeded', {
          model,
          fieldsCount: parsed.fields.length,
          docType: parsed.document_type,
          exceptions: parsed.exceptions?.length || 0,
        });

        const fields: AIExtractedField[] = (parsed.fields || []).map((f: any) => ({
          field_key: String(f.field_key || ''),
          field_label: String(f.field_label || f.field_key || ''),
          extracted_value: String(f.value || ''),
          confidence: Math.max(0, Math.min(100, Math.round((Number(f.confidence) || 0) * 100))),
          source_location: f.source_location,
          ...(f.line_items_array ? { line_items_array: f.line_items_array } : {}),
        }));

        return {
          fields,
          model,
          overallConfidence: parsed.current_confidence != null
            ? Math.round(parsed.current_confidence * 100)
            : null,
          warnings,
          documentType: parsed.document_type,
          classificationConfidence: parsed.classification_confidence,
          exceptions: parsed.exceptions || [],
          overallStatus: parsed.overall_status,
        };
      } else {
        warnings.push(`${model}: 0 parseable fields`);
      }
    } else {
      warnings.push(`${model}: ${(result.error || '').slice(0, 100)}`);
    }
  }

  return { fields: [], model: null, overallConfidence: null, warnings };
}

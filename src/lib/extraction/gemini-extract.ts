// gemini-extract.ts — Single-pass AI extraction via OpenRouter
import OpenAI from 'openai';
import { logger } from '@/lib/utils/logger';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MODELS = ['qwen/qwen3-vl-32b-instruct', 'qwen/qwen2.5-vl-72b-instruct', 'qwen/qwen3-vl-8b-instruct'];
export function isGeminiConfigured(): boolean { return !!OPENROUTER_API_KEY && OPENROUTER_API_KEY.length > 10; }
export function isProxyConfigured(): boolean { return false; }
export interface GeminiField { field_key: string; field_label: string; extracted_value: string; confidence: number; source_location?: any; line_items_array?: any[]; }
export interface GeminiExtractionResult { fields: GeminiField[]; model: string | null; overallConfidence: number | null; warnings: string[]; documentType?: string; classificationConfidence?: number; exceptions?: any[]; overallStatus?: string; }
const PROMPT = `You are ClearPort's Document Extraction Engine. Extract structured data from customs/logistics documents.
ANTI-HALLUCINATION: Only extract values actually printed. Never infer.
NORMALIZATION: Dates ISO-8601. Currency "amount CODE". Addresses comma-delimited. Line items as structured array.
CLASSIFY: COMMERCIAL_INVOICE, BILL_OF_LADING, PACKING_LIST, CERTIFICATE_OF_ORIGIN, ISF_FILING, ENTRY_SUMMARY, ARRIVAL_NOTICE, OTHER_UNRECOGNIZED
Extract ALL fields: shipper_name, shipper_address, consignee_name, consignee_address, notify_party, bill_of_lading_number, carrier_ref, container_numbers, container_number, seal_numbers, seal_number, vessel_name, voyage_number, port_of_loading, port_of_discharge, port_of_entry, goods_description, hs_codes, quantity, net_weight, gross_weight, weight_unit, incoterms, freight_terms, invoice_number, invoice_date, due_date, payment_date, shipment_date, shipped_on_board_date, delivery_date, currency, unit_price, total_value, subtotal, discount, tax, country_of_origin, carrier, line_items[], payment_status.
Validate: sum(line_items)=subtotal, delivery_date<shipment_date->CRITICAL, net_weight>gross_weight->CRITICAL.
OUTPUT (strict JSON): { "document_type":"...", "classification_confidence":0.0, "fields":[{field_key,field_label,value,confidence,source_location:{page,text_anchor,approx_position}}], "fields_expected_but_absent":[], "exceptions":[{exception_id,field_name,reason,severity,confidence,status}], "overall_status":"...", "current_confidence":0.0 }`;
let _client: OpenAI | null = null;
function getClient(): OpenAI { if (!_client) _client = new OpenAI({ apiKey: OPENROUTER_API_KEY!, baseURL: OPENROUTER_BASE_URL, defaultHeaders: { 'HTTP-Referer': 'https://clearport.app', 'X-Title': 'ClearPort' } }); return _client; }
async function callOR(model: string, prompt: string, deadline: number): Promise<{ output: string | null; ok: boolean; error?: string }> {
  let delay = 2000;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (deadline - Date.now() <= 1000) return { output: null, ok: false, error: 'budget exhausted' };
    try { const r = await getClient().chat.completions.create({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 4000, temperature: 0.0 }); const c = r.choices?.[0]?.message?.content; if (c) return { output: typeof c === 'string' ? c : JSON.stringify(c), ok: true }; return { output: null, ok: false, error: 'no content' }; }
    catch (err: any) { const m = err?.message || String(err); if (/429|rate/i.test(m) && attempt < 1) { await new Promise(r => setTimeout(r, delay)); delay *= 2; continue; } return { output: null, ok: false, error: m.slice(0, 200) }; }
  }
  return { output: null, ok: false, error: 'max retries' };
}
function parseJSON(output: string): any { if (!output) return null; let c = output.trim(); const s = c.indexOf('{'), e = c.lastIndexOf('}'); if (s !== -1 && e !== -1 && e > s) c = c.slice(s, e + 1); const f = c.match(/```(?:json)?\s*([\s\S]*?)```/i); if (f) c = f[1].trim(); try { return JSON.parse(c); } catch { try { return JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1)); } catch { return null; } } }
export async function callGeminiExtraction(text: string, deadline: number = Date.now() + 30000): Promise<GeminiExtractionResult> {
  if (!isGeminiConfigured()) return { fields: [], model: null, overallConfidence: null, warnings: ['not configured'] };
  if (!text?.trim()) return { fields: [], model: null, overallConfidence: null, warnings: ['empty text'] };
  const warnings: string[] = []; const prompt = `Document text:\n\n${text}\n\n---\n${PROMPT}`;
  for (const model of MODELS) {
    if (deadline - Date.now() <= 2000) { warnings.push('budget exhausted'); break; }
    logger.info('Calling OpenRouter (single-pass)', { model, textLength: text.length });
    const r = await callOR(model, prompt, deadline);
    if (r.ok && r.output) { const p = parseJSON(r.output); if (p?.fields?.length > 0) { logger.info('Extraction succeeded', { model, fields: p.fields.length, docType: p.document_type, exceptions: p.exceptions?.length || 0 }); const fields: GeminiField[] = (p.fields || []).map((f: any) => ({ field_key: String(f.field_key || ''), field_label: String(f.field_label || f.field_key || ''), extracted_value: String(f.value || ''), confidence: Math.max(0, Math.min(100, Math.round((Number(f.confidence) || 0) * 100))), source_location: f.source_location, ...(f.line_items_array ? { line_items_array: f.line_items_array } : {}) })); return { fields, model, overallConfidence: p.current_confidence != null ? Math.round(p.current_confidence * 100) : null, warnings, documentType: p.document_type, classificationConfidence: p.classification_confidence, exceptions: p.exceptions || [], overallStatus: p.overall_status }; } else warnings.push(`${model}: 0 fields`); }
    else warnings.push(`${model}: ${(r.error || '').slice(0, 100)}`);
  }
  return { fields: [], model: null, overallConfidence: null, warnings };
}

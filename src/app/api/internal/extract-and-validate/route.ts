// /api/internal/extract-and-validate — ASYNC 202 + full pipeline
import { NextResponse } from 'next/server';
import { requireOrgRole, getUserEmail } from '@/lib/services/auth.service';
import { regexExtract } from '@/lib/extraction/regex-extract';
import { callGeminiExtraction, isGeminiConfigured } from '@/lib/extraction/gemini-extract';
import { mapToCanonicalSchema, type CanonicalField } from '@/lib/extraction/canonical-schema';
import { runPipeline, type ShipmentDocument, type PipelineException } from '@/lib/extraction/pipeline';
import { errorResponse } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';

const HTS_FIELDS = new Set(['htsCode','htsCodes','hts','hs_codes']);
const PARTIES_FIELDS = new Set(['shipper','consignee','consigneeAddress','shipperAddress','notifyParty','shipper_name','consignee_name']);
function thresholdFor(k: string, r: { invoice_threshold: number; hts_threshold: number; parties_threshold: number }): number {
  if (HTS_FIELDS.has(k)) return r.hts_threshold; if (PARTIES_FIELDS.has(k)) return r.parties_threshold; return r.invoice_threshold;
}
async function extractPdfText(base64Data: string): Promise<string> {
  try { const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); try { const w = await import('pdfjs-dist/legacy/build/pdf.worker.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = w; } catch {}
    const buf = Buffer.from(base64Data, 'base64'); const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useWorkerFetch: false }).promise; let text = '';
    for (let i = 1; i <= doc.numPages; i++) { const p = await doc.getPage(i); const c = await p.getTextContent(); text += c.items.map((it: any) => it.str).join(' ') + '\n'; } await doc.cleanup(); return text;
  } catch (err) { logger.warn('PDF text extraction failed', { error: err instanceof Error ? err.message : String(err) }); return ''; }
}
interface InputDoc { documentId: string; textContent?: string; fileName: string; docType: string; mimeType: string; fileData?: string; }

export async function POST(req: Request) {
  try {
    const { user, client, orgId } = await requireOrgRole(req, 'operator');
    const body = await req.json().catch(() => null); if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    const { shipmentId, documents } = body as { shipmentId?: string; documents?: InputDoc[] };
    if (!shipmentId) return NextResponse.json({ error: "Missing 'shipmentId'" }, { status: 400 });
    if (!documents?.length) return NextResponse.json({ error: "Missing 'documents'" }, { status: 400 });
    await client.from('shipments').update({ validation_status: 'running' }).eq('id', shipmentId);
    void processExtraction(client, user.id, orgId, shipmentId, documents, getUserEmail(user)).catch(err => {
      logger.error('Async extraction crashed', { shipmentId, error: err instanceof Error ? err.message : String(err) });
      void client.from('shipments').update({ validation_status: 'failed' }).eq('id', shipmentId).then(() => {});
    });
    return NextResponse.json({ success: true, shipmentId, status: 'processing' }, { status: 202 });
  } catch (err) { return errorResponse(err); }
}

async function processExtraction(client: any, userId: string, orgId: string, shipmentId: string, documents: InputDoc[], userEmail: string): Promise<void> {
  let totalFieldsWritten = 0; let latestShipper: string | null = null; let latestConsignee: string | null = null;
  const allPipelineExceptions: PipelineException[] = []; const docTypeMap = new Map<string, string>(); const shipmentDocs: ShipmentDocument[] = [];
  for (const doc of documents) {
    docTypeMap.set(doc.documentId, doc.docType); let text = (doc.textContent || '').trim();
    if (!text && doc.fileData && (doc.mimeType === 'application/pdf' || doc.fileName.toLowerCase().endsWith('.pdf'))) { logger.info('Extracting PDF text', { fileName: doc.fileName }); text = (await extractPdfText(doc.fileData)).trim(); logger.info('PDF text extracted', { fileName: doc.fileName, length: text.length }); }
    if (!text) { logger.warn('No text for document', { fileName: doc.fileName }); continue; }
    let fields: CanonicalField[] = []; let extractionSource = 'regex_fallback';
    if (isGeminiConfigured()) { try { const aiResult = await callGeminiExtraction(text); if (aiResult.fields.length > 0) { fields = mapToCanonicalSchema(aiResult.fields); extractionSource = `ai_${aiResult.model}`; logger.info('AI extraction succeeded', { fileName: doc.fileName, model: aiResult.model, fields: fields.length }); } } catch (err) { logger.warn('AI failed, regex fallback', { fileName: doc.fileName }); } }
    if (fields.length === 0) { const rf = regexExtract(text); fields = mapToCanonicalSchema(rf.map(f => ({ field_key: f.field_key, field_label: f.field_label, value: f.extracted_value, confidence: f.confidence / 100 }))); if (fields.length === 0) continue; }
    const fieldsMap: Record<string, string> = {}; for (const f of fields) fieldsMap[f.field_key] = f.value;
    const shipDoc: ShipmentDocument = { source_shipment_id: shipmentId, doc_type: doc.docType.toLowerCase().replace(/[^a-z_]/g, '_') as any, fields: fieldsMap, raw_text: text };
    shipmentDocs.push(shipDoc);
    const pipelineResult = runPipeline(shipDoc, shipmentDocs); allPipelineExceptions.push(...pipelineResult.exceptions);
    for (const f of fields) {
      const key = f.field_key; const value = key === 'line_items' && f.line_items_array ? JSON.stringify(f.line_items_array) : f.value;
      if (!key || !value) continue;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; let safeDocId = doc.documentId;
      if (!uuidRe.test(doc.documentId)) { safeDocId = typeof crypto !== 'undefined' ? crypto.randomUUID() : `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0')}`; try { await client.from('documents').insert({ id: safeDocId, shipment_id: shipmentId, user_id: userId, org_id: orgId, doc_type: doc.docType || 'Commercial Invoice', file_name: doc.fileName, storage_path: `placeholder/${shipmentId}/${safeDocId}`, file_size: 0, mime_type: doc.mimeType || 'text/plain' }); } catch {} }
      const { error: insErr } = await client.from('document_fields').insert({ document_id: safeDocId, shipment_id: shipmentId, user_id: userId, org_id: orgId, field_key: key, field_label: f.field_label, extracted_value: value, confidence: f.confidence, is_flagged: false, validation_errors: [], extraction_source: extractionSource });
      if (insErr) { logger.warn('Field insert failed', { key, error: insErr.message }); continue; }
      totalFieldsWritten++; if (key === 'shipper_name' && !latestShipper) latestShipper = f.value; if (key === 'consignee_name' && !latestConsignee) latestConsignee = f.value;
    }
    logger.info('Pipeline result', { fileName: doc.fileName, decision: pipelineResult.decision.status, exceptions: pipelineResult.exceptions.length, confidence: pipelineResult.compositeConfidence });
  }
  const shipUpd: Record<string, string> = {}; if (latestShipper) shipUpd.shipper = latestShipper; if (latestConsignee) shipUpd.consignee = latestConsignee;
  if (Object.keys(shipUpd).length > 0) await client.from('shipments').update(shipUpd).eq('id', shipmentId);
  let { data: rules } = await client.from('operational_rules').select('invoice_threshold, hts_threshold, parties_threshold').eq('user_id', userId).maybeSingle();
  if (!rules) { const { data: nr } = await client.from('operational_rules').insert({ user_id: userId, org_id: orgId, invoice_threshold: 80, hts_threshold: 85, parties_threshold: 75 }).select('invoice_threshold, hts_threshold, parties_threshold').single(); rules = nr || { invoice_threshold: 80, hts_threshold: 85, parties_threshold: 75 }; }
  await client.from('exceptions').delete().eq('shipment_id', shipmentId).eq('status', 'Unresolved');
  const { data: dbFields } = await client.from('document_fields').select('id, document_id, field_key, field_label, extracted_value, corrected_value, confidence, cross_doc_value, cross_doc_source').eq('shipment_id', shipmentId);
  const excToInsert: any[] = []; let flaggedCount = 0, totalConf = 0;
  for (const f of (dbFields || []) as any[]) { const effVal = f.corrected_value || f.extracted_value || ''; const conf = Number(f.confidence) || 0; totalConf += conf; const thresh = thresholdFor(f.field_key, rules); const dt = docTypeMap.get(f.document_id) || null; if (conf < thresh) { excToInsert.push({ shipment_id: shipmentId, field_id: f.id, user_id: userId, org_id: orgId, field_key: f.field_key, field_name: f.field_label, original_value: effVal, extracted_value: f.extracted_value, confidence: conf, reason: `[MINOR] Confidence ${conf}% below ${f.field_key} threshold ${thresh}%`, exception_type: 'low_confidence', doc_type: dt, status: 'Unresolved' }); flaggedCount++; } }
  for (const exc of allPipelineExceptions) { excToInsert.push({ shipment_id: shipmentId, user_id: userId, org_id: orgId, field_key: exc.field, field_name: exc.field, original_value: exc.value_a || '', extracted_value: exc.value_a || '', confidence: 50, reason: `[${exc.severity}] ${exc.reason}`, exception_type: 'low_confidence', doc_type: null, status: 'Unresolved' }); flaggedCount++; }
  if (excToInsert.length > 0) await client.from('exceptions').insert(excToInsert);
  let currentConf = 0; const fc = dbFields?.length || 0; if (fc > 0) currentConf = Math.max(0, Math.min(100, Math.round(totalConf / fc - flaggedCount * 5)));
  const decisionStatus = allPipelineExceptions.length > 0 ? (allPipelineExceptions.some(e => e.severity === 'CRITICAL') ? 'degraded' : 'completed') : 'completed';
  await client.from('shipments').update({ current_confidence: currentConf, initial_confidence: currentConf, validation_status: decisionStatus, last_validated_at: new Date().toISOString() }).eq('id', shipmentId);
  try { await client.from('audit_logs').insert({ shipment_id: shipmentId, user_id: userId, org_id: orgId, text: `Pipeline: ${totalFieldsWritten} fields, ${excToInsert.length} exceptions, ${currentConf}% confidence. Decision: ${decisionStatus}.`, type: excToInsert.length > 0 ? 'warning' : 'success' }); } catch {}
  logger.info('Extraction completed', { shipmentId, fields: totalFieldsWritten, exceptions: excToInsert.length, pipelineExceptions: allPipelineExceptions.length, confidence: currentConf, decision: decisionStatus });
}

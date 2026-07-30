// pipeline.ts — Complete validation pipeline (bulletproofed)
// Ported from pipeline_demo_v2.py. Every step wrapped in try/catch.
import { logger } from '@/lib/utils/logger';

export type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR';
export type DocType = 'bill_of_lading' | 'commercial_invoice' | 'packing_list' | 'unknown';
export type DecisionStatus = 'REJECT_DOCUMENT' | 'BLOCK' | 'HOLD_FOR_REVIEW' | 'APPROVED';

export interface ValidationResult { valid: boolean; reason: string; computed?: string; normalized?: string; }
export interface PipelineException { severity: Severity; field: string; reason: string; doc_a?: string; doc_b?: string; value_a?: string; value_b?: string; }
export interface ShipmentDocument { source_shipment_id: string; doc_type: DocType; fields: Record<string, string>; raw_text?: string; }
export interface FieldAuditRecord { shipment_cluster_key: string; source_doc_id: string; doc_type: string; field: string; value: string | null; method: string; confidence: number; validated: boolean; validation_reason: string; severity_if_flagged: Severity | null; timestamp: number; }
export interface RoutedAction { action: string; queue: string; reason: string; }
export interface OcrCandidate { engine: string; text: string; length: number; entropy: number; fieldHits: number; score: number; }
export interface ComponentScores { model_confidence: number; ocr_quality: number; validation_score: number; cross_doc_consistency: number; }
export interface DiscoveryResult { field: string; candidate: string | null; accepted: boolean; reason: string; }
export interface DecisionResult { status: DecisionStatus; reason: string; exceptions: PipelineException[]; scanQualityScore: number; missingRequiredCount: number; crossDocConflicts: number; }
export interface PipelineResult { decision: DecisionResult; exceptions: PipelineException[]; auditRecords: FieldAuditRecord[]; routedActions: RoutedAction[]; compositeConfidence: number; clusterKey: string; docType: DocType; discoveredFields: Record<string, DiscoveryResult>; scores: ComponentScores; }

// --- Doc Classifier ---
const SIGNALS: Record<string, Array<[string, number]>> = {
  bill_of_lading: [['BILL OF LADING', 5], ['B/L NO', 4], ['NOTIFY PARTY', 4], ['SHIPPED ON BOARD', 3], ['PLACE OF DELIVERY', 2], ['VESSEL', 2], ['PORT OF DISCHARGE', 1], ['PORT OF LOADING', 1]],
  commercial_invoice: [['COMMERCIAL INVOICE', 5], ['INVOICE NO', 4], ['TOTAL AMOUNT DUE', 3], ['UNIT PRICE', 3], ['SUBTOTAL', 2], ['PAYMENT TERMS', 2], ['INCOTERMS', 1], ['HS CODE', 1]],
  packing_list: [['PACKING LIST', 5], ['NET WEIGHT', 2], ['CARTON NO', 3], ['PALLET', 2], ['GROSS WEIGHT', 1]],
};
export function classifyDocument(rawText: string): { doc_type: DocType; confidence: number; scores: Record<string, number> } {
  const text = (rawText || '').toUpperCase(); const scores: Record<string, number> = {};
  for (const [dt, sigs] of Object.entries(SIGNALS)) { const s = sigs.reduce((sum, [p, w]) => sum + (text.includes(p) ? w : 0), 0); const max = sigs.reduce((sum, [_, w]) => sum + w, 0); scores[dt] = max > 0 ? Math.round((s / max) * 1000) / 1000 : 0; }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]; const bs = best?.[1] ?? 0;
  if (bs < 0.15) return { doc_type: 'unknown', confidence: bs, scores };
  return { doc_type: best[0] as DocType, confidence: bs, scores };
}

// --- Schema Registry ---
interface FieldSchema { key: string; required: boolean; validator?: string; reconciles_with?: string; compare_mode?: string; mismatch_severity?: Severity; tolerance_pct?: number; allow_suffix_variant?: boolean; regex_fallback?: string; }
const SCHEMAS: Record<string, Record<string, FieldSchema>> = {
  bill_of_lading: {
    bl_number: { key: 'bl_number', required: true, validator: 'validate_bl_number', reconciles_with: 'carrier_ref', compare_mode: 'exact_id', mismatch_severity: 'CRITICAL', allow_suffix_variant: true },
    consignee_name: { key: 'consignee_name', required: true, reconciles_with: 'consignee_name', compare_mode: 'fuzzy_name', mismatch_severity: 'MAJOR' },
    notify_party: { key: 'notify_party', required: true },
    container_number: { key: 'container_number', required: true, validator: 'validate_container_number', reconciles_with: 'container_numbers', compare_mode: 'exact_id', mismatch_severity: 'CRITICAL', regex_fallback: '\\b[A-Z]{3}[UJZ]\\d{7}\\b' },
    seal_number: { key: 'seal_number', required: true, reconciles_with: 'seal_numbers', compare_mode: 'exact_id', mismatch_severity: 'CRITICAL' },
    port_of_discharge: { key: 'port_of_discharge', required: true, reconciles_with: 'port_of_discharge', compare_mode: 'port_locode', mismatch_severity: 'CRITICAL' },
    gross_weight_kg: { key: 'gross_weight_kg', required: true, reconciles_with: 'total_gross_weight', compare_mode: 'tolerance_numeric', mismatch_severity: 'MAJOR', tolerance_pct: 2.0 },
    shipped_on_board_date: { key: 'shipped_on_board_date', required: true, reconciles_with: 'invoice_date', compare_mode: 'date_sequence', mismatch_severity: 'MINOR' },
    freight_terms: { key: 'freight_terms', required: true },
  },
  commercial_invoice: {
    invoice_number: { key: 'invoice_number', required: true, regex_fallback: '\\bINV-\\d{4}-\\d+\\b' },
    consignee_name: { key: 'consignee_name', required: true, reconciles_with: 'consignee_name', compare_mode: 'fuzzy_name', mismatch_severity: 'MAJOR' },
    carrier_ref: { key: 'carrier_ref', required: true, validator: 'validate_bl_number', reconciles_with: 'bl_number', compare_mode: 'exact_id', mismatch_severity: 'CRITICAL', allow_suffix_variant: true },
    container_numbers: { key: 'container_numbers', required: true, validator: 'validate_container_number', reconciles_with: 'container_number', compare_mode: 'exact_id', mismatch_severity: 'CRITICAL', regex_fallback: '\\b[A-Z]{3}[UJZ]\\d{7}\\b' },
    seal_numbers: { key: 'seal_numbers', required: true, reconciles_with: 'seal_number', compare_mode: 'exact_id', mismatch_severity: 'CRITICAL' },
    port_of_discharge: { key: 'port_of_discharge', required: true, reconciles_with: 'port_of_discharge', compare_mode: 'port_locode', mismatch_severity: 'CRITICAL' },
    total_gross_weight: { key: 'total_gross_weight', required: true, reconciles_with: 'gross_weight_kg', compare_mode: 'tolerance_numeric', mismatch_severity: 'MAJOR', tolerance_pct: 2.0 },
    invoice_date: { key: 'invoice_date', required: true, reconciles_with: 'shipped_on_board_date', compare_mode: 'date_sequence', mismatch_severity: 'MINOR' },
    incoterms: { key: 'incoterms', required: true, validator: 'validate_incoterms' },
    country_of_origin: { key: 'country_of_origin', required: false, validator: 'normalize_country' },
    hs_codes: { key: 'hs_codes', required: false, validator: 'validate_hs_code', regex_fallback: '\\b\\d{4}\\.\\d{2}(?:\\.\\d{2})?\\b' },
  },
  packing_list: {
    container_numbers: { key: 'container_numbers', required: true, validator: 'validate_container_number', reconciles_with: 'container_number', compare_mode: 'exact_id', mismatch_severity: 'CRITICAL' },
    net_weight_kg: { key: 'net_weight_kg', required: true },
  },
};

// --- Validators ---
const LETTER_VALUES: Record<string, number> = { A:10,B:12,C:13,D:14,E:15,F:16,G:17,H:18,I:19,J:20,K:21,L:23,M:24,N:25,O:26,P:27,Q:28,R:29,S:30,T:31,U:32,V:34,W:35,X:36,Y:37,Z:38 };
export function validateContainerNumber(raw: string): ValidationResult { const val=(raw||'').replace(/\s+/g,'').toUpperCase(); if(!/^[A-Z]{3}[UJZ]\d{7}$/.test(val)) return {valid:false,reason:`Format invalid (expected 4 letters + 7 digits, got '${val}')`}; const body=val.slice(0,10); const given=parseInt(val[10]); let total=0; for(let i=0;i<body.length;i++){const ch=body[i]; total+=(LETTER_VALUES[ch]??parseInt(ch))*Math.pow(2,i);} const rem=total%11; const comp=rem===10?0:rem; if(comp!==given) return {valid:false,reason:`ISO 6346 check-digit mismatch: computed ${comp}, document shows ${given}`,computed:String(comp)}; return {valid:true,reason:'ISO 6346 check-digit valid',normalized:val}; }
const INCOTERMS_2020 = new Set(['EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP']);
export function validateIncoterms(raw: string): ValidationResult { const parts=(raw||'').trim().split(/\s+/); if(!parts.length) return {valid:false,reason:'empty'}; const code=parts[0].toUpperCase(); const place=parts.length>1?parts.slice(1).join(' '):null; if(!INCOTERMS_2020.has(code)) return {valid:false,reason:`'${code}' not valid Incoterms 2020`}; if(['CIF','CFR','FOB','FAS'].includes(code)&&!place) return {valid:false,reason:`${code} requires named port`}; return {valid:true,reason:'valid',normalized:`${code} ${place||''}`.trim()}; }
const COUNTRY_TO_ISO2: Record<string,string> = {PAKISTAN:'PK','UNITED STATES':'US','UNITED STATES OF AMERICA':'US',USA:'US',CHINA:'CN',GERMANY:'DE',INDIA:'IN',BANGLADESH:'BD',VIETNAM:'VN',JAPAN:'JP','UNITED KINGDOM':'GB',CANADA:'CA',MEXICO:'MX',NETHERLANDS:'NL'};
export function normalizeCountry(raw: string): ValidationResult { const key=(raw||'').trim().toUpperCase(); if(COUNTRY_TO_ISO2[key]) return {valid:true,reason:'normalized',normalized:COUNTRY_TO_ISO2[key]}; if(/^[A-Z]{2}$/.test(key)) return {valid:true,reason:'already ISO',normalized:key}; return {valid:false,reason:`Unrecognized '${raw}'`}; }
const CARRIER_BL: Record<string,RegExp> = {MAEU:/^MAEU\d{9}(-[A-Z]{2})?$/,HLCU:/^HLCU[A-Z0-9]{10}$/,MSCU:/^MSCU[A-Z0-9]{10}$/,SCLU:/^SCLU[A-Z0-9]{10}$/,OOLU:/^OOLU[A-Z0-9]{10}$/,COSU:/^COSU[A-Z0-9]{10}$/,ONEU:/^ONEU[A-Z0-9]{10}$/};
export function validateBlNumber(raw: string): ValidationResult { const val=(raw||'').replace(/\s+/g,'').toUpperCase(); const pfx=val.slice(0,4); const pat=CARRIER_BL[pfx]; if(!pat) return {valid:false,reason:`Unknown carrier prefix '${pfx}'`}; if(!pat.test(val)) return {valid:false,reason:`'${val}' doesn't match ${pfx} pattern`}; return {valid:true,reason:'matches',normalized:val}; }
const PORT_TO_LOCODE: Record<string,string> = {'LONG BEACH':'USLGB','LOS ANGELES':'USLAX',KARACHI:'PKKHI',OAKLAND:'USOAK','NEW YORK':'USNYC'};
export function normalizePort(raw: string): ValidationResult { const text=(raw||'').toUpperCase(); const m=text.match(/\(([A-Z]{5})\)/); if(m) return {valid:true,reason:'LOCODE present',normalized:m[1]}; for(const [city,code] of Object.entries(PORT_TO_LOCODE)) { if(text.includes(city)) return {valid:true,reason:`matched ${city}`,normalized:code}; } return {valid:false,reason:`Can't resolve '${raw}'`}; }
export function validateHsCode(raw: string): ValidationResult { const codes=(raw||'').split(',').map(c=>c.trim()).filter(Boolean); if(!codes.length) return {valid:false,reason:'none'}; const bad:string[]=[]; for(const c of codes){const d=c.replace(/\D/g,''); if(![6,8,10].includes(d.length)) bad.push(`'${c}'(${d.length})`);} if(bad.length) return {valid:false,reason:`Invalid: ${bad.join(', ')}`}; return {valid:true,reason:'valid',normalized:raw}; }
export function fuzzyNameMatch(a: string, b: string, threshold = 0.85): ValidationResult { const na=(a||'').toUpperCase().replace(/[^A-Z0-9 ]/g,'').trim(); const nb=(b||'').toUpperCase().replace(/[^A-Z0-9 ]/g,'').trim(); const wa=new Set(na.split(/\s+/)); const wb=new Set(nb.split(/\s+/)); const inter=[...wa].filter(w=>wb.has(w)).length; const union=new Set([...wa,...wb]).size; const r=union>0?inter/union:0; if(r<threshold) return {valid:false,reason:`similarity ${r.toFixed(2)} below ${threshold}`}; return {valid:true,reason:`similarity ${r.toFixed(2)}`}; }
export function valuesMatchWithinTolerance(a: number, b: number, tol = 2.0): ValidationResult { if(a===0||b===0) return {valid:false,reason:'zero'}; const d=Math.abs(a-b)/Math.max(a,b)*100; if(d>tol) return {valid:false,reason:`${a} vs ${b} differ by ${d.toFixed(2)}%`}; return {valid:true,reason:'within tolerance'}; }
export function dateSequenceAdvisory(a: string, b: string, la: string, lb: string): ValidationResult { if(a>b) return {valid:false,reason:`${la} (${a}) after ${lb} (${b})`}; return {valid:true,reason:'expected sequence'}; }
export function runValidator(name: string, value: string): ValidationResult { switch(name){case 'validate_container_number':return validateContainerNumber(value);case 'validate_incoterms':return validateIncoterms(value);case 'normalize_country':return normalizeCountry(value);case 'validate_bl_number':return validateBlNumber(value);case 'validate_hs_code':return validateHsCode(value);default:return {valid:true,reason:'no validator'};} }

// --- Severity Engine ---
export function ocrGuardrail(rawText: string, fieldCount: number, minChars = 200): PipelineException[] { const len=(rawText||'').length; const ex:PipelineException[]=[]; if(len<minChars){if(fieldCount>=5) ex.push({severity:'MAJOR',field:'pipeline_integrity',reason:`OCR guardrail ${len} chars (<${minChars}) but ${fieldCount} fields extracted — guardrail reading wrong buffer`});else ex.push({severity:'CRITICAL',field:'document_quality',reason:`${len} chars (<${minChars}) and only ${fieldCount} fields — genuine OCR failure`});} return ex; }
export function checkRequiredFields(docType: string, fields: Record<string, string>): PipelineException[] { const schema=SCHEMAS[docType]||{}; const ex:PipelineException[]=[]; for(const [k,f] of Object.entries(schema)){if(f.required&&!fields[k]) ex.push({severity:'CRITICAL',field:k,reason:`Required '${k}' missing for ${docType}`});} return ex; }
export function runFieldValidators(docType: string, fields: Record<string, string>): PipelineException[] { const schema=SCHEMAS[docType]||{}; const ex:PipelineException[]=[]; for(const [k,f] of Object.entries(schema)){if(!f.validator||!(k in fields)) continue; const r=runValidator(f.validator,fields[k]); if(!r.valid){const sev:Severity=f.validator==='validate_container_number'?'CRITICAL':'MINOR'; ex.push({severity:sev,field:k,reason:r.reason});}} return ex; }
export function severityGate(exs: PipelineException[]): string { const c=exs.filter(e=>e.severity==='CRITICAL').length; const m=exs.filter(e=>e.severity==='MAJOR').length; if(c>0) return 'REJECTED_HOLD'; if(m>2) return 'REVIEW_REQUIRED'; if(m>0) return 'REVIEW_RECOMMENDED'; return 'VALIDATED'; }

// --- Decision Engine ---
export function makeDecision(quality: number, missingReq: number, crossDocConflicts: number, exs: PipelineException[]): DecisionResult {
  if(quality<0.6) return {status:'REJECT_DOCUMENT',reason:`Quality ${quality.toFixed(2)} < 0.6`,exceptions:exs,scanQualityScore:quality,missingRequiredCount:missingReq,crossDocConflicts};
  if(missingReq>0) return {status:'BLOCK',reason:`${missingReq} required field(s) missing`,exceptions:exs,scanQualityScore:quality,missingRequiredCount:missingReq,crossDocConflicts};
  if(crossDocConflicts>0) return {status:'HOLD_FOR_REVIEW',reason:`${crossDocConflicts} cross-doc conflict(s)`,exceptions:exs,scanQualityScore:quality,missingRequiredCount:missingReq,crossDocConflicts};
  const crit=exs.filter(e=>e.severity==='CRITICAL').length; if(crit>0) return {status:'HOLD_FOR_REVIEW',reason:`${crit} CRITICAL exception(s)`,exceptions:exs,scanQualityScore:quality,missingRequiredCount:missingReq,crossDocConflicts};
  return {status:'APPROVED',reason:'All checks passed',exceptions:exs,scanQualityScore:quality,missingRequiredCount:missingReq,crossDocConflicts};
}

// --- Shipment Resolver ---
function normRef(v: string): string { return (v||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function linkKey(doc: ShipmentDocument): string { for(const f of ['carrier_ref','bl_number','bill_of_lading_number']){if(doc.fields[f]) return normRef(doc.fields[f]).slice(0,13);} return ''; }
export function resolveShipments(docs: ShipmentDocument[]): Map<string, ShipmentDocument[]> { const c=new Map<string,ShipmentDocument[]>(); for(const d of docs){const k=linkKey(d)||`UNLINKED::${d.source_shipment_id}`; if(!c.has(k)) c.set(k,[]); c.get(k)!.push(d);} return c; }

// --- Reconciliation ---
function cleanNum(v: string): number { return parseFloat((v||'0').replace(/[^\d.]/g,'')||'0'); }
function compareExactId(a: string, b: string, allowSuffix: boolean): {ok:boolean;reason:string} { const na=normRef(a),nb=normRef(b); if(na===nb) return {ok:true,reason:'exact match'}; if(allowSuffix){const [s,l]=[na,nb].sort((a,b)=>a.length-b.length); if(l.startsWith(s)&&l.length-s.length<=4) return {ok:true,reason:'suffix variant match'};} return {ok:false,reason:`'${a}' != '${b}'`}; }
function compareField(fs: FieldSchema, a: string, b: string): {ok:boolean|null;reason:string} { switch(fs.compare_mode){case 'exact_id':return compareExactId(a,b,!!fs.allow_suffix_variant);case 'fuzzy_name':{const r=fuzzyNameMatch(a,b);return {ok:r.valid,reason:r.reason};}case 'tolerance_numeric':{const r=valuesMatchWithinTolerance(cleanNum(a),cleanNum(b),fs.tolerance_pct??2.0);return {ok:r.valid,reason:r.reason};}case 'port_locode':{const la=normalizePort(a),lb=normalizePort(b);if(!la.valid||!lb.valid) return {ok:null,reason:'cannot normalize ports'};return {ok:la.normalized===lb.normalized,reason:`${la.normalized} vs ${lb.normalized}`};}case 'date_sequence':{const r=dateSequenceAdvisory(a,b,'a','b');return {ok:r.valid,reason:r.reason};}default:return {ok:null,reason:'no compare_mode'};} }
export function reconcileCluster(cluster: ShipmentDocument[]): PipelineException[] { const ex:PipelineException[]=[]; for(let i=0;i<cluster.length;i++){const da=cluster[i]; const sa=SCHEMAS[da.doc_type]||{}; for(const [fk,fs] of Object.entries(sa)){if(!fs.reconciles_with||!(fk in da.fields)) continue; for(let j=i+1;j<cluster.length;j++){const db=cluster[j]; const tf=fs.reconciles_with; if(db.doc_type===da.doc_type||!(tf in db.fields)) continue; const va=da.fields[fk],vb=db.fields[tf]; const r=compareField(fs,va,vb); if(r.ok===null) ex.push({severity:'MINOR',field:fk,reason:r.reason,doc_a:da.doc_type,doc_b:db.doc_type,value_a:va,value_b:vb}); else if(!r.ok) ex.push({severity:fs.mismatch_severity||'CRITICAL',field:fk,reason:r.reason,doc_a:da.doc_type,doc_b:db.doc_type,value_a:va,value_b:vb});}}} return ex; }

// --- Field Discovery ---
const FALLBACK_PATTERNS: Record<string, [string, string|null]> = { container_number: ['\\b[A-Z]{3}[UJZ]\\d{7}\\b', 'validate_container_number'], container_numbers: ['\\b[A-Z]{3}[UJZ]\\d{7}\\b', 'validate_container_number'], invoice_number: ['\\bINV-\\d{4}-\\d+\\b', null], hs_codes: ['\\b\\d{4}\\.\\d{2}(?:\\.\\d{2})?\\b', 'validate_hs_code'] };
export function discoverField(fieldKey: string, rawText: string): DiscoveryResult { const entry=FALLBACK_PATTERNS[fieldKey]; if(!entry) return {field:fieldKey,candidate:null,accepted:false,reason:'no pattern'}; const [pat,vn]=entry; const m=(rawText||'').match(new RegExp(pat,'i')); if(!m) return {field:fieldKey,candidate:null,accepted:false,reason:'no match'}; const cand=m[0].toUpperCase(); if(!vn) return {field:fieldKey,candidate:cand,accepted:true,reason:'LOW-CONFIDENCE candidate'}; const r=runValidator(vn,cand); if(!r.valid) return {field:fieldKey,candidate:cand,accepted:false,reason:`candidate '${cand}' FAILED: ${r.reason}`}; return {field:fieldKey,candidate:cand,accepted:true,reason:`'${cand}' PASSED: ${r.reason}`}; }
export function discoverMissingFields(docType: string, fields: Record<string, string>, rawText: string): Record<string, DiscoveryResult> { const schema=SCHEMAS[docType]||{}; const results:Record<string,DiscoveryResult>={}; for(const [k,fs] of Object.entries(schema)){if(fs.required&&!fields[k]&&fs.regex_fallback) results[k]=discoverField(k,rawText);} return results; }

// --- Audit ---
export function makeAuditRecord(ck: string, di: string, dt: string, f: string, v: string|null, m: string, c: number, val: boolean, r: string, sev: Severity|null=null): FieldAuditRecord { return {shipment_cluster_key:ck,source_doc_id:di,doc_type:dt,field:f,value:v,method:m,confidence:c,validated:val,validation_reason:r,severity_if_flagged:sev,timestamp:Date.now()}; }

// --- Routing ---
export function routeException(field: string, severity: Severity, reason: string): RoutedAction { if(['document_quality','pipeline_integrity'].includes(field)){if(severity==='CRITICAL') return {action:'RE_UPLOAD',queue:'scan_quality_queue',reason:`OCR failure: ${reason}`};return {action:'MANUAL_REVIEW',queue:'pipeline_ops_queue',reason:`Pipeline issue: ${reason}`};}if(severity==='CRITICAL') return {action:'MANUAL_REVIEW',queue:'critical_review_queue',reason};if(severity==='MAJOR') return {action:'AUDIT_QUEUE',queue:'reconciliation_audit_queue',reason};return {action:'AUTO_PASS',queue:'none',reason}; }
export function routeAll(exs: PipelineException[]): RoutedAction[] { return exs.map(e=>routeException(e.field,e.severity,e.reason)); }

// --- OCR Ensemble ---
function shannonEntropy(text: string): number { if(!text) return 0; const freq:Record<string,number>={}; for(const ch of text) freq[ch]=(freq[ch]||0)+1; const n=text.length; return -Object.values(freq).reduce((s,c)=>s+(c/n)*Math.log2(c/n),0); }
const SIG_PAT = [/BILL OF LADING/i,/INVOICE/i,/CONSIGNEE/i,/CONTAINER/i,/\b[A-Z]{3}[UJZ]\d{7}\b/i,/PORT OF (LOADING|DISCHARGE)/i];
export function scoreCandidate(engine: string, text: string): OcrCandidate { const len=(text||'').length; const ent=shannonEntropy(text||''); const hits=SIG_PAT.filter(p=>p.test(text||'')).length; const score=(Math.min(len,2000)/2000)*0.3+(Math.min(ent,4.5)/4.5)*0.3+(hits/SIG_PAT.length)*0.4; return {engine,text:text||'',length:len,entropy:Math.round(ent*1000)/1000,fieldHits:hits,score:Math.round(score*10000)/10000}; }
export function runEnsemble(variants: string[]): { best: OcrCandidate; candidates: OcrCandidate[] } { const cs=variants.map((t,i)=>scoreCandidate(`engine_${i}`,t)); const best=cs.reduce((m,c)=>c.score>m.score?c:m,cs[0]); return {best,candidates:cs}; }

// --- Confidence Composite ---
const DEFAULT_WEIGHTS = { model_confidence:0.4, ocr_quality:0.2, validation_score:0.2, cross_doc_consistency:0.2 };
export function computeComposite(scores: ComponentScores, weights?: Record<string,number>): number { const w=weights||DEFAULT_WEIGHTS; return Math.round((scores.model_confidence*w.model_confidence+scores.ocr_quality*w.ocr_quality+scores.validation_score*w.validation_score+scores.cross_doc_consistency*w.cross_doc_consistency)*10000)/10000; }

// --- Full Pipeline (bulletproofed) ---
export function runPipeline(doc: ShipmentDocument, allDocs: ShipmentDocument[]): PipelineResult {
  const rawText=doc.raw_text||''; const fields:Record<string,string>={...doc.fields}; const exceptions:PipelineException[]=[]; const auditRecords:FieldAuditRecord[]=[];
  const clusters=resolveShipments(allDocs); const clusterKey=linkKey(doc)||doc.source_shipment_id;
  const scores:ComponentScores={model_confidence:0.85,ocr_quality:Math.min(1,rawText.length/2000),validation_score:1.0,cross_doc_consistency:1.0};
  let docType:DocType=doc.doc_type; let discovered:Record<string,DiscoveryResult>={}; let reconExceptions:PipelineException[]=[];
  try { const variants=[rawText,rawText.slice(0,-5),rawText.slice(0,Math.floor(rawText.length*0.6))]; const {best}=runEnsemble(variants); scores.ocr_quality=best.score; } catch(err){exceptions.push({severity:'MAJOR',field:'pipeline_integrity',reason:`OCR ensemble failed: ${err instanceof Error?err.message:String(err)}`});}
  try { const cl=classifyDocument(rawText); docType=cl.doc_type!=='unknown'?cl.doc_type:doc.doc_type; } catch(err){exceptions.push({severity:'MAJOR',field:'pipeline_integrity',reason:`Classification failed: ${err instanceof Error?err.message:String(err)}`});}
  try { exceptions.push(...ocrGuardrail(rawText,Object.keys(fields).length)); } catch(err){exceptions.push({severity:'CRITICAL',field:'pipeline_integrity',reason:`Guardrail failed: ${err instanceof Error?err.message:String(err)}`});}
  try { const mb=checkRequiredFields(docType,fields); if(mb.length>0){discovered=discoverMissingFields(docType,fields,rawText); for(const[f,r]of Object.entries(discovered)){if(r.accepted&&r.candidate){fields[f]=r.candidate;auditRecords.push(makeAuditRecord(clusterKey,doc.source_shipment_id,docType,f,r.candidate,'regex_fallback',0.7,true,r.reason));}else{auditRecords.push(makeAuditRecord(clusterKey,doc.source_shipment_id,docType,f,null,'regex_fallback',0,false,r.reason));}}} } catch(err){exceptions.push({severity:'MAJOR',field:'pipeline_integrity',reason:`Discovery failed: ${err instanceof Error?err.message:String(err)}`});}
  try { exceptions.push(...checkRequiredFields(docType,fields)); exceptions.push(...runFieldValidators(docType,fields)); } catch(err){exceptions.push({severity:'CRITICAL',field:'pipeline_integrity',reason:`Validation failed: ${err instanceof Error?err.message:String(err)}`});}
  try { const cluster=clusters.get(clusterKey)||[doc]; if(cluster.length>1){reconExceptions=reconcileCluster(cluster);exceptions.push(...reconExceptions);} } catch(err){exceptions.push({severity:'CRITICAL',field:'pipeline_integrity',reason:`Reconciliation crashed: ${err instanceof Error?err.message:String(err)}`});}
  const totalRecon=Math.max(1,reconExceptions.length+1); scores.cross_doc_consistency=1.0-(reconExceptions.length/totalRecon);
  const vfc=exceptions.filter(e=>e.severity!=='MINOR').length; scores.validation_score=1.0-Math.min(1.0,vfc/Math.max(1,Object.keys(fields).length));
  const composite=computeComposite(scores);
  const missingReq=exceptions.filter(e=>e.severity==='CRITICAL'&&e.reason.includes('Required field')).length; const xdc=reconExceptions.filter(e=>e.severity!=='MINOR').length;
  const decision=makeDecision(scores.ocr_quality,missingReq,xdc,exceptions);
  const routedActions=routeAll(exceptions);
  for(const[f,v]of Object.entries(fields)){const exc=exceptions.find(e=>e.field===f);auditRecords.push(makeAuditRecord(clusterKey,doc.source_shipment_id,docType,f,v,'primary_extraction',0.85,!exc,exc?.reason||'passed',exc?.severity??null));}
  return {decision,exceptions,auditRecords,routedActions,compositeConfidence:composite,clusterKey,docType,discoveredFields:discovered,scores};
}

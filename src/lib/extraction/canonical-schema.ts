// canonical-schema.ts — Canonical field mapping
export interface CanonicalField { field_key: string; field_label: string; value: string; confidence: number; source_location?: any; line_items_array?: any[]; }
export interface ReconciliationFlag { field: string; severity: 'CRITICAL' | 'MAJOR' | 'MINOR'; reason: string; doc1_type: string; doc1_value: string; doc2_type: string; doc2_value: string; }
const KEY_MAP: Record<string, { canonical: string; label: string }> = {
  'shipper': { canonical: 'shipper_name', label: 'Shipper Name' }, 'shipper_name': { canonical: 'shipper_name', label: 'Shipper Name' }, 'party_from_name': { canonical: 'shipper_name', label: 'Shipper Name' },
  'shipper_address': { canonical: 'shipper_address', label: 'Shipper Address' }, 'party_from_address': { canonical: 'shipper_address', label: 'Shipper Address' },
  'consignee': { canonical: 'consignee_name', label: 'Consignee Name' }, 'consignee_name': { canonical: 'consignee_name', label: 'Consignee Name' }, 'party_to_name': { canonical: 'consignee_name', label: 'Consignee Name' },
  'consignee_address': { canonical: 'consignee_address', label: 'Consignee Address' }, 'party_to_address': { canonical: 'consignee_address', label: 'Consignee Address' },
  'invoice_number': { canonical: 'invoice_number', label: 'Invoice Number' }, 'invoiceNo': { canonical: 'invoice_number', label: 'Invoice Number' },
  'po_number': { canonical: 'po_number', label: 'PO Number' }, 'issue_date': { canonical: 'invoice_date', label: 'Invoice Date' }, 'invoice_date': { canonical: 'invoice_date', label: 'Invoice Date' },
  'due_date': { canonical: 'due_date', label: 'Due Date' }, 'payment_date': { canonical: 'payment_date', label: 'Payment Date' },
  'declaredValue': { canonical: 'total_value', label: 'Total Declared Value' }, 'total_value': { canonical: 'total_value', label: 'Total Declared Value' }, 'total_amount': { canonical: 'total_value', label: 'Total Declared Value' },
  'subtotal': { canonical: 'subtotal', label: 'Subtotal' }, 'discount': { canonical: 'discount', label: 'Discount' }, 'tax': { canonical: 'tax', label: 'Tax' }, 'currency': { canonical: 'currency', label: 'Currency' },
  'bill_of_lading_number': { canonical: 'bl_number', label: 'B/L Number' }, 'billOfLading': { canonical: 'bl_number', label: 'B/L Number' },
  'container_numbers': { canonical: 'container_numbers', label: 'Container Numbers' }, 'container_number': { canonical: 'container_number', label: 'Container Number' },
  'seal_numbers': { canonical: 'seal_numbers', label: 'Seal Numbers' }, 'seal_number': { canonical: 'seal_number', label: 'Seal Number' },
  'port_of_loading': { canonical: 'port_of_loading', label: 'Port of Loading' }, 'port_of_discharge': { canonical: 'port_of_discharge', label: 'Port of Discharge' }, 'portOfEntry': { canonical: 'port_of_entry', label: 'Port of Entry' },
  'hs_codes': { canonical: 'hs_codes', label: 'HS Codes' }, 'htsCode': { canonical: 'hs_codes', label: 'HS Codes' }, 'hts_code': { canonical: 'hs_codes', label: 'HS Codes' },
  'netWeight': { canonical: 'net_weight', label: 'Net Weight' }, 'net_weight': { canonical: 'net_weight', label: 'Net Weight' }, 'weight': { canonical: 'net_weight', label: 'Net Weight' },
  'grossWeight': { canonical: 'gross_weight', label: 'Gross Weight' }, 'gross_weight': { canonical: 'gross_weight', label: 'Gross Weight' },
  'country_of_origin': { canonical: 'country_of_origin', label: 'Country of Origin' }, 'countryOfOrigin': { canonical: 'country_of_origin', label: 'Country of Origin' },
  'incoterms': { canonical: 'incoterms', label: 'Incoterms' }, 'carrier': { canonical: 'carrier', label: 'Carrier' }, 'notify_party': { canonical: 'notify_party', label: 'Notify Party' },
  'line_items': { canonical: 'line_items', label: 'Line Items' },
};
export function mapToCanonicalSchema(rawFields: any[]): CanonicalField[] {
  const seen = new Map<string, CanonicalField>();
  for (const raw of rawFields) {
    const rawKey = String(raw.field_key || '').trim(); if (!rawKey) continue;
    const mapping = KEY_MAP[rawKey]; const canonicalKey = mapping?.canonical || rawKey;
    const canonical: CanonicalField = { field_key: canonicalKey, field_label: mapping?.label || String(raw.field_label || rawKey), value: String(raw.value || raw.extracted_value || ''), confidence: Math.max(0, Math.min(100, Math.round((Number(raw.confidence) || 0) * 100))), source_location: raw.source_location, ...(raw.line_items_array ? { line_items_array: raw.line_items_array } : {}) };
    const existing = seen.get(canonicalKey); if (!existing || existing.confidence < canonical.confidence) seen.set(canonicalKey, canonical);
  }
  return Array.from(seen.values());
}
export function runTemporalChecks(f: CanonicalField[]): ReconciliationFlag[] { return []; }
export function runFinancialExplainability(f: CanonicalField[]): ReconciliationFlag[] { return []; }
export function runTradeLogicChecks(f: CanonicalField[], t: string): ReconciliationFlag[] { return []; }
export function runPhysicalRealityChecks(f: CanonicalField[]): ReconciliationFlag[] { return []; }
export function runChainIntegrityChecks(d: any[]): ReconciliationFlag[] { return []; }

// ============================================================================
// extraction-schema.ts — The single authoritative extraction field schema
// ============================================================================
// WHAT THIS IS
//   The ONE Zod schema that defines every extraction field, its canonical
//   key, its human label, and its validation rules. Reconciles the THREE
//   previously-divergent field definitions that existed in the codebase:
//
//     1. supabase/functions/extract-document FIELD_DEFINITIONS (13 fields:
//        invoiceNo, shipper, consignee, declaredValue, htsCode, etc. — the
//        edge function's legacy schema).
//     2. src/app/api/internal/extract-and-validate HTS_FIELDS / PARTIES_FIELDS
//        (threshold-routing sets, not a full schema — but a divergent
//        definition of "which fields are HTS vs parties").
//     3. src/lib/extraction/canonical-schema KEY_MAP (50+ key variants
//        mapped to ~30 canonical keys — the most complete list, but no Zod
//        validation).
//
//   This file supersedes all three. The edge function's 13 fields and the
//   canonical-schema's 30 fields are UNIONED here, with the canonical keys
//   as the authoritative names. The threshold-routing sets (HTS_FIELDS,
//   PARTIES_FIELDS) are derived from this schema's `category` field, not
//   duplicated as separate constants.
//
// CLOSED ISSUES
//   - #29 (duplicated business rules): the field definitions are now in ONE
//     place. The edge function and the live route both import from here.
//   - Phase 4 Step 1 (structured output enforcement): every LLM response is
//     parsed through `llmResponseSchema`. On failure, the consumer treats it
//     as a tier failure (logs to job_attempts with status='failure' + the
//     Zod error detail) and falls through to the next tier.
// ============================================================================

import { z } from 'zod';

// ---------------------------------------------------------------------------
// §1. Field category — drives threshold routing (replaces HTS_FIELDS /
//     PARTIES_FIELDS sets). A field's category determines which confidence
//     threshold applies: hts fields need 85%, parties 75%, everything else 80%.
//     These match DEFAULT_THRESHOLDS in constants.ts.
// ---------------------------------------------------------------------------
export type FieldCategory = 'hts' | 'parties' | 'financial' | 'logistics' | 'physical' | 'dates' | 'meta';

// ---------------------------------------------------------------------------
// §2. The canonical field registry. ONE entry per canonical field key.
//     `aliases` lists every variant key the LLM or legacy code might produce
//     — these feed the canonical mapping (replacing canonical-schema.ts's
//     KEY_MAP). `category` drives threshold routing. `required_for` lists
//     which document types require this field (drives the Step 5 30% rule).
// ---------------------------------------------------------------------------
export interface FieldDefinition {
  key: string;
  label: string;
  category: FieldCategory;
  aliases: string[];
  required_for: DocType[];
  validator?: 'container_number' | 'bl_number' | 'incoterms' | 'country' | 'port' | 'hs_code' | 'date' | 'currency' | 'weight';
}

export type DocType =
  | 'commercial_invoice'
  | 'bill_of_lading'
  | 'packing_list'
  | 'certificate_of_origin'
  | 'unknown';

// ---------------------------------------------------------------------------
// §3. The field registry — the single source of truth.
//     Union of the edge function's 13 fields + the canonical schema's 30
//     fields, deduplicated on canonical key. Every alias from the old KEY_MAP
//     is preserved so LLM outputs using legacy key names still map correctly.
// ---------------------------------------------------------------------------
export const FIELD_REGISTRY: FieldDefinition[] = [
  // --- Parties ---
  { key: 'shipper_name', label: 'Shipper/Exporter', category: 'parties',
    aliases: ['shipper', 'shipper_name', 'party_from_name', 'exporter', 'exporter_name'],
    required_for: ['commercial_invoice', 'bill_of_lading'] },
  { key: 'shipper_address', label: 'Shipper Address', category: 'parties',
    aliases: ['shipper_address', 'shipperAddress', 'party_from_address', 'exporter_address'],
    required_for: [] },
  { key: 'consignee_name', label: 'Consignee/Importer', category: 'parties',
    aliases: ['consignee', 'consignee_name', 'party_to_name', 'importer', 'importer_name'],
    required_for: ['commercial_invoice', 'bill_of_lading'] },
  { key: 'consignee_address', label: 'Consignee Address', category: 'parties',
    aliases: ['consignee_address', 'consigneeAddress', 'party_to_address', 'importer_address'],
    required_for: [] },
  { key: 'notify_party', label: 'Notify Party', category: 'parties',
    aliases: ['notify_party', 'notifyParty', 'notify'],
    required_for: ['bill_of_lading'] },

  // --- Financial ---
  { key: 'invoice_number', label: 'Commercial Invoice #', category: 'financial',
    aliases: ['invoice_number', 'invoiceNo', 'invoice_no', 'inv_number'],
    required_for: ['commercial_invoice'], validator: undefined },
  { key: 'invoice_date', label: 'Invoice Date', category: 'dates',
    aliases: ['invoice_date', 'invoiceDate', 'issue_date'],
    required_for: ['commercial_invoice'], validator: 'date' },
  { key: 'due_date', label: 'Due Date', category: 'dates',
    aliases: ['due_date', 'dueDate'], required_for: [], validator: 'date' },
  { key: 'total_value', label: 'Total Declared Value', category: 'financial',
    aliases: ['total_value', 'declaredValue', 'total_amount', 'invoice_total', 'grand_total'],
    required_for: ['commercial_invoice'], validator: 'currency' },
  { key: 'subtotal', label: 'Subtotal', category: 'financial',
    aliases: ['subtotal', 'sub_total'], required_for: [], validator: 'currency' },
  { key: 'tax', label: 'Tax', category: 'financial',
    aliases: ['tax', 'tax_amount'], required_for: [], validator: 'currency' },
  { key: 'discount', label: 'Discount', category: 'financial',
    aliases: ['discount'], required_for: [], validator: 'currency' },
  { key: 'currency', label: 'Currency', category: 'financial',
    aliases: ['currency', 'currency_code'], required_for: [] },
  { key: 'unit_price', label: 'Unit Price', category: 'financial',
    aliases: ['unit_price', 'unitPrice'], required_for: [], validator: 'currency' },

  // --- Logistics / Transport ---
  { key: 'bl_number', label: 'Bill of Lading #', category: 'logistics',
    aliases: ['bl_number', 'bill_of_lading_number', 'billOfLading', 'bol_number', 'bl_no'],
    required_for: ['bill_of_lading'], validator: 'bl_number' },
  { key: 'carrier_ref', label: 'Carrier Reference', category: 'logistics',
    aliases: ['carrier_ref', 'carrier_reference', 'booking_number', 'booking_no'],
    required_for: [], validator: 'bl_number' },
  { key: 'container_number', label: 'Container Number', category: 'logistics',
    aliases: ['container_number', 'container_no', 'container'],
    required_for: ['bill_of_lading', 'packing_list'], validator: 'container_number' },
  { key: 'container_numbers', label: 'Container Numbers', category: 'logistics',
    aliases: ['container_numbers', 'containers'],
    required_for: [], validator: 'container_number' },
  { key: 'seal_number', label: 'Seal Number', category: 'logistics',
    aliases: ['seal_number', 'seal_no'], required_for: ['bill_of_lading'] },
  { key: 'seal_numbers', label: 'Seal Numbers', category: 'logistics',
    aliases: ['seal_numbers'], required_for: [] },
  { key: 'vessel_name', label: 'Vessel Name', category: 'logistics',
    aliases: ['vessel_name', 'vessel'], required_for: ['bill_of_lading'] },
  { key: 'voyage_number', label: 'Voyage Number', category: 'logistics',
    aliases: ['voyage_number', 'voyage', 'voyage_no'], required_for: ['bill_of_lading'] },
  { key: 'port_of_loading', label: 'Port of Loading', category: 'logistics',
    aliases: ['port_of_loading', 'portOfLoading'], required_for: ['bill_of_lading'], validator: 'port' },
  { key: 'port_of_discharge', label: 'Port of Discharge', category: 'logistics',
    aliases: ['port_of_discharge', 'portOfDischarge'], required_for: ['bill_of_lading'], validator: 'port' },
  { key: 'port_of_entry', label: 'Port of Entry', category: 'logistics',
    aliases: ['port_of_entry', 'portOfEntry'], required_for: [], validator: 'port' },
  { key: 'carrier', label: 'Carrier', category: 'logistics',
    aliases: ['carrier'], required_for: [] },
  { key: 'freight_terms', label: 'Freight Terms', category: 'logistics',
    aliases: ['freight_terms', 'freightTerms'], required_for: ['bill_of_lading'] },
  { key: 'incoterms', label: 'Incoterms', category: 'logistics',
    aliases: ['incoterms', 'incoterm'], required_for: [], validator: 'incoterms' },
  { key: 'goods_description', label: 'Goods Description', category: 'meta',
    aliases: ['goods_description', 'description', 'product_description'], required_for: [] },

  // --- Physical / Cargo ---
  { key: 'net_weight', label: 'Net Weight', category: 'physical',
    aliases: ['net_weight', 'netWeight', 'weight', 'net_weight_kg'],
    required_for: ['packing_list'], validator: 'weight' },
  { key: 'gross_weight', label: 'Gross Weight', category: 'physical',
    aliases: ['gross_weight', 'grossWeight', 'total_gross_weight'],
    required_for: ['packing_list'], validator: 'weight' },
  { key: 'quantity', label: 'Quantity', category: 'physical',
    aliases: ['quantity', 'qty', 'qty_received'], required_for: ['packing_list'] },
  { key: 'weight_unit', label: 'Weight Unit', category: 'physical',
    aliases: ['weight_unit', 'unit_of_measure', 'uom'], required_for: [] },

  // --- Compliance ---
  { key: 'hs_codes', label: 'HS/HTS Codes', category: 'hts',
    aliases: ['hs_codes', 'htsCode', 'htsCodes', 'hts_code', 'hts', 'hs_code', 'harmonized_code'],
    required_for: ['commercial_invoice'], validator: 'hs_code' },
  { key: 'country_of_origin', label: 'Country of Origin', category: 'meta',
    aliases: ['country_of_origin', 'countryOfOrigin', 'origin_country'],
    required_for: ['commercial_invoice', 'certificate_of_origin'], validator: 'country' },

  // --- Dates (logistics) ---
  { key: 'shipped_on_board_date', label: 'Shipped On Board Date', category: 'dates',
    aliases: ['shipped_on_board_date', 'shipped_on_board', 'on_board_date'],
    required_for: ['bill_of_lading'], validator: 'date' },
  { key: 'shipment_date', label: 'Shipment Date', category: 'dates',
    aliases: ['shipment_date'], required_for: [], validator: 'date' },
  { key: 'delivery_date', label: 'Delivery Date', category: 'dates',
    aliases: ['delivery_date'], required_for: [], validator: 'date' },
  { key: 'payment_date', label: 'Payment Date', category: 'dates',
    aliases: ['payment_date'], required_for: [], validator: 'date' },
  { key: 'payment_status', label: 'Payment Status', category: 'meta',
    aliases: ['payment_status'], required_for: [] },

  // --- Line items (structured array, not a scalar field) ---
  { key: 'line_items', label: 'Line Items', category: 'financial',
    aliases: ['line_items', 'lineItems', 'items'], required_for: [] },
];

// ---------------------------------------------------------------------------
// §4. Lookup maps derived from the registry (replaces the old KEY_MAP,
//     HTS_FIELDS, PARTIES_FIELDS, and EXTRACTION_FIELDS constants).
// ---------------------------------------------------------------------------
export const FIELD_KEY_MAP: Record<string, { canonical: string; label: string; category: FieldCategory }> =
  Object.fromEntries(
    FIELD_REGISTRY.flatMap((def) => [
      [def.key, { canonical: def.key, label: def.label, category: def.category }],
      ...def.aliases.map((a) => [a, { canonical: def.key, label: def.label, category: def.category }]),
    ]),
  );

export const ALL_CANONICAL_KEYS: string[] = FIELD_REGISTRY.map((d) => d.key);

export const HTS_FIELD_KEYS: Set<string> = new Set(
  FIELD_REGISTRY.filter((d) => d.category === 'hts').map((d) => d.key),
);

export const PARTIES_FIELD_KEYS: Set<string> = new Set(
  FIELD_REGISTRY.filter((d) => d.category === 'parties').map((d) => d.key),
);

// Fields required for each doc type — drives the Step 5 30% rule.
export const REQUIRED_FIELDS_BY_DOC_TYPE: Record<DocType, string[]> = {
  commercial_invoice: FIELD_REGISTRY.filter((d) => d.required_for.includes('commercial_invoice')).map((d) => d.key),
  bill_of_lading: FIELD_REGISTRY.filter((d) => d.required_for.includes('bill_of_lading')).map((d) => d.key),
  packing_list: FIELD_REGISTRY.filter((d) => d.required_for.includes('packing_list')).map((d) => d.key),
  certificate_of_origin: FIELD_REGISTRY.filter((d) => d.required_for.includes('certificate_of_origin')).map((d) => d.key),
  unknown: [],
};

// ---------------------------------------------------------------------------
// §5. mapToCanonicalSchema — replaces src/lib/extraction/canonical-schema.ts.
//     Takes raw LLM/regex output (any key variants) and maps to canonical
//     keys. Deduplicates on canonical key, keeping the highest-confidence
//     value when multiple aliases produce the same canonical key.
// ---------------------------------------------------------------------------
export interface CanonicalField {
  field_key: string;
  field_label: string;
  value: string;
  confidence: number; // 0-100
  source?: string;             // verbatim text snippet the LLM claims the value came from
  source_location?: { page: number; text_anchor: string; approx_position: string };
  line_items_array?: Array<Record<string, unknown>>;
  category: FieldCategory;
}

export function mapToCanonicalSchema(rawFields: Array<Record<string, unknown>>): CanonicalField[] {
  const seen = new Map<string, CanonicalField>();
  for (const raw of rawFields) {
    const rawKey = String(raw.field_key || raw.key || '').trim();
    if (!rawKey) continue;
    const mapping = FIELD_KEY_MAP[rawKey];
    const canonicalKey = mapping?.canonical || rawKey;
    const confidenceRaw = Number(raw.confidence ?? 0);
    // LLM confidence is 0.0-1.0; regex/existing DB confidence is 0-100.
    // Normalize to 0-100: if <= 1.0, multiply by 100.
    const confidence = Math.max(0, Math.min(100,
      confidenceRaw <= 1.0 ? Math.round(confidenceRaw * 100) : Math.round(confidenceRaw),
    ));
    const canonical: CanonicalField = {
      field_key: canonicalKey,
      field_label: mapping?.label || String(raw.field_label || rawKey),
      value: String(raw.value ?? raw.extracted_value ?? ''),
      confidence,
      source: raw.source ? String(raw.source) : undefined,
      source_location: raw.source_location as CanonicalField['source_location'],
      line_items_array: raw.line_items_array as CanonicalField['line_items_array'],
      category: mapping?.category || 'meta',
    };
    const existing = seen.get(canonicalKey);
    if (!existing || existing.confidence < canonical.confidence) {
      seen.set(canonicalKey, canonical);
    }
  }
  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// §6. Zod schemas — the validation gates.
//     llmResponseSchema:     parses the raw JSON the LLM returns.
//     extractionResultSchema: the canonical shape after mapping + validation.
// ---------------------------------------------------------------------------

// A single LLM-extracted field. The LLM returns confidence as 0.0-1.0;
// we accept that and normalize to 0-100 in mapToCanonicalSchema.
export const llmFieldSchema = z.object({
  field_key: z.string().min(1),
  field_label: z.string().optional(),
  value: z.union([z.string(), z.number(), z.null()]),
  confidence: z.number().min(0).max(1),
  source: z.string().optional(),
  source_location: z.object({
    page: z.number().int().min(1).optional(),
    text_anchor: z.string().optional(),
    approx_position: z.string().optional(),
  }).optional(),
  line_items_array: z.array(z.record(z.unknown())).optional(),
}).passthrough(); // allow extra fields (reasoning, etc.) — we don't reject on extras

export const llmResponseSchema = z.object({
  document_type: z.string().optional(),
  classification_confidence: z.number().min(0).max(1).optional(),
  fields: z.array(llmFieldSchema),
  fields_expected_but_absent: z.array(z.string()).optional(),
  exceptions: z.array(z.object({
    exception_id: z.string().optional(),
    field_name: z.string().optional(),
    field_key: z.string().optional(),
    reason: z.string(),
    severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']).optional(),
    confidence: z.number().optional(),
    status: z.string().optional(),
  }).passthrough()).optional(),
  overall_status: z.string().optional(),
  current_confidence: z.number().min(0).max(1).optional(),
  overall_confidence: z.number().min(0).max(1).optional(),
}).passthrough(); // allow extra meta fields — reject only on missing/wrong-typed CORE fields

// The schema the consumer's pipeline-hook must produce (extends the Phase 3
// pipelineResultSchema with the extraction-specific fields). This is the
// contract between the pipeline and complete_job.
export const extractionResultSchema = z.object({
  fields: z.array(z.object({
    field_key: z.string().min(1),
    field_label: z.string().min(1),
    extracted_value: z.string(),
    confidence: z.number().int().min(0).max(100),
    extraction_source: z.string().min(1),
    source: z.string().optional(),
    source_verified: z.boolean().optional(),
    category: z.enum(['hts', 'parties', 'financial', 'logistics', 'physical', 'dates', 'meta']).optional(),
  })),
  overall_confidence: z.number().min(0).max(100),
  decision: z.enum(['APPROVED', 'HOLD', 'BLOCK', 'REJECT', 'needs_manual_review']),
  exceptions: z.array(z.object({
    field_key: z.string().min(1),
    reason: z.string().min(1),
    severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
    exception_type: z.enum([
      'low_confidence', 'source_not_verified', 'model_disagreement',
      'math_error', 'cross_doc_mismatch', 'missing_field', 'schema_error',
    ]).optional(),
  })),
  pipeline_trace_id: z.string().min(1),
  document_type: z.enum(['commercial_invoice', 'bill_of_lading', 'packing_list', 'certificate_of_origin', 'unknown']).optional(),
  raw_text: z.string().optional(),
});

export type LLMResponse = z.infer<typeof llmResponseSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

// ---------------------------------------------------------------------------
// §7. thresholdFor(field_key, rules) — replaces the live route's
//     thresholdFor function. Routes by category: hts=85%, parties=75%,
//     everything else=80%. The `rules` param lets per-org overrides win.
// ---------------------------------------------------------------------------
export interface ThresholdRules {
  invoice_threshold: number;
  hts_threshold: number;
  parties_threshold: number;
}

export const DEFAULT_THRESHOLDS: ThresholdRules = {
  invoice_threshold: 80,
  hts_threshold: 85,
  parties_threshold: 75,
};

export function thresholdFor(fieldKey: string, rules: ThresholdRules = DEFAULT_THRESHOLDS): number {
  const mapping = FIELD_KEY_MAP[fieldKey];
  if (!mapping) return rules.invoice_threshold;
  switch (mapping.category) {
    case 'hts': return rules.hts_threshold;
    case 'parties': return rules.parties_threshold;
    default: return rules.invoice_threshold;
  }
}

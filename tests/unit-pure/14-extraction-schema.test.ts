// ============================================================================
// 14-extraction-schema.test.ts — Phase 4 Step 1 (structured output enforcement)
// ============================================================================
// Verifies the reconciled Zod schema rejects malformed LLM responses rather
// than silently coercing them. This is the gate that makes a tier FAILURE
// (not a silent coercion) when the LLM returns garbage.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  llmResponseSchema,
  llmFieldSchema,
  extractionResultSchema,
  mapToCanonicalSchema,
  FIELD_REGISTRY,
  FIELD_KEY_MAP,
  HTS_FIELD_KEYS,
  PARTIES_FIELD_KEYS,
  REQUIRED_FIELDS_BY_DOC_TYPE,
  thresholdFor,
  DEFAULT_THRESHOLDS,
} from '../../packages/shared/src/extraction-schema';

describe('Phase 4 Step 1 — Reconciled extraction schema', () => {

  describe('field registry reconciliation (closes #29 duplicated business rules)', () => {
    it('FIELD_REGISTRY is non-empty and has no duplicate canonical keys', () => {
      expect(FIELD_REGISTRY.length).toBeGreaterThan(20);
      const keys = FIELD_REGISTRY.map((d) => d.key);
      const unique = new Set(keys);
      expect(unique.size).toBe(keys.length);
    });

    it('includes the edge function legacy fields (invoiceNo, shipper, consignee)', () => {
      // The edge function's 13 FIELD_DEFINITIONS must all map to a canonical key.
      const legacyKeys = ['invoiceNo', 'shipper', 'consignee', 'consigneeAddress', 'declaredValue', 'htsCode', 'netWeight', 'grossWeight', 'portOfEntry', 'carrier', 'billOfLading', 'countryOfOrigin', 'invoiceDate'];
      for (const legacy of legacyKeys) {
        expect(FIELD_KEY_MAP[legacy], `legacy key "${legacy}" must map`).toBeDefined();
      }
    });

    it('includes the live route HTS_FIELDS + PARTIES_FIELDS sets', () => {
      // The live route's HTS_FIELDS = {htsCode, htsCodes, hts, hs_codes}
      // All must map to the canonical 'hs_codes' key.
      for (const k of ['htsCode', 'htsCodes', 'hts', 'hs_codes']) {
        expect(FIELD_KEY_MAP[k]?.canonical).toBe('hs_codes');
      }
      // PARTIES_FIELDS = {shipper, consignee, consigneeAddress, shipperAddress, notifyParty, shipper_name, consignee_name}
      for (const k of ['shipper', 'consignee', 'consigneeAddress', 'shipperAddress', 'notifyParty']) {
        expect(FIELD_KEY_MAP[k]).toBeDefined();
        expect(PARTIES_FIELD_KEYS.has(FIELD_KEY_MAP[k].canonical)).toBe(true);
      }
    });

    it('HTS_FIELD_KEYS is derived from the registry (not a separate constant)', () => {
      // The old code had HTS_FIELDS as a hand-maintained Set. Now it's derived.
      expect(HTS_FIELD_KEYS.has('hs_codes')).toBe(true);
      expect(HTS_FIELD_KEYS.size).toBeGreaterThanOrEqual(1);
    });

    it('REQUIRED_FIELDS_BY_DOC_TYPE lists the required fields per doc type', () => {
      expect(REQUIRED_FIELDS_BY_DOC_TYPE.commercial_invoice).toContain('invoice_number');
      expect(REQUIRED_FIELDS_BY_DOC_TYPE.commercial_invoice).toContain('consignee_name');
      expect(REQUIRED_FIELDS_BY_DOC_TYPE.bill_of_lading).toContain('bl_number');
      expect(REQUIRED_FIELDS_BY_DOC_TYPE.bill_of_lading).toContain('container_number');
      expect(REQUIRED_FIELDS_BY_DOC_TYPE.packing_list).toContain('net_weight');
    });
  });

  describe('mapToCanonicalSchema (replaces canonical-schema.ts KEY_MAP)', () => {
    it('maps legacy aliases to canonical keys', () => {
      const raw = [
        { field_key: 'invoiceNo', value: 'INV-001', confidence: 0.95 },
        { field_key: 'shipper', value: 'Acme', confidence: 0.9 },
        { field_key: 'htsCode', value: '8471.30.0100', confidence: 0.85 },
      ];
      const canonical = mapToCanonicalSchema(raw);
      const keys = canonical.map((f) => f.field_key).sort();
      expect(keys).toEqual(['hs_codes', 'invoice_number', 'shipper_name']);
    });

    it('normalizes confidence from 0.0-1.0 to 0-100', () => {
      const raw = [{ field_key: 'shipper_name', value: 'Acme', confidence: 0.85 }];
      const canonical = mapToCanonicalSchema(raw);
      expect(canonical[0].confidence).toBe(85);
    });

    it('preserves confidence already in 0-100 range', () => {
      const raw = [{ field_key: 'shipper_name', value: 'Acme', confidence: 85 }];
      const canonical = mapToCanonicalSchema(raw);
      expect(canonical[0].confidence).toBe(85);
    });

    it('deduplicates on canonical key, keeping highest confidence', () => {
      const raw = [
        { field_key: 'shipper', value: 'Acme (low)', confidence: 0.5 },
        { field_key: 'shipper_name', value: 'Acme Industries', confidence: 0.9 },
        { field_key: 'party_from_name', value: 'Acme (alt)', confidence: 0.7 },
      ];
      const canonical = mapToCanonicalSchema(raw);
      expect(canonical.length).toBe(1);
      expect(canonical[0].value).toBe('Acme Industries');
      expect(canonical[0].confidence).toBe(90);
    });

    it('preserves the source snippet (for Step 3 verbatim-anchor check)', () => {
      const raw = [{
        field_key: 'invoice_number',
        value: 'INV-001',
        confidence: 0.95,
        source: 'Invoice Number: INV-2026-001',
      }];
      const canonical = mapToCanonicalSchema(raw);
      expect(canonical[0].source).toBe('Invoice Number: INV-2026-001');
    });

    it('passes through unknown keys (no silent drop)', () => {
      const raw = [{ field_key: 'unknown_field', value: 'x', confidence: 0.5 }];
      const canonical = mapToCanonicalSchema(raw);
      expect(canonical.length).toBe(1);
      expect(canonical[0].field_key).toBe('unknown_field');
      expect(canonical[0].category).toBe('meta'); // default for unknown
    });
  });

  describe('thresholdFor (replaces live route thresholdFor)', () => {
    it('routes hts fields to hts_threshold (85%)', () => {
      expect(thresholdFor('hs_codes')).toBe(DEFAULT_THRESHOLDS.hts_threshold);
      expect(thresholdFor('hs_codes').toString()).toBe('85');
    });

    it('routes parties fields to parties_threshold (75%)', () => {
      expect(thresholdFor('shipper_name')).toBe(DEFAULT_THRESHOLDS.parties_threshold);
      expect(thresholdFor('consignee_name')).toBe(DEFAULT_THRESHOLDS.parties_threshold);
    });

    it('routes everything else to invoice_threshold (80%)', () => {
      expect(thresholdFor('invoice_number')).toBe(DEFAULT_THRESHOLDS.invoice_threshold);
      expect(thresholdFor('total_value')).toBe(DEFAULT_THRESHOLDS.invoice_threshold);
    });

    it('respects per-org rule overrides', () => {
      const customRules = { invoice_threshold: 90, hts_threshold: 95, parties_threshold: 80 };
      expect(thresholdFor('hs_codes', customRules)).toBe(95);
      expect(thresholdFor('shipper_name', customRules)).toBe(80);
    });
  });
});

// ===========================================================================
// THE CRITICAL TEST: malformed LLM responses are REJECTED, not coerced.
// This is the heart of Phase 4 Step 1 — a tier failure, not a silent accept.
// ===========================================================================
describe('Phase 4 Step 1 — Malformed LLM response rejection', () => {

  it('REJECTS an LLM response missing the required `fields` array', () => {
    const malformed = {
      document_type: 'Commercial Invoice',
      // fields array is MISSING — a common LLM failure mode
      overall_confidence: 0.85,
    };
    const parsed = llmResponseSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('REJECTS an LLM response where `fields` is the wrong type', () => {
    const malformed = {
      document_type: 'Commercial Invoice',
      fields: 'not an array', // wrong type
    };
    const parsed = llmResponseSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('REJECTS a field missing `field_key`', () => {
    const malformed = {
      fields: [
        { value: 'INV-001', confidence: 0.9 }, // no field_key
      ],
    };
    const parsed = llmResponseSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('REJECTS a field with `field_key` as empty string', () => {
    const malformed = {
      fields: [
        { field_key: '', value: 'INV-001', confidence: 0.9 },
      ],
    };
    const parsed = llmResponseSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('REJECTS a field with confidence > 1.0 (LLM should return 0.0-1.0)', () => {
    const malformed = {
      fields: [
        { field_key: 'invoice_number', value: 'INV-001', confidence: 1.5 },
      ],
    };
    const parsed = llmResponseSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('REJECTS a field with negative confidence', () => {
    const malformed = {
      fields: [
        { field_key: 'invoice_number', value: 'INV-001', confidence: -0.1 },
      ],
    };
    const parsed = llmResponseSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('REJECTS a field with confidence as a string (wrong type)', () => {
    const malformed = {
      fields: [
        { field_key: 'invoice_number', value: 'INV-001', confidence: 'high' },
      ],
    };
    const parsed = llmResponseSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('REJECTS an LLM response that is not valid JSON at all (simulated)', () => {
    // The consumer wraps JSON.parse in try/catch; a parse failure is a tier
    // failure. Here we simulate by passing a non-object.
    const malformed = null as unknown;
    const parsed = llmResponseSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('ACCEPTS a well-formed LLM response (the happy path)', () => {
    const valid = {
      document_type: 'Commercial Invoice',
      classification_confidence: 0.92,
      fields: [
        { field_key: 'invoiceNo', value: 'INV-2026-001', confidence: 0.95, source: 'Invoice Number: INV-2026-001' },
        { field_key: 'shipper', value: 'Acme Industries Ltd.', confidence: 0.9, source: 'Shipper: Acme Industries Ltd.' },
      ],
      overall_confidence: 0.88,
    };
    const parsed = llmResponseSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    expect(parsed.data.fields.length).toBe(2);
  });

  it('ACCEPTS a minimal LLM response (only fields array, everything else optional)', () => {
    const minimal = {
      fields: [
        { field_key: 'invoice_number', value: 'INV-001', confidence: 0.8 },
      ],
    };
    const parsed = llmResponseSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
  });

  it('preserves the Zod error detail so the consumer can log it to job_attempts', () => {
    // When the consumer catches a validation failure, it logs the Zod error
    // to job_attempts.error_message. This test verifies the error detail is
    // structured (not just "validation failed").
    const malformed = {
      fields: [{ confidence: 1.5 }], // missing field_key, bad confidence
    };
    const parsed = llmResponseSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const errorJson = JSON.stringify(parsed.error.issues);
      // The error must mention which fields failed so the ledger entry is useful.
      expect(errorJson).toMatch(/field_key|confidence/);
    }
  });

  it('extractionResultSchema REJECTS a result with decision not in the enum', () => {
    const malformed = {
      fields: [],
      overall_confidence: 50,
      decision: 'MAYBE', // not in [APPROVED, HOLD, BLOCK, REJECT, needs_manual_review]
      exceptions: [],
      pipeline_trace_id: 'trace-1',
    };
    const parsed = extractionResultSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('extractionResultSchema ACCEPTS needs_manual_review as a decision (Step 5)', () => {
    const valid = {
      fields: [],
      overall_confidence: 0,
      decision: 'needs_manual_review',
      exceptions: [],
      pipeline_trace_id: 'trace-1',
    };
    const parsed = extractionResultSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('extractionResultSchema REJECTS an exception with invalid severity', () => {
    const malformed = {
      fields: [],
      overall_confidence: 50,
      decision: 'HOLD',
      exceptions: [{ field_key: 'x', reason: 'y', severity: 'WARN' }], // not CRITICAL|MAJOR|MINOR
      pipeline_trace_id: 'trace-1',
    };
    const parsed = extractionResultSchema.safeParse(malformed);
    expect(parsed.success).toBe(false);
  });

  it('extractionResultSchema ACCEPTS source_not_verified as an exception_type (Step 3)', () => {
    const valid = {
      fields: [],
      overall_confidence: 20,
      decision: 'HOLD',
      exceptions: [{
        field_key: 'invoice_number',
        reason: 'LLM-claimed source snippet not found in raw text',
        severity: 'MAJOR',
        exception_type: 'source_not_verified',
      }],
      pipeline_trace_id: 'trace-1',
    };
    const parsed = extractionResultSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });
});

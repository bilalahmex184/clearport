// ============================================================================
// 16-deterministic-validators.test.ts — Phase 4 Step 4 (math + cross validate)
// ============================================================================
// Pure unit tests for packages/shared/src/deterministic-validators.ts — the
// shared home for the deterministic (non-LLM) validation logic ported from
// the previously-orphaned edge functions:
//
//   • supabase/functions/math-validate/index.ts (433 lines)
//   • supabase/functions/cross-validate/index.ts (323 lines)
//   • src/lib/extraction/pipeline.ts format validators (validateContainerNumber,
//     validateBlNumber, validateIncoterms, normalizeCountry, normalizePort,
//     validateHsCode, fuzzyNameMatch, valuesMatchWithinTolerance)
//
// The point of this test file: prove the deterministic logic is now (a) in a
// shared package, (b) pure (no Deno/Supabase deps), and (c) correct on the
// spec's 12 cases. Pure-logic — no network, no DB, no env vars. Just vitest.
//
// NOTE on test 8 (validateContainerNumber): the spec text listed MSCU6639871
// as "valid" and MSCU6639870 as "invalid (check-digit mismatch)". The actual
// ISO 6346 check-digit algorithm (and the existing pipeline.ts port) computes
// the check digit for body "MSCU663987" as 0, so MSCU6639870 is the VALID one
// and MSCU6639871 is the INVALID one. The spec text was inverted; the tests
// below verify the algorithm's correct behavior.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  parseNumber,
  normalizeUnit,
  parseWeight,
  toKg,
  checkNetVsGrossWeight,
  checkLineItemsSum,
  checkSubtotalPlusTaxEqualsTotal,
  checkDateSequence,
  checkCurrencyConsistency,
  reconcileCrossDocument,
  validateContainerNumber,
  validateBlNumber,
  validateIncoterms,
  normalizeCountry,
  normalizePort,
  validateHsCode,
  fuzzyNameMatch,
  valuesMatchWithinTolerance,
  runSchemaValidatorsForFields,
  runDeterministicValidation,
  type ValidationException,
} from '../../packages/shared/src/deterministic-validators';
import type { CanonicalField } from '../../packages/shared/src/extraction-schema';

// ---------------------------------------------------------------------------
// Fixture helpers — construct CanonicalField objects with minimal boilerplate.
// ---------------------------------------------------------------------------

function field(
  field_key: string,
  value: string,
  opts: Partial<CanonicalField> = {},
): CanonicalField {
  return {
    field_key,
    field_label: opts.field_label ?? field_key,
    value,
    confidence: opts.confidence ?? 90,
    category: opts.category ?? 'meta',
    ...opts,
  };
}

function financialField(field_key: string, value: string): CanonicalField {
  return field(field_key, value, { category: 'financial' });
}

// ===========================================================================
// §1. parseNumber — extracts numeric value from messy strings
// ===========================================================================
describe('parseNumber (math-validate port)', () => {
  it('"$1,234.56 USD" → 1234.56', () => {
    expect(parseNumber('$1,234.56 USD')).toBe(1234.56);
  });

  it('"1234 kg" → 1234', () => {
    expect(parseNumber('1234 kg')).toBe(1234);
  });

  it('"" → null', () => {
    expect(parseNumber('')).toBeNull();
  });

  it('null → null', () => {
    expect(parseNumber(null)).toBeNull();
  });

  it('undefined → null', () => {
    expect(parseNumber(undefined)).toBeNull();
  });

  it('"abc" → null (no digits to parse)', () => {
    expect(parseNumber('abc')).toBeNull();
  });

  it('handles negative values (signs preserved)', () => {
    expect(parseNumber('-1,234.50')).toBe(-1234.5);
  });
});

// ===========================================================================
// §2. parseWeight + normalizeUnit
// ===========================================================================
describe('parseWeight + normalizeUnit (math-validate port)', () => {
  it('"1234 kg" → { value: 1234, unit: "kg" }', () => {
    expect(parseWeight('1234 kg')).toEqual({ value: 1234, unit: 'kg' });
  });

  it('"1,234.5 lb" → { value: 1234.5, unit: "lbs" } (comma-stripped, lb→lbs)', () => {
    expect(parseWeight('1,234.5 lb')).toEqual({ value: 1234.5, unit: 'lbs' });
  });

  it('"500 pounds" → { value: 500, unit: "lbs" } (spelled-out unit)', () => {
    expect(parseWeight('500 pounds')).toEqual({ value: 500, unit: 'lbs' });
  });

  it('"500g" → { value: 500, unit: "g" } (no space, single-letter unit)', () => {
    expect(parseWeight('500g')).toEqual({ value: 500, unit: 'g' });
  });

  it('"100" (no unit) → { value: 100, unit: "" } (unspecified assumed kg later)', () => {
    expect(parseWeight('100')).toEqual({ value: 100, unit: '' });
  });

  it('"not a weight" → null', () => {
    expect(parseWeight('not a weight')).toBeNull();
  });

  it('null → null', () => {
    expect(parseWeight(null)).toBeNull();
  });

  it('normalizeUnit: "pounds" → "lbs"', () => {
    expect(normalizeUnit('pounds')).toBe('lbs');
  });

  it('normalizeUnit: "kilograms" → "kg"', () => {
    expect(normalizeUnit('kilograms')).toBe('kg');
  });

  it('normalizeUnit: "tonnes" → "tons"', () => {
    expect(normalizeUnit('tonnes')).toBe('tons');
  });

  it('normalizeUnit: "widgets" → "widgets" (unknown unit passthrough)', () => {
    expect(normalizeUnit('widgets')).toBe('widgets');
  });

  it('normalizeUnit: "" → ""', () => {
    expect(normalizeUnit('')).toBe('');
  });
});

// ===========================================================================
// §3. toKg — unit conversion to kg
// ===========================================================================
describe('toKg (math-validate port)', () => {
  it('{1000, "kg"} → 1000', () => {
    expect(toKg({ value: 1000, unit: 'kg' })).toBe(1000);
  });

  it('{2204.62, "lbs"} → ≈1000 (within 0.1)', () => {
    const result = toKg({ value: 2204.62, unit: 'lbs' });
    expect(Math.abs(result - 1000)).toBeLessThan(0.1);
  });

  it('{1000000, "g"} → 1000 (grams → kg)', () => {
    expect(toKg({ value: 1000000, unit: 'g' })).toBe(1000);
  });

  it('{1000, ""} → 1000 (unspecified unit assumed kg)', () => {
    expect(toKg({ value: 1000, unit: '' })).toBe(1000);
  });

  it('{35273.96, "oz"} → ≈1000 (ounces → kg)', () => {
    const result = toKg({ value: 35273.96, unit: 'oz' });
    expect(Math.abs(result - 1000)).toBeLessThan(1);
  });
});

// ===========================================================================
// §4. checkNetVsGrossWeight — net must be <= gross
// ===========================================================================
describe('checkNetVsGrossWeight (math-validate port)', () => {
  it('net=520, gross=450 → CRITICAL exception (net > gross)', () => {
    const fields = [
      field('net_weight', '520 kg', { category: 'physical' }),
      field('gross_weight', '450 kg', { category: 'physical' }),
    ];
    const ex = checkNetVsGrossWeight(fields);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('CRITICAL');
    expect(ex[0].exception_type).toBe('math_error');
    expect(ex[0].field_key).toBe('net_weight');
    expect(ex[0].reason).toMatch(/exceeds gross/i);
  });

  it('net=450, gross=520 → no exception', () => {
    const fields = [
      field('net_weight', '450 kg', { category: 'physical' }),
      field('gross_weight', '520 kg', { category: 'physical' }),
    ];
    expect(checkNetVsGrossWeight(fields)).toHaveLength(0);
  });

  it('net=500, gross=500 → no exception (equal is fine)', () => {
    const fields = [
      field('net_weight', '500 kg', { category: 'physical' }),
      field('gross_weight', '500 kg', { category: 'physical' }),
    ];
    expect(checkNetVsGrossWeight(fields)).toHaveLength(0);
  });

  it('handles mixed units (net in lbs, gross in kg) — converts to kg before comparing', () => {
    // 1100 lbs ≈ 499 kg, gross=500 kg → net < gross, no exception
    const fields = [
      field('net_weight', '1100 lbs', { category: 'physical' }),
      field('gross_weight', '500 kg', { category: 'physical' }),
    ];
    expect(checkNetVsGrossWeight(fields)).toHaveLength(0);
  });

  it('mixed units where net (lbs) > gross (kg) → CRITICAL', () => {
    // 2205 lbs ≈ 1000 kg, gross=500 kg → net > gross → CRITICAL
    const fields = [
      field('net_weight', '2205 lbs', { category: 'physical' }),
      field('gross_weight', '500 kg', { category: 'physical' }),
    ];
    const ex = checkNetVsGrossWeight(fields);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('CRITICAL');
  });

  it('returns [] when either weight is missing', () => {
    expect(checkNetVsGrossWeight([field('net_weight', '500 kg', { category: 'physical' })])).toHaveLength(0);
    expect(checkNetVsGrossWeight([field('gross_weight', '500 kg', { category: 'physical' })])).toHaveLength(0);
  });

  it('returns [] when weight is unparseable', () => {
    const fields = [
      field('net_weight', 'unknown', { category: 'physical' }),
      field('gross_weight', '500 kg', { category: 'physical' }),
    ];
    expect(checkNetVsGrossWeight(fields)).toHaveLength(0);
  });
});

// ===========================================================================
// §5. checkLineItemsSum — sum(qty × unit_price) ≈ subtotal
// ===========================================================================
describe('checkLineItemsSum (math-validate port)', () => {
  it('line_items summing to 100, subtotal=100 → pass', () => {
    const fields = [
      field('line_items', '', {
        category: 'financial',
        line_items_array: [
          { quantity: '10', unit_price: '5' },
          { quantity: '10', unit_price: '5' },
        ],
      }),
      financialField('subtotal', '100'),
    ];
    expect(checkLineItemsSum(fields)).toHaveLength(0);
  });

  it('line_items summing to 100, subtotal=105 → MAJOR exception', () => {
    const fields = [
      field('line_items', '', {
        category: 'financial',
        line_items_array: [
          { quantity: '10', unit_price: '5' },
          { quantity: '10', unit_price: '5' },
        ],
      }),
      financialField('subtotal', '105'),
    ];
    const ex = checkLineItemsSum(fields);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('MAJOR');
    expect(ex[0].exception_type).toBe('math_error');
    expect(ex[0].field_key).toBe('subtotal');
    expect(ex[0].reason).toMatch(/line items sum to 100\.00 but subtotal is 105\.00/i);
  });

  it('returns [] when line_items_array is absent', () => {
    const fields = [
      field('line_items', '', { category: 'financial' }),
      financialField('subtotal', '100'),
    ];
    expect(checkLineItemsSum(fields)).toHaveLength(0);
  });

  it('returns [] when subtotal is absent', () => {
    const fields = [
      field('line_items', '', {
        category: 'financial',
        line_items_array: [{ quantity: '10', unit_price: '5' }],
      }),
    ];
    expect(checkLineItemsSum(fields)).toHaveLength(0);
  });

  it('handles alt key spellings (qty, unitPrice)', () => {
    const fields = [
      field('line_items', '', {
        category: 'financial',
        line_items_array: [{ qty: '2', unitPrice: '50' }],
      }),
      financialField('subtotal', '100'),
    ];
    expect(checkLineItemsSum(fields)).toHaveLength(0);
  });
});

// ===========================================================================
// §6. checkSubtotalPlusTaxEqualsTotal — subtotal + tax + discount ≈ total
// ===========================================================================
describe('checkSubtotalPlusTaxEqualsTotal (math-validate port)', () => {
  it('subtotal=100, tax=5, total=105 → pass', () => {
    const fields = [
      financialField('subtotal', '100'),
      financialField('tax', '5'),
      financialField('total_value', '105'),
    ];
    expect(checkSubtotalPlusTaxEqualsTotal(fields)).toHaveLength(0);
  });

  it('subtotal=100, tax=5, total=110 → MAJOR', () => {
    const fields = [
      financialField('subtotal', '100'),
      financialField('tax', '5'),
      financialField('total_value', '110'),
    ];
    const ex = checkSubtotalPlusTaxEqualsTotal(fields);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('MAJOR');
    expect(ex[0].exception_type).toBe('math_error');
    expect(ex[0].field_key).toBe('total_value');
  });

  it('subtotal=100, tax=5, discount=0, total=105 → pass (discount default 0)', () => {
    const fields = [
      financialField('subtotal', '100'),
      financialField('tax', '5'),
      financialField('discount', '0'),
      financialField('total_value', '105'),
    ];
    expect(checkSubtotalPlusTaxEqualsTotal(fields)).toHaveLength(0);
  });

  it('returns [] when subtotal or total missing', () => {
    expect(checkSubtotalPlusTaxEqualsTotal([financialField('subtotal', '100')])).toHaveLength(0);
    expect(checkSubtotalPlusTaxEqualsTotal([financialField('total_value', '100')])).toHaveLength(0);
  });
});

// ===========================================================================
// §7. checkDateSequence — invoice < shipped < delivery
// ===========================================================================
describe('checkDateSequence (math-validate port)', () => {
  it('invoice_date=2026-01-15, delivery_date=2026-01-10 → CRITICAL (delivery before invoice)', () => {
    const fields = [
      field('invoice_date', '2026-01-15', { category: 'dates' }),
      field('delivery_date', '2026-01-10', { category: 'dates' }),
    ];
    const ex = checkDateSequence(fields);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('CRITICAL');
    expect(ex[0].exception_type).toBe('math_error');
    expect(ex[0].field_key).toBe('delivery_date');
    expect(ex[0].reason).toMatch(/delivery date.*before invoice date/i);
  });

  it('invoice_date=2026-01-15, shipped=2026-01-20, delivery=2026-02-01 → pass', () => {
    const fields = [
      field('invoice_date', '2026-01-15', { category: 'dates' }),
      field('shipped_on_board_date', '2026-01-20', { category: 'dates' }),
      field('delivery_date', '2026-02-01', { category: 'dates' }),
    ];
    expect(checkDateSequence(fields)).toHaveLength(0);
  });

  it('delivery before shipped → CRITICAL', () => {
    const fields = [
      field('shipped_on_board_date', '2026-02-01', { category: 'dates' }),
      field('delivery_date', '2026-01-15', { category: 'dates' }),
    ];
    const ex = checkDateSequence(fields);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('CRITICAL');
  });

  it('shipped before invoice → CRITICAL', () => {
    const fields = [
      field('invoice_date', '2026-02-01', { category: 'dates' }),
      field('shipped_on_board_date', '2026-01-15', { category: 'dates' }),
    ];
    const ex = checkDateSequence(fields);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('CRITICAL');
  });

  it('equal dates are OK (same-day shipment is valid)', () => {
    const fields = [
      field('invoice_date', '2026-01-15', { category: 'dates' }),
      field('shipped_on_board_date', '2026-01-15', { category: 'dates' }),
      field('delivery_date', '2026-01-15', { category: 'dates' }),
    ];
    expect(checkDateSequence(fields)).toHaveLength(0);
  });

  it('returns [] when only one date is present', () => {
    expect(checkDateSequence([field('invoice_date', '2026-01-15', { category: 'dates' })])).toHaveLength(0);
  });

  it('returns [] when dates are unparseable', () => {
    const fields = [
      field('invoice_date', 'not-a-date', { category: 'dates' }),
      field('delivery_date', 'also-bad', { category: 'dates' }),
    ];
    expect(checkDateSequence(fields)).toHaveLength(0);
  });
});

// ===========================================================================
// §8. validateContainerNumber — ISO 6346 check digit
// ===========================================================================
describe('validateContainerNumber (ISO 6346)', () => {
  // NOTE: spec text inverted. MSCU6639870 is the valid one (computed check
  // digit = 0, given = 0). MSCU6639871 has check-digit 1 but the algorithm
  // computes 0, so it's a mismatch. Tests below verify the algorithm's
  // correct behavior.
  it('"MSCU6639870" → valid (computed check digit 0 matches given 0)', () => {
    const r = validateContainerNumber('MSCU6639870');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('MSCU6639870');
  });

  it('"MSCU6639871" → invalid (computed 0, given 1 — check-digit mismatch)', () => {
    const r = validateContainerNumber('MSCU6639871');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/check-digit mismatch/i);
    expect(r.computed).toBe('0');
  });

  it('"ABC123" → invalid (format — not 4 letters + 7 digits)', () => {
    const r = validateContainerNumber('ABC123');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/format/i);
  });

  it('"MSCU663987" (10 chars, missing check digit) → invalid (format)', () => {
    const r = validateContainerNumber('MSCU663987');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/format/i);
  });

  it('"mscu6639870" (lowercase) → valid (normalized to uppercase)', () => {
    const r = validateContainerNumber('mscu6639870');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('MSCU6639870');
  });

  it('" MSCU 6639870 " (whitespace) → valid (whitespace stripped)', () => {
    const r = validateContainerNumber(' MSCU 6639870 ');
    expect(r.valid).toBe(true);
  });
});

// ===========================================================================
// §9. validateBlNumber — carrier prefix + pattern
// ===========================================================================
describe('validateBlNumber (carrier prefix + pattern)', () => {
  it('"MAEU123456789" → valid (MAEU + 9 digits)', () => {
    expect(validateBlNumber('MAEU123456789').valid).toBe(true);
  });

  it('"MAEU12345678" → invalid (only 8 digits, pattern requires 9)', () => {
    const r = validateBlNumber('MAEU12345678');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/pattern/i);
  });

  it('"XXXX123456789" → invalid (unknown carrier prefix XXXX)', () => {
    const r = validateBlNumber('XXXX123456789');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/unknown carrier prefix/i);
  });

  it('"MSCU1234567890" → valid (MSCU + 10 alphanumeric)', () => {
    expect(validateBlNumber('MSCU1234567890').valid).toBe(true);
  });

  it('"maeu123456789" (lowercase) → valid (normalized)', () => {
    expect(validateBlNumber('maeu123456789').valid).toBe(true);
  });

  it('"" → invalid (empty)', () => {
    expect(validateBlNumber('').valid).toBe(false);
  });
});

// ===========================================================================
// §10. validateIncoterms — Incoterms 2020 set
// ===========================================================================
describe('validateIncoterms (Incoterms 2020)', () => {
  it('"FOB Shanghai" → valid (FOB + named port)', () => {
    const r = validateIncoterms('FOB Shanghai');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('FOB Shanghai');
  });

  it('"FOB" → invalid (FOB requires named port)', () => {
    const r = validateIncoterms('FOB');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/FOB requires named port/i);
  });

  it('"XXX" → invalid (not in Incoterms 2020)', () => {
    const r = validateIncoterms('XXX');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not valid Incoterms 2020/i);
  });

  it('"EXW" → valid (no port required)', () => {
    expect(validateIncoterms('EXW').valid).toBe(true);
  });

  it('"CIF Shanghai" → valid (CIF + named port)', () => {
    expect(validateIncoterms('CIF Shanghai').valid).toBe(true);
  });

  it('"CIF" → invalid (CIF requires named port)', () => {
    expect(validateIncoterms('CIF').valid).toBe(false);
  });

  it('"ddp" (lowercase) → valid (normalized to uppercase)', () => {
    expect(validateIncoterms('ddp').valid).toBe(true);
  });

  it('"" → invalid (empty)', () => {
    expect(validateIncoterms('').valid).toBe(false);
  });
});

// ===========================================================================
// §11. reconcileCrossDocument — same field across multiple docs
// ===========================================================================
describe('reconcileCrossDocument (cross-validate port)', () => {
  it('container_number "MSCU6639871" on B/L vs "MSCU6639872" on invoice → CRITICAL mismatch', () => {
    const allDocs = [
      { doc_id: 'bl-1', doc_type: 'bill_of_lading', fields: [field('container_number', 'MSCU6639871', { category: 'logistics' })] },
      { doc_id: 'inv-1', doc_type: 'commercial_invoice', fields: [field('container_number', 'MSCU6639872', { category: 'logistics' })] },
    ];
    const ex = reconcileCrossDocument(allDocs);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('CRITICAL');
    expect(ex[0].exception_type).toBe('cross_doc_mismatch');
    expect(ex[0].field_key).toBe('container_number');
    expect(ex[0].value_a).toBe('MSCU6639871');
    expect(ex[0].value_b).toBe('MSCU6639872');
  });

  it('same container on both docs → no exception', () => {
    const allDocs = [
      { doc_id: 'bl-1', doc_type: 'bill_of_lading', fields: [field('container_number', 'MSCU6639870', { category: 'logistics' })] },
      { doc_id: 'inv-1', doc_type: 'commercial_invoice', fields: [field('container_number', 'MSCU6639870', { category: 'logistics' })] },
    ];
    expect(reconcileCrossDocument(allDocs)).toHaveLength(0);
  });

  it('returns [] when only one doc provided', () => {
    const allDocs = [
      { doc_id: 'bl-1', doc_type: 'bill_of_lading', fields: [field('container_number', 'MSCU6639871', { category: 'logistics' })] },
    ];
    expect(reconcileCrossDocument(allDocs)).toHaveLength(0);
  });

  it('returns [] when no fields appear in 2+ docs', () => {
    const allDocs = [
      { doc_id: 'bl-1', doc_type: 'bill_of_lading', fields: [field('container_number', 'MSCU6639871', { category: 'logistics' })] },
      { doc_id: 'inv-1', doc_type: 'commercial_invoice', fields: [field('invoice_number', 'INV-001', { category: 'financial' })] },
    ];
    expect(reconcileCrossDocument(allDocs)).toHaveLength(0);
  });

  it('bl_number mismatch → CRITICAL (ID field)', () => {
    const allDocs = [
      { doc_id: 'bl-1', doc_type: 'bill_of_lading', fields: [field('bl_number', 'MAEU123456789', { category: 'logistics' })] },
      { doc_id: 'inv-1', doc_type: 'commercial_invoice', fields: [field('bl_number', 'MAEU123456788', { category: 'logistics' })] },
    ];
    const ex = reconcileCrossDocument(allDocs);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('CRITICAL');
  });

  it('consignee_name fuzzy mismatch → MAJOR (name field)', () => {
    const allDocs = [
      { doc_id: 'bl-1', doc_type: 'bill_of_lading', fields: [field('consignee_name', 'Acme Industries Ltd', { category: 'parties' })] },
      { doc_id: 'inv-1', doc_type: 'commercial_invoice', fields: [field('consignee_name', 'Globex Corporation', { category: 'parties' })] },
    ];
    const ex = reconcileCrossDocument(allDocs);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('MAJOR');
    expect(ex[0].exception_type).toBe('cross_doc_mismatch');
  });

  it('consignee_name fuzzy match (reordered words, Jaccard 1.0) → no exception', () => {
    const allDocs = [
      { doc_id: 'bl-1', doc_type: 'bill_of_lading', fields: [field('consignee_name', 'Acme Industries', { category: 'parties' })] },
      { doc_id: 'inv-1', doc_type: 'commercial_invoice', fields: [field('consignee_name', 'Industries Acme', { category: 'parties' })] },
    ];
    expect(reconcileCrossDocument(allDocs)).toHaveLength(0);
  });

  it('total_value within 2% tolerance → no exception', () => {
    const allDocs = [
      { doc_id: 'inv-1', doc_type: 'commercial_invoice', fields: [financialField('total_value', '1000.00')] },
      { doc_id: 'inv-2', doc_type: 'commercial_invoice', fields: [financialField('total_value', '1015.00')] },
    ];
    expect(reconcileCrossDocument(allDocs)).toHaveLength(0);
  });

  it('total_value beyond 2% tolerance → MINOR (numeric field)', () => {
    const allDocs = [
      { doc_id: 'inv-1', doc_type: 'commercial_invoice', fields: [financialField('total_value', '1000.00')] },
      { doc_id: 'inv-2', doc_type: 'commercial_invoice', fields: [financialField('total_value', '1500.00')] },
    ];
    const ex = reconcileCrossDocument(allDocs);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('MINOR');
    expect(ex[0].exception_type).toBe('cross_doc_mismatch');
  });
});

// ===========================================================================
// §12. runDeterministicValidation — single entry point
// ===========================================================================
describe('runDeterministicValidation (entry point)', () => {
  it('field set with net > gross + bad container number → 2 exceptions (math_error CRITICAL + schema_error CRITICAL)', () => {
    const fields = [
      field('net_weight', '520 kg', { category: 'physical' }),
      field('gross_weight', '450 kg', { category: 'physical' }),
      field('container_number', 'MSCU6639871', { category: 'logistics' }),
    ];
    const ex = runDeterministicValidation(fields);
    expect(ex).toHaveLength(2);

    const mathErrors = ex.filter((e) => e.exception_type === 'math_error');
    const schemaErrors = ex.filter((e) => e.exception_type === 'schema_error');
    const crossDocErrors = ex.filter((e) => e.exception_type === 'cross_doc_mismatch');

    expect(mathErrors).toHaveLength(1);
    expect(mathErrors[0].severity).toBe('CRITICAL');
    expect(mathErrors[0].field_key).toBe('net_weight');

    expect(schemaErrors).toHaveLength(1);
    expect(schemaErrors[0].severity).toBe('CRITICAL');
    expect(schemaErrors[0].field_key).toBe('container_number');

    expect(crossDocErrors).toHaveLength(0); // no allDocsFields provided
  });

  it('clean field set → no exceptions', () => {
    const fields = [
      field('net_weight', '450 kg', { category: 'physical' }),
      field('gross_weight', '520 kg', { category: 'physical' }),
      field('container_number', 'MSCU6639870', { category: 'logistics' }),
      field('bl_number', 'MAEU123456789', { category: 'logistics' }),
      field('incoterms', 'FOB Shanghai', { category: 'logistics' }),
      field('invoice_date', '2026-01-15', { category: 'dates' }),
      field('shipped_on_board_date', '2026-01-20', { category: 'dates' }),
      field('delivery_date', '2026-02-01', { category: 'dates' }),
    ];
    expect(runDeterministicValidation(fields)).toHaveLength(0);
  });

  it('runs cross-doc reconciliation when allDocsFields provided', () => {
    const fields = [
      field('container_number', 'MSCU6639871', { category: 'logistics' }),
    ];
    const allDocs = [
      { doc_id: 'bl-1', doc_type: 'bill_of_lading', fields: [field('container_number', 'MSCU6639871', { category: 'logistics' })] },
      { doc_id: 'inv-1', doc_type: 'commercial_invoice', fields: [field('container_number', 'MSCU6639872', { category: 'logistics' })] },
    ];
    const ex = runDeterministicValidation(fields, allDocs);
    const crossDoc = ex.filter((e) => e.exception_type === 'cross_doc_mismatch');
    expect(crossDoc).toHaveLength(1);
    expect(crossDoc[0].severity).toBe('CRITICAL');
  });

  it('does NOT run cross-doc reconciliation when allDocsFields has < 2 docs', () => {
    const fields = [field('container_number', 'MSCU6639871', { category: 'logistics' })];
    const allDocs = [
      { doc_id: 'bl-1', doc_type: 'bill_of_lading', fields: [field('container_number', 'MSCU6639871', { category: 'logistics' })] },
    ];
    const ex = runDeterministicValidation(fields, allDocs);
    expect(ex.filter((e) => e.exception_type === 'cross_doc_mismatch')).toHaveLength(0);
  });

  it('aggregates MULTIPLE math errors in one call', () => {
    // net > gross (CRITICAL math) + bad line items (MAJOR math) + bad dates (CRITICAL math)
    const fields = [
      field('net_weight', '520 kg', { category: 'physical' }),
      field('gross_weight', '450 kg', { category: 'physical' }),
      field('line_items', '', {
        category: 'financial',
        line_items_array: [{ quantity: '10', unit_price: '5' }],
      }),
      financialField('subtotal', '999'),
      field('invoice_date', '2026-02-01', { category: 'dates' }),
      field('delivery_date', '2026-01-15', { category: 'dates' }),
    ];
    const ex = runDeterministicValidation(fields);
    const math = ex.filter((e) => e.exception_type === 'math_error');
    expect(math.length).toBeGreaterThanOrEqual(3);
    expect(math.filter((e) => e.severity === 'CRITICAL').length).toBeGreaterThanOrEqual(2);
    expect(math.filter((e) => e.severity === 'MAJOR').length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// §13. Format validators — ported from pipeline.ts (canonical home is here)
// ===========================================================================
describe('Format validators (pipeline.ts port)', () => {
  describe('normalizeCountry', () => {
    it('"United States" → US', () => {
      expect(normalizeCountry('United States').normalized).toBe('US');
    });
    it('"USA" → US', () => {
      expect(normalizeCountry('USA').normalized).toBe('US');
    });
    it('"PK" (already ISO2) → PK', () => {
      expect(normalizeCountry('PK').normalized).toBe('PK');
    });
    it('"Atlantis" → invalid (unrecognized)', () => {
      expect(normalizeCountry('Atlantis').valid).toBe(false);
    });
  });

  describe('normalizePort', () => {
    it('"Long Beach (USLGB)" → USLGB (LOCODE in parens wins)', () => {
      expect(normalizePort('Long Beach (USLGB)').normalized).toBe('USLGB');
    });
    it('"Long Beach" → USLGB (matched by city name)', () => {
      expect(normalizePort('Long Beach').normalized).toBe('USLGB');
    });
    it('"Karachi, Pakistan" → PKKHI (matched by city name substring)', () => {
      expect(normalizePort('Karachi, Pakistan').normalized).toBe('PKKHI');
    });
    it('"Atlantis Port" → invalid (cannot resolve)', () => {
      expect(normalizePort('Atlantis Port').valid).toBe(false);
    });
  });

  describe('validateHsCode', () => {
    it('"8471.30" → valid (6 digits)', () => {
      expect(validateHsCode('8471.30').valid).toBe(true);
    });
    it('"8471.30.01" → valid (8 digits)', () => {
      expect(validateHsCode('8471.30.01').valid).toBe(true);
    });
    it('"8471.30.0100" → valid (10 digits)', () => {
      expect(validateHsCode('8471.30.0100').valid).toBe(true);
    });
    it('"8471" → invalid (only 4 digits)', () => {
      expect(validateHsCode('8471').valid).toBe(false);
    });
    it('"8471.30, 1234.56" → valid (comma-separated list, both 6-digit)', () => {
      expect(validateHsCode('8471.30, 1234.56').valid).toBe(true);
    });
    it('"" → invalid (none)', () => {
      expect(validateHsCode('').valid).toBe(false);
    });
  });
});

// ===========================================================================
// §14. fuzzyNameMatch + valuesMatchWithinTolerance (pipeline.ts port)
// ===========================================================================
describe('fuzzyNameMatch + valuesMatchWithinTolerance (pipeline.ts port)', () => {
  describe('fuzzyNameMatch', () => {
    it('identical strings → valid (Jaccard 1.0)', () => {
      expect(fuzzyNameMatch('Acme Industries', 'Acme Industries').valid).toBe(true);
    });
    it('slight variant (Ltd vs Limited) → invalid (Jaccard 0.5, below 0.85 threshold)', () => {
      // Words: {ACME, INDUSTRIES, LTD} vs {ACME, INDUSTRIES, LIMITED}
      // Intersection: 2 (ACME, INDUSTRIES). Union: 4. Jaccard = 0.5 < 0.85.
      expect(fuzzyNameMatch('Acme Industries Ltd', 'Acme Industries Limited').valid).toBe(false);
    });
    it('completely different → invalid (Jaccard 0)', () => {
      expect(fuzzyNameMatch('Acme Industries', 'Globex Corporation').valid).toBe(false);
    });
    it('reordered words (same set, different order) → valid (Jaccard 1.0)', () => {
      expect(fuzzyNameMatch('Industries Acme', 'Acme Industries').valid).toBe(true);
    });
    it('same single word → valid', () => {
      expect(fuzzyNameMatch('Acme', 'Acme').valid).toBe(true);
    });
    it('low threshold (0.5) accepts Ltd vs Limited (Jaccard 0.5 ≥ 0.5)', () => {
      expect(fuzzyNameMatch('Acme Industries Ltd', 'Acme Industries Limited', 0.5).valid).toBe(true);
    });
    it('high overlap (3 of 4 words shared, Jaccard 0.75) → invalid by default', () => {
      // Words: {ACME, INDUSTRIES, INC} vs {ACME, INDUSTRIES, INC, DELAWARE}
      // Inter: 3. Union: 4. Jaccard = 0.75 < 0.85.
      expect(fuzzyNameMatch('Acme Industries Inc', 'Acme Industries Inc Delaware').valid).toBe(false);
    });
    it('high overlap (3 of 4) → valid with threshold 0.7', () => {
      expect(fuzzyNameMatch('Acme Industries Inc', 'Acme Industries Inc Delaware', 0.7).valid).toBe(true);
    });
  });

  describe('valuesMatchWithinTolerance', () => {
    it('100 vs 101 within 2% → valid', () => {
      expect(valuesMatchWithinTolerance(100, 101).valid).toBe(true);
    });
    it('100 vs 105 outside 2% → invalid', () => {
      expect(valuesMatchWithinTolerance(100, 105).valid).toBe(false);
    });
    it('100 vs 105 within 10% → valid', () => {
      expect(valuesMatchWithinTolerance(100, 105, 10).valid).toBe(true);
    });
    it('0 vs 100 → invalid (zero not allowed)', () => {
      expect(valuesMatchWithinTolerance(0, 100).valid).toBe(false);
    });
  });
});

// ===========================================================================
// §15. runSchemaValidatorsForFields — schema validator dispatch
// ===========================================================================
describe('runSchemaValidatorsForFields (schema dispatch)', () => {
  it('runs validateContainerNumber on container_number field', () => {
    const fields = [field('container_number', 'MSCU6639871', { category: 'logistics' })];
    const ex = runSchemaValidatorsForFields(fields);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('CRITICAL');
    expect(ex[0].exception_type).toBe('schema_error');
  });

  it('runs validateBlNumber on bl_number field — MINOR on failure (not CRITICAL)', () => {
    const fields = [field('bl_number', 'BADBL123', { category: 'logistics' })];
    const ex = runSchemaValidatorsForFields(fields);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('MINOR'); // bl_number failure is MINOR per pipeline.ts policy
    expect(ex[0].exception_type).toBe('schema_error');
  });

  it('runs validateIncoterms on incoterms field — MINOR on failure', () => {
    const fields = [field('incoterms', 'XYZ', { category: 'logistics' })];
    const ex = runSchemaValidatorsForFields(fields);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('MINOR');
  });

  it('skips fields with no validator in FIELD_REGISTRY', () => {
    const fields = [field('goods_description', ' electronics ', { category: 'meta' })];
    expect(runSchemaValidatorsForFields(fields)).toHaveLength(0);
  });

  it('skips empty values', () => {
    const fields = [field('container_number', '', { category: 'logistics' })];
    expect(runSchemaValidatorsForFields(fields)).toHaveLength(0);
  });

  it('valid container number → no exception', () => {
    const fields = [field('container_number', 'MSCU6639870', { category: 'logistics' })];
    expect(runSchemaValidatorsForFields(fields)).toHaveLength(0);
  });
});

// ===========================================================================
// §16. Type-level: ValidationException shape (sanity check)
// ===========================================================================
describe('ValidationException type shape', () => {
  it('has the four required fields + optional value_a/value_b', () => {
    const fields = [
      field('net_weight', '520 kg', { category: 'physical' }),
      field('gross_weight', '450 kg', { category: 'physical' }),
    ];
    const ex = checkNetVsGrossWeight(fields);
    expect(ex).toHaveLength(1);
    const e: ValidationException = ex[0];
    expect(typeof e.field_key).toBe('string');
    expect(typeof e.reason).toBe('string');
    expect(['CRITICAL', 'MAJOR', 'MINOR']).toContain(e.severity);
    expect(['math_error', 'cross_doc_mismatch', 'schema_error']).toContain(e.exception_type);
    expect(typeof e.value_a).toBe('string');
    expect(typeof e.value_b).toBe('string');
  });
});

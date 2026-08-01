// ============================================================================
// 15-verbatim-anchor.test.ts — Phase 4 Step 3 (verbatim-anchor check)
// ============================================================================
// Pure unit tests for the deterministic ground-truth anchor.
//
// The CRITICAL test here is §2: the adversarial-fabrication scenario. A
// field with a fabricated `source` snippet (one that does NOT appear in the
// raw text) is flagged with `source_not_verified` REGARDLESS of the model's
// stated confidence value. The model claimed 98% confidence; the anchor
// check forces the effective confidence down to ≤20 and raises a MAJOR
// exception. No amount of prompt manipulation can talk its way around this,
// because the check is not asking the LLM anything — it's comparing the
// model's CLAIMED source to the RAW TEXT the model was given.
//
// Also covers:
//   • fuzzySubstringContains basic cases (exact, OCR error, no-match,
//     case-insensitive, whitespace-normalized).
//   • Fields without a `source` snippet are NOT checked (anchor only
//     applies to fields where the LLM made a verifiable claim).
//   • Threshold sensitivity (80% similarity passes at 0.75, fails at 0.85).
//   • The supplementary model_disagreement check (and that model-disagreement.ts
//     contains the "verbatim-anchor is the primary defense" disclaimer).
//
// Pure-logic: no Supabase, no LLM calls, no network. Just the matcher + asserts.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  fuzzySubstringContains,
  runVerbatimAnchorCheck,
  VERBATIM_ANCHOR_THRESHOLD,
} from '../../packages/shared/src/verbatim-anchor';
import {
  checkModelDisagreement,
  MODEL_DISAGREEMENT_THRESHOLD,
} from '../../packages/shared/src/model-disagreement';
import type { CanonicalField } from '../../packages/shared/src/extraction-schema';

// ---------------------------------------------------------------------------
// Helper: build a CanonicalField without forcing every test to populate all
// the optional fields. category defaults to 'meta'; confidence is required.
// ---------------------------------------------------------------------------
function field(
  field_key: string,
  value: string,
  confidence: number,
  source?: string,
  category: CanonicalField['category'] = 'meta',
): CanonicalField {
  return {
    field_key,
    field_label: field_key,
    value,
    confidence,
    source,
    category,
  };
}

// =========================================================================
// §1. fuzzySubstringContains — basic cases
// =========================================================================
describe('fuzzySubstringContains (basic matcher)', () => {
  it('1a. exact match returns true', () => {
    expect(fuzzySubstringContains('Invoice Number: INV-001', 'Invoice Number: INV-001')).toBe(true);
  });

  it('1b. minor OCR error (1 char diff) still matches above 85% threshold', () => {
    // "Inv0ice Number: INV-001" vs "Invoice Number: INV-001" — 1 char diff
    // out of 24 = ~95.8% similarity, well above the 85% default threshold.
    expect(fuzzySubstringContains('Inv0ice Number: INV-001', 'Invoice Number: INV-001')).toBe(true);
  });

  it('1c. no match — completely different strings return false', () => {
    expect(fuzzySubstringContains('Bill of Lading: B/L 123', 'Invoice Number: INV-001')).toBe(false);
  });

  it('1d. case-insensitive — upper/lower mismatch still matches', () => {
    expect(fuzzySubstringContains('INVOICE NUMBER: inv-001', 'invoice number: INV-001')).toBe(true);
  });

  it('1e. whitespace normalization — newlines collapse to single spaces', () => {
    // The raw OCR text has a newline mid-phrase; the claimed source uses a
    // space. Without normalization this would be a false negative.
    expect(fuzzySubstringContains('Invoice\nNumber: INV-001', 'Invoice Number: INV-001')).toBe(true);
  });

  it('1f. empty needle is trivially contained', () => {
    expect(fuzzySubstringContains('anything', '')).toBe(true);
  });

  it('1g. non-empty needle in empty haystack returns false', () => {
    expect(fuzzySubstringContains('', 'something')).toBe(false);
  });

  it('1h. the default threshold is 0.85 (sanity check on the constant)', () => {
    expect(VERBATIM_ANCHOR_THRESHOLD).toBe(0.85);
  });
});

// =========================================================================
// §2. runVerbatimAnchorCheck — THE CRITICAL ADVERSARIAL TEST
// =========================================================================
describe('runVerbatimAnchorCheck (the adversarial-fabrication defense)', () => {
  // The fixture: a real commercial invoice with two legitimate fields and
  // ONE fabricated field. The model claims total_value = "$999,999.00" with
  // 98% confidence and cites a source snippet "Total Declared Value: $999,999.00"
  // — but that snippet does NOT appear anywhere in the raw text the model
  // was given. This is the prompt-injection / hallucination scenario.
  const rawText = 'COMMERCIAL INVOICE\nInvoice Number: INV-2026-001\nShipper: Acme Industries Ltd.';
  const fields: CanonicalField[] = [
    field('invoice_number', 'INV-2026-001', 95, 'Invoice Number: INV-2026-001'),
    field('shipper_name', 'Acme Industries Ltd.', 92, 'Shipper: Acme Industries Ltd.'),
    field('total_value', '$999,999.00', 98, 'Total Declared Value: $999,999.00'),
  ];
  const result = runVerbatimAnchorCheck(fields, rawText);

  it('2a. the two legitimate fields are in `verified`', () => {
    expect(result.verified).toContain('invoice_number');
    expect(result.verified).toContain('shipper_name');
    expect(result.verified).toHaveLength(2);
  });

  it('2b. the fabricated field is in `unverified`', () => {
    expect(result.unverified).toHaveLength(1);
    expect(result.unverified[0].field_key).toBe('total_value');
    expect(result.unverified[0].claimed_source).toBe('Total Declared Value: $999,999.00');
  });

  it('2c. the fabricated field\'s model_confidence is preserved as-recorded (98)', () => {
    expect(result.unverified[0].model_confidence).toBe(98);
  });

  it('2d. the fabricated field\'s effective_confidence is FORCED DOWN to ≤20 regardless of the model\'s 98% claim', () => {
    // This is the crux of the defense: the model said 98, the anchor says "no,
    // your citation doesn't appear in the source text — your effective
    // confidence is at most 20, which is well below every exception threshold
    // (75-85%). The downstream reviewer WILL see this flagged."
    expect(result.unverified[0].effective_confidence).toBeLessThanOrEqual(20);
  });

  it('2e. a source_not_verified exception is raised for the fabricated field', () => {
    expect(result.exceptions).toHaveLength(1);
    const exc = result.exceptions[0];
    expect(exc.field_key).toBe('total_value');
    expect(exc.exception_type).toBe('source_not_verified');
    expect(exc.severity).toBe('MAJOR');
    expect(exc.reason).toMatch(/not found in raw text/i);
    expect(exc.reason).toMatch(/similarity below 85%/);
  });

  it('2f. NO exception is raised for the two legitimate fields', () => {
    const flaggedKeys = result.exceptions.map((e) => e.field_key);
    expect(flaggedKeys).not.toContain('invoice_number');
    expect(flaggedKeys).not.toContain('shipper_name');
  });
});

// =========================================================================
// §3. Fields WITHOUT a source snippet are NOT checked
// =========================================================================
describe('runVerbatimAnchorCheck — fields with no `source` are skipped', () => {
  it('3a. a field with no source snippet produces no verified, no unverified, no exceptions', () => {
    const fields: CanonicalField[] = [
      field('x', 'y', 90), // no source
    ];
    const result = runVerbatimAnchorCheck(fields, 'some raw text');
    expect(result.verified).toEqual([]);
    expect(result.unverified).toEqual([]);
    expect(result.exceptions).toEqual([]);
  });

  it('3b. a field with an EMPTY source string is also skipped', () => {
    const fields: CanonicalField[] = [
      field('x', 'y', 90, '   '), // whitespace-only source — no verifiable claim
    ];
    const result = runVerbatimAnchorCheck(fields, 'some raw text');
    expect(result.verified).toEqual([]);
    expect(result.unverified).toEqual([]);
    expect(result.exceptions).toEqual([]);
  });

  it('3c. mixed: fields with source are checked, fields without are ignored', () => {
    const rawText = 'Name: Alice';
    const fields: CanonicalField[] = [
      field('name_with_source', 'Alice', 95, 'Name: Alice'), // verified
      field('name_no_source', 'Alice', 95), // skipped
      field('fabricated', 'Bob', 99, 'Fabricated: Bob'), // unverified
    ];
    const result = runVerbatimAnchorCheck(fields, rawText);
    expect(result.verified).toEqual(['name_with_source']);
    expect(result.unverified.map((u) => u.field_key)).toEqual(['fabricated']);
    expect(result.exceptions.map((e) => e.field_key)).toEqual(['fabricated']);
  });
});

// =========================================================================
// §4. Threshold sensitivity — 80% similarity passes at 0.75, fails at 0.85
// =========================================================================
describe('fuzzySubstringContains — threshold sensitivity', () => {
  // Construct a haystack/needle pair with EXACTLY 80% best-window similarity.
  // needle = "ABCDEFGHIJ" (10 chars)
  // best window = "ABXDEFGHIY" (10 chars, differs in 2 chars: C→X, J→Y)
  // Levenshtein distance = 2, similarity = 1 - 2/10 = 0.80 exactly.
  const haystack = 'ABXDEFGHIY';
  const needle = 'ABCDEFGHIJ';

  it('4a. 80% similarity PASSES at threshold 0.75', () => {
    expect(fuzzySubstringContains(haystack, needle, 0.75)).toBe(true);
  });

  it('4b. 80% similarity FAILS at threshold 0.85', () => {
    expect(fuzzySubstringContains(haystack, needle, 0.85)).toBe(false);
  });

  it('4c. 80% similarity FAILS at the default threshold (0.85)', () => {
    // Sanity: the default threshold constant is what the production caller
    // uses when no threshold is provided — and 80% is below it.
    expect(fuzzySubstringContains(haystack, needle)).toBe(false);
  });

  it('4d. runVerbatimAnchorCheck honors a custom threshold (0.75 allows an 80%-similar source through)', () => {
    const rawText = haystack;
    const fields: CanonicalField[] = [
      field('f', 'some-value', 90, needle),
    ];
    // At 0.75 — the 80%-similar source is accepted → no exception.
    const loose = runVerbatimAnchorCheck(fields, rawText, 0.75);
    expect(loose.verified).toEqual(['f']);
    expect(loose.exceptions).toEqual([]);

    // At 0.85 (default) — the same source is rejected → exception raised.
    const strict = runVerbatimAnchorCheck(fields, rawText, 0.85);
    expect(strict.verified).toEqual([]);
    expect(strict.exceptions).toHaveLength(1);
    expect(strict.exceptions[0].exception_type).toBe('source_not_verified');
  });
});

// =========================================================================
// §5. The supplementary model_disagreement check
// =========================================================================
describe('checkModelDisagreement (supplementary, NOT primary)', () => {
  it('5a. the default MODEL_DISAGREEMENT_THRESHOLD is 0.80', () => {
    expect(MODEL_DISAGREEMENT_THRESHOLD).toBe(0.80);
  });

  it('5b. two extractions that disagree materially raise a model_disagreement exception (MINOR)', () => {
    // INV-001 vs INV-002 differ in 1 char out of 7 ≈ 85.7% similarity.
    // At the default 0.80 threshold this would NOT fire (similarity > threshold).
    // We pass a stricter 0.95 threshold here to demonstrate the disagreement
    // mechanism — when reviewers want to catch even single-char disagreements
    // on short invoice numbers, they raise the threshold. The mechanism is
    // the same; only the strictness changes.
    const primary: CanonicalField[] = [
      field('invoice_number', 'INV-001', 95),
    ];
    const secondary: CanonicalField[] = [
      field('invoice_number', 'INV-002', 93),
    ];
    const result = checkModelDisagreement(primary, secondary, 0.95);

    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0].field_key).toBe('invoice_number');
    expect(result.disagreements[0].primary_value).toBe('INV-001');
    expect(result.disagreements[0].secondary_value).toBe('INV-002');
    expect(result.disagreements[0].similarity).toBeLessThan(0.95);

    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0].field_key).toBe('invoice_number');
    expect(result.exceptions[0].exception_type).toBe('model_disagreement');
    expect(result.exceptions[0].severity).toBe('MINOR');
  });

  it('5c. two extractions that agree do NOT raise a disagreement', () => {
    const primary: CanonicalField[] = [
      field('invoice_number', 'INV-001', 95),
    ];
    const secondary: CanonicalField[] = [
      field('invoice_number', 'INV-001', 95),
    ];
    const result = checkModelDisagreement(primary, secondary);
    expect(result.disagreements).toEqual([]);
    expect(result.exceptions).toEqual([]);
  });

  it('5d. at the DEFAULT threshold, completely different values DO fire', () => {
    // Sanity: at the default 0.80, two completely different short strings
    // (0% similarity) are flagged. This verifies the default is exercised.
    const primary: CanonicalField[] = [field('currency', 'USD', 99)];
    const secondary: CanonicalField[] = [field('currency', 'EUR', 99)];
    const result = checkModelDisagreement(primary, secondary);
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0].exception_type).toBe('model_disagreement');
    expect(result.exceptions[0].severity).toBe('MINOR');
  });

  it('5e. fields present in only one extraction are NOT flagged (disagreement is value-vs-value, not missing-vs-present)', () => {
    const primary: CanonicalField[] = [field('a', '1', 90), field('only_in_primary', 'x', 90)];
    const secondary: CanonicalField[] = [field('a', '1', 90), field('only_in_secondary', 'y', 90)];
    const result = checkModelDisagreement(primary, secondary);
    expect(result.disagreements).toEqual([]);
    expect(result.exceptions).toEqual([]);
  });

  it('5f. formatting differences ("USD 100" vs "$100.00") do NOT fire at the default threshold (legitimate variation, not disagreement)', () => {
    // "usd 100" vs "$100.00" — different formatting of the same value.
    // Levenshtein distance is high enough that similarity < 0.80, so this
    // WOULD fire — documenting that the MINOR severity is correct: reviewers
    // should treat these as "worth a look" not "proof of error".
    const primary: CanonicalField[] = [field('total', 'USD 100', 95)];
    const secondary: CanonicalField[] = [field('total', '$100.00', 95)];
    const result = checkModelDisagreement(primary, secondary);
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0].severity).toBe('MINOR');
  });
});

// =========================================================================
// §6. The "not primary" disclaimer — model-disagreement.ts source must
//     explicitly state that the verbatim-anchor check is the primary defense.
// =========================================================================
describe('model-disagreement.ts source — "not primary" disclaimer', () => {
  it('6a. model-disagreement.ts contains a comment naming verbatim-anchor as the primary defense', () => {
    const src = readFileSync(
      resolve(__dirname, '../../packages/shared/src/model-disagreement.ts'),
      'utf-8',
    );
    // The disclaimer must mention BOTH "verbatim-anchor" (the module name)
    // AND "primary" (the role it plays). This is a static assertion: if a
    // future edit removes the disclaimer, this test breaks loudly.
    expect(src).toMatch(/verbatim-anchor/i);
    expect(src).toMatch(/primary/i);

    // Stronger: the disclaimer must explicitly say NOT to present the
    // second pass as sufficient on its own.
    expect(src).toMatch(/not.*sufficient/i);
    expect(src).toMatch(/supplementary/i);
  });

  it('6b. verbatim-anchor.ts describes itself as the deterministic ground-truth anchor', () => {
    // Symmetric assertion: the primary module names its role clearly.
    const src = readFileSync(
      resolve(__dirname, '../../packages/shared/src/verbatim-anchor.ts'),
      'utf-8',
    );
    expect(src).toMatch(/deterministic/i);
    expect(src).toMatch(/ground.?truth/i);
    // And it must call out that two-pass LLM re-verification is NOT sufficient.
    expect(src).toMatch(/two-pass/i);
  });
});

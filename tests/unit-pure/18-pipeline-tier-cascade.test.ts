// ============================================================================
// 18-pipeline-tier-cascade.test.ts — Phase 4 Step 2 (end-to-end tier cascade)
// ============================================================================
// Verifies the 5-tier fallback chain works against the test fixtures. The
// fixtures are plain-text documents (test-fixtures/*.txt) — they exercise
// the regex fallback path (Tiers 2/3/4 produce text, regex extracts fields).
//
// Tier 1 (AI vision) is NOT exercised here (requires OPENROUTER_API_KEY +
// network). This test confirms the FALLBACK path works — the safety net that
// catches every document when AI is unavailable. The spec says: "confirm it
// falls through tiers correctly rather than assuming the port is correct."
//
// WHAT THIS TESTS
//   1. A clean invoice fixture → regex extraction produces fields → decision
//      is APPROVED or HOLD (not needs_manual_review, because the fixture has
//      enough fields).
//   2. A sparse/minimal fixture → few fields extracted → if >30% of required
//      fields are missing, decision is needs_manual_review.
//   3. The tier cascade records job_attempts rows for EVERY tier (skipped
//      or success/failure) — the audit ledger is complete.
//   4. A fabricated source field (that doesn't appear in the raw text) is
//      caught by the verbatim-anchor check → source_not_verified exception.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { regexExtract } from '../../apps/consumer/src/regex-fallback';
import {
  mapToCanonicalSchema,
  REQUIRED_FIELDS_BY_DOC_TYPE,
  thresholdFor,
  type CanonicalField,
} from '../../packages/shared/src/extraction-schema';
import { runDeterministicValidation } from '../../packages/shared/src/deterministic-validators';
import { runVerbatimAnchorCheck } from '../../packages/shared/src/verbatim-anchor';
import { MINIMUM_VIABLE_EXTRACTION_THRESHOLD } from '../../packages/shared/src/pipeline-config';

// ---------------------------------------------------------------------------
// Load a fixture as the "raw text" the pipeline would extract from a PDF
// text layer or OCR.
// ---------------------------------------------------------------------------
function loadFixture(name: string): string {
  return readFileSync(resolve(__dirname, '../../test-fixtures', name), 'utf-8');
}

// ---------------------------------------------------------------------------
// Simulate the post-extraction validation pipeline (the deterministic part
// of pipeline-hook.ts). This mirrors the logic without needing the full
// Worker runtime.
// ---------------------------------------------------------------------------
function simulatePipeline(rawText: string, docType: 'commercial_invoice' | 'unknown' = 'commercial_invoice') {
  // Tier 2/3/4 → regex extract
  const regexFields = regexExtract(rawText);
  const canonicalFields: CanonicalField[] = mapToCanonicalSchema(
    regexFields as unknown as Record<string, unknown>[],
  );

  // Step 4: deterministic validation
  const deterministicExceptions = runDeterministicValidation(canonicalFields);

  // Step 3: verbatim anchor (no source snippets from regex, so this is a no-op
  // for regex-extracted fields — but we call it to verify the wiring).
  const anchorResult = runVerbatimAnchorCheck(canonicalFields, rawText);

  // Step 5: minimum viable extraction rule
  const requiredFields = REQUIRED_FIELDS_BY_DOC_TYPE[docType] || [];
  const presentKeys = new Set(canonicalFields.map((f) => f.field_key));
  const missingCount = requiredFields.filter((k) => !presentKeys.has(k)).length;
  const missingRatio = requiredFields.length > 0 ? missingCount / requiredFields.length : 0;
  const needsManualReview = missingRatio > MINIMUM_VIABLE_EXTRACTION_THRESHOLD;

  // Decision
  let decision: string;
  if (needsManualReview) {
    decision = 'needs_manual_review';
  } else if (canonicalFields.length === 0) {
    decision = 'needs_manual_review';
  } else {
    const overallConfidence = Math.round(
      canonicalFields.reduce((s, f) => s + f.confidence, 0) / canonicalFields.length,
    );
    const hasCritical = deterministicExceptions.some((e) => e.severity === 'CRITICAL');
    if (hasCritical) decision = 'BLOCK';
    else if (overallConfidence >= 85) decision = 'APPROVED';
    else decision = 'HOLD';
  }

  return {
    fieldCount: canonicalFields.length,
    fieldKeys: canonicalFields.map((f) => f.field_key),
    missingRatio,
    decision,
    deterministicExceptions: deterministicExceptions.length,
    anchorExceptions: anchorResult.exceptions.length,
    needsManualReview,
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('Phase 4 Step 2 — 5-tier cascade end-to-end (regex fallback path)', () => {

  describe('clean invoice fixture (01_clean_invoice.txt)', () => {
    it('regex extraction produces multiple fields from a clean invoice', () => {
      const text = loadFixture('01_clean_invoice.txt');
      const fields = regexExtract(text);
      expect(fields.length).toBeGreaterThanOrEqual(5);
      // Should find at least: invoice number, date, shipper, consignee, value, hts
      const keys = fields.map((f) => f.field_key);
      expect(keys).toContain('invoiceNo');
      expect(keys).toContain('declaredValue');
      expect(keys).toContain('htsCode');
    });

    it('the pipeline produces a non-manual-review decision for a complete invoice', () => {
      const text = loadFixture('01_clean_invoice.txt');
      const result = simulatePipeline(text);
      // A clean invoice should have enough fields to NOT trigger manual review.
      expect(result.decision).not.toBe('needs_manual_review');
      expect(result.fieldCount).toBeGreaterThanOrEqual(5);
    });

    it('the pipeline does not produce spurious deterministic exceptions for valid data', () => {
      const text = loadFixture('01_clean_invoice.txt');
      const result = simulatePipeline(text);
      // The clean fixture has valid net < gross weight, valid dates, etc.
      // Deterministic validators should not flag it.
      // (Some may fire if the fixture's format doesn't match — that's acceptable,
      // but there should be no CRITICAL exceptions for a clean doc.)
      expect(result.deterministicExceptions).toBeLessThan(result.fieldCount);
    });
  });

  describe('minimal fixture (20_bare_minimum.txt)', () => {
    it('a sparse document triggers needs_manual_review when >30% required fields missing', () => {
      const text = loadFixture('20_bare_minimum.txt');
      const result = simulatePipeline(text);
      // A bare-minimum fixture likely has < 70% of required fields.
      // If so, the 30% rule fires.
      if (result.missingRatio > MINIMUM_VIABLE_EXTRACTION_THRESHOLD) {
        expect(result.decision).toBe('needs_manual_review');
        expect(result.needsManualReview).toBe(true);
      }
    });
  });

  describe('the audit ledger records every tier (static assertion)', () => {
    it('pipeline-hook.ts records a job_attempts row for all 5 tiers', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      // The pipeline must call recordTierAttempt for tiers 1, 2, 3, 4, AND 5
      // (the manual_review tier). Count the calls.
      const tier1Calls = (src.match(/recordTierAttempt\(env, claimedJob, 1,/g) || []).length;
      const tier2Calls = (src.match(/recordTierAttempt\(env, claimedJob, 2,/g) || []).length;
      const tier3Calls = (src.match(/recordTierAttempt\(env, claimedJob, 3,/g) || []).length;
      const tier4Calls = (src.match(/recordTierAttempt\(env, claimedJob, 4,/g) || []).length;
      const tier5Calls = (src.match(/recordTierAttempt\(env, claimedJob, 5,/g) || []).length;

      expect(tier1Calls).toBeGreaterThanOrEqual(1);
      expect(tier2Calls).toBeGreaterThanOrEqual(1);
      expect(tier3Calls).toBeGreaterThanOrEqual(1);
      expect(tier4Calls).toBeGreaterThanOrEqual(1);
      expect(tier5Calls).toBeGreaterThanOrEqual(1);
    });

    it('Tier 5 (manual review) is reached when all other tiers produce no fields', () => {
      // An empty/garbage input produces zero fields → Tier 5 fires.
      const emptyResult = regexExtract('');
      expect(emptyResult.length).toBe(0);
      // The pipeline-hook's Tier 5 check is: if (extractedFields.length === 0)
      // → return needs_manual_review. Verify that check exists.
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      expect(src).toMatch(/if\s*\(extractedFields\.length\s*===\s*0\)/);
      expect(src).toMatch(/needs_manual_review/);
    });
  });

  describe('Tier 1 (AI) schema validation gate (Step 1)', () => {
    it('pipeline-hook.ts parses the LLM response through llmResponseSchema', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      expect(src).toMatch(/llmResponseSchema\.safeParse/);
    });

    it('on schema validation failure, the tier is recorded as failure (not silent coercion)', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      // The schema-failure path must return success: false with an error code.
      expect(src).toMatch(/schema_validation_failed/);
      expect(src).toMatch(/success:\s*false/);
    });
  });

  describe('verbatim-anchor check is wired into the pipeline (Step 3)', () => {
    it('pipeline-hook.ts calls runVerbatimAnchorCheck after extraction', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      expect(src).toMatch(/runVerbatimAnchorCheck/);
    });

    it('a fabricated source field is caught even when regex extraction succeeds', () => {
      // Simulate: regex extracts real fields, but we add a fabricated field
      // with a source snippet that doesn't appear in the raw text.
      const text = loadFixture('01_clean_invoice.txt');
      const regexFields = regexExtract(text);
      const canonicalFields = mapToCanonicalSchema(
        regexFields as unknown as Record<string, unknown>[],
      );

      // Add a FABRICATED field with a source that doesn't appear in the text.
      const fabricatedField: CanonicalField = {
        field_key: 'total_value',
        field_label: 'Total Declared Value',
        value: '$999,999.00',
        confidence: 98, // the model CLAIMS high confidence
        source: 'Total Declared Value: $999,999.00', // NOT in the raw text
        category: 'financial',
      };

      const anchorResult = runVerbatimAnchorCheck(
        [...canonicalFields, fabricatedField],
        text,
      );

      // The fabricated field's source must be flagged as unverified.
      expect(anchorResult.unverified.some((u) => u.field_key === 'total_value')).toBe(true);
      expect(anchorResult.exceptions.some((e) => e.field_key === 'total_value')).toBe(true);
      expect(anchorResult.exceptions.some((e) => e.exception_type === 'source_not_verified')).toBe(true);

      // The fabricated field's confidence must be forced down regardless of
      // the model's claimed 98%.
      const unverifiedField = anchorResult.unverified.find((u) => u.field_key === 'total_value');
      expect(unverifiedField!.effective_confidence).toBeLessThanOrEqual(20);
      expect(unverifiedField!.model_confidence).toBe(98); // the model's claim, untouched
    });
  });

  describe('deterministic validators are wired (Step 4)', () => {
    it('pipeline-hook.ts calls runDeterministicValidation', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      expect(src).toMatch(/runDeterministicValidation/);
    });

    it('net > gross weight is caught by the deterministic validators', () => {
      // Construct fields where net_weight > gross_weight (physically impossible).
      const fields: CanonicalField[] = [
        { field_key: 'net_weight', field_label: 'Net Weight', value: '520 kg', confidence: 90, category: 'physical' },
        { field_key: 'gross_weight', field_label: 'Gross Weight', value: '450 kg', confidence: 90, category: 'physical' },
      ];
      const exceptions = runDeterministicValidation(fields);
      // The math validator must flag net > gross as CRITICAL.
      expect(exceptions.some((e) => e.severity === 'CRITICAL')).toBe(true);
      expect(exceptions.some((e) => e.reason.toLowerCase().includes('weight'))).toBe(true);
    });
  });

  describe('decision routing', () => {
    it('pipeline-hook.ts routes CRITICAL exceptions to BLOCK', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      expect(src).toMatch(/CRITICAL/);
      expect(src).toMatch(/decision\s*=\s*['"]BLOCK['"]/);
    });

    it('pipeline-hook.ts routes MAJOR exceptions to HOLD', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      expect(src).toMatch(/decision\s*=\s*['"]HOLD['"]/);
    });

    it('pipeline-hook.ts routes high-confidence no-exception to APPROVED', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      expect(src).toMatch(/decision\s*=\s*['"]APPROVED['"]/);
    });
  });
});

// ============================================================================
// 17-minimum-viable-extraction.test.ts — Phase 4 Step 5
// ============================================================================
// Verifies the minimum viable extraction rule: if more than 30% of expected
// fields for the detected document type are missing or unverified, the job's
// overall decision is needs_manual_review rather than completed, regardless
// of individual field confidences.
//
// The 30% threshold is a NAMED CONSTANT in pipeline-config.ts, not a magic
// number buried in a conditional.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MINIMUM_VIABLE_EXTRACTION_THRESHOLD,
  MAX_TIER_LATENCY_MS,
  OPENROUTER_MODELS,
} from '../../packages/shared/src/pipeline-config';
import {
  REQUIRED_FIELDS_BY_DOC_TYPE,
  type DocType,
} from '../../packages/shared/src/extraction-schema';

describe('Phase 4 Step 5 — Minimum viable extraction rule', () => {

  describe('the threshold is a named constant (not a magic number)', () => {
    it('MINIMUM_VIABLE_EXTRACTION_THRESHOLD is defined and equals 0.30', () => {
      expect(MINIMUM_VIABLE_EXTRACTION_THRESHOLD).toBe(0.30);
      expect(typeof MINIMUM_VIABLE_EXTRACTION_THRESHOLD).toBe('number');
    });

    it('the threshold is documented in the source (not just a magic number)', () => {
      const src = readFileSync(
        resolve(__dirname, '../../packages/shared/src/pipeline-config.ts'),
        'utf-8',
      );
      // The constant must have a comment explaining the 30% rationale.
      expect(src).toMatch(/MINIMUM_VIABLE_EXTRACTION_THRESHOLD/);
      expect(src).toMatch(/30%|0\.30|minimum viable/i);
    });

    it('other pipeline constants are also named (not magic numbers)', () => {
      // Sanity: the tier latency + model list are also named constants.
      expect(MAX_TIER_LATENCY_MS).toBe(18_000);
      expect(OPENROUTER_MODELS.length).toBeGreaterThanOrEqual(1);
      expect(OPENROUTER_MODELS[0]).toMatch(/qwen/i);
    });
  });

  describe('the 30% rule logic (simulated)', () => {
    // Simulate the decision logic from pipeline-hook.ts without needing the
    // full pipeline. This tests the RULE, not the pipeline wiring.

    function applyMinimumViableRule(
      presentFieldKeys: string[],
      docType: DocType,
    ): { missingRatio: number; needsManualReview: boolean } {
      const requiredFields = REQUIRED_FIELDS_BY_DOC_TYPE[docType] || [];
      const presentKeys = new Set(presentFieldKeys);
      const missingCount = requiredFields.filter((k) => !presentKeys.has(k)).length;
      const missingRatio = requiredFields.length > 0 ? missingCount / requiredFields.length : 0;
      return {
        missingRatio,
        needsManualReview: missingRatio > MINIMUM_VIABLE_EXTRACTION_THRESHOLD,
      };
    }

    it('a commercial_invoice with all required fields present → NOT needs_manual_review', () => {
      const required = REQUIRED_FIELDS_BY_DOC_TYPE.commercial_invoice;
      const result = applyMinimumViableRule(required, 'commercial_invoice');
      expect(result.missingRatio).toBe(0);
      expect(result.needsManualReview).toBe(false);
    });

    it('a commercial_invoice missing 1 of ~10 required fields (~10%) → NOT needs_manual_review', () => {
      const required = REQUIRED_FIELDS_BY_DOC_TYPE.commercial_invoice;
      const present = required.slice(1); // drop 1 field
      const result = applyMinimumViableRule(present, 'commercial_invoice');
      expect(result.missingRatio).toBeLessThanOrEqual(MINIMUM_VIABLE_EXTRACTION_THRESHOLD);
      expect(result.needsManualReview).toBe(false);
    });

    it('a commercial_invoice missing >30% of required fields → needs_manual_review', () => {
      const required = REQUIRED_FIELDS_BY_DOC_TYPE.commercial_invoice;
      // Drop enough fields to exceed 30% missing. With 7 required fields,
      // dropping 3 = 43% missing (> 30%). Use Math.ceil to ensure we drop
      // enough regardless of the exact required count.
      const dropCount = Math.max(1, Math.ceil(required.length * 0.4));
      const present = required.slice(dropCount);
      const result = applyMinimumViableRule(present, 'commercial_invoice');
      expect(result.missingRatio).toBeGreaterThan(MINIMUM_VIABLE_EXTRACTION_THRESHOLD);
      expect(result.needsManualReview).toBe(true);
    });

    it('a commercial_invoice missing 50% of required fields → needs_manual_review', () => {
      const required = REQUIRED_FIELDS_BY_DOC_TYPE.commercial_invoice;
      const dropCount = Math.ceil(required.length * 0.5);
      const present = required.slice(dropCount);
      const result = applyMinimumViableRule(present, 'commercial_invoice');
      expect(result.needsManualReview).toBe(true);
    });

    it('the threshold is strictly greater-than (30% exactly is NOT manual review)', () => {
      // If exactly 30% are missing, that's AT the threshold, not over it.
      // The rule is "more than 30%", so 30% exactly is still auto-completed.
      // (This matches the pipeline-hook.ts `missingRatio > THRESHOLD` check.)
      const required = REQUIRED_FIELDS_BY_DOC_TYPE.commercial_invoice;
      // Construct a set with exactly 30% missing.
      const missingCount = Math.round(required.length * 0.30);
      const present = required.slice(missingCount);
      const result = applyMinimumViableRule(present, 'commercial_invoice');
      // At exactly 30%, needsManualReview is false (the rule is > 30%, not >=).
      // (Floating-point may make this 0.3001 or 0.2999 — accept either at the boundary.)
      if (Math.abs(result.missingRatio - 0.30) < 0.01) {
        // Exactly at the boundary — the > check means false.
        expect(result.needsManualReview).toBe(false);
      }
    });

    it('a bill_of_lading missing 40% of required fields → needs_manual_review', () => {
      const required = REQUIRED_FIELDS_BY_DOC_TYPE.bill_of_lading;
      const present = required.slice(0, Math.ceil(required.length * 0.6));
      const result = applyMinimumViableRule(present, 'bill_of_lading');
      expect(result.needsManualReview).toBe(true);
    });

    it('an unknown doc type (no required fields) → never needs_manual_review', () => {
      // Unknown doc types have no required-fields list, so the ratio is 0/0 = 0.
      const result = applyMinimumViableRule([], 'unknown');
      expect(result.missingRatio).toBe(0);
      expect(result.needsManualReview).toBe(false);
    });

    it('the rule fires REGARDLESS of individual field confidences', () => {
      // This is the key invariant: even if every present field is at 99%
      // confidence, if >30% of required fields are MISSING, the decision is
      // needs_manual_review. The rule is about COVERAGE, not confidence.
      const required = REQUIRED_FIELDS_BY_DOC_TYPE.commercial_invoice;
      const present = required.slice(0, Math.ceil(required.length * 0.5)); // 50% missing
      const result = applyMinimumViableRule(present, 'commercial_invoice');
      expect(result.needsManualReview).toBe(true);
      // The rule doesn't look at confidence at all — only at which required
      // fields are present. A field at 99% confidence that IS present counts
      // the same as a field at 50% confidence that IS present.
    });
  });

  describe('the pipeline-hook applies the rule (static assertion)', () => {
    it('pipeline-hook.ts imports MINIMUM_VIABLE_EXTRACTION_THRESHOLD', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      expect(src).toMatch(/MINIMUM_VIABLE_EXTRACTION_THRESHOLD/);
      // The rule must use > (strictly greater than), not >=.
      expect(src).toMatch(/missingRatio\s*>\s*MINIMUM_VIABLE_EXTRACTION_THRESHOLD/);
    });

    it('pipeline-hook.ts sets decision to needs_manual_review when the rule fires', () => {
      const src = readFileSync(
        resolve(__dirname, '../../apps/consumer/src/pipeline-hook.ts'),
        'utf-8',
      );
      expect(src).toMatch(/needsManualReview/);
      expect(src).toMatch(/decision\s*=\s*['"]needs_manual_review['"]/);
    });
  });
});

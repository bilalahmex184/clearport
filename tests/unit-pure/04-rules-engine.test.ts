// ============================================================================
// P13 — Pure unit tests for the validation rules engine
// ----------------------------------------------------------------------------
// Exercises src/lib/rules/engine.ts: runRules + runRulesUpgraded.
// These are the pure (no-DB) evaluators; the loadRules() function is the
// only DB-bound piece and is intentionally NOT exercised here.
//
// Covers all 5 rule_types: confidence_threshold, required_field, regex_format,
// math_check, cross_doc_match.
//
// No network, no Supabase — only pure JS object construction + assertion.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  runRules,
  runRulesUpgraded,
  type ValidationRule,
  type DocumentField,
} from '@/lib/rules/engine';

// ---------------------------------------------------------------------------
// Factory helpers — keep the test bodies short + readable.
// ---------------------------------------------------------------------------
let ruleIdCounter = 0;
function nextRuleId(): string {
  ruleIdCounter += 1;
  return `rule-${ruleIdCounter}`;
}

function makeRule(
  overrides: Partial<ValidationRule> & Pick<ValidationRule, 'rule_type' | 'name'>,
): ValidationRule {
  return {
    id: nextRuleId(),
    org_id: 'org-test',
    name: overrides.name,
    field_key: overrides.field_key ?? null,
    rule_type: overrides.rule_type,
    config: overrides.config ?? {},
    severity: overrides.severity ?? 'flag',
    is_active: true,
    ...overrides,
  };
}

function makeField(overrides: Partial<DocumentField>): DocumentField {
  return {
    id: `field-${Math.random().toString(36).slice(2, 9)}`,
    field_key: overrides.field_key ?? 'unknown',
    field_label: overrides.field_label ?? overrides.field_key ?? 'unknown',
    extracted_value: overrides.extracted_value ?? null,
    corrected_value: overrides.corrected_value ?? null,
    confidence: overrides.confidence ?? 100,
    is_flagged: overrides.is_flagged ?? false,
    document_id: overrides.document_id ?? 'doc-1',
    documents: overrides.documents ?? { doc_type: 'Invoice', file_name: 'inv.pdf' },
    ...overrides,
  };
}

describe('rules/engine (P13)', () => {
  // =========================================================================
  // confidence_threshold
  // =========================================================================
  describe('confidence_threshold', () => {
    it('passes when field.confidence >= min_confidence', () => {
      const rule = makeRule({
        name: 'HTS conf check',
        field_key: 'htsCode',
        rule_type: 'confidence_threshold',
        config: { min_confidence: 85 },
      });
      const field = makeField({
        field_key: 'htsCode',
        extracted_value: '8471.30.0100',
        confidence: 90,
      });
      const results = runRules([rule], [field]);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].message).toContain('passed');
    });

    it('fails when field.confidence < min_confidence', () => {
      const rule = makeRule({
        name: 'HTS conf check',
        field_key: 'htsCode',
        rule_type: 'confidence_threshold',
        config: { min_confidence: 85 },
        severity: 'block',
      });
      const field = makeField({
        field_key: 'htsCode',
        extracted_value: '8471.30.0100',
        confidence: 60,
      });
      const results = runRules([rule], [field]);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].severity).toBe('block');
      // Interpolated explanation should mention actual + threshold values.
      expect(results[0].message).toContain('60');
      expect(results[0].message).toContain('85');
    });

    it('passes when min_confidence is 0 (unset / default)', () => {
      const rule = makeRule({
        name: 'always-pass',
        field_key: 'shipper',
        rule_type: 'confidence_threshold',
        config: {},
      });
      const field = makeField({ field_key: 'shipper', confidence: 0 });
      const results = runRules([rule], [field]);
      expect(results[0].passed).toBe(true);
    });

    it('uses corrected_value-bearing field but still evaluates confidence', () => {
      const rule = makeRule({
        name: 'conf',
        field_key: 'netWeight',
        rule_type: 'confidence_threshold',
        config: { min_confidence: 80 },
      });
      const field = makeField({
        field_key: 'netWeight',
        extracted_value: '450 lbs',
        corrected_value: '475 lbs',
        confidence: 50,
      });
      const results = runRules([rule], [field]);
      expect(results[0].passed).toBe(false);
    });
  });

  // =========================================================================
  // required_field
  // =========================================================================
  describe('required_field', () => {
    it('fails when the field is entirely missing from the document', () => {
      const rule = makeRule({
        name: 'HTS required',
        field_key: 'htsCode',
        rule_type: 'required_field',
        severity: 'block',
      });
      // Field list has shipper but NOT htsCode.
      const fields = [makeField({ field_key: 'shipper' })];
      const results = runRules([rule], fields);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('htsCode');
      expect(results[0].severity).toBe('block');
    });

    it('passes when the field is present with a non-empty value', () => {
      const rule = makeRule({
        name: 'HTS required',
        field_key: 'htsCode',
        rule_type: 'required_field',
      });
      const fields = [
        makeField({ field_key: 'htsCode', extracted_value: '8471.30.0100' }),
      ];
      const results = runRules([rule], fields);
      expect(results[0].passed).toBe(true);
    });

    it('fails when the field is present but value is empty', () => {
      const rule = makeRule({
        name: 'HTS required',
        field_key: 'htsCode',
        rule_type: 'required_field',
      });
      const fields = [
        makeField({ field_key: 'htsCode', extracted_value: '', corrected_value: null }),
      ];
      const results = runRules([rule], fields);
      expect(results[0].passed).toBe(false);
    });

    it('uses corrected_value when extracted_value is empty', () => {
      const rule = makeRule({
        name: 'HTS required',
        field_key: 'htsCode',
        rule_type: 'required_field',
      });
      const fields = [
        makeField({
          field_key: 'htsCode',
          extracted_value: null,
          corrected_value: '8471.30.0100',
        }),
      ];
      const results = runRules([rule], fields);
      expect(results[0].passed).toBe(true);
    });
  });

  // =========================================================================
  // regex_format
  // =========================================================================
  describe('regex_format', () => {
    it('passes when value matches the pattern', () => {
      const rule = makeRule({
        name: 'HTS format',
        field_key: 'htsCode',
        rule_type: 'regex_format',
        config: { pattern: '^\\d{4}\\.\\d{2}\\.\\d{4}$' },
      });
      const field = makeField({
        field_key: 'htsCode',
        extracted_value: '8471.30.0100',
      });
      const results = runRules([rule], [field]);
      expect(results[0].passed).toBe(true);
    });

    it('fails when value does NOT match the pattern', () => {
      const rule = makeRule({
        name: 'HTS format',
        field_key: 'htsCode',
        rule_type: 'regex_format',
        config: { pattern: '^\\d{4}\\.\\d{2}\\.\\d{4}$' },
      });
      const field = makeField({
        field_key: 'htsCode',
        extracted_value: 'INVALID-HTS',
      });
      const results = runRules([rule], [field]);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('INVALID-HTS');
    });

    it('passes when value is empty (required_field handles missing)', () => {
      const rule = makeRule({
        name: 'HTS format',
        field_key: 'htsCode',
        rule_type: 'regex_format',
        config: { pattern: '^\\d{4}\\.\\d{2}\\.\\d{4}$' },
      });
      const field = makeField({ field_key: 'htsCode', extracted_value: '' });
      const results = runRules([rule], [field]);
      expect(results[0].passed).toBe(true);
    });

    it('passes when pattern config is missing (no-op)', () => {
      const rule = makeRule({
        name: 'HTS format',
        field_key: 'htsCode',
        rule_type: 'regex_format',
        config: {},
      });
      const field = makeField({
        field_key: 'htsCode',
        extracted_value: 'anything',
      });
      const results = runRules([rule], [field]);
      expect(results[0].passed).toBe(true);
    });

    it('passes when the pattern is an invalid regex (does not block)', () => {
      const rule = makeRule({
        name: 'bad regex',
        field_key: 'htsCode',
        rule_type: 'regex_format',
        config: { pattern: '(' }, // unbalanced parens — invalid
      });
      const field = makeField({
        field_key: 'htsCode',
        extracted_value: 'whatever',
      });
      const results = runRules([rule], [field]);
      expect(results[0].passed).toBe(true);
    });
  });

  // =========================================================================
  // math_check
  // =========================================================================
  describe('math_check', () => {
    describe('greater_than_zero', () => {
      it('passes for a positive value', () => {
        const rule = makeRule({
          name: 'value>0',
          field_key: 'declaredValue',
          rule_type: 'math_check',
          config: { check: 'greater_than_zero' },
        });
        const field = makeField({
          field_key: 'declaredValue',
          extracted_value: '$1,250.00',
        });
        const results = runRules([rule], [field]);
        expect(results[0].passed).toBe(true);
      });

      it('fails for zero', () => {
        const rule = makeRule({
          name: 'value>0',
          field_key: 'declaredValue',
          rule_type: 'math_check',
          config: { check: 'greater_than_zero' },
        });
        const field = makeField({
          field_key: 'declaredValue',
          extracted_value: '$0.00',
        });
        const results = runRules([rule], [field]);
        expect(results[0].passed).toBe(false);
      });

      it('fails for a negative value', () => {
        const rule = makeRule({
          name: 'value>0',
          field_key: 'declaredValue',
          rule_type: 'math_check',
          config: { check: 'greater_than_zero' },
        });
        const field = makeField({
          field_key: 'declaredValue',
          extracted_value: '-50.00',
        });
        const results = runRules([rule], [field]);
        expect(results[0].passed).toBe(false);
      });

      it('fails for non-numeric text', () => {
        const rule = makeRule({
          name: 'value>0',
          field_key: 'declaredValue',
          rule_type: 'math_check',
          config: { check: 'greater_than_zero' },
        });
        const field = makeField({
          field_key: 'declaredValue',
          extracted_value: 'N/A',
        });
        const results = runRules([rule], [field]);
        expect(results[0].passed).toBe(false);
      });
    });

    describe('gross_gte_net', () => {
      it('passes when gross >= net (both in kg)', () => {
        const rule = makeRule({
          name: 'gross>=net',
          field_key: 'grossWeight',
          rule_type: 'math_check',
          config: { check: 'gross_gte_net' },
        });
        const fields = [
          makeField({ field_key: 'grossWeight', extracted_value: '2,800 kg' }),
          makeField({ field_key: 'netWeight', extracted_value: '2,500 kg' }),
        ];
        const results = runRules([rule], fields);
        expect(results).toHaveLength(1);
        expect(results[0].passed).toBe(true);
      });

      it('fails when gross < net', () => {
        const rule = makeRule({
          name: 'gross>=net',
          field_key: 'grossWeight',
          rule_type: 'math_check',
          config: { check: 'gross_gte_net' },
        });
        const fields = [
          makeField({ field_key: 'grossWeight', extracted_value: '500 kg' }),
          makeField({ field_key: 'netWeight', extracted_value: '2,500 kg' }),
        ];
        const results = runRules([rule], fields);
        expect(results[0].passed).toBe(false);
      });

      it('passes when gross = net (boundary)', () => {
        const rule = makeRule({
          name: 'gross>=net',
          field_key: 'grossWeight',
          rule_type: 'math_check',
          config: { check: 'gross_gte_net' },
        });
        const fields = [
          makeField({ field_key: 'grossWeight', extracted_value: '2,500 kg' }),
          makeField({ field_key: 'netWeight', extracted_value: '2,500 kg' }),
        ];
        const results = runRules([rule], fields);
        expect(results[0].passed).toBe(true);
      });

      it('handles mixed units (lbs vs kg) via conversion', () => {
        const rule = makeRule({
          name: 'gross>=net',
          field_key: 'grossWeight',
          rule_type: 'math_check',
          config: { check: 'gross_gte_net' },
        });
        // 1000 lbs = 453.6 kg ; 500 kg → gross(453.6) < net(500) → fails
        const fields = [
          makeField({ field_key: 'grossWeight', extracted_value: '1000 lbs' }),
          makeField({ field_key: 'netWeight', extracted_value: '500 kg' }),
        ];
        const results = runRules([rule], fields);
        expect(results[0].passed).toBe(false);
      });

      it('passes when either weight field is missing (can\'t check)', () => {
        const rule = makeRule({
          name: 'gross>=net',
          field_key: 'grossWeight',
          rule_type: 'math_check',
          config: { check: 'gross_gte_net' },
        });
        const fields = [
          makeField({ field_key: 'grossWeight', extracted_value: '2,800 kg' }),
          // netWeight intentionally absent
        ];
        const results = runRules([rule], fields);
        expect(results[0].passed).toBe(true);
      });
    });

    it('passes when check config is missing (no-op)', () => {
      const rule = makeRule({
        name: 'no-check',
        field_key: 'declaredValue',
        rule_type: 'math_check',
        config: {},
      });
      const field = makeField({
        field_key: 'declaredValue',
        extracted_value: 'whatever',
      });
      const results = runRules([rule], [field]);
      expect(results[0].passed).toBe(true);
    });

    it('passes for an unknown check name (no-op, default true)', () => {
      const rule = makeRule({
        name: 'unknown-check',
        field_key: 'declaredValue',
        rule_type: 'math_check',
        config: { check: 'unknown_check_name' },
      });
      const field = makeField({
        field_key: 'declaredValue',
        extracted_value: 'whatever',
      });
      const results = runRules([rule], [field]);
      expect(results[0].passed).toBe(true);
    });
  });

  // =========================================================================
  // cross_doc_match — global rule (field_key is null)
  // =========================================================================
  describe('cross_doc_match (global)', () => {
    it('detects mismatch across two documents for the same field_key', () => {
      const rule = makeRule({
        name: 'consignee agreement',
        field_key: null,
        rule_type: 'cross_doc_match',
        severity: 'flag',
      });
      const fields = [
        makeField({
          field_key: 'consignee',
          extracted_value: 'Beta Corp',
          document_id: 'doc-1',
          documents: { doc_type: 'Invoice', file_name: 'inv.pdf' },
        }),
        makeField({
          field_key: 'consignee',
          extracted_value: 'Beta Corporation',
          document_id: 'doc-2',
          documents: { doc_type: 'Packing List', file_name: 'pack.pdf' },
        }),
      ];
      const results = runRules([rule], fields);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].field_key).toBe('consignee');
      expect(results[0].message).toContain('Invoice');
      expect(results[0].message).toContain('Packing List');
    });

    it('passes when both documents agree on the value (case-insensitive)', () => {
      const rule = makeRule({
        name: 'consignee agreement',
        field_key: null,
        rule_type: 'cross_doc_match',
      });
      const fields = [
        makeField({
          field_key: 'consignee',
          extracted_value: 'Beta Corp',
          document_id: 'doc-1',
        }),
        makeField({
          field_key: 'consignee',
          extracted_value: '  beta corp ', // trimmed + lowercased before compare
          document_id: 'doc-2',
        }),
      ];
      const results = runRules([rule], fields);
      expect(results).toHaveLength(0); // no mismatch → no result emitted
    });

    it('does not flag fields that appear in only one document', () => {
      const rule = makeRule({
        name: 'consignee agreement',
        field_key: null,
        rule_type: 'cross_doc_match',
      });
      const fields = [
        makeField({
          field_key: 'consignee',
          extracted_value: 'Beta Corp',
          document_id: 'doc-1',
        }),
        makeField({
          field_key: 'shipper',
          extracted_value: 'Acme',
          document_id: 'doc-2',
        }),
      ];
      const results = runRules([rule], fields);
      expect(results).toHaveLength(0);
    });
  });

  // =========================================================================
  // cross_doc_match — field-specific (field_key set)
  // =========================================================================
  describe('cross_doc_match (field-specific)', () => {
    it('passes when the field-specific value agrees across docs', () => {
      const rule = makeRule({
        name: 'hts agreement',
        field_key: 'htsCode',
        rule_type: 'cross_doc_match',
      });
      const fields = [
        makeField({
          field_key: 'htsCode',
          extracted_value: '8471.30.0100',
          document_id: 'doc-1',
        }),
        makeField({
          field_key: 'htsCode',
          extracted_value: '8471.30.0100',
          document_id: 'doc-2',
        }),
      ];
      const results = runRules([rule], fields);
      // One result per matching field (2), both pass.
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.passed)).toBe(true);
    });

    it('fails when the field-specific value disagrees across docs', () => {
      const rule = makeRule({
        name: 'hts agreement',
        field_key: 'htsCode',
        rule_type: 'cross_doc_match',
      });
      const fields = [
        makeField({
          field_key: 'htsCode',
          extracted_value: '8471.30.0100',
          document_id: 'doc-1',
          documents: { doc_type: 'Invoice', file_name: 'inv.pdf' },
        }),
        makeField({
          field_key: 'htsCode',
          extracted_value: '8480.71.8010',
          document_id: 'doc-2',
          documents: { doc_type: 'Packing List', file_name: 'pack.pdf' },
        }),
      ];
      const results = runRules([rule], fields);
      expect(results).toHaveLength(2);
      expect(results.every((r) => !r.passed)).toBe(true);
      expect(results[0].message).toContain('Invoice');
      expect(results[0].message).toContain('Packing List');
    });
  });

  // =========================================================================
  // runRulesUpgraded — structured RuleEvaluationResult output
  // =========================================================================
  describe('runRulesUpgraded', () => {
    it('produces structured results with decision_trace + dependencies', () => {
      const rule = makeRule({
        name: 'conf',
        field_key: 'htsCode',
        rule_type: 'confidence_threshold',
        config: { min_confidence: 85 },
        severity: 'block',
      });
      const field = makeField({
        field_key: 'htsCode',
        extracted_value: '8471.30.0100',
        confidence: 60,
      });
      const results = runRulesUpgraded([rule], [field]);
      expect(results).toHaveLength(1);
      const r = results[0];
      expect(r.status).toBe('failed');
      expect(r.severity).toBe('error'); // 'block' maps to 'error'
      expect(r.dependencies).toContain('htsCode');
      expect(r.decision_trace.evaluation_path).toContain('confidence_threshold');
      expect(r.decision_trace.final_outcome).toBe('failed');
      expect(r.expected).toContain('confidence >= 85');
    });

    it('required_field missing → structured fail with "missing" actual', () => {
      const rule = makeRule({
        name: 'req',
        field_key: 'htsCode',
        rule_type: 'required_field',
        severity: 'flag',
      });
      const results = runRulesUpgraded([rule], [makeField({ field_key: 'shipper' })]);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
      expect(results[0].severity).toBe('warning'); // 'flag' maps to 'warning'
      expect(results[0].actual).toBe('missing');
      expect(results[0].decision_trace.evaluation_path).toContain('not_found');
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {
    it('returns [] for empty rules array', () => {
      expect(runRules([], [makeField({ field_key: 'shipper' })])).toEqual([]);
    });

    it('returns [] for empty fields array', () => {
      const rule = makeRule({
        name: 'conf',
        field_key: 'htsCode',
        rule_type: 'confidence_threshold',
        config: { min_confidence: 80 },
      });
      // No fields → rule skipped (not even a required_field fail, because
      // field_key is 'htsCode' which is just absent).
      expect(runRules([rule], [])).toEqual([
        // required_field is the only rule_type that emits a fail on absent
        // field, so confidence_threshold just skips.
      ]);
    });

    it('skips non-required rules when the field_key is absent', () => {
      const rules = [
        makeRule({
          name: 'conf',
          field_key: 'htsCode',
          rule_type: 'confidence_threshold',
          config: { min_confidence: 80 },
        }),
        makeRule({
          name: 'fmt',
          field_key: 'htsCode',
          rule_type: 'regex_format',
          config: { pattern: '.*' },
        }),
      ];
      const fields = [makeField({ field_key: 'shipper' })];
      expect(runRules(rules, fields)).toEqual([]);
    });

    it('runs multiple rules against multiple fields (matrix)', () => {
      const rules = [
        makeRule({
          name: 'conf-hts',
          field_key: 'htsCode',
          rule_type: 'confidence_threshold',
          config: { min_confidence: 80 },
        }),
        makeRule({
          name: 'conf-shipper',
          field_key: 'shipper',
          rule_type: 'confidence_threshold',
          config: { min_confidence: 80 },
        }),
      ];
      const fields = [
        makeField({ field_key: 'htsCode', extracted_value: '8471.30.0100', confidence: 90 }),
        makeField({ field_key: 'shipper', extracted_value: 'Acme', confidence: 50 }),
      ];
      const results = runRules(rules, fields);
      expect(results).toHaveLength(2);
      const hts = results.find((r) => r.field_key === 'htsCode');
      const ship = results.find((r) => r.field_key === 'shipper');
      expect(hts?.passed).toBe(true);
      expect(ship?.passed).toBe(false);
    });
  });
});

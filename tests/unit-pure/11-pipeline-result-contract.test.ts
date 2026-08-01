// ============================================================================
// 11-pipeline-result-contract.test.ts
// ----------------------------------------------------------------------------
// Pure unit tests for packages/shared/src/pipeline-result.ts — the canonical
// Zod schema for an extraction pipeline result.
//
// This schema is the integration contract between the consumer's pipeline-hook
// (Phase 3 stub → Phase 4 real impl) and the rest of the system:
//   • Consumer → DB (Point 1): writeSuccessResult validates BEFORE
//     complete_job(true, result). A malformed result throws → caught by
//     processJob → recordFailureAndComplete (ledger + complete_job(false)).
//     A buggy Phase 4 pipeline CANNOT write garbage to the DB.
//   • DB → client (Point 5): the ingress Worker's cached-result return path
//     re-validates job.result before returning it. A malformed stored result
//     is rejected with a 500 (CACHED_RESULT_INVALID), NOT silently passed.
//
// These tests assert the schema itself enforces the contract — independent
// of the consumer/ingress wiring (those are exercised by integration tests).
// No network, no Supabase, no env vars. Just Zod + assertions.
//
// Covers the 10 contract cases from the p3-fix-3 + p3-fix-5 task spec.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  pipelineResultSchema,
  pipelineFieldSchema,
  pipelineExceptionSchema,
  STUB_PIPELINE_RESULT,
  type PipelineResult,
} from '../../packages/shared/src/pipeline-result';

// ---------------------------------------------------------------------------
// Fixture builders — start from a known-good base and mutate one field per
// negative test so each failure is unambiguously attributable.
// ---------------------------------------------------------------------------

/** A minimal valid PipelineResult (the stub sentinel). */
function validBase(): PipelineResult {
  return { ...STUB_PIPELINE_RESULT, fields: [], exceptions: [] };
}

/** A realistic full result — 3 fields, 1 exception, APPROVED, confidence 92. */
function realisticResult(): PipelineResult {
  return {
    fields: [
      {
        field_key: 'invoice_number',
        field_label: 'Invoice Number',
        extracted_value: 'INV-2024-0042',
        confidence: 95,
        extraction_source: 'ai',
      },
      {
        field_key: 'total_value',
        field_label: 'Total Value',
        extracted_value: '12450.00 USD',
        confidence: 88,
        extraction_source: 'ai',
      },
      {
        field_key: 'currency',
        field_label: 'Currency',
        extracted_value: 'USD',
        confidence: 100,
        extraction_source: 'regex',
      },
    ],
    overall_confidence: 92,
    decision: 'APPROVED',
    exceptions: [
      {
        field_key: 'shipper_phone',
        reason: 'Could not be extracted from the document — manual review advised',
        severity: 'MINOR',
      },
    ],
    pipeline_trace_id: 'trace-abc-123-realistic',
  };
}

// =========================================================================
// Contract test — the 10 cases from the p3-fix-3 + p3-fix-5 task spec
// =========================================================================
describe('pipelineResultSchema contract (p3-fix-3 + p3-fix-5)', () => {
  // 1. Valid result passes — the STUB_PIPELINE_RESULT sentinel validates.
  it('1. STUB_PIPELINE_RESULT validates against pipelineResultSchema', () => {
    const parsed = pipelineResultSchema.safeParse(STUB_PIPELINE_RESULT);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.decision).toBe('HOLD');
      expect(parsed.data.overall_confidence).toBe(0);
      expect(parsed.data.fields).toEqual([]);
      expect(parsed.data.exceptions).toEqual([]);
      expect(parsed.data.pipeline_trace_id).toBe('stub-phase3');
    }
  });

  // 2. Missing required field fails — a result without pipeline_trace_id.
  it('2. missing pipeline_trace_id fails validation', () => {
    const { pipeline_trace_id: _omit, ...rest } = validBase();
    const parsed = pipelineResultSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  // 3. Invalid decision fails — must be APPROVED | HOLD | BLOCK | REJECT.
  it('3. decision: "UNKNOWN" fails validation (not in enum)', () => {
    const parsed = pipelineResultSchema.safeParse({
      ...validBase(),
      decision: 'UNKNOWN',
    });
    expect(parsed.success).toBe(false);
  });

  // 4. Confidence out of range fails — overall_confidence > 100.
  it('4. overall_confidence: 150 fails validation (> 100)', () => {
    const parsed = pipelineResultSchema.safeParse({
      ...validBase(),
      overall_confidence: 150,
    });
    expect(parsed.success).toBe(false);
  });

  // 5. Confidence negative fails — overall_confidence < 0.
  it('5. overall_confidence: -1 fails validation (< 0)', () => {
    const parsed = pipelineResultSchema.safeParse({
      ...validBase(),
      overall_confidence: -1,
    });
    expect(parsed.success).toBe(false);
  });

  // 6. Invalid severity fails — must be CRITICAL | MAJOR | MINOR.
  it('6. exception severity: "WARN" fails validation (not in enum)', () => {
    const parsed = pipelineResultSchema.safeParse({
      ...validBase(),
      exceptions: [
        {
          field_key: 'shipper_phone',
          reason: 'missing',
          severity: 'WARN',
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  // 7. Field with empty field_key fails — min(1) on field_key.
  it('7. field_key: "" fails validation (empty string)', () => {
    const parsed = pipelineResultSchema.safeParse({
      ...validBase(),
      fields: [
        {
          field_key: '',
          field_label: 'Invoice Number',
          extracted_value: 'INV-0042',
          confidence: 90,
          extraction_source: 'ai',
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  // 8. Non-integer confidence fails — field.confidence must be int.
  it('8. field confidence: 85.5 fails validation (must be int)', () => {
    const parsed = pipelineResultSchema.safeParse({
      ...validBase(),
      fields: [
        {
          field_key: 'invoice_number',
          field_label: 'Invoice Number',
          extracted_value: 'INV-0042',
          confidence: 85.5,
          extraction_source: 'ai',
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  // 9. Missing exceptions array fails — exceptions is required.
  it('9. missing exceptions array fails validation', () => {
    const { exceptions: _omit, ...rest } = validBase();
    const parsed = pipelineResultSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  // 10. A realistic full result passes — 3 fields, 1 exception, APPROVED, 92.
  it('10. a realistic full result (3 fields, 1 exception, APPROVED, 92) passes', () => {
    const result = realisticResult();
    const parsed = pipelineResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.fields).toHaveLength(3);
      expect(parsed.data.exceptions).toHaveLength(1);
      expect(parsed.data.decision).toBe('APPROVED');
      expect(parsed.data.overall_confidence).toBe(92);
      expect(parsed.data.pipeline_trace_id).toBe('trace-abc-123-realistic');
      // Confidence values preserved exactly (all integers in range).
      expect(parsed.data.fields.map((f) => f.confidence)).toEqual([95, 88, 100]);
    }
  });
});

// =========================================================================
// Subschema sanity — field + exception schemas in isolation
// =========================================================================
describe('pipelineFieldSchema (subschema sanity)', () => {
  it('accepts a well-formed field', () => {
    const parsed = pipelineFieldSchema.safeParse({
      field_key: 'invoice_number',
      field_label: 'Invoice Number',
      extracted_value: 'INV-0042',
      confidence: 90,
      extraction_source: 'ai',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects confidence = 101 (out of range)', () => {
    const parsed = pipelineFieldSchema.safeParse({
      field_key: 'invoice_number',
      field_label: 'Invoice Number',
      extracted_value: 'INV-0042',
      confidence: 101,
      extraction_source: 'ai',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty extraction_source', () => {
    const parsed = pipelineFieldSchema.safeParse({
      field_key: 'invoice_number',
      field_label: 'Invoice Number',
      extracted_value: 'INV-0042',
      confidence: 90,
      extraction_source: '',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('pipelineExceptionSchema (subschema sanity)', () => {
  it('accepts each of the three severities', () => {
    for (const severity of ['CRITICAL', 'MAJOR', 'MINOR'] as const) {
      const parsed = pipelineExceptionSchema.safeParse({
        field_key: 'shipper_phone',
        reason: 'missing',
        severity,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects an empty reason', () => {
    const parsed = pipelineExceptionSchema.safeParse({
      field_key: 'shipper_phone',
      reason: '',
      severity: 'MAJOR',
    });
    expect(parsed.success).toBe(false);
  });
});

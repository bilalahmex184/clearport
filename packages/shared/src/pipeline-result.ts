// ============================================================================
// packages/shared/src/pipeline-result.ts — Canonical PipelineResult schema
// ============================================================================
// WHAT THIS IS
//   The Zod-validated shape of an extraction pipeline result. This is the
//   contract between the consumer Worker's pipeline-hook (Phase 3 stub →
//   Phase 4 real impl) and the rest of the system (jobs.result JSONB column,
//   ingress Worker's cached-result return path).
//
// WHY A SHARED SCHEMA
//   Two boundaries validate against this exact schema:
//     1. Consumer → DB (writeSuccessResult in apps/consumer/src/index.ts):
//        BEFORE complete_job(true, result), the consumer validates the
//        pipeline output. A malformed result is treated as a pipeline
//        FAILURE — the throw is caught by processJob's existing try/catch,
//        which calls recordFailureAndComplete (records to the ledger +
//        complete_job(false) → retry or dead-letter). A buggy Phase 4
//        pipeline CANNOT write garbage to the DB.
//     2. DB → client (cached path in apps/ingress/src/index.ts): when the
//        ingress Worker returns a cached completed result, it re-validates
//        job.result. A malformed stored result (e.g. from a buggy pipeline
//        version that has since been fixed) is rejected with a 500 — the
//        client gets a clear error and can re-upload to trigger
//        reprocessing. Garbage is NEVER silently passed to the client.
//
// WHY ZOD
//   Zod is already a root dependency (used in src/app/api/* validators).
//   Both Workers (ingress, consumer) bundle the shared package via
//   wrangler/esbuild, so zod is pulled into the Worker bundle transparently
//   — no new runtime dependency on the Worker itself.
//
// POINT 1 (pipeline contract) + POINT 5 (cached-result validation) from the
// Phase 3 hardening review are both enforced by this single schema.
// ============================================================================

import { z } from 'zod';

// ---------------------------------------------------------------------------
// pipelineFieldSchema — a single extracted field. confidence is an INTEGER
// 0-100 (matches the documents_fields.confidence column → INTEGER CHECK
// (confidence BETWEEN 0 AND 100)). The .int() guard rejects 85.5 etc.
// ---------------------------------------------------------------------------
export const pipelineFieldSchema = z.object({
  field_key: z.string().min(1),
  field_label: z.string().min(1),
  extracted_value: z.string(),
  confidence: z.number().int().min(0).max(100),
  extraction_source: z.string().min(1),
});

// ---------------------------------------------------------------------------
// pipelineExceptionSchema — a non-fatal issue the pipeline flagged for human
// review. severity drives downstream routing (CRITICAL → BLOCK, MAJOR → HOLD,
// MINOR → APPROVED-with-note). The enum is closed: a new severity must be a
// deliberate schema change, not a silent addition.
// ---------------------------------------------------------------------------
export const pipelineExceptionSchema = z.object({
  field_key: z.string().min(1),
  reason: z.string().min(1),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
});

// ---------------------------------------------------------------------------
// pipelineResultSchema — the top-level result. Stored verbatim on
// jobs.result (JSONB). decision drives shipment routing:
//   APPROVED → auto-pass (high confidence, no exceptions)
//   HOLD     → human review (low confidence or non-critical exceptions)
//   BLOCK    → missing required field(s); operator must intervene
//   REJECT   → unrecoverable document quality (OCR failed, blank, etc.)
// ---------------------------------------------------------------------------
export const pipelineResultSchema = z.object({
  fields: z.array(pipelineFieldSchema),
  overall_confidence: z.number().min(0).max(100),
  decision: z.enum(['APPROVED', 'HOLD', 'BLOCK', 'REJECT']),
  exceptions: z.array(pipelineExceptionSchema),
  pipeline_trace_id: z.string().min(1),
});

export type PipelineResult = z.infer<typeof pipelineResultSchema>;
export type PipelineField = z.infer<typeof pipelineFieldSchema>;
export type PipelineException = z.infer<typeof pipelineExceptionSchema>;

// ---------------------------------------------------------------------------
// STUB_PIPELINE_RESULT — sentinel for the Phase 3 stub pipeline-hook.
// The stub returns this shape (with a fresh pipeline_trace_id swapped in at
// runtime — see apps/consumer/src/pipeline-hook.ts). Hard-coding the sentinel
// here lets the contract test assert the stub produces a schema-valid result
// without coupling to the stub's implementation.
// ---------------------------------------------------------------------------
export const STUB_PIPELINE_RESULT: PipelineResult = {
  fields: [],
  overall_confidence: 0,
  decision: 'HOLD',
  exceptions: [],
  pipeline_trace_id: 'stub-phase3',
};

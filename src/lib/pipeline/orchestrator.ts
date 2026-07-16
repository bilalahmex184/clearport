// ============================================================================
// ClearPort — Orchestrator + Trace System
// ============================================================================
// Implements the pipeline guardrails:
//   - If status === "failed" → STOP pipeline immediately
//   - If status === "partial" → continue WITH degraded_mode = true
//   - Retry allowed only if idempotency_key unchanged
//   - All stages MUST log before exit
// ============================================================================

import type {
  PipelineStageResult,
  StageStatus,
  SystemException,
  MissingField,
  StageMeta,
  DocumentAuditTrail,
  AuditTimelineEntry,
  FieldHistory,
  RuleEvaluationResult,
  CrossValidationResult,
} from "./types";
import { PIPELINE_VERSIONS } from "./types";
import { logger } from "@/lib/utils/logger";

// ---------------------------------------------------------------------------
// Trace ID + Idempotency
// ---------------------------------------------------------------------------

/**
 * Generate a unique trace ID for correlating across all pipeline stages.
 */
export function generateTraceId(): string {
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generate an idempotency key from a file's content hash.
 * Used to detect duplicate uploads and prevent double-processing.
 */
export async function generateIdempotencyKey(content: string | ArrayBuffer): Promise<string> {
  if (typeof content === "string") {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      hash |= 0;
    }
    return `idem-${Math.abs(hash).toString(36)}`;
  }
  const bytes = new Uint8Array(content);
  let hash = 0;
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash << 5) - hash) + bytes[i];
    hash |= 0;
  }
  return `idem-${Math.abs(hash).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Stage Executor
// ---------------------------------------------------------------------------

/**
 * Execute a pipeline stage with full observability and guardrails.
 *
 * Guardrails:
 * - If the stage throws, it's caught and returned as status="failed"
 * - If the stage returns partial results, degraded_mode is set to true
 * - If the stage returns failed, the orchestrator will STOP
 * - Every stage logs its result before returning
 */
export async function executeStage<T>(
  stageName: string,
  traceId: string,
  idempotencyKey: string,
  fn: () => Promise<{
    data: T | null;
    errors?: SystemException[];
    warnings?: SystemException[];
    missing_fields?: MissingField[];
  }>,
): Promise<PipelineStageResult<T>> {
  const startTime = performance.now();
  const timestamp = new Date().toISOString();

  try {
    const result = await fn();
    const duration_ms = Math.round(performance.now() - startTime);

    // Determine status from errors
    let status: StageStatus = "success";
    if (result.errors && result.errors.length > 0) {
      const hasErrors = result.errors.some((e) => e.severity === "error");
      status = hasErrors ? "partial" : "success";
    }
    if (result.missing_fields && result.missing_fields.length > 0) {
      status = status === "success" ? "partial" : status;
    }

    const stageResult: PipelineStageResult<T> = {
      status,
      stage: stageName,
      data: result.data,
      errors: result.errors || [],
      warnings: result.warnings || [],
      missing_fields: result.missing_fields || [],
      meta: {
        duration_ms,
        timestamp,
        version: PIPELINE_VERSIONS.orchestrator,
        trace_id: traceId,
        idempotency_key: idempotencyKey,
        degraded_mode: status === "partial",
        metrics: {
          records_processed: result.data ? 1 : 0,
          error_count: (result.errors || []).length,
          warning_count: (result.warnings || []).length,
        },
      },
    };

    // Log before exit (guardrail)
    logger.info(`[pipeline] Stage "${stageName}" completed`, {
      trace_id: traceId,
      stage: stageName,
      status,
      duration_ms,
      errors: stageResult.errors.length,
      warnings: stageResult.warnings.length,
      missing_fields: stageResult.missing_fields?.length || 0,
    });

    return stageResult;
  } catch (err) {
    const duration_ms = Math.round(performance.now() - startTime);
    const error: SystemException = {
      code: "STAGE_EXCEPTION",
      message: err instanceof Error ? err.message : String(err),
      severity: "error",
      internal_message: err instanceof Error ? err.stack : String(err),
      user_message: `An error occurred during ${stageName}. Please try again or contact support.`,
    };

    const stageResult: PipelineStageResult<T> = {
      status: "failed",
      stage: stageName,
      data: null,
      errors: [error],
      warnings: [],
      meta: {
        duration_ms,
        timestamp,
        version: PIPELINE_VERSIONS.orchestrator,
        trace_id: traceId,
        idempotency_key: idempotencyKey,
        degraded_mode: false,
        metrics: {
          records_processed: 0,
          error_count: 1,
          warning_count: 0,
        },
      },
    };

    // Log before exit (guardrail)
    logger.error(`[pipeline] Stage "${stageName}" FAILED`, {
      trace_id: traceId,
      stage: stageName,
      status: "failed",
      duration_ms,
      error: error.message,
    });

    return stageResult;
  }
}

// ---------------------------------------------------------------------------
// Pipeline Orchestrator
// ---------------------------------------------------------------------------

export interface PipelineContext {
  trace_id: string;
  idempotency_key: string;
  shipment_id: string;
  document_id?: string;
  degraded_mode: boolean;
  stages: PipelineStageResult[];
  audit_trail: DocumentAuditTrail;
}

/**
 * Create a new pipeline context with a fresh trace ID and audit trail.
 */
export function createPipelineContext(shipmentId: string, idempotencyKey: string, documentId?: string): PipelineContext {
  const traceId = generateTraceId();
  return {
    trace_id: traceId,
    idempotency_key: idempotencyKey,
    shipment_id: shipmentId,
    document_id: documentId,
    degraded_mode: false,
    stages: [],
    audit_trail: {
      document_id: documentId || shipmentId,
      trace_id: traceId,
      timeline: [],
      field_history: {},
      rule_results: [],
      cross_validation: [],
      final_decision: {
        status: "needs_review",
        reason: "Pipeline in progress",
      },
    },
  };
}

/**
 * Run a stage with guardrails. If the stage fails, the pipeline stops.
 * If the stage is partial, degraded_mode is set to true for subsequent stages.
 */
export async function runStage<T>(
  ctx: PipelineContext,
  stageName: string,
  fn: () => Promise<{
    data: T | null;
    errors?: SystemException[];
    warnings?: SystemException[];
    missing_fields?: MissingField[];
  }>,
): Promise<PipelineStageResult<T>> {
  // Guardrail: if previous stage failed, skip this stage
  const previousFailed = ctx.stages.some((s) => s.status === "failed");
  if (previousFailed) {
    const skipped: PipelineStageResult<T> = {
      status: "skipped",
      stage: stageName,
      data: null,
      errors: [],
      warnings: [],
      meta: {
        duration_ms: 0,
        timestamp: new Date().toISOString(),
        version: PIPELINE_VERSIONS.orchestrator,
        trace_id: ctx.trace_id,
        idempotency_key: ctx.idempotency_key,
        degraded_mode: ctx.degraded_mode,
      },
    };
    ctx.stages.push(skipped);
    ctx.audit_trail.timeline.push({
      stage: stageName,
      status: "skipped",
      timestamp: skipped.meta.timestamp,
    });
    logger.warn(`[pipeline] Stage "${stageName}" SKIPPED (previous stage failed)`, {
      trace_id: ctx.trace_id,
    });
    return skipped;
  }

  // Execute the stage
  const result = await executeStage<T>(stageName, ctx.trace_id, ctx.idempotency_key, fn);

  // Update context
  ctx.stages.push(result);
  if (result.status === "partial") {
    ctx.degraded_mode = true;
  }

  // Update audit trail timeline
  ctx.audit_trail.timeline.push({
    stage: stageName,
    status: result.status,
    timestamp: result.meta.timestamp,
    duration_ms: result.meta.duration_ms,
  });

  return result;
}

/**
 * Finalize the pipeline: determine the final decision based on all stages.
 */
export function finalizePipeline(ctx: PipelineContext): {
  status: "approved" | "rejected" | "needs_review";
  reason: string;
} {
  const hasFailures = ctx.stages.some((s) => s.status === "failed");
  const hasErrors = ctx.stages.some((s) => s.errors.some((e) => e.severity === "error"));
  const hasMissingFields = ctx.stages.some((s) => (s.missing_fields || []).length > 0);

  let status: "approved" | "rejected" | "needs_review";
  let reason: string;

  if (hasFailures) {
    status = "rejected";
    reason = "Pipeline failed: one or more stages could not complete.";
  } else if (hasErrors || hasMissingFields || ctx.degraded_mode) {
    status = "needs_review";
    reason = ctx.degraded_mode
      ? "Pipeline completed in degraded mode. Some fields require manual review."
      : "Pipeline completed with errors or missing fields that require manual review.";
  } else {
    status = "approved";
    reason = "All pipeline stages completed successfully with no errors.";
  }

  ctx.audit_trail.final_decision = { status, reason };

  logger.info(`[pipeline] Finalized: ${status}`, {
    trace_id: ctx.trace_id,
    status,
    reason,
    stages: ctx.stages.length,
    degraded_mode: ctx.degraded_mode,
  });

  return { status, reason };
}

// ---------------------------------------------------------------------------
// Field History Tracker
// ---------------------------------------------------------------------------

/**
 * Track a field's value change through the pipeline stages.
 */
export function trackFieldHistory(
  ctx: PipelineContext,
  fieldKey: string,
  value: any,
  source: string,
  stage: string,
): void {
  if (!ctx.audit_trail.field_history[fieldKey]) {
    ctx.audit_trail.field_history[fieldKey] = [];
  }
  ctx.audit_trail.field_history[fieldKey].push({
    value,
    source,
    stage,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// UI Error Mapper
// ---------------------------------------------------------------------------

import type { UIError } from "./types";

/**
 * Convert pipeline results into UI-safe errors for the Exception Desk.
 */
export function mapToUIErrors(stageResults: PipelineStageResult[]): UIError[] {
  const uiErrors: UIError[] = [];

  for (const stage of stageResults) {
    // Map errors
    for (const err of stage.errors) {
      uiErrors.push({
        type: err.code.includes("MISSING") ? "missing_field" : "system_error",
        message: err.user_message || err.message,
        field: err.field_path,
        severity: err.severity === "error" ? "error" : "warning",
      });
    }

    // Map missing fields
    if (stage.missing_fields) {
      for (const mf of stage.missing_fields) {
        uiErrors.push({
          type: mf.reason === "missing" ? "missing_field" : "low_confidence",
          message: `Field "${mf.field}" is ${mf.reason.replace("_", " ")}.`,
          field: mf.field,
          severity: "warning",
        });
      }
    }
  }

  return uiErrors;
}

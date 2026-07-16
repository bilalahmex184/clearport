// ============================================================================
// ClearPort — Pipeline System Barrel Export
// ============================================================================
// Single import point for the entire pipeline contract system.
//
// Usage:
//   import { createPipelineContext, runStage, finalizePipeline, mapToUIErrors } from '@/lib/pipeline';
// ============================================================================

// Types
export type {
  StageStatus,
  PipelineStageResult,
  SystemException,
  MissingField,
  StageMeta,
  StageMetrics,
  ExtractedField,
  FieldHistory,
  RuleEvaluationResult,
  DecisionTrace,
  CrossValidationResult,
  SystemMetrics,
  AlertThresholds,
  DocumentAuditTrail,
  AuditTimelineEntry,
  UIError,
} from "./types";

export { PIPELINE_VERSIONS } from "./types";

// Orchestrator
export {
  generateTraceId,
  generateIdempotencyKey,
  executeStage,
  createPipelineContext,
  runStage,
  finalizePipeline,
  trackFieldHistory,
  mapToUIErrors,
  type PipelineContext,
} from "./orchestrator";

// Missing Field Detector
export {
  detectMissingFields,
  REQUIRED_FIELDS,
  RECOMMENDED_FIELDS,
} from "./missing-field-detector";

// Cross Validator
export {
  crossValidateSimple,
} from "./cross-validator";

// Metrics
export {
  computeMetrics,
  DEFAULT_THRESHOLDS,
} from "./metrics";

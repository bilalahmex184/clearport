// ============================================================================
// ClearPort — Global Pipeline Contract
// ============================================================================
// This file defines the types and runtime system that governs every stage
// of the document processing pipeline. It guarantees:
//   - No silent failures
//   - Every missing field explicitly tracked
//   - Every rule decision explainable
//   - Every pipeline step observable
//   - Every error visible to user
//   - Full audit trace per document
// ============================================================================

// ---------------------------------------------------------------------------
// 1. CORE TYPES
// ---------------------------------------------------------------------------

export type StageStatus = "success" | "partial" | "failed" | "skipped";

export interface PipelineStageResult<T = any> {
  status: StageStatus;
  stage: string;
  data: T | null;
  errors: SystemException[];
  warnings: SystemException[];
  missing_fields?: MissingField[];
  meta: StageMeta;
}

export interface SystemException {
  code: string;
  message: string;
  field_path?: string;
  severity: "error" | "warning";
  user_message?: string;     // UI-safe
  internal_message?: string; // debug only
}

export interface MissingField {
  field: string;
  reason: "missing" | "low_confidence" | "invalid_format";
  confidence?: number;
}

export interface StageMeta {
  duration_ms: number;
  timestamp: string;
  version: string;
  trace_id: string;              // correlation across system
  idempotency_key: string;
  degraded_mode: boolean;
  retry_count?: number;
  input_checksum?: string;       // detect duplicates
  raw_payload_uri?: string;
  metrics?: StageMetrics;
}

export interface StageMetrics {
  records_processed: number;
  error_count: number;
  warning_count: number;
}

// ---------------------------------------------------------------------------
// 2. EXTRACTION SYSTEM
// ---------------------------------------------------------------------------

export interface ExtractedField<T = any> {
  value: T | null;
  confidence: number;
  source: "gemini" | "ocr" | "user_override" | "fallback";
  raw_text: string;                // audit critical
  normalized: boolean;
  bbox?: {
    page: number;
    x: number;
    y: number;
    w: number;
    h: number;
  };
  extraction_version: string;      // model version
  parser_version: string;          // parsing logic version
  field_history?: FieldHistory[];  // lifecycle tracking
}

export interface FieldHistory {
  value: any;
  source: string;
  stage: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// 3. BUSINESS RULES ENGINE
// ---------------------------------------------------------------------------

export interface RuleEvaluationResult {
  rule_id: string;
  status: "passed" | "failed" | "skipped";
  severity: "error" | "warning";
  expected: any;
  actual: any;
  reason: string;
  execution_time_ms?: number;
  dependencies?: string[]; // fields used
  decision_trace?: DecisionTrace;
}

export interface DecisionTrace {
  fields_used: string[];
  evaluation_path: string[];
  final_outcome: string;
}

// ---------------------------------------------------------------------------
// 4. CROSS VALIDATION
// ---------------------------------------------------------------------------

export interface CrossValidationResult {
  field: string;
  sources: string[];
  values: any[];
  result: "match" | "mismatch" | "uncertain";
  tolerance?: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// 5. OBSERVABILITY
// ---------------------------------------------------------------------------

export interface SystemMetrics {
  extraction_success_rate: number;
  fallback_rate: number;
  missing_required_rate: number;
  rule_failure_rate: number;
}

export interface AlertThresholds {
  fallback_rate: number;          // e.g., > 0.2
  missing_required_rate: number;  // e.g., > 0.05
  rule_failure_rate: number;
}

// ---------------------------------------------------------------------------
// 6. AUDIT TRAIL
// ---------------------------------------------------------------------------

export interface DocumentAuditTrail {
  document_id: string;
  trace_id: string;
  timeline: AuditTimelineEntry[];
  field_history: Record<string, FieldHistory[]>;
  rule_results: RuleEvaluationResult[];
  cross_validation: CrossValidationResult[];
  final_decision: {
    status: "approved" | "rejected" | "needs_review";
    reason: string;
  };
}

export interface AuditTimelineEntry {
  stage: string;
  status: StageStatus;
  timestamp: string;
  duration_ms?: number;
}

// ---------------------------------------------------------------------------
// 7. UI ERROR MAPPING
// ---------------------------------------------------------------------------

export interface UIError {
  type: "missing_field" | "validation_error" | "low_confidence" | "system_error";
  message: string;
  field?: string;
  severity: "error" | "warning";
}

// ---------------------------------------------------------------------------
// 8. PIPELINE VERSIONS
// ---------------------------------------------------------------------------

export const PIPELINE_VERSIONS = {
  orchestrator: "1.0.0",
  extraction: "1.0.0",
  parser: "1.0.0",
  rules_engine: "1.0.0",
  cross_validation: "1.0.0",
  audit: "1.0.0",
} as const;

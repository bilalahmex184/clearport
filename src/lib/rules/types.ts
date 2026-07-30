// ============================================================================
// types.ts — Shared types for the rules engine (extracted from deprecated/pipeline/types.ts)
// These types are still used by src/lib/rules/engine.ts which is imported by
// the rules API route. They live here so we don't depend on /deprecated/.
// ============================================================================

export interface RuleEvaluationResult {
  rule_id: string;
  status: 'passed' | 'failed' | 'skipped';
  severity: 'error' | 'warning';
  expected: any;
  actual: any;
  reason: string;
  execution_time_ms?: number;
  dependencies?: string[];
  decision_trace?: DecisionTrace;
}

export interface DecisionTrace {
  fields_used: string[];
  evaluation_path: string[];
  final_outcome: string;
}

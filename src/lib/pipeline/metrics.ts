// ============================================================================
// ClearPort — Metrics + Alerting System
// ============================================================================
// Tracks system-wide metrics for observability and alerting.
// ============================================================================

import type { SystemMetrics, AlertThresholds, PipelineStageResult } from "./types";
import { logger } from "@/lib/utils/logger";

// Default alert thresholds
export const DEFAULT_THRESHOLDS: AlertThresholds = {
  fallback_rate: 0.2,          // > 20% fallback = alert
  missing_required_rate: 0.05, // > 5% missing required = alert
  rule_failure_rate: 0.15,     // > 15% rule failures = alert
};

/**
 * Compute system metrics from a batch of pipeline stage results.
 */
export function computeMetrics(
  stageResults: PipelineStageResult[],
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
): {
  metrics: SystemMetrics;
  alerts: string[];
} {
  const total = stageResults.length;
  if (total === 0) {
    return {
      metrics: {
        extraction_success_rate: 0,
        fallback_rate: 0,
        missing_required_rate: 0,
        rule_failure_rate: 0,
      },
      alerts: [],
    };
  }

  // Count by status
  const successes = stageResults.filter((s) => s.status === "success").length;
  const partials = stageResults.filter((s) => s.status === "partial").length;
  const failures = stageResults.filter((s) => s.status === "failed").length;

  // Count missing fields
  const stagesWithMissing = stageResults.filter((s) => (s.missing_fields || []).length > 0).length;

  // Count degraded mode (fallback used)
  const degraded = stageResults.filter((s) => s.meta.degraded_mode).length;

  // Count rule failures (stages with errors in rules engine)
  const ruleStages = stageResults.filter((s) => s.stage.includes("rule") || s.stage.includes("validation"));
  const ruleFailures = ruleStages.filter((s) => s.errors.length > 0).length;

  const metrics: SystemMetrics = {
    extraction_success_rate: (successes / total) * 100,
    fallback_rate: degraded / total,
    missing_required_rate: stagesWithMissing / total,
    rule_failure_rate: ruleStages.length > 0 ? ruleFailures / ruleStages.length : 0,
  };

  // Check thresholds
  const alerts: string[] = [];
  if (metrics.fallback_rate > thresholds.fallback_rate) {
    alerts.push(`Fallback rate ${(metrics.fallback_rate * 100).toFixed(1)}% exceeds threshold ${(thresholds.fallback_rate * 100).toFixed(1)}%`);
  }
  if (metrics.missing_required_rate > thresholds.missing_required_rate) {
    alerts.push(`Missing required field rate ${(metrics.missing_required_rate * 100).toFixed(1)}% exceeds threshold ${(thresholds.missing_required_rate * 100).toFixed(1)}%`);
  }
  if (metrics.rule_failure_rate > thresholds.rule_failure_rate) {
    alerts.push(`Rule failure rate ${(metrics.rule_failure_rate * 100).toFixed(1)}% exceeds threshold ${(thresholds.rule_failure_rate * 100).toFixed(1)}%`);
  }

  // Log alerts
  for (const alert of alerts) {
    logger.warn(`[metrics] ALERT: ${alert}`);
  }

  return { metrics, alerts };
}

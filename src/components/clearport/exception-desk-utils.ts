// ============================================================================
// exception-desk-utils.ts — Shared helpers for the ExceptionDesk panels
// ============================================================================
// Extracted from ExceptionDesk.tsx (FIX5-7-SPLIT — behavior-preserving).
//
// Tiny pure helpers used by both ExceptionList (left panel) and
// ResolutionPanel (right panel) to render confidence badges consistently.
// ============================================================================

/**
 * Returns Tailwind classes for the confidence pill color based on the
 * exception's confidence score:
 *   < 60  → red (critical)
 *   < 85  → amber (warning)
 *   >= 85 → green (compliant)
 */
export function getConfidenceColor(conf: number): string {
  if (conf < 60) return 'text-red-400 bg-red-950/40 border-red-900/50';
  if (conf < 85) return 'text-amber-400 bg-amber-950/40 border-amber-900/50';
  return 'text-green-400 bg-green-950/40 border-green-900/50';
}

/**
 * Returns the human-readable severity label for the confidence pill:
 *   < 60  → RED / CRITICAL
 *   < 85  → AMBER / WARNING
 *   >= 85 → GREEN / COMPLIANT
 */
export function getConfidenceBadge(conf: number): string {
  if (conf < 60) return 'RED / CRITICAL';
  if (conf < 85) return 'AMBER / WARNING';
  return 'GREEN / COMPLIANT';
}

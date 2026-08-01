// ============================================================================
// packages/shared/src/verbatim-anchor.ts — Deterministic ground-truth anchor
// ============================================================================
// WHAT THIS IS
//   The deterministic defense against adversarial extraction. For every field
//   the LLM returned with a `source` snippet (the exact verbatim quote it
//   CLAIMS the value came from), run a fuzzy substring match between that
//   snippet and the actual raw OCR/PDF text for the document. If no
//   sufficiently close match is found, do NOT trust the model's self-reported
//   confidence — force the field's effective confidence down below the
//   exception threshold regardless of what the model claimed, and tag the
//   exception reason as "source_not_verified" (distinct from low_confidence,
//   so reviewers can see this is a STRONGER signal — the model fabricated a
//   citation, not merely expressed uncertainty).
//
// WHY THIS EXISTS / WHY TWO-PASS IS NOT ENOUGH
//   Two-pass LLM re-verification does NOT defend against a crafted document,
//   because both passes read the same untrusted text through the same class
//   of model. A document that injects a fake value via prompt manipulation
//   will fool BOTH passes — they're both grading the same homework. This
//   check is the actual anchor to ground truth — it does not rely on asking
//   the LLM anything. It compares the model's CLAIMED source snippet to the
//   RAW TEXT the model was given. A fabricated source that doesn't appear
//   in the raw text is caught here, deterministically, with no prompt
//   engineering that can talk its way around it.
//
// RELATIONSHIP TO model-disagreement.ts
//   The supplementary model_disagreement check catches HONEST model
//   disagreement (one model hallucinated, the other didn't). It does NOT
//   catch a crafted document that fools both. THIS file (verbatim-anchor)
//   is the primary defense against adversarial input. See model-disagreement.ts
//   for the explicit "not primary" disclaimer.
// ============================================================================

import type { CanonicalField } from './extraction-schema';

// ---------------------------------------------------------------------------
// §1. The default similarity threshold for the verbatim-anchor check.
//     0.85 = 85% Levenshtein-normalized similarity. Tuned to tolerate common
//     OCR artifacts (a misread character or two) while rejecting fabricated
//     citations that share no common substring with the raw text.
// ---------------------------------------------------------------------------
export const VERBATIM_ANCHOR_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// §2. Result type returned by runVerbatimAnchorCheck.
// ---------------------------------------------------------------------------
export interface VerbatimAnchorResult {
  /** Field keys whose source snippet was verified against the raw text. */
  verified: string[];
  /** Fields whose claimed source snippet could NOT be found in the raw text. */
  unverified: Array<{
    field_key: string;
    claimed_source: string;
    model_confidence: number;
    effective_confidence: number;
  }>;
  /** Exceptions to surface (source_not_verified, severity MAJOR). */
  exceptions: Array<{
    field_key: string;
    reason: string;
    severity: 'MAJOR';
    exception_type: 'source_not_verified';
  }>;
}

// ---------------------------------------------------------------------------
// §3. normalizeWhitespace — collapse runs of whitespace to a single space and
//     trim. OCR/PDF text extraction frequently inserts newlines, tabs, and
//     double-spaces mid-phrase ("Invoice\nNumber: INV-001"). Without
//     normalization these would cause false negatives: the model's source
//     snippet ("Invoice Number: INV-001") wouldn't match the raw text even
//     though the difference is purely an artifact of the extraction process,
//     not a fabrication.
// ---------------------------------------------------------------------------
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// §4. levenshtein — classic edit distance, O(n*m) time, O(min(n,m)) space.
//     Used by both fuzzySubstringContains (this file) and the supplementary
//     model-disagreement check (model-disagreement.ts has its own copy —
//     intentionally duplicated to keep the two modules decoupled, since
//     model-disagreement is a self-contained supplementary check).
// ---------------------------------------------------------------------------
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep `a` as the shorter string to minimize the row buffer size.
  if (a.length > b.length) {
    [a, b] = [b, a];
  }
  const aLen = a.length;
  const bLen = b.length;

  let prev = new Array<number>(aLen + 1);
  let curr = new Array<number>(aLen + 1);

  for (let i = 0; i <= aLen; i++) prev[i] = i;

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    const bChar = b.charCodeAt(j - 1);
    for (let i = 1; i <= aLen; i++) {
      const cost = a.charCodeAt(i - 1) === bChar ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1, // deletion from a
        curr[i - 1] + 1, // insertion into a
        prev[i - 1] + cost, // substitution
      );
    }
    // Swap buffers — prev becomes the just-computed row for the next iter.
    [prev, curr] = [curr, prev];
  }

  return prev[aLen];
}

// ---------------------------------------------------------------------------
// §5. fuzzySubstringContains — the core matcher.
//
//     For every window of `needle.length` in `haystack`, compute the
//     Levenshtein distance between that window and `needle`, normalize to a
//     0-1 similarity score (1 - distance / needle.length), and return true
//     if ANY window meets or exceeds the threshold.
//
//     Normalization (whitespace collapse + lowercase) is applied to both
//     inputs BEFORE matching, so OCR line-break artifacts and case variation
//     don't cause false negatives.
//
//     Optimization: if `needle` is longer than `haystack`, the maximum
//     achievable similarity is `haystack.length / needle.length` (you'd need
//     at least `needle.length - haystack.length` insertions to align them).
//     If that upper bound is below the threshold, skip the work and return
//     false. If the upper bound meets the threshold, fall through and compute
//     the actual distance against the full haystack (treating the whole
//     haystack as a single short window).
// ---------------------------------------------------------------------------
export function fuzzySubstringContains(
  haystack: string,
  needle: string,
  threshold: number = VERBATIM_ANCHOR_THRESHOLD,
): boolean {
  const h = normalizeWhitespace(haystack).toLowerCase();
  const n = normalizeWhitespace(needle).toLowerCase();

  // Edge cases.
  if (n.length === 0) return true; // empty needle trivially "contained"
  if (h.length === 0) return false; // non-empty needle can't be in empty haystack

  // Optimization: needle longer than haystack — similarity is bounded above
  // by haystack.length / needle.length. If that's below threshold, no match.
  if (n.length > h.length) {
    const maxSimilarity = h.length / n.length;
    if (maxSimilarity < threshold) return false;
    // Upper bound meets threshold — compute the actual similarity against
    // the full haystack (which is shorter than the needle). Use needle.length
    // as the denominator to keep the normalization consistent.
    const dist = levenshtein(h, n);
    const similarity = 1 - dist / n.length;
    return similarity >= threshold;
  }

  // Sliding window of size needle.length across haystack.
  const windowSize = n.length;
  const lastStart = h.length - windowSize;
  for (let i = 0; i <= lastStart; i++) {
    const window = h.substring(i, i + windowSize);
    // Fast path: identical substring (no edit distance work needed).
    if (window === n) return true;
    const dist = levenshtein(window, n);
    // windowSize === n.length here, so denominator is unambiguous.
    const similarity = 1 - dist / windowSize;
    if (similarity >= threshold) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// §6. runVerbatimAnchorCheck — the public entry point.
//
//     For each field with a non-empty `source` snippet, run
//     fuzzySubstringContains(rawText, field.source, threshold).
//       - Verified  → field key added to `verified[]`, confidence untouched.
//       - Unverified → field added to `unverified[]` with effective_confidence
//                      FORCED DOWN to min(model_confidence, 20) — well below
//                      any exception threshold (75-85%), so it WILL be flagged
//                      downstream regardless of what the model claimed. An
//                      exception with `exception_type: 'source_not_verified'`,
//                      `severity: 'MAJOR'` is also raised.
//
//     Fields WITHOUT a `source` snippet are NOT checked — they pass through
//     with their original confidence. The anchor only applies to fields where
//     the LLM made a VERIFIABLE claim (it cited a source). Fields with no
//     source are still subject to the normal low_confidence threshold; this
//     check just doesn't add a stronger signal for them.
// ---------------------------------------------------------------------------
export function runVerbatimAnchorCheck(
  fields: CanonicalField[],
  rawText: string,
  threshold: number = VERBATIM_ANCHOR_THRESHOLD,
): VerbatimAnchorResult {
  const result: VerbatimAnchorResult = {
    verified: [],
    unverified: [],
    exceptions: [],
  };

  for (const field of fields) {
    // Skip fields with no verifiable claim — the anchor doesn't apply.
    if (!field.source || field.source.trim().length === 0) continue;

    const isVerified = fuzzySubstringContains(rawText, field.source, threshold);

    if (isVerified) {
      result.verified.push(field.field_key);
      continue;
    }

    // Unverified: force effective confidence down below any exception
    // threshold (75-85%). 20 is well below all of them. Use Math.min so
    // we never RAISE a confidence the model already scored low — if the
    // model said 10, we keep 10 (still flagged, just not artificially
    // bumped up).
    const effectiveConfidence = Math.min(field.confidence, 20);

    result.unverified.push({
      field_key: field.field_key,
      claimed_source: field.source,
      model_confidence: field.confidence,
      effective_confidence: effectiveConfidence,
    });

    result.exceptions.push({
      field_key: field.field_key,
      reason: `LLM-claimed source snippet not found in raw text (similarity below ${threshold * 100}%)`,
      severity: 'MAJOR',
      exception_type: 'source_not_verified',
    });
  }

  return result;
}

// ============================================================================
// packages/shared/src/model-disagreement.ts — Supplementary (NOT primary)
// ============================================================================
// WHAT THIS IS
//   A supplementary second-pass reconciliation check. Re-run extraction on
//   ambiguous/low-confidence fields only (to control cost) with a different
//   model from the fallback list, and flag a "model_disagreement" exception
//   if the two extractions differ materially on a shared field.
//
//   For each field present in BOTH the primary and secondary extractions,
//   compute a Levenshtein-normalized string similarity. If similarity falls
//   below the threshold (default 0.80), raise a model_disagreement exception
//   with severity MINOR — it's a signal worth a reviewer's attention, but
//   not a proof of error (one model may have legitimately extracted a
//   differently-formatted but equivalent value, e.g. "USD 100" vs "$100.00").
//
// ==========================================================================
// IMPORTANT: This is supplementary. The verbatim-anchor check
// (verbatim-anchor.ts) is the primary defense against adversarial input.
// Do NOT present this second pass as sufficient on its own.
// ==========================================================================
//
// WHY IT'S NOT SUFFICIENT ON ITS OWN
//   Two-pass LLM re-verification does NOT defend against a crafted document,
//   because both passes read the SAME untrusted text through the SAME CLASS
//   of model. A document that injects a fake value via prompt manipulation
//   will likely fool BOTH passes — they're both grading the same homework.
//   The verbatim-anchor check (verbatim-anchor.ts) is the one doing the real
//   work against adversarial input: it compares the model's CLAIMED source
//   snippet to the RAW TEXT the model was given, deterministically, with no
//   prompt engineering that can talk its way around it.
//
//   This check catches HONEST model disagreement (one model hallucinated,
//   the other didn't, on an otherwise-legitimate document). It does NOT
//   catch a crafted document that fools both. Always run BOTH checks; never
//   substitute this for verbatim-anchor.
// ============================================================================

import type { CanonicalField } from './extraction-schema';

// ---------------------------------------------------------------------------
// §1. Default disagreement threshold. Lower than the verbatim-anchor
//     threshold (0.85) because the inputs are SHORT field values (not long
//     snippets), and we only want to flag MATERIAL disagreement, not
//     formatting differences ("USD 100" vs "$100.00" should not trigger).
// ---------------------------------------------------------------------------
export const MODEL_DISAGREEMENT_THRESHOLD = 0.80;

// ---------------------------------------------------------------------------
// §2. Result type.
// ---------------------------------------------------------------------------
export interface ModelDisagreementResult {
  disagreements: Array<{
    field_key: string;
    primary_value: string;
    secondary_value: string;
    similarity: number;
  }>;
  exceptions: Array<{
    field_key: string;
    reason: string;
    severity: 'MINOR';
    exception_type: 'model_disagreement';
  }>;
}

// ---------------------------------------------------------------------------
// §3. normalizeWhitespace + levenshtein — local copies (intentionally
//     duplicated from verbatim-anchor.ts) so this module is self-contained
//     and decoupled. The two modules share an algorithm, not a dependency.
//     If the algorithm changes, change BOTH (or refactor into a shared util
//     — for now the duplication is two ~15-line functions, the lesser evil).
// ---------------------------------------------------------------------------
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
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
        prev[i] + 1,
        curr[i - 1] + 1,
        prev[i - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[aLen];
}

// ---------------------------------------------------------------------------
// §4. stringSimilarity — direct (non-substring) similarity between two
//     field values. Same Levenshtein normalization as verbatim-anchor uses
//     for its substring windows: 1 - distance / max(len(a), len(b)).
//     Whitespace-normalized + lowercased before comparison so "USD 100"
//     vs "usd  100" (extra space) is treated as identical.
// ---------------------------------------------------------------------------
function stringSimilarity(a: string, b: string): number {
  const na = normalizeWhitespace(a).toLowerCase();
  const nb = normalizeWhitespace(b).toLowerCase();
  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

// ---------------------------------------------------------------------------
// §5. checkModelDisagreement — compare two sets of extracted fields.
//
//     Takes primaryFields and secondaryFields (both CanonicalField[]). For
//     each field_key present in BOTH, compute stringSimilarity(primary.value,
//     secondary.value). If similarity < threshold, add to `disagreements`
//     and raise a MINOR model_disagreement exception.
//
//     Fields present in only ONE of the two sets are NOT flagged here —
//     "missing in one extraction" is a different signal (handled by the
//     missing_field exception type elsewhere). This check is purely about
//     VALUE disagreement on fields both models attempted.
// ---------------------------------------------------------------------------
export function checkModelDisagreement(
  primaryFields: CanonicalField[],
  secondaryFields: CanonicalField[],
  threshold: number = MODEL_DISAGREEMENT_THRESHOLD,
): ModelDisagreementResult {
  const secondaryByKey = new Map<string, CanonicalField>();
  for (const f of secondaryFields) {
    secondaryByKey.set(f.field_key, f);
  }

  const result: ModelDisagreementResult = {
    disagreements: [],
    exceptions: [],
  };

  for (const primary of primaryFields) {
    const secondary = secondaryByKey.get(primary.field_key);
    if (!secondary) continue; // only compare fields present in BOTH

    const similarity = stringSimilarity(
      String(primary.value ?? ''),
      String(secondary.value ?? ''),
    );

    if (similarity < threshold) {
      result.disagreements.push({
        field_key: primary.field_key,
        primary_value: String(primary.value ?? ''),
        secondary_value: String(secondary.value ?? ''),
        similarity,
      });
      result.exceptions.push({
        field_key: primary.field_key,
        reason: `Primary and secondary extractions disagree (similarity ${(similarity * 100).toFixed(1)}% < ${(threshold * 100)}%)`,
        severity: 'MINOR',
        exception_type: 'model_disagreement',
      });
    }
  }

  return result;
}

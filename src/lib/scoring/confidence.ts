// ============================================================================
// confidence.ts — Confidence scoring engine
// ============================================================================
// Combines AI confidence + validation errors + uncertain fields into a
// single 0-100 score that determines whether a document is "clean" or
// "needs_review".
//
// Formula:
//   score = ai_confidence × 100
//   score -= len(validation_errors) × 15
//   score -= len(uncertain_fields) × 10
//   score = max(0, min(100, score))
//
// Threshold:
//   ≥ 85 → "clean" (auto-approve)
//   60-84 → "needs_review" (human checks)
//   < 60 → "needs_review" (low confidence, likely bad extraction)
// ============================================================================

export interface ConfidenceInput {
  /** AI model's own confidence (0-1) from the meta.overall_confidence field */
  aiConfidence: number;
  /** Validation errors from the validation layer */
  validationErrors: string[];
  /** Fields the AI marked as uncertain (from meta.uncertain_fields or missing_fields) */
  uncertainFields: string[];
  /** OCR confidence estimate (0-1) from postprocess.estimateOcrConfidence */
  ocrConfidence?: number;
}

export interface ConfidenceResult {
  score: number;           // 0-100
  status: 'clean' | 'needs_review';
  breakdown: {
    aiScore: number;
    validationPenalty: number;
    uncertainPenalty: number;
    ocrPenalty: number;
    finalScore: number;
  };
}

const CLEAN_THRESHOLD = 85;
const VALIDATION_PENALTY = 15;
const UNCERTAIN_PENALTY = 10;
const OCR_PENALTY = 20; // Applied when OCR confidence < 0.5

/**
 * Calculate the final confidence score for an extraction.
 *
 * @returns { score, status, breakdown }
 */
export function calculateConfidence(input: ConfidenceInput): ConfidenceResult {
  // Start with AI confidence (0-1 → 0-100)
  let score = input.aiConfidence * 100;

  const aiScore = score;
  const validationPenalty = input.validationErrors.length * VALIDATION_PENALTY;
  const uncertainPenalty = input.uncertainFields.length * UNCERTAIN_PENALTY;

  // OCR quality penalty: if OCR confidence is low, the whole extraction is suspect
  let ocrPenalty = 0;
  if (input.ocrConfidence !== undefined && input.ocrConfidence < 0.5) {
    ocrPenalty = OCR_PENALTY;
  }

  score -= validationPenalty;
  score -= uncertainPenalty;
  score -= ocrPenalty;

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    status: score >= CLEAN_THRESHOLD ? 'clean' : 'needs_review',
    breakdown: {
      aiScore: Math.round(aiScore),
      validationPenalty,
      uncertainPenalty,
      ocrPenalty,
      finalScore: score,
    },
  };
}

/**
 * Smart mode switch: decide whether to skip the AI (Gemini) layer.
 *
 * If OCR confidence is very high (> 0.9) AND the text has clear field
 * patterns, regex extraction alone may be sufficient — skip the AI call
 * entirely to save time + API quota.
 *
 * Returns true if AI should be skipped (regex-only extraction is sufficient).
 */
export function shouldSkipAi(
  ocrConfidence: number,
  hasClearPatterns: boolean,
): boolean {
  // Only skip if OCR is very clean AND patterns are clearly detectable
  return ocrConfidence > 0.9 && hasClearPatterns;
}

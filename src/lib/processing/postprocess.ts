// ============================================================================
// postprocess.ts — OCR text cleanup before AI structuring
// ============================================================================
// Cleans up common OCR artifacts before the text is sent to Gemini:
//   - Fix broken words (e.g. "inv0ice" → "invoice", "0" → "o" in words)
//   - Remove random symbols/noise
//   - Merge split numbers (e.g. "5 2,150" → "52,150")
//   - Normalize spacing (collapse multiple spaces/newlines)
//   - Fix common OCR character substitutions
// ============================================================================

// Common OCR character substitutions (order matters — longer patterns first)
const OCR_FIXES: Array<[RegExp, string | null]> = [
  // Number-in-word fixes (0 → o, 1 → l, 5 → s) — only in word context
  [/\binv0ice\b/gi, 'invoice'],
  [/\bInv0ice\b/g, 'Invoice'],
  [/\bshipper\b/gi, 'shipper'],
  [/\bsh1pper\b/gi, 'shipper'],
  [/\bcons1gnee\b/gi, 'consignee'],
  [/\b0r1gin\b/gi, 'origin'],
  [/\btar1ff\b/gi, 'tariff'],
  [/\bquantrty\b/gi, 'quantity'],
  [/\bdescr1pt1on\b/gi, 'description'],

  // Merge split numbers: "5 2,150" → "52,150", "1 234" → "1234"
  [/(?<=\d)\s+(?=\d{3}(?:[,.\s]|$))/g, ''],

  // Fix common currency splits: "$ 52,150" → "$52,150"
  [/\$\s+(\d)/g, '$$$1'],

  // Remove non-printable noise characters
  [/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''],

  // Collapse multiple spaces (but keep newlines)
  [/[ \t]{2,}/g, ' '],

  // Collapse 3+ newlines to 2
  [/\n{3,}/g, '\n\n'],

  // Fix tab characters in the middle of lines
  [/\t/g, ' '],
];

/**
 * Clean up OCR text before sending to the AI structuring layer.
 * Fixes common OCR artifacts that confuse LLMs.
 */
export function postprocessOcrText(rawText: string): string {
  if (!rawText) return '';

  let cleaned = rawText;

  for (const [pattern, replacement] of OCR_FIXES) {
    cleaned = cleaned.replace(pattern, replacement ?? '');
  }

  // Trim leading/trailing whitespace
  return cleaned.trim();
}

/**
 * Quick heuristic: estimate OCR quality from the raw text.
 * Returns 0-1 confidence based on:
 *   - Ratio of alphanumeric chars to total
 *   - Presence of common OCR garbage patterns
 *   - Average word length (very short words = bad OCR)
 */
export function estimateOcrConfidence(text: string): number {
  if (!text || text.length < 10) return 0.1;

  const totalChars = text.length;
  const alphaNumeric = (text.match(/[a-zA-Z0-9]/g) || []).length;
  const ratio = alphaNumeric / totalChars;

  // Count common OCR garbage indicators
  const garbagePatterns = [
    /[|\\\/]{3,}/g,      // Pipe/slash runs
    /[~`]{2,}/g,          // Tilde/backtick runs
    /[\x00-\x1f]{2,}/g,   // Control character runs
    /[^\x20-\x7E\n\r]{3,}/g, // Non-ASCII runs (mojibake)
  ];

  let garbageCount = 0;
  for (const pattern of garbagePatterns) {
    garbageCount += (text.match(pattern) || []).length;
  }

  // Average word length
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const avgWordLength = words.length > 0
    ? words.reduce((sum, w) => sum + w.length, 0) / words.length
    : 0;

  // Score: start with alphanumeric ratio, penalize garbage + short words
  let score = ratio;
  score -= garbageCount * 0.05;
  if (avgWordLength < 2) score -= 0.2;
  if (avgWordLength < 1.5) score -= 0.2;

  return Math.max(0, Math.min(1, score));
}

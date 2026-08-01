// packages/shared/src/constants.ts — Business rule constants
// Single definition of HTS field sets, confidence thresholds, etc.
// These were previously duplicated between supabase/functions/ and src/app/api/internal/.

export const HTS_FIELDS = new Set([
  'htsCode', 'htsCodes', 'hts', 'hs_codes',
]);

export const PARTIES_FIELDS = new Set([
  'shipper', 'consignee', 'consigneeAddress', 'shipperAddress',
  'notifyParty', 'shipper_name', 'consignee_name',
]);

export const DEFAULT_THRESHOLDS = {
  invoice_threshold: 80,
  hts_threshold: 85,
  parties_threshold: 75,
} as const;

// NOTE: MAX_FILE_SIZE_BYTES used to live here as `50 * 1024 * 1024` (50MB).
// It has been superseded by the canonical 20MB server-side limit in
// `./file-validation.ts` (which matches the `documents` bucket
// `file_size_limit` set in supabase/migrations/016_bucket_size_limit.sql).
// Import MAX_FILE_SIZE_BYTES from './file-validation' going forward.
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/tiff',
  'text/plain',
  'text/csv',
] as const;

export const EXTRACTION_DEADLINE_MS = 30_000; // 30s for single-pass AI extraction
export const MAX_RETRIES = 3;
export const DEAD_LETTER_THRESHOLD = 3;

export const SEVERITY_LEVELS = {
  CRITICAL: 3,
  MAJOR: 2,
  MINOR: 1,
} as const;

export const DECISION_THRESHOLDS = {
  DOC_QUALITY_REJECT: 0.6,
  CONFIDENCE_AUTO_APPROVE: 0.85,
  WEIGHT_TOLERANCE_PCT: 2.0,
  VALUE_TOLERANCE_PCT: 0.1,
} as const;

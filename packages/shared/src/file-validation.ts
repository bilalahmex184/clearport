// ============================================================================
// packages/shared/src/file-validation.ts
// ----------------------------------------------------------------------------
// Server-side file validation: size limits + magic-byte MIME signature
// verification + extension/signature consistency.
//
// WHY CLIENT-SIDE VALIDATION IS INSUFFICIENT
// ------------------------------------------
// Client-side validation (File API `size`, `type` properties, accept="..."
// attributes) is the FIRST line of defense but CANNOT be the only one:
//
//   1. `File.type` is taken from the OS / file extension — trivially spoofable
//      with `curl --data-binary`, a hand-crafted multipart body, or even a
//      renamed file. A client can claim `application/pdf` while shipping an
//      HTML payload, an EXE, or a polyglot file designed to exploit a
//      downstream parser (pdfjs-dist, Sharp, the AI extraction pipeline).
//   2. The browser `accept="..."` attribute is advisory only — every major
//      browser allows the user to override it via the file picker.
//   3. Supabase Storage does NOT validate content against the declared MIME
//      type. The 20MB `file_size_limit` on the `documents` bucket (see
//      supabase/migrations/016_bucket_size_limit.sql) only caps the byte
//      COUNT, not the content TYPE. A 1MB EXE named invoice.pdf is happily
//      accepted by Storage today.
//   4. Bugs in client code (e.g. a missed accept attribute, a stale allowlist)
//      silently let bad data into the system with no server-side backstop.
//
// This module is the SERVER-SIDE gate. It runs in the ingress Cloudflare
// Worker (and/or the Next.js /api upload route) BEFORE any storage PUT or
// DB row insert. If a check fails, the request is rejected with the
// appropriate 4xx status — no bytes ever touch Supabase Storage, no row is
// ever written to `documents`.
//
// MAGIC BYTE SIGNATURES RECOGNIZED
// ---------------------------------
//   PDF  : 25 50 44 46                            ("%PDF")
//   PNG  : 89 50 4E 47                            ("\x89PNG")
//   JPEG : FF D8 FF                               (SOI + start-of-marker)
//   TIFF : 49 49 2A 00  (little-endian, "II*\0")  OR
//          4D 4D 00 2A  (big-endian,    "MM\0*")
//
// Only the first 8 bytes are inspected — enough to cover all signatures
// above (TIFF big-endian is the longest at 4 bytes; we read 8 for future
// expansion room and to match common implementations).
//
// EXECUTION ORDER (validateUploadedFile)
// ---------------------------------------
//   1. validateFileSize        — cheapest check; rejects 0-byte / oversized
//   2. validateMagicBytes      — verifies actual content type
//   3. validateExtensionConsistency — cross-checks declared extension vs MIME
//
// The first failure short-circuits and throws. On success, the detected
// canonical mimeType is returned to the caller — this is the value to
// persist on the `documents` DB row, NOT whatever the client claimed.
//
// ISOMORPHIC CONSTRAINT
// ---------------------
// This file MUST run in BOTH the Cloudflare Worker runtime (no Node `fs`,
// `path`, `crypto`, `Buffer`) and the Next.js Node runtime. We therefore
// use only standard `Uint8Array` / `ArrayBuffer` APIs and pure arithmetic.
// ============================================================================

/**
 * Maximum allowed upload size — matches the `documents` bucket
 * `file_size_limit` set in supabase/migrations/016_bucket_size_limit.sql
 * (20 * 1024 * 1024 = 20MB). Anything larger is rejected with HTTP 413
 * BEFORE any storage write is attempted.
 */
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Error codes raised by file-validation checks. Each maps to a canonical
 * HTTP status (see {@link FILE_VALIDATION_STATUS_CODES}).
 */
export type FileValidationErrorCode =
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNKNOWN_FILE_TYPE'
  | 'EXTENSION_MISMATCH';

/** HTTP status code for each error code. */
const FILE_VALIDATION_STATUS_CODES: Record<FileValidationErrorCode, number> = {
  // 400 Bad Request — empty payload is a client error, not a size issue.
  EMPTY_FILE: 400,
  // 413 Payload Too Large — matches RFC 7231 §6.5.11.
  FILE_TOO_LARGE: 413,
  // 415 Unsupported Media Type — matches RFC 7231 §6.5.13.
  UNKNOWN_FILE_TYPE: 415,
  // 415 Unsupported Media Type — extension/MIME mismatch is conceptually
  // the same class of error as an unknown content type.
  EXTENSION_MISMATCH: 415,
};

/**
 * Error thrown by every `validate*` function in this module. Carries an
 * HTTP `statusCode` so the calling route / Worker can translate directly
 * to a 4xx response without re-mapping.
 *
 * Usage in a Next.js route handler:
 * ```ts
 * try {
 *   const { mimeType } = validateUploadedFile(file);
 * } catch (e) {
 *   if (e instanceof FileValidationError) {
 *     return NextResponse.json({ error: e.message, code: e.code }, { status: e.statusCode });
 *   }
 *   throw e;
 * }
 * ```
 */
export class FileValidationError extends Error {
  readonly code: FileValidationErrorCode;
  readonly statusCode: number;

  constructor(code: FileValidationErrorCode, message: string) {
    super(message);
    this.name = 'FileValidationError';
    this.code = code;
    this.statusCode = FILE_VALIDATION_STATUS_CODES[code];
    // Restore prototype chain after transpilation — required for
    // `instanceof FileValidationError` to work in bundled output
    // (Next.js webpack / esbuild both strip the prototype otherwise).
    Object.setPrototypeOf(this, FileValidationError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 1. Size validation
// ---------------------------------------------------------------------------

/**
 * Reject empty payloads (`size === 0`) and oversized payloads
 * (`size > MAX_FILE_SIZE_BYTES`).
 *
 * Throws {@link FileValidationError} on failure:
 *   - `EMPTY_FILE`     (HTTP 400) if size is 0, negative, NaN, or Infinity
 *   - `FILE_TOO_LARGE` (HTTP 413) if size exceeds 20MB
 *
 * Returns `void` on success.
 */
export function validateFileSize(size: number): void {
  // Guard against NaN / Infinity / negative — all treated as empty/invalid.
  if (!Number.isFinite(size) || size <= 0) {
    throw new FileValidationError(
      'EMPTY_FILE',
      'Uploaded file is empty (0 bytes).',
    );
  }
  if (size > MAX_FILE_SIZE_BYTES) {
    throw new FileValidationError(
      'FILE_TOO_LARGE',
      `Uploaded file size ${size} bytes exceeds the ${MAX_FILE_SIZE_BYTES}-byte (20MB) limit.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Magic-byte MIME signature validation
// ---------------------------------------------------------------------------

/**
 * A known file signature: the canonical mimeType, the canonical file
 * extension (short form, e.g. `.pdf`), and one or more alternative
 * leading-byte prefixes that identify the format.
 *
 * TIFF has two endianness variants (little-endian `II*\0` and big-endian
 * `MM\0*`), hence `magicBytes` is an array of arrays.
 */
export interface MimeSignature {
  /** Canonical MIME type — what we treat the file as for downstream routing. */
  mimeType: string;
  /**
   * Canonical extension (short form): `.pdf`, `.png`, `.jpg`, `.tif`.
   * Long-form aliases (`.jpeg`, `.tiff`) are accepted at validation time
   * via {@link EXTENSION_ALIASES} but never written here — the canonical
   * form is what we persist to the DB.
   */
  extension: string;
  /**
   * One or more alternative leading-byte prefixes. A file matches if its
   * first N bytes equal ANY of the prefixes (where N is the prefix length).
   */
  magicBytes: number[][];
}

/**
 * Recognized file signatures, keyed by a short canonical name. The keys
 * are stable identifiers used in tests and logging; they are NOT user-facing.
 *
 * Adding a new supported file type = adding one entry here. The detection
 * and validation functions automatically pick it up.
 */
export const MIME_SIGNATURES: Record<string, MimeSignature> = {
  PDF: {
    mimeType: 'application/pdf',
    extension: '.pdf',
    magicBytes: [[0x25, 0x50, 0x44, 0x46]], // "%PDF"
  },
  PNG: {
    mimeType: 'image/png',
    extension: '.png',
    magicBytes: [[0x89, 0x50, 0x4e, 0x47]], // "\x89PNG"
  },
  JPEG: {
    mimeType: 'image/jpeg',
    extension: '.jpg',
    magicBytes: [[0xff, 0xd8, 0xff]], // SOI (FF D8) + marker start (FF)
  },
  TIFF: {
    mimeType: 'image/tiff',
    extension: '.tif',
    magicBytes: [
      [0x49, 0x49, 0x2a, 0x00], // little-endian: "II*\0"
      [0x4d, 0x4d, 0x00, 0x2a], // big-endian:    "MM\0*"
    ],
  },
};

/**
 * Long-form extension aliases that should also be accepted for each
 * canonical short form. Used only in {@link validateExtensionConsistency}
 * — never written to {@link MIME_SIGNATURES} so the canonical `extension`
 * field stays the short form (`.jpg`, `.tif`).
 */
const EXTENSION_ALIASES: Record<string, string[]> = {
  '.jpg': ['.jpeg'],
  '.tif': ['.tiff'],
};

/**
 * Returns true if `prefix` is a leading subsequence of `bytes`.
 * Pure, isomorphic — no Node `Buffer` or `crypto.timingSafeEqual`.
 */
function bytesStartWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (prefix.length === 0) return true;
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Detect the MIME type of a file by inspecting its leading magic bytes.
 *
 * Reads only the first 8 bytes (in practice the caller passes the whole
 * file; we never inspect past byte 8). Returns the canonical mimeType on
 * match, or `null` if:
 *   - the buffer is null/undefined/empty
 *   - no known signature matches
 *
 * Handles short buffers (less than 8 bytes) gracefully — a 3-byte JPEG
 * prefix will still match because `bytesStartWith` only requires the
 * prefix length, not the full 8 bytes.
 */
export function detectMimeFromBytes(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length === 0) return null;
  for (const sig of Object.values(MIME_SIGNATURES)) {
    for (const prefix of sig.magicBytes) {
      if (bytesStartWith(bytes, prefix)) {
        return sig.mimeType;
      }
    }
  }
  return null;
}

/**
 * Reject payloads whose leading bytes don't match any known signature.
 * Throws {@link FileValidationError} with code `UNKNOWN_FILE_TYPE`
 * (HTTP 415) on failure; returns `void` on success.
 *
 * This is the primary defense against renamed-EXE / polyglot attacks —
 * the file's ACTUAL bytes must begin with a recognized magic sequence,
 * regardless of what the client declared in `Content-Type` or the
 * multipart filename.
 */
export function validateMagicBytes(bytes: Uint8Array): void {
  const detected = detectMimeFromBytes(bytes);
  if (detected === null) {
    throw new FileValidationError(
      'UNKNOWN_FILE_TYPE',
      'Uploaded file does not match any known magic-byte signature (PDF, PNG, JPEG, TIFF).',
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Extension/signature consistency
// ---------------------------------------------------------------------------

/**
 * Lower-cased file extension including the leading dot, e.g. `.pdf`.
 * Returns `''` if the file name has no extension.
 *
 * Implemented manually (not Node `path.extname`) to stay isomorphic.
 * Handles both POSIX (`/`) and Windows (`\`) path separators.
 */
function extractExtension(fileName: string): string {
  const lastSlash = Math.max(
    fileName.lastIndexOf('/'),
    fileName.lastIndexOf('\\'),
  );
  const baseName = lastSlash >= 0 ? fileName.slice(lastSlash + 1) : fileName;
  const lastDot = baseName.lastIndexOf('.');
  // lastDot <= 0 covers dotfiles (`.bashrc`) and no-extension cases.
  // lastDot === length-1 covers trailing-dot cases (`foo.`).
  if (lastDot <= 0 || lastDot === baseName.length - 1) return '';
  return baseName.slice(lastDot).toLowerCase();
}

/**
 * Reject files whose declared extension doesn't match the MIME type that
 * {@link detectMimeFromBytes} returned from the actual bytes.
 *
 * Catches the classic "rename evil.exe to invoice.pdf" attack: even if the
 * bytes happen to start with `%PDF`, an EXE would fail this check. More
 * importantly, it catches the inverse — a real PDF named `invoice.png`
 * would be misrouted by downstream code that switches on extension.
 *
 * Case-insensitive on the extension. Accepts long-form aliases:
 *   - `.jpeg` for `.jpg`
 *   - `.tiff` for `.tif`
 *
 * Throws {@link FileValidationError} with code `EXTENSION_MISMATCH`
 * (HTTP 415) on failure; returns `void` on success.
 */
export function validateExtensionConsistency(
  fileName: string,
  detectedMimeType: string,
): void {
  const ext = extractExtension(fileName);
  if (ext === '') {
    // No extension at all is treated as a mismatch — every supported
    // format has a canonical extension, and extension-less uploads are
    // a strong signal of an automated / malicious client.
    throw new FileValidationError(
      'EXTENSION_MISMATCH',
      `File name "${fileName}" has no recognizable extension matching detected MIME type "${detectedMimeType}".`,
    );
  }

  // Find the signature whose mimeType matches the detected one.
  const matchingSig = Object.values(MIME_SIGNATURES).find(
    (s) => s.mimeType === detectedMimeType,
  );

  if (!matchingSig) {
    // Shouldn't happen if the caller passed a value from
    // detectMimeFromBytes, but guard against misuse.
    throw new FileValidationError(
      'EXTENSION_MISMATCH',
      `Detected MIME type "${detectedMimeType}" has no known canonical extension.`,
    );
  }

  const canonical = matchingSig.extension.toLowerCase();
  const aliases = (EXTENSION_ALIASES[canonical] ?? []).map((a) =>
    a.toLowerCase(),
  );
  const acceptedExtensions = [canonical, ...aliases];

  if (!acceptedExtensions.includes(ext)) {
    throw new FileValidationError(
      'EXTENSION_MISMATCH',
      `File extension "${ext}" does not match detected MIME type "${detectedMimeType}" (expected ${acceptedExtensions.join(' or ')}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Combined entry point
// ---------------------------------------------------------------------------

/** Shape of the file object passed into {@link validateUploadedFile}. */
export interface UploadedFilePayload {
  /** Original file name, e.g. `invoice-2026-04.pdf`. */
  name: string;
  /** Declared size in bytes. */
  size: number;
  /**
   * At least the first 8 bytes of the file content. MAY be the full file.
   * Only the first 8 bytes are inspected for magic-byte matching.
   */
  bytes: Uint8Array;
}

/**
 * Run all three server-side validations in order:
 *
 *   1. size              — reject empty / oversized
 *   2. magic bytes       — reject unknown content types
 *   3. extension consistency — reject extension/MIME mismatches
 *
 * Throws the FIRST {@link FileValidationError} encountered (short-circuit).
 * On success, returns `{ mimeType }` — the canonical type the caller
 * should treat the file as. This is the value to persist on the `documents`
 * DB row, NOT whatever the client claimed in `Content-Type`.
 *
 * This is the SINGLE function the ingress Cloudflare Worker / Next.js
 * upload route should call BEFORE issuing
 * `supabase.storage.from('documents').upload(...)`.
 *
 * @example
 * ```ts
 * const file = { name: 'invoice.pdf', size: bytes.length, bytes };
 * const { mimeType } = validateUploadedFile(file);
 * // mimeType === 'application/pdf' — safe to persist + pass to extraction
 * ```
 */
export function validateUploadedFile(
  file: UploadedFilePayload,
): { mimeType: string } {
  // 1. Size first — cheapest check. Critically, this must run BEFORE the
  //    magic-byte check so that a 25MB HTML payload is rejected as
  //    FILE_TOO_LARGE (413) rather than UNKNOWN_FILE_TYPE (415) — the
  //    size issue is the more important signal for the caller.
  validateFileSize(file.size);

  // 2. Magic bytes — verify the actual content type.
  validateMagicBytes(file.bytes);

  // 3. Extension consistency — cross-check the declared extension against
  //    the detected MIME type.
  const detectedMimeType = detectMimeFromBytes(file.bytes);
  // detectMimeFromBytes cannot return null here because validateMagicBytes
  // already threw — but guard for type safety / future refactors.
  if (detectedMimeType === null) {
    throw new FileValidationError(
      'UNKNOWN_FILE_TYPE',
      'Failed to detect MIME type from file bytes.',
    );
  }
  validateExtensionConsistency(file.name, detectedMimeType);

  return { mimeType: detectedMimeType };
}

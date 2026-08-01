// ============================================================================
// 10-file-validation.test.ts
// ----------------------------------------------------------------------------
// Pure unit tests for packages/shared/src/file-validation.ts — the
// server-side magic-byte MIME validation gate.
//
// No network, no Supabase, no env vars, no Deno. Just Uint8Array fixtures
// and assertions on the FileValidationError shape.
//
// Covers (per p2-3 task spec):
//   1. validateFileSize         — 0 / 21MB / 20MB-boundary / 1KB
//   2. detectMimeFromBytes      — PDF / PNG / JPEG / TIFF LE / TIFF BE / HTML / empty
//   3. validateMagicBytes       — UNKNOWN_FILE_TYPE on HTML, passes on PDF
//   4. validateExtensionConsistency — mismatch + long-form aliases (.jpeg/.tiff)
//   5. validateUploadedFile     — end-to-end size → magic → extension ordering
//   6. statusCode mapping       — each error code → correct HTTP status
//   7. MIME_SIGNATURES sanity   — coverage + TIFF dual-endianness
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  FileValidationError,
  MAX_FILE_SIZE_BYTES,
  MIME_SIGNATURES,
  detectMimeFromBytes,
  validateFileSize,
  validateMagicBytes,
  validateExtensionConsistency,
  validateUploadedFile,
} from '../../packages/shared/src/file-validation';

// ---------------------------------------------------------------------------
// Helpers + fixtures
// ---------------------------------------------------------------------------

/** Tiny helper to build a Uint8Array from a list of byte values. */
const bytes = (arr: number[]) => new Uint8Array(arr);

const KB = 1024;
const MB = 1024 * 1024;

// Real magic-byte prefixes for each supported format. We pad to 8 bytes
// where the canonical signature is shorter, to mirror what detectMimeFromBytes
// would see from a real file (the function reads up to 8 bytes).
const PDF_BYTES = bytes([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
const PNG_BYTES = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // \x89PNG\r\n\x1a\n
const JPEG_BYTES = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]); // SOI + APP0...
const TIFF_LE_BYTES = bytes([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]); // "II*\0"...
const TIFF_BE_BYTES = bytes([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]); // "MM\0*"...
const HTML_BYTES = bytes([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);               // "<html>"

/** Asserts that `fn` throws a FileValidationError with the given code + status. */
function expectFileError(
  fn: () => void,
  code: string,
  statusCode: number,
): void {
  try {
    fn();
    throw new Error(`expected fn() to throw FileValidationError(${code})`);
  } catch (e) {
    expect(e).toBeInstanceOf(FileValidationError);
    const err = e as FileValidationError;
    expect(err.code).toBe(code);
    expect(err.statusCode).toBe(statusCode);
  }
}

// =========================================================================
// 1. validateFileSize
// =========================================================================
describe('validateFileSize', () => {
  it('rejects 0 bytes with EMPTY_FILE (400)', () => {
    expectFileError(() => validateFileSize(0), 'EMPTY_FILE', 400);
  });

  it('rejects 21MB with FILE_TOO_LARGE (413)', () => {
    expectFileError(() => validateFileSize(21 * MB), 'FILE_TOO_LARGE', 413);
  });

  it('accepts exactly 20MB (boundary — equal to MAX_FILE_SIZE_BYTES)', () => {
    expect(validateFileSize(MAX_FILE_SIZE_BYTES)).toBeUndefined();
    // Sanity: MAX_FILE_SIZE_BYTES really is 20MB.
    expect(MAX_FILE_SIZE_BYTES).toBe(20 * 1024 * 1024);
  });

  it('accepts 1KB', () => {
    expect(validateFileSize(1 * KB)).toBeUndefined();
  });

  it('rejects negative sizes as EMPTY_FILE (defensive)', () => {
    expectFileError(() => validateFileSize(-1), 'EMPTY_FILE', 400);
  });

  it('rejects NaN as EMPTY_FILE (defensive)', () => {
    expectFileError(() => validateFileSize(NaN), 'EMPTY_FILE', 400);
  });
});

// =========================================================================
// 2. detectMimeFromBytes
// =========================================================================
describe('detectMimeFromBytes', () => {
  it('detects application/pdf from "%PDF" prefix', () => {
    expect(detectMimeFromBytes(PDF_BYTES)).toBe('application/pdf');
  });

  it('detects image/png from "\\x89PNG" prefix', () => {
    expect(detectMimeFromBytes(PNG_BYTES)).toBe('image/png');
  });

  it('detects image/jpeg from FF D8 FF prefix', () => {
    expect(detectMimeFromBytes(JPEG_BYTES)).toBe('image/jpeg');
  });

  it('detects image/tiff from little-endian "II*\\0" prefix', () => {
    expect(detectMimeFromBytes(TIFF_LE_BYTES)).toBe('image/tiff');
  });

  it('detects image/tiff from big-endian "MM\\0*" prefix', () => {
    expect(detectMimeFromBytes(TIFF_BE_BYTES)).toBe('image/tiff');
  });

  it('returns null for HTML/text bytes ("<html")', () => {
    expect(detectMimeFromBytes(HTML_BYTES)).toBeNull();
  });

  it('returns null for an empty array', () => {
    expect(detectMimeFromBytes(new Uint8Array(0))).toBeNull();
  });

  it('handles short buffers smaller than 8 bytes gracefully (3-byte JPEG still matches)', () => {
    expect(detectMimeFromBytes(bytes([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
  });

  it('returns null for a 2-byte buffer that is a prefix of JPEG but not a full match', () => {
    // Only FF D8 (no FF) — not enough to confirm JPEG, must NOT match.
    expect(detectMimeFromBytes(bytes([0xff, 0xd8]))).toBeNull();
  });
});

// =========================================================================
// 3. validateMagicBytes
// =========================================================================
describe('validateMagicBytes', () => {
  it('throws UNKNOWN_FILE_TYPE (415) on HTML bytes', () => {
    expectFileError(() => validateMagicBytes(HTML_BYTES), 'UNKNOWN_FILE_TYPE', 415);
  });

  it('passes silently on real PDF bytes', () => {
    expect(validateMagicBytes(PDF_BYTES)).toBeUndefined();
  });

  it('passes silently on PNG / JPEG / TIFF LE / TIFF BE', () => {
    expect(validateMagicBytes(PNG_BYTES)).toBeUndefined();
    expect(validateMagicBytes(JPEG_BYTES)).toBeUndefined();
    expect(validateMagicBytes(TIFF_LE_BYTES)).toBeUndefined();
    expect(validateMagicBytes(TIFF_BE_BYTES)).toBeUndefined();
  });

  it('throws UNKNOWN_FILE_TYPE on empty bytes', () => {
    expectFileError(() => validateMagicBytes(new Uint8Array(0)), 'UNKNOWN_FILE_TYPE', 415);
  });
});

// =========================================================================
// 4. validateExtensionConsistency
// =========================================================================
describe('validateExtensionConsistency', () => {
  it('throws EXTENSION_MISMATCH (415) when "doc.pdf" is paired with PNG bytes', () => {
    expectFileError(
      () => validateExtensionConsistency('doc.pdf', 'image/png'),
      'EXTENSION_MISMATCH',
      415,
    );
  });

  it('accepts "doc.pdf" paired with application/pdf', () => {
    expect(
      validateExtensionConsistency('doc.pdf', 'application/pdf'),
    ).toBeUndefined();
  });

  it('accepts "photo.jpeg" (long form) with image/jpeg', () => {
    expect(
      validateExtensionConsistency('photo.jpeg', 'image/jpeg'),
    ).toBeUndefined();
  });

  it('accepts "scan.tiff" (long form) with image/tiff', () => {
    expect(
      validateExtensionConsistency('scan.tiff', 'image/tiff'),
    ).toBeUndefined();
  });

  it('is case-insensitive on the extension', () => {
    expect(
      validateExtensionConsistency('INVOICE.PDF', 'application/pdf'),
    ).toBeUndefined();
  });

  it('rejects ".png" extension with image/jpeg MIME (cross-format mismatch)', () => {
    expectFileError(
      () => validateExtensionConsistency('photo.png', 'image/jpeg'),
      'EXTENSION_MISMATCH',
      415,
    );
  });

  it('rejects a file name with no extension', () => {
    expectFileError(
      () => validateExtensionConsistency('invoice', 'application/pdf'),
      'EXTENSION_MISMATCH',
      415,
    );
  });

  it('handles path-prefixed file names (POSIX + Windows)', () => {
    expect(
      validateExtensionConsistency('/tmp/uploads/invoice.pdf', 'application/pdf'),
    ).toBeUndefined();
    expect(
      validateExtensionConsistency('C:\\Users\\me\\invoice.pdf', 'application/pdf'),
    ).toBeUndefined();
  });
});

// =========================================================================
// 5. validateUploadedFile end-to-end
// =========================================================================
describe('validateUploadedFile (end-to-end)', () => {
  it('rejects a fake PDF (HTML content named .pdf) with UNKNOWN_FILE_TYPE (415)', () => {
    // Construct the file object as specified in the task: HTML bytes followed
    // by zeros to reach size 100.
    const fakeBytes = new Uint8Array(100);
    fakeBytes.set([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e], 0); // "<html>" + zeros
    expectFileError(
      () => validateUploadedFile({ name: 'fake.pdf', size: 100, bytes: fakeBytes }),
      'UNKNOWN_FILE_TYPE',
      415,
    );
  });

  it('rejects a 25MB payload with FILE_TOO_LARGE (413) BEFORE checking bytes', () => {
    // Bytes are HTML (would otherwise trigger UNKNOWN_FILE_TYPE) — but the
    // size check runs FIRST and must win.
    const htmlBytes = new Uint8Array(8);
    htmlBytes.set([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x00, 0x00], 0);
    expectFileError(
      () => validateUploadedFile({ name: 'big.pdf', size: 25 * MB, bytes: htmlBytes }),
      'FILE_TOO_LARGE',
      413,
    );
  });

  it('rejects a 0-byte file with EMPTY_FILE (400)', () => {
    expectFileError(
      () =>
        validateUploadedFile({
          name: 'empty.pdf',
          size: 0,
          bytes: new Uint8Array(0),
        }),
      'EMPTY_FILE',
      400,
    );
  });

  it('rejects a mismatched extension (real PNG content named "doc.pdf") with EXTENSION_MISMATCH (415)', () => {
    expectFileError(
      () =>
        validateUploadedFile({
          name: 'doc.pdf',
          size: 8,
          bytes: PNG_BYTES,
        }),
      'EXTENSION_MISMATCH',
      415,
    );
  });

  it('passes a valid 1KB PDF and returns { mimeType: "application/pdf" }', () => {
    // Build a 1KB PDF-shaped payload: %PDF prefix + zeros.
    const pdfKb = new Uint8Array(1 * KB);
    pdfKb.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37], 0);
    const result = validateUploadedFile({
      name: 'invoice.pdf',
      size: 1 * KB,
      bytes: pdfKb,
    });
    expect(result).toEqual({ mimeType: 'application/pdf' });
  });

  it('passes a valid PNG named "photo.png"', () => {
    const result = validateUploadedFile({
      name: 'photo.png',
      size: 8,
      bytes: PNG_BYTES,
    });
    expect(result).toEqual({ mimeType: 'image/png' });
  });

  it('passes a valid JPEG named "scan.jpg"', () => {
    const result = validateUploadedFile({
      name: 'scan.jpg',
      size: 8,
      bytes: JPEG_BYTES,
    });
    expect(result).toEqual({ mimeType: 'image/jpeg' });
  });

  it('passes a valid TIFF named "doc.tif" (little-endian)', () => {
    const result = validateUploadedFile({
      name: 'doc.tif',
      size: 8,
      bytes: TIFF_LE_BYTES,
    });
    expect(result).toEqual({ mimeType: 'image/tiff' });
  });

  it('passes a valid TIFF named "doc.tiff" (big-endian, long-form ext)', () => {
    const result = validateUploadedFile({
      name: 'doc.tiff',
      size: 8,
      bytes: TIFF_BE_BYTES,
    });
    expect(result).toEqual({ mimeType: 'image/tiff' });
  });

  it('verifies execution order: size → magic → extension (oversized + HTML + bad ext → FILE_TOO_LARGE)', () => {
    // A payload that would fail ALL THREE checks must surface the size error
    // first, proving the order is size-before-magic-before-extension.
    const evilBytes = new Uint8Array(8);
    evilBytes.set([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x00, 0x00], 0);
    expectFileError(
      () =>
        validateUploadedFile({
          name: 'mismatch.exe', // bad ext + HTML content + 25MB size
          size: 25 * MB,
          bytes: evilBytes,
        }),
      'FILE_TOO_LARGE',
      413,
    );
  });

  it('verifies execution order: valid size + HTML content + bad ext → UNKNOWN_FILE_TYPE (not EXTENSION_MISMATCH)', () => {
    // Size is OK (1KB), bytes are HTML (fails magic), extension is .pdf
    // (would also fail extension consistency). Magic check runs before
    // extension check, so UNKNOWN_FILE_TYPE must win.
    const htmlBytes = new Uint8Array(1 * KB);
    htmlBytes.set([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e], 0);
    expectFileError(
      () =>
        validateUploadedFile({
          name: 'invoice.pdf',
          size: 1 * KB,
          bytes: htmlBytes,
        }),
      'UNKNOWN_FILE_TYPE',
      415,
    );
  });
});

// =========================================================================
// 6. Error statusCode mapping
// =========================================================================
describe('FileValidationError statusCode mapping', () => {
  const cases: Array<{
    code: string;
    status: number;
    build: () => void;
    label: string;
  }> = [
    {
      code: 'EMPTY_FILE',
      status: 400,
      label: 'empty size',
      build: () => validateFileSize(0),
    },
    {
      code: 'FILE_TOO_LARGE',
      status: 413,
      label: 'oversized payload',
      build: () => validateFileSize(21 * MB),
    },
    {
      code: 'UNKNOWN_FILE_TYPE',
      status: 415,
      label: 'HTML magic bytes',
      build: () => validateMagicBytes(HTML_BYTES),
    },
    {
      code: 'EXTENSION_MISMATCH',
      status: 415,
      label: '.pdf ext with PNG MIME',
      build: () => validateExtensionConsistency('doc.pdf', 'image/png'),
    },
  ];

  for (const c of cases) {
    it(`maps ${c.code} → HTTP ${c.status} (${c.label})`, () => {
      expectFileError(c.build, c.code, c.status);
    });
  }

  it('FileValidationError is a real Error subclass (instanceof + name + message)', () => {
    try {
      validateFileSize(0);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(FileValidationError);
      expect((e as FileValidationError).name).toBe('FileValidationError');
      expect((e as FileValidationError).message).toBeTruthy();
    }
  });
});

// =========================================================================
// 7. MIME_SIGNATURES sanity
// =========================================================================
describe('MIME_SIGNATURES', () => {
  it('covers exactly PDF / PNG / JPEG / TIFF', () => {
    const mimes = Object.values(MIME_SIGNATURES)
      .map((s) => s.mimeType)
      .sort();
    expect(mimes).toEqual(
      ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'].sort(),
    );
  });

  it('PDF signature is "%PDF" (25 50 44 46)', () => {
    expect(MIME_SIGNATURES.PDF.magicBytes).toEqual([[0x25, 0x50, 0x44, 0x46]]);
    expect(MIME_SIGNATURES.PDF.mimeType).toBe('application/pdf');
    expect(MIME_SIGNATURES.PDF.extension).toBe('.pdf');
  });

  it('PNG signature is "\\x89PNG" (89 50 4E 47)', () => {
    expect(MIME_SIGNATURES.PNG.magicBytes).toEqual([[0x89, 0x50, 0x4e, 0x47]]);
    expect(MIME_SIGNATURES.PNG.mimeType).toBe('image/png');
    expect(MIME_SIGNATURES.PNG.extension).toBe('.png');
  });

  it('JPEG signature is FF D8 FF', () => {
    expect(MIME_SIGNATURES.JPEG.magicBytes).toEqual([[0xff, 0xd8, 0xff]]);
    expect(MIME_SIGNATURES.JPEG.mimeType).toBe('image/jpeg');
    expect(MIME_SIGNATURES.JPEG.extension).toBe('.jpg');
  });

  it('TIFF has TWO alternative magic-byte prefixes (LE + BE)', () => {
    expect(MIME_SIGNATURES.TIFF.magicBytes).toHaveLength(2);
    expect(MIME_SIGNATURES.TIFF.magicBytes[0]).toEqual([0x49, 0x49, 0x2a, 0x00]);
    expect(MIME_SIGNATURES.TIFF.magicBytes[1]).toEqual([0x4d, 0x4d, 0x00, 0x2a]);
    expect(MIME_SIGNATURES.TIFF.mimeType).toBe('image/tiff');
    expect(MIME_SIGNATURES.TIFF.extension).toBe('.tif');
  });
});

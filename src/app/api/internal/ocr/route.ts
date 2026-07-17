// ============================================================================
// /api/internal/ocr — Self-hosted tesseract.js OCR endpoint
// ============================================================================
//
// INTERNAL ONLY — not reachable by end users. Protected by a shared-secret
// header (X-Internal-Secret) checked against process.env.INTERNAL_OCR_SECRET.
// The Supabase extract-document edge function calls this route as Tier 3 of
// its extraction cascade (after Gemini Vision and PDF text-layer extraction).
//
// Why a separate Node route? tesseract.js needs a Node.js runtime (it spawns a
// worker + WASM module); Supabase edge functions run on Deno and can't host
// it directly. The edge function base64-encodes the file and ships it over
// HTTPS, this route decodes it, runs OCR, and returns the text.
//
// Contract:
//   POST /api/internal/ocr
//   Headers: X-Internal-Secret: <shared-secret>
//            Content-Type: application/json
//   Body:    { data: string (base64), mimeType: string }
//   200 OK:  { text: string, confidence: number }
//   401:     { error: "Unauthorized" }
//   400:     { error: "Bad request", detail: string }
//   415:     { error: "Unsupported mime type", detail: string }   // PDFs (no rasterizer)
//   408:     { error: "OCR timeout" }
//   500/502: { error: "OCR failed", detail: string }
//
// Notes:
//   - 25s internal timeout (AbortController). The edge function's 18s wall-clock
//     budget will fire first if needed — that's intentional.
//   - PDF support requires sharp built with poppler/libvips-pdf. This route
//     returns a 415 for PDFs so the edge function falls through to manual
//     review (Tier 4). See worklog P3.
// ============================================================================

import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { logger } from '@/lib/utils/logger';

// Force the Node.js runtime — tesseract.js spawns a Node worker and WASM and
// cannot run on the edge runtime.
export const runtime = 'nodejs';
// Allow up to 30s on the platform side (route's internal timeout is 25s, so we
// have headroom for response serialization).
export const maxDuration = 30;

const INTERNAL_TIMEOUT_MS = 25_000;
const SHARED_SECRET_ENV = 'INTERNAL_OCR_SECRET';

// Mime types tesseract.js can ingest directly (after sharp normalization to PNG).
const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
]);

interface OcrRequestBody {
  data: string;
  mimeType: string;
}

interface OcrSuccessResponse {
  text: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function badRequest(detail: string) {
  return NextResponse.json({ error: 'Bad request', detail }, { status: 400 });
}

function unsupportedType(detail: string) {
  return NextResponse.json({ error: 'Unsupported mime type', detail }, { status: 415 });
}

function ocrTimeout() {
  return NextResponse.json({ error: 'OCR timeout' }, { status: 408 });
}

function ocrFailed(detail: string, status = 500) {
  return NextResponse.json({ error: 'OCR failed', detail }, { status });
}

/**
 * Decode a base64 string into a Node Buffer.
 * Handles both standard and URL-safe variants, and strips any
 * `data:...;base64,` prefix the caller might have included.
 */
function decodeBase64ToBuffer(b64: string): Buffer {
  let cleaned = b64.trim();
  // Strip data-URI prefix if present (data:image/png;base64,XXXX)
  const commaIdx = cleaned.indexOf(',');
  if (cleaned.startsWith('data:') && commaIdx !== -1) {
    cleaned = cleaned.slice(commaIdx + 1);
  }
  // URL-safe → standard base64
  cleaned = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(cleaned, 'base64');
}

/**
 * Normalize an arbitrary image buffer to PNG via sharp. tesseract.js prefers
 * PNG/JPEG and tends to mis-handle exotic pixel layouts; normalizing gives
 * deterministic results. Returns the normalized PNG buffer.
 */
async function normalizeImage(buffer: Buffer, mimeType: string): Promise<Buffer> {
  // Already PNG and reasonable size — pass through (sharp re-encode is cheap anyway).
  // We still run through sharp to validate the image and apply a sensible max-dim.
  const pipeline = sharp(buffer, {
    // hint sharp about the input when mimeType is unusual
    density: 300,
  });

  // Cap the longest side at 2000px so tesseract stays fast and memory-safe.
  // Oversized scans waste time without improving OCR meaningfully.
  const meta = await pipeline.metadata();
  const maxDim = 2000;
  let resizeOpts: { width?: number; height?: number } = {};
  if (meta.width && meta.height) {
    const longest = Math.max(meta.width, meta.height);
    if (longest > maxDim) {
      const scale = maxDim / longest;
      resizeOpts = {
        width: Math.round(meta.width * scale),
        height: Math.round(meta.height * scale),
      };
    }
  }

  return sharp(buffer)
    .rotate() // auto-orient from EXIF
    .resize({ ...resizeOpts, withoutEnlargement: true })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // ── 1. Shared-secret check ──
  const secret = process.env[SHARED_SECRET_ENV];
  if (!secret) {
    logger.error('OCR route called but INTERNAL_OCR_SECRET is not set', {
      route: '/api/internal/ocr',
    });
    // Treat misconfiguration as unauthorized — never process without a secret.
    return unauthorized();
  }
  const provided = req.headers.get('x-internal-secret');
  if (!provided || provided !== secret) {
    logger.warn('OCR route rejected — bad or missing X-Internal-Secret', {
      route: '/api/internal/ocr',
      hadHeader: !!provided,
    });
    return unauthorized();
  }

  // ── 2. Parse body ──
  let body: OcrRequestBody;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed.data !== 'string' || typeof parsed.mimeType !== 'string') {
      logger.warn('OCR route — malformed body', { route: '/api/internal/ocr' });
      return badRequest('Body must be { data: string (base64), mimeType: string }');
    }
    body = parsed as OcrRequestBody;
  } catch (err) {
    logger.warn('OCR route — JSON parse failed', {
      route: '/api/internal/ocr',
      error: String((err as Error)?.message || err),
    });
    return badRequest('Invalid JSON body');
  }

  const { mimeType, data } = body;

  // ── 3. Mime-type gate ──
  // PDFs require a rasterizer. Sharp in this environment is NOT built with
  // poppler/libvips-pdf (sharp.format.pdf.input.{file,buffer,stream} = false),
  // so we can't rasterize PDFs here. Return 415 so the edge function falls
  // through to manual review (Tier 4) cleanly.
  if (mimeType === 'application/pdf') {
    logger.info('OCR route — PDF not supported, returning 415', {
      route: '/api/internal/ocr',
      mimeType,
    });
    return unsupportedType(
      'PDF rasterization is not available in this environment — sharp was built without poppler/libvips-pdf support. Falling through to manual review.',
    );
  }

  if (!IMAGE_MIME_TYPES.has(mimeType.toLowerCase())) {
    logger.warn('OCR route — unsupported mime type', {
      route: '/api/internal/ocr',
      mimeType,
    });
    return unsupportedType(`Unsupported mime type: ${mimeType}. Supported: ${[...IMAGE_MIME_TYPES].join(', ')}`);
  }

  // ── 4. Decode base64 ──
  let imageBuffer: Buffer;
  try {
    imageBuffer = decodeBase64ToBuffer(data);
    if (imageBuffer.length === 0) {
      return badRequest('Decoded buffer is empty');
    }
  } catch (err) {
    logger.error('OCR route — base64 decode failed', {
      route: '/api/internal/ocr',
      error: String((err as Error)?.message || err),
    });
    return badRequest('Failed to decode base64 data');
  }

  // ── 5. Normalize via sharp ──
  let normalizedBuffer: Buffer;
  try {
    normalizedBuffer = await normalizeImage(imageBuffer, mimeType);
  } catch (err) {
    logger.error('OCR route — sharp normalize failed', {
      route: '/api/internal/ocr',
      mimeType,
      byteLength: imageBuffer.length,
      error: String((err as Error)?.message || err),
    });
    return ocrFailed(`Image preprocessing failed: ${(err as Error)?.message || String(err)}`, 422);
  }

  logger.info('OCR route — starting tesseract', {
    route: '/api/internal/ocr',
    mimeType,
    inputBytes: imageBuffer.length,
    normalizedBytes: normalizedBuffer.length,
    timeoutMs: INTERNAL_TIMEOUT_MS,
  });

  // ── 6. Run tesseract with a 25s timeout ──
  // We use an AbortController + Promise.race so a stuck worker can't hang the
  // route indefinitely. tesseract.js doesn't natively accept an AbortSignal,
  // so we race against a timeout promise and terminate the worker in a finally
  // block.
  //
  // The worker is stored on a mutable holder object so TypeScript's
  // control-flow analysis doesn't narrow it back to `null` (assignments happen
  // inside an async closure, which CFA can't track across).
  const controller = new AbortController();
  const holder: { worker: { terminate: () => Promise<unknown> } | null } = { worker: null };

  const tesseractPromise = (async (): Promise<OcrSuccessResponse> => {
    const worker = await createWorker('eng');
    holder.worker = worker;
    const { data: result } = await worker.recognize(normalizedBuffer);
    return {
      text: (result?.text ?? '').trim(),
      confidence: typeof result?.confidence === 'number' ? Math.round(result.confidence) : 0,
    };
  })();

  const timeoutPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(() => {
      controller.abort();
      reject(new Error(`OCR timed out after ${INTERNAL_TIMEOUT_MS}ms`));
    }, INTERNAL_TIMEOUT_MS);
    // Allow the Node process to exit even if the timer is still pending.
    if (typeof t === 'object' && 'unref' in t) {
      (t as NodeJS.Timeout).unref();
    }
  });

  try {
    const result = await Promise.race([tesseractPromise, timeoutPromise]);
    const elapsedMs = Date.now() - startedAt;
    logger.info('OCR route — success', {
      route: '/api/internal/ocr',
      mimeType,
      textLength: result.text.length,
      confidence: result.confidence,
      elapsedMs,
    });
    return NextResponse.json(result);
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = (err as Error)?.message || String(err);
    const isTimeout = /timed out/i.test(message);
    logger.error('OCR route — tesseract failed', {
      route: '/api/internal/ocr',
      mimeType,
      elapsedMs,
      isTimeout,
      error: message,
    });
    if (isTimeout) return ocrTimeout();
    return ocrFailed(message, 502);
  } finally {
    // Always terminate the worker — it spawns a child Node process and holds
    // WASM memory; failing to terminate leaks ~50–100MB per call.
    const w = holder.worker;
    if (w) {
      try {
        await w.terminate();
      } catch {
        // Best-effort cleanup — ignore.
      }
    }
  }
}

// Reject GET / PUT / etc. — internal endpoints are POST-only.
export async function GET(): Promise<Response> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}

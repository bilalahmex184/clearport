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
//   415:     { error: "Unsupported mime type", detail: string }
//   408:     { error: "OCR timeout" }
//   500/502: { error: "OCR failed", detail: string }
//
// Notes:
//   - 25s internal timeout (AbortController). The edge function's 18s wall-clock
//     budget will fire first if needed — that's intentional.
//   - PDF support: rasterizes the first page to PNG at 300 DPI via poppler-utils'
//     `pdftoppm` binary (apt-get install poppler-utils), then feeds the PNG into
//     the existing normalizeImage → tesseract path. This is a one-time OS-level
//     install documented in the deployment README. If pdftoppm is missing or
//     the PDF is corrupt, returns a 415/502 so the edge function falls through
//     to manual review (Tier 4).
// ============================================================================

import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { logger } from '@/lib/utils/logger';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync as existsSyncSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);

// Resolve the tesseract.js worker script's real filesystem path.
// Turbopack rewrites both `require.resolve(...)` and `createRequire().resolve()`
// into virtual module paths that Node's `new Worker(path)` rejects. We
// construct the path directly from process.cwd() instead — this works because
// ClearPort is self-hosted (not serverless), so node_modules is always at the
// project root. The path is validated at module load; if missing, OCR calls
// will fail with a clear error rather than a confusing worker-spawn crash.
function resolveTesseractWorkerPath(): string {
  // Try createRequire first (works in some bundler configs)
  try {
    const nodeRequire = createRequire(import.meta.url);
    const resolved = nodeRequire.resolve(
      'tesseract.js/src/worker-script/node/index.js',
    );
    // If Turbopack rewrote it, the path won't start with '/' — check for that
    if (resolved.startsWith('/') && existsSyncSync(resolved)) {
      return resolved;
    }
  } catch {
    // Fall through to manual path construction
  }
  // Fallback: construct from process.cwd() (self-hosted deployment)
  return join(process.cwd(), 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js');
}
const TESSERACT_WORKER_PATH = resolveTesseractWorkerPath();

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

/**
 * Rasterize the first page of a PDF to a PNG buffer using poppler-utils'
 * `pdftoppm` binary. Returns the PNG buffer on success.
 * Throws if pdftoppm is missing, the PDF is corrupt, or the conversion fails.
 *
 * Uses a temp directory in the OS tmpdir. The caller is responsible for
 * cleanup — use the cleanup callback returned alongside the buffer, or
 * call the function inside a try/finally that removes the temp path.
 */
async function rasterizePdfFirstPage(pdfBuffer: Buffer): Promise<{ pngBuffer: Buffer; cleanup: () => Promise<void> }> {
  const sessionId = randomUUID();
  const tempDir = join(tmpdir(), `clearport-ocr-${sessionId}`);
  await mkdir(tempDir, { recursive: true });

  const pdfPath = join(tempDir, 'input.pdf');
  const outputPrefix = join(tempDir, 'page'); // pdftoppm appends -1.png
  let pngPath = join(tempDir, 'page-1.png'); // pdftoppm -png naming: <prefix>-1.png

  const cleanup = async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort — ignore.
    }
  };

  try {
    // Write the PDF to disk for pdftoppm
    await writeFile(pdfPath, pdfBuffer);

    // pdftoppm -png -r 300 -f 1 -l 1 <pdf> <output-prefix>
    //   -png      : output PNG format
    //   -r 300    : 300 DPI (good balance of quality + speed for OCR)
    //   -f 1 -l 1 : first page to last page (just page 1)
    try {
      await execFileAsync('pdftoppm', ['-png', '-r', '300', '-f', '1', '-l', '1', pdfPath, outputPrefix], {
        timeout: 20_000, // hard cap — pdftoppm must finish well within the route's 25s budget
        maxBuffer: 10 * 1024 * 1024, // 10MB stdout/stderr cap
      });
    } catch (err: unknown) {
      const e = err as { code?: string; stderr?: string; message?: string };
      // ENOENT means pdftoppm binary isn't installed
      if (e.code === 'ENOENT') {
        throw new Error('pdftoppm binary not found — install poppler-utils (apt-get install poppler-utils)');
      }
      throw new Error(`pdftoppm failed: ${e.stderr || e.message || String(err)}`);
    }

    // pdftoppm names files <prefix>-1.png (single digit for page 1)
    const pngBuffer = await readFile(pngPath);
    if (pngBuffer.length === 0) {
      throw new Error('pdftoppm produced an empty PNG');
    }

    return { pngBuffer, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
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

  // ── 3. Decode base64 ──
  let rawBuffer: Buffer;
  try {
    rawBuffer = decodeBase64ToBuffer(data);
    if (rawBuffer.length === 0) {
      return badRequest('Decoded buffer is empty');
    }
  } catch (err) {
    logger.error('OCR route — base64 decode failed', {
      route: '/api/internal/ocr',
      error: String((err as Error)?.message || err),
    });
    return badRequest('Failed to decode base64 data');
  }

  // ── 4. Handle PDFs: rasterize first page via pdftoppm, then OCR the PNG ──
  // PDFs need a rasterizer. Sharp in this environment is NOT built with
  // poppler/libvips-pdf, so we shell out to poppler-utils' `pdftoppm` binary
  // instead (apt-get install poppler-utils). The first page is rasterized at
  // 300 DPI to a PNG, then fed into the existing normalizeImage → tesseract
  // path unchanged. Temp files are cleaned up in a finally block.
  let imageBuffer: Buffer;
  let pdfCleanup: (() => Promise<void>) | null = null;

  if (mimeType === 'application/pdf') {
    logger.info('OCR route — rasterizing PDF first page via pdftoppm', {
      route: '/api/internal/ocr',
      inputBytes: rawBuffer.length,
    });
    try {
      const result = await rasterizePdfFirstPage(rawBuffer);
      imageBuffer = result.pngBuffer;
      pdfCleanup = result.cleanup;
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      logger.error('OCR route — PDF rasterization failed', {
        route: '/api/internal/ocr',
        error: msg,
      });
      // If pdftoppm is missing, that's a configuration issue → 415
      if (msg.includes('pdftoppm binary not found')) {
        return unsupportedType('PDF rasterization unavailable — pdftoppm not installed. Install poppler-utils.');
      }
      // Corrupt PDF or rasterization failure → 422 (processable entity but failed)
      return ocrFailed(`PDF rasterization failed: ${msg}`, 422);
    }
  } else if (IMAGE_MIME_TYPES.has(mimeType.toLowerCase())) {
    imageBuffer = rawBuffer;
  } else {
    logger.warn('OCR route — unsupported mime type', {
      route: '/api/internal/ocr',
      mimeType,
    });
    return unsupportedType(`Unsupported mime type: ${mimeType}. Supported: ${[...IMAGE_MIME_TYPES].join(', ')}, application/pdf`);
  }

  // ── 5. Normalize via sharp ──
  let normalizedBuffer: Buffer;
  try {
    normalizedBuffer = await normalizeImage(imageBuffer, mimeType === 'application/pdf' ? 'image/png' : mimeType);
  } catch (err) {
    logger.error('OCR route — sharp normalize failed', {
      route: '/api/internal/ocr',
      mimeType,
      byteLength: imageBuffer.length,
      error: String((err as Error)?.message || err),
    });
    if (pdfCleanup) await pdfCleanup();
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
    // Explicitly set workerPath so Next.js's Turbopack bundler doesn't break
    // tesseract.js's __dirname-based path resolution. TESSERACT_WORKER_PATH is
    // resolved at module load via createRequire (bypasses Turbopack's virtual
    // module rewriting) to a real filesystem path.
    const worker = await createWorker('eng', 1, {
      workerPath: TESSERACT_WORKER_PATH,
      corePath: undefined, // let tesseract.js auto-download the WASM core
      langPath: undefined, // let tesseract.js auto-download language data
    });
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
    // Clean up PDF temp files if we rasterized one
    if (pdfCleanup) {
      try {
        await pdfCleanup();
      } catch {
        // Best-effort — ignore.
      }
    }
  }
}

// Reject GET / PUT / etc. — internal endpoints are POST-only.
export async function GET(): Promise<Response> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}

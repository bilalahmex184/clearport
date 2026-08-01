// ============================================================================
// /api/internal/ocr — Tesseract.js OCR service (Tier 4 fallback)
// ============================================================================
// Phase 6 Round-2 fix #49: This route was deleted in Phase 1 but the consumer
// Worker's Tier 4 (Tesseract) fallback still points at it via OCR_SERVICE_URL.
// This recreation provides a minimal tesseract.js endpoint that:
//   1. Receives { file: base64, mimeType } POST body
//   2. Runs tesseract.js on the decoded bytes
//   3. Returns { text: string } on success, { error: string } on failure
//
// The route is authenticated via the X-OCR-Secret header (INTERNAL_OCR_SECRET
// env var). This prevents public access — only the consumer Worker (which has
// the secret) can call it.
//
// In production, this runs in the Next.js app (Node runtime, not Edge) because
// tesseract.js needs Node APIs. The consumer Worker calls it via fetch.
// ============================================================================

import { NextResponse } from 'next/server';
import { createWorker } from 'tesseract.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30; // 30 seconds — matches the consumer's 25s timeout

export async function POST(req: Request) {
  // --- Auth: verify the OCR secret ---
  const ocrSecret = process.env.INTERNAL_OCR_SECRET;
  if (!ocrSecret) {
    return NextResponse.json(
      { error: 'OCR service not configured (INTERNAL_OCR_SECRET missing)' },
      { status: 503 },
    );
  }
  const providedSecret = req.headers.get('X-OCR-Secret');
  if (providedSecret !== ocrSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json() as { file?: string; mimeType?: string };
    if (!body.file) {
      return NextResponse.json({ error: 'Missing file (base64)' }, { status: 400 });
    }

    // Decode base64 → bytes
    const bytes = Buffer.from(body.file, 'base64');

    // Run tesseract.js
    const worker = await createWorker('eng');
    const { data: { text } } = await worker.recognize(bytes);
    await worker.terminate();

    if (!text || text.trim().length === 0) {
      return NextResponse.json({ error: 'Tesseract returned no text' }, { status: 422 });
    }

    return NextResponse.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `OCR failed: ${message}` },
      { status: 500 },
    );
  }
}

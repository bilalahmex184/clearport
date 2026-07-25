// ============================================================================
// preprocess.ts — Image preprocessing before OCR
// ============================================================================
// Resizes, grayscales, and denoises images before they hit the OCR engine.
// This dramatically improves OCR accuracy on messy/scanned documents.
//
// Uses sharp (already installed) — a fast native image processing library.
// Pipeline: resize (max 1200px width) → grayscale → normalize → denoise
// ============================================================================

import sharp from 'sharp';

const MAX_WIDTH = 1200; // Resize to max 1200px — balances quality vs speed

export interface PreprocessResult {
  buffer: Buffer;
  originalWidth: number;
  originalHeight: number;
  newWidth: number;
  newHeight: number;
  preprocessed: boolean;
}

/**
 * Preprocess an image for OCR:
 *   1. Resize to max 1200px width (preserves aspect ratio)
 *   2. Convert to grayscale (removes color noise)
 *   3. Normalize contrast (helps OCR on faded/low-contrast scans)
 *   4. Sharpen slightly (improves edge detection for text)
 *
 * For PDFs, this is called AFTER pdftoppm rasterizes a page to PNG.
 * For images, this is called directly on the uploaded file.
 */
export async function preprocessImage(
  inputBuffer: Buffer,
  mimeType: string,
): Promise<PreprocessResult> {
  try {
    const metadata = await sharp(inputBuffer).metadata();
    const originalWidth = metadata.width || 0;
    const originalHeight = metadata.height || 0;

    // If already small enough, skip resize
    const needsResize = originalWidth > MAX_WIDTH;
    const resizeOptions = needsResize
      ? { width: MAX_WIDTH, withoutEnlargement: true }
      : {};

    const processed = await sharp(inputBuffer, { density: 300 })
      .resize(resizeOptions)
      .grayscale()           // Remove color — OCR works better on B&W
      .normalize()            // Auto-contrast enhancement
      .sharpen({ sigma: 1.0 }) // Mild sharpening for text edges
      .png({ compressionLevel: 6, quality: 95 })
      .toBuffer();

    const newMeta = await sharp(processed).metadata();

    return {
      buffer: processed,
      originalWidth,
      originalHeight,
      newWidth: newMeta.width || 0,
      newHeight: newMeta.height || 0,
      preprocessed: true,
    };
  } catch (err) {
    // If preprocessing fails, return the original buffer — OCR still runs
    console.warn('[preprocess] Image preprocessing failed, using original:', err instanceof Error ? err.message : err);
    return {
      buffer: inputBuffer,
      originalWidth: 0,
      originalHeight: 0,
      newWidth: 0,
      newHeight: 0,
      preprocessed: false,
    };
  }
}

/**
 * Check if preprocessing would help (based on image size/type).
 * Small images (< 500px) or already-grayscale images may not benefit.
 */
export function shouldPreprocess(width: number, height: number, mimeType: string): boolean {
  if (width > MAX_WIDTH) return true;
  if (mimeType === 'image/tiff') return true; // TIFFs from scanners benefit from normalization
  return false;
}

// ============================================================================
// /api/upload — proxy to the upload-document edge function with RBAC gate
// ============================================================================
//
// POST /api/upload  multipart/form-data { file, shipmentId?, docType? }
//   → 200 OK  { success: true, shipmentId, documentId, storagePath }
//   → 401     unauthenticated
//   → 403     insufficient permissions (viewer role lacks 'upload')
//   → 413     file exceeds 10 MB cap
//   → 415     unsupported MIME type
//
// The actual upload + documents row insert + Gemini extraction kick-off live
// in the `upload-document` Supabase edge function (Deno). This route is a
// thin Next.js wrapper that:
//   1. Enforces RBAC (anonymous users → operator → can upload; viewer → 403)
//   2. Pre-validates file size + MIME so we fail fast without a round-trip
//   3. Forwards the caller's JWT to the edge function so RLS + verify_jwt
//      still see the real user
//
// The frontend today calls the edge function directly via
// `supabase.functions.invoke('upload-document', ...)` from ClearPortContext.
// Going through this route instead gives us a single permission checkpoint
// server-side. The frontend can be migrated incrementally.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireUserClient, getUserEmail, getUserRole } from '@/lib/services/auth.service';
import { canUpload } from '@/lib/services/rbac.service';
import { logUpload } from '@/lib/services/audit-log.service';
import { errorResponse } from '@/lib/utils/error-handler';
import { logger } from '@/lib/utils/logger';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/tiff',
  'text/plain',
  'text/csv',
]);

const EDGE_FUNCTION_NAME = 'upload-document';

/**
 * Invoke the upload-document edge function on behalf of the caller, forwarding
 * their JWT so RLS / verify_jwt both see the real user.
 */
async function invokeUploadEdgeFunction(
  authHeader: string,
  formData: FormData,
): Promise<Response> {
  const fnUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/${EDGE_FUNCTION_NAME}`;
  return fetch(fnUrl, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      // apikey is required by Supabase's gateway for edge-function calls.
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
    body: formData,
  });
}

export async function POST(req: Request) {
  try {
    const { user, client } = await requireUserClient(req);

    // RBAC: only roles with 'upload' (admin + operator) can submit files.
    // viewer is read-only.
    const role = getUserRole(user);
    if (!canUpload(role)) {
      return NextResponse.json(
        { error: 'Insufficient permissions: upload role required', code: 'FORBIDDEN' },
        { status: 403 },
      );
    }

    const formData = await req.formData().catch(() => null);
    if (!formData) {
      return NextResponse.json(
        { error: 'Expected multipart/form-data body' },
        { status: 400 },
      );
    }

    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Missing "file" field in form data' },
        { status: 400 },
      );
    }

    // Pre-validate size + MIME so we fail fast without a function round-trip.
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          error: `File exceeds 10MB limit (${(file.size / (1024 * 1024)).toFixed(2)} MB)`,
          code: 'FILE_TOO_LARGE',
        },
        { status: 413 },
      );
    }
    if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        {
          error: `Unsupported file type: ${file.type}. Allowed: PDF, PNG, JPEG, TIFF, TXT, CSV.`,
          code: 'UNSUPPORTED_TYPE',
        },
        { status: 415 },
      );
    }

    const authHeader = req.headers.get('authorization') ?? '';

    // Rebuild a clean FormData for the edge function (drop any fields the
    // edge function doesn't expect — it accepts file, shipmentId, docType).
    const forwardForm = new FormData();
    forwardForm.append('file', file, file.name);
    const shipmentId = formData.get('shipmentId');
    if (typeof shipmentId === 'string') forwardForm.append('shipmentId', shipmentId);
    const docType = formData.get('docType');
    if (typeof docType === 'string') forwardForm.append('docType', docType);

    const upstream = await invokeUploadEdgeFunction(authHeader, forwardForm);

    // Forward non-JSON upstream errors verbatim.
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      logger.warn('upload: edge function returned non-2xx', {
        status: upstream.status,
        body: text.slice(0, 500),
      });
      return NextResponse.json(
        { error: `Upload failed (edge: ${upstream.status})`, details: text || undefined },
        { status: upstream.status },
      );
    }

    const result = await upstream.json().catch(() => ({}));

    // Best-effort structured audit log. The edge function may also write its
    // own log entry; this one records the actor + file metadata explicitly.
    const resolvedShipmentId =
      (result && typeof result === 'object' && 'shipmentId' in result && (result as any).shipmentId) ||
      shipmentId ||
      null;
    if (resolvedShipmentId) {
      await logUpload(
        client,
        getUserEmail(user),
        String(resolvedShipmentId),
        file.name,
        file.size,
      ).catch((err) => {
        logger.warn('upload: audit log failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}

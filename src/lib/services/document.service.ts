// ============================================================================
// ClearPort — Document Service
// Reads from the documents table and generates signed storage URLs.
// The actual upload (multipart parsing + storage put) still lives in the
// upload-document edge function because it needs the service-role key for
// storage writes; this service only handles the read path.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbDocument } from '@/lib/clearport-types';
import { logger } from '@/lib/utils/logger';
import { AppError } from '@/lib/utils/error-handler';

const SIGNED_URL_TTL_SECONDS = 3600; // 1 hour — matches the edge function
const STORAGE_BUCKET = 'documents';

/**
 * Fetch all documents attached to a shipment, newest first.
 */
export async function getDocuments(
  client: SupabaseClient,
  shipmentId: string,
): Promise<DbDocument[]> {
  const { data, error } = await client
    .from('documents')
    .select('*')
    .eq('shipment_id', shipmentId)
    .order('uploaded_at', { ascending: false });

  if (error) {
    logger.error('DocumentService: fetch documents failed', {
      shipmentId,
      error: error.message,
    });
    throw new AppError(
      'Failed to fetch documents',
      500,
      'DB_ERROR',
      error.message,
    );
  }

  return (data || []) as DbDocument[];
}

/**
 * Generate a signed URL for a single document row. RLS ensures the caller
 * can only request URLs for documents they own.
 */
export async function getSignedUrlForDocument(
  client: SupabaseClient,
  documentId: string,
): Promise<{ signedUrl: string; expiresIn: number }> {
  const { data: doc, error } = await client
    .from('documents')
    .select('id, storage_path')
    .eq('id', documentId)
    .maybeSingle();

  if (error) {
    logger.error('DocumentService: fetch document for signed URL failed', {
      documentId,
      error: error.message,
    });
    throw new AppError(
      'Failed to fetch document',
      500,
      'DB_ERROR',
      error.message,
    );
  }
  if (!doc) {
    throw new AppError(
      `Document not found: ${documentId}`,
      404,
      'NOT_FOUND',
      { documentId },
    );
  }

  return getSignedUrl(client, doc.storage_path as string);
}

/**
 * Generate a signed URL for an arbitrary storage path. The path is expected
 * to be of the form `{user_id}/{shipment_id}/{filename}`. The user-scoped
 * client respects RLS on the storage bucket.
 */
export async function getSignedUrl(
  client: SupabaseClient,
  storagePath: string,
): Promise<{ signedUrl: string; expiresIn: number }> {
  if (!storagePath) {
    throw new AppError('storagePath is required', 422, 'VALIDATION_ERROR');
  }

  const { data, error } = await client
    .storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

  if (error) {
    logger.error('DocumentService: signed URL failed', {
      storagePath,
      error: error.message,
    });
    throw new AppError(
      'Failed to generate signed URL',
      500,
      'STORAGE_ERROR',
      error.message,
    );
  }
  if (!data?.signedUrl) {
    throw new AppError(
      'Failed to generate signed URL',
      500,
      'STORAGE_ERROR',
      { storagePath },
    );
  }

  return { signedUrl: data.signedUrl, expiresIn: SIGNED_URL_TTL_SECONDS };
}

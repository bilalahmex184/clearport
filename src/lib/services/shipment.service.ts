// ============================================================================
// ClearPort — Shipment Service
// All shipment CRUD operations. Each function takes a user-scoped SupabaseClient
// (from auth.service.requireUserClient) so RLS applies automatically.
//
// Mapping logic (snake_case DB → camelCase frontend) is imported from
// @/lib/supabase to avoid duplication.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ShipmentEntry,
  DbShipment,
  DbDocumentField,
  DbException,
  DbDocument,
} from '@/lib/clearport-types';
import {
  mapDbToShipment,
  mapDbToField,
  mapDbToException,
} from '@/lib/supabase';
import { logger } from '@/lib/utils/logger';
import { AppError } from '@/lib/utils/error-handler';

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

function isSchemaNotDeployed(message: string): boolean {
  return (
    message.includes('PGRST205') ||
    message.includes('42P01') ||
    message.includes('does not exist') ||
    message.includes('Could not find the table')
  );
}

function wrapDbError(action: string, message: string): AppError {
  if (isSchemaNotDeployed(message)) {
    return new AppError(
      'Schema not deployed. Run supabase/schema.sql in Supabase SQL Editor.',
      500,
      'SCHEMA_NOT_DEPLOYED',
      { action, dbError: message },
    );
  }
  return new AppError(`Failed to ${action}`, 500, 'DB_ERROR', message);
}

// ---------------------------------------------------------------------------
// List — paginated, newest first, with related fields/exceptions/documents
// ---------------------------------------------------------------------------

export async function getShipments(
  client: SupabaseClient,
  options: { page?: number; limit?: number } = {},
): Promise<PaginatedResult<ShipmentEntry>> {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 20));
  const offset = (page - 1) * limit;

  const {
    data: shipments,
    error,
    count,
  } = await client
    .from('shipments')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    logger.error('ShipmentService: fetch shipments failed', {
      error: error.message,
    });
    throw wrapDbError('fetch shipments', error.message);
  }

  if (!shipments || shipments.length === 0) {
    return {
      data: [],
      pagination: { page, limit, total: 0, totalPages: 0 },
    };
  }

  const shipmentIds = shipments.map((s) => s.id);

  // Fetch related rows in parallel — single round-trip per table.
  const [fieldsRes, exceptionsRes, documentsRes] = await Promise.all([
    client.from('document_fields').select('*').in('shipment_id', shipmentIds),
    client.from('exceptions').select('*').in('shipment_id', shipmentIds),
    client.from('documents').select('*').in('shipment_id', shipmentIds),
  ]);

  if (fieldsRes.error) {
    logger.warn('ShipmentService: fetch fields failed', {
      error: fieldsRes.error.message,
    });
  }
  if (exceptionsRes.error) {
    logger.warn('ShipmentService: fetch exceptions failed', {
      error: exceptionsRes.error.message,
    });
  }
  if (documentsRes.error) {
    logger.warn('ShipmentService: fetch documents failed', {
      error: documentsRes.error.message,
    });
  }

  const allFields = (fieldsRes.data || []) as DbDocumentField[];
  const allExceptions = (exceptionsRes.data || []) as DbException[];
  const allDocuments = (documentsRes.data || []) as DbDocument[];

  const mappedShipments: ShipmentEntry[] = shipments.map((s: DbShipment) => {
    const fields = allFields.filter((f) => f.shipment_id === s.id);
    const exceptions = allExceptions.filter((e) => e.shipment_id === s.id);
    const documents = allDocuments.filter((d) => d.shipment_id === s.id);
    return mapDbToShipment(s, fields, exceptions, documents);
  });

  const total = count || 0;
  return {
    data: mappedShipments,
    pagination: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  };
}

// ---------------------------------------------------------------------------
// Get one — full detail for the EntryDetailView page
// ---------------------------------------------------------------------------

export async function getShipmentById(
  client: SupabaseClient,
  shipmentId: string,
): Promise<ShipmentEntry | null> {
  const { data: shipment, error } = await client
    .from('shipments')
    .select('*')
    .eq('id', shipmentId)
    .maybeSingle();

  if (error) {
    logger.error('ShipmentService: fetch single shipment failed', {
      shipmentId,
      error: error.message,
    });
    throw wrapDbError('fetch shipment', error.message);
  }
  if (!shipment) return null;

  const [fieldsRes, exceptionsRes, documentsRes] = await Promise.all([
    client
      .from('document_fields')
      .select('*')
      .eq('shipment_id', shipmentId),
    client.from('exceptions').select('*').eq('shipment_id', shipmentId),
    client.from('documents').select('*').eq('shipment_id', shipmentId),
  ]);

  if (fieldsRes.error) {
    logger.warn('ShipmentService: fetch fields failed', {
      shipmentId,
      error: fieldsRes.error.message,
    });
  }
  if (exceptionsRes.error) {
    logger.warn('ShipmentService: fetch exceptions failed', {
      shipmentId,
      error: exceptionsRes.error.message,
    });
  }
  if (documentsRes.error) {
    logger.warn('ShipmentService: fetch documents failed', {
      shipmentId,
      error: documentsRes.error.message,
    });
  }

  return mapDbToShipment(
    shipment as DbShipment,
    (fieldsRes.data || []) as DbDocumentField[],
    (exceptionsRes.data || []) as DbException[],
    (documentsRes.data || []) as DbDocument[],
  );
}

// ---------------------------------------------------------------------------
// Create — minimal shipment row (documents get attached via upload pipeline)
// ---------------------------------------------------------------------------

export interface CreateShipmentInput {
  id: string;
  shipper: string;
  consignee: string;
  docsCount?: number;
  urgency?: string;
}

export async function createShipment(
  client: SupabaseClient,
  data: CreateShipmentInput,
): Promise<DbShipment> {
  const payload = {
    id: data.id,
    shipper: data.shipper,
    consignee: data.consignee,
    docs_count: data.docsCount ?? 0,
    urgency: data.urgency ?? 'PENDING',
    // initial_confidence defaults to 0 until extraction runs;
    // current_confidence mirrors it. DB defaults should also cover these.
    initial_confidence: 0,
    current_confidence: 0,
    status: 'Under Review',
  };

  const { data: created, error } = await client
    .from('shipments')
    .insert(payload)
    .select()
    .single();

  if (error) {
    logger.error('ShipmentService: create shipment failed', {
      shipper: data.shipper,
      error: error.message,
    });
    throw wrapDbError('create shipment', error.message);
  }

  logger.info('ShipmentService: created shipment', {
    shipmentId: created.id,
    shipper: created.shipper,
  });

  return created as DbShipment;
}

// ---------------------------------------------------------------------------
// Update — partial patch of a shipment row
// ---------------------------------------------------------------------------

export async function updateShipment(
  client: SupabaseClient,
  shipmentId: string,
  data: Partial<DbShipment>,
): Promise<DbShipment> {
  // Only allow known-safe columns to be updated through this path.
  const allowed: Array<keyof DbShipment> = [
    'shipper',
    'consignee',
    'status',
    'docs_count',
    'urgency',
    'initial_confidence',
    'current_confidence',
  ];

  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (data[key] !== undefined) {
      patch[key] = data[key];
    }
  }
  patch.updated_at = new Date().toISOString();

  const { data: updated, error } = await client
    .from('shipments')
    .update(patch)
    .eq('id', shipmentId)
    .select()
    .maybeSingle();

  if (error) {
    logger.error('ShipmentService: update shipment failed', {
      shipmentId,
      error: error.message,
    });
    throw wrapDbError('update shipment', error.message);
  }
  if (!updated) {
    throw new AppError(
      `Shipment not found: ${shipmentId}`,
      404,
      'NOT_FOUND',
      { shipmentId },
    );
  }

  return updated as DbShipment;
}

// ---------------------------------------------------------------------------
// Delete — cascading cleanup happens at the DB level via FK ON DELETE CASCADE
// ---------------------------------------------------------------------------

export async function deleteShipment(
  client: SupabaseClient,
  shipmentId: string,
): Promise<void> {
  const { error } = await client
    .from('shipments')
    .delete()
    .eq('id', shipmentId);

  if (error) {
    logger.error('ShipmentService: delete shipment failed', {
      shipmentId,
      error: error.message,
    });
    throw wrapDbError('delete shipment', error.message);
  }

  logger.info('ShipmentService: deleted shipment', { shipmentId });
}

// Re-export the mapping helpers so route handlers don't need a second import.
export { mapDbToShipment, mapDbToField, mapDbToException };

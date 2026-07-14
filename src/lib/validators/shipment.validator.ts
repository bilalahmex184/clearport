// ============================================================================
// ClearPort — Shipment Validators
// Zod schemas for shipment create/update payloads. Shared by route handlers
// and (optionally) edge functions to enforce a single source of truth for
// the shape of inbound data.
// ============================================================================

import { z } from 'zod';

export const createShipmentSchema = z.object({
  shipper: z.string().min(1, 'Shipper is required').max(200),
  consignee: z.string().min(1, 'Consignee is required').max(200),
  docsCount: z.number().int().min(0).max(100).default(0),
  urgency: z.string().max(50).default('PENDING'),
});

export const updateShipmentSchema = z.object({
  shipper: z.string().min(1).max(200).optional(),
  consignee: z.string().min(1).max(200).optional(),
  status: z.enum(['Under Review', 'Approved', 'Exported']).optional(),
  urgency: z.string().max(50).optional(),
});

export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;
export type UpdateShipmentInput = z.infer<typeof updateShipmentSchema>;

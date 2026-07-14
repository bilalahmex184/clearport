// ============================================================================
// ClearPort — Exception Validators
// Zod schemas for resolving a single exception and for batch-accepting
// high-confidence exceptions.
// ============================================================================

import { z } from 'zod';

export const updateExceptionSchema = z.object({
  status: z.enum(['Accepted', 'Corrected', 'Rejected']),
  correctedValue: z.string().max(500).optional(),
});

export const batchAcceptSchema = z.object({
  shipmentId: z.string().min(1),
  threshold: z.number().int().min(0).max(100).optional(),
});

export type UpdateExceptionInput = z.infer<typeof updateExceptionSchema>;
export type BatchAcceptInput = z.infer<typeof batchAcceptSchema>;

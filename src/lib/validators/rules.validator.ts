// ============================================================================
// ClearPort — Operational Rules Validator
// Validates updates to the user's operational thresholds.
// ============================================================================

import { z } from 'zod';

export const updateRulesSchema = z.object({
  invoiceThreshold: z.number().int().min(0).max(100).optional(),
  htsThreshold: z.number().int().min(0).max(100).optional(),
  partiesThreshold: z.number().int().min(0).max(100).optional(),
});

export type UpdateRulesInput = z.infer<typeof updateRulesSchema>;

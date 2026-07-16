// ============================================================================
// ClearPort — Multi-Layer Validation System
// ============================================================================
// Schema validation (Zod) + cross-field validation + conditional validation.
// All validation failures specify exact field, reason, and suggested correction.
// ============================================================================

import { z, ZodError } from 'zod';
import { ValidationError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// Validation Result
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: ValidationFieldError[];
}

export interface ValidationFieldError {
  field: string;
  reason: string;
  suggestion?: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Input Validation Schemas (Zod)
// ---------------------------------------------------------------------------

export const shipmentSchema = z.object({
  id: z.string().min(1, 'Shipment ID is required').max(50, 'Shipment ID too long'),
  shipper: z.string().min(1, 'Shipper is required').max(200, 'Shipper name too long'),
  consignee: z.string().min(1, 'Consignee is required').max(200, 'Consignee name too long'),
  status: z.enum(['Under Review', 'Approved', 'Exported']),
  docs_count: z.number().int().min(0).max(1000),
  urgency: z.string().max(50),
  initial_confidence: z.number().int().min(0).max(100),
  current_confidence: z.number().int().min(0).max(100),
});

export const exceptionUpdateSchema = z.object({
  status: z.enum(['Accepted', 'Corrected', 'Rejected']),
  correctedValue: z.string().max(500).optional(),
});

export const inviteSchema = z.object({
  email: z.string().email('Invalid email address'),
  role: z.enum(['admin', 'operator', 'viewer']),
});

export const validationRuleSchema = z.object({
  name: z.string().min(1, 'Rule name is required').max(200),
  field_key: z.string().nullable(),
  rule_type: z.enum(['confidence_threshold', 'math_check', 'cross_doc_match', 'required_field', 'regex_format']),
  config: z.record(z.string(), z.any()),
  severity: z.enum(['block', 'flag', 'warn']),
  is_active: z.boolean(),
});

export const brokerTemplateSchema = z.object({
  name: z.string().min(1, 'Template name is required').max(200),
  direction: z.enum(['import', 'export']),
  delimiter: z.string().default(','),
  encoding: z.string().default('utf-8'),
});

export const fieldMappingSchema = z.object({
  internal_field_key: z.string().min(1, 'Internal field key is required'),
  external_field_name: z.string().min(1, 'External field name is required'),
  transform: z.record(z.string(), z.any()),
  is_required: z.boolean(),
  sort_order: z.number().int(),
});

// ---------------------------------------------------------------------------
// Cross-Field Validation
// ---------------------------------------------------------------------------

/**
 * Validate that gross weight >= net weight (if both present).
 */
export function validateWeightConsistency(fields: Record<string, string>): ValidationFieldError[] {
  const errors: ValidationFieldError[] = [];
  const netWeight = fields['netWeight'];
  const grossWeight = fields['grossWeight'];

  if (netWeight && grossWeight) {
    const net = parseFloat(netWeight.replace(/[^0-9.]/g, ''));
    const gross = parseFloat(grossWeight.replace(/[^0-9.]/g, ''));
    if (!isNaN(net) && !isNaN(gross) && gross < net) {
      errors.push({
        field: 'grossWeight',
        reason: `Gross weight (${grossWeight}) must be greater than or equal to net weight (${netWeight}).`,
        suggestion: 'Check if the weights were swapped or misread.',
        code: 'WEIGHT_INCONSISTENCY',
      });
    }
  }

  return errors;
}

/**
 * Validate that HTS code matches the expected format.
 */
export function validateHTSFormat(value: string): ValidationFieldError[] {
  const errors: ValidationFieldError[] = [];
  if (value && !/^\d{4}\.\d{2}\.\d{4}$/.test(value)) {
    errors.push({
      field: 'htsCode',
      reason: `HTS code "${value}" does not match the required format XXXX.XX.XXXX (e.g., 8471.30.0100).`,
      suggestion: 'Check for missing dots or extra digits.',
      code: 'HTS_FORMAT_INVALID',
    });
  }
  return errors;
}

/**
 * Validate that country of origin is a 2-letter ISO code.
 */
export function validateCountryCode(value: string): ValidationFieldError[] {
  const errors: ValidationFieldError[] = [];
  if (value && !/^[A-Z]{2}$/.test(value)) {
    errors.push({
      field: 'countryOfOrigin',
      reason: `Country code "${value}" must be exactly 2 uppercase letters (e.g., US, CN, DE).`,
      suggestion: 'Use ISO 3166-1 alpha-2 format.',
      code: 'COUNTRY_FORMAT_INVALID',
    });
  }
  return errors;
}

/**
 * Validate that declared value is a positive currency amount.
 */
export function validateDeclaredValue(value: string): ValidationFieldError[] {
  const errors: ValidationFieldError[] = [];
  if (value) {
    const num = parseFloat(value.replace(/[^0-9.]/g, ''));
    if (isNaN(num)) {
      errors.push({
        field: 'declaredValue',
        reason: `Declared value "${value}" is not a valid number.`,
        suggestion: 'Ensure the value includes only digits, decimal point, and currency symbol.',
        code: 'VALUE_NOT_NUMERIC',
      });
    } else if (num <= 0) {
      errors.push({
        field: 'declaredValue',
        reason: `Declared value must be greater than zero.`,
        code: 'VALUE_NOT_POSITIVE',
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Conditional Validation (based on context)
// ---------------------------------------------------------------------------

export interface ValidationContext {
  document_type?: string;
  org_rules?: {
    invoice_threshold?: number;
    hts_threshold?: number;
    parties_threshold?: number;
  };
  is_export?: boolean;
}

/**
 * Run all cross-field validations based on the provided fields + context.
 */
export function validateBusinessRules(
  fields: Record<string, string>,
  context?: ValidationContext,
): ValidationFieldError[] {
  const errors: ValidationFieldError[] = [];

  // Always validate format
  if (fields['htsCode']) errors.push(...validateHTSFormat(fields['htsCode']));
  if (fields['countryOfOrigin']) errors.push(...validateCountryCode(fields['countryOfOrigin']));
  if (fields['declaredValue']) errors.push(...validateDeclaredValue(fields['declaredValue']));

  // Cross-field validations
  errors.push(...validateWeightConsistency(fields));

  // Conditional: if exporting, require invoiceNo + declaredValue
  if (context?.is_export) {
    if (!fields['invoiceNo']) {
      errors.push({
        field: 'invoiceNo',
        reason: 'Invoice number is required for export.',
        code: 'REQUIRED_FOR_EXPORT',
      });
    }
    if (!fields['declaredValue']) {
      errors.push({
        field: 'declaredValue',
        reason: 'Declared value is required for export.',
        code: 'REQUIRED_FOR_EXPORT',
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Schema Validation Wrapper
// ---------------------------------------------------------------------------

/**
 * Validate data against a Zod schema.
 * Returns a ValidationResult with field-specific errors.
 */
export function validateSchema<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
): { success: true; data: T } | { success: false; errors: ValidationFieldError[] } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors: ValidationFieldError[] = result.error.errors.map((err: any) => ({
    field: err.path.join('.'),
    reason: err.message,
    code: `SCHEMA_${err.code.toUpperCase()}`,
  }));

  return { success: false, errors };
}

/**
 * Validate and throw ValidationError on failure.
 */
export function validateOrThrow<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = validateSchema(schema, data);
  if (!result.success) {
    const firstError = result.errors[0];
    throw new ValidationError(firstError.field, firstError.reason, {
      suggestion: firstError.suggestion,
      context: { all_errors: result.errors },
    });
  }
  return result.data;
}

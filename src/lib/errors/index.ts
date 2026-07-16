// ============================================================================
// ClearPort — Error Handling System
// ============================================================================
// Strict error taxonomy: ValidationError, BusinessError, InfrastructureError,
// ExternalAPIError. Every error has code, message, context, severity.
// No generic "Something went wrong" allowed.
// ============================================================================

import { logger } from '@/lib/observability/logger';

// ---------------------------------------------------------------------------
// Error Severity
// ---------------------------------------------------------------------------

export type ErrorSeverity = 'error' | 'warning' | 'info';

// ---------------------------------------------------------------------------
// Base ClearPortError
// ---------------------------------------------------------------------------

export abstract class ClearPortError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;
  abstract readonly severity: ErrorSeverity;
  readonly context: Record<string, any>;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    message: string,
    options?: {
      context?: Record<string, any>;
      userMessage?: string;
      retryable?: boolean;
      statusCode?: number;
      cause?: Error;
    },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.context = options?.context || {};
    this.userMessage = options?.userMessage || message;
    this.retryable = options?.retryable || false;
    this.statusCode = options?.statusCode || 500;
    if (options?.cause) {
      (this as any).cause = options.cause;
    }
  }

  toJSON() {
    return {
      code: this.code,
      category: this.category,
      message: this.userMessage,
      severity: this.severity,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

// ---------------------------------------------------------------------------
// Error Categories
// ---------------------------------------------------------------------------

export type ErrorCategory = 'validation' | 'business' | 'infrastructure' | 'external_api';

// ---------------------------------------------------------------------------
// ValidationError — input doesn't match expected schema/format
// ---------------------------------------------------------------------------

export class ValidationError extends ClearPortError {
  readonly category = 'validation' as const;
  readonly severity = 'warning' as const;
  readonly field?: string;
  readonly suggestion?: string;

  constructor(
    field: string,
    message: string,
    options?: {
      suggestion?: string;
      context?: Record<string, any>;
      userMessage?: string;
    },
  ) {
    super(message, {
      context: { field, ...options?.context },
      userMessage: options?.userMessage || message,
      statusCode: 422,
      ...options,
    });
    this.field = field;
    this.suggestion = options?.suggestion;
  }

  get code(): string {
    return `VALIDATION_${this.field?.toUpperCase() || 'ERROR'}`;
  }
}

// ---------------------------------------------------------------------------
// BusinessError — business rule violation
// ---------------------------------------------------------------------------

export class BusinessError extends ClearPortError {
  readonly category = 'business' as const;
  readonly severity = 'error' as const;

  constructor(
    code: string,
    message: string,
    options?: {
      context?: Record<string, any>;
      userMessage?: string;
      retryable?: boolean;
    },
  ) {
    super(message, {
      context: options?.context,
      userMessage: options?.userMessage || message,
      statusCode: 403,
      retryable: options?.retryable || false,
      ...options,
    });
    // Override code via a property since it's abstract
    (this as any)._code = code;
  }

  get code(): string {
    return (this as any)._code || 'BUSINESS_ERROR';
  }
}

// ---------------------------------------------------------------------------
// InfrastructureError — DB, storage, internal service failure
// ---------------------------------------------------------------------------

export class InfrastructureError extends ClearPortError {
  readonly category = 'infrastructure' as const;
  readonly severity = 'error' as const;

  constructor(
    service: string,
    message: string,
    options?: {
      context?: Record<string, any>;
      userMessage?: string;
      retryable?: boolean;
      cause?: Error;
    },
  ) {
    super(message, {
      context: { service, ...options?.context },
      userMessage: options?.userMessage || `${service} is temporarily unavailable. Please try again.`,
      statusCode: 503,
      retryable: options?.retryable ?? true,
      cause: options?.cause,
    });
    (this as any)._service = service;
  }

  get code(): string {
    return `INFRA_${(this as any)._service?.toUpperCase() || 'ERROR'}`;
  }
}

// ---------------------------------------------------------------------------
// ExternalAPIError — third-party API failure (Gemini, Cloud Vision, etc.)
// ---------------------------------------------------------------------------

export class ExternalAPIError extends ClearPortError {
  readonly category = 'external_api' as const;
  readonly severity = 'error' as const;
  readonly serviceName: string;

  constructor(
    serviceName: string,
    message: string,
    options?: {
      context?: Record<string, any>;
      userMessage?: string;
      retryable?: boolean;
      statusCode?: number;
      cause?: Error;
    },
  ) {
    super(message, {
      context: { service: serviceName, ...options?.context },
      userMessage: options?.userMessage || `${serviceName} service is unavailable. Please try again later.`,
      statusCode: options?.statusCode || 502,
      retryable: options?.retryable ?? true,
      cause: options?.cause,
    });
    this.serviceName = serviceName;
  }

  get code(): string {
    return `EXTERNAL_${this.serviceName.toUpperCase()}`;
  }
}

// ---------------------------------------------------------------------------
// Error Response Format (API → UI)
// ---------------------------------------------------------------------------

export interface ErrorResponse {
  error: {
    code: string;
    category: ErrorCategory;
    message: string;          // user-safe
    severity: ErrorSeverity;
    retryable: boolean;
    field?: string;           // for validation errors
    suggestion?: string;      // for validation errors
    context?: Record<string, any>; // sanitized — no secrets
    request_id?: string;      // for traceability
  };
}

/**
 * Convert any error to an API-safe ErrorResponse.
 * NEVER leaks internal details, stack traces, or sensitive data.
 */
export function toErrorResponse(err: unknown, requestId?: string): ErrorResponse {
  if (err instanceof ClearPortError) {
    // Log the error with full context
    logger.error(`[${err.category}] ${err.code}: ${err.message}`, {
      error_code: err.code,
      error_category: err.category,
      error_severity: err.severity,
      error_context: err.context,
      stack_trace: err.stack,
      request_id: requestId,
    });

    return {
      error: {
        code: err.code,
        category: err.category,
        message: err.userMessage,
        severity: err.severity,
        retryable: err.retryable,
        ...(err instanceof ValidationError ? { field: err.field, suggestion: err.suggestion } : {}),
        // Only include context if it's safe (no secrets)
        context: sanitizeContext(err.context),
        ...(requestId ? { request_id: requestId } : {}),
      },
    };
  }

  // Unknown error — log full detail, return generic-safe message
  logger.error('[unknown] Unexpected error', {
    error_type: err instanceof Error ? err.constructor.name : 'Unknown',
    error_message: err instanceof Error ? err.message : String(err),
    stack_trace: err instanceof Error ? err.stack : undefined,
    request_id: requestId,
  });

  return {
    error: {
      code: 'INTERNAL_ERROR',
      category: 'infrastructure',
      message: 'An unexpected error occurred. Our team has been notified.',
      severity: 'error',
      retryable: false,
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
}

/**
 * Remove sensitive data from context before sending to UI.
 */
function sanitizeContext(context: Record<string, any>): Record<string, any> {
  const sanitized = { ...context };
  const sensitiveKeys = ['password', 'token', 'secret', 'key', 'authorization', 'api_key'];
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

/**
 * Get HTTP status code from error.
 */
export function getHttpStatus(err: unknown): number {
  if (err instanceof ClearPortError) return err.statusCode;
  return 500;
}

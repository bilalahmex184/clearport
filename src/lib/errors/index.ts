// ============================================================================
// ClearPort — Consolidated Error Handling System
// ============================================================================
// SINGLE source of truth for error responses in ClearPort API routes.
//
// Exports:
//   - AppError                    — the ONE error class (simple, no taxonomy)
//   - errorResponse(err, ...)     — convert any thrown value to a NextResponse
//   - successResponse(data, ...)  — convert a value to a NextResponse
//   - badRequest / unauthorized / forbidden / notFound / conflict /
//     internalError               — convenience constructors for common cases
//
// Canonical response shape (the contract between server + frontend):
//   { error: <message>, code: <code>, details: <details|undefined> }
//
// History: the codebase previously had TWO divergent error shapes:
//   1. A "rich" ClearPortError taxonomy in this file (ValidationError,
//      BusinessError, InfrastructureError, ExternalAPIError) that produced
//      a nested `{ error: { code, category, message, severity, retryable,
//      context, ... } }` shape.
//   2. A "simple" AppError + errorResponse() in @/lib/utils/error-handler.ts
//      that produced the flat `{ error, code, details }` shape.
// Routes used them inconsistently, so the frontend had to handle both.
// Phase 7 Step 3 (p7-3) consolidates them into the flat shape exported here.
// ============================================================================

import { NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

export type ErrorSeverity = 'error' | 'warning' | 'info';

export interface AppErrorOptions {
  severity?: ErrorSeverity;
  retryable?: boolean;
  /** Original cause (preserved for logging / Sentry — never serialized). */
  cause?: unknown;
}

// ---------------------------------------------------------------------------
// AppError — the ONE error class
// ---------------------------------------------------------------------------
// Intentionally simple: just the fields route handlers actually need. The
// previous ClearPortError taxonomy (category/severity/context/userMessage/
// suggestion/field) was over-engineered for a solo-founder codebase and
// produced a different JSON shape than the live errorResponse(), which meant
// the frontend had to handle two shapes. AppError keeps the same positional
// signature as the old @/lib/utils/error-handler version so every existing
// `new AppError(message, statusCode, code, details)` call site keeps working
// unchanged; severity/retryable are added via an optional 5th options arg.
// ---------------------------------------------------------------------------

export class AppError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    message: string,
    statusCode: number = 500,
    code?: string,
    details?: unknown,
    options?: AppErrorOptions,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.severity = options?.severity ?? 'error';
    this.retryable = options?.retryable ?? false;
    this.cause = options?.cause;
    // Restore prototype chain (TS target quirk when extending built-in Error).
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

// ---------------------------------------------------------------------------
// errorResponse — convert any thrown value into a NextResponse
// ---------------------------------------------------------------------------
// Use this as the catch-all in every route handler:
//
//   try {
//     ...
//   } catch (err) {
//     return errorResponse(err);
//   }
//
// Behavior:
//   - AppError → uses its statusCode/code/message/details.
//   - generic Error → 500 with code 'INTERNAL_ERROR' (or defaultStatusCode/
//     defaultCode if the caller wants a different fallback for non-AppError
//     throws, e.g. a route that wants 400 BAD_REQUEST for plain Errors).
//   - null/undefined/string/object → 500 with code 'INTERNAL_ERROR' and a
//     generic message. NEVER throws, NEVER leaks internals.
//
// The body is always the canonical flat shape:
//   { error: <message>, code: <code|undefined>, details: <details|undefined> }
// ---------------------------------------------------------------------------

export function errorResponse(
  err: unknown,
  defaultStatusCode: number = 500,
  defaultCode: string = 'INTERNAL_ERROR',
): NextResponse {
  let statusCode: number;
  let code: string | undefined;
  let message: string;
  let details: unknown;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof Error) {
    statusCode = defaultStatusCode;
    code = defaultCode;
    message = err.message || 'Internal server error';
    details = undefined;
  } else {
    // Defensive: null, undefined, string, plain object, etc.
    statusCode = defaultStatusCode;
    code = defaultCode;
    message = 'An unexpected error occurred';
    details = undefined;
  }

  // Log via the shared structured logger. Wrapped in try/catch so a logger
  // failure can never break the response path (the response is still
  // returned even if logging throws).
  try {
    logger.error(`[errorResponse] ${code ?? 'UNCATEGORIZED'}: ${message}`, {
      statusCode,
      code: code ?? null,
      message,
      errorType: err instanceof Error ? err.constructor.name : typeof err,
      stack: err instanceof Error ? err.stack : undefined,
      details,
    });
  } catch {
    console.error('[errorResponse] logger failed:', {
      statusCode,
      code,
      message,
      details,
      err,
    });
  }

  // Sentry forwarding removed — was causing memory issues in dev. Can be
  // re-added with a lighter config in production if needed.

  return NextResponse.json(
    { error: message, code, details },
    { status: statusCode },
  );
}

// ---------------------------------------------------------------------------
// successResponse — symmetric helper for the happy path
// ---------------------------------------------------------------------------
// Lets route handlers use a consistent pair: successResponse(data) on the
// happy path, errorResponse(err) on the unhappy path. Both produce a
// NextResponse with a JSON body, so routes look uniform.
// ---------------------------------------------------------------------------

export function successResponse(data: unknown, statusCode: number = 200): NextResponse {
  return NextResponse.json(data, { status: statusCode });
}

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------
// Thin wrappers around `new AppError(...)` for the most common HTTP error
// cases. Lets route handlers write `throw badRequest('Invalid email')`
// instead of `throw new AppError('Invalid email', 400, 'BAD_REQUEST')`.
// ---------------------------------------------------------------------------

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError(message, 400, 'BAD_REQUEST', details);
}

export function unauthorized(message: string = 'Unauthorized'): AppError {
  return new AppError(message, 401, 'UNAUTHORIZED');
}

export function forbidden(message: string = 'Forbidden'): AppError {
  return new AppError(message, 403, 'FORBIDDEN');
}

export function notFound(message: string = 'Not found'): AppError {
  return new AppError(message, 404, 'NOT_FOUND');
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError(message, 409, 'CONFLICT', details);
}

export function internalError(
  message: string = 'Internal server error',
  details?: unknown,
): AppError {
  return new AppError(message, 500, 'INTERNAL_ERROR', details);
}

// ---------------------------------------------------------------------------
// Backward-compatibility aliases
// ---------------------------------------------------------------------------
// A few internal call sites use a generic name `validation(...)` helper that
// returned a 422 AppError. Keep the same export so existing imports don't
// break. Prefer `badRequest(...)` with code 'BAD_REQUEST' for new code.
// ---------------------------------------------------------------------------

export function validation(message: string, details?: unknown): AppError {
  return new AppError(message, 422, 'VALIDATION_ERROR', details);
}

// Legacy `errors` object — preserved so any consumer that imported
// `errors.badRequest(...)` etc. keeps working. New code should import the
// named functions directly.
export const errors = {
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  validation,
  internal: internalError,
};

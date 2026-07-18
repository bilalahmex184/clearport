// ============================================================================
// ClearPort — Error Handler
// Provides a single AppError class for expected failures (validation,
// not-found, unauthorized) plus helpers to normalize unknown errors and
// emit a Next.js-compatible JSON Response.
// ============================================================================

import * as Sentry from '@sentry/nextjs';

export interface HandledError {
  message: string;
  code?: string;
  statusCode: number;
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    // Restore prototype chain (TS target quirk when extending built-in Error)
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Normalize any thrown value (AppError, Error, or unknown) into a plain
 * HandledError shape so callers don't need to do their own instanceof dance.
 */
export function handleError(error: unknown): HandledError {
  if (error instanceof AppError) {
    return {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, statusCode: 500 };
  }
  return { message: 'An unexpected error occurred', statusCode: 500 };
}

/**
 * Convert any thrown value into a JSON Response suitable for returning
 * directly from a Next.js route handler or edge function.
 *
 * S6: Forwards the error to Sentry before returning so every API failure
 * (not just unhandled throws) is captured. AppError instances with a code
 * are still captured — Sentry dedupes by stack+message, and the code adds
 * a useful tag for grouping. Sentry.init() is a no-op without a DSN, so
 * captureException is a safe no-op in local dev.
 */
export function errorResponse(error: unknown): Response {
  const { message, code, statusCode, details } = handleError(error);
  // Forward to Sentry. Safe to call without Sentry initialized (no-op).
  // We capture the original thrown value so Sentry sees the real stack.
  try {
    Sentry.captureException(error, {
      tags: { code: code ?? 'UNCATEGORIZED', statusCode: String(statusCode) },
      extra: { message, details },
    });
  } catch {
    // Never let Sentry instrumentation break the response path.
  }
  return Response.json(
    { error: message, code, details },
    { status: statusCode },
  );
}

/**
 * Convenience constructors for the most common AppError cases.
 */
export const errors = {
  badRequest: (message: string, details?: unknown) =>
    new AppError(message, 400, 'BAD_REQUEST', details),
  unauthorized: (message = 'Unauthorized') =>
    new AppError(message, 401, 'UNAUTHORIZED'),
  forbidden: (message = 'Forbidden') =>
    new AppError(message, 403, 'FORBIDDEN'),
  notFound: (message = 'Not found') =>
    new AppError(message, 404, 'NOT_FOUND'),
  conflict: (message: string, details?: unknown) =>
    new AppError(message, 409, 'CONFLICT', details),
  validation: (message: string, details?: unknown) =>
    new AppError(message, 422, 'VALIDATION_ERROR', details),
  internal: (message = 'Internal server error', details?: unknown) =>
    new AppError(message, 500, 'INTERNAL_ERROR', details),
};

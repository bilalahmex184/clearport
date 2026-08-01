// ============================================================================
// 26-error-consolidation.test.ts — Phase 7 Step 3 (p7-3)
// ============================================================================
// Verifies the consolidated error-handling system in `src/lib/errors/index.ts`.
//
// The codebase previously had TWO divergent error-response shapes:
//   1. A "rich" ClearPortError taxonomy in @/lib/errors (nested
//      `{ error: { code, category, message, severity, ... } }`).
//   2. A "simple" AppError + errorResponse() in @/lib/utils/error-handler.ts
//      (flat `{ error, code, details }`).
//
// Phase 7 Step 3 consolidates them into ONE shape exported from
// @/lib/errors. These tests lock in the consolidated contract:
//   - AppError carries message/statusCode/code/details/severity/retryable.
//   - errorResponse() emits the canonical flat JSON shape for any thrown value.
//   - Convenience constructors (badRequest/notFound/etc.) produce the right
//     status codes + machine-readable codes.
//   - successResponse() mirrors errorResponse() on the happy path.
//
// PURE LOGIC tests — uses the real Next.js NextResponse (no network, no DOM).
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  AppError,
  errorResponse,
  successResponse,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  internalError,
  validation,
  errors,
} from '@/lib/errors';

// ---------------------------------------------------------------------------
// Helper: read a NextResponse body as parsed JSON.
// ---------------------------------------------------------------------------
async function readJson(res: Response): Promise<any> {
  return res.json();
}

// ===========================================================================
// TESTS — AppError shape
// ===========================================================================

describe('Phase 7 Step 3 — AppError carries all consolidated fields', () => {
  it('carries message, statusCode, code, details, severity, retryable', () => {
    const err = new AppError(
      'Invoice not found',
      404,
      'NOT_FOUND',
      { invoiceId: 'INV-001' },
      { severity: 'warning', retryable: true },
    );

    expect(err.message).toBe('Invoice not found');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.details).toEqual({ invoiceId: 'INV-001' });
    expect(err.severity).toBe('warning');
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('AppError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('defaults statusCode=500, code=undefined, severity=error, retryable=false', () => {
    const err = new AppError('boom');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBeUndefined();
    expect(err.severity).toBe('error');
    expect(err.retryable).toBe(false);
    expect(err.details).toBeUndefined();
  });

  it('preserves the prototype chain so instanceof works after rethrow', () => {
    const original = new AppError('x', 400, 'BAD_REQUEST');
    // Simulate a rethrow through a boundary: some bundlers lose the prototype
    // chain when an Error subclass crosses an async boundary. The constructor
    // explicitly restores it via Object.setPrototypeOf, so instanceof must
    // still hold.
    const rethrown: unknown = original;
    expect(rethrown).toBeInstanceOf(AppError);
    expect(rethrown).toBeInstanceOf(Error);
  });

  it('accepts cause via the options bag', () => {
    const cause = new Error('underlying');
    const err = new AppError('wrapped', 500, 'INTERNAL_ERROR', undefined, {
      cause,
    });
    expect(err.cause).toBe(cause);
  });
});

// ===========================================================================
// TESTS — errorResponse()
// ===========================================================================

describe('Phase 7 Step 3 — errorResponse() emits the canonical flat shape', () => {
  it('returns the AppError statusCode + body { error, code }', async () => {
    const err = new AppError('test', 400, 'BAD_REQUEST');
    const res = errorResponse(err);

    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body).toEqual({ error: 'test', code: 'BAD_REQUEST' });
    // details is undefined → JSON.stringify drops it → body has no `details` key
    expect(body.details).toBeUndefined();
  });

  it('forwards AppError details in the body when present', async () => {
    const err = new AppError('conflict', 409, 'CONFLICT', { resourceId: 42 });
    const res = errorResponse(err);

    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(body).toEqual({
      error: 'conflict',
      code: 'CONFLICT',
      details: { resourceId: 42 },
    });
  });

  it('wraps a generic Error as 500 INTERNAL_ERROR', async () => {
    const res = errorResponse(new Error('generic'));

    expect(res.status).toBe(500);
    const body = await readJson(res);
    expect(body.error).toBe('generic');
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('returns 500 for null (defensive — never throws)', async () => {
    const res = errorResponse(null);

    expect(res.status).toBe(500);
    const body = await readJson(res);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.error).toBe('An unexpected error occurred');
  });

  it('returns 500 for undefined (defensive)', async () => {
    const res = errorResponse(undefined);

    expect(res.status).toBe(500);
    const body = await readJson(res);
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('returns 500 for a thrown string (defensive)', async () => {
    const res = errorResponse('a bare string');

    expect(res.status).toBe(500);
    const body = await readJson(res);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.error).toBe('An unexpected error occurred');
  });

  it('returns 500 for a thrown plain object (defensive)', async () => {
    const res = errorResponse({ random: 'object' });

    expect(res.status).toBe(500);
    const body = await readJson(res);
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('honors defaultStatusCode/defaultCode for non-AppError throws', async () => {
    // A route that wants plain Errors to surface as 400 BAD_REQUEST (rather
    // than the default 500 INTERNAL_ERROR) can pass overrides.
    const res = errorResponse(new Error('bad input'), 400, 'BAD_REQUEST');

    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.error).toBe('bad input');
  });

  it('AppError statusCode/code always win over the defaults', async () => {
    const err = new AppError('not found', 404, 'NOT_FOUND');
    const res = errorResponse(err, 400, 'BAD_REQUEST');

    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.code).toBe('NOT_FOUND');
    expect(body.error).toBe('not found');
  });

  it('never throws — even on a circular thrown object', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => errorResponse(circular)).not.toThrow();
  });
});

// ===========================================================================
// TESTS — successResponse()
// ===========================================================================

describe('Phase 7 Step 3 — successResponse() mirrors errorResponse()', () => {
  it('returns 200 with the body verbatim by default', async () => {
    const res = successResponse({ data: 1 });

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toEqual({ data: 1 });
  });

  it('honors a custom statusCode (e.g. 201 Created)', async () => {
    const res = successResponse({ id: 'abc' }, 201);

    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body).toEqual({ id: 'abc' });
  });

  it('handles a plain string body', async () => {
    const res = successResponse('ok');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toBe('ok');
  });

  it('handles an array body', async () => {
    const res = successResponse([1, 2, 3]);
    const body = await readJson(res);
    expect(body).toEqual([1, 2, 3]);
  });
});

// ===========================================================================
// TESTS — convenience constructors
// ===========================================================================

describe('Phase 7 Step 3 — convenience constructors', () => {
  it('badRequest(message) → 400 / BAD_REQUEST', () => {
    const err = badRequest('x');
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('x');
  });

  it('badRequest(message, details) → carries details', () => {
    const err = badRequest('missing field', { field: 'invoiceNo' });
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.details).toEqual({ field: 'invoiceNo' });
  });

  it('unauthorized() → 401 / UNAUTHORIZED with default message', () => {
    const err = unauthorized();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('Unauthorized');
  });

  it('unauthorized(custom) → 401 / UNAUTHORIZED with custom message', () => {
    const err = unauthorized('Please log in');
    expect(err.message).toBe('Please log in');
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('forbidden() → 403 / FORBIDDEN with default message', () => {
    const err = forbidden();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('Forbidden');
  });

  it('notFound() → 404 / NOT_FOUND with default message', () => {
    const err = notFound();
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Not found');
  });

  it('notFound(custom) → 404 / NOT_FOUND with custom message', () => {
    const err = notFound('Shipment SHIP-1234 not found');
    expect(err.message).toBe('Shipment SHIP-1234 not found');
  });

  it('conflict(message, details) → 409 / CONFLICT', () => {
    const err = conflict('duplicate', { id: 7 });
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err.details).toEqual({ id: 7 });
  });

  it('internalError() → 500 / INTERNAL_ERROR with default message', () => {
    const err = internalError();
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.message).toBe('Internal server error');
  });

  it('internalError(custom, details) → 500 / INTERNAL_ERROR', () => {
    const err = internalError('DB down', { retryable: true });
    expect(err.message).toBe('DB down');
    expect(err.details).toEqual({ retryable: true });
  });

  it('validation(message, details) → 422 / VALIDATION_ERROR', () => {
    const err = validation('invalid email');
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('legacy `errors` object still exposes all constructors', () => {
    expect(errors.badRequest('x').code).toBe('BAD_REQUEST');
    expect(errors.unauthorized().code).toBe('UNAUTHORIZED');
    expect(errors.forbidden().code).toBe('FORBIDDEN');
    expect(errors.notFound().code).toBe('NOT_FOUND');
    expect(errors.conflict('x').code).toBe('CONFLICT');
    expect(errors.validation('x').code).toBe('VALIDATION_ERROR');
    expect(errors.internal().code).toBe('INTERNAL_ERROR');
  });
});

// ===========================================================================
// TESTS — End-to-end: errorResponse(convenience constructor)
// ===========================================================================

describe('Phase 7 Step 3 — end-to-end: constructors + errorResponse', () => {
  it('badRequest("x") → errorResponse → 400 / { error: "x", code: "BAD_REQUEST" }', async () => {
    const res = errorResponse(badRequest('x'));
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body).toEqual({ error: 'x', code: 'BAD_REQUEST' });
  });

  it('notFound() → errorResponse → 404 / { error: "Not found", code: "NOT_FOUND" }', async () => {
    const res = errorResponse(notFound());
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('conflict(...) → errorResponse → 409 / { error, code, details }', async () => {
    const res = errorResponse(conflict('dup', { id: 7 }));
    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(body).toEqual({
      error: 'dup',
      code: 'CONFLICT',
      details: { id: 7 },
    });
  });
});

// ============================================================================
// ClearPort — Request Middleware
// ============================================================================
// Wraps every API route with:
//   - request_id generation
//   - structured logging (start + end)
//   - latency tracking
//   - error handling (converts any error to ErrorResponse)
//   - zero silent failures
// ============================================================================

import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import {
  createRequestContext,
  clearRequestContext,
  traceRequest,
  logger,
  getRequestContext,
} from '@/lib/observability/logger';
import { toErrorResponse, getHttpStatus, ClearPortError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// API Route Wrapper
// ---------------------------------------------------------------------------

type RouteHandler = (req: Request, ctx: RouteContext) => Promise<Response | NextResponse>;

export interface RouteContext {
  request_id: string;
  user_id?: string;
  organization_id?: string;
}

/**
 * Wrap an API route handler with observability + error handling.
 *
 * Usage:
 *   export const POST = withMiddleware(async (req, ctx) => {
 *     startStage('business_logic');
 *     // ... your logic
 *     endStage('business_logic');
 *     return NextResponse.json({ success: true });
 *   });
 */
export function withMiddleware(handler: RouteHandler): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const requestId = randomUUID();
    const action = `${req.method} ${new URL(req.url).pathname}`;

    // Extract user_id and org_id from headers if available
    const userId = req.headers.get('x-user-id') || undefined;
    const orgId = req.headers.get('x-org-id') || undefined;

    return traceRequest(
      action,
      async (ctx) => {
        logger.info(`Request started: ${action}`, {
          method: req.method,
          path: new URL(req.url).pathname,
        });

        try {
          const response = await handler(req, {
            request_id: ctx.request_id,
            user_id: userId,
            organization_id: orgId,
          });

          // If it's a NextResponse, add request_id header
          if (response instanceof NextResponse) {
            response.headers.set('X-Request-Id', ctx.request_id);
          }

          return response;
        } catch (err) {
          logger.error(`Unhandled error in route: ${action}`, {
            error_type: err instanceof Error ? err.constructor.name : 'Unknown',
            error_message: err instanceof Error ? err.message : String(err),
            stack_trace: err instanceof Error ? err.stack : undefined,
          });

          const errorResponse = toErrorResponse(err, ctx.request_id);
          const status = getHttpStatus(err);

          return NextResponse.json(errorResponse, {
            status,
            headers: { 'X-Request-Id': ctx.request_id },
          });
        }
      },
      { userId, orgId },
    ).catch(() => {
      // traceRequest already logged + rejected — return a fallback response
      // This should never execute because traceRequest resolves/rejects internally,
      // but if it does, we return a safe error.
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', severity: 'error', retryable: false } },
        { status: 500, headers: { 'X-Request-Id': requestId } },
      );
    });
  };
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

export async function healthCheck(): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy';
  services: Record<string, { status: string; latency_ms?: number }>;
}> {
  const services: Record<string, { status: string; latency_ms?: number }> = {};

  // Check Supabase
  try {
    const start = performance.now();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (supabaseUrl) {
      const res = await fetch(`${supabaseUrl}/rest/v1/`, {
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '' },
        signal: AbortSignal.timeout(5000),
      });
      services.supabase = { status: res.ok ? 'healthy' : 'degraded', latency_ms: Math.round(performance.now() - start) };
    } else {
      services.supabase = { status: 'unconfigured' };
    }
  } catch (err) {
    services.supabase = { status: 'unhealthy' };
  }

  // Check edge functions
  try {
    const start = performance.now();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (supabaseUrl) {
      const res = await fetch(`${supabaseUrl}/functions/v1/get-shipments`, {
        method: 'POST',
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      });
      services.edge_functions = { status: res.status === 401 ? 'healthy' : 'degraded', latency_ms: Math.round(performance.now() - start) };
    } else {
      services.edge_functions = { status: 'unconfigured' };
    }
  } catch {
    services.edge_functions = { status: 'unhealthy' };
  }

  // Overall status
  const allHealthy = Object.values(services).every((s) => s.status === 'healthy' || s.status === 'unconfigured');
  const anyUnhealthy = Object.values(services).some((s) => s.status === 'unhealthy');

  return {
    status: anyUnhealthy ? 'unhealthy' : allHealthy ? 'healthy' : 'degraded',
    services,
  };
}

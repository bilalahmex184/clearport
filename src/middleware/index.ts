// ============================================================================
// ClearPort — Request Middleware
// ============================================================================
// Two distinct concerns live here:
//
//   1. `requestMiddleware` — a Next.js middleware (activated by src/middleware.ts)
//      that runs on every matched request, generates a request_id, logs the
//      request, and stamps the response with `X-Request-Id`. Lightweight by
//      design — no DB calls, no auth, no body parsing.
//
//   2. `withMiddleware` — a per-route-handler wrapper that adds structured
//      logging + error handling around an individual API route. Opt-in per
//      route; not currently used by the live routes (see worklog P5).
//
// Both share the observability logger so all output is structured JSON.
// ============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import {
  createRequestContext,
  clearRequestContext,
  traceRequest,
  logger,
  getRequestContext,
} from '@/lib/observability/logger';
import { toErrorResponse, getHttpStatus, ClearPortError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// Public routes — no auth required
// ---------------------------------------------------------------------------
// These routes are accessible without a session: the auth pages themselves,
// the legal pages, and the invite-acceptance flow (which handles its own auth).
const PUBLIC_ROUTES = new Set([
  '/login',
  '/signup',
  '/reset-password',
  '/accept-invite',
  '/terms',
  '/privacy',
  '/legal',
]);

function isPublicRoute(pathname: string): boolean {
  // Exact match for static public routes
  if (PUBLIC_ROUTES.has(pathname)) return true;
  // API routes handle their own auth (Bearer token check in requireOrgRole)
  if (pathname.startsWith('/api/')) return true;
  // Next.js internal routes
  if (pathname.startsWith('/_next/')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Next.js Middleware (runs on every matched request)
// ---------------------------------------------------------------------------

/**
 * Next.js middleware entry point. Activated by `src/proxy.ts`.
 *
 * Two concerns:
 *   1. Request observability: generates a request_id, logs the request line,
 *      stamps the response with X-Request-Id, and propagates the id to
 *      downstream API routes via the x-request-id header.
 *   2. Auth guard: checks for a Supabase session on non-public routes. If no
 *      session (and demo mode is off), redirects to /login. API routes handle
 *      their own auth (Bearer token), so they're exempt.
 */
export async function requestMiddleware(req: NextRequest): Promise<NextResponse> {
  const requestId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const method = req.method;
  const path = req.nextUrl.pathname;

  // Lightweight per-request log line. Structured JSON so it's grep-able in
  // dev.log and shippable to a log aggregator in prod.
  logger.info(`[middleware] ${method} ${path}`, {
    request_id: requestId,
    method,
    path,
  });

  // Propagate request_id to downstream route handlers via a custom header
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-request-id', requestId);

  // ── Auth guard ──
  // Check for a Supabase session on non-public, non-API routes. If no session
  // and demo mode is off, redirect to /login.
  if (!isPublicRoute(path)) {
    const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
    if (!demoMode) {
      // Read the session token from the supabase auth cookie. The cookie name
      // follows the pattern sb-<project-ref>-auth-token. We check for its
      // presence — the actual session validation happens server-side in the
      // API routes via requireOrgRole(). This is just a redirect guard to
      // avoid a flash of "logged out" content.
      const hasAuthCookie = req.cookies.getAll().some(c =>
        c.name.startsWith('sb-') && c.name.includes('auth-token')
      );

      if (!hasAuthCookie) {
        const loginUrl = new URL('/login', req.url);
        loginUrl.searchParams.set('redirect', path);
        const redirectResponse = NextResponse.redirect(loginUrl);
        redirectResponse.headers.set('X-Request-Id', requestId);
        return redirectResponse;
      }
    }
  }

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // Surface request_id on the response so the UI / client can correlate.
  response.headers.set('X-Request-Id', requestId);

  return response;
}

// ---------------------------------------------------------------------------
// API Route Wrapper (opt-in per route)
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
    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

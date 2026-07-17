// ============================================================================
// ClearPort — Next.js Proxy Entry Point (replaces deprecated middleware.ts)
// ============================================================================
// Next.js 16 deprecated the `middleware.ts` convention in favor of `proxy.ts`.
// This file serves the same role: it runs on every matched request, generates
// a request_id, logs the request, and stamps the response with X-Request-Id.
//
// The implementation lives in `src/middleware/index.ts` so it can be unit
// tested and co-located with the per-route `withMiddleware` wrapper. This
// file just re-exports the default + the matcher config.
// ============================================================================

import { requestMiddleware } from './middleware/index';

export default requestMiddleware;

// ---------------------------------------------------------------------------
// Matcher — runs on every route EXCEPT static assets.
// ---------------------------------------------------------------------------

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

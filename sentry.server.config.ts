// ============================================================================
// ClearPort — Sentry Node.js SDK initialization (server runtime)
// ============================================================================
//
// Loaded automatically by `withSentryConfig` on the Node.js server runtime
// (route handlers with `export const runtime = 'nodejs'`, server components,
// server actions). Captures unhandled exceptions on the server side.
//
// No-op when SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN is unset — local dev works
// without a Sentry project.
//
// See: https://docs.sentry.io/platforms/javascript/guides/nextjs/
// ============================================================================

import * as Sentry from '@sentry/nextjs';

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV || 'development',
  });
}

// ============================================================================
// ClearPort — Sentry Browser SDK initialization
// ============================================================================
//
// Loaded automatically by `withSentryConfig` (in next.config.ts) on the client
// bundle. Captures unhandled exceptions, promise rejections, and 10% of
// performance transactions (tracesSampleRate: 0.1) in the browser.
//
// No-op when NEXT_PUBLIC_SENTRY_DSN / SENTRY_DSN is unset — local dev works
// without a Sentry project. The DSN is public (NEXT_PUBLIC_*) on purpose:
// it only authorizes sending events, not reading them.
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

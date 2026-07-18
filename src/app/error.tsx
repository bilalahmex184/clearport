'use client';

import * as React from 'react';
import * as Sentry from '@sentry/nextjs';
import { ErrorFallback } from '@/components/clearport/ErrorBoundary';

// ---------------------------------------------------------------------------
// Next.js App Router error boundary (route-segment level).
// ---------------------------------------------------------------------------
// This file is the Next.js convention for catching errors thrown while
// rendering any route segment under src/app/ (server OR client components).
// It receives `error` (the thrown value) and `reset` (a Next.js-provided
// callback that re-renders the segment) from the framework.
//
// We report the error to Sentry on mount, then render the same shared
// <ErrorFallback> UI used by the <ErrorBoundary> class component so every
// failure path looks identical to the user. The "Reload" button calls
// Next.js's `reset()` first (which attempts a soft re-render of the segment)
// and then forces a full page reload — that way we recover from transient
// render errors without losing the page, but always have a hard-reload escape
// hatch for deeper state corruption.
// ---------------------------------------------------------------------------

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  React.useEffect(() => {
    try {
      Sentry.captureException(error, {
        tags: { source: 'app/error.tsx' },
      });
    } catch (reportErr) {
      console.error('[app/error.tsx] failed to report to Sentry:', reportErr);
    }
  }, [error]);

  const handleReload = React.useCallback(() => {
    try {
      reset();
    } catch (resetErr) {
      console.warn('[app/error.tsx] reset() threw:', resetErr);
    }
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, [reset]);

  return <ErrorFallback error={error} onReload={handleReload} />;
}

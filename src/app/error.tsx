'use client';

import * as React from 'react';
import { ErrorFallback } from '@/components/clearport/ErrorBoundary';

// ---------------------------------------------------------------------------
// Next.js App Router error boundary (route-segment level).
// Catches errors thrown while rendering any route segment under src/app/.
// Renders the shared <ErrorFallback> UI. Sentry reporting removed (was causing
// memory issues in dev; can be re-added with a lighter config in production).
// ---------------------------------------------------------------------------

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  React.useEffect(() => {
    console.error('[app/error.tsx]', error);
  }, [error]);

  const handleReload = React.useCallback(() => {
    try { reset(); } catch (e) { console.warn('[app/error.tsx] reset() threw:', e); }
    if (typeof window !== 'undefined') window.location.reload();
  }, [reset]);

  return <ErrorFallback error={error} onReload={handleReload} />;
}

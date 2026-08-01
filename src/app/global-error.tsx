'use client';

import * as React from 'react';
import { ErrorFallback } from '@/components/clearport/ErrorBoundary';

// ---------------------------------------------------------------------------
// Next.js global error boundary (root-layout level).
// Must render its own <html> + <body> tags. Sentry removed (memory fix).
// ---------------------------------------------------------------------------

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  React.useEffect(() => {
    console.error('[app/global-error.tsx]', error);
  }, [error]);

  const handleReload = React.useCallback(() => {
    try { reset(); } catch (e) { console.warn('[app/global-error.tsx] reset() threw:', e); }
    if (typeof window !== 'undefined') window.location.reload();
  }, [reset]);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-[#06070a] text-gray-200 font-sans">
        <ErrorFallback error={error} onReload={handleReload} />
      </body>
    </html>
  );
}

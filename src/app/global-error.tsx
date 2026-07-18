'use client';

import * as React from 'react';
import * as Sentry from '@sentry/nextjs';
import { ErrorFallback } from '@/components/clearport/ErrorBoundary';

// ---------------------------------------------------------------------------
// Next.js global error boundary (root-layout level).
// ---------------------------------------------------------------------------
// This file catches errors thrown while rendering the ROOT layout
// (src/app/layout.tsx). When it fires, Next.js replaces the entire document
// — including <html> and <body> — so this component MUST render its own
// <html> + <body> tags (the standard layout's wrapper is gone by the time we
// get here). This is a hard Next.js requirement; omitting them produces a
// blank page instead of a fallback.
//
// We inline the fallback markup (rather than reusing <ErrorFallback> directly)
// because the shared component assumes the layout has already set up the dark
// theme + Inter / JetBrains Mono fonts on <body>. Here we own the document
// shell, so we set those classes ourselves and then render the same dark card.
// ---------------------------------------------------------------------------

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  React.useEffect(() => {
    try {
      Sentry.captureException(error, {
        tags: { source: 'app/global-error.tsx' },
      });
    } catch (reportErr) {
      console.error('[app/global-error.tsx] failed to report to Sentry:', reportErr);
    }
  }, [error]);

  const handleReload = React.useCallback(() => {
    try {
      reset();
    } catch (resetErr) {
      console.warn('[app/global-error.tsx] reset() threw:', resetErr);
    }
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, [reset]);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-[#06070a] text-gray-200 font-sans">
        <ErrorFallback error={error} onReload={handleReload} />
      </body>
    </html>
  );
}

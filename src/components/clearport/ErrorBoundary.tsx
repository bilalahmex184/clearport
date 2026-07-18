'use client';

import * as React from 'react';
import * as Sentry from '@sentry/nextjs';

// ---------------------------------------------------------------------------
// ErrorBoundary — class component that catches render-time exceptions in its
// subtree, reports them to Sentry, and renders a graceful dark-theme fallback
// (instead of a white screen) with a Reload button.
//
// Error boundaries MUST be class components in React — there is no hook
// equivalent. getDerivedStateFromError() flips the boundary into its fallback
// state; componentDidCatch() reports the error to Sentry with the React
// component stack so engineers can trace which subtree blew up.
//
// Mounted in src/app/page.tsx around <AppShell /> inside <ClearPortProvider>.
// The shared <ErrorFallback> UI is also reused by the Next.js convention
// files src/app/error.tsx (route-level boundary) and src/app/global-error.tsx
// (root-layout boundary) so all three failure paths look identical.
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // Flip into fallback render. Sentry reporting happens in componentDidCatch
    // so we have access to the component stack.
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Report to Sentry. Wrapped in try/catch so a Sentry init failure can
    // never block the user's path to the Reload button.
    try {
      Sentry.captureException(error, {
        contexts: {
          react: { componentStack: errorInfo.componentStack },
        },
        tags: { source: 'ErrorBoundary' },
      });
    } catch (reportErr) {
      console.error('[ErrorBoundary] failed to report to Sentry:', reportErr);
    }
  }

  handleReload = (): void => {
    // Clear the boundary state so a remounted subtree gets a fresh start,
    // then force a full page reload to blow away any corrupted client state.
    this.setState({ hasError: false, error: null });
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render(): React.ReactNode {
    if (this.state.hasError && this.state.error) {
      return (
        <ErrorFallback
          error={this.state.error}
          onReload={this.handleReload}
        />
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// ErrorFallback — shared dark-theme fallback UI used by:
//   1. <ErrorBoundary> (render-time exceptions in the React tree)
//   2. src/app/error.tsx (Next.js route-level error boundary)
//   3. src/app/global-error.tsx (Next.js root-layout error boundary)
//
// Exported so the three call sites stay visually identical and any future
// styling change only needs to happen in one place.
// ---------------------------------------------------------------------------

interface ErrorFallbackProps {
  error: Error & { digest?: string };
  onReload: () => void;
}

export function ErrorFallback({ error, onReload }: ErrorFallbackProps): React.ReactElement {
  return (
    <div className="min-h-screen bg-[#06070a] text-gray-200 flex items-center justify-center p-6 font-sans">
      <div className="max-w-md w-full bg-[#0c0d12] border border-red-900/40 rounded-xl p-8 text-center">
        <div className="w-14 h-14 bg-red-950/40 border border-red-900 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg
            className="w-7 h-7 text-red-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>

        <h2 className="text-sm font-bold text-amber-400 uppercase font-mono tracking-wider mb-2">
          Application Error
        </h2>

        <p className="text-xs text-gray-400 leading-relaxed mb-4">
          ClearPort encountered an unexpected error. The details below have been
          logged to Sentry. Try reloading the application.
        </p>

        <pre className="text-[10px] text-gray-500 font-mono bg-black/40 border border-gray-900 rounded p-2 mb-4 overflow-x-auto max-h-32 overflow-y-auto text-left whitespace-pre-wrap break-all">
          {error.message || String(error)}
          {error.digest ? `\n[digest: ${error.digest}]` : ''}
        </pre>

        <button
          type="button"
          onClick={onReload}
          className="w-full bg-amber-500 hover:bg-amber-600 text-black text-xs font-bold px-4 py-2.5 rounded-lg transition-all cursor-pointer uppercase tracking-wider"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

'use client';

import * as React from 'react';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error('[ClearPort Error Boundary]', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-[#06070a] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-[#0c0d12] border border-red-900/40 rounded-xl p-8 text-center">
        <div className="w-14 h-14 bg-red-950/40 border border-red-900 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h2 className="text-sm font-bold text-red-400 uppercase font-mono tracking-wider mb-2">
          Application Error
        </h2>
        <p className="text-xs text-gray-400 leading-relaxed mb-4">
          ClearPort encountered an unexpected error. The error has been logged. Try reloading the application.
        </p>
        <pre className="text-[10px] text-gray-600 font-mono bg-black/40 border border-gray-900 rounded p-2 mb-4 overflow-x-auto max-h-32 overflow-y-auto text-left">
          {error.message}
        </pre>
        <button
          onClick={reset}
          className="w-full bg-amber-500 hover:bg-amber-600 text-black text-xs font-bold px-4 py-2.5 rounded-lg transition-all cursor-pointer uppercase tracking-wider"
        >
          Reload Application
        </button>
      </div>
    </div>
  );
}

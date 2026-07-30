'use client';
// ============================================================================
// OnboardingBanner.tsx — first-run onboarding flow (FIX 10)
// ============================================================================
// Two exports:
//
//   OnboardingBanner (default)
//     Dismissible amber banner shown at the top of the Exception Desk when
//     the user has 0 shipments AND hasn't dismissed it before (localStorage
//     flag 'clearport-onboarding-dismissed'). Calls onGoToIngest() to flip
//     to the Ingest Desk tab and onDismiss() to hide + persist the flag.
//
//   FirstUploadTooltip (named)
//     Small pulsing highlight overlay rendered on top of the Ingest Desk
//     upload zone the first time a user lands on the Ingest tab. Self-
//     manages its own visibility via the localStorage flag
//     'clearport-first-upload'. Mount it inside the upload zone's `relative`
//     parent — it positions itself absolutely over the drop zone.
//
// Both components are no-ops during SSR (localStorage isn't available) and
// only become visible after the mount effect runs, so they're safe to render
// inside Next.js App Router pages.
// ============================================================================

import * as React from 'react';
import { UploadCloud, X } from 'lucide-react';
import { useClearPort } from '@/context/ClearPortContext';

// ---------------------------------------------------------------------------
// OnboardingBanner
// ---------------------------------------------------------------------------

export interface OnboardingBannerProps {
  /** Hide the banner + persist the dismissal to localStorage. */
  onDismiss: () => void;
  /** Switch to the Ingest Desk tab. */
  onGoToIngest: () => void;
}

/**
 * Amber-themed dismissible banner shown above the Exception Desk content
 * when the user has 0 shipments and hasn't dismissed it before.
 *
 * Visibility is owned by the parent (ExceptionDesk) — it decides when to
 * mount this component based on `entries.length === 0` + the localStorage
 * flag. This component only handles its own rendering + the dismiss/click
 * callbacks. Keeping the visibility logic in the parent means the banner
 * disappears instantly on dismiss (no flash of stale content while a
 * child effect re-runs).
 */
export default function OnboardingBanner({
  onDismiss,
  onGoToIngest,
}: OnboardingBannerProps) {
  const { theme } = useClearPort();

  // Dark theme uses the exact classes from the spec; light theme mirrors
  // AlertBanner's pattern with amber-50 / amber-200 / amber-800 so the
  // banner remains legible in either theme.
  const wrapperClass =
    theme === 'light'
      ? 'bg-amber-50 border-amber-200 text-amber-800'
      : 'bg-amber-950/30 border-amber-900/40 text-amber-400';

  const buttonClass =
    theme === 'light'
      ? 'bg-amber-500 hover:bg-amber-400 text-black'
      : 'bg-amber-500 hover:bg-amber-400 text-black';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`shrink-0 border-b px-4 py-3 flex items-center gap-3 ${wrapperClass}`}
    >
      <UploadCloud className="w-5 h-5 shrink-0" />

      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-tight">
          Welcome to ClearPort!
        </p>
        <p className="text-xs opacity-80 leading-tight mt-0.5">
          Upload your first customs document to get started.
        </p>
      </div>

      <button
        type="button"
        onClick={onGoToIngest}
        className={`${buttonClass} px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer shrink-0`}
      >
        Go to Ingest Desk
      </button>

      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss welcome banner"
        className={`p-1 rounded transition-colors cursor-pointer shrink-0 ${
          theme === 'light'
            ? 'text-amber-600/70 hover:text-amber-700'
            : 'text-amber-400/70 hover:text-amber-400'
        }`}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FirstUploadTooltip
// ---------------------------------------------------------------------------

const FIRST_UPLOAD_FLAG = 'clearport-first-upload';

/**
 * Small pulsing highlight overlay for the Ingest Desk upload zone. Shown
 * the first time a user lands on the Ingest tab (localStorage flag
 * 'clearport-first-upload' not yet set). Self-manages its own visibility —
 * no props needed.
 *
 * Layout: an absolutely-positioned overlay covering the parent's full box.
 * The overlay has `pointer-events-none` so the underlying drop zone still
 * receives drag/click events; only the dismiss button is `pointer-events-
 * auto` so it can be clicked.
 *
 * The pulsing amber ring is rendered around the upload zone edge; a small
 * floating chip below points the user at it with a "↓ Upload your first
 * document here" label.
 *
 * Mount this inside the upload zone's `relative` parent so it inherits the
 * correct bounding box. See IngestUpload.tsx for the canonical mount.
 */
export function FirstUploadTooltip() {
  // Lazy initializer: read localStorage once on mount. SSR-safe — the
  // initializer returns false during SSR (window is undefined) and the
  // mount effect re-syncs from the real localStorage value on the client.
  const [visible, setVisible] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(FIRST_UPLOAD_FLAG) !== 'true';
  });

  // Re-sync from localStorage after mount. Handles the SSR → client
  // transition (initial state was false during SSR; this flips it true on
  // the client when the flag isn't set).
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const dismissed =
      window.localStorage.getItem(FIRST_UPLOAD_FLAG) === 'true';
    setVisible(!dismissed);
  }, []);

  const dismiss = React.useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(FIRST_UPLOAD_FLAG, 'true');
    }
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <div className="absolute inset-0 pointer-events-none z-10">
      {/* Pulsing amber ring around the upload zone edge. The ring is
          inset-0 so it traces the parent's border; the parent is the
          upload-zone wrapper, which has a `relative` position. */}
      <div className="absolute inset-0 rounded-2xl ring-4 ring-amber-500/60 animate-pulse" />

      {/* Floating chip below the upload zone pointing up at it. */}
      <div className="absolute -bottom-11 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-amber-950/90 border border-amber-900/40 text-amber-400 px-3 py-1.5 rounded-md text-[11px] font-mono whitespace-nowrap pointer-events-auto shadow-lg">
        <span aria-hidden>↑</span>
        <span>Upload your first document here</span>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss first-upload hint"
          title="Dismiss"
          className="text-amber-400/70 hover:text-amber-400 transition-colors cursor-pointer ml-1"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

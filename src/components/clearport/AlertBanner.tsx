'use client';

// ============================================================================
// AlertBanner — top-of-page banner showing active operational alerts (S6)
// ============================================================================
//
// Polls /api/health/alerts every 60 seconds. Shows a red banner at the top
// of the page if any alerts are active (dead-letter processing jobs, tier
// success rate < 50%, etc.). Renders null when:
//   - userRole is 'viewer' (only admins/operators see ops alerts)
//   - the alerts array is empty
//   - the fetch fails (we silently swallow errors so the rest of the UI
//     keeps working; the next poll will try again)
//
// Designed to be mounted once at the top of src/app/page.tsx — above the
// AnimatePresence view panel — so the banner is always visible regardless
// of which tab is active.
//
// Implementation note: the poll interval + fetch function are stored in
// refs so that ClearPortContext re-renders (which happen frequently — the
// context value is not memoized) don't tear down and re-create the
// setInterval. The interval effect has empty deps and lives for the
// component's lifetime.
// ============================================================================

import * as React from 'react';
import { AlertTriangle, X, RefreshCw } from 'lucide-react';
import { useClearPort } from '@/context/ClearPortContext';

interface Alert {
  type: string;
  severity: 'critical' | 'high' | 'medium';
  message: string;
  createdAt: string;
}

interface AlertsResponse {
  alerts: Alert[];
}

const POLL_INTERVAL_MS = 60_000; // 60 seconds

export default function AlertBanner() {
  const { userRole, theme, apiFetchOrg } = useClearPort();
  const [alerts, setAlerts] = React.useState<Alert[]>([]);
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  // Only admin/operator see the banner. Viewers don't get paged.
  const shouldShow = userRole === 'admin' || userRole === 'operator';

  // Refs that the polling effect reads — kept up to date on every render
  // via the small sync effect below. This decouples the polling interval
  // (which must not be torn down + re-created on every parent re-render)
  // from the latest values of `shouldShow` and `apiFetchOrg`.
  const shouldShowRef = React.useRef(shouldShow);
  const apiFetchOrgRef = React.useRef(apiFetchOrg);
  React.useEffect(() => {
    shouldShowRef.current = shouldShow;
    apiFetchOrgRef.current = apiFetchOrg;
  });

  // The fetch function is intentionally NOT memoized — it reads the latest
  // values from refs every time it's invoked, so it doesn't need to be
  // recreated when those values change.
  const fetchAlerts = React.useCallback(async () => {
    if (!shouldShowRef.current) return; // viewer — no point polling
    try {
      setIsRefreshing(true);
      const res = await apiFetchOrgRef.current<AlertsResponse>('/api/health/alerts');
      setAlerts(Array.isArray(res?.alerts) ? res.alerts : []);
    } catch {
      // Silent failure — the next poll will retry. The banner shouldn't
      // make noise about its own inability to fetch alerts (that would be
      // a meta-alert, which is more annoying than useful).
      setAlerts([]);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // One-shot initial fetch on mount (also picks up role transitions from
  // viewer → admin/operator, since `shouldShow` is in the deps).
  React.useEffect(() => {
    if (!shouldShow) {
      setAlerts([]);
      return;
    }
    fetchAlerts();
  }, [shouldShow, fetchAlerts]);

  // Stable 60s poll interval — lives for the component's lifetime, reads
  // the latest `shouldShow` from the ref each tick so it stops polling
  // when the user becomes a viewer.
  React.useEffect(() => {
    const id = setInterval(() => {
      if (shouldShowRef.current) fetchAlerts();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  // Filter out dismissed alerts (by type+message so re-fires still show).
  const visibleAlerts = React.useMemo(
    () => alerts.filter((a) => !dismissed.has(`${a.type}::${a.message}`)),
    [alerts, dismissed],
  );

  if (!shouldShow || visibleAlerts.length === 0) return null;

  const criticalCount = visibleAlerts.filter((a) => a.severity === 'critical').length;
  const highCount = visibleAlerts.filter((a) => a.severity === 'high').length;
  const mediumCount = visibleAlerts.filter((a) => a.severity === 'medium').length;

  const summary =
    `${visibleAlerts.length} active alert${visibleAlerts.length === 1 ? '' : 's'}` +
    (criticalCount > 0 ? ` • ${criticalCount} critical` : '') +
    (highCount > 0 ? ` • ${highCount} high` : '') +
    (mediumCount > 0 ? ` • ${mediumCount} medium` : '');

  const dismiss = (a: Alert) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(`${a.type}::${a.message}`);
      return next;
    });
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`shrink-0 border-b px-4 py-2 flex items-start gap-3 transition-colors duration-200 ${
        theme === 'light'
          ? 'bg-red-50 border-red-200 text-red-800'
          : 'bg-red-950/40 border-red-500/30 text-red-200'
      }`}
    >
      <AlertTriangle
        className={`w-4 h-4 mt-0.5 shrink-0 ${
          criticalCount > 0
            ? 'text-red-500 animate-pulse'
            : theme === 'light' ? 'text-red-600' : 'text-red-400'
        }`}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[11px] font-bold uppercase tracking-wider">
            {summary}
          </span>
          <button
            onClick={fetchAlerts}
            disabled={isRefreshing}
            title="Re-check now"
            className={`p-0.5 rounded transition-opacity ${
              isRefreshing ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-70 cursor-pointer'
            }`}
          >
            <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Show up to 3 alert messages; the rest are summarized. */}
        <ul className="mt-1 space-y-0.5 text-[11px] font-mono leading-snug">
          {visibleAlerts.slice(0, 3).map((a, i) => (
            <li key={`${a.type}-${i}`} className="flex items-start gap-2">
              <span
                className={`shrink-0 px-1 rounded text-[9px] font-bold uppercase ${
                  a.severity === 'critical'
                    ? (theme === 'light' ? 'bg-red-600 text-white' : 'bg-red-500 text-white')
                    : a.severity === 'high'
                      ? (theme === 'light' ? 'bg-red-200 text-red-800' : 'bg-red-900/60 text-red-200')
                      : (theme === 'light' ? 'bg-amber-200 text-amber-800' : 'bg-amber-900/60 text-amber-200')
                }`}
              >
                {a.severity}
              </span>
              <span className="break-words flex-1">{a.message}</span>
              <button
                onClick={() => dismiss(a)}
                title="Dismiss (until next poll brings it back)"
                className={`shrink-0 p-0.5 rounded transition-opacity hover:opacity-70 ${
                  theme === 'light' ? 'text-red-400' : 'text-red-400/70'
                }`}
              >
                <X className="w-3 h-3" />
              </button>
            </li>
          ))}
          {visibleAlerts.length > 3 && (
            <li className="text-[10px] opacity-70 italic pl-1">
              + {visibleAlerts.length - 3} more alert{visibleAlerts.length - 3 === 1 ? '' : 's'}…
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

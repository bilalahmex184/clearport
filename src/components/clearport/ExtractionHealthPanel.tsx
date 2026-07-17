'use client';

// ============================================================================
// ExtractionHealthPanel — operational health panel for the extraction pipeline
// ============================================================================
//
// Shown on the Dashboard (Command Center). Two sections:
//
//   1. Tier Success Rate (last 24h) — per-tier success/failure/skipped counts
//      + success_rate percentage, sourced from GET /api/extraction-health.
//      Helps admins see at a glance which tier is degrading (e.g. Gemini
//      rate-limiting, Tesseract service down).
//
//   2. Manual Review Queue — documents currently in 'needs_manual_review',
//      sorted oldest-first. Each row is clickable and navigates to the
//      Exception Desk for that shipment so an admin can work the queue.
//
// Auto-refreshes every 30 seconds while mounted. Falls back to an empty
// state when the extraction_attempts table isn't deployed yet (migration
// 017 not run) — the API returns empty arrays in that case.
// ============================================================================

import * as React from 'react';
import { useClearPort } from '@/context/ClearPortContext';
import {
  Activity,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Clock,
  AlertTriangle,
  RefreshCw,
  ChevronRight,
  Inbox,
} from 'lucide-react';

interface TierStat {
  tier: number;
  tier_name: string;
  total: number;
  success: number;
  failure: number;
  skipped: number;
  success_rate: number;
}

interface ManualReviewQueueEntry {
  document_id: string;
  shipment_id: string;
  file_name: string;
  created_at: string;
  processing_status: string;
}

interface HealthResponse {
  tierStats: TierStat[];
  manualReviewQueue: ManualReviewQueueEntry[];
}

const TIER_LABELS: Record<number, string> = {
  1: 'Gemini Vision',
  2: 'PDF Text Layer',
  3: 'Tesseract OCR',
  4: 'Manual Review',
};

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getSuccessRateColor(rate: number): string {
  if (rate >= 80) return 'text-emerald-400 bg-emerald-950/40 border-emerald-900/50';
  if (rate >= 50) return 'text-amber-400 bg-amber-950/40 border-amber-900/50';
  if (rate > 0) return 'text-red-400 bg-red-950/40 border-red-900/50';
  return 'text-gray-500 bg-gray-950/40 border-gray-800';
}

export default function ExtractionHealthPanel() {
  const { apiFetchOrg, selectEntry, setActiveTab } = useClearPort();

  const [data, setData] = React.useState<HealthResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = React.useState<Date | null>(null);

  const load = React.useCallback(async () => {
    try {
      setError(null);
      const res = await apiFetchOrg<HealthResponse>('/api/extraction-health');
      setData(res);
      setLastUpdated(new Date());
    } catch (err) {
      // Non-fatal — the panel degrades to a friendly message. The dashboard
      // itself doesn't crash.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiFetchOrg]);

  // Initial load + 30s auto-refresh.
  React.useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 30000);
    return () => clearInterval(interval);
  }, [load]);

  const handleReview = (shipmentId: string) => {
    selectEntry(shipmentId);
    setActiveTab('exception-desk');
  };

  const tierStats = data?.tierStats ?? [];
  const queue = data?.manualReviewQueue ?? [];
  const hasTierData = tierStats.length > 0;
  const hasQueueData = queue.length > 0;

  return (
    <div className="border rounded-xl bg-[#0c0d12] border-gray-900 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-gray-900 bg-[#0e1017] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="p-1 rounded border bg-black/40 border-gray-800 text-amber-500">
            <Activity className="w-4 h-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Extraction Health</h3>
            <p className="text-[10px] text-gray-500 mt-0.5 font-mono uppercase tracking-wider">
              24h tier success rate • manual review queue
            </p>
          </div>
        </div>
        <button
          onClick={() => void load()}
          className="p-1.5 rounded border border-gray-800 bg-gray-950 text-gray-500 hover:text-gray-300 hover:border-gray-700 transition-all cursor-pointer"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Body */}
      <div className="p-4 space-y-5">
        {error && (
          <div className="flex items-center gap-2 text-xs text-red-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span className="font-mono">Failed to load: {error}</span>
          </div>
        )}

        {/* Section 1: Tier Success Rate */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-gray-500">
              Tier Success Rate (24h)
            </span>
            {lastUpdated && (
              <span className="text-[9px] font-mono text-gray-600" suppressHydrationWarning>
                updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
          </div>

          {loading && !hasTierData ? (
            <div className="space-y-1.5">
              {[1, 2, 3, 4].map((tier) => (
                <div key={tier} className="h-8 rounded bg-gray-950/60 animate-pulse" />
              ))}
            </div>
          ) : hasTierData ? (
            <div className="space-y-1.5">
              {tierStats.map((stat) => (
                <div
                  key={stat.tier}
                  className="flex items-center justify-between gap-2 p-2 rounded bg-gray-950/40 border border-gray-900"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-[10px] font-bold text-gray-500 shrink-0">
                      T{stat.tier}
                    </span>
                    <span className="text-xs text-gray-300 truncate">
                      {TIER_LABELS[stat.tier] || stat.tier_name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Success / failure / skipped mini-counts */}
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-emerald-500" title={`${stat.success} successes`}>
                      <CheckCircle2 className="w-3 h-3" />
                      {stat.success}
                    </span>
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-red-500" title={`${stat.failure} failures`}>
                      <XCircle className="w-3 h-3" />
                      {stat.failure}
                    </span>
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-gray-500" title={`${stat.skipped} skipped`}>
                      <MinusCircle className="w-3 h-3" />
                      {stat.skipped}
                    </span>
                    <span
                      className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border ${getSuccessRateColor(stat.success_rate)}`}
                      title={`${stat.success} of ${stat.total} attempts succeeded`}
                    >
                      {stat.success_rate.toFixed(1)}%
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center py-4 text-[11px] text-gray-600 font-mono uppercase tracking-wider">
              No extraction attempts in the last 24h
            </div>
          )}
        </div>

        {/* Section 2: Manual Review Queue */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-gray-500">
              Manual Review Queue
            </span>
            {hasQueueData && (
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border bg-amber-950/40 border-amber-900/50 text-amber-400">
                {queue.length} WAITING
              </span>
            )}
          </div>

          {loading && !hasQueueData ? (
            <div className="space-y-1.5">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-7 rounded bg-gray-950/60 animate-pulse" />
              ))}
            </div>
          ) : hasQueueData ? (
            <div className="space-y-1 max-h-[240px] overflow-y-auto pr-1">
              {queue.map((entry) => (
                <button
                  key={entry.document_id}
                  onClick={() => handleReview(entry.shipment_id)}
                  className="w-full text-left p-2 rounded bg-gray-950/40 border border-gray-900 hover:border-amber-500/30 hover:bg-gray-950 transition-all cursor-pointer group"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Clock className="w-3 h-3 text-amber-500 shrink-0" />
                      <span className="text-xs font-mono text-gray-300 truncate" title={entry.file_name}>
                        {entry.file_name}
                      </span>
                    </div>
                    <ChevronRight className="w-3 h-3 text-gray-600 group-hover:text-amber-500 shrink-0 transition-colors" />
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5 pl-4.5">
                    <span className="text-[10px] font-mono text-gray-600 truncate">
                      {entry.shipment_id}
                    </span>
                    <span className="text-[10px] font-mono text-gray-500 shrink-0" suppressHydrationWarning>
                      {formatRelativeTime(entry.created_at)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-5 text-center">
              <Inbox className="w-6 h-6 text-emerald-500 mb-1.5" />
              <p className="text-[11px] font-semibold text-gray-400">Queue empty</p>
              <p className="text-[10px] text-gray-600 mt-0.5">No documents awaiting manual review</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

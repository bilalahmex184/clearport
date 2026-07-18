'use client';

// ============================================================================
// ExtractionTracePanel — expandable tier-by-tier extraction audit timeline
// ============================================================================
//
// Shown inside EntryDetailView. Collapsed by default; when expanded it calls
// GET /api/documents/[id]/extraction-trace for every document in the
// shipment (in parallel) and renders a per-document timeline of
// extraction_attempts rows:
//
//   Doc: invoice.pdf (Commercial Invoice)
//     Tier 1  gemini_vision        SUCCESS   823ms   model:gemini-2.5-pro   8 fields
//     Tier 2  pdf_text_layer       SKIPPED   —       Not needed — Tier 1 succeeded
//     Tier 3  cloud_vision         SKIPPED   —       Not needed — earlier tier succeeded
//     Tier 4  tesseract_ocr        SKIPPED   —       Not needed — earlier tier succeeded
//     Tier 5  needs_manual_review  —         —       (not reached)
//
// Documents with zero extraction_attempts rows are hidden entirely (per the
// task spec: "Only shows for documents that have extraction_attempts rows").
//
// Uses the shadcn/ui Collapsible primitive + the project's dark-theme
// styling (matches the EntryDetailView panel chrome).
// ============================================================================

import * as React from 'react';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible';
import {
  ChevronRight,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Clock,
  Activity,
  Loader2,
  FileText,
} from 'lucide-react';

interface ExtractionAttempt {
  id: string;
  document_id: string;
  org_id: string;
  pipeline_trace_id: string;
  tier: number;
  tier_name: string;
  status: 'success' | 'failure' | 'skipped';
  fields_extracted: number | null;
  error_code: string | null;
  error_message: string | null;
  latency_ms: number | null;
  created_at: string;
}

interface DocumentTrace {
  attempts: ExtractionAttempt[];
  document: {
    id: string;
    processing_status: string | null;
    extraction_source: string | null;
  };
}

interface Props {
  documents: Array<{
    id: string;
    docType: string;
    fileName: string;
    mimeType: string | null;
    uploadedAt: string;
  }>;
  apiFetchOrg: <T = any>(path: string, options?: RequestInit & { raw?: boolean }) => Promise<T>;
}

type FetchState = 'idle' | 'loading' | 'loaded' | 'error';

const STATUS_META: Record<
  ExtractionAttempt['status'],
  { label: string; color: string; bg: string; border: string; icon: typeof CheckCircle2 }
> = {
  success: {
    label: 'SUCCESS',
    color: 'text-emerald-400',
    bg: 'bg-emerald-950/40',
    border: 'border-emerald-900/50',
    icon: CheckCircle2,
  },
  failure: {
    label: 'FAILURE',
    color: 'text-red-400',
    bg: 'bg-red-950/40',
    border: 'border-red-900/50',
    icon: XCircle,
  },
  skipped: {
    label: 'SKIPPED',
    color: 'text-gray-400',
    bg: 'bg-gray-950/40',
    border: 'border-gray-800',
    icon: MinusCircle,
  },
};

function formatLatency(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export default function ExtractionTracePanel({ documents, apiFetchOrg }: Props) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [state, setState] = React.useState<FetchState>('idle');
  // Map of documentId → DocumentTrace (only includes docs with attempts)
  const [traces, setTraces] = React.useState<Map<string, DocumentTrace>>(new Map());
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  // Track which documentId is being viewed when there are multiple, so the
  // timeline can be focused. Defaults to the first doc with attempts.
  const [activeDocId, setActiveDocId] = React.useState<string | null>(null);

  // Reset state when the document set changes (e.g. user switches shipments).
  // We key on a stable string of document IDs so the effect fires on real
  // changes, not array-identity churn.
  const docKey = React.useMemo(() => documents.map((d) => d.id).sort().join(','), [documents]);
  React.useEffect(() => {
    setState('idle');
    setTraces(new Map());
    setActiveDocId(null);
    setErrorMsg(null);
    setIsOpen(false);
  }, [docKey]);

  const loadTraces = React.useCallback(async () => {
    if (documents.length === 0) {
      setState('loaded');
      return;
    }
    setState('loading');
    setErrorMsg(null);
    try {
      // Fetch all document traces in parallel. The route returns an empty
      // attempts array for documents with no ledger rows (or if migration
      // 017 isn't deployed yet), so we filter those out below.
      const results = await Promise.all(
        documents.map((doc) =>
          apiFetchOrg<DocumentTrace>(`/api/documents/${doc.id}/extraction-trace`)
            .then((res) => ({ docId: doc.id, res }))
            .catch((err) => {
              // Per-doc fetch failure shouldn't abort the whole panel —
              // just log and treat as "no trace for this doc".
              console.warn('[extraction-trace] fetch failed for', doc.id, err);
              return { docId: doc.id, res: null };
            }),
        ),
      );

      const next = new Map<string, DocumentTrace>();
      for (const { docId, res } of results) {
        if (res && Array.isArray(res.attempts) && res.attempts.length > 0) {
          next.set(docId, res);
        }
      }
      setTraces(next);
      // Auto-select the first doc with attempts so the timeline shows
      // something immediately.
      const firstWithAttempts = results.find((r) => r.res && (r.res.attempts?.length ?? 0) > 0);
      setActiveDocId(firstWithAttempts?.docId ?? null);
      setState('loaded');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [documents, apiFetchOrg]);

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (open && state === 'idle') {
        void loadTraces();
      }
    },
    [state, loadTraces],
  );

  // Render nothing if there are no documents at all (e.g. seed/demo mode).
  if (documents.length === 0) return null;

  const docsWithTraces = Array.from(traces.values());
  const totalAttempts = docsWithTraces.reduce((acc, t) => acc + t.attempts.length, 0);
  const activeTrace = activeDocId ? traces.get(activeDocId) : undefined;

  return (
    <Collapsible open={isOpen} onOpenChange={handleOpenChange} className={`border rounded-xl overflow-hidden bg-[#0c0d12] border-gray-900`}>
      <CollapsibleTrigger asChild>
        <button
          className="w-full p-4 flex items-center justify-between hover:bg-gray-950/40 transition-colors cursor-pointer"
          type="button"
        >
          <div className="flex items-center gap-2.5">
            <span className="p-1 rounded border bg-black/40 border-gray-800 text-gray-400">
              <Activity className="w-4 h-4" />
            </span>
            <div className="text-left">
              <span className="block text-[10px] font-mono uppercase tracking-widest text-gray-500">
                PIPELINE AUDIT TRAIL
              </span>
              <span className="block text-sm font-semibold text-gray-200">
                Extraction Trace
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {state === 'loaded' && totalAttempts > 0 && (
              <span className="font-mono text-[10px] px-2 py-0.5 rounded border bg-gray-950 border-gray-800 text-gray-500">
                {docsWithTraces.length} DOC{docsWithTraces.length !== 1 ? 'S' : ''} • {totalAttempts} ATTEMPTS
              </span>
            )}
            {state === 'loaded' && totalAttempts === 0 && (
              <span className="font-mono text-[10px] px-2 py-0.5 rounded border bg-gray-950 border-gray-800 text-gray-600">
                NO TRACE DATA
              </span>
            )}
            <ChevronRight
              className={`w-4 h-4 text-gray-500 transition-transform ${isOpen ? 'rotate-90' : ''}`}
            />
          </div>
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="border-t border-gray-900 p-4 space-y-4">
          {state === 'loading' && (
            <div className="flex items-center justify-center py-6 text-gray-500 text-xs">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              <span className="font-mono uppercase tracking-wider">Loading trace…</span>
            </div>
          )}

          {state === 'error' && (
            <div className="flex items-center gap-2 py-4 text-red-400 text-xs">
              <XCircle className="w-4 h-4 shrink-0" />
              <span className="font-mono">Failed to load trace: {errorMsg}</span>
            </div>
          )}

          {state === 'loaded' && totalAttempts === 0 && (
            <div className="flex items-center justify-center py-6 text-gray-600 text-xs font-mono uppercase tracking-wider">
              No extraction attempts recorded for this shipment
            </div>
          )}

          {state === 'loaded' && totalAttempts > 0 && (
            <>
              {/* Document selector tabs (only when >1 doc has trace data) */}
              {docsWithTraces.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  {docsWithTraces.map((t) => {
                    const doc = documents.find((d) => d.id === t.document.id);
                    const isActive = activeDocId === t.document.id;
                    return (
                      <button
                        key={t.document.id}
                        onClick={() => setActiveDocId(t.document.id)}
                        className={`text-[10px] font-mono px-2 py-1 rounded border transition-all cursor-pointer truncate max-w-[200px] ${
                          isActive
                            ? 'bg-gray-900 text-amber-400 border-amber-500/30'
                            : 'bg-gray-950 text-gray-500 border-gray-800 hover:text-gray-300'
                        }`}
                        title={doc?.fileName}
                      >
                        {doc?.fileName || t.document.id.slice(0, 8)}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Active document's timeline */}
              {activeTrace && (
                <DocumentTimeline
                  trace={activeTrace}
                  fileName={documents.find((d) => d.id === activeTrace.document.id)?.fileName || activeTrace.document.id}
                />
              )}
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// DocumentTimeline — renders the tier-by-tier timeline for a single document
// ---------------------------------------------------------------------------

function DocumentTimeline({ trace, fileName }: { trace: DocumentTrace; fileName: string }) {
  const { attempts, document: doc } = trace;

  return (
    <div className="space-y-3">
      {/* Document header */}
      <div className="flex items-center justify-between gap-2 pb-2 border-b border-gray-900">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          <span className="text-xs font-mono text-gray-300 truncate" title={fileName}>
            {fileName}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {doc.processing_status && (
            <span
              className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${
                doc.processing_status === 'completed'
                  ? 'bg-emerald-950 text-emerald-400 border-emerald-900/40'
                  : doc.processing_status === 'needs_manual_review'
                    ? 'bg-red-950 text-red-400 border-red-900/40'
                    : doc.processing_status === 'failed'
                      ? 'bg-red-950 text-red-400 border-red-900/40'
                      : 'bg-amber-950 text-amber-400 border-amber-900/40'
              }`}
            >
              {doc.processing_status.toUpperCase()}
            </span>
          )}
          {doc.extraction_source && (
            <span className="text-[9px] font-mono text-gray-500 truncate max-w-[140px]" title={doc.extraction_source}>
              {doc.extraction_source}
            </span>
          )}
        </div>
      </div>

      {/* Tier timeline */}
      <div className="space-y-1.5">
        {attempts.map((att, idx) => {
          const meta = STATUS_META[att.status];
          const Icon = meta.icon;
          const isLast = idx === attempts.length - 1;
          return (
            <div key={att.id} className="relative pl-6">
              {/* Vertical connector line */}
              {!isLast && (
                <div className="absolute left-[10px] top-5 bottom-[-6px] w-px bg-gray-800" />
              )}
              {/* Status dot */}
              <div
                className={`absolute left-0 top-1 w-5 h-5 rounded-full flex items-center justify-center border ${meta.bg} ${meta.border}`}
              >
                <Icon className={`w-3 h-3 ${meta.color}`} />
              </div>
              {/* Row content */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-mono text-[10px] font-bold text-gray-500 shrink-0">
                    T{att.tier}
                  </span>
                  <span className="text-xs font-semibold text-gray-300 truncate">
                    {att.tier_name}
                  </span>
                </div>
                <span
                  className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${meta.bg} ${meta.border} ${meta.color}`}
                >
                  {meta.label}
                </span>
                {att.latency_ms !== null && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-gray-500">
                    <Clock className="w-3 h-3" />
                    {formatLatency(att.latency_ms)}
                  </span>
                )}
                {att.fields_extracted !== null && att.fields_extracted > 0 && (
                  <span className="text-[10px] font-mono text-emerald-500">
                    {att.fields_extracted} field{att.fields_extracted !== 1 ? 's' : ''}
                  </span>
                )}
                {att.error_message && (
                  <span
                    className={`text-[10px] font-mono ${
                      att.status === 'success' ? 'text-gray-500' : 'text-gray-400'
                    } truncate max-w-full`}
                    title={att.error_message}
                  >
                    {att.error_message}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Trace ID footer */}
      {attempts[0]?.pipeline_trace_id && (
        <div className="pt-2 border-t border-gray-950 text-[9px] font-mono text-gray-600 truncate">
          trace: {attempts[0].pipeline_trace_id}
        </div>
      )}
    </div>
  );
}

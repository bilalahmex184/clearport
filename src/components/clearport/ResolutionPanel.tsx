'use client';
// ============================================================================
// ResolutionPanel.tsx — Right panel of the ExceptionDesk
// ============================================================================
// Extracted from ExceptionDesk.tsx (FIX5-7-SPLIT — behavior-preserving).
//
// Renders the selected exception's resolution UI: header (field name, type,
// severity badge), discrepancy reason + explanation, extracted vs cross-doc
// data comparison, the inline manual-override editor, the Accept/Modify/Reject
// action buttons (gated by RBAC), the collapsible audit trail, and the
// keyboard-shortcuts footer. Also owns the window-scoped keyboard handler
// (Space=Accept, E=Edit, R=Reject, Ctrl+Z=Undo) — all of which act on the
// selected exception, so they live here alongside the editor state.
//
// When no exception is selected (all cleared), shows an "All exceptions
// cleared" empty state.
// ============================================================================

import * as React from 'react';
import {
  AlertCircle, CheckCircle2, ChevronRight, RefreshCw, XCircle, Undo2,
} from 'lucide-react';
import type {
  ShipmentEntry, Exception, ReviewerAction,
} from '@/lib/clearport-types';
import { getConfidenceColor, getConfidenceBadge } from './exception-desk-utils';

export interface ResolutionPanelProps {
  selectedEntry: ShipmentEntry;
  selectedException: Exception | undefined;
  onUpdateException: (entryId: string, exceptionId: string, status: ReviewerAction, newValue?: string) => void;
  onUndoLastAction: () => void;
  canResolveExceptions: boolean;
}

export default function ResolutionPanel({
  selectedEntry,
  selectedException,
  onUpdateException,
  onUndoLastAction,
  canResolveExceptions,
}: ResolutionPanelProps) {
  const [isEditing, setIsEditing] = React.useState(false);
  const [editValue, setEditValue] = React.useState('');
  const [showHistory, setShowHistory] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Fix: use useEffect instead of setState-during-render
  React.useEffect(() => {
    if (selectedException) {
      setEditValue(selectedException.correctedValue ?? selectedException.extractedValue);
      setIsEditing(false);
    }
  }, [selectedException?.id]);

  // Keyboard shortcuts (scoped — only when not typing in input)
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') {
          inputRef.current?.blur();
          setIsEditing(false);
        }
        return;
      }

      if (!selectedException || !selectedEntry) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        // Undo is a resolve-adjacent action — gated by the same RBAC check.
        if (!canResolveExceptions) return;
        e.preventDefault();
        onUndoLastAction();
        return;
      }

      // Accept / Modify / Reject shortcuts are no-ops for viewer role.
      if (!canResolveExceptions) return;

      if (e.key === ' ') {
        e.preventDefault();
        onUpdateException(selectedEntry.id, selectedException.id, 'Accepted');
      }

      if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setIsEditing(true);
        setTimeout(() => inputRef.current?.focus(), 50);
      }

      if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        onUpdateException(selectedEntry.id, selectedException.id, 'Rejected');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedException, selectedEntry, onUpdateException, onUndoLastAction, canResolveExceptions]);

  const handleSaveEdit = () => {
    if (selectedException && selectedEntry) {
      onUpdateException(selectedEntry.id, selectedException.id, 'Corrected', editValue);
      setIsEditing(false);
    }
  };

  return (
    <div className="lg:col-span-4 bg-[#0c0d12] border border-gray-900 rounded-xl flex flex-col overflow-hidden min-h-[400px] lg:min-h-0">
      {selectedException ? (
        <div className="flex-1 flex flex-col justify-between overflow-hidden">
          <div className="p-4 space-y-4 overflow-y-auto flex-1">
            {/* Header */}
            <div className="border-b border-gray-900 pb-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-mono text-gray-500 tracking-wider">EXCEPTION FIELD RESOLUTION</span>
                <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded border ${
                  selectedException.status === 'Unresolved'
                    ? getConfidenceColor(selectedException.confidence)
                    : 'bg-gray-950 text-gray-400 border-gray-900'
                }`}>
                  {selectedException.status === 'Unresolved'
                    ? getConfidenceBadge(selectedException.confidence)
                    : selectedException.status.toUpperCase()}
                </span>
              </div>
              <h3 className="text-base font-semibold text-gray-100 tracking-tight leading-tight">
                {selectedException.fieldName}
              </h3>
              <span className="text-[10px] font-mono text-gray-600 uppercase mt-1 block">
                Type: {selectedException.exceptionType.replace(/_/g, ' ')}
              </span>
            </div>

            {/* Discrepancy reason + explanation */}
            <div className="bg-[#120f12] border border-red-950/40 p-3.5 rounded-lg">
              <h4 className="text-[11px] font-mono text-red-400 tracking-wider uppercase mb-1 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" />
                DISCREPANCY WHY:
              </h4>
              <p className="text-xs text-gray-300 leading-normal">{selectedException.reason}</p>
              {selectedException.explanation && selectedException.explanation !== selectedException.reason && (
                <div className="mt-2 pt-2 border-t border-red-950/30">
                  <span className="text-[9px] font-mono text-amber-400 uppercase tracking-wider block mb-0.5">EXPLANATION:</span>
                  <p className="text-[11px] text-amber-300/90 leading-relaxed">{selectedException.explanation}</p>
                </div>
              )}
            </div>

            {/* Data comparison */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-black border border-gray-900 p-3 rounded-lg">
                <span className="text-[10px] text-gray-500 block uppercase tracking-wider font-mono">EXTRACTED (OCR)</span>
                <span className="text-sm font-mono font-bold text-gray-200 block mt-1">
                  {selectedException.extractedValue}
                </span>
                <span className="text-[9px] font-mono text-gray-600 block mt-0.5">
                  Confidence: {selectedException.confidence}%
                </span>
              </div>
              <div className="bg-black border border-gray-900 p-3 rounded-lg">
                <span className="text-[10px] text-gray-500 block uppercase tracking-wider font-mono">CROSS-DOC SOURCE</span>
                <span className="text-sm font-mono font-bold text-gray-400 block mt-1">
                  {selectedException.crossDocValue || '—'}
                </span>
                <span className="text-[9px] font-mono text-gray-600 block mt-0.5">
                  Source: {selectedException.docType}
                </span>
              </div>
            </div>

            {/* Inline editor */}
            <div className="space-y-1.5">
              <label className="text-[11px] text-gray-400 font-mono tracking-wider block uppercase">
                MANUAL / OVERRIDE VALUE:
              </label>
              {isEditing ? (
                <div className="flex gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleSaveEdit();
                      if (e.key === 'Escape') setIsEditing(false);
                    }}
                    className="flex-1 bg-black text-gray-200 border border-gray-700 px-3 py-2 text-sm rounded-lg focus:outline-none focus:border-amber-500 font-mono tracking-tight"
                  />
                  <button
                    onClick={handleSaveEdit}
                    className="bg-amber-600 hover:bg-amber-500 text-black px-3 py-1.5 rounded-lg font-medium text-xs transition-all cursor-pointer"
                  >
                    Apply
                  </button>
                  <button
                    onClick={() => setIsEditing(false)}
                    className="text-gray-400 hover:text-white border border-gray-800 px-3 py-1.5 rounded-lg text-xs transition-all cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between bg-black border border-gray-900 rounded-lg p-2.5">
                  <span className="font-mono text-sm font-bold text-emerald-400">{editValue}</span>
                  {canResolveExceptions ? (
                    <button
                      onClick={() => {
                        setIsEditing(true);
                        setTimeout(() => inputRef.current?.focus(), 50);
                      }}
                      className="text-xs text-gray-400 hover:text-white bg-gray-900 hover:bg-gray-800 border border-gray-800 px-2 py-1 rounded transition-all cursor-pointer"
                    >
                      Edit Field
                    </button>
                  ) : (
                    <span className="text-[10px] font-mono uppercase text-gray-600 px-2 py-1">
                      Read-only
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Action buttons — gated by canResolve. Viewer role sees a
                locked notice instead of the Accept / Modify / Reject row. */}
            {canResolveExceptions ? (
              <div className="pt-3 grid grid-cols-3 gap-2">
                <button
                  onClick={() => onUpdateException(selectedEntry.id, selectedException.id, 'Accepted')}
                  className={`py-2 px-1 text-xs rounded-lg font-medium border cursor-pointer transition-all flex flex-col items-center justify-center gap-1 ${
                    selectedException.status === 'Accepted'
                      ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                      : 'bg-black border-gray-900 text-emerald-500 hover:bg-emerald-950/20'
                  }`}
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Accept [Space]</span>
                </button>
                <button
                  onClick={() => {
                    setIsEditing(true);
                    setTimeout(() => inputRef.current?.focus(), 50);
                  }}
                  className={`py-2 px-1 text-xs rounded-lg font-medium border cursor-pointer transition-all flex flex-col items-center justify-center gap-1 ${
                    selectedException.status === 'Corrected'
                      ? 'bg-blue-950 text-blue-400 border-blue-800'
                      : 'bg-black border-gray-900 text-blue-500 hover:bg-blue-950/20'
                  }`}
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Modify [E]</span>
                </button>
                <button
                  onClick={() => onUpdateException(selectedEntry.id, selectedException.id, 'Rejected')}
                  className={`py-2 px-1 text-xs rounded-lg font-medium border cursor-pointer transition-all flex flex-col items-center justify-center gap-1 ${
                    selectedException.status === 'Rejected'
                      ? 'bg-red-950 text-red-400 border-red-800'
                      : 'bg-black border-gray-900 text-red-500 hover:bg-red-950/20'
                  }`}
                >
                  <XCircle className="w-4 h-4" />
                  <span>Reject [R]</span>
                </button>
              </div>
            ) : (
              <div className="pt-3 grid grid-cols-3 gap-2">
                <div className="py-2 px-1 text-xs rounded-lg font-medium border bg-black/40 border-gray-900 text-gray-600 flex flex-col items-center justify-center gap-1 opacity-60 cursor-not-allowed">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Accept</span>
                </div>
                <div className="py-2 px-1 text-xs rounded-lg font-medium border bg-black/40 border-gray-900 text-gray-600 flex flex-col items-center justify-center gap-1 opacity-60 cursor-not-allowed">
                  <RefreshCw className="w-4 h-4" />
                  <span>Modify</span>
                </div>
                <div className="py-2 px-1 text-xs rounded-lg font-medium border bg-black/40 border-gray-900 text-gray-600 flex flex-col items-center justify-center gap-1 opacity-60 cursor-not-allowed">
                  <XCircle className="w-4 h-4" />
                  <span>Reject</span>
                </div>
              </div>
            )}

            {/* Audit trail */}
            <div className="pt-4 border-t border-gray-900">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center justify-between w-full text-xs text-gray-500 font-mono tracking-wider hover:text-gray-300 py-1"
              >
                <span>AUDIT TRAIL ({selectedException.history.length})</span>
                <span>{showHistory ? '[-]' : '[+]'}</span>
              </button>
              {showHistory && (
                <div className="mt-2 text-[11px] text-gray-400 bg-[#090a0f] p-3 rounded-lg border border-gray-900 space-y-2 max-h-32 overflow-y-auto">
                  {selectedException.history.length === 0 ? (
                    <p className="text-gray-600 italic">No previous reviews logged for this field.</p>
                  ) : (
                    selectedException.history.map((h, idx) => (
                      <div key={idx} className="border-b border-gray-900/40 pb-1.5 last:border-b-0">
                        <div className="flex justify-between items-center text-gray-500 font-mono text-[9px] mb-0.5">
                          <span>{h.user}</span>
                          <span suppressHydrationWarning>{new Date(h.timestamp).toLocaleTimeString()}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="font-semibold text-gray-300">{h.action}:</span>
                          <span className="line-through text-gray-600 font-mono">{h.oldValue}</span>
                          <ChevronRight className="w-3 h-3 text-gray-700" />
                          <span className="text-emerald-400 font-mono font-semibold">{h.newValue}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Keyboard shortcuts footer */}
          <div className="p-3 bg-black/40 border-t border-gray-900 flex justify-between items-center text-[10px] text-gray-500 font-mono select-none">
            <div className="flex items-center gap-1">
              <kbd className={`bg-gray-950 px-1.5 py-0.5 rounded border border-gray-800 font-bold uppercase ${canResolveExceptions ? 'text-gray-300' : 'text-gray-700'}`}>Space</kbd>
              <span className={canResolveExceptions ? '' : 'text-gray-700'}>Accept</span>
              <kbd className={`bg-gray-950 px-1.5 py-0.5 rounded border border-gray-800 font-bold uppercase ml-2 ${canResolveExceptions ? 'text-gray-300' : 'text-gray-700'}`}>E</kbd>
              <span className={canResolveExceptions ? '' : 'text-gray-700'}>Edit</span>
              <kbd className={`bg-gray-950 px-1.5 py-0.5 rounded border border-gray-800 font-bold uppercase ml-2 ${canResolveExceptions ? 'text-gray-300' : 'text-gray-700'}`}>R</kbd>
              <span className={canResolveExceptions ? '' : 'text-gray-700'}>Reject</span>
            </div>
            <button
              onClick={canResolveExceptions ? onUndoLastAction : undefined}
              disabled={!canResolveExceptions}
              className={`flex items-center gap-1 text-[11px] border px-2 py-1 rounded font-bold uppercase transition-all ${
                canResolveExceptions
                  ? 'text-gray-400 hover:text-white hover:bg-gray-900 border-gray-800 cursor-pointer'
                  : 'text-gray-700 border-gray-900 bg-gray-950/50 cursor-not-allowed'
              }`}
            >
              <Undo2 className="w-3.5 h-3.5 text-gray-500" />
              Undo [Ctrl+Z]
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-6 text-gray-500">
          <CheckCircle2 className="w-12 h-12 text-gray-600 mb-2" />
          <p className="text-sm font-semibold text-gray-300">All exceptions cleared</p>
          <p className="text-xs text-gray-600 max-w-xs mt-1">
            Select another shipment or upload invoices to run compliance tests.
          </p>
        </div>
      )}
    </div>
  );
}

'use client';

import * as React from 'react';
import { useClearPort } from '@/context/ClearPortContext';
import {
  AlertCircle, CheckCircle2, ChevronRight, Eye, RefreshCw, XCircle, FileText,
  ZoomIn, ZoomOut, RotateCw, Sparkles, Undo2, Loader2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase, invokeEdgeFunction } from '@/lib/supabase';

export default function ExceptionDesk() {
  const {
    entries,
    selectedEntry,
    selectedExceptionId,
    selectedException,
    selectException,
    updateException,
    undoLastAction,
    acceptAllHighConfidence,
    rules,
  } = useClearPort();

  const [severityFilter, setSeverityFilter] = React.useState<'All' | 'High' | 'Medium' | 'Low'>('All');
  const [sortBy, setSortBy] = React.useState<'severity' | 'confidence' | 'fieldName'>('severity');
  const [isEditing, setIsEditing] = React.useState(false);
  const [editValue, setEditValue] = React.useState('');
  const [activeDocTab, setActiveDocTab] = React.useState('');
  const [zoomLevel, setZoomLevel] = React.useState(100);
  const [rotation, setRotation] = React.useState(0);
  const [showHistory, setShowHistory] = React.useState(false);
  const [documentUrl, setDocumentUrl] = React.useState<string | null>(null);
  const [isLoadingUrl, setIsLoadingUrl] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Fetch signed URL for the active document when tab changes
  React.useEffect(() => {
    if (!selectedEntry || !activeDocTab) {
      setDocumentUrl(null);
      return;
    }

    // Find the document matching the active tab
    const doc = selectedEntry.documents.find(d => d.docType === activeDocTab);
    if (!doc) {
      setDocumentUrl(null);
      return;
    }

    let cancelled = false;
    setIsLoadingUrl(true);
    setDocumentUrl(null);

    (async () => {
      try {
        // Try the get-document-url edge function first
        const response = await invokeEdgeFunction<any>('get-document-url', {
          storagePath: doc.storagePath,
        });
        if (!cancelled && response?.success && response.signedUrl) {
          setDocumentUrl(response.signedUrl);
        }
      } catch (err) {
        // Fallback: try direct Supabase storage signed URL
        if (supabase && !cancelled) {
          try {
            const { data } = await supabase.storage
              .from('documents')
              .createSignedUrl(doc.storagePath, 3600);
            if (data?.signedUrl) {
              setDocumentUrl(data.signedUrl);
            }
          } catch (e) {
            console.warn('[doc-url] failed to get signed URL:', e);
          }
        }
      } finally {
        if (!cancelled) setIsLoadingUrl(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedEntry?.id, activeDocTab]);

  // Fix: use useEffect instead of setState-during-render
  React.useEffect(() => {
    if (selectedException) {
      setEditValue(selectedException.correctedValue ?? selectedException.extractedValue);
      setActiveDocTab(selectedException.docType);
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
        e.preventDefault();
        undoLastAction();
        return;
      }

      if (e.key === ' ') {
        e.preventDefault();
        updateException(selectedEntry.id, selectedException.id, 'Accepted');
      }

      if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setIsEditing(true);
        setTimeout(() => inputRef.current?.focus(), 50);
      }

      if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        updateException(selectedEntry.id, selectedException.id, 'Rejected');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedException, selectedEntry, updateException, undoLastAction]);

  if (!selectedEntry) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-500 p-6">
        <AlertCircle className="w-12 h-12 mb-4 text-gray-600 animate-pulse" />
        <p className="text-sm font-medium">No shipment selected</p>
        <p className="text-xs text-gray-600 mt-1">Please select an active batch from the Dashboard or sidebar.</p>
      </div>
    );
  }

  const exceptions = selectedEntry.exceptions;

  // Filter & Sort
  const filteredExceptions = exceptions.filter(ex => {
    if (severityFilter === 'All') return true;
    if (severityFilter === 'High') return ex.confidence < 60;
    if (severityFilter === 'Medium') return ex.confidence >= 60 && ex.confidence < 85;
    if (severityFilter === 'Low') return ex.confidence >= 85;
    return true;
  });

  const sortedExceptions = [...filteredExceptions].sort((a, b) => {
    if (sortBy === 'severity') return a.confidence - b.confidence;
    if (sortBy === 'confidence') return b.confidence - a.confidence;
    return a.fieldName.localeCompare(b.fieldName);
  });

  const totalExceptions = exceptions.length;
  const resolvedExceptions = exceptions.filter(ex => ex.status !== 'Unresolved').length;
  const highConfidenceCount = exceptions.filter(ex => ex.status === 'Unresolved' && ex.confidence >= rules.invoiceThreshold).length;

  const getConfidenceColor = (conf: number) => {
    if (conf < 60) return 'text-red-400 bg-red-950/40 border-red-900/50';
    if (conf < 85) return 'text-amber-400 bg-amber-950/40 border-amber-900/50';
    return 'text-green-400 bg-green-950/40 border-green-900/50';
  };

  const getConfidenceBadge = (conf: number) => {
    if (conf < 60) return 'RED / CRITICAL';
    if (conf < 85) return 'AMBER / WARNING';
    return 'GREEN / COMPLIANT';
  };

  const handleSaveEdit = () => {
    if (selectedException && selectedEntry) {
      updateException(selectedEntry.id, selectedException.id, 'Corrected', editValue);
      setIsEditing(false);
    }
  };

  // Data-driven document tabs (derive from shipment fields, not hardcoded IDs)
  const availableDocTypes = Array.from(new Set(selectedEntry.fields.map(f => f.sourceDoc).filter(Boolean)));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 h-full overflow-hidden p-6 font-sans">
      {/* LEFT PANEL: EXCEPTION LIST */}
      <div className="lg:col-span-3 bg-[#0c0d12] border border-gray-900 rounded-xl flex flex-col overflow-hidden">
        <div className="p-4 border-b border-gray-900 bg-[#0e1017]">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-xs text-gray-500 tracking-wider">EXCEPTIONS DESK</span>
            <span className="font-mono text-xs text-emerald-400 bg-emerald-950/30 px-2 py-0.5 rounded border border-emerald-900/40">
              {resolvedExceptions} / {totalExceptions} RESOLVED
            </span>
          </div>
          <h2 className="text-sm font-medium text-gray-200 tracking-tight flex items-center gap-1.5">
            <FileText className="w-4 h-4 text-gray-400" />
            {selectedEntry.id}
          </h2>
          <p className="text-xs text-gray-500 mt-1 truncate">{selectedEntry.shipper}</p>
        </div>

        {/* Filters */}
        <div className="p-3 border-b border-gray-900 bg-[#090a0f] space-y-2.5">
          <div className="flex items-center gap-1">
            {(['All', 'High', 'Medium', 'Low'] as const).map(filter => (
              <button
                key={filter}
                onClick={() => setSeverityFilter(filter)}
                className={`text-[11px] px-2.5 py-1 rounded-md font-medium transition-all ${
                  severityFilter === filter
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-950'
                }`}
              >
                {filter}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">SORT BY</span>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as any)}
              className="bg-black border border-gray-800 text-gray-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-gray-700 font-medium"
            >
              <option value="severity">Severity (Low Conf)</option>
              <option value="confidence">Confidence (High)</option>
              <option value="fieldName">Field Name</option>
            </select>
          </div>

          {highConfidenceCount > 0 && (
            <button
              onClick={() => acceptAllHighConfidence(selectedEntry.id)}
              className="w-full flex items-center justify-center gap-1.5 text-xs bg-emerald-950/30 text-emerald-400 border border-emerald-900/50 hover:bg-emerald-900/20 py-2 rounded-md transition-all cursor-pointer font-medium mt-1"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Accept {highConfidenceCount} Fields ≥ {rules.invoiceThreshold}% Conf
            </button>
          )}
        </div>

        {/* Exceptions list */}
        <div className="flex-1 overflow-y-auto divide-y divide-gray-950 p-2 space-y-1.5">
          <AnimatePresence mode="popLayout">
            {sortedExceptions.map(ex => {
              const isSelected = ex.id === selectedExceptionId;
              const severityClass = getConfidenceColor(ex.confidence);
              const isDone = ex.status !== 'Unresolved';

              return (
                <motion.div
                  key={ex.id}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  onClick={() => selectException(ex.id)}
                  className={`p-3 rounded-lg cursor-pointer transition-all border ${
                    isSelected
                      ? 'bg-gray-950 border-gray-700 shadow-lg shadow-black/40'
                      : 'bg-transparent border-transparent hover:bg-gray-950/40 hover:border-gray-900'
                  }`}
                >
                  <div className="flex items-start justify-between gap-1.5 mb-1.5">
                    <span className="text-xs font-semibold text-gray-200 tracking-tight leading-tight">
                      {ex.fieldName}
                    </span>
                    {isDone ? (
                      <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0 ${
                        ex.status === 'Accepted' ? 'bg-emerald-950 text-emerald-400 border border-emerald-900/30' :
                        ex.status === 'Rejected' ? 'bg-red-950 text-red-400 border border-red-900/30' :
                        'bg-blue-950 text-blue-400 border border-blue-900/30'
                      }`}>
                        {ex.status.toUpperCase()}
                      </span>
                    ) : (
                      <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border shrink-0 ${severityClass}`}>
                        {ex.confidence}%
                      </span>
                    )}
                  </div>

                  <p className="text-[11px] text-gray-400 leading-normal line-clamp-2">{ex.reason}</p>

                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-900/30 text-[10px] text-gray-500 font-mono">
                    <span>{ex.docType}</span>
                    <span className="text-gray-600 uppercase">{ex.exceptionType.replace(/_/g, ' ')}</span>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>

          {sortedExceptions.length === 0 && (
            <div className="p-8 text-center text-gray-500 text-xs">
              No exceptions match the selected filter.
            </div>
          )}
        </div>
      </div>

      {/* CENTER PANEL: DOCUMENT VIEWER */}
      <div className="lg:col-span-5 bg-[#0c0d12] border border-gray-900 rounded-xl flex flex-col overflow-hidden relative">
        {/* Document Tabs (data-driven) */}
        <div className="px-4 py-2 bg-[#0e1017] border-b border-gray-900 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {availableDocTypes.map(doc => (
              <button
                key={doc}
                onClick={() => setActiveDocTab(doc)}
                className={`text-xs px-3 py-1.5 rounded-md font-medium transition-all whitespace-nowrap ${
                  activeDocTab === doc
                    ? 'bg-gray-800 text-gray-100'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {doc === 'Commercial Invoice' ? 'Invoice' : doc === 'Bill of Lading' ? 'BOL' : doc}
              </button>
            ))}
            {availableDocTypes.length === 0 && (
              <span className="text-xs text-gray-600">No documents available</span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setZoomLevel(prev => Math.max(50, prev - 10))}
              title="Zoom Out"
              className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-950 transition-all cursor-pointer"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-gray-500 w-10 text-center">{zoomLevel}%</span>
            <button
              onClick={() => setZoomLevel(prev => Math.min(200, prev + 10))}
              title="Zoom In"
              className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-950 transition-all cursor-pointer"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              onClick={() => setRotation(prev => (prev + 90) % 360)}
              title="Rotate 90°"
              className="p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-950 transition-all cursor-pointer"
            >
              <RotateCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Document Board — shows real uploaded file or extracted data view */}
        <div className="flex-1 overflow-auto bg-[#040406] p-6 flex items-start justify-center relative">
          {documentUrl ? (
            /* Real file viewer — show the actual uploaded document */
            <div
              style={{
                transform: `scale(${zoomLevel / 100}) rotate(${rotation}deg)`,
                transformOrigin: 'top center',
                transition: 'transform 0.15s ease-out',
              }}
              className="rounded border border-gray-700 shadow-2xl overflow-hidden bg-white relative"
            >
              {documentUrl.endsWith('.txt') || documentUrl.includes('text/plain') ? (
                /* Text file — show as preformatted text */
                <iframe src={documentUrl} className="w-[500px] h-[600px] bg-white" title="Document" />
              ) : documentUrl.includes('.pdf') || documentUrl.includes('application/pdf') ? (
                /* PDF — show in iframe */
                <iframe src={documentUrl} className="w-[500px] h-[600px] bg-white" title="Document PDF" />
              ) : (
                /* Image — show directly */
                <img src={documentUrl} alt="Document" className="max-w-[500px] max-h-[600px] object-contain" />
              )}

              {/* Highlighted bounding box overlay */}
              {selectedException && activeDocTab === selectedException.docType && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="absolute border-[2px] border-amber-500 bg-amber-500/10 rounded pointer-events-none shadow-[0_0_12px_rgba(245,158,11,0.4)]"
                  style={{
                    left: `${selectedException.boundingBox.x}%`,
                    top: `${selectedException.boundingBox.y}%`,
                    width: `${selectedException.boundingBox.w}%`,
                    height: `${selectedException.boundingBox.h}%`,
                  }}
                >
                  <div className="absolute -top-3.5 left-0 text-[7px] font-mono text-white bg-amber-600 px-1 py-0.5 rounded shadow whitespace-nowrap uppercase tracking-wider font-bold">
                    FLAGGED: {selectedException.fieldName.toUpperCase()}
                  </div>
                </motion.div>
              )}
            </div>
          ) : isLoadingUrl ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
            </div>
          ) : (
            /* Fallback: show extracted data as a structured view (not a fake document) */
            <div
              style={{
                transform: `scale(${zoomLevel / 100}) rotate(${rotation}deg)`,
                transformOrigin: 'top center',
                transition: 'transform 0.15s ease-out',
              }}
              className="w-[500px] bg-[#0c0d12] border border-gray-800 rounded-xl shadow-2xl p-6 relative"
            >
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-gray-800">
                <div>
                  <h3 className="text-sm font-bold text-gray-100 uppercase tracking-wider">
                    {activeDocTab || 'Extracted Data'}
                  </h3>
                  <p className="text-[10px] text-gray-500 font-mono mt-0.5">
                    {selectedEntry.id} • {selectedEntry.documents.length} file(s) uploaded
                  </p>
                </div>
                <span className="text-[9px] font-mono bg-amber-950/40 text-amber-400 border border-amber-900/40 px-2 py-0.5 rounded uppercase">
                  Structured Extract
                </span>
              </div>

              <div className="space-y-2">
                {selectedEntry.fields.map((f, idx) => (
                  <div key={f.id || idx} className={`flex justify-between items-start p-2 rounded border ${
                    f.isFlagged ? 'bg-red-950/20 border-red-900/40' : 'bg-black/30 border-gray-900'
                  }`}>
                    <div className="flex-1">
                      <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider block">{f.label}</span>
                      <span className={`text-xs font-mono ${f.isFlagged ? 'text-amber-400' : 'text-gray-200'}`}>
                        {f.value}
                      </span>
                      {f.crossDocValue && (
                        <span className="text-[9px] text-red-400 block mt-0.5">↔ {f.crossDocValue}</span>
                      )}
                    </div>
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                      f.confidence < 60 ? 'bg-red-950 text-red-400' :
                      f.confidence < 85 ? 'bg-amber-950 text-amber-400' :
                      'bg-emerald-950 text-emerald-400'
                    }`}>
                      {f.confidence}%
                    </span>
                  </div>
                ))}
              </div>

              {selectedEntry.fields.length === 0 && (
                <div className="text-center py-8 text-gray-600 text-xs">
                  No fields extracted for this shipment.
                </div>
              )}

              {selectedException && activeDocTab === selectedException.docType && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="mt-4 p-3 bg-amber-950/20 border border-amber-900/40 rounded-lg"
                >
                  <div className="text-[10px] font-mono text-amber-400 uppercase tracking-wider mb-1">
                    ⚠ FLAGGED: {selectedException.fieldName}
                  </div>
                  <p className="text-[11px] text-gray-300">{selectedException.reason}</p>
                </motion.div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* RIGHT PANEL: RESOLUTION DESK */}
      <div className="lg:col-span-4 bg-[#0c0d12] border border-gray-900 rounded-xl flex flex-col overflow-hidden">
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

              {/* Discrepancy reason */}
              <div className="bg-[#120f12] border border-red-950/40 p-3.5 rounded-lg">
                <h4 className="text-[11px] font-mono text-red-400 tracking-wider uppercase mb-1 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5" />
                  DISCREPANCY WHY:
                </h4>
                <p className="text-xs text-gray-300 leading-normal">{selectedException.reason}</p>
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
                    <button
                      onClick={() => {
                        setIsEditing(true);
                        setTimeout(() => inputRef.current?.focus(), 50);
                      }}
                      className="text-xs text-gray-400 hover:text-white bg-gray-900 hover:bg-gray-800 border border-gray-800 px-2 py-1 rounded transition-all cursor-pointer"
                    >
                      Edit Field
                    </button>
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div className="pt-3 grid grid-cols-3 gap-2">
                <button
                  onClick={() => updateException(selectedEntry.id, selectedException.id, 'Accepted')}
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
                  onClick={() => updateException(selectedEntry.id, selectedException.id, 'Rejected')}
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
                <kbd className="bg-gray-950 px-1.5 py-0.5 rounded border border-gray-800 text-gray-300 font-bold uppercase">Space</kbd> Accept
                <kbd className="bg-gray-950 px-1.5 py-0.5 rounded border border-gray-800 text-gray-300 font-bold uppercase ml-2">E</kbd> Edit
                <kbd className="bg-gray-950 px-1.5 py-0.5 rounded border border-gray-800 text-gray-300 font-bold uppercase ml-2">R</kbd> Reject
              </div>
              <button
                onClick={undoLastAction}
                className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-white hover:bg-gray-900 border border-gray-800 px-2 py-1 rounded transition-all cursor-pointer font-bold uppercase"
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
    </div>
  );
}

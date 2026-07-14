'use client';

import * as React from 'react';
import { useClearPort } from '@/context/ClearPortContext';
import {
  AlertCircle, CheckCircle2, ChevronRight, Eye, RefreshCw, XCircle, FileText,
  ZoomIn, ZoomOut, RotateCw, Sparkles, Undo2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

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
  const inputRef = React.useRef<HTMLInputElement>(null);

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

        {/* Document Board */}
        <div className="flex-1 overflow-auto bg-[#040406] p-6 flex items-start justify-center relative">
          <div
            style={{
              transform: `scale(${zoomLevel / 100}) rotate(${rotation}deg)`,
              transformOrigin: 'top center',
              transition: 'transform 0.15s ease-out',
            }}
            className="w-[450px] aspect-[1/1.4] bg-[#fafbfc] rounded border border-gray-200 text-[#0f1115] shadow-2xl p-6 relative select-none font-serif flex flex-col justify-between"
          >
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 font-sans font-bold border-4 border-red-500/10 text-red-500/10 rounded-xl px-6 py-3 text-4xl rotate-12 tracking-widest pointer-events-none uppercase">
              {activeDocTab || 'Document'} WORK COPY
            </div>

            <div>
              <div className="flex justify-between items-start border-b-2 border-gray-900 pb-3 mb-4">
                <div>
                  <h1 className="text-[13px] font-extrabold uppercase tracking-widest font-sans text-gray-900">
                    {activeDocTab || 'Document'}
                  </h1>
                  <p className="text-[8px] text-gray-500 font-sans mt-0.5 uppercase tracking-wider">
                    {selectedEntry.id} • SECURE CARGO ENTRY
                  </p>
                </div>
                <div className="text-right">
                  <span className="font-sans font-semibold text-[8px] bg-gray-900 text-white px-1.5 py-0.5 rounded uppercase tracking-wider">
                    ORIGINAL EXTRACT
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 text-[8px] font-sans border-b border-gray-200 pb-2 mb-3">
                <div>
                  <span className="text-gray-500 block uppercase font-bold tracking-wider text-[7px]">Shipper / Exporter:</span>
                  <span className="font-semibold text-gray-900 block mt-0.5">{selectedEntry.shipper}</span>
                </div>
                <div>
                  <span className="text-gray-500 block uppercase font-bold tracking-wider text-[7px]">Consignee / Importer:</span>
                  <span className="font-semibold text-gray-900 block mt-0.5">{selectedEntry.consignee}</span>
                </div>
              </div>

              <div className="text-[8px] font-sans space-y-2">
                <div className="grid grid-cols-4 border-b border-gray-200 pb-1 font-bold text-gray-500 uppercase tracking-widest text-[6px]">
                  <div>REF NUMBER</div>
                  <div>PORT CODE</div>
                  <div>CARRIER</div>
                  <div className="text-right">ORIGIN</div>
                </div>
                <div className="grid grid-cols-4 border-b border-gray-100 pb-1.5 font-medium text-gray-900 font-mono">
                  <div>{selectedEntry.fields.find(f => f.key === 'invoiceNo')?.value || '—'}</div>
                  <div>{selectedEntry.fields.find(f => f.key === 'portOfEntry')?.value?.slice(0, 8) || '—'}</div>
                  <div>{selectedEntry.fields.find(f => f.key === 'carrier')?.value?.slice(0, 10) || '—'}</div>
                  <div className="text-right">
                    {selectedEntry.fields.find(f => f.key === 'countryOfOrigin')?.value || '—'}
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-2.5 text-[8.5px] text-gray-800 leading-relaxed font-serif">
                <p>
                  We hereby certify that the goods described below are of international export origin and conform to bilateral trade rules of the respective Customs departments.
                </p>

                <div className="border border-gray-200 p-2.5 rounded bg-gray-50/50 mt-3 font-sans space-y-2">
                  <div className="flex justify-between font-bold border-b border-gray-200 pb-1 text-[7px] text-gray-500">
                    <span>ITEM DESCRIPTION & SPECS</span>
                    <span>HTS CLASSIFICATION</span>
                  </div>
                  <div className="flex justify-between items-center text-gray-900 font-medium">
                    <span>Cargo Item (Aerospace-Spec)</span>
                    <span className="font-mono text-gray-900">
                      {selectedEntry.fields.find(f => f.key === 'htsCode')?.value || '—'}
                    </span>
                  </div>
                  <div className="flex justify-between items-center border-t border-gray-100 pt-1 text-gray-900">
                    <span className="text-gray-500 text-[7px]">Gross/Net Declared Weights:</span>
                    <span className="font-mono font-medium text-gray-900">
                      {selectedEntry.fields.find(f => f.key === 'netWeight')?.value || '—'}
                    </span>
                  </div>
                </div>

                <div className="pt-2 text-[7.5px] text-gray-500 leading-normal italic">
                  * Discrepancy values are highlighted dynamically on OCR workspace overlays. This copy has been parsed securely through the Gemini extraction engine.
                </div>
              </div>
            </div>

            <div className="border-t-2 border-gray-900 pt-3 flex justify-between items-end font-sans">
              <div>
                <span className="text-[6.5px] text-gray-400 uppercase tracking-widest block font-bold">VERIFIED BY AGENT</span>
                <span className="text-[7px] text-gray-900 block font-semibold mt-0.5">CBP REGISTERED FILING AGENCY</span>
              </div>
              <div className="text-right">
                <span className="text-[6.5px] text-gray-500 uppercase tracking-widest block font-bold">TOTAL VALUE DECLARED:</span>
                <span className="text-xs font-mono font-extrabold text-gray-950 tracking-tight block">
                  {selectedEntry.fields.find(f => f.key === 'declaredValue')?.value || '—'}
                </span>
              </div>
            </div>

            {/* Highlighted bounding box */}
            {selectedException && activeDocTab === selectedException.docType && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="absolute border-[2px] border-amber-500 bg-amber-500/10 rounded pointer-events-none shadow-[0_0_12px_rgba(245,158,11,0.4)] flex flex-col justify-end p-0.5"
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

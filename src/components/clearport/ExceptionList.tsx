'use client';
// ============================================================================
// ExceptionList.tsx — Left panel of the ExceptionDesk
// ============================================================================
// Extracted from ExceptionDesk.tsx (FIX5-7-SPLIT — behavior-preserving).
//
// Renders the shipment header, CSV export button, validation status banner,
// severity/sort filters, the high-confidence batch-accept button, the
// read-only notice for viewer-role users, and the scrollable exception list.
//
// All state is local (severityFilter, sortBy) or derived from props. The
// parent (ExceptionDesk) passes the selected entry + action callbacks; the
// list itself never touches the ClearPort context directly so it stays
// focused on presentation.
// ============================================================================

import * as React from 'react';
import {
  AlertCircle, CheckCircle2, FileText, Sparkles, Loader2, FileSpreadsheet,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type {
  ShipmentEntry, OperationalRules,
} from '@/lib/clearport-types';
import { type UserRole, roleLabel } from '@/lib/services/rbac.service';
import { getConfidenceColor } from './exception-desk-utils';

export interface ExceptionListProps {
  selectedEntry: ShipmentEntry;
  selectedExceptionId: string;
  onSelectException: (id: string) => void;
  onExportCSV: (entryId: string) => void | Promise<void>;
  onAcceptAllHighConfidence: (entryId: string) => void;
  rules: OperationalRules;
  canResolveExceptions: boolean;
  userRole: UserRole;
}

export default function ExceptionList({
  selectedEntry,
  selectedExceptionId,
  onSelectException,
  onExportCSV,
  onAcceptAllHighConfidence,
  rules,
  canResolveExceptions,
  userRole,
}: ExceptionListProps) {
  const [severityFilter, setSeverityFilter] = React.useState<'All' | 'High' | 'Medium' | 'Low'>('All');
  const [sortBy, setSortBy] = React.useState<'severity' | 'confidence' | 'fieldName'>('severity');

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

  return (
    <div className="lg:col-span-3 bg-[#0c0d12] border border-gray-900 rounded-xl flex flex-col overflow-hidden min-h-[400px] lg:min-h-0">
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

        {/* CSV Export Button */}
        <button
          onClick={() => onExportCSV(selectedEntry.id)}
          className="mt-3 w-full flex items-center justify-center gap-1.5 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-black font-bold px-2 py-1.5 rounded-lg transition-all cursor-pointer uppercase tracking-wider"
        >
          <FileSpreadsheet className="w-3 h-3" />
          Export CSV
        </button>

        {/* (§4) Validation status banner — reads validation_status, not just totalExceptions */}
        {selectedEntry.validationStatus === 'completed' && totalExceptions === 0 && (
          <div className="mt-2 p-2 rounded-lg border text-[10px] font-mono flex items-center gap-1.5 bg-emerald-950/30 border-emerald-900/40 text-emerald-400">
            <CheckCircle2 className="w-3 h-3 shrink-0" />
            <span>VALIDATED — zero exceptions found. Shipment is clean.</span>
          </div>
        )}
        {selectedEntry.validationStatus === 'completed' && totalExceptions > 0 && (
          <div className="mt-2 p-2 rounded-lg border text-[10px] font-mono flex items-center gap-1.5 bg-amber-950/30 border-amber-900/40 text-amber-400">
            <AlertCircle className="w-3 h-3 shrink-0" />
            <span>VALIDATED — {totalExceptions} exceptions require review.</span>
          </div>
        )}
        {(selectedEntry.validationStatus === 'failed' || selectedEntry.validationStatus === 'degraded') && (
          <div className="mt-2 p-2 rounded-lg border text-[10px] font-mono flex items-center gap-1.5 bg-red-950/30 border-red-900/40 text-red-400">
            <AlertCircle className="w-3 h-3 shrink-0" />
            <span>VALIDATION INCOMPLETE — pipeline error, retry required.</span>
          </div>
        )}
        {(selectedEntry.validationStatus === 'pending' || selectedEntry.validationStatus === 'running' || !selectedEntry.validationStatus) && (
          <div className="mt-2 p-2 rounded-lg border text-[10px] font-mono flex items-center gap-1.5 bg-blue-950/30 border-blue-900/40 text-blue-400">
            <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
            <span>VALIDATION IN PROGRESS — not yet validated.</span>
          </div>
        )}
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

        {highConfidenceCount > 0 && canResolveExceptions && (
          <button
            onClick={() => onAcceptAllHighConfidence(selectedEntry.id)}
            className="w-full flex items-center justify-center gap-1.5 text-xs bg-emerald-950/30 text-emerald-400 border border-emerald-900/50 hover:bg-emerald-900/20 py-2 rounded-md transition-all cursor-pointer font-medium mt-1"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Accept {highConfidenceCount} Fields ≥ {rules.invoiceThreshold}% Conf
          </button>
        )}

        {!canResolveExceptions && (
          <div className="mt-1 flex items-start gap-1.5 text-[10px] text-amber-500/90 bg-amber-950/20 border border-amber-900/40 rounded-md p-2 font-mono leading-relaxed">
            <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
            <span>
              READ-ONLY ({roleLabel(userRole)}) — Accept / Modify / Reject are
              disabled. Switch to an operator / admin session to resolve exceptions.
            </span>
          </div>
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
                onClick={() => onSelectException(ex.id)}
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
  );
}

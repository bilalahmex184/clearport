'use client';

import * as React from 'react';
import { useClearPort } from '@/context/ClearPortContext';
import { CheckCircle2, FileSpreadsheet, AlertCircle, FileText } from 'lucide-react';
import { canExport, roleLabel } from '@/lib/services/rbac.service';
import ExtractionTracePanel from './ExtractionTracePanel';

export default function EntryDetailView() {
  const { entries, selectedEntryId, selectedEntry, selectEntry, selectException, setActiveTab, exportToCSV, userRole, apiFetchOrg } = useClearPort();

  // RBAC: every role (admin / operator / viewer) has the 'export' permission,
  // so this gate is currently a no-op for the default role assignment. It's
  // wired in so a future "no-export" role (e.g. external auditor with a
  // redacted view) automatically hides the button without component edits.
  const canExportCsv = canExport(userRole);

  const [isExporting, setIsExporting] = React.useState(false);

  if (!selectedEntry) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-500 p-6">
        <AlertCircle className="w-12 h-12 mb-4 text-gray-600 animate-pulse" />
        <p className="text-sm font-medium">No shipment entry selected</p>
        <p className="text-xs text-gray-600 mt-1">Please select an active batch from the left list.</p>
      </div>
    );
  }

  const unresolvedCount = selectedEntry.exceptions.filter(e => e.status === 'Unresolved').length;
  const isExportEnabled = unresolvedCount === 0;

  const getTimelineStep = (status: string, unresolved: number) => {
    if (status === 'Exported') return 5;
    if (status === 'Approved') return 4;
    if (status === 'Under Review' && unresolved > 0) return 3;
    if (status === 'Under Review') return 2;
    return 1;
  };

  const activeStep = getTimelineStep(selectedEntry.status, unresolvedCount);

  const handleFixInline = (exceptionId: string) => {
    selectException(exceptionId);
    setActiveTab('exception-desk');
  };

  const handleExport = async () => {
    if (!canExportCsv) return;
    setIsExporting(true);
    try {
      await exportToCSV(selectedEntry.id);
    } finally {
      setIsExporting(false);
    }
  };

  const getStepClass = (stepNum: number) => {
    if (activeStep > stepNum) return 'text-emerald-400 bg-emerald-950/40 border-emerald-900/60';
    if (activeStep === stepNum) return 'text-amber-400 bg-amber-950 border-amber-900 shadow-[0_0_8px_rgba(245,158,11,0.25)]';
    return 'text-gray-600 bg-black/40 border-gray-900';
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 h-full overflow-hidden p-6 font-sans">
      {/* LEFT COLUMN: SHIPMENT SELECTOR */}
      <div className="lg:col-span-3 bg-[#0c0d12] border border-gray-900 rounded-xl flex flex-col overflow-hidden">
        <div className="p-4 border-b border-gray-900 bg-[#0e1017]">
          <span className="font-mono text-xs text-gray-500 tracking-wider">ENTRY RECORDS REGISTER</span>
          <h2 className="text-sm font-semibold text-gray-200 mt-1">Select Shipment Archive</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {entries.map(ent => {
            const isSelected = ent.id === selectedEntryId;
            const hasExceptions = ent.exceptions.filter(e => e.status === 'Unresolved').length > 0;
            return (
              <div
                key={ent.id}
                onClick={() => selectEntry(ent.id)}
                className={`p-3 rounded-lg cursor-pointer transition-all border ${
                  isSelected
                    ? 'bg-gray-950 border-gray-700 shadow-md'
                    : 'bg-transparent border-transparent hover:bg-gray-950/40 hover:border-gray-900'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-extrabold text-gray-200">{ent.id}</span>
                  <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${
                    ent.status === 'Approved'
                      ? 'bg-emerald-950 text-emerald-400 border-emerald-900/40'
                      : ent.status === 'Exported'
                        ? 'bg-blue-950 text-blue-400 border-blue-900/40'
                        : 'bg-amber-950 text-amber-400 border-amber-900/40'
                  }`}>
                    {ent.status.toUpperCase()}
                  </span>
                </div>
                <p className="text-[11px] text-gray-400 mt-1 truncate leading-tight">{ent.shipper}</p>
                <p className="text-[10px] text-gray-600 mt-0.5 font-mono">
                  {ent.fields.length} fields • {ent.docsCount} source files
                </p>
                {hasExceptions && (
                  <p className="text-[10px] text-amber-500 mt-1 font-mono">{ent.exceptions.filter(e => e.status === 'Unresolved').length} unresolved</p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* RIGHT COLUMN: TIMELINE + FIELDS TABLE */}
      <div className="lg:col-span-9 bg-[#0c0d12] border border-gray-900 rounded-xl flex flex-col overflow-hidden">
        {/* Timeline */}
        <div className="p-5 border-b border-gray-900 bg-[#0e1017]">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
            <div>
              <span className="font-mono text-xs text-emerald-400 tracking-wider">SECURE FILING REGISTRY</span>
              <h2 className="text-lg font-extrabold text-gray-100 tracking-tight mt-0.5">
                Shipment Audit Record: <span className="font-mono">{selectedEntry.id}</span>
              </h2>
            </div>

            <button
              disabled={!isExportEnabled || isExporting || !canExportCsv}
              onClick={handleExport}
              title={!canExportCsv ? `Export disabled for ${roleLabel(userRole)} role` : undefined}
              className={`flex items-center gap-2 text-xs font-bold px-4 py-2 rounded-lg border transition-all uppercase tracking-wider ${
                isExportEnabled && !isExporting && canExportCsv
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-black border-emerald-700 cursor-pointer shadow-lg shadow-emerald-950/35'
                  : 'bg-gray-950 text-gray-600 border-gray-900 cursor-not-allowed'
              }`}
            >
              <FileSpreadsheet className={`w-4 h-4 ${isExporting ? 'animate-spin' : ''}`} />
              <span>{isExporting ? 'Exporting...' : 'Export to CSV'}</span>
            </button>
          </div>

          {/* Timeline Grid */}
          <div className="relative pt-1 max-w-4xl mx-auto">
            <div className="absolute top-[21px] left-4 right-4 h-0.5 bg-gray-900 -z-10"></div>
            <div className="grid grid-cols-5 gap-2">
              {['UPLOADED', 'OCR PARSED', 'UNDER REVIEW', 'APPROVED', 'EXPORTED'].map((label, idx) => (
                <div key={label} className="text-center">
                  <div className={`w-8 h-8 rounded-full border-2 mx-auto flex items-center justify-center font-mono text-xs font-extrabold z-10 transition-all ${getStepClass(idx + 1)}`}>
                    {String(idx + 1).padStart(2, '0')}
                  </div>
                  <span className="text-[10px] font-bold text-gray-400 font-mono tracking-wider block mt-2">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Fields Table */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-gray-900 text-[10px] font-mono text-gray-500 uppercase tracking-wider bg-black/30 sticky top-0">
                <th className="py-3 px-5 font-semibold">EXTRACTED CORE DATA FIELDS</th>
                <th className="py-3 px-5 font-semibold">DECLARED VALUE</th>
                <th className="py-3 px-5 font-semibold">ORIGINAL SOURCE FILE</th>
                <th className="py-3 px-5 font-semibold text-right">COMPLIANCE RISK STATE</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-950 font-medium">
              {selectedEntry.fields.map((f, idx) => (
                <tr
                  key={f.id || idx}
                  className={`hover:bg-gray-950/40 transition-colors ${
                    f.isFlagged ? 'bg-red-950/10 border-l-2 border-l-red-500' : ''
                  }`}
                >
                  <td className="py-3 px-5 font-semibold text-gray-300">
                    {f.label}
                    <span className="text-[9px] text-gray-600 block mt-0.5 font-mono uppercase tracking-wider">Key: {f.key}</span>
                  </td>
                  <td className="py-3 px-5 font-mono text-gray-200">
                    {f.value}
                    {f.crossDocValue && (
                      <span className="text-[9px] text-amber-500 block mt-0.5">↔ {f.crossDocValue}</span>
                    )}
                  </td>
                  <td className="py-3 px-5 font-mono text-gray-500">
                    {f.sourceDoc}
                  </td>
                  <td className="py-3 px-5 text-right">
                    {f.isFlagged && f.exceptionId ? (
                      <button
                        onClick={() => handleFixInline(f.exceptionId!)}
                        className="inline-flex items-center gap-1 text-[10px] bg-red-950 text-red-400 border border-red-900/60 px-2 py-1 rounded hover:bg-red-900 hover:text-white transition-all cursor-pointer font-bold uppercase tracking-wider"
                      >
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>Fix Mismatch</span>
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-mono bg-emerald-950/30 px-2 py-1 rounded border border-emerald-900/30">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        SECURE
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Export lock banner */}
        {!isExportEnabled && (
          <div className="p-4 bg-[#140b0b] border-t border-gray-900 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-red-400 font-semibold leading-normal">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>EXPORT SUSPENDED: Resolve {unresolvedCount} active discrepancies before customs clearance filing.</span>
            </div>
            <button
              onClick={() => setActiveTab('exception-desk')}
              className="text-xs text-gray-400 hover:text-white underline font-bold whitespace-nowrap uppercase tracking-wider"
            >
              Open Exception Desk
            </button>
          </div>
        )}

        {/* Extraction Trace — collapsible audit timeline. Only shows rows for
            documents that have extraction_attempts entries (i.e. the
            extract-document edge function has run since migration 017 was
            applied). Hidden entirely in seed/demo mode (no documents). */}
        {selectedEntry.documents.length > 0 && (
          <ExtractionTracePanel
            documents={selectedEntry.documents}
            apiFetchOrg={apiFetchOrg}
          />
        )}
      </div>
    </div>
  );
}

'use client';

import * as React from 'react';
import { useClearPort, type ShipmentEntry } from '@/context/ClearPortContext';
import {
  FileCheck,
  Hourglass,
  AlertTriangle,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  FileWarning,
  ArrowRight,
  Terminal,
  ChevronRight,
  Clock,
  CircleDollarSign,
} from 'lucide-react';
import ExtractionHealthPanel from './ExtractionHealthPanel';

export default function Dashboard() {
  const { entries, selectEntry, setActiveTab, selectException, auditLogs, theme, toggleTheme } = useClearPort();

  // Find highest-stakes unresolved exception (only real exceptions, no fabricated IDs)
  const criticalException = React.useMemo(() => {
    let highestRisk: { entry: ShipmentEntry; exception: any } | null = null;

    for (const entry of entries) {
      if (entry.status !== 'Under Review') continue;
      for (const ex of entry.exceptions) {
        if (ex.status !== 'Unresolved') continue;
        if (!highestRisk || ex.confidence < highestRisk.exception.confidence) {
          highestRisk = { entry, exception: ex };
        }
      }
    }
    return highestRisk;
  }, [entries]);

  const handleFixAlert = () => {
    if (criticalException) {
      selectEntry(criticalException.entry.id);
      selectException(criticalException.exception.id);
      setActiveTab('exception-desk');
    }
  };

  const getConfidenceBadgeColor = (conf: number) => {
    if (conf < 60) return 'text-red-400 bg-red-950/40 border-red-900/50';
    if (conf < 85) return 'text-amber-400 bg-amber-950/40 border-amber-900/50';
    return 'text-green-400 bg-green-950/40 border-green-900/50';
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'Approved': return 'text-emerald-400 bg-emerald-950/40 border-emerald-900/40';
      case 'Exported': return 'text-blue-400 bg-blue-950/40 border-blue-900/40';
      default: return 'text-amber-400 bg-amber-950/40 border-amber-900/40';
    }
  };

  // Dynamic KPI calculations
  const totalFlaggedFields = entries.reduce((acc, curr) => acc + curr.fields.filter(f => f.isFlagged).length, 0);
  const totalFieldsCount = entries.reduce((acc, curr) => acc + curr.fields.length, 0);
  const flaggedRate = totalFieldsCount > 0 ? ((totalFlaggedFields / totalFieldsCount) * 100).toFixed(1) : '0.0';
  const totalDocs = entries.reduce((acc, curr) => acc + curr.docsCount, 0);

  return (
    <div className="space-y-4 sm:space-y-6 overflow-y-auto h-full pb-6 sm:pb-8 pr-1 sm:pr-2 p-3 sm:p-4 md:p-6 font-sans">
      {/* HEADER + THEME SWITCH */}
      <div className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b ${
        theme === 'light' ? 'border-gray-200' : 'border-gray-900/40'
      }`}>
        <div>
          <h2 className={`text-xl font-bold tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-gray-100'}`}>
            Customs Clearance Command Center
          </h2>
          <p className={`text-xs mt-0.5 ${theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
            Real-time status of cargo filings, automated OCR discrepancy detection, and regulatory exception flows.
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2.5">
          <span className={`font-mono text-[10px] uppercase font-bold tracking-wider ${theme === 'light' ? 'text-gray-500' : 'text-gray-500'}`}>
            CONSOLE THEME
          </span>
          <div className={`relative flex items-center p-0.5 rounded-full border transition-all duration-200 ${
            theme === 'light' ? 'bg-gray-200 border-gray-300' : 'bg-[#0d0e14] border-gray-800'
          }`}>
            <button
              onClick={() => { if (theme !== 'dark') toggleTheme(); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-mono font-bold uppercase transition-all duration-200 cursor-pointer ${
                theme === 'dark'
                  ? 'bg-[#06070a] text-amber-500 border border-amber-500/30 shadow-md'
                  : 'text-gray-500 hover:text-gray-400'
              }`}
            >
              <div className="w-2.5 h-2.5 rounded-full bg-[#06070a] border border-gray-700 shrink-0" />
              <span>Dark</span>
            </button>
            <button
              onClick={() => { if (theme !== 'light') toggleTheme(); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-mono font-bold uppercase transition-all duration-200 cursor-pointer ${
                theme === 'light'
                  ? 'bg-white text-gray-900 border border-gray-200 shadow-sm'
                  : 'text-gray-500 hover:text-gray-400'
              }`}
            >
              <div className="w-2.5 h-2.5 rounded-full bg-white border border-gray-300 shrink-0" />
              <span>Light</span>
            </button>
          </div>
        </div>
      </div>

      {/* KPI STRIP */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className={`border rounded-xl p-4 flex flex-col justify-between ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm' : 'bg-[#0c0d12] border-gray-900'
        }`}>
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">DOCUMENTS TOTAL</span>
            <FileCheck className="w-4 h-4 text-gray-400" />
          </div>
          <div className="mt-2.5">
            <h3 className={`text-2xl font-semibold font-mono tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-gray-100'}`}>{totalDocs}</h3>
            <div className="flex items-center gap-1 mt-1 text-[11px] text-emerald-500 font-medium">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>{entries.length} active shipments</span>
            </div>
          </div>
        </div>

        <div className={`border rounded-xl p-4 flex flex-col justify-between ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm' : 'bg-[#0c0d12] border-gray-900'
        }`}>
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">AVG PARSE TIME</span>
            <Hourglass className="w-4 h-4 text-gray-400" />
          </div>
          <div className="mt-2.5">
            <h3 className={`text-2xl font-semibold font-mono tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-gray-100'}`}>48s</h3>
            <div className="flex items-center gap-1 mt-1 text-[11px] text-emerald-500 font-medium">
              <TrendingDown className="w-3.5 h-3.5" />
              <span>Under 1-min target</span>
            </div>
          </div>
        </div>

        <div className={`border rounded-xl p-4 flex flex-col justify-between ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm' : 'bg-[#0c0d12] border-gray-900'
        }`}>
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">FLAGGED FIELDS %</span>
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </div>
          <div className="mt-2.5">
            <h3 className={`text-2xl font-semibold font-mono tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-gray-100'}`}>{flaggedRate}%</h3>
            <div className="flex items-center gap-1 mt-1 text-[11px] text-gray-500 font-medium">
              <span>{totalFlaggedFields} of {totalFieldsCount} fields</span>
            </div>
          </div>
        </div>

        <div className={`border rounded-xl p-4 flex flex-col justify-between ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm' : 'bg-[#0c0d12] border-gray-900'
        }`}>
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">CATCH RATE</span>
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="mt-2.5">
            <h3 className={`text-2xl font-semibold font-mono tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-gray-100'}`}>99.85%</h3>
            <div className="flex items-center gap-1 mt-1 text-[11px] text-emerald-500 font-medium">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>Validation accuracy</span>
            </div>
          </div>
        </div>

        <div className={`border rounded-xl p-4 flex flex-col justify-between ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm' : 'bg-[#0c0d12] border-gray-900'
        }`}>
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">TIME SAVED</span>
            <CircleDollarSign className="w-4 h-4 text-gray-400" />
          </div>
          <div className="mt-2.5">
            <h3 className={`text-2xl font-semibold font-mono tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-gray-100'}`}>28.5 hr</h3>
            <div className="flex items-center gap-1 mt-1 text-[11px] text-emerald-500 font-medium font-mono">
              <span>Est. $1,425 saved</span>
            </div>
          </div>
        </div>
      </div>

      {/* MAIN LAYOUT */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* LEFT: Active batches table */}
        <div className={`lg:col-span-8 border rounded-xl overflow-hidden flex flex-col justify-between ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm' : 'bg-[#0c0d12] border-gray-900'
        }`}>
          <div>
            <div className={`p-4 border-b flex justify-between items-center ${
              theme === 'light' ? 'bg-gray-50 border-gray-200' : 'bg-[#0e1017] border-gray-900'
            }`}>
              <div>
                <h3 className={`text-sm font-semibold ${theme === 'light' ? 'text-gray-900' : 'text-gray-200'}`}>Active Cargo Ingest Batches</h3>
                <p className="text-xs text-gray-500 mt-0.5">Real-time status of multi-document shipment filings under review.</p>
              </div>
              <span className={`font-mono text-[10px] px-2 py-1 rounded border ${
                theme === 'light' ? 'bg-white border-gray-200 text-gray-500' : 'bg-gray-950 border-gray-900 text-gray-500'
              }`}>
                {entries.length} CURRENT BATCHES
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className={`border-b text-[10px] font-mono uppercase tracking-wider ${
                    theme === 'light' ? 'bg-gray-50/50 border-gray-200 text-gray-500' : 'bg-black/30 border-gray-900 text-gray-500'
                  }`}>
                    <th className="py-3 px-4 font-semibold">SHIPMENT REFERENCE</th>
                    <th className="py-3 px-4 font-semibold">SHIPPER</th>
                    <th className="py-3 px-4 font-semibold text-center">FILES</th>
                    <th className="py-3 px-4 font-semibold text-center">CONFIDENCE</th>
                    <th className="py-3 px-4 font-semibold">DEADLINE</th>
                    <th className="py-3 px-4 font-semibold">STATUS</th>
                    <th className="py-3 px-4 font-semibold text-right">ACTION</th>
                  </tr>
                </thead>
                <tbody className={`divide-y font-medium ${theme === 'light' ? 'divide-gray-100' : 'divide-gray-950'}`}>
                  {entries.map(entry => {
                    const unresolvedCount = entry.exceptions.filter(e => e.status === 'Unresolved').length;
                    return (
                      <tr key={entry.id} className={`transition-colors ${theme === 'light' ? 'hover:bg-gray-50' : 'hover:bg-gray-950/40'}`}>
                        <td className={`py-3.5 px-4 font-mono font-bold ${theme === 'light' ? 'text-gray-900' : 'text-gray-200'}`}>
                          {entry.id}
                        </td>
                        <td className={`py-3.5 px-4 truncate max-w-[140px] ${theme === 'light' ? 'text-gray-600' : 'text-gray-400'}`} title={entry.shipper}>
                          {entry.shipper}
                        </td>
                        <td className="py-3.5 px-4 text-center font-mono text-gray-500">
                          {entry.docsCount} docs
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <span className={`font-mono text-xs font-bold px-2 py-0.5 rounded border inline-block ${getConfidenceBadgeColor(entry.currentConfidence)}`}>
                            {entry.currentConfidence}%
                          </span>
                        </td>
                        <td className={`py-3.5 px-4 font-mono ${theme === 'light' ? 'text-gray-600' : 'text-gray-400'}`}>
                          {entry.urgency === 'RESOLVED' ? (
                            <span className="text-emerald-500">Ready</span>
                          ) : (
                            <div className="flex items-center gap-1 text-red-500 font-bold">
                              <Clock className="w-3.5 h-3.5" />
                              <span>{entry.urgency}</span>
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-4">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${getStatusBadgeColor(entry.status)}`}>
                            {entry.status === 'Under Review' && unresolvedCount > 0
                              ? `${unresolvedCount} EXCEPTIONS`
                              : entry.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <button
                            onClick={() => {
                              selectEntry(entry.id);
                              setActiveTab(entry.exceptions.length > 0 ? 'exception-desk' : 'entry-detail');
                            }}
                            className={`text-[11px] font-semibold px-2.5 py-1 rounded border transition-all cursor-pointer ${
                              theme === 'light'
                                ? 'text-gray-700 hover:text-gray-900 bg-white hover:bg-gray-50 border-gray-200 shadow-sm'
                                : 'text-gray-300 hover:text-white bg-gray-950 hover:bg-gray-900 border-gray-800'
                            }`}
                          >
                            Manage
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className={`p-3 border-t text-center ${theme === 'light' ? 'border-gray-200 bg-gray-50' : 'border-gray-950 bg-black/10'}`}>
            <button
              onClick={() => setActiveTab('entry-detail')}
              className={`text-xs inline-flex items-center gap-1 transition-all cursor-pointer ${
                theme === 'light' ? 'text-gray-500 hover:text-gray-700' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <span>View complete historical entry logs</span>
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* RIGHT: Critical alert + logs */}
        <div className="lg:col-span-4 space-y-5">
          {/* Critical exception module */}
          <div className={`border rounded-xl p-5 space-y-4 ${
            theme === 'light' ? 'bg-white border-gray-200 shadow-sm' : 'bg-[#0c0d12] border-gray-900'
          }`}>
            <div className={`flex items-center gap-2 pb-2 border-b ${theme === 'light' ? 'border-gray-100' : 'border-gray-900'}`}>
              <span className={`p-1 rounded border ${theme === 'light' ? 'bg-red-50 border-red-200 text-red-600' : 'bg-red-950/50 border-red-900/40 text-red-400'}`}>
                <FileWarning className="w-4 h-4 animate-pulse" />
              </span>
              <div>
                <h4 className="text-xs font-bold font-mono tracking-widest text-red-500 uppercase">HIGHEST PRIORITY RECONCILIATION</h4>
                <p className="text-[10px] text-gray-500">Unresolved exception with highest legal weight.</p>
              </div>
            </div>

            {criticalException ? (
              <div className="space-y-3.5">
                <div>
                  <span className="font-mono text-[10px] text-gray-500">{criticalException.entry.id} • {criticalException.exception.docType}</span>
                  <h3 className={`text-sm font-semibold mt-0.5 leading-snug ${theme === 'light' ? 'text-gray-900' : 'text-gray-200'}`}>
                    {criticalException.exception.fieldName}
                  </h3>
                </div>

                <div className={`border p-3 rounded-lg ${theme === 'light' ? 'bg-gray-50 border-gray-200' : 'bg-black/40 border-gray-950'}`}>
                  <span className="text-[9px] font-mono text-gray-500 block uppercase">SYSTEM ASSESSMENT:</span>
                  <p className={`text-xs mt-1 leading-normal ${theme === 'light' ? 'text-gray-600' : 'text-gray-400'}`}>
                    {criticalException.exception.reason}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className={`p-2 rounded font-mono ${theme === 'light' ? 'bg-gray-50 border border-gray-200' : 'bg-black border-gray-900'}`}>
                    <span className="text-[9px] text-gray-500 block">EXTRACTED VALUE</span>
                    <span className={`font-bold ${theme === 'light' ? 'text-gray-800' : 'text-gray-300'}`}>
                      {criticalException.exception.extractedValue}
                    </span>
                  </div>
                  <div className={`p-2 rounded font-mono ${theme === 'light' ? 'bg-gray-50 border border-gray-200' : 'bg-black border-gray-900'}`}>
                    <span className="text-[9px] text-gray-500 block">STATED CONFIDENCE</span>
                    <span className="font-bold text-red-500">{criticalException.exception.confidence}%</span>
                  </div>
                </div>

                <button
                  onClick={handleFixAlert}
                  className={`w-full flex items-center justify-center gap-1.5 text-xs border py-2.5 rounded-lg transition-all font-bold uppercase tracking-wider cursor-pointer ${
                    theme === 'light'
                      ? 'bg-red-50 hover:bg-red-100 text-red-600 border-red-200'
                      : 'bg-red-950/40 hover:bg-red-950 text-red-400 hover:text-white border-red-900/60'
                  }`}
                >
                  <span>Resolve Field Exception</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="py-8 text-center space-y-2">
                <ShieldCheck className="w-10 h-10 text-emerald-500 mx-auto" />
                <p className={`text-xs font-semibold ${theme === 'light' ? 'text-gray-800' : 'text-gray-300'}`}>All Systems Clear</p>
                <p className="text-[11px] text-gray-500">No pending exceptions require human broker intervention at this time.</p>
              </div>
            )}
          </div>

          {/* Audit logs */}
          <div className={`border rounded-xl p-4 flex flex-col ${
            theme === 'light' ? 'bg-white border-gray-200 shadow-sm' : 'bg-[#0c0d12] border-gray-900'
          }`}>
            <div className={`flex items-center gap-1.5 pb-2 border-b mb-3 ${theme === 'light' ? 'border-gray-100' : 'border-gray-900'}`}>
              <Terminal className="w-3.5 h-3.5 text-gray-500" />
              <span className={`text-[10px] font-mono uppercase tracking-widest font-bold ${theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>
                REAL-TIME COMPLIANCE AUDIT LOGS
              </span>
            </div>

            <div className="space-y-3 max-h-[220px] overflow-y-auto pr-1">
              {auditLogs.slice(0, 8).map(log => (
                <div key={log.id} className={`text-[11px] leading-relaxed border-b pb-2 last:border-0 last:pb-0 ${
                  theme === 'light' ? 'border-gray-100' : 'border-gray-950'
                }`}>
                  <div className="flex justify-between items-center text-gray-500 font-mono text-[9px] mb-0.5">
                    <span className="flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        log.type === 'success' ? 'bg-emerald-500' : log.type === 'warning' ? 'bg-amber-500' : log.type === 'error' ? 'bg-red-500' : 'bg-blue-500'
                      }`}></span>
                      {log.type.toUpperCase()}
                    </span>
                    <span suppressHydrationWarning>
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className={`font-medium ${theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>{log.text}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Extraction Health — operational panel showing tier success rates
              over the last 24h + the manual-review queue. Auto-refreshes
              every 30s. Only visible to org members (the underlying API is
              viewer-gated). Hidden in demo/fallback mode (the API returns
              empty arrays). */}
          <ExtractionHealthPanel />
        </div>
      </div>
    </div>
  );
}

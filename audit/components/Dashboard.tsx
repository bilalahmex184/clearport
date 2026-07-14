'use client';

import * as React from 'react';
import { useClearPort, ShipmentEntry } from '../context/ClearPortContext';
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
  Briefcase
} from 'lucide-react';
import { motion } from 'motion/react';

export default function Dashboard() {
  const { entries, selectEntry, setActiveTab, selectException, auditLogs, theme, toggleTheme } = useClearPort();

  // Find the single highest-stakes unresolved exception based on flagged fields (document_fields)
  // (lowest confidence score amongst unresolved flagged fields)
  const criticalException = React.useMemo(() => {
    let highestRisk: { entry: ShipmentEntry; exception: any } | null = null;
    
    for (const entry of entries) {
      if (entry.status === 'Under Review') {
        // Query flagged fields (document_fields) instead of shipments.exceptions directly
        const flaggedFields = entry.fields.filter(f => f.isFlagged);
        for (const field of flaggedFields) {
          // Find the corresponding exception if it exists
          const ex = entry.exceptions.find(e => e.id === field.exceptionId || e.fieldKey === field.key);
          if (ex && ex.status === 'Unresolved') {
            if (!highestRisk || ex.confidence < highestRisk.exception.confidence) {
              highestRisk = { entry, exception: ex };
            }
          } else if (!ex) {
            // Synthesize virtual exception if there is a flagged field without an explicit exception object
            const virtualEx = {
              id: field.exceptionId || `${entry.id}-${field.key}`,
              fieldName: field.label,
              fieldKey: field.key,
              originalValue: field.value,
              extractedValue: field.value,
              confidence: entry.currentConfidence || 70,
              reason: `Discrepancy or flag detected on extracted document field "${field.label}".`,
              docType: field.sourceDoc || 'Document',
              boundingBox: { x: 10, y: 10, w: 20, h: 4 },
              status: 'Unresolved' as const,
              history: []
            };
            if (!highestRisk || virtualEx.confidence < highestRisk.exception.confidence) {
              highestRisk = { entry, exception: virtualEx };
            }
          }
        }
      }
    }
    return highestRisk;
  }, [entries]);

  // Jump straight to resolve this critical issue
  const handleFixAlert = () => {
    if (criticalException) {
      selectEntry(criticalException.entry.id);
      selectException(criticalException.exception.id);
      setActiveTab('exception-desk');
    }
  };

  const getConfidenceBadgeColor = (conf: number) => {
    if (conf < 60) return 'text-red-500 bg-red-100/70 border-red-200 dark:text-red-400 dark:bg-red-950/40 dark:border-red-900/50';
    if (conf < 85) return 'text-amber-600 bg-amber-100/70 border-amber-200 dark:text-amber-400 dark:bg-amber-950/40 dark:border-amber-900/50';
    return 'text-green-600 bg-green-100/70 border-green-200 dark:text-green-400 dark:bg-green-950/40 dark:border-green-900/50';
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'Approved':
        return 'text-emerald-600 bg-emerald-100/70 border-emerald-200 dark:text-emerald-400 dark:bg-emerald-950/40 dark:border-emerald-900/40';
      case 'Exported':
        return 'text-blue-600 bg-blue-100/70 border-blue-200 dark:text-blue-400 dark:bg-blue-950/40 dark:border-blue-900/40';
      default:
        return 'text-amber-600 bg-amber-100/70 border-amber-200 dark:text-amber-400 dark:bg-amber-950/40 dark:border-amber-900/40';
    }
  };

  // Dynamic calculations for KPI strip - querying document_fields (fields isFlagged) instead of shipments.exceptions
  const totalFlaggedFields = entries.reduce((acc, curr) => acc + curr.fields.filter(f => f.isFlagged).length, 0);
  const totalFieldsCount = entries.reduce((acc, curr) => acc + curr.fields.length, 0);
  const flaggedRate = totalFieldsCount > 0 ? ((totalFlaggedFields / totalFieldsCount) * 100).toFixed(1) : '0.0';

  return (
    <div id="dashboard-root" className="space-y-6 overflow-y-auto max-h-[calc(100vh-120px)] pb-8 pr-2 font-sans">
      
      {/* HEADER SECTION WITH COMPLIANCE SUMMARY & THEME SWITCH */}
      <div className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b transition-colors duration-200 ${
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

        {/* Dynamic Dual-Color Theme Switch */}
        <div className="shrink-0 flex items-center gap-2.5">
          <span className={`font-mono text-[10px] uppercase font-bold tracking-wider ${theme === 'light' ? 'text-gray-500' : 'text-gray-450'}`}>
            CONSOLE THEME
          </span>
          <div className={`relative flex items-center p-0.5 rounded-full border transition-all duration-200 ${
            theme === 'light' 
              ? 'bg-gray-200 border-gray-300' 
              : 'bg-[#0d0e14] border-gray-800'
          }`}>
            {/* Dark Toggle Button Part */}
            <button
              onClick={() => { if (theme !== 'dark') toggleTheme(); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-mono font-bold uppercase transition-all duration-200 cursor-pointer ${
                theme === 'dark'
                  ? 'bg-[#06070a] text-amber-500 border border-amber-500/30 shadow-md shadow-amber-500/5'
                  : 'text-gray-500 hover:text-gray-400'
              }`}
            >
              <div className="w-2.5 h-2.5 rounded-full bg-[#06070a] border border-gray-750 shrink-0" />
              <span>Dark</span>
            </button>
            {/* Light Toggle Button Part */}
            <button
              onClick={() => { if (theme !== 'light') toggleTheme(); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-mono font-bold uppercase transition-all duration-200 cursor-pointer ${
                theme === 'light'
                  ? 'bg-white text-gray-900 border border-gray-200 shadow-sm'
                  : 'text-gray-500 hover:text-gray-450'
              }`}
            >
              <div className="w-2.5 h-2.5 rounded-full bg-white border border-gray-300 shrink-0" />
              <span>Light</span>
            </button>
          </div>
        </div>
      </div>

      {/* 1. TOP KPI STRIP */}
      <div id="kpi-strip" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        
        {/* KPI 1: Documents Processed */}
        <div className={`border rounded-xl p-4 flex flex-col justify-between transition-all duration-200 ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm text-gray-800' : 'bg-[#0c0d12] border-gray-900 text-gray-200'
        }`}>
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">DOCUMENTS TODAY</span>
            <FileCheck className={`w-4 h-4 ${theme === 'light' ? 'text-gray-400' : 'text-gray-450'}`} />
          </div>
          <div className="mt-2.5">
            <h3 className={`text-2xl font-semibold font-mono tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-gray-100'}`}>142</h3>
            <div className="flex items-center gap-1 mt-1 text-[11px] text-emerald-600 font-medium">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>+12.4% vs last week</span>
            </div>
          </div>
        </div>

        {/* KPI 2: Average Processing Time */}
        <div className={`border rounded-xl p-4 flex flex-col justify-between transition-all duration-200 ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm text-gray-800' : 'bg-[#0c0d12] border-gray-900 text-gray-200'
        }`}>
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">AVG PARSE TIME</span>
            <Hourglass className={`w-4 h-4 ${theme === 'light' ? 'text-gray-400' : 'text-gray-450'}`} />
          </div>
          <div className="mt-2.5">
            <h3 className={`text-2xl font-semibold font-mono tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-gray-100'}`}>48s</h3>
            <div className="flex items-center gap-1 mt-1 text-[11px] text-emerald-600 font-medium">
              <TrendingDown className="w-3.5 h-3.5" />
              <span>-4.2s (OCR upgrade)</span>
            </div>
          </div>
        </div>

        {/* KPI 3: Flagged Fields % */}
        <div className={`border rounded-xl p-4 flex flex-col justify-between transition-all duration-200 ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm text-gray-800' : 'bg-[#0c0d12] border-gray-900 text-gray-200'
        }`}>
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">FLAGGED FIELDS %</span>
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </div>
          <div className="mt-2.5">
            <h3 className={`text-2xl font-semibold font-mono tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-gray-100'}`}>{flaggedRate}%</h3>
            <div className="flex items-center gap-1 mt-1 text-[11px] text-emerald-600 font-medium">
              <TrendingDown className="w-3.5 h-3.5" />
              <span>-0.8% auto-cleared</span>
            </div>
          </div>
        </div>

        {/* KPI 4: Error Catch Rate */}
        <div className={`border rounded-xl p-4 flex flex-col justify-between transition-all duration-200 ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm text-gray-800' : 'bg-[#0c0d12] border-gray-900 text-gray-200'
        }`}>
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">CATCH RATE (CBP)</span>
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="mt-2.5">
            <h3 className={`text-2xl font-semibold font-mono tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-gray-100'}`}>99.85%</h3>
            <div className="flex items-center gap-1 mt-1 text-[11px] text-emerald-600 font-medium">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>+0.02% CBP clear</span>
            </div>
          </div>
        </div>

        {/* KPI 5: Hours Saved */}
        <div className={`border rounded-xl p-4 flex flex-col justify-between transition-all duration-200 ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm text-gray-800' : 'bg-[#0c0d12] border-gray-900 text-gray-200'
        }`}>
          <div className="flex justify-between items-start">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest">TIME & VALUE SAVED</span>
            <CircleDollarSign className={`w-4 h-4 ${theme === 'light' ? 'text-gray-400' : 'text-gray-450'}`} />
          </div>
          <div className="mt-2.5">
            <h3 className={`text-2xl font-semibold font-mono tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-gray-100'}`}>28.5 hr</h3>
            <div className="flex items-center gap-1 mt-1 text-[11px] text-emerald-600 font-medium font-mono">
              <span>Est. $1,425 saved today</span>
            </div>
          </div>
        </div>

      </div>

      {/* 2. MAIN LAYOUT: ACTIVE BATCHES & CRITICAL ALERT PANEL */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        
        {/* LEFT COLUMN: ACTIVE BATCHES TABLE (8 cols) */}
        <div className={`lg:col-span-8 border rounded-xl overflow-hidden flex flex-col justify-between transition-colors duration-200 ${
          theme === 'light' ? 'bg-white border-gray-200 shadow-sm' : 'bg-[#0c0d12] border-gray-900'
        }`}>
          <div>
            <div className={`p-4 border-b flex justify-between items-center transition-colors duration-200 ${
              theme === 'light' ? 'bg-gray-50 border-gray-200' : 'bg-[#0e1017] border-gray-900'
            }`}>
              <div>
                <h3 className={`text-sm font-semibold ${theme === 'light' ? 'text-gray-900' : 'text-gray-200'}`}>Active Cargo Ingest Batches</h3>
                <p className="text-xs text-gray-500 mt-0.5">Real-time status of multi-document shipment filings under review.</p>
              </div>
              <span className={`font-mono text-[10px] px-2 py-1 rounded border transition-colors duration-200 ${
                theme === 'light' ? 'bg-white border-gray-200 text-gray-500' : 'bg-gray-950 border-gray-900 text-gray-450'
              }`}>
                {entries.length} CURRENT BATCHES
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className={`border-b text-[10px] font-mono uppercase tracking-wider transition-colors duration-200 ${
                    theme === 'light' ? 'bg-gray-50/50 border-gray-200 text-gray-500' : 'bg-black/30 border-gray-900 text-gray-500'
                  }`}>
                    <th className="py-3 px-4 font-semibold">SHIPMENT REFERENCE</th>
                    <th className="py-3 px-4 font-semibold">SHIPPER EXPORTER</th>
                    <th className="py-3 px-4 font-semibold text-center">FILES</th>
                    <th className="py-3 px-4 font-semibold text-center">INTEGRITY RATE</th>
                    <th className="py-3 px-4 font-semibold">CBP DEADLINE</th>
                    <th className="py-3 px-4 font-semibold">STATUS</th>
                    <th className="py-3 px-4 font-semibold text-right">ACTION</th>
                  </tr>
                </thead>
                <tbody className={`divide-y font-medium transition-colors duration-200 ${
                  theme === 'light' ? 'divide-gray-150' : 'divide-gray-950'
                }`}>
                  {entries.map((entry) => {
                    const unresolvedCount = entry.exceptions.filter(e => e.status === 'Unresolved').length;
                    
                    return (
                      <tr key={entry.id} className={`transition-colors ${
                        theme === 'light' ? 'hover:bg-gray-50/50' : 'hover:bg-gray-950/40'
                      }`}>
                        <td className={`py-3.5 px-4 font-mono font-bold ${
                          theme === 'light' ? 'text-gray-900' : 'text-gray-200'
                        }`}>
                          {entry.id}
                        </td>
                        <td className={`py-3.5 px-4 truncate max-w-[140px] ${
                          theme === 'light' ? 'text-gray-600' : 'text-gray-400'
                        }`} title={entry.shipper}>
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
                        <td className={`py-3.5 px-4 font-mono ${
                          theme === 'light' ? 'text-gray-600' : 'text-gray-400'
                        }`}>
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
                                ? 'text-gray-750 hover:text-gray-900 bg-white hover:bg-gray-50 border-gray-250 shadow-sm'
                                : 'text-gray-300 hover:text-white bg-gray-950 hover:bg-gray-900 border-gray-850'
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

          <div className={`p-3 border-t text-center transition-colors duration-200 ${
            theme === 'light' ? 'border-gray-200 bg-gray-50/50' : 'border-gray-950 bg-black/10'
          }`}>
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

        {/* RIGHT COLUMN: HIGH-STAKES EXCEPTION ALERT (4 cols) */}
        <div className="lg:col-span-4 space-y-5">
          
          {/* CRITICAL EXCEPTION MODULE */}
          <div className={`border rounded-xl p-5 space-y-4 transition-colors duration-200 ${
            theme === 'light' ? 'bg-white border-gray-200 shadow-sm text-gray-800' : 'bg-[#0c0d12] border-gray-900 text-gray-200'
          }`}>
            <div className={`flex items-center gap-2 pb-2 border-b transition-colors duration-200 ${
              theme === 'light' ? 'border-gray-150' : 'border-gray-900'
            }`}>
              <span className={`p-1 rounded border ${
                theme === 'light' ? 'bg-red-50 border-red-200 text-red-600' : 'bg-red-950/50 border-red-900/40 text-red-400'
              }`}>
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
                  <h3 className={`text-sm font-semibold mt-0.5 leading-snug ${theme === 'light' ? 'text-gray-900' : 'text-gray-200'}`}>{criticalException.exception.fieldName}</h3>
                </div>

                <div className={`border p-3 rounded-lg transition-colors duration-200 ${
                  theme === 'light' ? 'bg-gray-50 border-gray-200' : 'bg-black/40 border-gray-950'
                }`}>
                  <span className="text-[9px] font-mono text-gray-500 block uppercase">SYSTEM ASSESSMENT:</span>
                  <p className={`text-xs mt-1 leading-normal ${theme === 'light' ? 'text-gray-650' : 'text-gray-450'}`}>
                    {criticalException.exception.reason}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className={`p-2 rounded font-mono transition-colors duration-200 ${
                    theme === 'light' ? 'bg-gray-50 border border-gray-200' : 'bg-black'
                  }`}>
                    <span className="text-[9px] text-gray-500 block">EXTRACTED VALUE</span>
                    <span className={`font-bold ${theme === 'light' ? 'text-gray-800' : 'text-gray-350'}`}>{criticalException.exception.extractedValue}</span>
                  </div>
                  <div className={`p-2 rounded font-mono transition-colors duration-200 ${
                    theme === 'light' ? 'bg-gray-50 border border-gray-200' : 'bg-black'
                  }`}>
                    <span className="text-[9px] text-gray-500 block">STATED CONFIDENCE</span>
                    <span className="font-bold text-red-500">{criticalException.exception.confidence}%</span>
                  </div>
                </div>

                <button
                  onClick={handleFixAlert}
                  className={`w-full flex items-center justify-center gap-1.5 text-xs border py-2.5 rounded-lg transition-all font-bold uppercase tracking-wider cursor-pointer ${
                    theme === 'light'
                      ? 'bg-red-50 hover:bg-red-100 text-red-650 hover:text-red-700 border-red-200'
                      : 'bg-red-955/40 hover:bg-red-950 text-red-400 hover:text-white border-red-900/60'
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

          {/* REAL-TIME SYSTEM LOGS FEED */}
          <div className={`border rounded-xl p-4 flex flex-col transition-colors duration-200 ${
            theme === 'light' ? 'bg-white border-gray-200 shadow-sm text-gray-800' : 'bg-[#0c0d12] border-gray-900 text-gray-200'
          }`}>
            <div className={`flex items-center gap-1.5 pb-2 border-b mb-3 transition-colors duration-200 ${
              theme === 'light' ? 'border-gray-150' : 'border-gray-900'
            }`}>
              <Terminal className="w-3.5 h-3.5 text-gray-500" />
              <span className={`text-[10px] font-mono uppercase tracking-widest font-bold ${theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>REAL-TIME COMPLIANCE AUDIT LOGS</span>
            </div>

            <div className="space-y-3 max-h-[220px] overflow-y-auto pr-1">
              {auditLogs.slice(0, 6).map((log) => (
                <div key={log.id} className={`text-[11px] leading-relaxed border-b pb-2 last:border-0 last:pb-0 transition-colors duration-200 ${
                  theme === 'light' ? 'border-gray-100' : 'border-gray-950'
                }`}>
                  <div className="flex justify-between items-center text-gray-500 font-mono text-[9px] mb-0.5">
                    <span className="flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        log.type === 'success' ? 'bg-emerald-500' : log.type === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                      }`}></span>
                      {log.type.toUpperCase()}
                    </span>
                    <span suppressHydrationWarning>{new Date(log.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className={`font-medium ${theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>{log.text}</p>
                </div>
              ))}
            </div>
          </div>

        </div>

      </div>

    </div>
  );
}

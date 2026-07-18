'use client';

import * as React from 'react';
import { useClearPort } from '@/context/ClearPortContext';
import { AlertTriangle, FileWarning, ChevronRight } from 'lucide-react';

export default function CrossDocAuditor() {
  const { entries, selectedEntry, setActiveTab, selectException } = useClearPort();

  if (!selectedEntry) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-500 p-6">
        <AlertTriangle className="w-12 h-12 mb-4 text-gray-600 animate-pulse" />
        <p className="text-sm font-medium">No active entry selected</p>
        <p className="text-xs text-gray-600 mt-1">Please select an active batch from the Dashboard.</p>
      </div>
    );
  }

  // Derive documents from fields' sourceDoc
  const uniqueDocs = Array.from(new Set(selectedEntry.fields.map(f => f.sourceDoc).filter(Boolean)));
  const documentCount = Math.max(selectedEntry.docsCount || 0, uniqueDocs.length);

  if (documentCount < 2 && selectedEntry.exceptions.length === 0) {
    return (
      <div className="space-y-4 sm:space-y-6 overflow-y-auto h-full pb-6 sm:pb-8 pr-1 sm:pr-2 p-3 sm:p-4 md:p-6 font-sans">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0c0d12] border border-gray-900 rounded-xl p-5">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="font-mono text-xs text-amber-500 tracking-wider">INTEGRITY ENGINE</span>
              <span className="w-1 h-1 bg-gray-700 rounded-full"></span>
              <span className="font-mono text-xs text-gray-400">{selectedEntry.id}</span>
            </div>
            <h2 className="text-xl font-bold text-gray-100 tracking-tight">Cross-Document Verification Auditor</h2>
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">
              Comparing values declared across Commercial Invoice, packing documents, Certificates, and shipping manifests to detect hidden customs discrepancies.
            </p>
          </div>
          <div className="text-right">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest block">ENTRY INTEGRITY STATUS</span>
            <span className="text-sm font-mono font-extrabold mt-1 inline-block px-3 py-1 rounded border border-amber-900/40 text-amber-500 bg-amber-950/30">
              INSUFFICIENT DATA
            </span>
          </div>
        </div>

        <div className="h-[calc(100vh-280px)] flex flex-col items-center justify-center border border-gray-900 rounded-xl bg-[#0c0d12] p-8 text-center text-gray-500">
          <FileWarning className="w-12 h-12 mb-4 text-amber-500/80 animate-pulse" />
          <h3 className="text-sm font-semibold text-gray-200">Not enough documents to cross-reference</h3>
          <p className="text-xs text-gray-400 mt-2 max-w-md leading-relaxed">
            This shipment currently contains only {documentCount} document{documentCount === 1 ? '' : 's'} ({uniqueDocs.join(', ') || 'Commercial Invoice'}).
            Cross-document verification requires at least 2 documents to cross-reference fields and detect discrepancies.
          </p>
        </div>
      </div>
    );
  }

  // Find exceptions by field key (no hardcoded IDs — fully data-driven)
  const weightExc = selectedEntry.exceptions.find(ex => ex.fieldKey === 'netWeight' || ex.fieldKey === 'net_weight');
  const htsExc = selectedEntry.exceptions.find(ex => ex.fieldKey === 'htsCode' || ex.fieldKey === 'hts_code');
  const originExc = selectedEntry.exceptions.find(ex => ex.fieldKey === 'countryOfOrigin' || ex.fieldKey === 'country_of_origin');
  const valueExc = selectedEntry.exceptions.find(ex => ex.fieldKey === 'declaredValue' || ex.fieldKey === 'declared_value');

  // Get field values (data-driven, no hardcoded fallbacks)
  const htsField = selectedEntry.fields.find(f => f.key === 'htsCode' || f.key === 'hts_code');
  const valueField = selectedEntry.fields.find(f => f.key === 'declaredValue' || f.key === 'declared_value');
  const weightField = selectedEntry.fields.find(f => f.key === 'netWeight' || f.key === 'net_weight');

  const htsValue = htsField?.value || '—';
  const declaredValueStr = valueField?.value || '—';
  const weightValue = weightField?.value || '—';

  const handleDeepLink = (exceptionId: string) => {
    selectException(exceptionId);
    setActiveTab('exception-desk');
  };

  return (
    <div className="space-y-4 sm:space-y-6 overflow-y-auto h-full pb-6 sm:pb-8 pr-1 sm:pr-2 p-3 sm:p-4 md:p-6 font-sans">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0c0d12] border border-gray-900 rounded-xl p-5">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="font-mono text-xs text-amber-500 tracking-wider">INTEGRITY ENGINE</span>
            <span className="w-1 h-1 bg-gray-700 rounded-full"></span>
            <span className="font-mono text-xs text-gray-400">{selectedEntry.id}</span>
          </div>
          <h2 className="text-xl font-bold text-gray-100 tracking-tight">Cross-Document Verification Auditor</h2>
          <p className="text-xs text-gray-400 mt-1 leading-relaxed">
            Comparing values declared across Commercial Invoice, packing documents, Certificates, and shipping manifests.
          </p>
        </div>
        <div className="text-right">
          <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest block">ENTRY INTEGRITY STATUS</span>
          <span className={`text-sm font-mono font-extrabold mt-1 inline-block px-3 py-1 rounded border ${
            selectedEntry.status === 'Approved'
              ? 'text-emerald-400 bg-emerald-950/30 border-emerald-900/40'
              : 'text-amber-500 bg-amber-950/30 border-amber-900/40'
          }`}>
            {selectedEntry.status === 'Approved' ? 'PASSED / SECURE' : 'ACTION REQUIRED'}
          </span>
        </div>
      </div>

      {/* Comparison Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {/* Weight Card */}
        <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5 flex flex-col justify-between hover:border-gray-800 transition-all">
          <div>
            <div className="flex justify-between items-start mb-3">
              <span className="text-xs font-mono text-gray-400 font-bold uppercase tracking-wider">Weight Discrepancy Test</span>
              {weightExc && weightExc.status === 'Unresolved' ? (
                <span className="text-[10px] font-mono font-bold bg-red-950/40 text-red-400 border border-red-900/40 px-2 py-0.5 rounded">
                  CRITICAL MISMATCH
                </span>
              ) : (
                <span className="text-[10px] font-mono font-bold bg-emerald-950/40 text-emerald-400 border border-emerald-900/40 px-2 py-0.5 rounded">
                  MATCHING / VERIFIED
                </span>
              )}
            </div>

            <div className="space-y-2 mt-4">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-gray-500">Extracted Value:</span>
                <span className={`font-semibold ${weightExc && weightExc.status === 'Unresolved' ? 'text-red-400' : 'text-gray-300'}`}>
                  {weightValue}
                </span>
              </div>
              {weightExc?.crossDocValue && (
                <div className="flex justify-between text-xs font-mono border-t border-gray-900 pt-1.5">
                  <span className="text-gray-500">Cross-Doc Source:</span>
                  <span className="font-semibold text-gray-300">{weightExc.crossDocValue}</span>
                </div>
              )}
            </div>

            {weightExc && weightExc.status === 'Unresolved' ? (
              <div className="mt-4 bg-[#140b0b] border border-red-950 p-3 rounded-lg space-y-1">
                <span className="text-[10px] text-red-400 font-mono font-bold uppercase block">DISCREPANCY DETECTED</span>
                <p className="text-[11px] text-gray-300 leading-normal">{weightExc.reason}</p>
              </div>
            ) : (
              <div className="mt-4 bg-emerald-950/20 border border-emerald-900/30 p-3 rounded-lg">
                <p className="text-[11px] text-gray-400 leading-normal">
                  All cargo manifests and packing documentation net weights align perfectly.
                </p>
              </div>
            )}
          </div>

          {weightExc && weightExc.status === 'Unresolved' && (
            <button
              onClick={() => handleDeepLink(weightExc.id)}
              className="mt-5 w-full flex items-center justify-center gap-1.5 text-xs bg-red-950/50 hover:bg-red-950 text-red-400 hover:text-white border border-red-900/60 py-2.5 rounded-lg transition-all cursor-pointer font-bold uppercase tracking-wider"
            >
              <FileWarning className="w-3.5 h-3.5" />
              Fix This Now
            </button>
          )}
        </div>

        {/* HTS Code Card */}
        <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5 flex flex-col justify-between hover:border-gray-800 transition-all">
          <div>
            <div className="flex justify-between items-start mb-3">
              <span className="text-xs font-mono text-gray-400 font-bold uppercase tracking-wider">HTS Code Consistency</span>
              {htsExc && htsExc.status === 'Unresolved' ? (
                <span className="text-[10px] font-mono font-bold bg-amber-950/40 text-amber-400 border border-amber-900/40 px-2 py-0.5 rounded">
                  TARIFF WARNING
                </span>
              ) : (
                <span className="text-[10px] font-mono font-bold bg-emerald-950/40 text-emerald-400 border border-emerald-900/40 px-2 py-0.5 rounded">
                  MATCHING / VERIFIED
                </span>
              )}
            </div>

            <div className="space-y-2 mt-4">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-gray-500">Extracted HTS:</span>
                <span className={`font-semibold ${htsExc && htsExc.status === 'Unresolved' ? 'text-amber-400' : 'text-gray-300'}`}>
                  {htsValue}
                </span>
              </div>
              {htsExc?.crossDocValue && (
                <div className="flex justify-between text-xs font-mono border-t border-gray-900 pt-1.5">
                  <span className="text-gray-500">Cross-Doc HTS:</span>
                  <span className="font-semibold text-gray-300">{htsExc.crossDocValue}</span>
                </div>
              )}
            </div>

            {htsExc && htsExc.status === 'Unresolved' ? (
              <div className="mt-4 bg-[#14110b] border border-amber-950 p-3 rounded-lg space-y-1">
                <span className="text-[10px] text-amber-400 font-mono font-bold uppercase block">CLASSIFICATION MISMATCH</span>
                <p className="text-[11px] text-gray-300 leading-normal">{htsExc.reason}</p>
              </div>
            ) : (
              <div className="mt-4 bg-emerald-950/20 border border-emerald-900/30 p-3 rounded-lg">
                <p className="text-[11px] text-gray-400 leading-normal">
                  Primary and supplementary tariff classifications align across documents.
                </p>
              </div>
            )}
          </div>

          {htsExc && htsExc.status === 'Unresolved' && (
            <button
              onClick={() => handleDeepLink(htsExc.id)}
              className="mt-5 w-full flex items-center justify-center gap-1.5 text-xs bg-amber-950/50 hover:bg-amber-950 text-amber-400 hover:text-white border border-amber-900/60 py-2.5 rounded-lg transition-all cursor-pointer font-bold uppercase tracking-wider"
            >
              <FileWarning className="w-3.5 h-3.5" />
              Fix This Now
            </button>
          )}
        </div>

        {/* Origin & Value Card */}
        <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5 flex flex-col justify-between hover:border-gray-800 transition-all">
          <div>
            <div className="flex justify-between items-start mb-3">
              <span className="text-xs font-mono text-gray-400 font-bold uppercase tracking-wider">Origin & Value Verification</span>
              {originExc && originExc.status === 'Unresolved' ? (
                <span className="text-[10px] font-mono font-bold bg-amber-950/40 text-amber-400 border border-amber-900/40 px-2 py-0.5 rounded">
                  ORIGIN DISCREPANCY
                </span>
              ) : valueExc && valueExc.status === 'Unresolved' ? (
                <span className="text-[10px] font-mono font-bold bg-amber-950/40 text-amber-400 border border-amber-900/40 px-2 py-0.5 rounded">
                  VALUATION WARNING
                </span>
              ) : (
                <span className="text-[10px] font-mono font-bold bg-emerald-950/40 text-emerald-400 border border-emerald-900/40 px-2 py-0.5 rounded">
                  MATCHING / VERIFIED
                </span>
              )}
            </div>

            <div className="space-y-2 mt-4">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-gray-500">Declared Value:</span>
                <span className="font-semibold text-gray-300">{declaredValueStr}</span>
              </div>
              {originExc?.crossDocValue && (
                <div className="flex justify-between text-xs font-mono border-t border-gray-900 pt-1.5">
                  <span className="text-gray-500">Origin Conflict:</span>
                  <span className={`font-semibold ${originExc.status === 'Unresolved' ? 'text-amber-400' : 'text-gray-300'}`}>
                    {originExc.crossDocValue}
                  </span>
                </div>
              )}
            </div>

            {((originExc && originExc.status === 'Unresolved') || (valueExc && valueExc.status === 'Unresolved')) ? (
              <div className="mt-4 bg-[#14110b] border border-amber-950 p-3 rounded-lg space-y-1">
                <span className="text-[10px] text-amber-400 font-mono font-bold uppercase block">INTEGRITY CHECK FAIL</span>
                <p className="text-[11px] text-gray-300 leading-normal">
                  {originExc?.reason || valueExc?.reason || 'Discrepancy detected in origin or value fields.'}
                </p>
              </div>
            ) : (
              <div className="mt-4 bg-emerald-950/20 border border-emerald-900/30 p-3 rounded-lg">
                <p className="text-[11px] text-gray-400 leading-normal">
                  Declared origins and values have been crosschecked and match fully.
                </p>
              </div>
            )}
          </div>

          {((originExc && originExc.status === 'Unresolved') || (valueExc && valueExc.status === 'Unresolved')) && (
            <button
              onClick={() => handleDeepLink(originExc ? originExc.id : valueExc!.id)}
              className="mt-5 w-full flex items-center justify-center gap-1.5 text-xs bg-amber-950/50 hover:bg-amber-950 text-amber-400 hover:text-white border border-amber-900/60 py-2.5 rounded-lg transition-all cursor-pointer font-bold uppercase tracking-wider"
            >
              <FileWarning className="w-3.5 h-3.5" />
              Fix This Now
            </button>
          )}
        </div>
      </div>

      {/* Detailed Comparison Table */}
      <div className="bg-[#0c0d12] border border-gray-900 rounded-xl overflow-hidden">
        <div className="p-4 bg-[#0e1017] border-b border-gray-900 flex justify-between items-center">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Cross-Document Value Comparison Matrix</h3>
            <p className="text-xs text-gray-500 mt-0.5">Comprehensive audit of extracted data fields compared side-by-side.</p>
          </div>
          <span className="font-mono text-xs text-gray-500">{uniqueDocs.length} SOURCE FILES PARSED</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-gray-900 text-[10px] font-mono text-gray-500 uppercase tracking-wider bg-black/30">
                <th className="py-3 px-4 font-semibold">DATA FIELD KEY</th>
                <th className="py-3 px-4 font-semibold">VALUE</th>
                <th className="py-3 px-4 font-semibold">CROSS-DOC VALUE</th>
                <th className="py-3 px-4 font-semibold">SOURCE</th>
                <th className="py-3 px-4 font-semibold text-right">AUDIT STATEMENT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-950 font-medium">
              {selectedEntry.fields.filter(f => f.isFlagged || f.crossDocValue).map((f, idx) => {
                const exc = selectedEntry.exceptions.find(e => e.id === f.exceptionId);
                const hasMismatch = exc && exc.status === 'Unresolved';
                return (
                  <tr key={f.id || idx} className="hover:bg-gray-950/40">
                    <td className="py-3 px-4 font-mono text-gray-400">{f.label}</td>
                    <td className={`py-3 px-4 font-mono ${hasMismatch ? 'text-amber-400 font-bold' : 'text-gray-300'}`}>
                      {f.value}
                    </td>
                    <td className="py-3 px-4 font-mono text-gray-300">
                      {f.crossDocValue || '—'}
                    </td>
                    <td className="py-3 px-4 font-mono text-gray-500">
                      {f.crossDocSource || f.sourceDoc}
                    </td>
                    <td className={`py-3 px-4 text-right font-mono ${hasMismatch ? 'text-amber-500 font-bold' : 'text-emerald-400'}`}>
                      {hasMismatch ? 'MISMATCH' : 'PASSED'}
                    </td>
                  </tr>
                );
              })}
              {selectedEntry.fields.filter(f => f.isFlagged || f.crossDocValue).length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-gray-500 text-xs">
                    No flagged fields to display. All fields passed cross-document validation.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

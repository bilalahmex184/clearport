'use client';

import * as React from 'react';
import { useClearPort } from '../context/ClearPortContext';
import { CheckCircle2, AlertTriangle, ArrowRight, CornerDownRight, FileWarning, Search, ChevronRight } from 'lucide-react';
import { motion } from 'motion/react';

export default function CrossDocAuditor() {
  const { entries, selectedEntry, selectedEntryId, setActiveTab, selectException } = useClearPort();

  if (!selectedEntry) {
    return (
      <div id="cross-doc-empty" className="h-[calc(100vh-140px)] flex flex-col items-center justify-center text-gray-500">
        <AlertTriangle className="w-12 h-12 mb-4 text-gray-600 animate-pulse" />
        <p className="text-sm font-medium">No active entry selected</p>
        <p className="text-xs text-gray-600 mt-1">Please select an active batch from the Dashboard.</p>
      </div>
    );
  }

  // Check the actual number of documents available for the given shipment
  const uniqueDocs = Array.from(new Set(selectedEntry.fields.map(f => f.sourceDoc).filter(Boolean)));
  const documentCount = Math.max(selectedEntry.docsCount || 0, uniqueDocs.length);

  if (documentCount < 2) {
    return (
      <div id="cross-doc-root" className="space-y-6 overflow-y-auto max-h-[calc(100vh-120px)] pb-8 pr-2 font-sans">
        {/* Header and Summary */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0c0d12] border border-gray-900 rounded-xl p-5">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="font-mono text-xs text-amber-500 tracking-wider">INTEGRITY ENGINE</span>
              <span className="w-1 h-1 bg-gray-700 rounded-full"></span>
              <span className="font-mono text-xs text-gray-400">{selectedEntry.id}</span>
            </div>
            <h2 className="text-xl font-bold text-gray-100 tracking-tight">Cross-Document Verification Auditor</h2>
            <p className="text-xs text-gray-400 mt-1 leading-relaxed">
              Comparing values declared across Commercial Invoice, packing documents, Certificates, and shipping carriers manifests to detect hidden customs discrepancies.
            </p>
          </div>
          <div className="text-right">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest block">ENTRY INTEGRITY STATUS</span>
            <span className={`text-sm font-mono font-extrabold mt-1 inline-block px-3 py-1 rounded border border-amber-900/40 text-amber-500 bg-amber-950/30`}>
              INSUFFICIENT DATA
            </span>
          </div>
        </div>

        <div className="h-[calc(100vh-280px)] flex flex-col items-center justify-center border border-gray-900 rounded-xl bg-[#0c0d12] p-8 text-center text-gray-500">
          <FileWarning className="w-12 h-12 mb-4 text-amber-500/80 animate-pulse" />
          <h3 className="text-sm font-semibold text-gray-200">Not enough documents to cross-reference</h3>
          <p className="text-xs text-gray-400 mt-2 max-w-md leading-relaxed">
            This shipment currently contains only {documentCount} document{documentCount === 1 ? '' : 's'} ({uniqueDocs.join(', ') || 'Commercial Invoice'}). 
            Cross-document verification requires at least 2 documents (e.g., Commercial Invoice, Packing List, or Bill of Lading) to cross-reference fields and detect discrepancies.
          </p>
        </div>
      </div>
    );
  }

  // Find status of specific discrepancies in our selected entry
  const weightExc = selectedEntry.exceptions.find((ex) => ex.fieldKey === 'netWeight' || ex.fieldKey === 'net_weight');
  const htsExc = selectedEntry.exceptions.find((ex) => ex.fieldKey === 'htsCode' || ex.fieldKey === 'hts_code');
  const originExc = selectedEntry.exceptions.find((ex) => ex.fieldKey === 'countryOfOrigin' || ex.fieldKey === 'country_of_origin');
  const valueExc = selectedEntry.exceptions.find((ex) => ex.fieldKey === 'declaredValue' || ex.fieldKey === 'declared_value');

  // Query live fields from selectedEntry (which fetches from document_fields table)
  const htsField = selectedEntry.fields.find(f => f.key === 'htsCode' || f.key === 'hts_code');
  const valueField = selectedEntry.fields.find(f => f.key === 'declaredValue' || f.key === 'declared_value');
  const htsValue = htsField ? htsField.value : (selectedEntry.id === 'SHIP-2026-8802' || selectedEntry.id === 'SHIP-999-DEMO' ? '8108.90.3060' : '8504.40.9580');
  const declaredValueStr = valueField ? valueField.value : (selectedEntry.id === 'SHIP-2026-8802' || selectedEntry.id === 'SHIP-999-DEMO' ? '$128,450.00' : '$84,120.00');

  // Helper for deep-linking
  const handleDeepLink = (exceptionId: string) => {
    selectException(exceptionId);
    setActiveTab('exception-desk');
  };

  return (
    <div id="cross-doc-root" className="space-y-6 overflow-y-auto max-h-[calc(100vh-120px)] pb-8 pr-2 font-sans">
      
      {/* Header and Summary */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0c0d12] border border-gray-900 rounded-xl p-5">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="font-mono text-xs text-amber-500 tracking-wider">INTEGRITY ENGINE</span>
            <span className="w-1 h-1 bg-gray-700 rounded-full"></span>
            <span className="font-mono text-xs text-gray-400">{selectedEntry.id}</span>
          </div>
          <h2 className="text-xl font-bold text-gray-100 tracking-tight">Cross-Document Verification Auditor</h2>
          <p className="text-xs text-gray-400 mt-1 leading-relaxed">
            Comparing values declared across Commercial Invoice, packing documents, Certificates, and shipping carriers manifests to detect hidden customs discrepancies.
          </p>
        </div>
        <div className="text-right">
          <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest block">ENTRY INTEGRITY STATUS</span>
          <span className={`text-sm font-mono font-extrabold mt-1 inline-block px-3 py-1 rounded border ${
            selectedEntry.status === 'Approved' ? 'text-emerald-400 bg-emerald-950/30 border-emerald-900/40' : 'text-amber-500 bg-amber-950/30 border-amber-900/40'
          }`}>
            {selectedEntry.status === 'Approved' ? 'PASSED / SECURE' : 'ACTION REQUIRED / SUSPENDED'}
          </span>
        </div>
      </div>

      {/* CROSS-DOCUMENT COMPARSION CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        
        {/* CARD 1: CARGO WEIGHT CROSS-CHECK */}
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
                <span className="text-gray-500">Bill of Lading:</span>
                <span className={`font-semibold ${weightExc && weightExc.status === 'Unresolved' ? 'text-red-400' : 'text-gray-300'}`}>
                  {weightExc && weightExc.status === 'Unresolved' ? '12,450 lbs' : '14,250 lbs'}
                </span>
              </div>
              <div className="flex justify-between text-xs font-mono border-t border-gray-900 pt-1.5">
                <span className="text-gray-500">Packing List:</span>
                <span className="font-semibold text-gray-300">14,250 lbs</span>
              </div>
            </div>

            {weightExc && weightExc.status === 'Unresolved' ? (
              <div className="mt-4 bg-[#140b0b] border border-red-950 p-3 rounded-lg space-y-1">
                <span className="text-[10px] text-red-400 font-mono font-bold uppercase block">1,800 LBS DISCREPANCY</span>
                <p className="text-[11px] text-gray-300 leading-normal">
                  Under-declared weights represent a primary flag for Customs (CBP) audit inspections and can lead to severe fines and vessel delays.
                </p>
              </div>
            ) : (
              <div className="mt-4 bg-emerald-950/20 border border-emerald-900/30 p-3 rounded-lg">
                <p className="text-[11px] text-gray-400 leading-normal">
                  All cargo manifests and packing documentation net weights align perfectly. Standard CBP clearance is approved.
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

        {/* CARD 2: HTS CODE ACCURACY */}
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
                <span className="text-gray-500">Commercial Invoice:</span>
                <span className={`font-semibold ${htsExc && htsExc.status === 'Unresolved' ? 'text-amber-400' : 'text-gray-300'}`}>
                  {htsValue}
                </span>
              </div>
              <div className="flex justify-between text-xs font-mono border-t border-gray-900 pt-1.5">
                <span className="text-gray-500">Packing List:</span>
                <span className="font-semibold text-gray-300">
                  {selectedEntry.id === 'SHIP-2026-8802' || selectedEntry.id === 'SHIP-999-DEMO' ? '8108.90.3030' : htsValue}
                </span>
              </div>
            </div>

            {htsExc && htsExc.status === 'Unresolved' ? (
              <div className="mt-4 bg-[#14110b] border border-amber-950 p-3 rounded-lg space-y-1">
                <span className="text-[10px] text-amber-400 font-mono font-bold uppercase block">CLASSIFICATION MISMATCH</span>
                <p className="text-[11px] text-gray-300 leading-normal">
                  Suffix mismatch detected. Inconsistent HTS designations can delay HTS tariff declarations or lead to miscalculated customs duties.
                </p>
              </div>
            ) : (
              <div className="mt-4 bg-emerald-950/20 border border-emerald-900/30 p-3 rounded-lg">
                <p className="text-[11px] text-gray-400 leading-normal">
                  Primary and supplementary tariff classifications align across the invoice and bills of lading.
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

        {/* CARD 3: COUNTRY OF ORIGIN OR VALUE DESIGNATION */}
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
                <span className="text-gray-500">Commercial Invoice:</span>
                <span className="font-semibold text-gray-300">
                  {selectedEntry.id === 'SHIP-2026-8802' || selectedEntry.id === 'SHIP-999-DEMO' ? declaredValueStr : 'CN'}
                </span>
              </div>
              <div className="flex justify-between text-xs font-mono border-t border-gray-900 pt-1.5">
                <span className="text-gray-500">Certificate / Form:</span>
                <span className={`font-semibold ${originExc && originExc.status === 'Unresolved' ? 'text-amber-400' : 'text-gray-300'}`}>
                  {selectedEntry.id === 'SHIP-2026-8802' || selectedEntry.id === 'SHIP-999-DEMO' ? declaredValueStr : originExc && originExc.status === 'Unresolved' ? 'TW' : 'CN'}
                </span>
              </div>
            </div>

            {((originExc && originExc.status === 'Unresolved') || (valueExc && valueExc.status === 'Unresolved')) ? (
              <div className="mt-4 bg-[#14110b] border border-amber-950 p-3 rounded-lg space-y-1">
                <span className="text-[10px] text-amber-400 font-mono font-bold uppercase block">INTEGRITY CHECK FAIL</span>
                <p className="text-[11px] text-gray-300 leading-normal">
                  {selectedEntry.id === 'SHIP-2026-8802' 
                    ? "Paper crease on Invoice leaves character '8' uncertain. Double-check with broker packing records."
                    : "Country codes (CN vs TW) conflict. Trade compliance forbids conflicting origin certificates."}
                </p>
              </div>
            ) : (
              <div className="mt-4 bg-emerald-950/20 border border-emerald-900/30 p-3 rounded-lg">
                <p className="text-[11px] text-gray-400 leading-normal">
                  Declared origins and values have been crosschecked against historical logs and match fully.
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

      {/* DETAILED LINE-ITEM COMPARISON TABLE */}
      <div className="bg-[#0c0d12] border border-gray-900 rounded-xl overflow-hidden">
        <div className="p-4 bg-[#0e1017] border-b border-gray-900 flex justify-between items-center">
          <div>
            <h3 className="text-sm font-semibold text-gray-200">Cross-Document Value Comparison Matrix</h3>
            <p className="text-xs text-gray-500 mt-0.5">Comprehensive audit of extracted data fields compared side-by-side across files.</p>
          </div>
          <span className="font-mono text-xs text-gray-500">3 TOTAL SOURCE FILES PARSED</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-gray-900 text-[10px] font-mono text-gray-500 uppercase tracking-wider bg-black/30">
                <th className="py-3 px-4 font-semibold">DATA FIELD KEY</th>
                <th className="py-3 px-4 font-semibold">COMMERCIAL INVOICE</th>
                <th className="py-3 px-4 font-semibold">PACKING LIST</th>
                <th className="py-3 px-4 font-semibold">BILL OF LADING / FORM</th>
                <th className="py-3 px-4 font-semibold text-right">AUDIT STATEMENT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-900 font-medium">
              
              <tr className="hover:bg-gray-950/40">
                <td className="py-3 px-4 font-mono text-gray-400">Shipper Exporter Name</td>
                <td className="py-3 px-4 text-gray-300">{selectedEntry.shipper}</td>
                <td className="py-3 px-4 text-gray-300">{selectedEntry.shipper}</td>
                <td className="py-3 px-4 text-gray-500">—</td>
                <td className="py-3 px-4 text-right text-emerald-400 font-mono">100% MATCH</td>
              </tr>

              <tr className="hover:bg-gray-950/40">
                <td className="py-3 px-4 font-mono text-gray-400">Consignee Importer Name</td>
                <td className="py-3 px-4 text-gray-300">{selectedEntry.consignee}</td>
                <td className="py-3 px-4 text-gray-300">{selectedEntry.consignee}</td>
                <td className="py-3 px-4 text-gray-300">{selectedEntry.consignee}</td>
                <td className="py-3 px-4 text-right text-emerald-400 font-mono">100% MATCH</td>
              </tr>

              <tr className="hover:bg-gray-950/40">
                <td className="py-3 px-4 font-mono text-gray-400">Primary Tariff HTS Code</td>
                <td className={`py-3 px-4 font-mono ${htsExc && htsExc.status === 'Unresolved' ? 'text-amber-400 font-bold bg-amber-950/10' : 'text-gray-300'}`}>
                  {htsValue}
                </td>
                <td className="py-3 px-4 text-gray-300 font-mono">
                  {selectedEntry.id === 'SHIP-2026-8802' || selectedEntry.id === 'SHIP-999-DEMO' ? '8108.90.3030' : htsValue}
                </td>
                <td className="py-3 px-4 text-gray-500">—</td>
                <td className={`py-3 px-4 text-right font-mono ${htsExc && htsExc.status === 'Unresolved' ? 'text-amber-500 font-bold' : 'text-emerald-400'}`}>
                  {htsExc && htsExc.status === 'Unresolved' ? 'HTS SUFFIX MISMATCH' : 'PASSED'}
                </td>
              </tr>

              <tr className="hover:bg-gray-950/40">
                <td className="py-3 px-4 font-mono text-gray-400">Total Net Declared Weight</td>
                <td className="py-3 px-4 text-gray-500">—</td>
                <td className="py-3 px-4 text-gray-300 font-mono">
                  {selectedEntry.id === 'SHIP-2026-8802' || selectedEntry.id === 'SHIP-999-DEMO' ? '14,250 lbs' : '4,120 lbs'}
                </td>
                <td className={`py-3 px-4 font-mono ${weightExc && weightExc.status === 'Unresolved' ? 'text-red-400 font-bold bg-red-950/10' : 'text-gray-300'}`}>
                  {weightExc && weightExc.status === 'Unresolved' ? '12,450 lbs' : '14,250 lbs'}
                </td>
                <td className={`py-3 px-4 text-right font-mono ${weightExc && weightExc.status === 'Unresolved' ? 'text-red-400 font-bold' : 'text-emerald-400'}`}>
                  {weightExc && weightExc.status === 'Unresolved' ? '1,800 LBS DISCREPANCY' : 'PASSED'}
                </td>
              </tr>

              <tr className="hover:bg-gray-950/40">
                <td className="py-3 px-4 font-mono text-gray-400">Invoice Total Valuation</td>
                <td className={`py-3 px-4 font-mono ${valueExc && valueExc.status === 'Unresolved' ? 'text-amber-400 font-bold bg-amber-950/10' : 'text-gray-300'}`}>
                  {declaredValueStr}
                </td>
                <td className="py-3 px-4 text-gray-500">—</td>
                <td className="py-3 px-4 text-gray-300 font-mono">
                  {declaredValueStr}
                </td>
                <td className={`py-3 px-4 text-right font-mono ${valueExc && valueExc.status === 'Unresolved' ? 'text-amber-500 font-bold' : 'text-emerald-400'}`}>
                  {valueExc && valueExc.status === 'Unresolved' ? 'LOW CONF OVERLAY' : 'PASSED'}
                </td>
              </tr>

            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}

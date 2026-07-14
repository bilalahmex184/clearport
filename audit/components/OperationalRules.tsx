'use client';

import * as React from 'react';
import { useClearPort } from '../context/ClearPortContext';
import { Sliders, ShieldCheck, HelpCircle, Users, Link2, AlertCircle } from 'lucide-react';
import { motion } from 'motion/react';

export default function OperationalRules() {
  const { rules, updateRules } = useClearPort();

  const handleSliderChange = (category: 'invoiceThreshold' | 'htsThreshold' | 'partiesThreshold', value: number) => {
    updateRules({ [category]: value });
  };

  return (
    <div id="rules-root" className="space-y-6 overflow-y-auto max-h-[calc(100vh-120px)] pb-8 pr-2 font-sans">
      
      {/* Introduction */}
      <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5">
        <span className="font-mono text-xs text-amber-500 tracking-wider">SYSTEM CONFIGURATIONS</span>
        <h2 className="text-xl font-bold text-gray-100 tracking-tight mt-1">Operational Compliance Rules & Settings</h2>
        <p className="text-xs text-gray-400 mt-2 leading-relaxed">
          Configure the sensitivity threshold of {"ClearPort's"} neural parsing engine. High thresholds reduce compliance risks but increase human review times. Low thresholds expedite automation but pose audit vulnerabilities.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        
        {/* LEFT COLUMN: CRITICAL THRESHOLD SLIDERS (7 cols) */}
        <div className="lg:col-span-7 bg-[#0c0d12] border border-gray-900 rounded-xl p-5 space-y-5">
          <div className="pb-3 border-b border-gray-900">
            <h3 className="text-sm font-semibold text-gray-200">Neural Confidence Threshold Adjusters</h3>
            <p className="text-xs text-gray-500 mt-0.5">Control the margin of acceptable OCR confidence before triggering human exceptions.</p>
          </div>

          <div className="space-y-6">
            
            {/* Slider 1: Invoice totals */}
            <div className="space-y-2">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-gray-300">Invoice Totals & Valuation Threshold</span>
                <span className="font-mono font-bold text-amber-400 bg-amber-950/20 border border-amber-900/30 px-2 py-0.5 rounded">
                  {rules.invoiceThreshold}% CONFIDENCE
                </span>
              </div>
              <input
                type="range"
                min="50"
                max="95"
                step="5"
                value={rules.invoiceThreshold}
                onChange={(e) => handleSliderChange('invoiceThreshold', parseInt(e.target.value))}
                className="w-full accent-amber-500 cursor-pointer h-1.5 bg-gray-900 rounded-lg appearance-none"
              />
              <p className="text-[11px] text-gray-500 leading-normal">
                {rules.invoiceThreshold >= 80 
                  ? "Strict audit setting. High confidence required. Prevents any minor OCR fold crease from slipping past review."
                  : "Lenient setting. Increases auto-clear rates but risks overlooking minor OCR valuation character inaccuracies."}
              </p>
            </div>

            {/* Slider 2: HTS codes */}
            <div className="space-y-2 border-t border-gray-900/40 pt-4">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-gray-300">HTS Suffix Code Classifications Threshold</span>
                <span className="font-mono font-bold text-amber-400 bg-amber-950/20 border border-amber-900/30 px-2 py-0.5 rounded">
                  {rules.htsThreshold}% CONFIDENCE
                </span>
              </div>
              <input
                type="range"
                min="50"
                max="95"
                step="5"
                value={rules.htsThreshold}
                onChange={(e) => handleSliderChange('htsThreshold', parseInt(e.target.value))}
                className="w-full accent-amber-500 cursor-pointer h-1.5 bg-gray-900 rounded-lg appearance-none"
              />
              <p className="text-[11px] text-gray-500 leading-normal">
                {rules.htsThreshold >= 85 
                  ? "Audit-defense stance. Highly sensitive to suffix mismatches. Minimizes risks of tariff penalty actions."
                  : "Expedited stance. Minor variations in final digits will be auto-cleared, decreasing manual workload."}
              </p>
            </div>

            {/* Slider 3: Parties */}
            <div className="space-y-2 border-t border-gray-900/40 pt-4">
              <div className="flex justify-between items-center text-xs">
                <span className="font-semibold text-gray-300">Shipper & Consignee Parties Threshold</span>
                <span className="font-mono font-bold text-amber-400 bg-amber-950/20 border border-amber-900/30 px-2 py-0.5 rounded">
                  {rules.partiesThreshold}% CONFIDENCE
                </span>
              </div>
              <input
                type="range"
                min="50"
                max="95"
                step="5"
                value={rules.partiesThreshold}
                onChange={(e) => handleSliderChange('partiesThreshold', parseInt(e.target.value))}
                className="w-full accent-amber-500 cursor-pointer h-1.5 bg-gray-900 rounded-lg appearance-none"
              />
              <p className="text-[11px] text-gray-500 leading-normal">
                {rules.partiesThreshold >= 75 
                  ? "Secure watchlist matching. Prevents address abbreviation typos from escaping review."
                  : "Permissive watchlist setting. Auto-ignores common corporate suffix formatting variances (e.g. Inc vs LLC)."}
              </p>
            </div>

          </div>
        </div>

        {/* RIGHT COLUMN: TEAM ROLES & INTEGRATIONS (5 cols) */}
        <div className="lg:col-span-5 space-y-5">
          
          {/* TEAM MANAGEMENT */}
          <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-4 space-y-3.5">
            <div className="flex items-center gap-1.5 pb-2 border-b border-gray-900">
              <Users className="w-4 h-4 text-gray-500" />
              <span className="text-[10px] font-mono text-gray-400 uppercase tracking-widest font-bold">Team Role Authorizations</span>
            </div>

            <div className="space-y-2.5">
              <div className="flex justify-between items-center p-2.5 bg-black/60 rounded-lg border border-gray-950">
                <div>
                  <span className="text-xs font-semibold text-gray-300 block">syednasirbukhari033@gmail.com</span>
                  <span className="text-[10px] text-emerald-400 font-mono block mt-0.5 font-bold uppercase">System Admin</span>
                </div>
                <span className="text-[9px] font-mono text-gray-600 bg-gray-950 border border-gray-900 px-1.5 py-0.5 rounded">OWNER</span>
              </div>

              <div className="flex justify-between items-center p-2.5 bg-black/40 rounded-lg border border-gray-950/60">
                <div>
                  <span className="text-xs font-semibold text-gray-400 block">c.compliance@clearport.corp</span>
                  <span className="text-[10px] text-gray-500 font-mono block mt-0.5">Customs Compliance Specialist</span>
                </div>
                <span className="text-[9px] font-mono text-gray-500 bg-gray-950 border border-gray-900 px-1.5 py-0.5 rounded">REVIEWER</span>
              </div>
            </div>

            <div className="pt-2 border-t border-gray-900 text-right">
              <button
                onClick={() => alert('Feature limits:\nRole management is locked under company-wide secure Single Sign-On (SSO) settings.')}
                className="text-[11px] font-semibold text-gray-400 hover:text-white bg-gray-950 hover:bg-gray-900 border border-gray-850 px-3 py-1.5 rounded transition-all cursor-pointer uppercase tracking-wider"
              >
                Invite New Broker
              </button>
            </div>
          </div>

          {/* INTEGRATIONS STATUS PANEL */}
          <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-4 space-y-3.5">
            <div className="flex items-center gap-1.5 pb-2 border-b border-gray-900">
              <Link2 className="w-4 h-4 text-gray-500" />
              <span className="text-[10px] font-mono text-gray-400 uppercase tracking-widest font-bold">Broker System Integrations</span>
            </div>

            <div className="space-y-3 font-mono text-[11px]">
              
              {/* Integration 1 */}
              <div className="flex justify-between items-center py-1">
                <span className="text-gray-400 font-sans">CargoWise TMS Gateway:</span>
                <span className="text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-900/40 font-bold uppercase text-[9px]">
                  CONNECTED
                </span>
              </div>

              {/* Integration 2 */}
              <div className="flex justify-between items-center py-1 border-t border-gray-950">
                <span className="text-gray-400 font-sans">CBP Automated Broker Interface (ABI):</span>
                <span className="text-emerald-400 bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-900/40 font-bold uppercase text-[9px]">
                  ACTIVE / ONLINE
                </span>
              </div>

              {/* Integration 3 */}
              <div className="flex justify-between items-center py-1 border-t border-gray-950">
                <span className="text-gray-500 font-sans">Descartes Logistics Portal:</span>
                <span className="text-gray-500 bg-gray-950 px-2 py-0.5 rounded border border-gray-900 font-bold uppercase text-[9px]">
                  NOT CONNECTED
                </span>
              </div>

            </div>
          </div>

          {/* COMPLIANCE OFFICER DESIGNATION */}
          <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-4 space-y-2 text-xs">
            <span className="text-[10px] font-mono text-gray-500 uppercase tracking-widest block">ADMIN COMPLIANCE OFFICER</span>
            <span className="font-semibold text-gray-300 block">Syed Nasir Bukhari</span>
            <span className="text-gray-500 block">Lead Customs Compliance Director // CBP Agent ID #CBP-9940</span>
            <span className="text-[11px] text-gray-600 block mt-1.5 pt-1.5 border-t border-gray-900">
              Secure Hotline Support: <span className="text-gray-400">compliance@clearport.corp</span>
            </span>
          </div>

        </div>

      </div>

    </div>
  );
}

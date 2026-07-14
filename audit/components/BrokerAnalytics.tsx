'use client';

import * as React from 'react';
import { useClearPort } from '../context/ClearPortContext';
import { ShieldCheck, BarChart3, TrendingUp, AlertTriangle, Download, FileSpreadsheet, Sparkles, Award } from 'lucide-react';
import { motion } from 'motion/react';

export default function BrokerAnalytics() {
  const { entries, auditLogs } = useClearPort();

  // Dynamic CBP Audit Readiness score calculation
  const stats = React.useMemo(() => {
    let totalExceptions = 0;
    let resolvedExceptions = 0;

    for (const entry of entries) {
      totalExceptions += entry.exceptions.length;
      resolvedExceptions += entry.exceptions.filter(ex => ex.status !== 'Unresolved').length;
    }

    // Baseline CBP score is 80%, increases up to 100% as broker clears exceptions
    const resolvedPercentage = totalExceptions > 0 ? (resolvedExceptions / totalExceptions) : 1;
    const auditReadinessScore = Math.min(100, Math.round(80 + (resolvedPercentage * 20)));

    return {
      totalExceptions,
      resolvedExceptions,
      unresolvedExceptions: totalExceptions - resolvedExceptions,
      auditReadinessScore,
    };
  }, [entries]);

  // Handle mock report triggers
  const handleExportPDF = () => {
    alert('ClearPort System Message:\nPreparing official Customs Broker Report. PDF export generated and scheduled for download.');
  };

  const handleExportCSV = () => {
    alert('ClearPort System Message:\nPreparing compliance log database stream. CSV log download triggered.');
  };

  return (
    <div id="analytics-root" className="space-y-6 overflow-y-auto max-h-[calc(100vh-120px)] pb-8 pr-2 font-sans">
      
      {/* 1. TOP HEADER & MAIN CBP READINESS CIRCLE */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        
        {/* Left block (7 cols): Introduction and Charts */}
        <div className="lg:col-span-7 bg-[#0c0d12] border border-gray-900 rounded-xl p-5 flex flex-col justify-between">
          <div>
            <span className="font-mono text-xs text-emerald-400 tracking-wider">COMPLIANCE INTELLIGENCE</span>
            <h2 className="text-xl font-bold text-gray-100 tracking-tight mt-1">CBP Security & Operations Analytics</h2>
            <p className="text-xs text-gray-400 mt-2 leading-relaxed">
              Real-time modeling of Customs audit vulnerability. Resolve document mismatches to secure a perfect CBP filing score and maintain trusted trader status.
            </p>
          </div>

          {/* SVG Error trend over 6 weeks */}
          <div className="mt-6 space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="font-mono text-gray-500 uppercase">Weekly Exception Trends (Last 6 Weeks)</span>
              <span className="text-[10px] text-gray-400 font-mono bg-black px-2 py-0.5 rounded border border-gray-900">
                LATEST: {stats.unresolvedExceptions} ACTIVE ERRORS
              </span>
            </div>

            <div className="w-full bg-black/60 border border-gray-950 p-4 rounded-xl h-44 flex flex-col justify-between relative">
              {/* Simple beautiful SVG chart */}
              <div className="absolute inset-x-4 top-6 bottom-8">
                <svg className="w-full h-full" viewBox="0 0 500 100" preserveAspectRatio="none">
                  {/* Grid Lines */}
                  <line x1="0" y1="20" x2="500" y2="20" stroke="#0e1017" strokeWidth="1" strokeDasharray="4" />
                  <line x1="0" y1="50" x2="500" y2="50" stroke="#0e1017" strokeWidth="1" strokeDasharray="4" />
                  <line x1="0" y1="80" x2="500" y2="80" stroke="#0e1017" strokeWidth="1" strokeDasharray="4" />

                  {/* Polyline Path */}
                  {/* Map values from 15 -> 12 -> 18 -> 8 -> 5 -> active unresolved exceptions */}
                  <polyline
                    fill="none"
                    stroke="url(#chart-grad)"
                    strokeWidth="2.5"
                    points={`0,30 100,50 200,20 300,60 400,80 500,${100 - (stats.unresolvedExceptions * 15)}`}
                  />

                  {/* Gradient definition */}
                  <defs>
                    <linearGradient id="chart-grad" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#d97706" />
                      <stop offset="100%" stopColor="#10b981" />
                    </linearGradient>
                  </defs>

                  {/* Chart Dots */}
                  <circle cx="0" cy="30" r="4" fill="#d97706" />
                  <circle cx="100" cy="50" r="4" fill="#d97706" />
                  <circle cx="200" cy="20" r="4" fill="#b45309" />
                  <circle cx="300" cy="60" r="4" fill="#f59e0b" />
                  <circle cx="400" cy="80" r="4" fill="#10b981" />
                  <circle cx="500" cy={100 - (stats.unresolvedExceptions * 15)} r="5" fill="#34d399" />
                </svg>
              </div>

              {/* Chart Labels */}
              <div className="flex justify-between items-end text-[9px] font-mono text-gray-500 w-full pt-32">
                <span>WEEK 22</span>
                <span>WEEK 23</span>
                <span>WEEK 24</span>
                <span>WEEK 25</span>
                <span>WEEK 26</span>
                <span className="text-emerald-400 font-bold">CURRENT</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right block (5 cols): Prominent Audit Readiness Score Circle */}
        <div className="lg:col-span-5 bg-[#0c0d12] border border-gray-900 rounded-xl p-6 flex flex-col justify-between items-center text-center">
          <div className="w-full text-left">
            <span className="font-mono text-xs text-gray-500 tracking-wider">REGULATORY SECURE RATING</span>
            <h3 className="text-sm font-semibold text-gray-200 mt-0.5">CBP Audit Readiness Index</h3>
          </div>

          <div className="my-6 relative flex items-center justify-center">
            {/* Circular progress bar SVG */}
            <svg className="w-40 h-40 transform -rotate-90">
              <circle
                cx="80"
                cy="80"
                r="64"
                className="stroke-gray-900"
                strokeWidth="10"
                fill="transparent"
              />
              <circle
                cx="80"
                cy="80"
                r="64"
                className="stroke-emerald-500"
                strokeWidth="10"
                fill="transparent"
                strokeDasharray={402}
                strokeDashoffset={402 - (402 * stats.auditReadinessScore) / 100}
                strokeLinecap="round"
                style={{ transition: 'stroke-dashoffset 0.5s ease-out' }}
              />
            </svg>
            <div className="absolute flex flex-col items-center">
              <span className="text-3xl font-mono font-extrabold text-white tracking-tight">
                {stats.auditReadinessScore}%
              </span>
              <span className="text-[9px] font-mono text-emerald-400 font-bold tracking-widest mt-1">
                SECURE / HIGH
              </span>
            </div>
          </div>

          <p className="text-[11px] text-gray-500 max-w-xs leading-normal">
            Your score updates automatically as exceptions are resolved. Perfect filings are designated as <span className="text-emerald-400 font-bold">Low CBP Risk Priority</span>.
          </p>

          <div className="grid grid-cols-2 gap-3 w-full border-t border-gray-900 pt-4 mt-4">
            <button
              onClick={handleExportPDF}
              className="flex items-center justify-center gap-1 text-[11px] bg-gray-950 hover:bg-gray-900 text-gray-300 hover:text-white border border-gray-850 py-2 rounded-lg cursor-pointer transition-all font-bold uppercase tracking-wider"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export PDF Report</span>
            </button>
            <button
              onClick={handleExportCSV}
              className="flex items-center justify-center gap-1 text-[11px] bg-gray-950 hover:bg-gray-900 text-gray-300 hover:text-white border border-gray-850 py-2 rounded-lg cursor-pointer transition-all font-bold uppercase tracking-wider"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>Export CSV Logs</span>
            </button>
          </div>
        </div>

      </div>

      {/* 2. EXCEPTION CATEGORY BREAKDOWN & COMPLIANCE CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        
        {/* Exception category horizontal bars */}
        <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5">
          <div className="pb-3 border-b border-gray-900 mb-4">
            <span className="font-mono text-[10px] text-gray-500 tracking-wider">ERROR MODES ANALYSIS</span>
            <h3 className="text-sm font-semibold text-gray-200 mt-0.5">Discrepancies by Customs Category</h3>
          </div>

          <div className="space-y-4">
            {/* Category 1 */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-medium">
                <span className="text-gray-300">HTS Suffix Code Misclassifications</span>
                <span className="text-gray-400 font-mono">45%</span>
              </div>
              <div className="w-full bg-gray-950 rounded-full h-2 overflow-hidden border border-gray-900">
                <div className="bg-amber-500 h-2 rounded-full" style={{ width: '45%' }}></div>
              </div>
            </div>

            {/* Category 2 */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-medium">
                <span className="text-gray-300">Invoice Valuation & Totals Conflicting</span>
                <span className="text-gray-400 font-mono">25%</span>
              </div>
              <div className="w-full bg-gray-950 rounded-full h-2 overflow-hidden border border-gray-900">
                <div className="bg-amber-600 h-2 rounded-full" style={{ width: '25%' }}></div>
              </div>
            </div>

            {/* Category 3 */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-medium">
                <span className="text-gray-300">Entity Corporate Names / Addresses Mismatch</span>
                <span className="text-gray-400 font-mono">20%</span>
              </div>
              <div className="w-full bg-gray-950 rounded-full h-2 overflow-hidden border border-gray-900">
                <div className="bg-orange-600 h-2 rounded-full" style={{ width: '20%' }}></div>
              </div>
            </div>

            {/* Category 4 */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-medium">
                <span className="text-gray-300">Missing Mandatory Shipping Certificates</span>
                <span className="text-gray-400 font-mono">10%</span>
              </div>
              <div className="w-full bg-gray-950 rounded-full h-2 overflow-hidden border border-gray-900">
                <div className="bg-red-500 h-2 rounded-full" style={{ width: '10%' }}></div>
              </div>
            </div>

          </div>
        </div>

        {/* MESSY VS SAFEST SHIPPER CARDS */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          
          {/* Card: Safest Shipper */}
          <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-1.5 pb-2 border-b border-gray-900">
                <Award className="w-4 h-4 text-emerald-400" />
                <span className="text-[10px] font-mono text-emerald-400 font-bold uppercase tracking-wider">SAFEST CLIENT DESIGNATION</span>
              </div>
              <h4 className="text-sm font-bold text-gray-100 tracking-tight mt-3">Precision Die-Cast GMBH</h4>
              <p className="text-[10px] font-mono text-gray-500 mt-1">Germany • High-speed manufacturing</p>
              
              <div className="bg-black p-3.5 rounded-lg border border-gray-950 mt-4 text-xs font-mono">
                <div className="flex justify-between">
                  <span className="text-gray-500">Avg exceptions/entry:</span>
                  <span className="text-emerald-400 font-extrabold">0.12</span>
                </div>
                <div className="flex justify-between border-t border-gray-950 pt-1.5 mt-1.5">
                  <span className="text-gray-500">Auto-clear rate:</span>
                  <span className="text-emerald-400 font-extrabold">98.5%</span>
                </div>
              </div>
            </div>
            
            <p className="text-[10px] text-gray-600 mt-4 italic">
              Digital EDI integrations ensure near-perfect formatting consistency.
            </p>
          </div>

          {/* Card: Messiest Shipper */}
          <div className="bg-[#0c0d12] border border-gray-900 rounded-xl p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-1.5 pb-2 border-b border-gray-900">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                <span className="text-[10px] font-mono text-amber-500 font-bold uppercase tracking-wider">HIGHEST REWORK CLIENT</span>
              </div>
              <h4 className="text-sm font-bold text-gray-100 tracking-tight mt-3">AeroParts Global Inc.</h4>
              <p className="text-[10px] font-mono text-gray-500 mt-1">Japan • Aerospace logistics</p>
              
              <div className="bg-black p-3.5 rounded-lg border border-gray-950 mt-4 text-xs font-mono">
                <div className="flex justify-between">
                  <span className="text-gray-500">Avg exceptions/entry:</span>
                  <span className="text-amber-500 font-extrabold">4.20</span>
                </div>
                <div className="flex justify-between border-t border-gray-950 pt-1.5 mt-1.5">
                  <span className="text-gray-500">Auto-clear rate:</span>
                  <span className="text-amber-500 font-extrabold">42.1%</span>
                </div>
              </div>
            </div>

            <p className="text-[10px] text-gray-600 mt-4 italic">
              Heavy reliance on paper scans results in high OCR errors.
            </p>
          </div>

        </div>

      </div>

    </div>
  );
}

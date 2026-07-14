'use client';

import * as React from 'react';
import { useClearPort } from '@/context/ClearPortContext';
import {
  Database, CheckCircle2, AlertTriangle, RefreshCw, Terminal, Copy, Check, Server, ExternalLink, Lock,
} from 'lucide-react';

interface SupabaseSyncPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SupabaseSyncPanel({ isOpen, onClose }: SupabaseSyncPanelProps) {
  const { entries, supabaseStatus, edgeFunctionStatus, refreshData, auditLogs, theme } = useClearPort();
  const [copiedSQL, setCopiedSQL] = React.useState(false);
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  if (!isOpen) return null;

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshData();
    } finally {
      setTimeout(() => setIsRefreshing(false), 600);
    }
  };

  const sqlScript = `-- ClearPort Production Schema
-- Run in Supabase SQL Editor

-- Tables: shipments, documents, document_fields, exceptions,
-- operational_rules, audit_logs
-- All with RLS using auth.uid()
-- Storage bucket: documents (private, scoped by user_id path)

-- See full schema: supabase/schema.sql`;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(sqlScript);
    setCopiedSQL(true);
    setTimeout(() => setCopiedSQL(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className={`w-full max-w-3xl rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[90vh] transition-colors duration-200 ${
        theme === 'light' ? 'bg-white border-gray-200 text-gray-800' : 'bg-[#0b0c11] border-gray-900 text-gray-200'
      }`}>
        {/* Header */}
        <div className={`p-5 border-b flex items-center justify-between ${
          theme === 'light' ? 'bg-gray-50 border-gray-100' : 'bg-[#0f1118] border-gray-900'
        }`}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-500 border border-emerald-500/20">
              <Database className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h2 className={`text-base font-bold tracking-tight ${theme === 'light' ? 'text-gray-900' : 'text-white'}`}>
                Supabase Integration Console
              </h2>
              <p className="text-xs text-gray-500 font-mono">REAL-TIME PERSISTENCE & SCHEMAS</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className={`w-8 h-8 rounded-lg flex items-center justify-center font-mono text-sm border hover:bg-gray-500/10 cursor-pointer ${
              theme === 'light' ? 'border-gray-200 text-gray-600' : 'border-gray-900 text-gray-400'
            }`}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Status Banner */}
          {supabaseStatus === 'connected' && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h4 className="text-xs font-bold text-emerald-500 uppercase font-mono">Connection Active</h4>
                <p className="text-xs text-emerald-600/95 leading-relaxed">
                  ClearPort is synchronized with your Supabase instance. Shipment entries, operational thresholds, and audit logs persist to PostgreSQL with Row-Level Security.
                </p>
              </div>
            </div>
          )}

          {supabaseStatus === 'unconfigured' && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h4 className="text-xs font-bold text-amber-500 uppercase font-mono">Credentials Pending</h4>
                <p className="text-xs text-amber-600/95 leading-relaxed">
                  Supabase environment variables are not present. Running in local fallback mode. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to connect.
                </p>
              </div>
            </div>
          )}

          {supabaseStatus === 'error_tables' && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h4 className="text-xs font-bold text-red-500 uppercase font-mono">Schema Missing</h4>
                <p className="text-xs text-red-500/90 leading-relaxed">
                  Supabase credentials matched, but the query failed. Run the SQL migration script in your Supabase SQL Editor to create the required tables.
                </p>
              </div>
            </div>
          )}

          {/* Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className={`p-4 rounded-lg border ${
              theme === 'light' ? 'bg-gray-50/50 border-gray-200' : 'bg-[#0d0e14]/60 border-gray-900/60'
            }`}>
              <div className="flex items-center gap-2 text-xs text-gray-500 font-mono mb-1">
                <Server className="w-3.5 h-3.5" />
                <span>SYNC STATUS</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${
                  supabaseStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
                  supabaseStatus === 'loading' ? 'bg-amber-500 animate-pulse' :
                  'bg-red-500'
                }`}></span>
                <span className="text-xs font-bold uppercase font-mono tracking-tight">
                  {supabaseStatus === 'connected' ? 'Connected' :
                   supabaseStatus === 'loading' ? 'Connecting...' :
                   supabaseStatus === 'unconfigured' ? 'Offline' : 'Schema Error'}
                </span>
              </div>
            </div>

            <div className={`p-4 rounded-lg border ${
              theme === 'light' ? 'bg-gray-50/50 border-gray-200' : 'bg-[#0d0e14]/60 border-gray-900/60'
            }`}>
              <div className="flex items-center gap-2 text-xs text-gray-500 font-mono mb-1">
                <Database className="w-3.5 h-3.5" />
                <span>SYNCED SHIPMENTS</span>
              </div>
              <div className="text-sm font-extrabold font-mono">{entries.length} Records</div>
            </div>

            <div className={`p-4 rounded-lg border ${
              theme === 'light' ? 'bg-gray-50/50 border-gray-200' : 'bg-[#0d0e14]/60 border-gray-900/60'
            }`}>
              <div className="flex items-center gap-2 text-xs text-gray-500 font-mono mb-1">
                <Lock className="w-3.5 h-3.5" />
                <span>EDGE FUNCTIONS</span>
              </div>
              <div className={`text-xs font-bold font-mono ${
                edgeFunctionStatus === 'live' ? 'text-emerald-400' : 'text-amber-400'
              }`}>
                {edgeFunctionStatus === 'live' ? 'LIVE (11 DEPLOYED)' : 'FALLBACK MODE'}
              </div>
            </div>
          </div>

          {/* Edge Function Status */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider font-mono flex items-center gap-2">
              <Terminal className="w-4 h-4 text-amber-500" />
              <span>Edge Function Pipeline Status</span>
            </h4>
            <div className={`border rounded-lg p-4 space-y-2 font-mono text-[11px] ${
              theme === 'light' ? 'bg-gray-50/50 border-gray-200' : 'bg-black/10 border-gray-900'
            }`}>
              {[
                { name: 'upload-document', desc: 'Secure file upload to Storage' },
                { name: 'extract-document', desc: 'Gemini first-pass OCR extraction' },
                { name: 'cross-validate', desc: 'Gemini cross-document validation' },
                { name: 'schema-validate', desc: 'JSON schema field validation' },
                { name: 'math-validate', desc: 'Math/cross-field validation' },
                { name: 'flag-exceptions', desc: 'Confidence threshold flagging' },
                { name: 'get-shipments', desc: 'Fetch hydrated shipment data' },
                { name: 'update-exception', desc: 'Resolve single exception' },
                { name: 'batch-accept', desc: 'Batch-accept high-confidence' },
                { name: 'export-csv', desc: 'CSV export with RFC-4180 escaping' },
                { name: 'get-document-url', desc: 'Signed URL generation' },
              ].map(fn => (
                <div key={fn.name} className="flex items-center justify-between border-b last:border-0 pb-1.5 last:pb-0 border-gray-900/30">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      edgeFunctionStatus === 'live' ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}></span>
                    <span className="text-gray-400">{fn.name}</span>
                    <span className="text-gray-600">— {fn.desc}</span>
                  </div>
                  <span className={edgeFunctionStatus === 'live' ? 'text-emerald-400' : 'text-amber-400'}>
                    {edgeFunctionStatus === 'live' ? 'DEPLOYED' : 'PENDING'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Env Configuration */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider font-mono flex items-center gap-2">
              <Server className="w-4 h-4 text-emerald-500" />
              <span>Environment Configuration</span>
            </h4>
            <div className={`border rounded-lg p-4 space-y-3 font-mono text-[11px] ${
              theme === 'light' ? 'bg-gray-50/50 border-gray-200' : 'bg-black/10 border-gray-900'
            }`}>
              <div className="flex items-center justify-between border-b pb-2 border-gray-900/30">
                <span className="text-gray-500">NEXT_PUBLIC_SUPABASE_URL</span>
                <span className={process.env.NEXT_PUBLIC_SUPABASE_URL ? 'text-emerald-500 font-bold' : 'text-amber-500 font-bold'}>
                  {process.env.NEXT_PUBLIC_SUPABASE_URL ? '✓ CONFIGURED' : '✗ MISSING'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-500">NEXT_PUBLIC_SUPABASE_ANON_KEY</span>
                <span className={process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? 'text-emerald-500 font-bold' : 'text-amber-500 font-bold'}>
                  {process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? '✓ CONFIGURED' : '✗ MISSING'}
                </span>
              </div>
            </div>
          </div>

          {/* SQL Migration Hint */}
          {supabaseStatus === 'error_tables' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-amber-500" />
                  <span className="text-xs font-bold uppercase tracking-wider font-mono">SQL Migration Script</span>
                </div>
                <button
                  onClick={copyToClipboard}
                  className={`flex items-center gap-1 text-[11px] font-mono border px-2.5 py-1 rounded transition-all cursor-pointer ${
                    copiedSQL ? 'text-emerald-500 border-emerald-500/30' : 'text-gray-500 border-gray-700'
                  }`}
                >
                  {copiedSQL ? <><Check className="w-3 h-3" /> <span>Copied!</span></> : <><Copy className="w-3 h-3" /> <span>Copy SQL</span></>}
                </button>
              </div>
              <div className={`p-4 rounded-lg font-mono text-[11px] leading-relaxed overflow-x-auto border max-h-48 overflow-y-auto ${
                theme === 'light' ? 'bg-gray-50 border-gray-200 text-gray-700' : 'bg-black/40 border-gray-900 text-gray-400'
              }`}>
                <pre>{sqlScript}</pre>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-gray-500 font-mono">
                <span>Open your</span>
                <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer" className="text-amber-500 hover:underline flex items-center gap-0.5">
                  Supabase Dashboard <ExternalLink className="w-2.5 h-2.5" />
                </a>
                <span>→ SQL Editor → Paste script → Run</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`p-4 border-t flex items-center justify-between ${
          theme === 'light' ? 'bg-gray-50 border-gray-100' : 'bg-[#0f1118] border-gray-900'
        }`}>
          <div className="text-[10px] text-gray-500 font-mono">ClearPort Sync Services v5.0</div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={supabaseStatus !== 'connected' && supabaseStatus !== 'error_tables'}
              className={`flex items-center gap-1.5 text-xs font-bold border px-3.5 py-1.5 rounded-lg transition-all cursor-pointer ${
                supabaseStatus === 'connected' || supabaseStatus === 'error_tables'
                  ? 'border-gray-700 hover:bg-gray-800 text-gray-300'
                  : 'opacity-50 cursor-not-allowed text-gray-600'
              }`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-emerald-500' : ''}`} />
              <span>{isRefreshing ? 'Refreshing...' : 'Verify & Fetch'}</span>
            </button>
            <button
              onClick={onClose}
              className="bg-amber-500 hover:bg-amber-600 text-black text-xs font-bold px-4 py-1.5 rounded-lg transition-all cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import * as React from 'react';
import { ClearPortProvider, useClearPort } from '@/context/ClearPortContext';
import Dashboard from '@/components/Dashboard';
import IngestUpload from '@/components/IngestUpload';
import ExceptionDesk from '@/components/ExceptionDesk';
import CrossDocAuditor from '@/components/CrossDocAuditor';
import BrokerAnalytics from '@/components/BrokerAnalytics';
import OperationalRules from '@/components/OperationalRules';
import EntryDetailView from '@/components/EntryDetailView';
import { 
  Shield, 
  Terminal, 
  Cpu, 
  CheckCircle, 
  AlertTriangle, 
  Settings2, 
  LayoutDashboard, 
  UploadCloud, 
  FileWarning, 
  SearchCode, 
  TrendingUp, 
  History,
  FileSpreadsheet,
  Database
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import SupabaseSyncPanel from '@/components/SupabaseSyncPanel';

// Shell container to handle state
function AppShell() {
  const { activeTab, setActiveTab, entries, theme, supabaseStatus } = useClearPort();
  const [isSupabaseOpen, setIsSupabaseOpen] = React.useState(false);

  // Dynamic notification badges
  const activeExceptionsCount = React.useMemo(() => {
    return entries.reduce((acc, curr) => {
      return acc + curr.exceptions.filter(e => e.status === 'Unresolved').length;
    }, 0);
  }, [entries]);

  const hasWeightDiscrepancy = React.useMemo(() => {
    return entries.some((ent) => 
      ent.exceptions.some((ex) => ex.fieldKey === 'netWeight' && ex.status === 'Unresolved')
    );
  }, [entries]);

  // Sidebar link items
  const menuItems = [
    { id: 'dashboard', label: 'Command Center', icon: LayoutDashboard },
    { id: 'ingest', label: 'Ingest Desk', icon: UploadCloud },
    { 
      id: 'exception-desk', 
      label: 'Exception Desk', 
      icon: FileWarning, 
      badge: activeExceptionsCount > 0 ? activeExceptionsCount : undefined 
    },
    { 
      id: 'cross-doc', 
      label: 'Cross-Doc Auditor', 
      icon: SearchCode, 
      badgeDot: hasWeightDiscrepancy 
    },
    { id: 'analytics', label: 'Broker Analytics', icon: TrendingUp },
    { id: 'entry-detail', label: 'Entry Detail View', icon: History },
    { id: 'rules', label: 'Operational Rules', icon: Settings2 },
  ];

  const renderActiveView = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard />;
      case 'ingest':
        return <IngestUpload />;
      case 'exception-desk':
        return <ExceptionDesk />;
      case 'cross-doc':
        return <CrossDocAuditor />;
      case 'analytics':
        return <BrokerAnalytics />;
      case 'rules':
        return <OperationalRules />;
      case 'entry-detail':
        return <EntryDetailView />;
      default:
        return <ExceptionDesk />;
    }
  };

  const getViewTitle = () => {
    const item = menuItems.find(m => m.id === activeTab);
    return item ? item.label : 'ClearPort';
  };

  return (
    <div 
      id="clearport-shell" 
      className={`min-h-screen font-sans flex overflow-hidden transition-colors duration-200 ${
        theme === 'light' 
          ? 'bg-[#f4f5f7] text-gray-800' 
          : 'bg-[#06070a] text-gray-200'
      }`}
    >
      
      {/* 1. LEFT NAVIGATION RIAL / SIDEBAR */}
      <aside 
        className={`w-64 flex flex-col justify-between shrink-0 select-none z-20 transition-colors duration-200 ${
          theme === 'light' 
            ? 'bg-white border-r border-gray-200 text-gray-800' 
            : 'bg-[#0a0b10] border-r border-gray-900 text-gray-200'
        }`}
      >
        
        {/* Top brand header */}
        <div>
          <div className={`p-5 border-b flex items-center gap-2 transition-colors duration-200 ${
            theme === 'light' ? 'bg-gray-50/50 border-gray-200' : 'bg-[#0d0e14] border-gray-900'
          }`}>
            <div className="w-7 h-7 bg-amber-500 rounded-lg flex items-center justify-center font-bold text-black text-sm tracking-tighter">
              CP
            </div>
            <div>
              <h1 className={`text-sm font-bold tracking-tight uppercase ${theme === 'light' ? 'text-gray-900' : 'text-white'}`}>ClearPort</h1>
              <span className={`font-mono text-[9px] block leading-none mt-1 ${theme === 'light' ? 'text-gray-400' : 'text-gray-550'}`}>v4.1.2 // ENTERPRISE</span>
            </div>
          </div>

          {/* Navigation Items list */}
          <nav className="p-3 space-y-1 mt-4">
            {menuItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition-all group cursor-pointer ${
                    isActive 
                      ? theme === 'light' ? 'bg-gray-200 text-gray-900 shadow-sm' : 'bg-gray-900 text-white shadow-sm' 
                      : theme === 'light' ? 'text-gray-500 hover:text-gray-900 hover:bg-gray-100/70' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-950/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className={`w-4 h-4 transition-all ${isActive ? 'text-amber-500' : 'text-gray-650 group-hover:text-gray-400'}`} />
                    <span>{item.label}</span>
                  </div>
                  
                  {item.badge && (
                    <span className="font-mono text-[10px] font-bold bg-amber-950 text-amber-400 border border-amber-900/40 px-1.5 py-0.5 rounded leading-none shrink-0">
                      {item.badge}
                    </span>
                  )}

                  {item.badgeDot && (
                    <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-ping shrink-0 mr-1" />
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom system credentials */}
        <div className={`p-4 border-t space-y-3 transition-colors duration-200 ${
          theme === 'light' ? 'bg-gray-50/50 border-gray-200' : 'bg-[#08090d] border-gray-900'
        }`}>
          <div className="flex items-center gap-2.5">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-mono font-bold ${
              theme === 'light' ? 'bg-gray-200 text-gray-650' : 'bg-gray-900 text-gray-550'
            }`}>
              SN
            </div>
            <div className="overflow-hidden">
              <span className={`text-[11px] font-bold block truncate ${theme === 'light' ? 'text-gray-750' : 'text-gray-300'}`}>syednasirbukhari033</span>
              <span className="text-[9px] text-gray-500 font-mono block leading-none mt-0.5">Customs Broker</span>
            </div>
          </div>

          <div className={`flex items-center justify-between text-[10px] font-mono border-t pt-2 ${
            theme === 'light' ? 'border-gray-200 text-gray-500' : 'border-gray-900/60 text-gray-550'
          }`}>
            <div className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
              <span>CBP ABI STATE</span>
            </div>
            <span className="text-emerald-500 font-bold uppercase">ONLINE</span>
          </div>
        </div>

      </aside>

      {/* 2. MAIN HUB WORKSPACE CONTENT */}
      <main className="flex-1 flex flex-col overflow-hidden relative">
        
        {/* Top Global Status Header bar */}
        <header className={`h-14 backdrop-blur border-b px-6 flex items-center justify-between shrink-0 select-none z-10 transition-colors duration-200 ${
          theme === 'light' 
            ? 'bg-white/80 border-gray-200' 
            : 'bg-[#0a0b10]/60 border-gray-900'
        }`}>
          <div className="flex items-center gap-2 font-mono text-xs text-gray-500 uppercase tracking-widest">
            <Cpu className="w-4 h-4 text-gray-650" />
            <span>CORE NODE: SECURE SUITE</span>
            <span className="text-gray-700">/</span>
            <span className={`${theme === 'light' ? 'text-gray-750 font-bold' : 'text-gray-400 font-bold'}`}>{getViewTitle()}</span>
          </div>

          <div className="flex items-center gap-4">
            {/* Supabase connection status pill */}
            <button
              onClick={() => setIsSupabaseOpen(true)}
              className={`border px-2.5 py-1 rounded-md flex items-center gap-1.5 font-mono text-[10px] transition-all cursor-pointer hover:scale-[1.02] active:scale-[0.98] ${
                supabaseStatus === 'connected'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : supabaseStatus === 'loading'
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 animate-pulse'
                  : supabaseStatus === 'error_tables'
                  ? 'bg-red-500/10 border-red-500/30 text-red-400'
                  : 'bg-gray-500/5 border-gray-900 text-gray-500'
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              <span className="font-extrabold uppercase">
                SUPABASE: {
                  supabaseStatus === 'connected' ? 'LIVE SYNC' :
                  supabaseStatus === 'loading' ? 'CONNECTING...' :
                  supabaseStatus === 'error_tables' ? 'TABLES MISSING' : 'OFFLINE FALLBACK'
                }
              </span>
            </button>

            {/* Timestamp */}
            <div className="hidden md:flex items-center gap-1.5 font-mono text-[10px] text-gray-500 uppercase">
              <span>LOCAL_TIME:</span>
              <span className={`font-bold ${theme === 'light' ? 'text-gray-750' : 'text-gray-300'}`}>2026-07-10 02:24 UTC</span>
            </div>
            
            {/* CBP connection health */}
            <div className={`border px-3 py-1 rounded-md flex items-center gap-1.5 font-mono text-[10px] text-emerald-600 transition-colors duration-200 ${
              theme === 'light' ? 'bg-emerald-50/50 border-emerald-200 text-emerald-700' : 'bg-black/40 border-gray-900 text-emerald-400'
            }`}>
              <Shield className="w-3.5 h-3.5 text-emerald-500" />
              <span className="font-extrabold uppercase">CBP SAFE ENCRYPTION STATUS // ACTIVE</span>
            </div>
          </div>
        </header>

        {/* Interactive View Panel with Page Transition Animations */}
        <div className="flex-1 p-6 overflow-hidden relative">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.15 }}
              className="w-full h-full"
            >
              {renderActiveView()}
            </motion.div>
          </AnimatePresence>
        </div>

      </main>

      {/* Supabase Settings Panel Overlay */}
      <SupabaseSyncPanel isOpen={isSupabaseOpen} onClose={() => setIsSupabaseOpen(false)} />

    </div>
  );
}

export default function MasterPage() {
  const [mounted, setMounted] = React.useState(false);
  
  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return (
    <ClearPortProvider>
      <AppShell />
    </ClearPortProvider>
  );
}

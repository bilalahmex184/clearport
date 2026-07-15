'use client';

import * as React from 'react';
import Link from 'next/link';
import { ClearPortProvider, useClearPort } from '@/context/ClearPortContext';
import Dashboard from '@/components/clearport/Dashboard';
import IngestUpload from '@/components/clearport/IngestUpload';
import ExceptionDesk from '@/components/clearport/ExceptionDesk';
import CrossDocAuditor from '@/components/clearport/CrossDocAuditor';
import BrokerAnalytics from '@/components/clearport/BrokerAnalytics';
import OperationalRules from '@/components/clearport/OperationalRules';
import EntryDetailView from '@/components/clearport/EntryDetailView';
import BrokerTemplates from '@/components/clearport/BrokerTemplates';
import SupabaseSyncPanel from '@/components/clearport/SupabaseSyncPanel';
import {
  Shield,
  Cpu,
  Database,
  LayoutDashboard,
  UploadCloud,
  FileWarning,
  SearchCode,
  TrendingUp,
  History,
  Settings2,
  FileSpreadsheet,
  Menu,
  X,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

function AppShell() {
  const {
    activeTab,
    setActiveTab,
    entries,
    theme,
    supabaseStatus,
    edgeFunctionStatus,
    currentUser,
    currentTime,
    userOrgs,
    currentOrgId,
    switchOrg,
  } = useClearPort();
  const [isSupabaseOpen, setIsSupabaseOpen] = React.useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = React.useState(false);
  const [isOrgMenuOpen, setIsOrgMenuOpen] = React.useState(false);
  const orgMenuRef = React.useRef<HTMLDivElement | null>(null);

  // Close the org-switcher dropdown on outside click.
  React.useEffect(() => {
    if (!isOrgMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (orgMenuRef.current && !orgMenuRef.current.contains(e.target as Node)) {
        setIsOrgMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOrgMenuOpen]);

  // Current org display name (falls back to a placeholder before the first
  // org list load completes).
  const currentOrgName = React.useMemo(
    () => userOrgs.find((o) => o.org_id === currentOrgId)?.org_name ?? 'Personal',
    [userOrgs, currentOrgId],
  );

  // Dynamic notification badges
  const activeExceptionsCount = React.useMemo(() => {
    return entries.reduce((acc, curr) => {
      return acc + curr.exceptions.filter(e => e.status === 'Unresolved').length;
    }, 0);
  }, [entries]);

  const hasWeightDiscrepancy = React.useMemo(() => {
    return entries.some(ent =>
      ent.exceptions.some(ex => ex.fieldKey === 'netWeight' && ex.status === 'Unresolved')
    );
  }, [entries]);

  const menuItems = [
    { id: 'dashboard', label: 'Command Center', icon: LayoutDashboard },
    { id: 'ingest', label: 'Ingest Desk', icon: UploadCloud },
    {
      id: 'exception-desk',
      label: 'Exception Desk',
      icon: FileWarning,
      badge: activeExceptionsCount > 0 ? activeExceptionsCount : undefined,
    },
    {
      id: 'cross-doc',
      label: 'Cross-Doc Auditor',
      icon: SearchCode,
      badgeDot: hasWeightDiscrepancy,
    },
    { id: 'analytics', label: 'Broker Analytics', icon: TrendingUp },
    { id: 'entry-detail', label: 'Entry Detail View', icon: History },
    { id: 'rules', label: 'Operational Rules', icon: Settings2 },
    { id: 'broker-templates', label: 'Broker Templates', icon: FileSpreadsheet },
  ];

  const renderActiveView = () => {
    switch (activeTab) {
      case 'dashboard': return <Dashboard />;
      case 'ingest': return <IngestUpload />;
      case 'exception-desk': return <ExceptionDesk />;
      case 'cross-doc': return <CrossDocAuditor />;
      case 'analytics': return <BrokerAnalytics />;
      case 'rules': return <OperationalRules />;
      case 'entry-detail': return <EntryDetailView />;
      case 'broker-templates': return <BrokerTemplates />;
      default: return <ExceptionDesk />;
    }
  };

  const getViewTitle = () => {
    const item = menuItems.find(m => m.id === activeTab);
    return item ? item.label : 'ClearPort';
  };

  // Shorten user display
  const userDisplay = currentUser.includes('@')
    ? currentUser.split('@')[0]
    : currentUser;
  const userInitials = userDisplay.slice(0, 2).toUpperCase();

  const sidebarContent = (
    <>
      {/* Top brand header */}
      <div>
        <div className={`p-5 border-b flex items-center gap-2 transition-colors duration-200 ${
          theme === 'light' ? 'bg-gray-50 border-gray-200' : 'bg-[#0d0e14] border-gray-900'
        }`}>
          <div className="w-7 h-7 bg-amber-500 rounded-lg flex items-center justify-center font-bold text-black text-sm tracking-tighter">
            CP
          </div>
          <div>
            <h1 className={`text-sm font-bold tracking-tight uppercase ${
              theme === 'light' ? 'text-gray-900' : 'text-white'
            }`}>ClearPort</h1>
            <span className={`font-mono text-[9px] block leading-none mt-1 ${
              theme === 'light' ? 'text-gray-400' : 'text-gray-500'
            }`}>v5.0 // PRODUCTION</span>
          </div>
        </div>

        {/* Navigation Items list */}
        <nav className="p-3 space-y-1 mt-4">
          {menuItems.map(item => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id);
                  setIsMobileSidebarOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition-all group cursor-pointer ${
                  isActive
                    ? theme === 'light'
                      ? 'bg-gray-200 text-gray-900 shadow-sm'
                      : 'bg-gray-900 text-white shadow-sm'
                    : theme === 'light'
                      ? 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
                      : 'text-gray-500 hover:text-gray-300 hover:bg-gray-950/60'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className={`w-4 h-4 transition-all ${
                    isActive ? 'text-amber-500' : 'text-gray-500 group-hover:text-gray-400'
                  }`} />
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
        theme === 'light' ? 'bg-gray-50 border-gray-200' : 'bg-[#08090d] border-gray-900'
      }`}>
        <div className="flex items-center gap-2.5">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-mono font-bold ${
            theme === 'light' ? 'bg-gray-200 text-gray-600' : 'bg-gray-900 text-gray-400'
          }`}>
            {userInitials}
          </div>
          <div className="overflow-hidden">
            <span className={`text-[11px] font-bold block truncate ${
              theme === 'light' ? 'text-gray-700' : 'text-gray-300'
            }`}>{userDisplay}</span>
            <span className="text-[9px] text-gray-500 font-mono block leading-none mt-0.5">Customs Broker</span>
          </div>
        </div>

        <div className={`flex items-center justify-between text-[10px] font-mono border-t pt-2 ${
          theme === 'light' ? 'border-gray-200 text-gray-500' : 'border-gray-900 text-gray-500'
        }`}>
          <div className="flex items-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full ${
              edgeFunctionStatus === 'live' ? 'bg-emerald-500' : 'bg-amber-500'
            }`}></span>
            <span>{edgeFunctionStatus === 'live' ? 'EDGE LIVE' : 'FALLBACK MODE'}</span>
          </div>
          {edgeFunctionStatus === 'live'
            ? <Wifi className="w-3 h-3 text-emerald-500" />
            : <WifiOff className="w-3 h-3 text-amber-500" />
          }
        </div>
      </div>
    </>
  );

  return (
    <div
      className={`min-h-screen font-sans flex flex-col overflow-hidden transition-colors duration-200 ${
        theme === 'light'
          ? 'bg-[#f4f5f7] text-gray-800'
          : 'bg-[#06070a] text-gray-200'
      }`}
    >
      {/* Mobile header bar */}
      <div className={`md:hidden flex items-center justify-between px-4 py-3 border-b ${
        theme === 'light' ? 'bg-white border-gray-200' : 'bg-[#0a0b10] border-gray-900'
      }`}>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-amber-500 rounded flex items-center justify-center font-bold text-black text-xs">CP</div>
          <span className={`text-sm font-bold uppercase ${theme === 'light' ? 'text-gray-900' : 'text-white'}`}>ClearPort</span>
        </div>
        <button
          onClick={() => setIsMobileSidebarOpen(true)}
          className={`p-2 rounded-lg ${theme === 'light' ? 'hover:bg-gray-100' : 'hover:bg-gray-900'}`}
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <aside className={`hidden md:flex w-64 flex-col justify-between shrink-0 select-none z-20 transition-colors duration-200 ${
          theme === 'light'
            ? 'bg-white border-r border-gray-200 text-gray-800'
            : 'bg-[#0a0b10] border-r border-gray-900 text-gray-200'
        }`}>
          {sidebarContent}
        </aside>

        {/* Mobile sidebar drawer */}
        <AnimatePresence>
          {isMobileSidebarOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsMobileSidebarOpen(false)}
                className="md:hidden fixed inset-0 bg-black/60 z-40"
              />
              <motion.aside
                initial={{ x: -300 }}
                animate={{ x: 0 }}
                exit={{ x: -300 }}
                transition={{ type: 'tween', duration: 0.2 }}
                className={`md:hidden fixed left-0 top-0 bottom-0 w-64 flex flex-col justify-between z-50 ${
                  theme === 'light'
                    ? 'bg-white border-r border-gray-200'
                    : 'bg-[#0a0b10] border-r border-gray-900'
                }`}
              >
                <button
                  onClick={() => setIsMobileSidebarOpen(false)}
                  className="absolute top-4 right-4 p-1 rounded"
                >
                  <X className="w-5 h-5" />
                </button>
                {sidebarContent}
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        {/* Main content */}
        <main className="flex-1 flex flex-col overflow-hidden relative min-w-0">
          {/* Top header */}
          <header className={`h-14 backdrop-blur border-b px-6 flex items-center justify-between shrink-0 select-none z-10 transition-colors duration-200 ${
            theme === 'light'
              ? 'bg-white/80 border-gray-200'
              : 'bg-[#0a0b10]/60 border-gray-900'
          }`}>
            <div className="flex items-center gap-2 font-mono text-xs text-gray-500 uppercase tracking-widest truncate">
              <Cpu className="w-4 h-4 text-gray-500 shrink-0" />
              <span className="hidden sm:inline">CORE NODE:</span>
              <span className="hidden sm:inline text-gray-600">SECURE SUITE</span>
              <span className="text-gray-600 hidden sm:inline">/</span>
              <span className={`font-bold truncate ${theme === 'light' ? 'text-gray-800' : 'text-gray-400'}`}>
                {getViewTitle()}
              </span>
            </div>

            <div className="flex items-center gap-4 shrink-0">
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
                        : 'bg-gray-500/5 border-gray-700 text-gray-500'
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                <span className="font-extrabold uppercase hidden sm:inline">
                  SUPABASE: {
                    supabaseStatus === 'connected' ? 'LIVE SYNC' :
                    supabaseStatus === 'loading' ? 'CONNECTING...' :
                    supabaseStatus === 'error_tables' ? 'TABLES MISSING' : 'OFFLINE'
                  }
                </span>
                <span className="font-extrabold uppercase sm:hidden">
                  {supabaseStatus === 'connected' ? 'LIVE' : supabaseStatus === 'loading' ? '...' : 'OFF'}
                </span>
              </button>

              {/* Org switcher — only shown when the user belongs to more than one org.
                  Calls switchOrg() to update the active org context, which triggers
                  a full data reload via ClearPortContext.loadData(). */}
              {userOrgs.length > 1 && (
                <div className="relative" ref={orgMenuRef}>
                  <button
                    onClick={() => setIsOrgMenuOpen((v) => !v)}
                    className={`border px-2.5 py-1 rounded-md flex items-center gap-1.5 font-mono text-[10px] transition-all cursor-pointer hover:scale-[1.02] active:scale-[0.98] ${
                      theme === 'light'
                        ? 'bg-amber-50 border-amber-200 text-amber-700'
                        : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                    }`}
                    title="Switch organization"
                  >
                    <span className="font-extrabold uppercase hidden sm:inline">ORG:</span>
                    <span className="font-bold uppercase max-w-[140px] truncate">{currentOrgName}</span>
                    <svg
                      className={`w-3 h-3 transition-transform ${isOrgMenuOpen ? 'rotate-180' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {isOrgMenuOpen && (
                    <div
                      className={`absolute right-0 mt-1 min-w-[200px] rounded-md border shadow-lg z-30 overflow-hidden ${
                        theme === 'light'
                          ? 'bg-white border-gray-200'
                          : 'bg-[#0d0e14] border-gray-800'
                      }`}
                    >
                      <div className={`px-3 py-1.5 text-[9px] font-mono uppercase tracking-wider border-b ${
                        theme === 'light' ? 'text-gray-400 border-gray-200' : 'text-gray-500 border-gray-900'
                      }`}>
                        Switch Organization
                      </div>
                      {userOrgs.map((org) => {
                        const isActive = org.org_id === currentOrgId;
                        return (
                          <button
                            key={org.org_id}
                            onClick={() => {
                              switchOrg(org.org_id);
                              setIsOrgMenuOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 transition-colors ${
                              isActive
                                ? (theme === 'light'
                                    ? 'bg-amber-50 text-amber-700'
                                    : 'bg-amber-500/10 text-amber-400')
                                : (theme === 'light'
                                    ? 'text-gray-700 hover:bg-gray-100'
                                    : 'text-gray-300 hover:bg-gray-900/60')
                            }`}
                          >
                            <span className="text-xs font-semibold truncate">{org.org_name}</span>
                            <span className={`text-[9px] font-mono uppercase shrink-0 ${
                              isActive
                                ? (theme === 'light' ? 'text-amber-600' : 'text-amber-500')
                                : (theme === 'light' ? 'text-gray-400' : 'text-gray-500')
                            }`}>
                              {org.role}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Real-time timestamp */}
              <div className="hidden lg:flex items-center gap-1.5 font-mono text-[10px] text-gray-500 uppercase">
                <span>LOCAL_TIME:</span>
                <span className={`font-bold ${theme === 'light' ? 'text-gray-800' : 'text-gray-300'}`}>
                  {currentTime || '—'}
                </span>
              </div>

              {/* Encryption status */}
              <div className={`border px-3 py-1 rounded-md flex items-center gap-1.5 font-mono text-[10px] transition-colors duration-200 ${
                theme === 'light'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : 'bg-black/40 border-gray-900 text-emerald-400'
              }`}>
                <Shield className="w-3.5 h-3.5 text-emerald-500" />
                <span className="font-extrabold uppercase hidden md:inline">SECURE CHANNEL // ACTIVE</span>
                <span className="font-extrabold uppercase md:hidden">SECURE</span>
              </div>
            </div>
          </header>

          {/* Interactive View Panel */}
          <div className="flex-1 overflow-hidden relative">
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

          {/* Sticky footer */}
          <footer className={`h-8 border-t flex items-center justify-between px-4 text-[9px] font-mono shrink-0 ${
            theme === 'light'
              ? 'bg-white border-gray-200 text-gray-400'
              : 'bg-[#08090d] border-gray-900 text-gray-600'
          }`}>
            <span className="truncate">CLEARPORT v5.0 // CUSTOMS COMPLIANCE PLATFORM</span>
            <span className="hidden md:inline flex-1 text-center">
              {edgeFunctionStatus === 'live'
                ? 'EDGE FUNCTIONS LIVE • GEMINI EXTRACTION ACTIVE'
                : 'FALLBACK MODE • DEPLOY EDGE FUNCTIONS FOR FULL CAPABILITY'
              }
            </span>
            <div className="flex items-center gap-3 shrink-0">
              {/* Legal pages — server-rendered, accessible without auth */}
              <Link
                href="/terms"
                className="hover:text-gray-300 transition-colors hidden sm:inline"
                title="Terms of Use"
              >
                Terms
              </Link>
              <Link
                href="/privacy"
                className="hover:text-gray-300 transition-colors hidden sm:inline"
                title="Privacy Policy"
              >
                Privacy
              </Link>
              <Link
                href="/legal"
                className="hover:text-gray-300 transition-colors hidden sm:inline"
                title="AI Disclaimer & Legal Overview"
              >
                AI Disclaimer
              </Link>
              <span className="text-gray-700 hidden sm:inline">|</span>
              <span>{entries.length} SHIPMENTS</span>
            </div>
          </footer>
        </main>
      </div>

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
    return (
      <div className="min-h-screen bg-[#06070a] flex items-center justify-center">
        <div className="text-gray-500 font-mono text-xs animate-pulse">INITIALIZING CLEARPORT...</div>
      </div>
    );
  }

  return (
    <ClearPortProvider>
      <AppShell />
    </ClearPortProvider>
  );
}

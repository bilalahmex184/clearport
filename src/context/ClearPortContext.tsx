'use client';
// ============================================================================
// ClearPortContext.tsx — Top-level provider (thin composer)
// ============================================================================
// FIX5-7-SPLIT: the provider used to hold every piece of state (shipments,
// exceptions, rules, audit logs, org, RBAC, theme, clock, ...). It now
// composes three focused hooks and exposes them as a single context value
// with the SAME shape as before — consuming components (page.tsx,
// ExceptionDesk.tsx, Dashboard.tsx, etc.) are unchanged.
//
//   useTheme()        — theme + toggleTheme
//   useShipments()    — entries, selection, exception mutations, audit log,
//                       batch accept, upload, CSV export, polling
//   useOrg()          — org context, RBAC role, apiFetchOrg, loadData,
//                       switchOrg, supabase/edge-function status, clock
//
// Cross-hook wiring: four refs (apiFetchOrgRef, currentUserRef, loadDataRef,
// currentOrgIdRef) are created in the provider and shared between useOrg
// (which populates them) and useShipments (which reads from them in its
// action callbacks). This keeps the action callback identities stable
// regardless of org / user state changes, which is more correct than the
// previous version that listed `currentUser` and `apiFetchOrg` as deps.
// ============================================================================

import * as React from 'react';
import type {
  ShipmentEntry,
  Exception,
  ExtractedField,
  OperationalRules,
  AuditLog,
  ReviewerAction,
} from '@/lib/clearport-types';
import {
  type UserRole,
} from '@/lib/services/rbac.service';
import { useTheme } from './use-theme';
import { useShipments, type ApiFetchOrg } from './use-shipments';
import { useOrg, type SupabaseStatus, type EdgeFunctionStatus } from './use-org';

// Re-export so existing `import { SupabaseStatus } from '@/context/ClearPortContext'`
// (if any) keeps working — these types were previously declared here.
export type { SupabaseStatus, EdgeFunctionStatus };

// ============================================================================
// Context Type
// ============================================================================

interface ClearPortContextType {
  entries: ShipmentEntry[];
  selectedEntryId: string;
  selectedEntry: ShipmentEntry | undefined;
  selectedExceptionId: string;
  selectedException: Exception | undefined;
  activeTab: string;
  rules: OperationalRules;
  undoStack: { entryId: string; exceptionId: string; previousState: Exception }[];
  auditLogs: AuditLog[];
  theme: 'dark' | 'light';
  supabaseStatus: SupabaseStatus;
  edgeFunctionStatus: EdgeFunctionStatus;
  currentUser: string | null;
  currentTime: string;
  // RBAC role for the current user — fetched from /api/organizations on
  // load (reflects the user's role in their active org). Defaults to
  // 'operator' so the no-login UX continues to work before the role is
  // resolved. Components use the can* helpers (canUpload, canResolve,
  // canManageRules, canExport) from rbac.service to gate their UI.
  userRole: UserRole;
  // Organizations the user belongs to (populated from
  // GET /api/organizations). Empty until the first successful fetch.
  userOrgs: Array<{ org_id: string; org_name: string; role: UserRole }>;
  // The currently active org id. Sent as the X-Org-Id header on every
  // API call so the backend resolves the same org context via
  // requireOrgRole(). Null until the first org list load completes.
  currentOrgId: string | null;

  // API helper — same as apiFetch but injects X-Org-Id header
  apiFetchOrg: ApiFetchOrg;

  // Actions
  selectEntry: (id: string) => void;
  selectException: (id: string) => void;
  setActiveTab: (tab: string) => void;
  updateException: (entryId: string, exceptionId: string, status: ReviewerAction, newValue?: string) => void;
  undoLastAction: () => void;
  acceptAllHighConfidence: (entryId: string) => void;
  uploadDocuments: (files: File[]) => Promise<{ shipmentId: string; success: boolean; error?: string }>;
  updateRules: (newRules: Partial<OperationalRules>) => void;
  exportToCSV: (entryId: string) => Promise<void>;
  toggleTheme: () => void;
  refreshData: () => Promise<void>;
  // Switch the active org context. Updates currentOrgId + userRole, then
  // reloads all org-scoped data (shipments, rules, logs) via the API.
  switchOrg: (orgId: string) => void;
}

const ClearPortContext = React.createContext<ClearPortContextType | undefined>(undefined);

// ============================================================================
// Provider
// ============================================================================

export const ClearPortProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // activeTab stays in the provider — it's shell-level navigation state that
  // neither shipments nor org naturally owns.
  const [activeTab, setActiveTab] = React.useState<string>('exception-desk');

  // --- Cross-hook refs -----------------------------------------------------
  // Created here so both useOrg and useShipments can share them. useOrg
  // populates these via effects (mirroring its own state/callbacks); useShipments
  // reads from them inside its action callbacks. This breaks the would-be
  // circular dep (useOrg's loadData needs useShipments' setters; useShipments'
  // actions need useOrg's apiFetchOrg / currentUser / loadData / currentOrgId).
  const apiFetchOrgRef = React.useRef<ApiFetchOrg | null>(null);
  const currentUserRef = React.useRef<string | null>(null);
  const loadDataRef = React.useRef<() => Promise<void>>(() => Promise.resolve());
  const currentOrgIdRef = React.useRef<string | null>(null);

  // --- Compose the three focused hooks -------------------------------------
  const { theme, toggleTheme } = useTheme();

  // useShipments runs first because useOrg needs its setters + selectedEntryIdRef.
  // useShipments reads apiFetchOrgRef / currentUserRef / loadDataRef /
  // currentOrgIdRef, which start as null/empty but are populated by useOrg's
  // effects after the first commit. This is safe because no useShipments
  // action is callable during the first render — they're all user-triggered
  // (clicks, uploads, polls) and run after mount, by which point the refs are
  // populated.
  const shipments = useShipments({
    apiFetchOrgRef,
    currentUserRef,
    loadDataRef,
    currentOrgIdRef,
  });

  const org = useOrg({
    setEntries: shipments.setEntries,
    setRules: shipments.setRules,
    setAuditLogs: shipments.setAuditLogs,
    setSelectedEntryId: shipments.setSelectedEntryId,
    setSelectedExceptionId: shipments.setSelectedExceptionId,
    selectedEntryIdRef: shipments.selectedEntryIdRef,
    apiFetchOrgRef,
    currentUserRef,
    loadDataRef,
    currentOrgIdRef,
  });

  // --- Assemble the context value (same shape as before the split) --------
  const value: ClearPortContextType = {
    entries: shipments.entries,
    selectedEntryId: shipments.selectedEntryId,
    selectedEntry: shipments.selectedEntry,
    selectedExceptionId: shipments.selectedExceptionId,
    selectedException: shipments.selectedException,
    activeTab,
    rules: shipments.rules,
    undoStack: shipments.undoStack,
    auditLogs: shipments.auditLogs,
    theme,
    supabaseStatus: org.supabaseStatus,
    edgeFunctionStatus: org.edgeFunctionStatus,
    currentUser: org.currentUser,
    currentTime: org.currentTime,
    userRole: org.userRole,
    userOrgs: org.userOrgs,
    currentOrgId: org.currentOrgId,
    apiFetchOrg: org.apiFetchOrg,
    selectEntry: shipments.selectEntry,
    selectException: shipments.selectException,
    setActiveTab,
    updateException: shipments.updateException,
    undoLastAction: shipments.undoLastAction,
    acceptAllHighConfidence: shipments.acceptAllHighConfidence,
    uploadDocuments: shipments.uploadDocuments,
    updateRules: shipments.updateRules,
    exportToCSV: shipments.exportToCSV,
    toggleTheme,
    refreshData: shipments.refreshData,
    switchOrg: org.switchOrg,
  };

  return (
    <ClearPortContext.Provider value={value}>
      {children}
    </ClearPortContext.Provider>
  );
};

export function useClearPort() {
  const context = React.useContext(ClearPortContext);
  if (context === undefined) {
    throw new Error('useClearPort must be used within a ClearPortProvider');
  }
  return context;
}

export type { ShipmentEntry, Exception, ExtractedField, OperationalRules, AuditLog };

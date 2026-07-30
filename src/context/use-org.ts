'use client';
// ============================================================================
// use-org.ts — Org context, RBAC role, supabase/edge-function status, clock
// ============================================================================
// Extracted from ClearPortContext.tsx (FIX5-7-SPLIT — behavior-preserving).
//
// Owns the org bootstrap (GET /api/organizations), the org-scoped fetch
// wrapper (apiFetchOrg — injects X-Org-Id), the real-time clock, the current
// user email fetch, and the live/fallback data load (loadData). Also owns
// the supabase + edge-function status indicators that the rest of the UI
// uses to show "Demo Mode" badges.
//
// Cross-hook wiring: this hook receives the shipments setters + the
// selectedEntryIdRef from useShipments (so loadData can populate the
// shipments/rules/logs/selection after a successful API load). It also
// receives four refs (apiFetchOrgRef, currentUserRef, loadDataRef,
// currentOrgIdRef) that it populates via effects — useShipments reads from
// these refs in its action callbacks so the callback identities stay
// stable regardless of org/user state changes.
// ============================================================================

import * as React from 'react';
import {
  isSupabaseConfigured,
  ensureAuthenticated,
  getCurrentUserEmail,
  apiFetch,
  isDemoMode,
} from '@/lib/supabase';
import type {
  ShipmentEntry,
  OperationalRules,
  AuditLog,
} from '@/lib/clearport-types';
import {
  type UserRole,
} from '@/lib/services/rbac.service';
import type { ApiFetchOrg } from './use-shipments';

// --- Types ------------------------------------------------------------------
export type SupabaseStatus = 'connected' | 'unconfigured' | 'error_tables' | 'loading';
export type EdgeFunctionStatus = 'live' | 'fallback' | 'unknown';

export interface UseOrgDeps {
  // Setters from useShipments — used by loadData when applying fetched state.
  setEntries: React.Dispatch<React.SetStateAction<ShipmentEntry[]>>;
  setRules: React.Dispatch<React.SetStateAction<OperationalRules>>;
  setAuditLogs: React.Dispatch<React.SetStateAction<AuditLog[]>>;
  setSelectedEntryId: React.Dispatch<React.SetStateAction<string>>;
  setSelectedExceptionId: React.Dispatch<React.SetStateAction<string>>;
  selectedEntryIdRef: React.MutableRefObject<string>;
  // Refs that useOrg populates with its own callbacks/state so useShipments
  // can read them without recreating its action callbacks on every change.
  apiFetchOrgRef: React.MutableRefObject<ApiFetchOrg | null>;
  currentUserRef: React.MutableRefObject<string | null>;
  loadDataRef: React.MutableRefObject<() => Promise<void>>;
  currentOrgIdRef: React.MutableRefObject<string | null>;
}

export interface UseOrgResult {
  userOrgs: Array<{ org_id: string; org_name: string; role: UserRole }>;
  currentOrgId: string | null;
  userRole: UserRole;
  supabaseStatus: SupabaseStatus;
  edgeFunctionStatus: EdgeFunctionStatus;
  currentUser: string | null;
  currentTime: string;
  apiFetchOrg: ApiFetchOrg;
  switchOrg: (orgId: string) => void;
}

/**
 * Manages org context, RBAC role, and the live/fallback data load.
 *
 * On mount, fires `loadData` which: ensures the Supabase session, fetches the
 * user's org memberships (bootstrapping currentOrgId + userRole), then loads
 * shipments / rules / logs for the active org. Subsequent `switchOrg` calls
 * update currentOrgId + userRole and reload.
 */
export function useOrg(deps: UseOrgDeps): UseOrgResult {
  const {
    setEntries,
    setRules,
    setAuditLogs,
    setSelectedEntryId,
    setSelectedExceptionId,
    selectedEntryIdRef,
    apiFetchOrgRef,
    currentUserRef,
    loadDataRef,
    currentOrgIdRef,
  } = deps;

  const [supabaseStatus, setSupabaseStatus] = React.useState<SupabaseStatus>(
    isSupabaseConfigured() ? 'loading' : 'unconfigured'
  );
  const [edgeFunctionStatus, setEdgeFunctionStatus] = React.useState<EdgeFunctionStatus>('unknown');
  const [currentUser, setCurrentUser] = React.useState<string | null>(null);
  const [currentTime, setCurrentTime] = React.useState<string>('');
  // Initial value 'operator' preserves the no-login UX. The real role is
  // fetched from /api/organizations on load (see loadData below).
  const [userRole, setUserRole] = React.useState<UserRole>('operator');
  // Orgs the user belongs to + the currently active org id. Populated by
  // loadData on first run; switchOrg() updates currentOrgId and reloads.
  const [userOrgs, setUserOrgs] = React.useState<Array<{ org_id: string; org_name: string; role: UserRole }>>([]);
  const [currentOrgId, setCurrentOrgId] = React.useState<string | null>(null);

  // Refs mirror the org state so loadData / apiFetchOrg / switchOrg can read
  // the latest values without being recreated on every state change. This
  // keeps loadData's deps stable ([apiFetchOrg]) so the initial mount effect
  // only fires once, and switchOrg can explicitly trigger a reload.
  //
  // P7 fix: ref assignments are done in useEffect (not during render) to be
  // safe under React's concurrent rendering model. A component can render
  // more than once per commit in concurrent mode; mutating refs during render
  // would corrupt them. useEffect runs exactly once per commit.
  //
  // currentOrgIdRef is created in the provider and shared with useShipments
  // (uploadDocuments reads org_id from it when writing a processing_jobs row).
  const userOrgsRef = React.useRef<typeof userOrgs>([]);
  React.useEffect(() => {
    currentOrgIdRef.current = currentOrgId;
  }, [currentOrgId]);
  React.useEffect(() => {
    userOrgsRef.current = userOrgs;
  }, [userOrgs]);

  // --- apiFetch wrapper that injects the X-Org-Id header for org-scoped routes ---
  // Uses the ref so the callback identity is stable (no dependency on state).
  // Routes that DON'T need an org context (e.g. /api/organizations itself)
  // should call the base `apiFetch` directly.
  const apiFetchOrg = React.useCallback(
    <T = any>(path: string, options: RequestInit & { raw?: boolean } = {}): Promise<T> => {
      const headers: Record<string, string> = {
        ...((options.headers as Record<string, string>) || {}),
      };
      if (currentOrgIdRef.current) {
        headers['X-Org-Id'] = currentOrgIdRef.current;
      }
      return apiFetch<T>(path, { ...options, headers });
    },
    // currentOrgIdRef is a stable ref (created via useRef in the provider).
    // Listed explicitly so the React Compiler can preserve the memoization.
    [currentOrgIdRef],
  );

  // Mirror apiFetchOrg + currentUser into the shared refs so useShipments'
  // action callbacks can read live values without being recreated. These
  // effects run after the first commit, so any user-triggered action (which
  // always fires after mount) sees the populated refs.
  React.useEffect(() => {
    apiFetchOrgRef.current = apiFetchOrg;
  }, [apiFetchOrg]);
  React.useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  // --- Real-time clock ---
  React.useEffect(() => {
    const update = () => {
      const now = new Date();
      const utc = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
      setCurrentTime(utc);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  // --- Load user email ---
  React.useEffect(() => {
    getCurrentUserEmail().then(email => setCurrentUser(email));
  }, []);

  // --- Load data ---
  const loadData = React.useCallback(async () => {
    if (!isSupabaseConfigured()) {
      setSupabaseStatus('unconfigured');
      setEdgeFunctionStatus('fallback');
      return;
    }

    setSupabaseStatus('loading');

    try {
      await ensureAuthenticated();
      const email = await getCurrentUserEmail();
      setCurrentUser(email);

      // --- Bootstrap org context (only on first run, when currentOrgId is null) ---
      // Subsequent reloads (e.g. after switchOrg) skip this block and reuse
      // the already-selected org. Uses the base apiFetch (no X-Org-Id header)
      // because GET /api/organizations is the bootstrap path that doesn't
      // require an org context.
      if (!currentOrgIdRef.current) {
        try {
          const orgsRes = await apiFetch<{
            organizations: Array<{ org_id: string; org_name: string; role: UserRole }>;
          }>('/api/organizations');

          const orgs = orgsRes?.organizations ?? [];
          if (orgs.length > 0) {
            setUserOrgs(orgs);
            const first = orgs[0];
            setCurrentOrgId(first.org_id);
            currentOrgIdRef.current = first.org_id;
            setUserRole(first.role);
          } else if (isDemoMode()) {
            try {
              const createRes = await apiFetch<{ organization: { id: string; name: string }; role: UserRole }>('/api/organizations', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Demo Workspace' }),
              });
              if (createRes?.organization?.id) {
                const newOrg = { org_id: createRes.organization.id, org_name: createRes.organization.name, role: createRes.role };
                setUserOrgs([newOrg]); setCurrentOrgId(newOrg.org_id); currentOrgIdRef.current = newOrg.org_id; setUserRole(newOrg.role);
              } else { setSupabaseStatus('connected'); setEdgeFunctionStatus('fallback'); return; }
            } catch (createErr) { console.warn('[ctx] Demo org creation failed:', createErr); setSupabaseStatus('connected'); setEdgeFunctionStatus('fallback'); return; }
          } else {
            setSupabaseStatus('connected'); setEdgeFunctionStatus('fallback'); return;
          }
        } catch (orgErr) {
          // 403 (no org membership) or network / schema error — fall back to
          // seed data so the demo UX keeps working.
          console.warn('[ctx] /api/organizations failed, falling back to seed data:', orgErr);
          setSupabaseStatus('connected');
          setEdgeFunctionStatus('fallback');
          return;
        }
      }

      // --- Fetch shipments for the active org (uses X-Org-Id header via apiFetchOrg) ---
      try {
        const response = await apiFetchOrg<{
          data: ShipmentEntry[];
          pagination: { total: number };
        }>('/api/shipments?page=1&limit=100');

        if (response?.data && Array.isArray(response.data)) {
          // Only use DB shipments if they have fields/exceptions data (new
          // schema). Old-schema shipments have empty arrays — fall back to
          // seed data so the demo UX is preserved.
          const hasRealData = response.data.some(
            (s) => s.fields.length > 0 || s.exceptions.length > 0,
          );

          if (hasRealData) {
            setEntries(response.data);
            // Select first shipment if current selection doesn't exist
            if (!response.data.find((s) => s.id === selectedEntryIdRef.current)) {
              const first = response.data[0];
              setSelectedEntryId(first.id);
              if (first.exceptions?.length > 0) {
                const unresolved = first.exceptions.find((e) => e.status === 'Unresolved');
                setSelectedExceptionId(unresolved ? unresolved.id : first.exceptions[0].id);
              }
            }
          }
          // else: keep seed entries (demo mode)

          setEdgeFunctionStatus('live');
          setSupabaseStatus('connected');

          // Fetch rules + logs in parallel via the org-scoped API routes.
          const [rulesRes, logsRes] = await Promise.all([
            apiFetchOrg<{ rules: OperationalRules }>('/api/rules').catch(() => null),
            apiFetchOrg<{ logs: AuditLog[] }>('/api/audit-logs').catch(() => null),
          ]);
          if (rulesRes?.rules) setRules(rulesRes.rules);
          if (logsRes?.logs && logsRes.logs.length > 0) setAuditLogs(logsRes.logs);
          return;
        }
      } catch (apiErr) {
        console.warn('[ctx] /api/shipments failed, falling back to seed data:', apiErr);
      }

      // Fallback: seed data (demo mode)
      setSupabaseStatus('connected');
      setEdgeFunctionStatus('fallback');
    } catch (err) {
      console.error('[ctx] loadData error:', err);
      setSupabaseStatus('error_tables');
      setEdgeFunctionStatus('fallback');
    }
  }, [apiFetchOrg, setEntries, setRules, setAuditLogs, setSelectedEntryId, setSelectedExceptionId, selectedEntryIdRef, currentOrgIdRef]);

  // Mirror loadData into the shared ref so useShipments' refreshData can call
  // the latest loadData without depending on it directly.
  React.useEffect(() => {
    loadDataRef.current = loadData;
  }, [loadData]);

  // --- switchOrg: change the active org context and reload data ---
  const switchOrg = React.useCallback((orgId: string) => {
    const org = userOrgsRef.current.find((o) => o.org_id === orgId);
    if (!org) {
      console.warn('[ctx] switchOrg: org not found in userOrgs', { orgId });
      return;
    }
    // Update both state + ref so apiFetchOrg picks up the new org immediately
    // (the ref is read synchronously; the state triggers a re-render).
    setCurrentOrgId(orgId);
    currentOrgIdRef.current = orgId;
    setUserRole(org.role);
    // Reload all org-scoped data for the new org.
    loadData();
  }, [loadData, currentOrgIdRef]);

  // loadData is async and needs live org context — a lazy useState initializer
  // can't be used here. This is a deliberate one-time async load on mount,
  // not a cascading render.
  React.useEffect(() => {
    loadData();
  }, [loadData]);

  return {
    userOrgs,
    currentOrgId,
    userRole,
    supabaseStatus,
    edgeFunctionStatus,
    currentUser,
    currentTime,
    apiFetchOrg,
    switchOrg,
  };
}

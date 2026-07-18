'use client';

import * as React from 'react';
import {
  supabase,
  isSupabaseConfigured,
  ensureAuthenticated,
  getCurrentUserEmail,
  invokeEdgeFunction,
  apiFetch,
  seedEntries,
  seedRules,
  seedLogs,
  calculateConfidence,
} from '@/lib/supabase';
import type {
  ShipmentEntry,
  Exception,
  ExtractedField,
  OperationalRules,
  AuditLog,
  ShipmentStatus,
  ExceptionStatus,
  ReviewerAction,
  ExceptionHistoryEntry,
} from '@/lib/clearport-types';
import {
  type UserRole,
} from '@/lib/services/rbac.service';

// ============================================================================
// Context Type
// ============================================================================

export type SupabaseStatus = 'connected' | 'unconfigured' | 'error_tables' | 'loading';
export type EdgeFunctionStatus = 'live' | 'fallback' | 'unknown';

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
  apiFetchOrg: <T = any>(path: string, options?: RequestInit & { raw?: boolean }) => Promise<T>;

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
  const [entries, setEntries] = React.useState<ShipmentEntry[]>(seedEntries);
  const [selectedEntryId, setSelectedEntryId] = React.useState<string>('SHIP-2026-8802');
  const [selectedExceptionId, setSelectedExceptionId] = React.useState<string>('8802-hts');
  const [activeTab, setActiveTab] = React.useState<string>('exception-desk');
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark');
  const [rules, setRules] = React.useState<OperationalRules>(seedRules);
  const [undoStack, setUndoStack] = React.useState<{ entryId: string; exceptionId: string; previousState: Exception }[]>([]);
  const [auditLogs, setAuditLogs] = React.useState<AuditLog[]>(seedLogs);
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
  // keeps loadData's deps stable ([]) so the initial mount effect only fires
  // once, and switchOrg can explicitly trigger a reload.
  //
  // P7 fix: ref assignments are done in useEffect (not during render) to be
  // safe under React's concurrent rendering model. A component can render
  // more than once per commit in concurrent mode; mutating refs during render
  // would corrupt them. useEffect runs exactly once per commit.
  const currentOrgIdRef = React.useRef<string | null>(null);
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
    [],
  );

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

  // --- Persist theme ---
  React.useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('clearport-theme') : null;
    if (saved === 'light' || saved === 'dark') setTheme(saved);
  }, []);

  const toggleTheme = React.useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      if (typeof window !== 'undefined') localStorage.setItem('clearport-theme', next);
      return next;
    });
  }, []);

  // --- Load data ---
  // P7 fix: ref assignment in useEffect (not during render) for concurrent-mode safety.
  const selectedEntryIdRef = React.useRef(selectedEntryId);
  React.useEffect(() => {
    selectedEntryIdRef.current = selectedEntryId;
  }, [selectedEntryId]);

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
          } else {
            // No org memberships — fall back to seed data with a warning.
            // The user can still see the demo data; they just can't mutate it.
            console.warn('[ctx] No org memberships found — falling back to seed data. Create or join an organization to enable live mode.');
            setSupabaseStatus('connected');
            setEdgeFunctionStatus('fallback');
            return;
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
  }, [apiFetchOrg]);

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
  }, [loadData]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const refreshData = React.useCallback(async () => {
    await loadData();
  }, [loadData]);

  // --- refreshShipment: pull a single shipment's full state from the DB ---
  // Used by (a) the polling effect below and (b) the end of the background
  // pipeline so the selected entry always reflects the real DB state
  // (fields, exceptions, validation_status). Replaces the entry in-place by id.
  //
  // If the shipment is NOT FOUND (404) — e.g. the row upsert failed silently
  // but a placeholder was already added — we mark the entry as 'failed' so the
  // polling effect stops retrying forever (it only polls while status is
  // pending/running). This prevents orphaned placeholders from generating
  // endless 404 requests.
  const refreshShipment = React.useCallback(async (shipmentId: string) => {
    if (!isSupabaseConfigured()) return;
    try {
      const res = await apiFetchOrg<{ shipment: ShipmentEntry }>(
        '/api/shipments/' + shipmentId,
      );
      if (res?.shipment) {
        setEntries(prev => {
          const idx = prev.findIndex(e => e.id === shipmentId);
          if (idx === -1) return prev; // not in list — nothing to update
          const updated = [...prev];
          // The DB row has the authoritative fields/exceptions/validation_status.
          updated[idx] = res.shipment;
          return updated;
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // If the shipment doesn't exist (404 / not found), mark the placeholder
      // as 'failed' so polling stops. This handles the edge case where the
      // shipment row upsert failed but a 'pending' placeholder was already
      // added to the UI — without this, the polling effect would retry forever.
      if (/404|not found/i.test(errMsg)) {
        setEntries(prev => {
          const idx = prev.findIndex(e => e.id === shipmentId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = {
            ...updated[idx],
            validationStatus: 'failed',
          };
          return updated;
        });
      } else {
        // Transient error (network blip, 500, etc.) — polling will retry on
        // the next tick. Log at debug to avoid console spam.
        console.debug('[ctx] refreshShipment failed for', shipmentId, errMsg);
      }
    }
  }, [apiFetchOrg]);

  // --- Computed ---
  const selectedEntry = React.useMemo(
    () => entries.find(e => e.id === selectedEntryId),
    [entries, selectedEntryId]
  );

  const selectedException = React.useMemo(() => {
    if (!selectedEntry) return undefined;
    return selectedEntry.exceptions.find(ex => ex.id === selectedExceptionId);
  }, [selectedEntry, selectedExceptionId]);

  // --- Light polling: while the selected shipment's validation_status is
  // 'pending' or 'running', refresh it from the DB every 4 seconds so the
  // user sees status transitions + extracted fields + exceptions appear in
  // real time without manually refreshing. Stops the moment the status
  // reaches a terminal state (completed/failed/degraded) or the selection
  // changes to an already-terminal shipment.
  React.useEffect(() => {
    if (!isSupabaseConfigured()) return;
    const status = selectedEntry?.validationStatus;
    if (status !== 'pending' && status !== 'running') return;
    if (!selectedEntryId) return;

    const POLL_INTERVAL_MS = 4000;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      await refreshShipment(selectedEntryId);
    };

    // Fire one immediately (so a fast pipeline that already finished shows up
    // without waiting 4s), then on the interval.
    void tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedEntryId, selectedEntry?.validationStatus, refreshShipment]);

  // --- Selection (fixes stale closure — uses functional update) ---
  const selectEntry = React.useCallback((id: string) => {
    setSelectedEntryId(id);
    setEntries(prev => {
      const entry = prev.find(e => e.id === id);
      if (entry && entry.exceptions.length > 0) {
        const unresolved = entry.exceptions.find(e => e.status === 'Unresolved');
        setSelectedExceptionId(unresolved ? unresolved.id : entry.exceptions[0].id);
      } else {
        setSelectedExceptionId('');
      }
      return prev;
    });
  }, []);

  const selectException = React.useCallback((id: string) => {
    setSelectedExceptionId(id);
  }, []);

  // --- Audit log helper ---
  const addAuditLog = React.useCallback((text: string, type: AuditLog['type'] = 'info', shipmentId?: string) => {
    const newLog: AuditLog = {
      id: typeof crypto !== 'undefined' ? crypto.randomUUID() : `log-${Date.now()}`,
      text,
      timestamp: new Date().toISOString(),
      type,
      shipmentId,
    };
    setAuditLogs(prev => [newLog, ...prev]);

    if (isSupabaseConfigured() && supabase) {
      supabase.from('audit_logs').insert({
        id: newLog.id,
        text: newLog.text,
        timestamp: newLog.timestamp,
        type: newLog.type,
        shipment_id: shipmentId || null,
      }).then(({ error }) => {
        if (error) console.warn('[ctx] audit log insert failed:', error.message);
      });
    }
  }, []);

  // --- Update exception (fixes setState-in-setState) ---
  const updateException = React.useCallback(
    (entryId: string, exceptionId: string, status: ReviewerAction, newValue?: string) => {
      let previousException: Exception | undefined;
      let updatedEntry: ShipmentEntry | undefined;

      setEntries(prevEntries => {
        return prevEntries.map(entry => {
          if (entry.id !== entryId) return entry;

          const prev = entry.exceptions.find(ex => ex.id === exceptionId);
          if (!prev) return entry;
          previousException = { ...prev };

          const updatedExceptions = entry.exceptions.map(ex => {
            if (ex.id !== exceptionId) return ex;

            const oldVal = ex.correctedValue || ex.extractedValue;
            const updatedVal = newValue !== undefined ? newValue : ex.extractedValue;

            const historyItem: ExceptionHistoryEntry = {
              user: currentUser || 'unknown',
              oldValue: oldVal,
              newValue: updatedVal,
              timestamp: new Date().toISOString(),
              action: status,
            };

            return {
              ...ex,
              status: status as ExceptionStatus,
              correctedValue: status === 'Corrected' ? newValue : undefined,
              history: [historyItem, ...ex.history],
              resolvedAt: new Date().toISOString(),
              resolvedBy: currentUser || undefined,
            };
          });

          const allResolved = updatedExceptions.every(ex => ex.status !== 'Unresolved');
          const newStatus: ShipmentStatus = allResolved ? 'Approved' : 'Under Review';
          const newConfidence = calculateConfidence(entry.initialConfidence, updatedExceptions);

          const updatedFields = entry.fields.map(f => {
            if (f.exceptionId === exceptionId) {
              const val = status === 'Corrected' ? (newValue || f.value) : f.value;
              return { ...f, value: val, isFlagged: false };
            }
            return f;
          });

          updatedEntry = {
            ...entry,
            status: newStatus,
            exceptions: updatedExceptions,
            fields: updatedFields,
            currentConfidence: newConfidence,
          };

          return updatedEntry;
        });
      });

      // Side effects AFTER setState
      if (previousException && updatedEntry) {
        setUndoStack(prevStack => [
          { entryId, exceptionId, previousState: { ...previousException! } },
          ...prevStack,
        ]);

        const logText = `Exception "${previousException.fieldName}" for ${entryId} was ${status.toLowerCase()}${
          status === 'Corrected' ? ` to "${newValue}"` : ''
        } by ${currentUser}.`;
        addAuditLog(logText, status === 'Rejected' ? 'warning' : 'success', entryId);

        // Persist via the /api/exceptions/:id route (handles exception update,
        // document_field sync, shipment confidence recompute, and audit log
        // in one server-side transaction). Uses the org-scoped wrapper so
        // the X-Org-Id header is sent.
        if (isSupabaseConfigured()) {
          apiFetchOrg(`/api/exceptions/${exceptionId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              status,
              correctedValue: status === 'Corrected' ? newValue : undefined,
            }),
          }).catch((err) => {
            console.warn('[ctx] exception update failed:', err instanceof Error ? err.message : err);
          });
        }
      }
    },
    [currentUser, addAuditLog, apiFetchOrg]
  );

  // --- Undo ---
  const undoLastAction = React.useCallback(() => {
    if (undoStack.length === 0) return;

    const [lastAction, ...remainingStack] = undoStack;
    setUndoStack(remainingStack);

    setEntries(prevEntries => {
      return prevEntries.map(entry => {
        if (entry.id !== lastAction.entryId) return entry;

        const restored = lastAction.previousState;
        const updatedExceptions = entry.exceptions.map(ex =>
          ex.id === lastAction.exceptionId ? restored : ex
        );

        const allResolved = updatedExceptions.every(ex => ex.status !== 'Unresolved');
        const newStatus: ShipmentStatus = allResolved ? 'Approved' : 'Under Review';
        const newConfidence = calculateConfidence(entry.initialConfidence, updatedExceptions);

        const updatedFields = entry.fields.map(f => {
          if (f.exceptionId === lastAction.exceptionId) {
            return {
              ...f,
              value: restored.status === 'Corrected' ? (restored.correctedValue || f.value) : restored.extractedValue,
              isFlagged: restored.status === 'Unresolved',
            };
          }
          return f;
        });

        const updatedEntry = {
          ...entry,
          status: newStatus,
          exceptions: updatedExceptions,
          fields: updatedFields,
          currentConfidence: newConfidence,
        };

        if (isSupabaseConfigured() && supabase) {
          supabase.from('exceptions').update({
            status: restored.status,
            corrected_value: restored.correctedValue || null,
            resolved_at: restored.resolvedAt || null,
            resolved_by: restored.resolvedBy || null,
            history: restored.history,
          }).eq('id', lastAction.exceptionId).then(({ error }) => {
            if (error) console.warn('[ctx] undo exception failed:', error.message);
          });

          supabase.from('shipments').update({
            status: newStatus,
            current_confidence: newConfidence,
            updated_at: new Date().toISOString(),
          }).eq('id', entry.id).then(({ error }) => {
            if (error) console.warn('[ctx] undo shipment failed:', error.message);
          });
        }

        return updatedEntry;
      });
    });

    addAuditLog(`Undo applied for last review action on shipment ${lastAction.entryId}`, 'info', lastAction.entryId);
  }, [undoStack, addAuditLog]);

  // --- Batch accept (uses configured threshold) ---
  const acceptAllHighConfidence = React.useCallback((entryId: string) => {
    setEntries(prevEntries => {
      return prevEntries.map(entry => {
        if (entry.id !== entryId) return entry;

        const cutoff = rules.invoiceThreshold;
        let acceptedCount = 0;

        const updatedExceptions = entry.exceptions.map(ex => {
          if (ex.status === 'Unresolved' && ex.confidence >= cutoff) {
            acceptedCount++;
            const historyItem: ExceptionHistoryEntry = {
              user: currentUser || 'unknown',
              oldValue: ex.extractedValue,
              newValue: ex.extractedValue,
              timestamp: new Date().toISOString(),
              action: 'Accepted' as ReviewerAction,
            };
            return {
              ...ex,
              status: 'Accepted' as ExceptionStatus,
              history: [historyItem, ...ex.history],
              resolvedAt: new Date().toISOString(),
              resolvedBy: currentUser || undefined,
            };
          }
          return ex;
        });

        if (acceptedCount === 0) return entry;

        const allResolved = updatedExceptions.every(ex => ex.status !== 'Unresolved');
        const newStatus: ShipmentStatus = allResolved ? 'Approved' : 'Under Review';
        const newConfidence = calculateConfidence(entry.initialConfidence, updatedExceptions);

        const updatedFields = entry.fields.map(f => {
          const exc = updatedExceptions.find(e => e.id === f.exceptionId);
          if (exc) return { ...f, isFlagged: exc.status === 'Unresolved' };
          return f;
        });

        const updatedEntry = {
          ...entry,
          status: newStatus,
          exceptions: updatedExceptions,
          fields: updatedFields,
          currentConfidence: newConfidence,
        };

        addAuditLog(
          `Batch action: Approved ${acceptedCount} high-confidence exceptions (≥${cutoff}%) in ${entryId}.`,
          'success',
          entryId
        );

        // Persist via the /api/exceptions/batch-accept route (accepts each
        // qualifying exception, syncs document_fields, recomputes shipment
        // confidence + status, and writes a batch-level audit log). Uses the
        // org-scoped wrapper so the X-Org-Id header is sent.
        if (isSupabaseConfigured()) {
          apiFetchOrg('/api/exceptions/batch-accept', {
            method: 'POST',
            body: JSON.stringify({
              shipmentId: entryId,
              threshold: cutoff,
            }),
          }).catch((err) => {
            console.warn('[ctx] batch accept failed:', err instanceof Error ? err.message : err);
          });
        }

        return updatedEntry;
      });
    });
  }, [rules.invoiceThreshold, currentUser, addAuditLog, apiFetchOrg]);

  // --- Inline pipeline fallback (§3) ---
  // Used ONLY when the processing_jobs table doesn't exist (migration 018 not
  // run yet) or the queue insert fails. This is the old synchronous path that
  // calls the edge function directly from the browser. The primary path is the
  // queue + worker — this is the safety net so extraction still works during
  // the migration period.
  //
  // (§4 refactor: extracted to src/context/inline-pipeline.ts — behavior preserved)
  const runInlinePipeline = React.useCallback(async (shipmentId: string, _detectedDocType: string) => {
    const { runInlinePipeline: runPipeline } = await import('./inline-pipeline');
    await runPipeline(shipmentId, apiFetchOrg, refreshShipment);
  }, [apiFetchOrg, refreshShipment]);

  // --- Upload documents ---
  const uploadDocuments = React.useCallback(async (files: File[]): Promise<{ shipmentId: string; success: boolean; error?: string }> => {
    const shipmentId = `SHIP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

    try {
      if (!isSupabaseConfigured()) {
        // Fallback
        const newEntry: ShipmentEntry = {
          id: shipmentId,
          shipper: 'Titanium Castings KK',
          consignee: 'Ironclad Logistics Inc.',
          status: 'Under Review',
          docsCount: files.length,
          urgency: '08:30:00',
          initialConfidence: 70,
          currentConfidence: 70,
          createdAt: new Date().toISOString(),
          documents: [],
          exceptions: [],
          fields: [],
        };

        const excId = typeof crypto !== 'undefined' ? crypto.randomUUID() : `${shipmentId}-address`;
        newEntry.exceptions = [{
          id: excId,
          fieldName: 'Consignee Corporate Address',
          fieldKey: 'consigneeAddress',
          originalValue: 'Suite 200, Seattle, WA',
          extractedValue: 'Suite 200, Seattle, WA',
          crossDocValue: 'Suite 201, Seattle, WA',
          confidence: 62,
          reason: 'Address abbreviation mismatch: Commercial Invoice lists "Suite 200, Seattle, WA" while Bill of Lading shows "Suite 201, Seattle, WA".',
          exceptionType: 'cross_doc_mismatch',
          docType: 'Bill of Lading',
          boundingBox: { x: 10, y: 35, w: 32, h: 5 },
          status: 'Unresolved',
          history: [],
          createdAt: new Date().toISOString(),
        }];

        newEntry.fields = [
          { id: 'n1', key: 'invoiceNo', label: 'Commercial Invoice #', value: 'TC-9921-KK', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 90 },
          { id: 'n2', key: 'invoiceDate', label: 'Invoice Date', value: new Date().toISOString().split('T')[0], sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 88 },
          { id: 'n3', key: 'shipper', label: 'Shipper / Exporter', value: 'Titanium Castings KK', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 95 },
          { id: 'n4', key: 'consignee', label: 'Consignee / Importer', value: 'Ironclad Logistics Inc.', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 94 },
          { id: 'n5', key: 'consigneeAddress', label: 'Consignee Address', value: 'Suite 200, Seattle, WA', sourceDoc: 'Commercial Invoice', isFlagged: true, confidence: 62, exceptionId: excId, crossDocValue: 'Suite 201, Seattle, WA' },
          { id: 'n6', key: 'declaredValue', label: 'Total Declared Value', value: '$45,210.00', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 87 },
          { id: 'n7', key: 'htsCode', label: 'HTS Code (Primary Line)', value: '7308.90.0000', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 91 },
          { id: 'n8', key: 'netWeight', label: 'Total Net Weight', value: '8,410 lbs', sourceDoc: 'Bill of Lading', isFlagged: false, confidence: 89 },
        ];

        setEntries(prev => [newEntry, ...prev]);
        setSelectedEntryId(shipmentId);
        setSelectedExceptionId(excId);
        addAuditLog(`New entry ${shipmentId} ingestion and auto-analysis completed with 1 exception.`, 'info', shipmentId);

        return { shipmentId, success: true };
      }

      // Real pipeline
      await ensureAuthenticated();

      // Step 1: Upload each file to Storage via edge function
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('shipment_id', shipmentId);

        try {
          if (supabase) {
            const { error } = await supabase.functions.invoke('upload-document', {
              body: formData,
            });
            if (error) throw error;
          }
        } catch (err) {
          console.warn('[upload] edge function failed for file:', err);
          // Continue — extraction will still try to work on whatever was uploaded
        }
      }

      // Step 2: Create the shipment row in DB with validation_status = 'pending'
      // so the UI can show "received, processing" the moment the upload lands —
      // NOT after the full extraction + validation chain finishes.
      if (supabase) {
        await supabase.from('shipments').upsert({
          id: shipmentId,
          shipper: 'Pending Extraction',
          consignee: 'Pending Extraction',
          status: 'Under Review',
          docs_count: files.length,
          urgency: '08:30:00',
          initial_confidence: 0,
          current_confidence: 0,
          validation_status: 'pending',
        }).then(({ error }) => {
          if (error) console.warn('[upload] shipment upsert:', error.message);
        });
      }

      // Detect document type from the first file's name
      const detectDocType = (fileName: string): string => {
        const lower = fileName.toLowerCase();
        if (lower.includes('packing') || lower.includes('pack')) return 'Packing List';
        if (lower.includes('lading') || lower.includes('bol')) return 'Bill of Lading';
        if (lower.includes('origin') || lower.includes('coo')) return 'Certificate of Origin';
        return 'Commercial Invoice';
      };
      const detectedDocType = files.length > 0 ? detectDocType(files[0].name) : 'Commercial Invoice';

      // ── IMMEDIATE RESPONSE: add a placeholder entry + select it ──
      // The user sees "received, processing" right away. The background
      // pipeline (below) + the polling effect keep the entry fresh as the
      // chain progresses: pending → running → completed/failed/degraded.
      const placeholderEntry: ShipmentEntry = {
        id: shipmentId,
        shipper: 'Pending Extraction',
        consignee: 'Pending Extraction',
        status: 'Under Review',
        docsCount: files.length,
        urgency: '08:30:00',
        initialConfidence: 0,
        currentConfidence: 0,
        createdAt: new Date().toISOString(),
        documents: [],
        exceptions: [],
        fields: [],
        validationStatus: 'pending',
      };
      setEntries(prev => [placeholderEntry, ...prev.filter(e => e.id !== shipmentId)]);
      setSelectedEntryId(shipmentId);
      setSelectedExceptionId('');
      addAuditLog(`Shipment ${shipmentId} received — processing started.`, 'info', shipmentId);

      // ── QUEUE-BASED PIPELINE (§3) ──
      // Instead of running extraction inline from the request path, write a
      // 'queued' processing_jobs row. The standalone worker process
      // (mini-services/worker/) polls this table, claims the job via
      // SELECT ... FOR UPDATE SKIP LOCKED, and runs the extraction + validation
      // pipeline with a time budget that isn't constrained by the edge
      // function's request-scoped CPU limit.
      //
      // The polling effect (every 4s) refreshes the selected shipment's status
      // from the DB as the worker progresses: pending → running →
      // completed/failed/degraded. This is the durable async processing layer
      // — the upload returns immediately, the worker handles the rest.
      try {
        const traceId = typeof crypto !== 'undefined' ? crypto.randomUUID() : `trace-${Date.now()}`;
        if (!supabase) throw new Error('Supabase client not initialized');
        const { error: jobErr } = await supabase.from('processing_jobs').insert({
          shipment_id: shipmentId,
          org_id: currentOrgIdRef.current,
          job_type: 'extraction',
          status: 'queued',
          trace_id: traceId,
        });
        if (jobErr) {
          console.warn('[queue] failed to write processing_jobs row:', jobErr.message);
          // Fallback: if the processing_jobs table doesn't exist yet (migration
          // not run), fall back to the old inline pipeline so extraction still
          // works. This is a safety net, not the primary path.
          addAuditLog('[queue] processing_jobs table not available — falling back to inline extraction', 'warning', shipmentId);
          void runInlinePipeline(shipmentId, detectedDocType).catch(err => {
            console.error('[pipeline] inline fallback failed:', err);
          });
        } else {
          addAuditLog(`[queue] Extraction job queued for ${shipmentId} (trace: ${traceId.slice(0, 8)})`, 'info', shipmentId);
        }
      } catch (err) {
        console.error('[queue] unexpected error writing job:', err);
        // Same fallback — don't let a queue failure prevent extraction
        void runInlinePipeline(shipmentId, detectedDocType).catch(() => {});
      }

      // Return immediately — the user has already seen "received, processing".
      // The worker process will pick up the job and run the extraction + validation
      // pipeline. The polling effect (every 4s) keeps the UI in sync with the DB.
      return { shipmentId, success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Upload pipeline failed';
      addAuditLog(`Upload failed for ${shipmentId}: ${errMsg}`, 'error', shipmentId);
      return { shipmentId, success: false, error: errMsg };
    }
  }, [rules, addAuditLog, refreshShipment, apiFetchOrg]);

  // --- Update rules ---
  const updateRules = React.useCallback((newRules: Partial<OperationalRules>) => {
    setRules(prev => {
      const updated = { ...prev, ...newRules };

      // Persist via the /api/rules route (upserts the org's rules row).
      // Uses the org-scoped wrapper so the X-Org-Id header is sent.
      if (isSupabaseConfigured()) {
        apiFetchOrg('/api/rules', {
          method: 'PATCH',
          body: JSON.stringify(newRules),
        }).catch((err) => {
          console.warn('[ctx] rules update failed:', err instanceof Error ? err.message : err);
        });
      }

      return updated;
    });
    addAuditLog('Compliance operational thresholds updated.', 'info');
  }, [addAuditLog, apiFetchOrg]);

  // --- Real CSV export ---
  const exportToCSV = React.useCallback(async (entryId: string) => {
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;

    // Try the /api/export/:id route first (generates CSV server-side from the
    // DB-backed shipment data and returns it as text/csv). Uses the org-scoped
    // wrapper so the X-Org-Id header is sent.
    if (isSupabaseConfigured()) {
      try {
        const res = await apiFetchOrg<Response>(`/api/export/${entryId}`, { raw: true });
        if (res.ok) {
          const csv = await res.text();
          if (csv) {
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ClearPort_Audit_${entryId}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            addAuditLog(`Audit logs exported to CSV for ${entryId}.`, 'success', entryId);
            return;
          }
        }
      } catch (err) {
        console.warn('[csv] /api/export failed, generating locally:', err);
      }
    }

    // Fallback: local CSV generation from in-memory entry
    const rows: string[] = [];
    rows.push('Field Key,Field Label,Value,Source Document,Confidence,Flagged,Status');
    entry.fields.forEach(f => {
      const exc = entry.exceptions.find(e => e.id === f.exceptionId);
      const status = exc ? exc.status : 'SECURE';
      const escaped = [f.key, f.label, f.value, f.sourceDoc, f.confidence, f.isFlagged, status]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',');
      rows.push(escaped);
    });

    rows.push('');
    rows.push('Exception ID,Field Name,Reason,Confidence,Status,Resolved By');
    entry.exceptions.forEach(e => {
      const escaped = [e.id, e.fieldName, e.reason, e.confidence, e.status, e.resolvedBy || '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',');
      rows.push(escaped);
    });

    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ClearPort_Audit_${entryId}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addAuditLog(`Audit logs exported to CSV for ${entryId}.`, 'success', entryId);
  }, [entries, addAuditLog, apiFetchOrg]);

  const value: ClearPortContextType = {
    entries,
    selectedEntryId,
    selectedEntry,
    selectedExceptionId,
    selectedException,
    activeTab,
    rules,
    undoStack,
    auditLogs,
    theme,
    supabaseStatus,
    edgeFunctionStatus,
    currentUser,
    currentTime,
    userRole,
    userOrgs,
    currentOrgId,
    apiFetchOrg,
    selectEntry,
    selectException,
    setActiveTab,
    updateException,
    undoLastAction,
    acceptAllHighConfidence,
    uploadDocuments,
    updateRules,
    exportToCSV,
    toggleTheme,
    refreshData,
    switchOrg,
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

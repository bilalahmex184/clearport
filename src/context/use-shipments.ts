'use client';
// ============================================================================
// use-shipments.ts — Shipment / exception / rules / audit state + actions
// ============================================================================
// Extracted from ClearPortContext.tsx (FIX5-7-SPLIT — behavior-preserving).
//
// Owns all shipment-scoped state: entries, selectedEntryId, selectedExceptionId,
// rules, undoStack, auditLogs. Exposes the selection callbacks, exception
// mutation actions, batch-accept, document upload, CSV export, audit-log
// helper, and the light polling effect that refreshes a pending/running
// shipment from the DB.
//
// Cross-hook dependencies: this hook receives refs that the useOrg hook
// populates (apiFetchOrg, currentUser, loadData, currentOrgId). Reading
// from refs keeps the callback identities stable — the original used
// `apiFetchOrg` and `currentUser` as useCallback deps, but `apiFetchOrg`
// itself has empty deps so it was already stable; `currentUser` changing
// recreated the callbacks. Using refs means the callbacks are now always
// stable, which is more correct (no behavior change for consumers).
// ============================================================================

import * as React from 'react';
import {
  supabase,
  isSupabaseConfigured,
  ensureAuthenticated,
  seedEntries,
  seedRules,
  seedLogs,
  calculateConfidence,
} from '@/lib/supabase';
import type {
  ShipmentEntry,
  Exception,
  OperationalRules,
  AuditLog,
  ShipmentStatus,
  ExceptionStatus,
  ReviewerAction,
  ExceptionHistoryEntry,
} from '@/lib/clearport-types';

// --- Types shared across context hooks --------------------------------------
export type ApiFetchOrg = <T = any>(path: string, options?: RequestInit & { raw?: boolean }) => Promise<T>;

export interface UseShipmentsDeps {
  // Refs populated by useOrg — let shipments callbacks read live values
  // without recreating the callbacks on every state change.
  apiFetchOrgRef: React.MutableRefObject<ApiFetchOrg | null>;
  currentUserRef: React.MutableRefObject<string | null>;
  loadDataRef: React.MutableRefObject<() => Promise<void>>;
  currentOrgIdRef: React.MutableRefObject<string | null>;
}

export interface UseShipmentsResult {
  // State
  entries: ShipmentEntry[];
  selectedEntryId: string;
  selectedExceptionId: string;
  rules: OperationalRules;
  undoStack: { entryId: string; exceptionId: string; previousState: Exception }[];
  auditLogs: AuditLog[];
  // Derived
  selectedEntry: ShipmentEntry | undefined;
  selectedException: Exception | undefined;
  // Actions
  selectEntry: (id: string) => void;
  selectException: (id: string) => void;
  updateException: (entryId: string, exceptionId: string, status: ReviewerAction, newValue?: string) => void;
  undoLastAction: () => void;
  acceptAllHighConfidence: (entryId: string) => void;
  uploadDocuments: (files: File[]) => Promise<{ shipmentId: string; success: boolean; error?: string }>;
  updateRules: (newRules: Partial<OperationalRules>) => void;
  exportToCSV: (entryId: string) => Promise<void>;
  refreshShipment: (shipmentId: string) => Promise<void>;
  refreshData: () => Promise<void>;
  // Internal handles exposed for the orchestrator (useOrg's loadData reads
  // selectedEntryIdRef so it can preserve the user's selection across reloads).
  selectedEntryIdRef: React.MutableRefObject<string>;
  setEntries: React.Dispatch<React.SetStateAction<ShipmentEntry[]>>;
  setRules: React.Dispatch<React.SetStateAction<OperationalRules>>;
  setAuditLogs: React.Dispatch<React.SetStateAction<AuditLog[]>>;
  setSelectedEntryId: React.Dispatch<React.SetStateAction<string>>;
  setSelectedExceptionId: React.Dispatch<React.SetStateAction<string>>;
}

/**
 * Manages all shipment-scoped state and the actions that mutate it.
 *
 * Cross-hook refs (apiFetchOrgRef, currentUserRef, loadDataRef,
 * currentOrgIdRef) are populated by the useOrg hook via effects, so by the
 * time any user-facing action is invoked (always after mount), the refs hold
 * the live values.
 */
export function useShipments(deps: UseShipmentsDeps): UseShipmentsResult {
  const { apiFetchOrgRef, currentUserRef, loadDataRef, currentOrgIdRef } = deps;

  const [entries, setEntries] = React.useState<ShipmentEntry[]>(seedEntries);
  const [selectedEntryId, setSelectedEntryId] = React.useState<string>('SHIP-2026-8802');
  const [selectedExceptionId, setSelectedExceptionId] = React.useState<string>('8802-hts');
  const [rules, setRules] = React.useState<OperationalRules>(seedRules);
  const [undoStack, setUndoStack] = React.useState<{ entryId: string; exceptionId: string; previousState: Exception }[]>([]);
  const [auditLogs, setAuditLogs] = React.useState<AuditLog[]>(seedLogs);

  // selectedEntryIdRef mirrors state so useOrg's loadData (which lives in a
  // different hook) can read the latest selected id without being recreated
  // on every selection change. P7 fix: ref assignment in useEffect (not
  // during render) for concurrent-mode safety.
  const selectedEntryIdRef = React.useRef(selectedEntryId);
  React.useEffect(() => {
    selectedEntryIdRef.current = selectedEntryId;
  }, [selectedEntryId]);

  // --- Computed ---
  const selectedEntry = React.useMemo(
    () => entries.find(e => e.id === selectedEntryId),
    [entries, selectedEntryId]
  );

  const selectedException = React.useMemo(() => {
    if (!selectedEntry) return undefined;
    return selectedEntry.exceptions.find(ex => ex.id === selectedExceptionId);
  }, [selectedEntry, selectedExceptionId]);

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
    const apiFetchOrg = apiFetchOrgRef.current;
    if (!apiFetchOrg) return;
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
      // Match on the structured `code` first (apiFetch now throws ApiFetchError
      // with code='NOT_FOUND'); fall back to the message regex for non-API
      // errors (network, etc.).
      const errCode = (err as { code?: string })?.code;
      if (errCode === 'NOT_FOUND' || /404|not found/i.test(errMsg)) {
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
  }, [apiFetchOrgRef]);

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

  // --- Update exception (fixes setState-in-setState) ---
  const updateException = React.useCallback(
    (entryId: string, exceptionId: string, status: ReviewerAction, newValue?: string) => {
      const currentUser = currentUserRef.current;
      const apiFetchOrg = apiFetchOrgRef.current;
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
        if (isSupabaseConfigured() && apiFetchOrg) {
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
    [addAuditLog, apiFetchOrgRef, currentUserRef]
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
    const currentUser = currentUserRef.current;
    const apiFetchOrg = apiFetchOrgRef.current;

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
        if (isSupabaseConfigured() && apiFetchOrg) {
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
  }, [rules.invoiceThreshold, addAuditLog, apiFetchOrgRef, currentUserRef]);

  // --- Inline pipeline fallback (§3) ---
  // Used ONLY when the processing_jobs table doesn't exist (migration 018 not
  // run yet) or the queue insert fails. This is the old synchronous path that
  // calls the edge function directly from the browser. The primary path is the
  // queue + worker — this is the safety net so extraction still works during
  // the migration period.
  //
  // NOTE: The old inline-pipeline (edge function cascade) has been quarantined
  // to /deprecated/. The live upload flow now calls /api/internal/extract-and-validate
  // which runs the full pipeline in the Next.js Node runtime (async 202 pattern).

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

      // Real pipeline — ASYNC: upload + fire extraction, return immediately
      await ensureAuthenticated();
      let waitRetries = 0;
      while (!apiFetchOrgRef.current && waitRetries < 50) { await new Promise(r => setTimeout(r, 100)); waitRetries++; }

      // Phase 6 cutover: if the ingress Worker URL is configured, route the
      // upload through it (the new pipeline). The Worker handles Storage
      // upload, job creation, queue enqueue, and returns 202. Otherwise, fall
      // back to the old direct-Supabase + /api/internal/extract-and-validate path.
      const ingressUrl = process.env.NEXT_PUBLIC_INGRESS_URL;
      if (ingressUrl) {
        // === NEW PIPELINE (Phase 6) ===
        // The ingress Worker handles everything: auth, file validation, Storage
        // upload, job creation, queue enqueue. We just POST the file + shipment_id.
        try {
          const apiFetchOrg = apiFetchOrgRef.current;
          if (!apiFetchOrg) throw new Error('apiFetchOrg not ready');

          // Create the shipment row first (the Worker expects it to exist).
          if (supabase) {
            const { data: { user } } = await supabase.auth.getUser();
            await supabase.from('shipments').upsert({
              id: shipmentId, org_id: currentOrgIdRef.current, user_id: user?.id || null,
              shipper: 'Pending Extraction', consignee: 'Pending Extraction', status: 'Under Review',
              docs_count: files.length, urgency: '08:30:00', initial_confidence: 0, current_confidence: 0,
              validation_status: 'pending',
            }).then(({ error }) => { if (error) console.warn('[upload] upsert:', error.message); });
          }

          // Upload each file to the ingress Worker.
          for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('shipment_id', shipmentId);

            // The apiFetchOrg wrapper adds the X-Org-Id + Authorization headers.
            // But the ingress Worker is on a different origin (workers.dev), so
            // we use a direct fetch with the same headers.
            const { data: { user } } = await supabase!.auth.getUser();
            const authRes = await supabase!.auth.getSession();
            const jwt = authRes.data.session?.access_token || '';
            const orgId = currentOrgIdRef.current || '';

            const res = await fetch(`${ingressUrl}/`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${jwt}`,
                'X-Org-Id': orgId,
              },
              body: formData,
            });

            if (!res.ok) {
              const errBody = await res.json().catch(() => ({ error: 'unknown' }));
              console.error('[upload] ingress Worker error:', res.status, errBody);
              throw new Error(`Upload failed: ${errBody.error || res.statusText}`);
            }

            const result = await res.json();
            console.log('[upload] ingress accepted:', result);
          }

          // Add a placeholder entry so the UI shows the shipment immediately.
          const placeholderEntry: ShipmentEntry = {
            id: shipmentId, shipper: 'Pending Extraction', consignee: 'Pending Extraction',
            status: 'Under Review', docsCount: files.length, urgency: '08:30:00',
            initialConfidence: 0, currentConfidence: 0, createdAt: new Date().toISOString(),
            documents: [], exceptions: [], fields: [], validationStatus: 'pending',
          };
          setEntries(prev => [placeholderEntry, ...prev.filter(e => e.id !== shipmentId)]);
          setSelectedEntryId(shipmentId); setSelectedExceptionId('');
          addAuditLog(`Shipment ${shipmentId} uploaded via new pipeline — processing started.`, 'info', shipmentId);

          return { shipmentId, success: true };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'New pipeline upload failed';
          console.error('[upload] new pipeline error:', errMsg);
          addAuditLog(`Upload error (new pipeline): ${errMsg}`, 'error', shipmentId);
          // Fall through to the old pipeline as a safety net.
          console.warn('[upload] falling back to old pipeline');
        }
      }

      // === OLD PIPELINE (legacy, used when NEXT_PUBLIC_INGRESS_URL is not set
      // or the new pipeline failed) ===

      const detectDocType = (fileName: string): string => {
        const l = fileName.toLowerCase();
        if (l.includes('packing') || l.includes('pack')) return 'Packing List';
        if (l.includes('lading') || l.includes('bol')) return 'Bill of Lading';
        if (l.includes('origin') || l.includes('coo')) return 'Certificate of Origin';
        return 'Commercial Invoice';
      };

      if (supabase) {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('shipments').upsert({
          id: shipmentId, org_id: currentOrgIdRef.current, user_id: user?.id || null,
          shipper: 'Pending Extraction', consignee: 'Pending Extraction', status: 'Under Review',
          docs_count: files.length, urgency: '08:30:00', initial_confidence: 0, current_confidence: 0,
          validation_status: 'pending',
        }).then(({ error }) => { if (error) console.warn('[upload] upsert:', error.message); });
      }

      const docsPayload: Array<{ documentId: string; textContent: string; fileName: string; docType: string; mimeType: string; fileData?: string }> = [];
      for (const file of files) {
        const docType = detectDocType(file.name);
        const docId = typeof crypto !== 'undefined' ? crypto.randomUUID() : `doc-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
        let mimeType = file.type || '';
        if (!mimeType) { const ext = file.name.split('.').pop()?.toLowerCase() || ''; mimeType = { pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', txt:'text/plain', csv:'text/csv' }[ext] || 'application/octet-stream'; }

        // Read file content FIRST (before async storage ops)
        let textContent = '';
        let fileData: string | undefined;
        if (mimeType === 'application/pdf') {
          try { const ab = await file.arrayBuffer(); const bytes = new Uint8Array(ab); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) { bin += String.fromCharCode.apply(null, bytes.subarray(i, i+0x8000) as unknown as number[]); } fileData = btoa(bin); } catch (err) { console.warn('[upload] base64:', err); }
        } else if (mimeType.startsWith('text/')) { try { textContent = await file.text(); } catch {} }

        // Storage upload (best-effort)
        try { if (supabase) { const { error: ue } = await supabase.storage.from('documents').upload(`${currentOrgIdRef.current||'demo'}/${shipmentId}/${docId}-${file.name}`, file, { upsert: false }); if (ue) console.warn('[upload] storage:', ue.message); } } catch {}
        // Documents row (best-effort)
        try { if (supabase) { const { data: { user } } = await supabase.auth.getUser(); await supabase.from('documents').insert({ id: docId, shipment_id: shipmentId, user_id: user?.id||null, org_id: currentOrgIdRef.current, doc_type: docType, file_name: file.name, storage_path: `${currentOrgIdRef.current||'demo'}/${shipmentId}/${docId}-${file.name}`, file_size: file.size, mime_type: mimeType }).then(({ error }) => { if (error) console.warn('[upload] doc:', error.message); }); } } catch {}

        docsPayload.push({ documentId: docId, textContent, fileName: file.name, docType, mimeType, ...(fileData ? { fileData } : {}) });
      }

      const placeholderEntry: ShipmentEntry = { id: shipmentId, shipper: 'Pending Extraction', consignee: 'Pending Extraction', status: 'Under Review', docsCount: files.length, urgency: '08:30:00', initialConfidence: 0, currentConfidence: 0, createdAt: new Date().toISOString(), documents: [], exceptions: [], fields: [], validationStatus: 'pending' };
      setEntries(prev => [placeholderEntry, ...prev.filter(e => e.id !== shipmentId)]);
      setSelectedEntryId(shipmentId); setSelectedExceptionId('');
      addAuditLog(`Shipment ${shipmentId} received — processing started.`, 'info', shipmentId);

      const apiFetchOrg = apiFetchOrgRef.current;
      if (apiFetchOrg) {
        void (async () => {
          try {
            await apiFetchOrg('/api/internal/extract-and-validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shipmentId, documents: docsPayload }) });
            addAuditLog(`Extraction started for ${shipmentId}.`, 'info', shipmentId);
          } catch (err) { console.error('[pipeline] failed:', err); addAuditLog(`Extraction error: ${err instanceof Error ? err.message : String(err)}`, 'error', shipmentId); await refreshShipment(shipmentId).catch(() => {}); }
        })();
      }
      return { shipmentId, success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Upload pipeline failed';
      addAuditLog(`Upload failed for ${shipmentId}: ${errMsg}`, 'error', shipmentId);
      return { shipmentId, success: false, error: errMsg };
    }
  }, [addAuditLog, refreshShipment, currentOrgIdRef, apiFetchOrgRef]);

  // --- Update rules ---
  const updateRules = React.useCallback((newRules: Partial<OperationalRules>) => {
    const apiFetchOrg = apiFetchOrgRef.current;
    setRules(prev => {
      const updated = { ...prev, ...newRules };

      // Persist via the /api/rules route (upserts the org's rules row).
      // Uses the org-scoped wrapper so the X-Org-Id header is sent.
      if (isSupabaseConfigured() && apiFetchOrg) {
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
  }, [addAuditLog, apiFetchOrgRef]);

  // --- Real CSV export ---
  const exportToCSV = React.useCallback(async (entryId: string) => {
    const apiFetchOrg = apiFetchOrgRef.current;
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;

    // Try the /api/export/:id route first (generates CSV server-side from the
    // DB-backed shipment data and returns it as text/csv). Uses the org-scoped
    // wrapper so the X-Org-Id header is sent.
    if (isSupabaseConfigured() && apiFetchOrg) {
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
  }, [entries, addAuditLog, apiFetchOrgRef]);

  // --- refreshData: trigger a full reload via useOrg's loadData ---
  // Reads loadData from the ref so the callback identity is stable.
  const refreshData = React.useCallback(async () => {
    const loadData = loadDataRef.current;
    if (loadData) await loadData();
  }, [loadDataRef]);

  return {
    entries,
    selectedEntryId,
    selectedExceptionId,
    rules,
    undoStack,
    auditLogs,
    selectedEntry,
    selectedException,
    selectEntry,
    selectException,
    updateException,
    undoLastAction,
    acceptAllHighConfidence,
    uploadDocuments,
    updateRules,
    exportToCSV,
    refreshShipment,
    refreshData,
    // Internal handles for the orchestrator + useOrg
    selectedEntryIdRef,
    setEntries,
    setRules,
    setAuditLogs,
    setSelectedEntryId,
    setSelectedExceptionId,
  };
}

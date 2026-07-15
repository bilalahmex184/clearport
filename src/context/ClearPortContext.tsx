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
  getDefaultRole,
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
  currentUser: string;
  currentTime: string;
  // RBAC role for the current user — anonymous users default to 'operator'
  // so the no-login UX continues to work. Components use the can* helpers
  // (canUpload, canResolve, canManageRules, canExport) from rbac.service
  // to gate their interactive UI.
  userRole: UserRole;

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
  const [currentUser, setCurrentUser] = React.useState<string>('Broker');
  const [currentTime, setCurrentTime] = React.useState<string>('');
  // Anonymous users default to 'operator'. In production this would be
  // fetched from the server (e.g. GET /api/me → role from user_roles table).
  const [userRole, setUserRole] = React.useState<UserRole>(getDefaultRole());

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
  const selectedEntryIdRef = React.useRef(selectedEntryId);
  selectedEntryIdRef.current = selectedEntryId;

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

      // Try the new /api/shipments route (replaces both the get-shipments
      // edge function call AND the fetchShipmentsDirect fallback).
      try {
        const response = await apiFetch<{
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

          // Fetch rules + logs in parallel via the new API routes.
          const [rulesRes, logsRes] = await Promise.all([
            apiFetch<{ rules: OperationalRules }>('/api/rules').catch(() => null),
            apiFetch<{ logs: AuditLog[] }>('/api/audit-logs').catch(() => null),
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
  }, []);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const refreshData = React.useCallback(async () => {
    await loadData();
  }, [loadData]);

  // --- Computed ---
  const selectedEntry = React.useMemo(
    () => entries.find(e => e.id === selectedEntryId),
    [entries, selectedEntryId]
  );

  const selectedException = React.useMemo(() => {
    if (!selectedEntry) return undefined;
    return selectedEntry.exceptions.find(ex => ex.id === selectedExceptionId);
  }, [selectedEntry, selectedExceptionId]);

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
              user: currentUser,
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
              resolvedBy: currentUser,
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
        // in one server-side transaction).
        if (isSupabaseConfigured()) {
          apiFetch(`/api/exceptions/${exceptionId}`, {
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
    [currentUser, addAuditLog]
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
              user: currentUser,
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
              resolvedBy: currentUser,
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
        // confidence + status, and writes a batch-level audit log).
        if (isSupabaseConfigured()) {
          apiFetch('/api/exceptions/batch-accept', {
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
  }, [rules.invoiceThreshold, currentUser, addAuditLog]);

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

      // Step 2: Create the shipment row in DB (if not already created by upload-document)
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
        }).then(({ error }) => {
          if (error) console.warn('[upload] shipment upsert:', error.message);
        });
      }

      // Step 3: Extract fields via Gemini edge function
      let extractedFields: ExtractedField[] = [];
      let shipper = 'Unknown Shipper';
      let consignee = 'Unknown Consignee';

      try {
        const extractResponse = await invokeEdgeFunction<any>('extract-document', { shipmentId });
        if (extractResponse?.success && extractResponse.fields && extractResponse.fields.length > 0) {
          extractedFields = extractResponse.fields.map((f: any) => ({
            id: typeof crypto !== 'undefined' ? crypto.randomUUID() : `f-${Date.now()}`,
            key: f.field_key,
            label: f.field_label,
            value: f.extracted_value,
            sourceDoc: 'Commercial Invoice',
            isFlagged: false,
            confidence: f.confidence,
            boundingBox: f.bounding_box,
          }));
          if (extractResponse.shipper) shipper = extractResponse.shipper;
          if (extractResponse.consignee) consignee = extractResponse.consignee;
        }
      } catch (err) {
        console.warn('[extract] edge function failed:', err);
      }

      // Step 4: Call the validation chain (schema-validate, math-validate, flag-exceptions)
      // These run server-side and update the DB directly
      try {
        await invokeEdgeFunction('schema-validate', { shipmentId }).catch(() => {});
      } catch (err) {
        console.warn('[schema-validate] failed:', err);
      }
      try {
        await invokeEdgeFunction('math-validate', { shipmentId }).catch(() => {});
      } catch (err) {
        console.warn('[math-validate] failed:', err);
      }
      try {
        await invokeEdgeFunction('cross-validate', { shipmentId }).catch(() => {});
      } catch (err) {
        console.warn('[cross-validate] failed:', err);
      }
      try {
        await invokeEdgeFunction('flag-exceptions', { shipmentId }).catch(() => {});
      } catch (err) {
        console.warn('[flag-exceptions] failed:', err);
      }

      // Step 5: Reload from API to get the real DB state (with fields, exceptions, documents)
      if (extractedFields.length > 0) {
        // If we have extracted fields, build the entry from extraction response
        const newExceptions: Exception[] = [];
        const updatedFields = extractedFields.map(f => {
          let threshold = rules.invoiceThreshold;
          if (f.key === 'htsCode') threshold = rules.htsThreshold;
          else if (f.key === 'shipper' || f.key === 'consignee' || f.key === 'consigneeAddress') threshold = rules.partiesThreshold;

          if (f.confidence < threshold) {
            const excId = crypto.randomUUID();
            const exc: Exception = {
              id: excId,
              fieldName: f.label,
              fieldKey: f.key,
              originalValue: f.value,
              extractedValue: f.value,
              confidence: f.confidence,
              reason: `Extracted confidence (${f.confidence}%) is below threshold (${threshold}%).`,
              exceptionType: 'low_confidence',
              docType: f.sourceDoc,
              boundingBox: f.boundingBox || { x: 10, y: 35, w: 32, h: 5 },
              status: 'Unresolved',
              history: [],
              createdAt: new Date().toISOString(),
            };
            newExceptions.push(exc);
            return { ...f, isFlagged: true, exceptionId: excId };
          }
          return f;
        });

        const initialConfidence = Math.round(
          updatedFields.reduce((acc, f) => acc + f.confidence, 0) / Math.max(updatedFields.length, 1)
        );

        const newEntry: ShipmentEntry = {
          id: shipmentId,
          shipper,
          consignee,
          status: 'Under Review',
          docsCount: files.length,
          urgency: '08:30:00',
          initialConfidence,
          currentConfidence: initialConfidence,
          createdAt: new Date().toISOString(),
          documents: [],
          exceptions: newExceptions,
          fields: updatedFields,
        };

        setEntries(prev => [newEntry, ...prev]);
        setSelectedEntryId(shipmentId);
        setSelectedExceptionId(newExceptions[0]?.id || '');
      } else {
        // No fields extracted — reload from API to get whatever the DB has
        await loadData();
        setSelectedEntryId(shipmentId);
      }

      addAuditLog(
        `New entry ${shipmentId} ingestion completed: ${files.length} files, ${extractedFields.length} fields extracted.`,
        extractedFields.length > 0 ? 'success' : 'warning',
        shipmentId
      );

      return { shipmentId, success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Upload pipeline failed';
      addAuditLog(`Upload failed for ${shipmentId}: ${errMsg}`, 'error', shipmentId);
      return { shipmentId, success: false, error: errMsg };
    }
  }, [rules, addAuditLog]);

  // --- Update rules ---
  const updateRules = React.useCallback((newRules: Partial<OperationalRules>) => {
    setRules(prev => {
      const updated = { ...prev, ...newRules };

      // Persist via the /api/rules route (upserts the user's rules row).
      if (isSupabaseConfigured()) {
        apiFetch('/api/rules', {
          method: 'PATCH',
          body: JSON.stringify(newRules),
        }).catch((err) => {
          console.warn('[ctx] rules update failed:', err instanceof Error ? err.message : err);
        });
      }

      return updated;
    });
    addAuditLog('Compliance operational thresholds updated.', 'info');
  }, [addAuditLog]);

  // --- Real CSV export ---
  const exportToCSV = React.useCallback(async (entryId: string) => {
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;

    // Try the /api/export/:id route first (generates CSV server-side from the
    // DB-backed shipment data and returns it as text/csv).
    if (isSupabaseConfigured()) {
      try {
        const res = await apiFetch<Response>(`/api/export/${entryId}`, { raw: true });
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
  }, [entries, addAuditLog]);

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

'use client';

import * as React from 'react';
import { 
  getSupabaseShipments, 
  upsertSupabaseShipment, 
  getSupabaseRules, 
  upsertSupabaseRules, 
  getSupabaseLogs, 
  insertSupabaseLog,
  isSupabaseConfigured,
  getSupabaseDocumentFields,
  updateSupabaseDocumentField
} from '../lib/supabase';

export interface ExceptionHistory {
  user: string;
  oldValue: string;
  newValue: string;
  timestamp: string;
  action: 'Accepted' | 'Corrected' | 'Rejected';
}

export interface Exception {
  id: string;
  fieldName: string;
  fieldKey: string;
  originalValue: string;
  extractedValue: string;
  confidence: number;
  reason: string;
  docType: string;
  boundingBox: { x: number; y: number; w: number; h: number };
  status: 'Unresolved' | 'Accepted' | 'Corrected' | 'Rejected';
  correctedValue?: string;
  history: ExceptionHistory[];
}

export interface ExtractedField {
  key: string;
  label: string;
  value: string;
  sourceDoc: string;
  isFlagged: boolean;
  exceptionId?: string;
}

export interface ShipmentEntry {
  id: string;
  shipper: string;
  consignee: string;
  status: 'Under Review' | 'Approved' | 'Exported';
  docsCount: number;
  urgency: string;
  initialConfidence: number;
  currentConfidence: number;
  exceptions: Exception[];
  fields: ExtractedField[];
  createdAt: string;
}

interface OperationalRules {
  invoiceThreshold: number;
  htsThreshold: number;
  partiesThreshold: number;
}

interface ClearPortContextType {
  entries: ShipmentEntry[];
  selectedEntryId: string;
  selectedEntry: ShipmentEntry | undefined;
  selectedExceptionId: string;
  selectedException: Exception | undefined;
  activeTab: string;
  rules: OperationalRules;
  undoStack: { entryId: string; exceptionId: string; previousState: Exception }[];
  auditLogs: { id: string; text: string; timestamp: string; type: 'info' | 'success' | 'warning' }[];
  theme: 'dark' | 'light';
  supabaseStatus: 'connected' | 'unconfigured' | 'error_tables' | 'loading';
  
  // Actions
  selectEntry: (id: string) => void;
  selectException: (id: string) => void;
  setActiveTab: (tab: string) => void;
  updateException: (entryId: string, exceptionId: string, status: 'Accepted' | 'Corrected' | 'Rejected', newValue?: string) => void;
  undoLastAction: () => void;
  acceptAllHighConfidence: (entryId: string) => void;
  simulateUpload: (shipmentId: string, files: { name: string; type: string }[]) => Promise<void>;
  updateRules: (newRules: Partial<OperationalRules>) => void;
  exportToCSV: (entryId: string) => void;
  toggleTheme: () => void;
  refreshSupabaseData: () => Promise<void>;
}

const ClearPortContext = React.createContext<ClearPortContextType | undefined>(undefined);

const initialEntries: ShipmentEntry[] = [
  {
    id: 'SHIP-2026-8802',
    shipper: 'AeroParts Global Inc.',
    consignee: 'Nexus Aerospace LLC',
    status: 'Under Review',
    docsCount: 4,
    urgency: '01:42:15',
    initialConfidence: 64,
    currentConfidence: 64,
    createdAt: '2026-07-10T01:10:00Z',
    exceptions: [
      {
        id: '8802-hts',
        fieldName: 'HTS Code - Titanium Fasteners',
        fieldKey: 'htsCode',
        originalValue: '8108.90.3060',
        extractedValue: '8108.90.3060',
        confidence: 55,
        reason: 'HTS classification suffix mismatch: Commercial Invoice lists 8108.90.3060, while Packing List lists 8108.90.3030.',
        docType: 'Commercial Invoice',
        boundingBox: { x: 58, y: 36, w: 24, h: 4 },
        status: 'Unresolved',
        history: [],
      },
      {
        id: '8802-value',
        fieldName: 'Total Declared Value',
        fieldKey: 'declaredValue',
        originalValue: '$128,450.00',
        extractedValue: '$128,450.00',
        confidence: 72,
        reason: "Physical crease on Commercial Invoice obscured character '8'; verify with packing list total.",
        docType: 'Commercial Invoice',
        boundingBox: { x: 68, y: 78, w: 20, h: 4 },
        status: 'Unresolved',
        history: [],
      },
      {
        id: '8802-weight',
        fieldName: 'Cargo Net Weight',
        fieldKey: 'netWeight',
        originalValue: '12,450 lbs',
        extractedValue: '12,450 lbs',
        confidence: 48,
        reason: 'Discrepancy of 1,800 lbs in net weight: Bill of Lading lists 12,450 lbs, while Packing List lists 14,250 lbs.',
        docType: 'Bill of Lading',
        boundingBox: { x: 40, y: 52, w: 26, h: 4 },
        status: 'Unresolved',
        history: [],
      },
    ],
    fields: [
      { key: 'invoiceNo', label: 'Commercial Invoice #', value: 'INV-8802-AP', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'invoiceDate', label: 'Invoice Date', value: '2026-07-08', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'shipper', label: 'Shipper / Exporter', value: 'AeroParts Global Inc.', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'consignee', label: 'Consignee / Importer', value: 'Nexus Aerospace LLC', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'declaredValue', label: 'Total Declared Value', value: '$128,450.00', sourceDoc: 'Commercial Invoice', isFlagged: true, exceptionId: '8802-value' },
      { key: 'htsCode', label: 'HTS Code (Primary Line)', value: '8108.90.3060', sourceDoc: 'Commercial Invoice', isFlagged: true, exceptionId: '8802-hts' },
      { key: 'netWeight', label: 'Total Net Weight', value: '12,450 lbs', sourceDoc: 'Bill of Lading', isFlagged: true, exceptionId: '8802-weight' },
      { key: 'portOfEntry', label: 'CBP Port of Entry', value: 'Los Angeles (LAX - 2720)', sourceDoc: 'CBP Form 3461', isFlagged: false },
      { key: 'carrier', label: 'Exporting Carrier', value: 'Pacific Ocean Air Cargo', sourceDoc: 'Bill of Lading', isFlagged: false },
      { key: 'billOfLading', label: 'House Bill of Lading', value: 'POL-449102-X', sourceDoc: 'Bill of Lading', isFlagged: false },
    ],
  },
  {
    id: 'SHIP-2026-9041',
    shipper: 'Vanguard Tech Shanghai',
    consignee: 'Nova Grid Solutions',
    status: 'Under Review',
    docsCount: 3,
    urgency: '04:12:00',
    initialConfidence: 78,
    currentConfidence: 78,
    createdAt: '2026-07-09T22:45:00Z',
    exceptions: [
      {
        id: '9041-origin',
        fieldName: 'Country of Origin',
        fieldKey: 'countryOfOrigin',
        originalValue: 'CN',
        extractedValue: 'CN',
        confidence: 52,
        reason: 'Country of Origin code mismatch: Commercial Invoice lists CN, while Certificate of Origin lists TW.',
        docType: 'Certificate of Origin',
        boundingBox: { x: 12, y: 16, w: 14, h: 4 },
        status: 'Unresolved',
        history: [],
      },
    ],
    fields: [
      { key: 'invoiceNo', label: 'Commercial Invoice #', value: 'VND-9041-SH', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'invoiceDate', label: 'Invoice Date', value: '2026-07-07', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'shipper', label: 'Shipper / Exporter', value: 'Vanguard Tech Shanghai', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'consignee', label: 'Consignee / Importer', value: 'Nova Grid Solutions', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'declaredValue', label: 'Total Declared Value', value: '$84,120.00', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'countryOfOrigin', label: 'Country of Origin', value: 'CN', sourceDoc: 'Commercial Invoice', isFlagged: true, exceptionId: '9041-origin' },
      { key: 'htsCode', label: 'HTS Code (Primary Line)', value: '8504.40.9580', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'netWeight', label: 'Total Net Weight', value: '4,120 lbs', sourceDoc: 'Packing List', isFlagged: false },
      { key: 'portOfEntry', label: 'CBP Port of Entry', value: 'Seattle (Tacoma - 3001)', sourceDoc: 'Commercial Invoice', isFlagged: false },
    ],
  },
  {
    id: 'SHIP-2026-4410',
    shipper: 'Precision Die-Cast GMBH',
    consignee: 'Midwest Machinery Works',
    status: 'Approved',
    docsCount: 3,
    urgency: 'RESOLVED',
    initialConfidence: 94,
    currentConfidence: 94,
    createdAt: '2026-07-09T18:15:00Z',
    exceptions: [],
    fields: [
      { key: 'invoiceNo', label: 'Commercial Invoice #', value: 'PDC-4410-DE', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'invoiceDate', label: 'Invoice Date', value: '2026-07-06', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'shipper', label: 'Shipper / Exporter', value: 'Precision Die-Cast GMBH', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'consignee', label: 'Consignee / Importer', value: 'Midwest Machinery Works', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'declaredValue', label: 'Total Declared Value', value: '$345,900.00', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'htsCode', label: 'HTS Code (Primary Line)', value: '8480.71.8010', sourceDoc: 'Commercial Invoice', isFlagged: false },
      { key: 'netWeight', label: 'Total Net Weight', value: '28,150 lbs', sourceDoc: 'Bill of Lading', isFlagged: false },
      { key: 'portOfEntry', label: 'CBP Port of Entry', value: 'Chicago (O\'Hare - 3901)', sourceDoc: 'CBP Form 3461', isFlagged: false },
    ],
  },
];

const initialLogs = [
  { id: 'log-1', text: 'System extracted 4 docs for SHIP-2026-8802', timestamp: '2026-07-10T01:12:00Z', type: 'info' as const },
  { id: 'log-2', text: '3 critical exceptions identified in SHIP-2026-8802', timestamp: '2026-07-10T01:13:10Z', type: 'warning' as const },
  { id: 'log-3', text: 'Auto-audited country codes matching on Certificate of Origin', timestamp: '2026-07-10T01:14:05Z', type: 'success' as const },
  { id: 'log-4', text: 'Invoice parsed successfully for SHIP-2026-9041', timestamp: '2026-07-09T22:46:12Z', type: 'info' as const },
  { id: 'log-5', text: 'syednasirbukhari033@gmail.com approved SHIP-2026-4410', timestamp: '2026-07-09T19:02:40Z', type: 'success' as const },
];

export const ClearPortProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [entries, setEntries] = React.useState<ShipmentEntry[]>(initialEntries);
  const [selectedEntryId, setSelectedEntryId] = React.useState<string>('SHIP-2026-8802');
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark');

  const toggleTheme = React.useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);
  const [selectedExceptionId, setSelectedExceptionId] = React.useState<string>('8802-hts');
  const [activeTab, setActiveTab] = React.useState<string>('exception-desk');
  const [rules, setRules] = React.useState<OperationalRules>({
    invoiceThreshold: 80,
    htsThreshold: 85,
    partiesThreshold: 75,
  });
  const [undoStack, setUndoStack] = React.useState<{ entryId: string; exceptionId: string; previousState: Exception }[]>([]);
  const [auditLogs, setAuditLogs] = React.useState(initialLogs);
  const [supabaseStatus, setSupabaseStatus] = React.useState<'connected' | 'unconfigured' | 'error_tables' | 'loading'>(
    isSupabaseConfigured() ? 'loading' : 'unconfigured'
  );

  const loadFromSupabase = React.useCallback(async () => {
    if (!isSupabaseConfigured()) {
      setSupabaseStatus('unconfigured');
      return;
    }
    
    try {
      setSupabaseStatus('loading');
      const dbShipments = await getSupabaseShipments();
      
      if (dbShipments === null) {
        setSupabaseStatus('error_tables');
        return;
      }

      // Fetch document fields to enrich shipments
      let fieldsData: any[] | null = null;
      try {
        fieldsData = await getSupabaseDocumentFields();
      } catch (err) {
        console.warn('Failed to load document fields, falling back to shipments JSON:', err);
      }

      const enrichShipmentsList = (shipments: ShipmentEntry[]) => {
        if (!fieldsData || fieldsData.length === 0) return shipments;
        return shipments.map(ship => {
          const shipFields = fieldsData!.filter(f => f.documents?.shipment_id === ship.id);
          if (shipFields.length > 0) {
            const fields: ExtractedField[] = shipFields.map(f => ({
              key: f.field_key,
              label: f.field_label,
              value: f.corrected_value || f.extracted_value,
              sourceDoc: f.documents?.doc_type || 'Document',
              isFlagged: f.is_flagged,
              exceptionId: f.is_flagged ? String(f.id) : undefined,
            }));

            const exceptions: Exception[] = shipFields
              .filter(f => f.is_flagged)
              .map(f => ({
                id: String(f.id),
                fieldName: f.field_label,
                fieldKey: f.field_key,
                originalValue: f.extracted_value,
                extractedValue: f.extracted_value,
                confidence: f.confidence,
                reason: f.exception_reason || `Extracted confidence (${f.confidence}%) is below threshold.`,
                docType: f.documents?.doc_type || 'Document',
                boundingBox: { x: 10, y: 10, w: 20, h: 4 },
                status: f.reviewer_action ? (f.reviewer_action as any) : 'Unresolved',
                correctedValue: f.corrected_value || undefined,
                history: [],
              }));

            return {
              ...ship,
              fields,
              exceptions,
            };
          }
          return ship;
        });
      };

      // If table exists but has no data, seed it!
      if (dbShipments.length === 0) {
        for (const entry of initialEntries) {
          await upsertSupabaseShipment(entry);
        }
        const seededShipments = await getSupabaseShipments();
        if (seededShipments) {
          setEntries(enrichShipmentsList(seededShipments));
        }
      } else {
        setEntries(enrichShipmentsList(dbShipments));
      }

      // Load Rules
      const dbRules = await getSupabaseRules();
      if (dbRules) {
        setRules(dbRules);
      } else {
        // Seed initial rules if empty
        await upsertSupabaseRules({
          invoiceThreshold: 80,
          htsThreshold: 85,
          partiesThreshold: 75,
        });
      }

      // Load Logs
      const dbLogs = await getSupabaseLogs();
      if (dbLogs && dbLogs.length > 0) {
        setAuditLogs(dbLogs.map(l => ({
          id: l.id,
          text: l.text,
          timestamp: l.timestamp,
          type: l.type as 'info' | 'success' | 'warning',
        })));
      } else {
        // Seed initial logs
        for (const log of initialLogs) {
          await insertSupabaseLog({
            id: log.id,
            text: log.text,
            timestamp: log.timestamp,
            type: log.type as 'info' | 'success' | 'warning',
          });
        }
      }

      setSupabaseStatus('connected');
    } catch (err) {
      console.error('Error loading data from Supabase:', err);
      setSupabaseStatus('error_tables');
    }
  }, []);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      loadFromSupabase();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadFromSupabase]);

  const refreshSupabaseData = React.useCallback(async () => {
    await loadFromSupabase();
  }, [loadFromSupabase]);

  // Computed values
  const selectedEntry = React.useMemo(() => {
    return entries.find((e) => e.id === selectedEntryId);
  }, [entries, selectedEntryId]);

  const selectedException = React.useMemo(() => {
    if (!selectedEntry) return undefined;
    return selectedEntry.exceptions.find((ex) => ex.id === selectedExceptionId);
  }, [selectedEntry, selectedExceptionId]);

  // Adjust selections automatically if shipment changes
  const selectEntry = React.useCallback((id: string) => {
    setSelectedEntryId(id);
    const entry = entries.find((e) => e.id === id);
    if (entry && entry.exceptions.length > 0) {
      // Find first unresolved exception if any
      const unresolved = entry.exceptions.find(e => e.status === 'Unresolved');
      setSelectedExceptionId(unresolved ? unresolved.id : entry.exceptions[0].id);
    } else {
      setSelectedExceptionId('');
    }
  }, [entries]);

  const selectException = React.useCallback((id: string) => {
    setSelectedExceptionId(id);
  }, []);

  const updateRules = React.useCallback((newRules: Partial<OperationalRules>) => {
    setRules((prev) => {
      const updated = { ...prev, ...newRules };
      if (isSupabaseConfigured()) {
        upsertSupabaseRules(updated);
      }
      return updated;
    });
    setAuditLogs((prev) => {
      const newLog = {
        id: `log-${Date.now()}`,
        text: `Compliance operational thresholds updated.`,
        timestamp: new Date().toISOString(),
        type: 'info' as const,
      };
      if (isSupabaseConfigured()) {
        insertSupabaseLog(newLog);
      }
      return [newLog, ...prev];
    });
  }, []);

  // Accept, edit, or reject exception
  const updateException = React.useCallback(
    (entryId: string, exceptionId: string, status: 'Accepted' | 'Corrected' | 'Rejected', newValue?: string) => {
      setEntries((prevEntries) => {
        return prevEntries.map((entry) => {
          if (entry.id !== entryId) return entry;

          const previousException = entry.exceptions.find((ex) => ex.id === exceptionId);
          if (!previousException) return entry;

          // Push to undo stack
          setUndoStack((prevStack) => [
            { entryId, exceptionId, previousState: { ...previousException } },
            ...prevStack,
          ]);

          const updatedExceptions = entry.exceptions.map((ex) => {
            if (ex.id !== exceptionId) return ex;

            const oldVal = ex.correctedValue || ex.extractedValue;
            const updatedVal = newValue !== undefined ? newValue : ex.extractedValue;

            const historyItem = {
              user: 'syednasirbukhari033@gmail.com',
              oldValue: oldVal,
              newValue: updatedVal,
              timestamp: new Date().toISOString(),
              action: status,
            };

            return {
              ...ex,
              status,
              correctedValue: status === 'Corrected' ? newValue : undefined,
              history: [historyItem, ...ex.history],
            };
          });

          // Check if all exceptions are resolved
          const allResolved = updatedExceptions.every((ex) => ex.status !== 'Unresolved');
          const newStatus = (allResolved ? 'Approved' : 'Under Review') as 'Under Review' | 'Approved' | 'Exported';

          // Recalculate confidence score dynamically
          // Every resolved exception increases confidence score towards 100%
          const resolvedCount = updatedExceptions.filter((ex) => ex.status !== 'Unresolved').length;
          const totalExc = updatedExceptions.length;
          const confidenceBoost = totalExc > 0 ? ((100 - entry.initialConfidence) * (resolvedCount / totalExc)) : 0;
          const currentConfidence = Math.min(100, Math.round(entry.initialConfidence + confidenceBoost));

          // Also update fields values to sync values inline!
          const updatedFields = entry.fields.map((f) => {
            if (f.exceptionId === exceptionId) {
              const updatedVal = status === 'Corrected' ? (newValue || f.value) : f.value;
              return {
                ...f,
                value: updatedVal,
                isFlagged: false, // resolving clears the active error flag
              };
            }
            return f;
          });

          // Create audit log
          const logText = `Exception "${previousException.fieldName}" for ${entryId} was ${status.toLowerCase()}${
            status === 'Corrected' ? ` to "${newValue}"` : ''
          } by syednasirbukhari033@gmail.com.`;
          
          const newLog = {
            id: `log-${Date.now()}`,
            text: logText,
            timestamp: new Date().toISOString(),
            type: status === 'Rejected' ? 'warning' as const : 'success' as const,
          };

          if (isSupabaseConfigured()) {
            insertSupabaseLog(newLog);
          }

          setAuditLogs((prevLogs) => [newLog, ...prevLogs]);

          const updatedEntry = {
            ...entry,
            status: newStatus,
            exceptions: updatedExceptions,
            fields: updatedFields,
            currentConfidence,
          };

          if (isSupabaseConfigured()) {
            upsertSupabaseShipment(updatedEntry);
            if (exceptionId && !isNaN(Number(exceptionId))) {
              updateSupabaseDocumentField(Number(exceptionId), status, newValue);
            }
          }

          return updatedEntry;
        });
      });
    },
    []
  );

  const undoLastAction = React.useCallback(() => {
    if (undoStack.length === 0) return;

    const [lastAction, ...remainingStack] = undoStack;
    setUndoStack(remainingStack);

    setEntries((prevEntries) => {
      return prevEntries.map((entry) => {
        if (entry.id !== lastAction.entryId) return entry;

        const updatedExceptions = entry.exceptions.map((ex) => {
          if (ex.id !== lastAction.exceptionId) return ex;
          return lastAction.previousState;
        });

        const allResolved = updatedExceptions.every((ex) => ex.status !== 'Unresolved');
        const newStatus = (allResolved ? 'Approved' : 'Under Review') as 'Under Review' | 'Approved' | 'Exported';

        const resolvedCount = updatedExceptions.filter((ex) => ex.status !== 'Unresolved').length;
        const totalExc = updatedExceptions.length;
        const confidenceBoost = totalExc > 0 ? ((100 - entry.initialConfidence) * (resolvedCount / totalExc)) : 0;
        const currentConfidence = Math.min(100, Math.round(entry.initialConfidence + confidenceBoost));

        // Restore field flags
        const restoredException = lastAction.previousState;
        const updatedFields = entry.fields.map((f) => {
          if (f.exceptionId === lastAction.exceptionId) {
            return {
              ...f,
              value: restoredException.status === 'Corrected' ? (restoredException.correctedValue || f.value) : restoredException.extractedValue,
              isFlagged: restoredException.status === 'Unresolved',
            };
          }
          return f;
        });

        const updatedEntry = {
          ...entry,
          status: newStatus,
          exceptions: updatedExceptions,
          fields: updatedFields,
          currentConfidence,
        };

        if (isSupabaseConfigured()) {
          upsertSupabaseShipment(updatedEntry);
        }

        return updatedEntry;
      });
    });

    const newLog = {
      id: `log-${Date.now()}`,
      text: `Undo applied for last review action on shipment ${lastAction.entryId}`,
      timestamp: new Date().toISOString(),
      type: 'info' as const,
    };

    if (isSupabaseConfigured()) {
      insertSupabaseLog(newLog);
    }

    setAuditLogs((prevLogs) => [newLog, ...prevLogs]);
  }, [undoStack]);

  const acceptAllHighConfidence = React.useCallback((entryId: string) => {
    setEntries((prevEntries) => {
      return prevEntries.map((entry) => {
        if (entry.id !== entryId) return entry;

        let acceptedCount = 0;
        const updatedExceptions = entry.exceptions.map((ex) => {
          if (ex.status === 'Unresolved' && ex.confidence >= 70) {
            acceptedCount++;
            const historyItem = {
              user: 'syednasirbukhari033@gmail.com',
              oldValue: ex.extractedValue,
              newValue: ex.extractedValue,
              timestamp: new Date().toISOString(),
              action: 'Accepted' as const,
            };
            return {
              ...ex,
              status: 'Accepted' as const,
              history: [historyItem, ...ex.history],
            };
          }
          return ex;
        });

        if (acceptedCount === 0) return entry;

        const allResolved = updatedExceptions.every((ex) => ex.status !== 'Unresolved');
        const newStatus = (allResolved ? 'Approved' : 'Under Review') as 'Under Review' | 'Approved' | 'Exported';

        const resolvedCount = updatedExceptions.filter((ex) => ex.status !== 'Unresolved').length;
        const totalExc = updatedExceptions.length;
        const confidenceBoost = totalExc > 0 ? ((100 - entry.initialConfidence) * (resolvedCount / totalExc)) : 0;
        const currentConfidence = Math.min(100, Math.round(entry.initialConfidence + confidenceBoost));

        // Sync field values
        const updatedFields = entry.fields.map((f) => {
          const exception = updatedExceptions.find((ex) => ex.id === f.exceptionId);
          if (exception) {
            return {
              ...f,
              isFlagged: exception.status === 'Unresolved',
            };
          }
          return f;
        });

        const newLog = {
          id: `log-${Date.now()}`,
          text: `Batch action: Approved ${acceptedCount} high-confidence exceptions in ${entryId}.`,
          timestamp: new Date().toISOString(),
          type: 'success' as const,
        };

        if (isSupabaseConfigured()) {
          insertSupabaseLog(newLog);
          updatedExceptions.forEach((ex) => {
            if (ex.status === 'Accepted' && ex.id && !isNaN(Number(ex.id))) {
              if (ex.confidence >= 70) {
                updateSupabaseDocumentField(Number(ex.id), 'Accepted');
              }
            }
          });
        }

        setAuditLogs((prevLogs) => [newLog, ...prevLogs]);

        const updatedEntry = {
          ...entry,
          status: newStatus,
          exceptions: updatedExceptions,
          fields: updatedFields,
          currentConfidence,
        };

        if (isSupabaseConfigured()) {
          upsertSupabaseShipment(updatedEntry);
        }

        return updatedEntry;
      });
    });
  }, []);

  // Simulate document ingest and fields extraction
  const simulateUpload = React.useCallback(async (shipmentId: string, files: { name: string; type: string }[]) => {
    // Return a promise that resolves once simulation completes
    // The visual stepper is handled in Page 2.
    // This adds the entry to the state.
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
      exceptions: [
        {
          id: `${shipmentId}-address`,
          fieldName: 'Consignee Corporate Address',
          fieldKey: 'consigneeAddress',
          originalValue: 'Suite 200, Seattle, WA',
          extractedValue: 'Suite 200, Seattle, WA',
          confidence: 62,
          reason: 'Address abbreviation mismatch: Commercial Invoice lists "Suite 200, Seattle, WA" while Bill of Lading shows "Suite 201, Seattle, WA".',
          docType: 'Bill of Lading',
          boundingBox: { x: 10, y: 35, w: 32, h: 5 },
          status: 'Unresolved',
          history: [],
        },
      ],
      fields: [
        { key: 'invoiceNo', label: 'Commercial Invoice #', value: 'TC-9921-KK', sourceDoc: 'Commercial Invoice', isFlagged: false },
        { key: 'invoiceDate', label: 'Invoice Date', value: new Date().toISOString().split('T')[0], sourceDoc: 'Commercial Invoice', isFlagged: false },
        { key: 'shipper', label: 'Shipper / Exporter', value: 'Titanium Castings KK', sourceDoc: 'Commercial Invoice', isFlagged: false },
        { key: 'consignee', label: 'Consignee / Importer', value: 'Ironclad Logistics Inc.', sourceDoc: 'Commercial Invoice', isFlagged: false },
        { key: 'consigneeAddress', label: 'Consignee Address', value: 'Suite 200, Seattle, WA', sourceDoc: 'Commercial Invoice', isFlagged: true, exceptionId: `${shipmentId}-address` },
        { key: 'declaredValue', label: 'Total Declared Value', value: '$45,210.00', sourceDoc: 'Commercial Invoice', isFlagged: false },
        { key: 'htsCode', label: 'HTS Code (Primary Line)', value: '7308.90.0000', sourceDoc: 'Commercial Invoice', isFlagged: false },
        { key: 'netWeight', label: 'Total Net Weight', value: '8,410 lbs', sourceDoc: 'Bill of Lading', isFlagged: false },
      ],
    };

    if (isSupabaseConfigured()) {
      upsertSupabaseShipment(newEntry);
    }

    setEntries((prev) => [newEntry, ...prev]);
    setSelectedEntryId(shipmentId);
    setSelectedExceptionId(`${shipmentId}-address`);

    const newLog = {
      id: `log-${Date.now()}`,
      text: `New entry ${shipmentId} ingestion and auto-analysis completed with 1 exception.`,
      timestamp: new Date().toISOString(),
      type: 'info' as const,
    };

    if (isSupabaseConfigured()) {
      insertSupabaseLog(newLog);
    }

    setAuditLogs((prev) => [newLog, ...prev]);
  }, []);

  const exportToCSV = React.useCallback((entryId: string) => {
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;

    // Simulate CSV file download trigger
    setAuditLogs((prev) => [
      {
        id: `log-${Date.now()}`,
        text: `Audit logs exported to CSV for ${entryId}. File "ClearPort_Audit_${entryId}.csv" triggered.`,
        timestamp: new Date().toISOString(),
        type: 'success' as const,
      },
      ...prev,
    ]);
  }, [entries]);

  return (
    <ClearPortContext.Provider
      value={{
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
        selectEntry,
        selectException,
        setActiveTab,
        updateException,
        undoLastAction,
        acceptAllHighConfidence,
        simulateUpload,
        updateRules,
        exportToCSV,
        toggleTheme,
        refreshSupabaseData,
      }}
    >
      {children}
    </ClearPortContext.Provider>
  );
};

export const useClearPort = () => {
  const context = React.useContext(ClearPortContext);
  if (context === undefined) {
    throw new Error('useClearPort must be used within a ClearPortProvider');
  }
  return context;
};

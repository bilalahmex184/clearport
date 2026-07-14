import { createClient } from '@supabase/supabase-js';
import { ShipmentEntry, Exception, ExtractedField } from '../context/ClearPortContext';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Lazy initialization of Supabase client to prevent startup crashes when keys are missing.
export const supabase = supabaseUrl && supabaseAnonKey 
  ? createClient(supabaseUrl, supabaseAnonKey) 
  : null;

export const isSupabaseConfigured = (): boolean => {
  return !!supabaseUrl && !!supabaseAnonKey && !!supabase;
};

// Interface for database shipment row
export interface DbShipment {
  id: string;
  shipper: string;
  consignee: string;
  status: 'Under Review' | 'Approved' | 'Exported';
  docs_count: number;
  urgency: string;
  initial_confidence: number;
  current_confidence: number;
  exceptions: Exception[]; // typed Exception JSON array
  fields: ExtractedField[]; // typed fields JSON array
  created_at: string;
}

// Convert from DB representation to state interface
export function mapDbToShipment(db: DbShipment): ShipmentEntry {
  return {
    id: db.id,
    shipper: db.shipper,
    consignee: db.consignee,
    status: db.status,
    docsCount: db.docs_count,
    urgency: db.urgency,
    initialConfidence: db.initial_confidence,
    currentConfidence: db.current_confidence,
    exceptions: (db.exceptions || []) as Exception[],
    fields: (db.fields || []) as ExtractedField[],
    createdAt: db.created_at,
  };
}

// Convert from state interface to DB representation
export function mapShipmentToDb(entry: ShipmentEntry): DbShipment {
  return {
    id: entry.id,
    shipper: entry.shipper,
    consignee: entry.consignee,
    status: entry.status,
    docs_count: entry.docsCount,
    urgency: entry.urgency,
    initial_confidence: entry.initialConfidence,
    current_confidence: entry.currentConfidence,
    exceptions: entry.exceptions,
    fields: entry.fields,
    created_at: entry.createdAt,
  };
}

// Database Operational Rules interface
export interface DbRules {
  id: string;
  invoice_threshold: number;
  hts_threshold: number;
  parties_threshold: number;
  updated_at: string;
}

// Database Audit Log interface
export interface DbAuditLog {
  id: string;
  text: string;
  timestamp: string;
  type: 'info' | 'success' | 'warning';
}

// Database Document Field Join interface
export interface DbDocumentField {
  id: number;
  document_id: string;
  field_key: string;
  field_label: string;
  extracted_value: string;
  confidence: number;
  is_flagged: boolean;
  exception_reason: string | null;
  corrected_value: string | null;
  reviewer_action: 'Accepted' | 'Corrected' | 'Rejected' | null;
  updated_at: string;
  documents: {
    shipment_id: string;
    doc_type: string;
    file_name: string;
  } | null;
}

/**
 * Fetch all shipments from Supabase.
 * Returns null if Supabase is not configured or if table doesn't exist yet.
 */
export async function getSupabaseShipments(): Promise<ShipmentEntry[] | null> {
  if (!supabase) {
    console.log(`[${new Date().toISOString()}] [INFO] Supabase client is unconfigured. Skipping shipment fetch.`);
    return null;
  }
  
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] [DB_QUERY] Fetching shipments from database...`);
  
  try {
    const { data, error } = await supabase
      .from('shipments')
      .select('id, shipper, consignee, status, docs_count, urgency, initial_confidence, current_confidence, exceptions, fields, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.warn(`[${new Date().toISOString()}] [DB_WARN] Query failed (table may not be created yet): ${error.message}`);
      return null;
    }
    
    console.log(`[${new Date().toISOString()}] [DB_SUCCESS] Fetched ${(data || []).length} shipments in ${Date.now() - startTime}ms.`);
    return (data as unknown as DbShipment[]).map(mapDbToShipment);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [DB_ERROR] Failed fetching shipments:`, err);
    return null;
  }
}

/**
 * Fetch all document fields from Supabase, joined to documents (which has shipment_id).
 */
export async function getSupabaseDocumentFields(): Promise<DbDocumentField[] | null> {
  if (!supabase) {
    console.log(`[${new Date().toISOString()}] [INFO] Supabase client is unconfigured. Skipping fields fetch.`);
    return null;
  }

  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] [DB_QUERY] Fetching document fields with document joins...`);

  try {
    const { data, error } = await supabase
      .from('document_fields')
      .select(`
        id,
        document_id,
        field_key,
        field_label,
        extracted_value,
        confidence,
        is_flagged,
        exception_reason,
        corrected_value,
        reviewer_action,
        updated_at,
        documents (
          shipment_id,
          doc_type,
          file_name
        )
      `);

    if (error) {
      console.warn(`[${new Date().toISOString()}] [DB_WARN] Query failed (document_fields may not exist): ${error.message}`);
      return null;
    }
    
    console.log(`[${new Date().toISOString()}] [DB_SUCCESS] Fetched ${(data || []).length} document fields in ${Date.now() - startTime}ms.`);
    return data as unknown as DbDocumentField[];
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [DB_ERROR] Failed fetching document fields:`, err);
    return null;
  }
}

/**
 * Update a document field action and status in Supabase.
 */
export async function updateSupabaseDocumentField(
  fieldId: number, 
  status: 'Accepted' | 'Corrected' | 'Rejected', 
  correctedValue?: string
): Promise<boolean> {
  if (!supabase) return false;

  console.log(`[${new Date().toISOString()}] [DB_ACTION] Updating field ID ${fieldId} to "${status}"...`);

  try {
    const { error } = await supabase
      .from('document_fields')
      .update({
        reviewer_action: status,
        corrected_value: status === 'Corrected' ? correctedValue : null,
        is_flagged: false, // Resolving a field clears the flag
        updated_at: new Date().toISOString()
      })
      .eq('id', fieldId);

    if (error) {
      console.error(`[${new Date().toISOString()}] [DB_ERROR] Update failed for field ID ${fieldId}:`, error.message);
      return false;
    }
    
    console.log(`[${new Date().toISOString()}] [DB_SUCCESS] Updated field ID ${fieldId} successfully.`);
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [DB_ERROR] Exception in updateSupabaseDocumentField:`, err);
    return false;
  }
}

/**
 * Upsert a shipment in Supabase.
 */
export async function upsertSupabaseShipment(entry: ShipmentEntry): Promise<boolean> {
  if (!supabase) return false;

  console.log(`[${new Date().toISOString()}] [DB_ACTION] Upserting shipment "${entry.id}"...`);

  try {
    const dbRow = mapShipmentToDb(entry);
    const { error } = await supabase
      .from('shipments')
      .upsert(dbRow, { onConflict: 'id' });

    if (error) {
      console.error(`[${new Date().toISOString()}] [DB_ERROR] Upsert failed for shipment "${entry.id}":`, error.message);
      return false;
    }

    console.log(`[${new Date().toISOString()}] [DB_SUCCESS] Upserted shipment "${entry.id}" successfully.`);
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [DB_ERROR] Exception in upsertSupabaseShipment:`, err);
    return false;
  }
}

/**
 * Fetch operational rules from Supabase.
 */
export async function getSupabaseRules(): Promise<{ invoiceThreshold: number; htsThreshold: number; partiesThreshold: number } | null> {
  if (!supabase) return null;

  console.log(`[${new Date().toISOString()}] [DB_QUERY] Fetching operational rules config...`);

  try {
    const { data, error } = await supabase
      .from('operational_rules')
      .select('id, invoice_threshold, hts_threshold, parties_threshold, updated_at')
      .eq('id', 'default_config')
      .single();

    if (error) {
      if (error.code !== 'PGRST116') { // PGRST116 is code for "no rows returned" which is fine
        console.warn(`[${new Date().toISOString()}] [DB_WARN] Failed to fetch operational rules: ${error.message}`);
      }
      return null;
    }
    
    const dbRules = data as unknown as DbRules;
    console.log(`[${new Date().toISOString()}] [DB_SUCCESS] Fetched operational rules thresholds.`);
    return {
      invoiceThreshold: dbRules.invoice_threshold,
      htsThreshold: dbRules.hts_threshold,
      partiesThreshold: dbRules.parties_threshold,
    };
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [DB_ERROR] Exception in getSupabaseRules:`, err);
    return null;
  }
}

/**
 * Upsert operational rules in Supabase.
 */
export async function upsertSupabaseRules(rules: { invoiceThreshold: number; htsThreshold: number; partiesThreshold: number }): Promise<boolean> {
  if (!supabase) return false;

  console.log(`[${new Date().toISOString()}] [DB_ACTION] Saving updated operational rules...`);

  try {
    const dbRow: DbRules = {
      id: 'default_config',
      invoice_threshold: rules.invoiceThreshold,
      hts_threshold: rules.htsThreshold,
      parties_threshold: rules.partiesThreshold,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('operational_rules')
      .upsert(dbRow, { onConflict: 'id' });

    if (error) {
      console.error(`[${new Date().toISOString()}] [DB_ERROR] Upsert failed for rules:`, error.message);
      return false;
    }

    console.log(`[${new Date().toISOString()}] [DB_SUCCESS] Saved operational rules.`);
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [DB_ERROR] Exception in upsertSupabaseRules:`, err);
    return false;
  }
}

/**
 * Fetch audit logs from Supabase.
 */
export async function getSupabaseLogs(): Promise<DbAuditLog[] | null> {
  if (!supabase) return null;

  console.log(`[${new Date().toISOString()}] [DB_QUERY] Fetching latest 50 audit logs...`);

  try {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('id, text, timestamp, type')
      .order('timestamp', { ascending: false })
      .limit(50);

    if (error) {
      console.warn(`[${new Date().toISOString()}] [DB_WARN] Failed to fetch logs: ${error.message}`);
      return null;
    }

    console.log(`[${new Date().toISOString()}] [DB_SUCCESS] Fetched ${(data || []).length} logs successfully.`);
    return data as unknown as DbAuditLog[];
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [DB_ERROR] Exception in getSupabaseLogs:`, err);
    return null;
  }
}

/**
 * Insert a new audit log in Supabase.
 */
export async function insertSupabaseLog(log: DbAuditLog): Promise<boolean> {
  if (!supabase) return false;

  console.log(`[${new Date().toISOString()}] [DB_ACTION] Logging system audit event: "${log.text.slice(0, 45)}..."`);

  try {
    const { error } = await supabase
      .from('audit_logs')
      .insert(log);

    if (error) {
      console.error(`[${new Date().toISOString()}] [DB_ERROR] Insert failed for audit log:`, error.message);
      return false;
    }

    console.log(`[${new Date().toISOString()}] [DB_SUCCESS] Appended system audit log record.`);
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [DB_ERROR] Exception in insertSupabaseLog:`, err);
    return false;
  }
}

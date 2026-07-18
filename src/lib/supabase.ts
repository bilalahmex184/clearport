// ============================================================================
// ClearPort — Supabase Client + Data Access Layer
// ============================================================================

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  DbShipment,
  DbDocument,
  DbDocumentField,
  DbException,
  DbOperationalRules,
  DbAuditLog,
  ShipmentEntry,
  ExtractedField,
  Exception,
  ExceptionStatus,
  ReviewerAction,
  OperationalRules,
  AuditLog,
  ShipmentStatus,
  DocType,
  BoundingBox,
} from './clearport-types';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Lazy singleton — created on first use
let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  if (!_client) {
    _client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return _client;
}

export const supabase = getSupabase();

export function isSupabaseConfigured(): boolean {
  return !!supabaseUrl && !!supabaseAnonKey && !!supabase;
}

// ============================================================================
// AUTH — real accounts (email/password), with optional demo mode
// ============================================================================
// Production: users sign in via /login (supabase.auth.signInWithPassword)
// or sign up via /signup (supabase.auth.signUp). The proxy (src/proxy.ts)
// redirects unauthenticated users to /login on protected routes.
//
// Demo mode: if NEXT_PUBLIC_DEMO_MODE=true, ensureAuthenticated() falls back
// to anonymous sign-in so the app works without a login page (for local
// demos / CI smoke tests). Defaults to OFF — anonymous sign-in is never used
// in production unless explicitly enabled.
// ============================================================================

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
let _anonSignInPromise: Promise<boolean> | null = null;

/**
 * Ensure the client has an authenticated session.
 *
 * In production (default): returns true if there's a real session, false
 * otherwise. Does NOT auto-create anonymous sessions — the caller (page/proxy)
 * is responsible for redirecting to /login if false.
 *
 * In demo mode (NEXT_PUBLIC_DEMO_MODE=true): falls back to anonymous sign-in
 * so the app works without a login page. This is for local demos only.
 */
export async function ensureAuthenticated(): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;

  try {
    const { data: { session } } = await client.auth.getSession();
    if (session) return true;

    // Demo mode only: auto-create anonymous sessions
    if (DEMO_MODE) {
      if (!_anonSignInPromise) {
        _anonSignInPromise = client.auth.signInAnonymously()
          .then(({ data, error }) => {
            if (error) {
              console.warn('[auth] demo-mode anonymous sign-in failed:', error.message);
              return false;
            }
            return !!data.session;
          })
          .finally(() => {
            _anonSignInPromise = null;
          });
      }
      return _anonSignInPromise;
    }

    // Production: no session, no demo mode → not authenticated
    return false;
  } catch (err) {
    console.warn('[auth] ensureAuthenticated error:', err);
    return false;
  }
}

/**
 * Returns the current authenticated user's email, or a placeholder only in
 * demo mode. In production, returns null if no session (caller should
 * redirect to /login).
 */
export async function getCurrentUserEmail(): Promise<string | null> {
  const client = getSupabase();
  if (!client) return DEMO_MODE ? 'demo@clearport.local' : null;
  const { data: { user } } = await client.auth.getUser();
  if (user?.email) return user.email;
  if (DEMO_MODE && user?.id) return `anon-${user.id.slice(0, 8)}@clearport.local`;
  return DEMO_MODE ? 'demo@clearport.local' : null;
}

/**
 * Check if demo mode is enabled (anonymous sign-in fallback).
 */
export function isDemoMode(): boolean {
  return DEMO_MODE;
}

// ============================================================================
// EDGE FUNCTION INVOCATION HELPER
// ============================================================================

export async function invokeEdgeFunction<T = any>(
  name: string,
  body?: Record<string, any>,
  options?: { method?: 'POST' | 'GET' }
): Promise<T> {
  const client = getSupabase();
  if (!client) throw new Error('Supabase not configured');

  await ensureAuthenticated();

  const { data, error } = await client.functions.invoke(name, {
    body: body || {},
    method: options?.method || 'POST',
  });

  if (error) {
    throw new Error(`Edge function "${name}" failed: ${error.message}`);
  }

  return data as T;
}

// ============================================================================
// API ROUTE HELPERS
// These wrap fetch() calls to the new /api/* Next.js route handlers.
// The routes require a Bearer JWT (from the anonymous Supabase session) so
// they can build a user-scoped client and enforce RLS on every query.
// ============================================================================

/**
 * Returns the current session's access token (or null if no session / no
 * client). Used as the Bearer token for /api/* route calls.
 */
export async function getAuthToken(): Promise<string | null> {
  const client = getSupabase();
  if (!client) return null;
  try {
    const { data: { session } } = await client.auth.getSession();
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Thin fetch() wrapper that:
 *  1. Ensures the anonymous session exists (so a JWT is available).
 *  2. Attaches `Authorization: Bearer <jwt>` to every request.
 *  3. Sets `Content-Type: application/json` for requests with a body.
 *  4. Throws an Error on non-2xx responses (with the response body text for
 *     debugging) so callers can try/catch and fall back to seed data.
 *
 * Returns the parsed JSON body. For non-JSON responses (e.g. CSV), pass
 * `raw: true` to get the Response object back instead.
 */
export async function apiFetch<T = any>(
  path: string,
  options: RequestInit & { raw?: boolean } = {},
): Promise<T> {
  const client = getSupabase();
  if (client) {
    await ensureAuthenticated();
  }

  const token = await getAuthToken();

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  // Only set Content-Type for requests with a body (GET shouldn't set it
  // because some browsers/proxies complain about a Content-Type with no body).
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, { ...options, headers });

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`API ${path} failed (${res.status}): ${detail}`);
  }

  if (options.raw) {
    return res as unknown as T;
  }
  return res.json() as Promise<T>;
}

// ============================================================================
// MAPPING — DB rows (snake_case) → Frontend state (camelCase)
// ============================================================================

export function mapDbToShipment(
  db: DbShipment,
  fields: DbDocumentField[],
  exceptions: DbException[],
  documents: DbDocument[]
): ShipmentEntry {
  const mappedFields: ExtractedField[] = fields.map(mapDbToField);
  const mappedExceptions: Exception[] = exceptions.map(mapDbToException);

  return {
    id: db.id,
    shipper: db.shipper,
    consignee: db.consignee,
    status: db.status,
    docsCount: db.docs_count,
    urgency: db.urgency,
    initialConfidence: db.initial_confidence,
    currentConfidence: db.current_confidence,
    exceptions: mappedExceptions,
    fields: mappedFields,
    documents: documents.map(d => ({
      id: d.id,
      docType: d.doc_type,
      fileName: d.file_name,
      storagePath: d.storage_path,
      mimeType: d.mime_type,
      uploadedAt: d.uploaded_at,
    })),
    createdAt: db.created_at,
    validationStatus: (db as any).validation_status || 'pending',
    lastValidatedAt: (db as any).last_validated_at || undefined,
    pipelineTraceId: (db as any).pipeline_trace_id || undefined,
  };
}

export function mapDbToField(db: DbDocumentField): ExtractedField {
  const exceptionId = db.is_flagged ? db.id : undefined;
  return {
    id: db.id,
    key: db.field_key,
    label: db.field_label,
    value: db.corrected_value || db.extracted_value || '',
    sourceDoc: 'Document',
    isFlagged: db.is_flagged,
    exceptionId,
    confidence: db.confidence,
    correctedValue: db.corrected_value || undefined,
    crossDocValue: db.cross_doc_value || undefined,
    crossDocSource: db.cross_doc_source || undefined,
    boundingBox: db.bounding_box || undefined,
  };
}

export function mapDbToException(db: DbException): Exception {
  return {
    id: db.id,
    fieldName: db.field_name,
    fieldKey: db.field_key,
    originalValue: db.original_value || '',
    extractedValue: db.extracted_value || '',
    crossDocValue: db.cross_doc_value || undefined,
    confidence: db.confidence,
    reason: db.reason,
    explanation: (db as any).explanation || undefined,
    exceptionType: db.exception_type,
    docType: db.doc_type || 'Document',
    boundingBox: db.bounding_box || { x: 10, y: 10, w: 20, h: 4 },
    status: db.status,
    correctedValue: db.corrected_value || undefined,
    history: db.history || [],
    fieldId: db.field_id || undefined,
    createdAt: db.created_at,
    resolvedAt: db.resolved_at || undefined,
    resolvedBy: db.resolved_by || undefined,
  };
}

export function mapDbToAuditLog(db: DbAuditLog): AuditLog {
  return {
    id: db.id,
    text: db.text,
    timestamp: db.timestamp,
    type: db.type,
    shipmentId: db.shipment_id || undefined,
  };
}

export function mapDbToRules(db: DbOperationalRules): OperationalRules {
  return {
    invoiceThreshold: db.invoice_threshold,
    htsThreshold: db.hts_threshold,
    partiesThreshold: db.parties_threshold,
  };
}

// ============================================================================
// DATA ACCESS — thin wrappers over Supabase queries
// Used as fallback when edge functions aren't deployed
// ============================================================================

export async function fetchShipmentsDirect(): Promise<ShipmentEntry[] | null> {
  const client = getSupabase();
  if (!client) return null;

  try {
    const { data: shipments, error } = await client
      .from('shipments')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('[db] fetchShipments error:', error.message);
      return null;
    }

    if (!shipments || shipments.length === 0) return [];

    const shipmentIds = shipments.map(s => s.id);

    // Fetch related data in parallel
    const [fieldsRes, exceptionsRes, documentsRes] = await Promise.all([
      client.from('document_fields').select('*').in('shipment_id', shipmentIds),
      client.from('exceptions').select('*').in('shipment_id', shipmentIds),
      client.from('documents').select('*').in('shipment_id', shipmentIds),
    ]);

    if (fieldsRes.error) console.warn('[db] fields error:', fieldsRes.error.message);
    if (exceptionsRes.error) console.warn('[db] exceptions error:', exceptionsRes.error.message);
    if (documentsRes.error) console.warn('[db] documents error:', documentsRes.error.message);

    return shipments.map((s: DbShipment) => {
      const fields = (fieldsRes.data || []).filter(f => f.shipment_id === s.id) as DbDocumentField[];
      const exceptions = (exceptionsRes.data || []).filter(e => e.shipment_id === s.id) as DbException[];
      const documents = (documentsRes.data || []).filter(d => d.shipment_id === s.id) as DbDocument[];
      return mapDbToShipment(s, fields, exceptions, documents);
    });
  } catch (err) {
    console.error('[db] fetchShipmentsDirect error:', err);
    return null;
  }
}

export async function fetchRulesDirect(): Promise<OperationalRules | null> {
  const client = getSupabase();
  if (!client) return null;

  const { data, error } = await client
    .from('operational_rules')
    .select('*')
    .eq('id', 'default_config')
    .single();

  if (error) return null;
  return mapDbToRules(data as DbOperationalRules);
}

export async function fetchLogsDirect(): Promise<AuditLog[] | null> {
  const client = getSupabase();
  if (!client) return null;

  const { data, error } = await client
    .from('audit_logs')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(50);

  if (error) return null;
  return (data || []).map(mapDbToAuditLog);
}

// ============================================================================
// SEED DATA — used when DB is empty or in fallback mode
// ============================================================================

export const seedEntries: ShipmentEntry[] = [
  {
    id: 'SHIP-2026-8802',
    shipper: 'AeroParts Global Inc.',
    consignee: 'Nexus Aerospace LLC',
    status: 'Under Review',
    docsCount: 4,
    urgency: '01:42:15',
    initialConfidence: 64,
    currentConfidence: 64,
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    documents: [],
    exceptions: [
      {
        id: '8802-hts',
        fieldName: 'HTS Code - Titanium Fasteners',
        fieldKey: 'htsCode',
        originalValue: '8108.90.3060',
        extractedValue: '8108.90.3060',
        crossDocValue: '8108.90.3030',
        confidence: 55,
        reason: 'HTS classification suffix mismatch: Commercial Invoice lists 8108.90.3060, while Packing List lists 8108.90.3030.',
        exceptionType: 'cross_doc_mismatch',
        docType: 'Commercial Invoice',
        boundingBox: { x: 58, y: 36, w: 24, h: 4 },
        status: 'Unresolved',
        history: [],
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: '8802-value',
        fieldName: 'Total Declared Value',
        fieldKey: 'declaredValue',
        originalValue: '$128,450.00',
        extractedValue: '$128,450.00',
        confidence: 72,
        reason: "Physical crease on Commercial Invoice obscured character '8'; verify with packing list total.",
        exceptionType: 'low_confidence',
        docType: 'Commercial Invoice',
        boundingBox: { x: 68, y: 78, w: 20, h: 4 },
        status: 'Unresolved',
        history: [],
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: '8802-weight',
        fieldName: 'Cargo Net Weight',
        fieldKey: 'netWeight',
        originalValue: '12,450 lbs',
        extractedValue: '12,450 lbs',
        crossDocValue: '14,250 lbs',
        confidence: 48,
        reason: 'Discrepancy of 1,800 lbs in net weight: Bill of Lading lists 12,450 lbs, while Packing List lists 14,250 lbs.',
        exceptionType: 'cross_doc_mismatch',
        docType: 'Bill of Lading',
        boundingBox: { x: 40, y: 52, w: 26, h: 4 },
        status: 'Unresolved',
        history: [],
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    ],
    fields: [
      { id: 'f1', key: 'invoiceNo', label: 'Commercial Invoice #', value: 'INV-8802-AP', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 95 },
      { id: 'f2', key: 'invoiceDate', label: 'Invoice Date', value: '2026-07-08', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 92 },
      { id: 'f3', key: 'shipper', label: 'Shipper / Exporter', value: 'AeroParts Global Inc.', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 98 },
      { id: 'f4', key: 'consignee', label: 'Consignee / Importer', value: 'Nexus Aerospace LLC', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 97 },
      { id: 'f5', key: 'declaredValue', label: 'Total Declared Value', value: '$128,450.00', sourceDoc: 'Commercial Invoice', isFlagged: true, exceptionId: '8802-value', confidence: 72, crossDocValue: '$128,450.00' },
      { id: 'f6', key: 'htsCode', label: 'HTS Code (Primary Line)', value: '8108.90.3060', sourceDoc: 'Commercial Invoice', isFlagged: true, exceptionId: '8802-hts', confidence: 55, crossDocValue: '8108.90.3030', crossDocSource: 'Packing List' },
      { id: 'f7', key: 'netWeight', label: 'Total Net Weight', value: '12,450 lbs', sourceDoc: 'Bill of Lading', isFlagged: true, exceptionId: '8802-weight', confidence: 48, crossDocValue: '14,250 lbs', crossDocSource: 'Packing List' },
      { id: 'f8', key: 'portOfEntry', label: 'CBP Port of Entry', value: 'Los Angeles (LAX - 2720)', sourceDoc: 'CBP Form 3461', isFlagged: false, confidence: 94 },
      { id: 'f9', key: 'carrier', label: 'Exporting Carrier', value: 'Pacific Ocean Air Cargo', sourceDoc: 'Bill of Lading', isFlagged: false, confidence: 91 },
      { id: 'f10', key: 'billOfLading', label: 'House Bill of Lading', value: 'POL-449102-X', sourceDoc: 'Bill of Lading', isFlagged: false, confidence: 96 },
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
    createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    documents: [],
    exceptions: [
      {
        id: '9041-origin',
        fieldName: 'Country of Origin',
        fieldKey: 'countryOfOrigin',
        originalValue: 'CN',
        extractedValue: 'CN',
        crossDocValue: 'TW',
        confidence: 52,
        reason: 'Country of Origin code mismatch: Commercial Invoice lists CN, while Certificate of Origin lists TW.',
        exceptionType: 'cross_doc_mismatch',
        docType: 'Certificate of Origin',
        boundingBox: { x: 12, y: 16, w: 14, h: 4 },
        status: 'Unresolved',
        history: [],
        createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      },
    ],
    fields: [
      { id: 'f11', key: 'invoiceNo', label: 'Commercial Invoice #', value: 'VND-9041-SH', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 93 },
      { id: 'f12', key: 'invoiceDate', label: 'Invoice Date', value: '2026-07-07', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 90 },
      { id: 'f13', key: 'shipper', label: 'Shipper / Exporter', value: 'Vanguard Tech Shanghai', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 96 },
      { id: 'f14', key: 'consignee', label: 'Consignee / Importer', value: 'Nova Grid Solutions', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 95 },
      { id: 'f15', key: 'declaredValue', label: 'Total Declared Value', value: '$84,120.00', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 88 },
      { id: 'f16', key: 'countryOfOrigin', label: 'Country of Origin', value: 'CN', sourceDoc: 'Commercial Invoice', isFlagged: true, exceptionId: '9041-origin', confidence: 52, crossDocValue: 'TW', crossDocSource: 'Certificate of Origin' },
      { id: 'f17', key: 'htsCode', label: 'HTS Code (Primary Line)', value: '8504.40.9580', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 91 },
      { id: 'f18', key: 'netWeight', label: 'Total Net Weight', value: '4,120 lbs', sourceDoc: 'Packing List', isFlagged: false, confidence: 89 },
      { id: 'f19', key: 'portOfEntry', label: 'CBP Port of Entry', value: 'Seattle (Tacoma - 3001)', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 92 },
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
    createdAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    documents: [],
    exceptions: [],
    fields: [
      { id: 'f20', key: 'invoiceNo', label: 'Commercial Invoice #', value: 'PDC-4410-DE', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 97 },
      { id: 'f21', key: 'invoiceDate', label: 'Invoice Date', value: '2026-07-06', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 94 },
      { id: 'f22', key: 'shipper', label: 'Shipper / Exporter', value: 'Precision Die-Cast GMBH', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 99 },
      { id: 'f23', key: 'consignee', label: 'Consignee / Importer', value: 'Midwest Machinery Works', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 98 },
      { id: 'f24', key: 'declaredValue', label: 'Total Declared Value', value: '$345,900.00', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 96 },
      { id: 'f25', key: 'htsCode', label: 'HTS Code (Primary Line)', value: '8480.71.8010', sourceDoc: 'Commercial Invoice', isFlagged: false, confidence: 95 },
      { id: 'f26', key: 'netWeight', label: 'Total Net Weight', value: '28,150 lbs', sourceDoc: 'Bill of Lading', isFlagged: false, confidence: 93 },
      { id: 'f27', key: 'portOfEntry', label: 'CBP Port of Entry', value: "Chicago (O'Hare - 3901)", sourceDoc: 'CBP Form 3461', isFlagged: false, confidence: 96 },
    ],
  },
];

export const seedRules: OperationalRules = {
  invoiceThreshold: 80,
  htsThreshold: 85,
  partiesThreshold: 75,
};

export const seedLogs: AuditLog[] = [
  { id: 'log-1', text: 'System extracted 4 docs for SHIP-2026-8802', timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), type: 'info' },
  { id: 'log-2', text: '3 critical exceptions identified in SHIP-2026-8802', timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000 + 60000).toISOString(), type: 'warning' },
  { id: 'log-3', text: 'Auto-audited country codes matching on Certificate of Origin', timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000 + 120000).toISOString(), type: 'success' },
  { id: 'log-4', text: 'Invoice parsed successfully for SHIP-2026-9041', timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), type: 'info' },
  { id: 'log-5', text: 'Broker approved SHIP-2026-4410', timestamp: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), type: 'success' },
];

// ============================================================================
// CONFIDENCE CALCULATION
// ============================================================================

export function calculateConfidence(
  initialConfidence: number,
  exceptions: Exception[]
): number {
  const totalExc = exceptions.length;
  if (totalExc === 0) return Math.min(100, initialConfidence);
  const resolvedCount = exceptions.filter(e => e.status !== 'Unresolved').length;
  const boost = (100 - initialConfidence) * (resolvedCount / totalExc);
  return Math.min(100, Math.round(initialConfidence + boost));
}

export function getConfidenceColor(conf: number): string {
  if (conf < 60) return 'text-red-400 bg-red-950/40 border-red-900/50';
  if (conf < 85) return 'text-amber-400 bg-amber-950/40 border-amber-900/50';
  return 'text-green-400 bg-green-950/40 border-green-900/50';
}

export function getConfidenceBadge(conf: number): string {
  if (conf < 60) return 'RED / CRITICAL';
  if (conf < 85) return 'AMBER / WARNING';
  return 'GREEN / COMPLIANT';
}

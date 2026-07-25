;!function(){try { var e="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof global?global:"undefined"!=typeof window?window:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&((e._debugIds|| (e._debugIds={}))[n]="a6558a22-b650-788a-7a94-150e959a0a28")}catch(e){}}();
module.exports = [
"[externals]/next/dist/server/app-render/action-async-storage.external.js [external] (next/dist/server/app-render/action-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/action-async-storage.external.js", () => require("next/dist/server/app-render/action-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-unit-async-storage.external.js [external] (next/dist/server/app-render/work-unit-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-unit-async-storage.external.js", () => require("next/dist/server/app-render/work-unit-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-async-storage.external.js [external] (next/dist/server/app-render/work-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-async-storage.external.js", () => require("next/dist/server/app-render/work-async-storage.external.js"));

module.exports = mod;
}),
"[project]/src/lib/supabase.ts [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "apiFetch",
    ()=>apiFetch,
    "calculateConfidence",
    ()=>calculateConfidence,
    "decideInviteAction",
    ()=>decideInviteAction,
    "ensureAuthenticated",
    ()=>ensureAuthenticated,
    "fetchLogsDirect",
    ()=>fetchLogsDirect,
    "fetchRulesDirect",
    ()=>fetchRulesDirect,
    "fetchShipmentsDirect",
    ()=>fetchShipmentsDirect,
    "getAuthToken",
    ()=>getAuthToken,
    "getConfidenceBadge",
    ()=>getConfidenceBadge,
    "getConfidenceColor",
    ()=>getConfidenceColor,
    "getCurrentUserEmail",
    ()=>getCurrentUserEmail,
    "getSupabase",
    ()=>getSupabase,
    "invokeEdgeFunction",
    ()=>invokeEdgeFunction,
    "isDemoMode",
    ()=>isDemoMode,
    "isSupabaseConfigured",
    ()=>isSupabaseConfigured,
    "mapDbToAuditLog",
    ()=>mapDbToAuditLog,
    "mapDbToException",
    ()=>mapDbToException,
    "mapDbToField",
    ()=>mapDbToField,
    "mapDbToRules",
    ()=>mapDbToRules,
    "mapDbToShipment",
    ()=>mapDbToShipment,
    "redirectToLogin",
    ()=>redirectToLogin,
    "seedEntries",
    ()=>seedEntries,
    "seedLogs",
    ()=>seedLogs,
    "seedRules",
    ()=>seedRules,
    "supabase",
    ()=>supabase
]);
// ============================================================================
// ClearPort — Supabase Client + Data Access Layer
// ============================================================================
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$supabase$2f$supabase$2d$js$2f$dist$2f$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/node_modules/@supabase/supabase-js/dist/index.mjs [app-ssr] (ecmascript) <locals>");
;
const supabaseUrl = ("TURBOPACK compile-time value", "https://apfsceomnnhefxkvjhkz.supabase.co");
const supabaseAnonKey = ("TURBOPACK compile-time value", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwZnNjZW9tbm5oZWZ4a3ZqaGt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MDI0ODQsImV4cCI6MjA5OTA3ODQ4NH0.TN_HXmJlNBw94ikW0zeTCgG7uEiZX1dpzVazau0pQ1s");
// Lazy singleton — created on first use
let _client = null;
function getSupabase() {
    if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable
    ;
    if (!_client) {
        _client = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$supabase$2f$supabase$2d$js$2f$dist$2f$index$2e$mjs__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$locals$3e$__["createClient"])(supabaseUrl, supabaseAnonKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false
            }
        });
    }
    return _client;
}
const supabase = getSupabase();
// ── §2 fix: proactive session-expiry redirect ──
// When Supabase's own token refresh fails (e.g. refresh token revoked, or the
// session expired while the user was idle), the client fires a SIGNED_OUT
// auth state event. Listen for it and redirect to /login so the user doesn't
// see raw errors scattered across the UI on their next interaction.
//
// This catches the idle-expiry case that apiFetch's 401 handler can't — the
// 401 only fires when an API call is actually made, but SIGNED_OUT fires
// proactively as soon as the refresh fails.
if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable
;
function isSupabaseConfigured() {
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
let _anonSignInPromise = null;
async function ensureAuthenticated() {
    const client = getSupabase();
    if (!client) return false;
    try {
        const { data: { session } } = await client.auth.getSession();
        if (session) return true;
        // Demo mode only: auto-create anonymous sessions
        if (DEMO_MODE) {
            if (!_anonSignInPromise) {
                _anonSignInPromise = client.auth.signInAnonymously().then(({ data, error })=>{
                    if (error) {
                        console.warn('[auth] demo-mode anonymous sign-in failed:', error.message);
                        return false;
                    }
                    return !!data.session;
                }).finally(()=>{
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
async function getCurrentUserEmail() {
    const client = getSupabase();
    if (!client) return DEMO_MODE ? 'demo@clearport.local' : null;
    const { data: { user } } = await client.auth.getUser();
    if (user?.email) return user.email;
    if (DEMO_MODE && user?.id) return `anon-${user.id.slice(0, 8)}@clearport.local`;
    return DEMO_MODE ? 'demo@clearport.local' : null;
}
function isDemoMode() {
    return DEMO_MODE;
}
function decideInviteAction(token, hasSession, demoMode) {
    if (!token) {
        return {
            action: 'error',
            reason: 'no_token'
        };
    }
    if (!hasSession && !demoMode) {
        return {
            action: 'needs_auth',
            signupUrl: `/signup?invite=${encodeURIComponent(token)}`,
            loginUrl: `/login?redirect=${encodeURIComponent(`/accept-invite?token=${token}`)}`
        };
    }
    return {
        action: 'accept',
        token
    };
}
async function invokeEdgeFunction(name, body, options) {
    const client = getSupabase();
    if (!client) throw new Error('Supabase not configured');
    await ensureAuthenticated();
    const { data, error } = await client.functions.invoke(name, {
        body: body || {},
        method: options?.method || 'POST'
    });
    if (error) {
        throw new Error(`Edge function "${name}" failed: ${error.message}`);
    }
    return data;
}
async function getAuthToken() {
    const client = getSupabase();
    if (!client) return null;
    try {
        const { data: { session } } = await client.auth.getSession();
        return session?.access_token ?? null;
    } catch  {
        return null;
    }
}
function redirectToLogin(reason) {
    if ("TURBOPACK compile-time truthy", 1) return; // server-side — no redirect
    //TURBOPACK unreachable
    ;
    const currentPath = undefined;
    const loginUrl = undefined;
}
async function apiFetch(path, options = {}) {
    const client = getSupabase();
    if (client) {
        await ensureAuthenticated();
    }
    const token = await getAuthToken();
    const headers = {
        ...options.headers || {}
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    // Only set Content-Type for requests with a body (GET shouldn't set it
    // because some browsers/proxies complain about a Content-Type with no body).
    if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(path, {
        ...options,
        headers
    });
    // ── §2 fix: 401 → redirect to /login (session expired mid-use) ──
    // The middleware cookie check only verifies cookie presence, not token
    // validity. When a real session expires and an API call gets 401 back,
    // redirect the browser to /login instead of showing a raw thrown error.
    // Still throw so calling code with its own error handling isn't swallowed.
    if (res.status === 401) {
        redirectToLogin('API returned 401 — session expired');
        throw new Error(`API ${path} failed (401): session expired`);
    }
    if (!res.ok) {
        let detail = '';
        try {
            detail = await res.text();
        } catch  {
        /* ignore */ }
        throw new Error(`API ${path} failed (${res.status}): ${detail}`);
    }
    if (options.raw) {
        return res;
    }
    return res.json();
}
function mapDbToShipment(db, fields, exceptions, documents) {
    const mappedFields = fields.map(mapDbToField);
    const mappedExceptions = exceptions.map(mapDbToException);
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
        documents: documents.map((d)=>({
                id: d.id,
                docType: d.doc_type,
                fileName: d.file_name,
                storagePath: d.storage_path,
                mimeType: d.mime_type,
                uploadedAt: d.uploaded_at
            })),
        createdAt: db.created_at,
        validationStatus: db.validation_status || 'pending',
        lastValidatedAt: db.last_validated_at || undefined,
        pipelineTraceId: db.pipeline_trace_id || undefined
    };
}
function mapDbToField(db) {
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
        boundingBox: db.bounding_box || undefined
    };
}
function mapDbToException(db) {
    return {
        id: db.id,
        fieldName: db.field_name,
        fieldKey: db.field_key,
        originalValue: db.original_value || '',
        extractedValue: db.extracted_value || '',
        crossDocValue: db.cross_doc_value || undefined,
        confidence: db.confidence,
        reason: db.reason,
        explanation: db.explanation || undefined,
        exceptionType: db.exception_type,
        docType: db.doc_type || 'Document',
        boundingBox: db.bounding_box || {
            x: 10,
            y: 10,
            w: 20,
            h: 4
        },
        status: db.status,
        correctedValue: db.corrected_value || undefined,
        history: db.history || [],
        fieldId: db.field_id || undefined,
        createdAt: db.created_at,
        resolvedAt: db.resolved_at || undefined,
        resolvedBy: db.resolved_by || undefined
    };
}
function mapDbToAuditLog(db) {
    return {
        id: db.id,
        text: db.text,
        timestamp: db.timestamp,
        type: db.type,
        shipmentId: db.shipment_id || undefined
    };
}
function mapDbToRules(db) {
    return {
        invoiceThreshold: db.invoice_threshold,
        htsThreshold: db.hts_threshold,
        partiesThreshold: db.parties_threshold
    };
}
async function fetchShipmentsDirect() {
    const client = getSupabase();
    if (!client) return null;
    try {
        const { data: shipments, error } = await client.from('shipments').select('*').order('created_at', {
            ascending: false
        });
        if (error) {
            console.warn('[db] fetchShipments error:', error.message);
            return null;
        }
        if (!shipments || shipments.length === 0) return [];
        const shipmentIds = shipments.map((s)=>s.id);
        // Fetch related data in parallel
        const [fieldsRes, exceptionsRes, documentsRes] = await Promise.all([
            client.from('document_fields').select('*').in('shipment_id', shipmentIds),
            client.from('exceptions').select('*').in('shipment_id', shipmentIds),
            client.from('documents').select('*').in('shipment_id', shipmentIds)
        ]);
        if (fieldsRes.error) console.warn('[db] fields error:', fieldsRes.error.message);
        if (exceptionsRes.error) console.warn('[db] exceptions error:', exceptionsRes.error.message);
        if (documentsRes.error) console.warn('[db] documents error:', documentsRes.error.message);
        return shipments.map((s)=>{
            const fields = (fieldsRes.data || []).filter((f)=>f.shipment_id === s.id);
            const exceptions = (exceptionsRes.data || []).filter((e)=>e.shipment_id === s.id);
            const documents = (documentsRes.data || []).filter((d)=>d.shipment_id === s.id);
            return mapDbToShipment(s, fields, exceptions, documents);
        });
    } catch (err) {
        console.error('[db] fetchShipmentsDirect error:', err);
        return null;
    }
}
async function fetchRulesDirect() {
    const client = getSupabase();
    if (!client) return null;
    const { data, error } = await client.from('operational_rules').select('*').eq('id', 'default_config').single();
    if (error) return null;
    return mapDbToRules(data);
}
async function fetchLogsDirect() {
    const client = getSupabase();
    if (!client) return null;
    const { data, error } = await client.from('audit_logs').select('*').order('timestamp', {
        ascending: false
    }).limit(50);
    if (error) return null;
    return (data || []).map(mapDbToAuditLog);
}
const seedEntries = [
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
                boundingBox: {
                    x: 58,
                    y: 36,
                    w: 24,
                    h: 4
                },
                status: 'Unresolved',
                history: [],
                createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
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
                boundingBox: {
                    x: 68,
                    y: 78,
                    w: 20,
                    h: 4
                },
                status: 'Unresolved',
                history: [],
                createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
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
                boundingBox: {
                    x: 40,
                    y: 52,
                    w: 26,
                    h: 4
                },
                status: 'Unresolved',
                history: [],
                createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
            }
        ],
        fields: [
            {
                id: 'f1',
                key: 'invoiceNo',
                label: 'Commercial Invoice #',
                value: 'INV-8802-AP',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 95
            },
            {
                id: 'f2',
                key: 'invoiceDate',
                label: 'Invoice Date',
                value: '2026-07-08',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 92
            },
            {
                id: 'f3',
                key: 'shipper',
                label: 'Shipper / Exporter',
                value: 'AeroParts Global Inc.',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 98
            },
            {
                id: 'f4',
                key: 'consignee',
                label: 'Consignee / Importer',
                value: 'Nexus Aerospace LLC',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 97
            },
            {
                id: 'f5',
                key: 'declaredValue',
                label: 'Total Declared Value',
                value: '$128,450.00',
                sourceDoc: 'Commercial Invoice',
                isFlagged: true,
                exceptionId: '8802-value',
                confidence: 72,
                crossDocValue: '$128,450.00'
            },
            {
                id: 'f6',
                key: 'htsCode',
                label: 'HTS Code (Primary Line)',
                value: '8108.90.3060',
                sourceDoc: 'Commercial Invoice',
                isFlagged: true,
                exceptionId: '8802-hts',
                confidence: 55,
                crossDocValue: '8108.90.3030',
                crossDocSource: 'Packing List'
            },
            {
                id: 'f7',
                key: 'netWeight',
                label: 'Total Net Weight',
                value: '12,450 lbs',
                sourceDoc: 'Bill of Lading',
                isFlagged: true,
                exceptionId: '8802-weight',
                confidence: 48,
                crossDocValue: '14,250 lbs',
                crossDocSource: 'Packing List'
            },
            {
                id: 'f8',
                key: 'portOfEntry',
                label: 'CBP Port of Entry',
                value: 'Los Angeles (LAX - 2720)',
                sourceDoc: 'CBP Form 3461',
                isFlagged: false,
                confidence: 94
            },
            {
                id: 'f9',
                key: 'carrier',
                label: 'Exporting Carrier',
                value: 'Pacific Ocean Air Cargo',
                sourceDoc: 'Bill of Lading',
                isFlagged: false,
                confidence: 91
            },
            {
                id: 'f10',
                key: 'billOfLading',
                label: 'House Bill of Lading',
                value: 'POL-449102-X',
                sourceDoc: 'Bill of Lading',
                isFlagged: false,
                confidence: 96
            }
        ]
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
                boundingBox: {
                    x: 12,
                    y: 16,
                    w: 14,
                    h: 4
                },
                status: 'Unresolved',
                history: [],
                createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
            }
        ],
        fields: [
            {
                id: 'f11',
                key: 'invoiceNo',
                label: 'Commercial Invoice #',
                value: 'VND-9041-SH',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 93
            },
            {
                id: 'f12',
                key: 'invoiceDate',
                label: 'Invoice Date',
                value: '2026-07-07',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 90
            },
            {
                id: 'f13',
                key: 'shipper',
                label: 'Shipper / Exporter',
                value: 'Vanguard Tech Shanghai',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 96
            },
            {
                id: 'f14',
                key: 'consignee',
                label: 'Consignee / Importer',
                value: 'Nova Grid Solutions',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 95
            },
            {
                id: 'f15',
                key: 'declaredValue',
                label: 'Total Declared Value',
                value: '$84,120.00',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 88
            },
            {
                id: 'f16',
                key: 'countryOfOrigin',
                label: 'Country of Origin',
                value: 'CN',
                sourceDoc: 'Commercial Invoice',
                isFlagged: true,
                exceptionId: '9041-origin',
                confidence: 52,
                crossDocValue: 'TW',
                crossDocSource: 'Certificate of Origin'
            },
            {
                id: 'f17',
                key: 'htsCode',
                label: 'HTS Code (Primary Line)',
                value: '8504.40.9580',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 91
            },
            {
                id: 'f18',
                key: 'netWeight',
                label: 'Total Net Weight',
                value: '4,120 lbs',
                sourceDoc: 'Packing List',
                isFlagged: false,
                confidence: 89
            },
            {
                id: 'f19',
                key: 'portOfEntry',
                label: 'CBP Port of Entry',
                value: 'Seattle (Tacoma - 3001)',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 92
            }
        ]
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
            {
                id: 'f20',
                key: 'invoiceNo',
                label: 'Commercial Invoice #',
                value: 'PDC-4410-DE',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 97
            },
            {
                id: 'f21',
                key: 'invoiceDate',
                label: 'Invoice Date',
                value: '2026-07-06',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 94
            },
            {
                id: 'f22',
                key: 'shipper',
                label: 'Shipper / Exporter',
                value: 'Precision Die-Cast GMBH',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 99
            },
            {
                id: 'f23',
                key: 'consignee',
                label: 'Consignee / Importer',
                value: 'Midwest Machinery Works',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 98
            },
            {
                id: 'f24',
                key: 'declaredValue',
                label: 'Total Declared Value',
                value: '$345,900.00',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 96
            },
            {
                id: 'f25',
                key: 'htsCode',
                label: 'HTS Code (Primary Line)',
                value: '8480.71.8010',
                sourceDoc: 'Commercial Invoice',
                isFlagged: false,
                confidence: 95
            },
            {
                id: 'f26',
                key: 'netWeight',
                label: 'Total Net Weight',
                value: '28,150 lbs',
                sourceDoc: 'Bill of Lading',
                isFlagged: false,
                confidence: 93
            },
            {
                id: 'f27',
                key: 'portOfEntry',
                label: 'CBP Port of Entry',
                value: "Chicago (O'Hare - 3901)",
                sourceDoc: 'CBP Form 3461',
                isFlagged: false,
                confidence: 96
            }
        ]
    }
];
const seedRules = {
    invoiceThreshold: 80,
    htsThreshold: 85,
    partiesThreshold: 75
};
const seedLogs = [
    {
        id: 'log-1',
        text: 'System extracted 4 docs for SHIP-2026-8802',
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        type: 'info'
    },
    {
        id: 'log-2',
        text: '3 critical exceptions identified in SHIP-2026-8802',
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000 + 60000).toISOString(),
        type: 'warning'
    },
    {
        id: 'log-3',
        text: 'Auto-audited country codes matching on Certificate of Origin',
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000 + 120000).toISOString(),
        type: 'success'
    },
    {
        id: 'log-4',
        text: 'Invoice parsed successfully for SHIP-2026-9041',
        timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        type: 'info'
    },
    {
        id: 'log-5',
        text: 'Broker approved SHIP-2026-4410',
        timestamp: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
        type: 'success'
    }
];
function calculateConfidence(initialConfidence, exceptions) {
    const totalExc = exceptions.length;
    if (totalExc === 0) return Math.min(100, initialConfidence);
    const resolvedCount = exceptions.filter((e)=>e.status !== 'Unresolved').length;
    const boost = (100 - initialConfidence) * (resolvedCount / totalExc);
    return Math.min(100, Math.round(initialConfidence + boost));
}
function getConfidenceColor(conf) {
    if (conf < 60) return 'text-red-400 bg-red-950/40 border-red-900/50';
    if (conf < 85) return 'text-amber-400 bg-amber-950/40 border-amber-900/50';
    return 'text-green-400 bg-green-950/40 border-green-900/50';
}
function getConfidenceBadge(conf) {
    if (conf < 60) return 'RED / CRITICAL';
    if (conf < 85) return 'AMBER / WARNING';
    return 'GREEN / COMPLIANT';
}
}),
"[project]/src/app/login/page.tsx [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>LoginPage
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react-jsx-dev-runtime.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/navigation.js [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/supabase.ts [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$shield$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$export__default__as__Shield$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/shield.js [app-ssr] (ecmascript) <export default as Shield>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$loader$2d$circle$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$export__default__as__Loader2$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/loader-circle.js [app-ssr] (ecmascript) <export default as Loader2>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$circle$2d$alert$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$export__default__as__AlertCircle$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/circle-alert.js [app-ssr] (ecmascript) <export default as AlertCircle>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$log$2d$in$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$export__default__as__LogIn$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/log-in.js [app-ssr] (ecmascript) <export default as LogIn>");
// ============================================================================
// /login — Email + password login page
// ============================================================================
// Replaces the anonymous sign-in path. Calls supabase.auth.signInWithPassword().
// Redirects to / on success. Links to /signup and /reset-password.
// ============================================================================
'use client';
;
;
;
;
;
function LoginPage() {
    const router = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$navigation$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useRouter"])();
    const [email, setEmail] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"]('');
    const [password, setPassword] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"]('');
    const [loading, setLoading] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"](false);
    const [error, setError] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useState"](null);
    // If already logged in, redirect to /
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["useEffect"](()=>{
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["supabase"]?.auth.getSession().then(({ data: { session } })=>{
            if (session) router.replace('/');
        });
    }, [
        router
    ]);
    const handleSubmit = async (e)=>{
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const { data, error } = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["supabase"].auth.signInWithPassword({
                email: email.trim(),
                password
            });
            if (error) {
                // Surface Supabase Auth's built-in rate limiting + error messages
                // rather than swallowing them
                setError(error.message);
                return;
            }
            if (data.session) {
                router.replace('/');
                router.refresh();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
        } finally{
            setLoading(false);
        }
    };
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "min-h-screen bg-[#06070a] flex items-center justify-center p-4 font-sans",
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "max-w-md w-full",
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "text-center mb-8",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "w-14 h-14 bg-amber-500 rounded-2xl flex items-center justify-center font-bold text-black text-2xl tracking-tighter mx-auto mb-4 shadow-xl",
                            children: "CP"
                        }, void 0, false, {
                            fileName: "[project]/src/app/login/page.tsx",
                            lineNumber: 63,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("h1", {
                            className: "text-2xl font-bold text-white tracking-tight",
                            children: "ClearPort"
                        }, void 0, false, {
                            fileName: "[project]/src/app/login/page.tsx",
                            lineNumber: 66,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                            className: "text-sm text-gray-500 mt-1",
                            children: "Customs Compliance Platform"
                        }, void 0, false, {
                            fileName: "[project]/src/app/login/page.tsx",
                            lineNumber: 67,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/login/page.tsx",
                    lineNumber: 62,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "bg-[#0c0d12] border border-gray-900 rounded-xl p-6 sm:p-8",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "flex items-center gap-2 mb-6",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$log$2d$in$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$export__default__as__LogIn$3e$__["LogIn"], {
                                    className: "w-5 h-5 text-amber-500"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/login/page.tsx",
                                    lineNumber: 73,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                    className: "text-sm font-bold text-gray-200 uppercase tracking-wider",
                                    children: "Sign In"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/login/page.tsx",
                                    lineNumber: 74,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/login/page.tsx",
                            lineNumber: 72,
                            columnNumber: 11
                        }, this),
                        (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["isDemoMode"])() && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "mb-4 p-3 rounded-lg bg-amber-950/30 border border-amber-900/40 text-amber-400 text-xs flex items-center gap-2",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$circle$2d$alert$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$export__default__as__AlertCircle$3e$__["AlertCircle"], {
                                    className: "w-4 h-4 shrink-0"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/login/page.tsx",
                                    lineNumber: 79,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                    children: "Demo mode is active — anonymous sessions are enabled."
                                }, void 0, false, {
                                    fileName: "[project]/src/app/login/page.tsx",
                                    lineNumber: 80,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/login/page.tsx",
                            lineNumber: 78,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("form", {
                            onSubmit: handleSubmit,
                            className: "space-y-4",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("label", {
                                            className: "block text-xs font-mono text-gray-400 uppercase tracking-wider mb-1.5",
                                            children: "Email"
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/login/page.tsx",
                                            lineNumber: 86,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("input", {
                                            type: "email",
                                            value: email,
                                            onChange: (e)=>setEmail(e.target.value),
                                            required: true,
                                            autoComplete: "email",
                                            autoFocus: true,
                                            className: "w-full bg-black/40 border border-gray-900 rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30 transition-all",
                                            placeholder: "you@company.com"
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/login/page.tsx",
                                            lineNumber: 89,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/login/page.tsx",
                                    lineNumber: 85,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("label", {
                                            className: "block text-xs font-mono text-gray-400 uppercase tracking-wider mb-1.5",
                                            children: "Password"
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/login/page.tsx",
                                            lineNumber: 102,
                                            columnNumber: 15
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("input", {
                                            type: "password",
                                            value: password,
                                            onChange: (e)=>setPassword(e.target.value),
                                            required: true,
                                            autoComplete: "current-password",
                                            className: "w-full bg-black/40 border border-gray-900 rounded-lg px-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30 transition-all",
                                            placeholder: "••••••••"
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/login/page.tsx",
                                            lineNumber: 105,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/login/page.tsx",
                                    lineNumber: 101,
                                    columnNumber: 13
                                }, this),
                                error && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "p-3 rounded-lg bg-red-950/30 border border-red-900/40 text-red-400 text-xs flex items-start gap-2",
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$circle$2d$alert$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$export__default__as__AlertCircle$3e$__["AlertCircle"], {
                                            className: "w-4 h-4 shrink-0 mt-0.5"
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/login/page.tsx",
                                            lineNumber: 118,
                                            columnNumber: 17
                                        }, this),
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            children: error
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/login/page.tsx",
                                            lineNumber: 119,
                                            columnNumber: 17
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/login/page.tsx",
                                    lineNumber: 117,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                    type: "submit",
                                    disabled: loading,
                                    className: "w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-2.5 rounded-lg text-sm uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer",
                                    children: [
                                        loading ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$loader$2d$circle$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$export__default__as__Loader2$3e$__["Loader2"], {
                                            className: "w-4 h-4 animate-spin"
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/login/page.tsx",
                                            lineNumber: 128,
                                            columnNumber: 26
                                        }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$log$2d$in$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$export__default__as__LogIn$3e$__["LogIn"], {
                                            className: "w-4 h-4"
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/login/page.tsx",
                                            lineNumber: 128,
                                            columnNumber: 73
                                        }, this),
                                        loading ? 'Signing in...' : 'Sign In'
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/login/page.tsx",
                                    lineNumber: 123,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/login/page.tsx",
                            lineNumber: 84,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "mt-6 pt-4 border-t border-gray-900 space-y-2 text-center",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                    onClick: ()=>router.push('/reset-password'),
                                    className: "text-xs text-gray-500 hover:text-gray-300 transition-colors cursor-pointer",
                                    children: "Forgot your password?"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/login/page.tsx",
                                    lineNumber: 135,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "text-xs text-gray-600",
                                    children: [
                                        "Don't have an account?",
                                        ' ',
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                            onClick: ()=>router.push('/signup'),
                                            className: "text-amber-500 hover:text-amber-400 font-semibold transition-colors cursor-pointer",
                                            children: "Sign up"
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/login/page.tsx",
                                            lineNumber: 143,
                                            columnNumber: 15
                                        }, this)
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/login/page.tsx",
                                    lineNumber: 141,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/login/page.tsx",
                            lineNumber: 134,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/login/page.tsx",
                    lineNumber: 71,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                    className: "mt-6 flex items-center justify-center gap-1.5 text-[10px] font-mono text-gray-600 uppercase",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$shield$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__$3c$export__default__as__Shield$3e$__["Shield"], {
                            className: "w-3 h-3 text-emerald-500"
                        }, void 0, false, {
                            fileName: "[project]/src/app/login/page.tsx",
                            lineNumber: 155,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$ssr$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                            children: "Secured by Supabase Auth • Row-Level Security Enforced"
                        }, void 0, false, {
                            fileName: "[project]/src/app/login/page.tsx",
                            lineNumber: 156,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/src/app/login/page.tsx",
                    lineNumber: 154,
                    columnNumber: 9
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/src/app/login/page.tsx",
            lineNumber: 60,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/app/login/page.tsx",
        lineNumber: 59,
        columnNumber: 5
    }, this);
}
}),
];

//# debugId=a6558a22-b650-788a-7a94-150e959a0a28
//# sourceMappingURL=%5Broot-of-the-server%5D__8f7ad4b2._.js.map
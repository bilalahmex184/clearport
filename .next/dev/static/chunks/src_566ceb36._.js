;!function(){try { var e="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof global?global:"undefined"!=typeof window?window:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&((e._debugIds|| (e._debugIds={}))[n]="b67180eb-53c1-b4e9-185a-ebff08fbeb11")}catch(e){}}();
(globalThis.TURBOPACK || (globalThis.TURBOPACK = [])).push([typeof document === "object" ? document.currentScript : undefined,
"[project]/src/lib/supabase.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
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
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = /*#__PURE__*/ __turbopack_context__.i("[project]/node_modules/next/dist/build/polyfills/process.js [app-client] (ecmascript)");
// ============================================================================
// ClearPort — Supabase Client + Data Access Layer
// ============================================================================
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$supabase$2f$supabase$2d$js$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/node_modules/@supabase/supabase-js/dist/index.mjs [app-client] (ecmascript) <locals>");
;
const supabaseUrl = ("TURBOPACK compile-time value", "https://apfsceomnnhefxkvjhkz.supabase.co");
const supabaseAnonKey = ("TURBOPACK compile-time value", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwZnNjZW9tbm5oZWZ4a3ZqaGt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MDI0ODQsImV4cCI6MjA5OTA3ODQ4NH0.TN_HXmJlNBw94ikW0zeTCgG7uEiZX1dpzVazau0pQ1s");
// Lazy singleton — created on first use
let _client = null;
function getSupabase() {
    if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable
    ;
    if (!_client) {
        _client = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$supabase$2f$supabase$2d$js$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["createClient"])(supabaseUrl, supabaseAnonKey, {
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
if (supabase && ("TURBOPACK compile-time value", "object") !== 'undefined') {
    supabase.auth.onAuthStateChange((event)=>{
        if (event === 'SIGNED_OUT') {
            // Only redirect if we're not already on a public route (login/signup/etc)
            const path = window.location.pathname;
            const publicRoutes = [
                '/login',
                '/signup',
                '/reset-password',
                '/accept-invite',
                '/terms',
                '/privacy',
                '/legal'
            ];
            if (!publicRoutes.includes(path)) {
                redirectToLogin('SIGNED_OUT event — session expired or revoked');
            }
        }
    });
}
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
const DEMO_MODE = ("TURBOPACK compile-time value", "true") === 'true';
let _anonSignInPromise = null;
async function ensureAuthenticated() {
    const client = getSupabase();
    if (!client) return false;
    try {
        const { data: { session } } = await client.auth.getSession();
        if (session) return true;
        // Demo mode only: auto-create anonymous sessions
        if ("TURBOPACK compile-time truthy", 1) {
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
        //TURBOPACK unreachable
        ;
    } catch (err) {
        console.warn('[auth] ensureAuthenticated error:', err);
        return false;
    }
}
async function getCurrentUserEmail() {
    const client = getSupabase();
    if (!client) return ("TURBOPACK compile-time truthy", 1) ? 'demo@clearport.local' : "TURBOPACK unreachable";
    const { data: { user } } = await client.auth.getUser();
    if (user?.email) return user.email;
    if (DEMO_MODE && user?.id) return `anon-${user.id.slice(0, 8)}@clearport.local`;
    return ("TURBOPACK compile-time truthy", 1) ? 'demo@clearport.local' : "TURBOPACK unreachable";
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
    if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable
    ;
     // server-side — no redirect
    const currentPath = window.location.pathname + window.location.search;
    const loginUrl = new URL('/login', window.location.origin);
    loginUrl.searchParams.set('redirect', currentPath);
    console.warn(`[auth] redirecting to login (${reason})`);
    window.location.href = loginUrl.href;
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
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/lib/services/rbac.service.ts [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

// ============================================================================
// ClearPort — Role-Based Access Control (RBAC) Service
// ============================================================================
//
// Three roles with descending scope:
//   - admin     : full power — upload, edit, resolve, export, manage_rules,
//                 manage_users, and delete
//   - operator  : day-to-day broker work — upload, edit, resolve, export
//                 (cannot manage rules, users, or delete shipments)
//   - viewer    : read-only + export — for auditors / external reviewers
//
// Role lookup is now REAL — it queries organization_members for the user's
// role in the current org context (see auth.service.ts#getUserRole).
// There is no more getDefaultRole() silent fallback.
// ============================================================================
__turbopack_context__.s([
    "PERMISSIONS",
    ()=>PERMISSIONS,
    "canDelete",
    ()=>canDelete,
    "canEdit",
    ()=>canEdit,
    "canExport",
    ()=>canExport,
    "canManageRules",
    ()=>canManageRules,
    "canManageUsers",
    ()=>canManageUsers,
    "canResolve",
    ()=>canResolve,
    "canUpload",
    ()=>canUpload,
    "canView",
    ()=>canView,
    "hasPermission",
    ()=>hasPermission,
    "isAdmin",
    ()=>isAdmin,
    "roleLabel",
    ()=>roleLabel
]);
const PERMISSIONS = {
    admin: [
        'upload',
        'edit',
        'resolve',
        'export',
        'manage_rules',
        'manage_users',
        'delete'
    ],
    operator: [
        'upload',
        'edit',
        'resolve',
        'export'
    ],
    viewer: [
        'view',
        'export'
    ]
};
function hasPermission(role, permission) {
    const granted = PERMISSIONS[role];
    return granted.includes(permission);
}
function canUpload(role) {
    return hasPermission(role, 'upload');
}
function canEdit(role) {
    return hasPermission(role, 'edit');
}
function canResolve(role) {
    return hasPermission(role, 'resolve');
}
function canExport(role) {
    return hasPermission(role, 'export');
}
function canManageRules(role) {
    return hasPermission(role, 'manage_rules');
}
function canManageUsers(role) {
    return hasPermission(role, 'manage_users');
}
function canDelete(role) {
    return hasPermission(role, 'delete');
}
function canView(role) {
    return role === 'admin' || role === 'operator' || hasPermission(role, 'view');
}
function isAdmin(role) {
    return role === 'admin';
}
function roleLabel(role) {
    switch(role){
        case 'admin':
            return 'Administrator';
        case 'operator':
            return 'Customs Broker';
        case 'viewer':
            return 'Auditor (View Only)';
        default:
            return role;
    }
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/context/ClearPortContext.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "ClearPortProvider",
    ()=>ClearPortProvider,
    "useClearPort",
    ()=>useClearPort
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/supabase.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature(), _s1 = __turbopack_context__.k.signature();
'use client';
;
;
const ClearPortContext = /*#__PURE__*/ __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createContext"](undefined);
const ClearPortProvider = ({ children })=>{
    _s();
    const [entries, setEntries] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"](__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["seedEntries"]);
    const [selectedEntryId, setSelectedEntryId] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"]('SHIP-2026-8802');
    const [selectedExceptionId, setSelectedExceptionId] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"]('8802-hts');
    const [activeTab, setActiveTab] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"]('exception-desk');
    const [theme, setTheme] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"]({
        "ClearPortProvider.useState": ()=>{
            // Lazy initializer — read localStorage at first render, not in a mount effect.
            // This avoids a setState-in-effect (which causes a double render) and prevents
            // a flash of the wrong theme on initial load.
            if ("TURBOPACK compile-time truthy", 1) {
                const saved = localStorage.getItem('clearport-theme');
                if (saved === 'light' || saved === 'dark') return saved;
            }
            return 'dark';
        }
    }["ClearPortProvider.useState"]);
    const [rules, setRules] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"](__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["seedRules"]);
    const [undoStack, setUndoStack] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"]([]);
    const [auditLogs, setAuditLogs] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"](__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["seedLogs"]);
    const [supabaseStatus, setSupabaseStatus] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"]((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isSupabaseConfigured"])() ? 'loading' : 'unconfigured');
    const [edgeFunctionStatus, setEdgeFunctionStatus] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"]('unknown');
    const [currentUser, setCurrentUser] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"](null);
    const [currentTime, setCurrentTime] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"]('');
    // Initial value 'operator' preserves the no-login UX. The real role is
    // fetched from /api/organizations on load (see loadData below).
    const [userRole, setUserRole] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"]('operator');
    // Orgs the user belongs to + the currently active org id. Populated by
    // loadData on first run; switchOrg() updates currentOrgId and reloads.
    const [userOrgs, setUserOrgs] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"]([]);
    const [currentOrgId, setCurrentOrgId] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"](null);
    // Refs mirror the org state so loadData / apiFetchOrg / switchOrg can read
    // the latest values without being recreated on every state change. This
    // keeps loadData's deps stable ([]) so the initial mount effect only fires
    // once, and switchOrg can explicitly trigger a reload.
    //
    // P7 fix: ref assignments are done in useEffect (not during render) to be
    // safe under React's concurrent rendering model. A component can render
    // more than once per commit in concurrent mode; mutating refs during render
    // would corrupt them. useEffect runs exactly once per commit.
    const currentOrgIdRef = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"](null);
    const userOrgsRef = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"]([]);
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"]({
        "ClearPortProvider.useEffect": ()=>{
            currentOrgIdRef.current = currentOrgId;
        }
    }["ClearPortProvider.useEffect"], [
        currentOrgId
    ]);
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"]({
        "ClearPortProvider.useEffect": ()=>{
            userOrgsRef.current = userOrgs;
        }
    }["ClearPortProvider.useEffect"], [
        userOrgs
    ]);
    // --- apiFetch wrapper that injects the X-Org-Id header for org-scoped routes ---
    // Uses the ref so the callback identity is stable (no dependency on state).
    // Routes that DON'T need an org context (e.g. /api/organizations itself)
    // should call the base `apiFetch` directly.
    const apiFetchOrg = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[apiFetchOrg]": (path, options = {})=>{
            const headers = {
                ...options.headers || {}
            };
            if (currentOrgIdRef.current) {
                headers['X-Org-Id'] = currentOrgIdRef.current;
            }
            return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["apiFetch"])(path, {
                ...options,
                headers
            });
        }
    }["ClearPortProvider.useCallback[apiFetchOrg]"], []);
    // --- Real-time clock ---
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"]({
        "ClearPortProvider.useEffect": ()=>{
            const update = {
                "ClearPortProvider.useEffect.update": ()=>{
                    const now = new Date();
                    const utc = now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
                    setCurrentTime(utc);
                }
            }["ClearPortProvider.useEffect.update"];
            update();
            const interval = setInterval(update, 1000);
            return ({
                "ClearPortProvider.useEffect": ()=>clearInterval(interval)
            })["ClearPortProvider.useEffect"];
        }
    }["ClearPortProvider.useEffect"], []);
    // --- Load user email ---
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"]({
        "ClearPortProvider.useEffect": ()=>{
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getCurrentUserEmail"])().then({
                "ClearPortProvider.useEffect": (email)=>setCurrentUser(email)
            }["ClearPortProvider.useEffect"]);
        }
    }["ClearPortProvider.useEffect"], []);
    // Theme is now initialized lazily via useState(() => ...) above — no
    // mount effect needed. The toggleTheme callback persists changes to
    // localStorage on user action.
    const toggleTheme = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[toggleTheme]": ()=>{
            setTheme({
                "ClearPortProvider.useCallback[toggleTheme]": (prev)=>{
                    const next = prev === 'dark' ? 'light' : 'dark';
                    if ("TURBOPACK compile-time truthy", 1) localStorage.setItem('clearport-theme', next);
                    return next;
                }
            }["ClearPortProvider.useCallback[toggleTheme]"]);
        }
    }["ClearPortProvider.useCallback[toggleTheme]"], []);
    // --- Load data ---
    // P7 fix: ref assignment in useEffect (not during render) for concurrent-mode safety.
    const selectedEntryIdRef = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"](selectedEntryId);
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"]({
        "ClearPortProvider.useEffect": ()=>{
            selectedEntryIdRef.current = selectedEntryId;
        }
    }["ClearPortProvider.useEffect"], [
        selectedEntryId
    ]);
    const loadData = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[loadData]": async ()=>{
            if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isSupabaseConfigured"])()) {
                setSupabaseStatus('unconfigured');
                setEdgeFunctionStatus('fallback');
                return;
            }
            setSupabaseStatus('loading');
            try {
                await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ensureAuthenticated"])();
                const email = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getCurrentUserEmail"])();
                setCurrentUser(email);
                // --- Bootstrap org context (only on first run, when currentOrgId is null) ---
                // Subsequent reloads (e.g. after switchOrg) skip this block and reuse
                // the already-selected org. Uses the base apiFetch (no X-Org-Id header)
                // because GET /api/organizations is the bootstrap path that doesn't
                // require an org context.
                if (!currentOrgIdRef.current) {
                    try {
                        const orgsRes = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["apiFetch"])('/api/organizations');
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
                    const response = await apiFetchOrg('/api/shipments?page=1&limit=100');
                    if (response?.data && Array.isArray(response.data)) {
                        // Only use DB shipments if they have fields/exceptions data (new
                        // schema). Old-schema shipments have empty arrays — fall back to
                        // seed data so the demo UX is preserved.
                        const hasRealData = response.data.some({
                            "ClearPortProvider.useCallback[loadData].hasRealData": (s)=>s.fields.length > 0 || s.exceptions.length > 0
                        }["ClearPortProvider.useCallback[loadData].hasRealData"]);
                        if (hasRealData) {
                            setEntries(response.data);
                            // Select first shipment if current selection doesn't exist
                            if (!response.data.find({
                                "ClearPortProvider.useCallback[loadData]": (s)=>s.id === selectedEntryIdRef.current
                            }["ClearPortProvider.useCallback[loadData]"])) {
                                const first = response.data[0];
                                setSelectedEntryId(first.id);
                                if (first.exceptions?.length > 0) {
                                    const unresolved = first.exceptions.find({
                                        "ClearPortProvider.useCallback[loadData].unresolved": (e)=>e.status === 'Unresolved'
                                    }["ClearPortProvider.useCallback[loadData].unresolved"]);
                                    setSelectedExceptionId(unresolved ? unresolved.id : first.exceptions[0].id);
                                }
                            }
                        }
                        // else: keep seed entries (demo mode)
                        setEdgeFunctionStatus('live');
                        setSupabaseStatus('connected');
                        // Fetch rules + logs in parallel via the org-scoped API routes.
                        const [rulesRes, logsRes] = await Promise.all([
                            apiFetchOrg('/api/rules').catch({
                                "ClearPortProvider.useCallback[loadData]": ()=>null
                            }["ClearPortProvider.useCallback[loadData]"]),
                            apiFetchOrg('/api/audit-logs').catch({
                                "ClearPortProvider.useCallback[loadData]": ()=>null
                            }["ClearPortProvider.useCallback[loadData]"])
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
        }
    }["ClearPortProvider.useCallback[loadData]"], [
        apiFetchOrg
    ]);
    // --- switchOrg: change the active org context and reload data ---
    const switchOrg = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[switchOrg]": (orgId)=>{
            const org = userOrgsRef.current.find({
                "ClearPortProvider.useCallback[switchOrg].org": (o)=>o.org_id === orgId
            }["ClearPortProvider.useCallback[switchOrg].org"]);
            if (!org) {
                console.warn('[ctx] switchOrg: org not found in userOrgs', {
                    orgId
                });
                return;
            }
            // Update both state + ref so apiFetchOrg picks up the new org immediately
            // (the ref is read synchronously; the state triggers a re-render).
            setCurrentOrgId(orgId);
            currentOrgIdRef.current = orgId;
            setUserRole(org.role);
            // Reload all org-scoped data for the new org.
            loadData();
        }
    }["ClearPortProvider.useCallback[switchOrg]"], [
        loadData
    ]);
    // loadData is async and needs live org context — a lazy useState initializer
    // can't be used here. This is a deliberate one-time async load on mount,
    // not a cascading render.
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"]({
        "ClearPortProvider.useEffect": ()=>{
            loadData();
        }
    }["ClearPortProvider.useEffect"], [
        loadData
    ]);
    const refreshData = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[refreshData]": async ()=>{
            await loadData();
        }
    }["ClearPortProvider.useCallback[refreshData]"], [
        loadData
    ]);
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
    const refreshShipment = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[refreshShipment]": async (shipmentId)=>{
            if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isSupabaseConfigured"])()) return;
            try {
                const res = await apiFetchOrg('/api/shipments/' + shipmentId);
                if (res?.shipment) {
                    setEntries({
                        "ClearPortProvider.useCallback[refreshShipment]": (prev)=>{
                            const idx = prev.findIndex({
                                "ClearPortProvider.useCallback[refreshShipment].idx": (e)=>e.id === shipmentId
                            }["ClearPortProvider.useCallback[refreshShipment].idx"]);
                            if (idx === -1) return prev; // not in list — nothing to update
                            const updated = [
                                ...prev
                            ];
                            // The DB row has the authoritative fields/exceptions/validation_status.
                            updated[idx] = res.shipment;
                            return updated;
                        }
                    }["ClearPortProvider.useCallback[refreshShipment]"]);
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                // If the shipment doesn't exist (404 / not found), mark the placeholder
                // as 'failed' so polling stops. This handles the edge case where the
                // shipment row upsert failed but a 'pending' placeholder was already
                // added to the UI — without this, the polling effect would retry forever.
                if (/404|not found/i.test(errMsg)) {
                    setEntries({
                        "ClearPortProvider.useCallback[refreshShipment]": (prev)=>{
                            const idx = prev.findIndex({
                                "ClearPortProvider.useCallback[refreshShipment].idx": (e)=>e.id === shipmentId
                            }["ClearPortProvider.useCallback[refreshShipment].idx"]);
                            if (idx === -1) return prev;
                            const updated = [
                                ...prev
                            ];
                            updated[idx] = {
                                ...updated[idx],
                                validationStatus: 'failed'
                            };
                            return updated;
                        }
                    }["ClearPortProvider.useCallback[refreshShipment]"]);
                } else {
                    // Transient error (network blip, 500, etc.) — polling will retry on
                    // the next tick. Log at debug to avoid console spam.
                    console.debug('[ctx] refreshShipment failed for', shipmentId, errMsg);
                }
            }
        }
    }["ClearPortProvider.useCallback[refreshShipment]"], [
        apiFetchOrg
    ]);
    // --- Computed ---
    const selectedEntry = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"]({
        "ClearPortProvider.useMemo[selectedEntry]": ()=>entries.find({
                "ClearPortProvider.useMemo[selectedEntry]": (e)=>e.id === selectedEntryId
            }["ClearPortProvider.useMemo[selectedEntry]"])
    }["ClearPortProvider.useMemo[selectedEntry]"], [
        entries,
        selectedEntryId
    ]);
    const selectedException = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"]({
        "ClearPortProvider.useMemo[selectedException]": ()=>{
            if (!selectedEntry) return undefined;
            return selectedEntry.exceptions.find({
                "ClearPortProvider.useMemo[selectedException]": (ex)=>ex.id === selectedExceptionId
            }["ClearPortProvider.useMemo[selectedException]"]);
        }
    }["ClearPortProvider.useMemo[selectedException]"], [
        selectedEntry,
        selectedExceptionId
    ]);
    // --- Light polling: while the selected shipment's validation_status is
    // 'pending' or 'running', refresh it from the DB every 4 seconds so the
    // user sees status transitions + extracted fields + exceptions appear in
    // real time without manually refreshing. Stops the moment the status
    // reaches a terminal state (completed/failed/degraded) or the selection
    // changes to an already-terminal shipment.
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"]({
        "ClearPortProvider.useEffect": ()=>{
            if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isSupabaseConfigured"])()) return;
            const status = selectedEntry?.validationStatus;
            if (status !== 'pending' && status !== 'running') return;
            if (!selectedEntryId) return;
            const POLL_INTERVAL_MS = 4000;
            let cancelled = false;
            const tick = {
                "ClearPortProvider.useEffect.tick": async ()=>{
                    if (cancelled) return;
                    await refreshShipment(selectedEntryId);
                }
            }["ClearPortProvider.useEffect.tick"];
            // Fire one immediately (so a fast pipeline that already finished shows up
            // without waiting 4s), then on the interval.
            void tick();
            const interval = setInterval(tick, POLL_INTERVAL_MS);
            return ({
                "ClearPortProvider.useEffect": ()=>{
                    cancelled = true;
                    clearInterval(interval);
                }
            })["ClearPortProvider.useEffect"];
        }
    }["ClearPortProvider.useEffect"], [
        selectedEntryId,
        selectedEntry?.validationStatus,
        refreshShipment
    ]);
    // --- Selection (fixes stale closure — uses functional update) ---
    const selectEntry = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[selectEntry]": (id)=>{
            setSelectedEntryId(id);
            setEntries({
                "ClearPortProvider.useCallback[selectEntry]": (prev)=>{
                    const entry = prev.find({
                        "ClearPortProvider.useCallback[selectEntry].entry": (e)=>e.id === id
                    }["ClearPortProvider.useCallback[selectEntry].entry"]);
                    if (entry && entry.exceptions.length > 0) {
                        const unresolved = entry.exceptions.find({
                            "ClearPortProvider.useCallback[selectEntry].unresolved": (e)=>e.status === 'Unresolved'
                        }["ClearPortProvider.useCallback[selectEntry].unresolved"]);
                        setSelectedExceptionId(unresolved ? unresolved.id : entry.exceptions[0].id);
                    } else {
                        setSelectedExceptionId('');
                    }
                    return prev;
                }
            }["ClearPortProvider.useCallback[selectEntry]"]);
        }
    }["ClearPortProvider.useCallback[selectEntry]"], []);
    const selectException = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[selectException]": (id)=>{
            setSelectedExceptionId(id);
        }
    }["ClearPortProvider.useCallback[selectException]"], []);
    // --- Audit log helper ---
    const addAuditLog = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[addAuditLog]": (text, type = 'info', shipmentId)=>{
            const newLog = {
                id: typeof crypto !== 'undefined' ? crypto.randomUUID() : `log-${Date.now()}`,
                text,
                timestamp: new Date().toISOString(),
                type,
                shipmentId
            };
            setAuditLogs({
                "ClearPortProvider.useCallback[addAuditLog]": (prev)=>[
                        newLog,
                        ...prev
                    ]
            }["ClearPortProvider.useCallback[addAuditLog]"]);
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isSupabaseConfigured"])() && __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"]) {
                __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"].from('audit_logs').insert({
                    id: newLog.id,
                    text: newLog.text,
                    timestamp: newLog.timestamp,
                    type: newLog.type,
                    shipment_id: shipmentId || null
                }).then({
                    "ClearPortProvider.useCallback[addAuditLog]": ({ error })=>{
                        if (error) console.warn('[ctx] audit log insert failed:', error.message);
                    }
                }["ClearPortProvider.useCallback[addAuditLog]"]);
            }
        }
    }["ClearPortProvider.useCallback[addAuditLog]"], []);
    // --- Update exception (fixes setState-in-setState) ---
    const updateException = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[updateException]": (entryId, exceptionId, status, newValue)=>{
            let previousException;
            let updatedEntry;
            setEntries({
                "ClearPortProvider.useCallback[updateException]": (prevEntries)=>{
                    return prevEntries.map({
                        "ClearPortProvider.useCallback[updateException]": (entry)=>{
                            if (entry.id !== entryId) return entry;
                            const prev = entry.exceptions.find({
                                "ClearPortProvider.useCallback[updateException].prev": (ex)=>ex.id === exceptionId
                            }["ClearPortProvider.useCallback[updateException].prev"]);
                            if (!prev) return entry;
                            previousException = {
                                ...prev
                            };
                            const updatedExceptions = entry.exceptions.map({
                                "ClearPortProvider.useCallback[updateException].updatedExceptions": (ex)=>{
                                    if (ex.id !== exceptionId) return ex;
                                    const oldVal = ex.correctedValue || ex.extractedValue;
                                    const updatedVal = newValue !== undefined ? newValue : ex.extractedValue;
                                    const historyItem = {
                                        user: currentUser || 'unknown',
                                        oldValue: oldVal,
                                        newValue: updatedVal,
                                        timestamp: new Date().toISOString(),
                                        action: status
                                    };
                                    return {
                                        ...ex,
                                        status: status,
                                        correctedValue: status === 'Corrected' ? newValue : undefined,
                                        history: [
                                            historyItem,
                                            ...ex.history
                                        ],
                                        resolvedAt: new Date().toISOString(),
                                        resolvedBy: currentUser || undefined
                                    };
                                }
                            }["ClearPortProvider.useCallback[updateException].updatedExceptions"]);
                            const allResolved = updatedExceptions.every({
                                "ClearPortProvider.useCallback[updateException].allResolved": (ex)=>ex.status !== 'Unresolved'
                            }["ClearPortProvider.useCallback[updateException].allResolved"]);
                            const newStatus = allResolved ? 'Approved' : 'Under Review';
                            const newConfidence = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["calculateConfidence"])(entry.initialConfidence, updatedExceptions);
                            const updatedFields = entry.fields.map({
                                "ClearPortProvider.useCallback[updateException].updatedFields": (f)=>{
                                    if (f.exceptionId === exceptionId) {
                                        const val = status === 'Corrected' ? newValue || f.value : f.value;
                                        return {
                                            ...f,
                                            value: val,
                                            isFlagged: false
                                        };
                                    }
                                    return f;
                                }
                            }["ClearPortProvider.useCallback[updateException].updatedFields"]);
                            updatedEntry = {
                                ...entry,
                                status: newStatus,
                                exceptions: updatedExceptions,
                                fields: updatedFields,
                                currentConfidence: newConfidence
                            };
                            return updatedEntry;
                        }
                    }["ClearPortProvider.useCallback[updateException]"]);
                }
            }["ClearPortProvider.useCallback[updateException]"]);
            // Side effects AFTER setState
            if (previousException && updatedEntry) {
                setUndoStack({
                    "ClearPortProvider.useCallback[updateException]": (prevStack)=>[
                            {
                                entryId,
                                exceptionId,
                                previousState: {
                                    ...previousException
                                }
                            },
                            ...prevStack
                        ]
                }["ClearPortProvider.useCallback[updateException]"]);
                const logText = `Exception "${previousException.fieldName}" for ${entryId} was ${status.toLowerCase()}${status === 'Corrected' ? ` to "${newValue}"` : ''} by ${currentUser}.`;
                addAuditLog(logText, status === 'Rejected' ? 'warning' : 'success', entryId);
                // Persist via the /api/exceptions/:id route (handles exception update,
                // document_field sync, shipment confidence recompute, and audit log
                // in one server-side transaction). Uses the org-scoped wrapper so
                // the X-Org-Id header is sent.
                if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isSupabaseConfigured"])()) {
                    apiFetchOrg(`/api/exceptions/${exceptionId}`, {
                        method: 'PATCH',
                        body: JSON.stringify({
                            status,
                            correctedValue: status === 'Corrected' ? newValue : undefined
                        })
                    }).catch({
                        "ClearPortProvider.useCallback[updateException]": (err)=>{
                            console.warn('[ctx] exception update failed:', err instanceof Error ? err.message : err);
                        }
                    }["ClearPortProvider.useCallback[updateException]"]);
                }
            }
        }
    }["ClearPortProvider.useCallback[updateException]"], [
        currentUser,
        addAuditLog,
        apiFetchOrg
    ]);
    // --- Undo ---
    const undoLastAction = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[undoLastAction]": ()=>{
            if (undoStack.length === 0) return;
            const [lastAction, ...remainingStack] = undoStack;
            setUndoStack(remainingStack);
            setEntries({
                "ClearPortProvider.useCallback[undoLastAction]": (prevEntries)=>{
                    return prevEntries.map({
                        "ClearPortProvider.useCallback[undoLastAction]": (entry)=>{
                            if (entry.id !== lastAction.entryId) return entry;
                            const restored = lastAction.previousState;
                            const updatedExceptions = entry.exceptions.map({
                                "ClearPortProvider.useCallback[undoLastAction].updatedExceptions": (ex)=>ex.id === lastAction.exceptionId ? restored : ex
                            }["ClearPortProvider.useCallback[undoLastAction].updatedExceptions"]);
                            const allResolved = updatedExceptions.every({
                                "ClearPortProvider.useCallback[undoLastAction].allResolved": (ex)=>ex.status !== 'Unresolved'
                            }["ClearPortProvider.useCallback[undoLastAction].allResolved"]);
                            const newStatus = allResolved ? 'Approved' : 'Under Review';
                            const newConfidence = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["calculateConfidence"])(entry.initialConfidence, updatedExceptions);
                            const updatedFields = entry.fields.map({
                                "ClearPortProvider.useCallback[undoLastAction].updatedFields": (f)=>{
                                    if (f.exceptionId === lastAction.exceptionId) {
                                        return {
                                            ...f,
                                            value: restored.status === 'Corrected' ? restored.correctedValue || f.value : restored.extractedValue,
                                            isFlagged: restored.status === 'Unresolved'
                                        };
                                    }
                                    return f;
                                }
                            }["ClearPortProvider.useCallback[undoLastAction].updatedFields"]);
                            const updatedEntry = {
                                ...entry,
                                status: newStatus,
                                exceptions: updatedExceptions,
                                fields: updatedFields,
                                currentConfidence: newConfidence
                            };
                            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isSupabaseConfigured"])() && __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"]) {
                                __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"].from('exceptions').update({
                                    status: restored.status,
                                    corrected_value: restored.correctedValue || null,
                                    resolved_at: restored.resolvedAt || null,
                                    resolved_by: restored.resolvedBy || null,
                                    history: restored.history
                                }).eq('id', lastAction.exceptionId).then({
                                    "ClearPortProvider.useCallback[undoLastAction]": ({ error })=>{
                                        if (error) console.warn('[ctx] undo exception failed:', error.message);
                                    }
                                }["ClearPortProvider.useCallback[undoLastAction]"]);
                                __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"].from('shipments').update({
                                    status: newStatus,
                                    current_confidence: newConfidence,
                                    updated_at: new Date().toISOString()
                                }).eq('id', entry.id).then({
                                    "ClearPortProvider.useCallback[undoLastAction]": ({ error })=>{
                                        if (error) console.warn('[ctx] undo shipment failed:', error.message);
                                    }
                                }["ClearPortProvider.useCallback[undoLastAction]"]);
                            }
                            return updatedEntry;
                        }
                    }["ClearPortProvider.useCallback[undoLastAction]"]);
                }
            }["ClearPortProvider.useCallback[undoLastAction]"]);
            addAuditLog(`Undo applied for last review action on shipment ${lastAction.entryId}`, 'info', lastAction.entryId);
        }
    }["ClearPortProvider.useCallback[undoLastAction]"], [
        undoStack,
        addAuditLog
    ]);
    // --- Batch accept (uses configured threshold) ---
    const acceptAllHighConfidence = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[acceptAllHighConfidence]": (entryId)=>{
            setEntries({
                "ClearPortProvider.useCallback[acceptAllHighConfidence]": (prevEntries)=>{
                    return prevEntries.map({
                        "ClearPortProvider.useCallback[acceptAllHighConfidence]": (entry)=>{
                            if (entry.id !== entryId) return entry;
                            const cutoff = rules.invoiceThreshold;
                            let acceptedCount = 0;
                            const updatedExceptions = entry.exceptions.map({
                                "ClearPortProvider.useCallback[acceptAllHighConfidence].updatedExceptions": (ex)=>{
                                    if (ex.status === 'Unresolved' && ex.confidence >= cutoff) {
                                        acceptedCount++;
                                        const historyItem = {
                                            user: currentUser || 'unknown',
                                            oldValue: ex.extractedValue,
                                            newValue: ex.extractedValue,
                                            timestamp: new Date().toISOString(),
                                            action: 'Accepted'
                                        };
                                        return {
                                            ...ex,
                                            status: 'Accepted',
                                            history: [
                                                historyItem,
                                                ...ex.history
                                            ],
                                            resolvedAt: new Date().toISOString(),
                                            resolvedBy: currentUser || undefined
                                        };
                                    }
                                    return ex;
                                }
                            }["ClearPortProvider.useCallback[acceptAllHighConfidence].updatedExceptions"]);
                            if (acceptedCount === 0) return entry;
                            const allResolved = updatedExceptions.every({
                                "ClearPortProvider.useCallback[acceptAllHighConfidence].allResolved": (ex)=>ex.status !== 'Unresolved'
                            }["ClearPortProvider.useCallback[acceptAllHighConfidence].allResolved"]);
                            const newStatus = allResolved ? 'Approved' : 'Under Review';
                            const newConfidence = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["calculateConfidence"])(entry.initialConfidence, updatedExceptions);
                            const updatedFields = entry.fields.map({
                                "ClearPortProvider.useCallback[acceptAllHighConfidence].updatedFields": (f)=>{
                                    const exc = updatedExceptions.find({
                                        "ClearPortProvider.useCallback[acceptAllHighConfidence].updatedFields.exc": (e)=>e.id === f.exceptionId
                                    }["ClearPortProvider.useCallback[acceptAllHighConfidence].updatedFields.exc"]);
                                    if (exc) return {
                                        ...f,
                                        isFlagged: exc.status === 'Unresolved'
                                    };
                                    return f;
                                }
                            }["ClearPortProvider.useCallback[acceptAllHighConfidence].updatedFields"]);
                            const updatedEntry = {
                                ...entry,
                                status: newStatus,
                                exceptions: updatedExceptions,
                                fields: updatedFields,
                                currentConfidence: newConfidence
                            };
                            addAuditLog(`Batch action: Approved ${acceptedCount} high-confidence exceptions (≥${cutoff}%) in ${entryId}.`, 'success', entryId);
                            // Persist via the /api/exceptions/batch-accept route (accepts each
                            // qualifying exception, syncs document_fields, recomputes shipment
                            // confidence + status, and writes a batch-level audit log). Uses the
                            // org-scoped wrapper so the X-Org-Id header is sent.
                            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isSupabaseConfigured"])()) {
                                apiFetchOrg('/api/exceptions/batch-accept', {
                                    method: 'POST',
                                    body: JSON.stringify({
                                        shipmentId: entryId,
                                        threshold: cutoff
                                    })
                                }).catch({
                                    "ClearPortProvider.useCallback[acceptAllHighConfidence]": (err)=>{
                                        console.warn('[ctx] batch accept failed:', err instanceof Error ? err.message : err);
                                    }
                                }["ClearPortProvider.useCallback[acceptAllHighConfidence]"]);
                            }
                            return updatedEntry;
                        }
                    }["ClearPortProvider.useCallback[acceptAllHighConfidence]"]);
                }
            }["ClearPortProvider.useCallback[acceptAllHighConfidence]"]);
        }
    }["ClearPortProvider.useCallback[acceptAllHighConfidence]"], [
        rules.invoiceThreshold,
        currentUser,
        addAuditLog,
        apiFetchOrg
    ]);
    // --- Inline pipeline fallback (§3) ---
    // Used ONLY when the processing_jobs table doesn't exist (migration 018 not
    // run yet) or the queue insert fails. This is the old synchronous path that
    // calls the edge function directly from the browser. The primary path is the
    // queue + worker — this is the safety net so extraction still works during
    // the migration period.
    //
    // (§4 refactor: extracted to src/context/inline-pipeline.ts — behavior preserved)
    const runInlinePipeline = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[runInlinePipeline]": async (shipmentId, _detectedDocType)=>{
            const { runInlinePipeline: runPipeline } = await __turbopack_context__.A("[project]/src/context/inline-pipeline.ts [app-client] (ecmascript, async loader)");
            await runPipeline(shipmentId, apiFetchOrg, refreshShipment);
        }
    }["ClearPortProvider.useCallback[runInlinePipeline]"], [
        apiFetchOrg,
        refreshShipment
    ]);
    // --- Upload documents ---
    const uploadDocuments = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[uploadDocuments]": async (files)=>{
            const shipmentId = `SHIP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
            try {
                if (!(0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isSupabaseConfigured"])()) {
                    // Fallback
                    const newEntry = {
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
                        fields: []
                    };
                    const excId = typeof crypto !== 'undefined' ? crypto.randomUUID() : `${shipmentId}-address`;
                    newEntry.exceptions = [
                        {
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
                            boundingBox: {
                                x: 10,
                                y: 35,
                                w: 32,
                                h: 5
                            },
                            status: 'Unresolved',
                            history: [],
                            createdAt: new Date().toISOString()
                        }
                    ];
                    newEntry.fields = [
                        {
                            id: 'n1',
                            key: 'invoiceNo',
                            label: 'Commercial Invoice #',
                            value: 'TC-9921-KK',
                            sourceDoc: 'Commercial Invoice',
                            isFlagged: false,
                            confidence: 90
                        },
                        {
                            id: 'n2',
                            key: 'invoiceDate',
                            label: 'Invoice Date',
                            value: new Date().toISOString().split('T')[0],
                            sourceDoc: 'Commercial Invoice',
                            isFlagged: false,
                            confidence: 88
                        },
                        {
                            id: 'n3',
                            key: 'shipper',
                            label: 'Shipper / Exporter',
                            value: 'Titanium Castings KK',
                            sourceDoc: 'Commercial Invoice',
                            isFlagged: false,
                            confidence: 95
                        },
                        {
                            id: 'n4',
                            key: 'consignee',
                            label: 'Consignee / Importer',
                            value: 'Ironclad Logistics Inc.',
                            sourceDoc: 'Commercial Invoice',
                            isFlagged: false,
                            confidence: 94
                        },
                        {
                            id: 'n5',
                            key: 'consigneeAddress',
                            label: 'Consignee Address',
                            value: 'Suite 200, Seattle, WA',
                            sourceDoc: 'Commercial Invoice',
                            isFlagged: true,
                            confidence: 62,
                            exceptionId: excId,
                            crossDocValue: 'Suite 201, Seattle, WA'
                        },
                        {
                            id: 'n6',
                            key: 'declaredValue',
                            label: 'Total Declared Value',
                            value: '$45,210.00',
                            sourceDoc: 'Commercial Invoice',
                            isFlagged: false,
                            confidence: 87
                        },
                        {
                            id: 'n7',
                            key: 'htsCode',
                            label: 'HTS Code (Primary Line)',
                            value: '7308.90.0000',
                            sourceDoc: 'Commercial Invoice',
                            isFlagged: false,
                            confidence: 91
                        },
                        {
                            id: 'n8',
                            key: 'netWeight',
                            label: 'Total Net Weight',
                            value: '8,410 lbs',
                            sourceDoc: 'Bill of Lading',
                            isFlagged: false,
                            confidence: 89
                        }
                    ];
                    setEntries({
                        "ClearPortProvider.useCallback[uploadDocuments]": (prev)=>[
                                newEntry,
                                ...prev
                            ]
                    }["ClearPortProvider.useCallback[uploadDocuments]"]);
                    setSelectedEntryId(shipmentId);
                    setSelectedExceptionId(excId);
                    addAuditLog(`New entry ${shipmentId} ingestion and auto-analysis completed with 1 exception.`, 'info', shipmentId);
                    return {
                        shipmentId,
                        success: true
                    };
                }
                // Real pipeline
                await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ensureAuthenticated"])();
                // Step 1: Upload each file to Storage via edge function
                for (const file of files){
                    const formData = new FormData();
                    formData.append('file', file);
                    formData.append('shipment_id', shipmentId);
                    try {
                        if (__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"]) {
                            const { error } = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"].functions.invoke('upload-document', {
                                body: formData
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
                if (__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"]) {
                    await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"].from('shipments').upsert({
                        id: shipmentId,
                        shipper: 'Pending Extraction',
                        consignee: 'Pending Extraction',
                        status: 'Under Review',
                        docs_count: files.length,
                        urgency: '08:30:00',
                        initial_confidence: 0,
                        current_confidence: 0,
                        validation_status: 'pending'
                    }).then({
                        "ClearPortProvider.useCallback[uploadDocuments]": ({ error })=>{
                            if (error) console.warn('[upload] shipment upsert:', error.message);
                        }
                    }["ClearPortProvider.useCallback[uploadDocuments]"]);
                }
                // Detect document type from the first file's name
                const detectDocType = {
                    "ClearPortProvider.useCallback[uploadDocuments].detectDocType": (fileName)=>{
                        const lower = fileName.toLowerCase();
                        if (lower.includes('packing') || lower.includes('pack')) return 'Packing List';
                        if (lower.includes('lading') || lower.includes('bol')) return 'Bill of Lading';
                        if (lower.includes('origin') || lower.includes('coo')) return 'Certificate of Origin';
                        return 'Commercial Invoice';
                    }
                }["ClearPortProvider.useCallback[uploadDocuments].detectDocType"];
                const detectedDocType = files.length > 0 ? detectDocType(files[0].name) : 'Commercial Invoice';
                // ── IMMEDIATE RESPONSE: add a placeholder entry + select it ──
                // The user sees "received, processing" right away. The background
                // pipeline (below) + the polling effect keep the entry fresh as the
                // chain progresses: pending → running → completed/failed/degraded.
                const placeholderEntry = {
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
                    validationStatus: 'pending'
                };
                setEntries({
                    "ClearPortProvider.useCallback[uploadDocuments]": (prev)=>[
                            placeholderEntry,
                            ...prev.filter({
                                "ClearPortProvider.useCallback[uploadDocuments]": (e)=>e.id !== shipmentId
                            }["ClearPortProvider.useCallback[uploadDocuments]"])
                        ]
                }["ClearPortProvider.useCallback[uploadDocuments]"]);
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
                    if (!__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"]) throw new Error('Supabase client not initialized');
                    const { error: jobErr } = await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"].from('processing_jobs').insert({
                        shipment_id: shipmentId,
                        org_id: currentOrgIdRef.current,
                        job_type: 'extraction',
                        status: 'queued',
                        trace_id: traceId
                    });
                    if (jobErr) {
                        console.warn('[queue] failed to write processing_jobs row:', jobErr.message);
                        // Fallback: if the processing_jobs table doesn't exist yet (migration
                        // not run), fall back to the old inline pipeline so extraction still
                        // works. This is a safety net, not the primary path.
                        addAuditLog('[queue] processing_jobs table not available — falling back to inline extraction', 'warning', shipmentId);
                        void runInlinePipeline(shipmentId, detectedDocType).catch({
                            "ClearPortProvider.useCallback[uploadDocuments]": (err)=>{
                                console.error('[pipeline] inline fallback failed:', err);
                            }
                        }["ClearPortProvider.useCallback[uploadDocuments]"]);
                    } else {
                        addAuditLog(`[queue] Extraction job queued for ${shipmentId} (trace: ${traceId.slice(0, 8)})`, 'info', shipmentId);
                    }
                } catch (err) {
                    console.error('[queue] unexpected error writing job:', err);
                    // Same fallback — don't let a queue failure prevent extraction
                    void runInlinePipeline(shipmentId, detectedDocType).catch({
                        "ClearPortProvider.useCallback[uploadDocuments]": ()=>{}
                    }["ClearPortProvider.useCallback[uploadDocuments]"]);
                }
                // Return immediately — the user has already seen "received, processing".
                // The worker process will pick up the job and run the extraction + validation
                // pipeline. The polling effect (every 4s) keeps the UI in sync with the DB.
                return {
                    shipmentId,
                    success: true
                };
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : 'Upload pipeline failed';
                addAuditLog(`Upload failed for ${shipmentId}: ${errMsg}`, 'error', shipmentId);
                return {
                    shipmentId,
                    success: false,
                    error: errMsg
                };
            }
        }
    }["ClearPortProvider.useCallback[uploadDocuments]"], [
        rules,
        addAuditLog,
        refreshShipment,
        apiFetchOrg
    ]);
    // --- Update rules ---
    const updateRules = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[updateRules]": (newRules)=>{
            setRules({
                "ClearPortProvider.useCallback[updateRules]": (prev)=>{
                    const updated = {
                        ...prev,
                        ...newRules
                    };
                    // Persist via the /api/rules route (upserts the org's rules row).
                    // Uses the org-scoped wrapper so the X-Org-Id header is sent.
                    if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isSupabaseConfigured"])()) {
                        apiFetchOrg('/api/rules', {
                            method: 'PATCH',
                            body: JSON.stringify(newRules)
                        }).catch({
                            "ClearPortProvider.useCallback[updateRules]": (err)=>{
                                console.warn('[ctx] rules update failed:', err instanceof Error ? err.message : err);
                            }
                        }["ClearPortProvider.useCallback[updateRules]"]);
                    }
                    return updated;
                }
            }["ClearPortProvider.useCallback[updateRules]"]);
            addAuditLog('Compliance operational thresholds updated.', 'info');
        }
    }["ClearPortProvider.useCallback[updateRules]"], [
        addAuditLog,
        apiFetchOrg
    ]);
    // --- Real CSV export ---
    const exportToCSV = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"]({
        "ClearPortProvider.useCallback[exportToCSV]": async (entryId)=>{
            const entry = entries.find({
                "ClearPortProvider.useCallback[exportToCSV].entry": (e)=>e.id === entryId
            }["ClearPortProvider.useCallback[exportToCSV].entry"]);
            if (!entry) return;
            // Try the /api/export/:id route first (generates CSV server-side from the
            // DB-backed shipment data and returns it as text/csv). Uses the org-scoped
            // wrapper so the X-Org-Id header is sent.
            if ((0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["isSupabaseConfigured"])()) {
                try {
                    const res = await apiFetchOrg(`/api/export/${entryId}`, {
                        raw: true
                    });
                    if (res.ok) {
                        const csv = await res.text();
                        if (csv) {
                            const blob = new Blob([
                                csv
                            ], {
                                type: 'text/csv'
                            });
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
            const rows = [];
            rows.push('Field Key,Field Label,Value,Source Document,Confidence,Flagged,Status');
            entry.fields.forEach({
                "ClearPortProvider.useCallback[exportToCSV]": (f)=>{
                    const exc = entry.exceptions.find({
                        "ClearPortProvider.useCallback[exportToCSV].exc": (e)=>e.id === f.exceptionId
                    }["ClearPortProvider.useCallback[exportToCSV].exc"]);
                    const status = exc ? exc.status : 'SECURE';
                    const escaped = [
                        f.key,
                        f.label,
                        f.value,
                        f.sourceDoc,
                        f.confidence,
                        f.isFlagged,
                        status
                    ].map({
                        "ClearPortProvider.useCallback[exportToCSV].escaped": (v)=>`"${String(v).replace(/"/g, '""')}"`
                    }["ClearPortProvider.useCallback[exportToCSV].escaped"]).join(',');
                    rows.push(escaped);
                }
            }["ClearPortProvider.useCallback[exportToCSV]"]);
            rows.push('');
            rows.push('Exception ID,Field Name,Reason,Confidence,Status,Resolved By');
            entry.exceptions.forEach({
                "ClearPortProvider.useCallback[exportToCSV]": (e)=>{
                    const escaped = [
                        e.id,
                        e.fieldName,
                        e.reason,
                        e.confidence,
                        e.status,
                        e.resolvedBy || ''
                    ].map({
                        "ClearPortProvider.useCallback[exportToCSV].escaped": (v)=>`"${String(v).replace(/"/g, '""')}"`
                    }["ClearPortProvider.useCallback[exportToCSV].escaped"]).join(',');
                    rows.push(escaped);
                }
            }["ClearPortProvider.useCallback[exportToCSV]"]);
            const csv = rows.join('\n');
            const blob = new Blob([
                csv
            ], {
                type: 'text/csv'
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ClearPort_Audit_${entryId}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            addAuditLog(`Audit logs exported to CSV for ${entryId}.`, 'success', entryId);
        }
    }["ClearPortProvider.useCallback[exportToCSV]"], [
        entries,
        addAuditLog,
        apiFetchOrg
    ]);
    const value = {
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
        switchOrg
    };
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(ClearPortContext.Provider, {
        value: value,
        children: children
    }, void 0, false, {
        fileName: "[project]/src/context/ClearPortContext.tsx",
        lineNumber: 1022,
        columnNumber: 5
    }, ("TURBOPACK compile-time value", void 0));
};
_s(ClearPortProvider, "HTskONb2RIO3RFOApjxJKKPM7lw=");
_c = ClearPortProvider;
function useClearPort() {
    _s1();
    const context = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useContext"](ClearPortContext);
    if (context === undefined) {
        throw new Error('useClearPort must be used within a ClearPortProvider');
    }
    return context;
}
_s1(useClearPort, "b9L3QQ+jgeyIrH0NfHrJ8nn7VMU=");
var _c;
__turbopack_context__.k.register(_c, "ClearPortProvider");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
"[project]/src/app/page.tsx [app-client] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>MasterPage
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/client/app-dir/link.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$context$2f$ClearPortContext$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/context/ClearPortContext.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$Dashboard$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/Dashboard.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$IngestUpload$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/IngestUpload.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$ExceptionDesk$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/ExceptionDesk.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$CrossDocAuditor$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/CrossDocAuditor.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$BrokerAnalytics$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/BrokerAnalytics.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$OperationalRules$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/OperationalRules.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$EntryDetailView$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/EntryDetailView.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$BrokerTemplates$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/BrokerTemplates.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$TeamManagement$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/TeamManagement.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$SupabaseSyncPanel$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/SupabaseSyncPanel.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$AlertBanner$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/AlertBanner.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$ErrorBoundary$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/clearport/ErrorBoundary.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$shield$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Shield$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/shield.js [app-client] (ecmascript) <export default as Shield>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$cpu$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Cpu$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/cpu.js [app-client] (ecmascript) <export default as Cpu>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$database$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Database$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/database.js [app-client] (ecmascript) <export default as Database>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$layout$2d$dashboard$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__LayoutDashboard$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/layout-dashboard.js [app-client] (ecmascript) <export default as LayoutDashboard>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$cloud$2d$upload$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__UploadCloud$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/cloud-upload.js [app-client] (ecmascript) <export default as UploadCloud>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$file$2d$warning$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__FileWarning$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/file-warning.js [app-client] (ecmascript) <export default as FileWarning>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$search$2d$code$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__SearchCode$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/search-code.js [app-client] (ecmascript) <export default as SearchCode>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$trending$2d$up$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__TrendingUp$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/trending-up.js [app-client] (ecmascript) <export default as TrendingUp>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$history$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__History$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/history.js [app-client] (ecmascript) <export default as History>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$settings$2d$2$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Settings2$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/settings-2.js [app-client] (ecmascript) <export default as Settings2>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$file$2d$spreadsheet$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__FileSpreadsheet$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/file-spreadsheet.js [app-client] (ecmascript) <export default as FileSpreadsheet>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$users$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Users$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/users.js [app-client] (ecmascript) <export default as Users>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$menu$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Menu$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/menu.js [app-client] (ecmascript) <export default as Menu>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$x$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__X$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/x.js [app-client] (ecmascript) <export default as X>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$wifi$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Wifi$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/wifi.js [app-client] (ecmascript) <export default as Wifi>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$wifi$2d$off$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__WifiOff$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/wifi-off.js [app-client] (ecmascript) <export default as WifiOff>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$log$2d$out$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__LogOut$3e$__ = __turbopack_context__.i("[project]/node_modules/lucide-react/dist/esm/icons/log-out.js [app-client] (ecmascript) <export default as LogOut>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/framer-motion/dist/es/render/components/motion/proxy.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$components$2f$AnimatePresence$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/framer-motion/dist/es/components/AnimatePresence/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/supabase.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature(), _s1 = __turbopack_context__.k.signature();
'use client';
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
;
function AppShell() {
    _s();
    const { activeTab, setActiveTab, entries, theme, supabaseStatus, edgeFunctionStatus, currentUser, currentTime, userOrgs, currentOrgId, switchOrg } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$context$2f$ClearPortContext$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useClearPort"])();
    const [isSupabaseOpen, setIsSupabaseOpen] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"](false);
    const [isMobileSidebarOpen, setIsMobileSidebarOpen] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"](false);
    const [isOrgMenuOpen, setIsOrgMenuOpen] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"](false);
    const orgMenuRef = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"](null);
    // Close the org-switcher dropdown on outside click.
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"]({
        "AppShell.useEffect": ()=>{
            if (!isOrgMenuOpen) return;
            const handler = {
                "AppShell.useEffect.handler": (e)=>{
                    if (orgMenuRef.current && !orgMenuRef.current.contains(e.target)) {
                        setIsOrgMenuOpen(false);
                    }
                }
            }["AppShell.useEffect.handler"];
            document.addEventListener('mousedown', handler);
            return ({
                "AppShell.useEffect": ()=>document.removeEventListener('mousedown', handler)
            })["AppShell.useEffect"];
        }
    }["AppShell.useEffect"], [
        isOrgMenuOpen
    ]);
    // Current org display name (falls back to a placeholder before the first
    // org list load completes).
    const currentOrgName = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"]({
        "AppShell.useMemo[currentOrgName]": ()=>userOrgs.find({
                "AppShell.useMemo[currentOrgName]": (o)=>o.org_id === currentOrgId
            }["AppShell.useMemo[currentOrgName]"])?.org_name ?? 'Personal'
    }["AppShell.useMemo[currentOrgName]"], [
        userOrgs,
        currentOrgId
    ]);
    // Dynamic notification badges
    const activeExceptionsCount = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"]({
        "AppShell.useMemo[activeExceptionsCount]": ()=>{
            return entries.reduce({
                "AppShell.useMemo[activeExceptionsCount]": (acc, curr)=>{
                    return acc + curr.exceptions.filter({
                        "AppShell.useMemo[activeExceptionsCount]": (e)=>e.status === 'Unresolved'
                    }["AppShell.useMemo[activeExceptionsCount]"]).length;
                }
            }["AppShell.useMemo[activeExceptionsCount]"], 0);
        }
    }["AppShell.useMemo[activeExceptionsCount]"], [
        entries
    ]);
    const hasWeightDiscrepancy = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"]({
        "AppShell.useMemo[hasWeightDiscrepancy]": ()=>{
            return entries.some({
                "AppShell.useMemo[hasWeightDiscrepancy]": (ent)=>ent.exceptions.some({
                        "AppShell.useMemo[hasWeightDiscrepancy]": (ex)=>ex.fieldKey === 'netWeight' && ex.status === 'Unresolved'
                    }["AppShell.useMemo[hasWeightDiscrepancy]"])
            }["AppShell.useMemo[hasWeightDiscrepancy]"]);
        }
    }["AppShell.useMemo[hasWeightDiscrepancy]"], [
        entries
    ]);
    const menuItems = [
        {
            id: 'dashboard',
            label: 'Command Center',
            icon: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$layout$2d$dashboard$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__LayoutDashboard$3e$__["LayoutDashboard"]
        },
        {
            id: 'ingest',
            label: 'Ingest Desk',
            icon: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$cloud$2d$upload$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__UploadCloud$3e$__["UploadCloud"]
        },
        {
            id: 'exception-desk',
            label: 'Exception Desk',
            icon: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$file$2d$warning$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__FileWarning$3e$__["FileWarning"],
            badge: activeExceptionsCount > 0 ? activeExceptionsCount : undefined
        },
        {
            id: 'cross-doc',
            label: 'Cross-Doc Auditor',
            icon: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$search$2d$code$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__SearchCode$3e$__["SearchCode"],
            badgeDot: hasWeightDiscrepancy
        },
        {
            id: 'analytics',
            label: 'Broker Analytics',
            icon: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$trending$2d$up$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__TrendingUp$3e$__["TrendingUp"]
        },
        {
            id: 'entry-detail',
            label: 'Entry Detail View',
            icon: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$history$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__History$3e$__["History"]
        },
        {
            id: 'rules',
            label: 'Operational Rules',
            icon: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$settings$2d$2$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Settings2$3e$__["Settings2"]
        },
        {
            id: 'broker-templates',
            label: 'Broker Templates',
            icon: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$file$2d$spreadsheet$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__FileSpreadsheet$3e$__["FileSpreadsheet"]
        },
        {
            id: 'team',
            label: 'Team & Invites',
            icon: __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$users$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Users$3e$__["Users"]
        }
    ];
    const renderActiveView = ()=>{
        switch(activeTab){
            case 'dashboard':
                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$Dashboard$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 115,
                    columnNumber: 32
                }, this);
            case 'ingest':
                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$IngestUpload$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 116,
                    columnNumber: 29
                }, this);
            case 'exception-desk':
                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$ExceptionDesk$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 117,
                    columnNumber: 37
                }, this);
            case 'cross-doc':
                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$CrossDocAuditor$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 118,
                    columnNumber: 32
                }, this);
            case 'analytics':
                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$BrokerAnalytics$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 119,
                    columnNumber: 32
                }, this);
            case 'rules':
                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$OperationalRules$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 120,
                    columnNumber: 28
                }, this);
            case 'entry-detail':
                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$EntryDetailView$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 121,
                    columnNumber: 35
                }, this);
            case 'broker-templates':
                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$BrokerTemplates$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 122,
                    columnNumber: 39
                }, this);
            case 'team':
                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$TeamManagement$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 123,
                    columnNumber: 27
                }, this);
            default:
                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$ExceptionDesk$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                    fileName: "[project]/src/app/page.tsx",
                    lineNumber: 124,
                    columnNumber: 23
                }, this);
        }
    };
    const getViewTitle = ()=>{
        const item = menuItems.find((m)=>m.id === activeTab);
        return item ? item.label : 'ClearPort';
    };
    // Logout — signs out of Supabase and redirects to /login
    const handleLogout = async ()=>{
        try {
            await __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$supabase$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["supabase"]?.auth.signOut();
        } catch (err) {
            console.warn('[auth] signOut error:', err);
        }
        window.location.href = '/login';
    };
    // Shorten user display (handle null — user may not be logged in yet)
    const userDisplay = currentUser ? currentUser.includes('@') ? currentUser.split('@')[0] : currentUser : 'Guest';
    const userInitials = userDisplay.slice(0, 2).toUpperCase();
    const sidebarContent = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Fragment"], {
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: `p-5 border-b flex items-center gap-2 transition-colors duration-200 ${theme === 'light' ? 'bg-gray-50 border-gray-200' : 'bg-[#0d0e14] border-gray-900'}`,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "w-7 h-7 bg-amber-500 rounded-lg flex items-center justify-center font-bold text-black text-sm tracking-tighter",
                                children: "CP"
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 156,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("h1", {
                                        className: `text-sm font-bold tracking-tight uppercase ${theme === 'light' ? 'text-gray-900' : 'text-white'}`,
                                        children: "ClearPort"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 160,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: `font-mono text-[9px] block leading-none mt-1 ${theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`,
                                        children: "v5.0 // PRODUCTION"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 163,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 159,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 153,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("nav", {
                        className: "p-3 space-y-1 mt-4",
                        children: menuItems.map((item)=>{
                            const Icon = item.icon;
                            const isActive = activeTab === item.id;
                            return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                onClick: ()=>{
                                    setActiveTab(item.id);
                                    setIsMobileSidebarOpen(false);
                                },
                                className: `w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition-all group cursor-pointer ${isActive ? theme === 'light' ? 'bg-gray-200 text-gray-900 shadow-sm' : 'bg-gray-900 text-white shadow-sm' : theme === 'light' ? 'text-gray-500 hover:text-gray-900 hover:bg-gray-100' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-950/60'}`,
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "flex items-center gap-2.5",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(Icon, {
                                                className: `w-4 h-4 transition-all ${isActive ? 'text-amber-500' : 'text-gray-500 group-hover:text-gray-400'}`
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 192,
                                                columnNumber: 19
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                children: item.label
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 195,
                                                columnNumber: 19
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 191,
                                        columnNumber: 17
                                    }, this),
                                    item.badge && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "font-mono text-[10px] font-bold bg-amber-950 text-amber-400 border border-amber-900/40 px-1.5 py-0.5 rounded leading-none shrink-0",
                                        children: item.badge
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 199,
                                        columnNumber: 19
                                    }, this),
                                    item.badgeDot && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "w-1.5 h-1.5 bg-red-500 rounded-full animate-ping shrink-0 mr-1"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 205,
                                        columnNumber: 19
                                    }, this)
                                ]
                            }, item.id, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 175,
                                columnNumber: 15
                            }, this);
                        })
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 170,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 152,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: `p-4 border-t space-y-3 transition-colors duration-200 ${theme === 'light' ? 'bg-gray-50 border-gray-200' : 'bg-[#08090d] border-gray-900'}`,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "flex items-center gap-2.5",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: `w-7 h-7 rounded-full flex items-center justify-center text-xs font-mono font-bold ${theme === 'light' ? 'bg-gray-200 text-gray-600' : 'bg-gray-900 text-gray-400'}`,
                                children: userInitials
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 218,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "overflow-hidden flex-1 min-w-0",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: `text-[11px] font-bold block truncate ${theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`,
                                        title: currentUser || undefined,
                                        children: userDisplay
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 224,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "text-[9px] text-gray-500 font-mono block leading-none mt-0.5",
                                        children: currentUser ? 'Signed in' : 'Not signed in'
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 227,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 223,
                                columnNumber: 11
                            }, this),
                            currentUser && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                onClick: handleLogout,
                                title: "Sign out",
                                className: `p-1.5 rounded-md transition-all cursor-pointer shrink-0 ${theme === 'light' ? 'hover:bg-gray-200 text-gray-500 hover:text-gray-700' : 'hover:bg-gray-900 text-gray-500 hover:text-gray-300'}`,
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$log$2d$out$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__LogOut$3e$__["LogOut"], {
                                    className: "w-3.5 h-3.5"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 242,
                                    columnNumber: 15
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 233,
                                columnNumber: 13
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 217,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: `flex items-center justify-between text-[10px] font-mono border-t pt-2 ${theme === 'light' ? 'border-gray-200 text-gray-500' : 'border-gray-900 text-gray-500'}`,
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "flex items-center gap-1",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: `w-1.5 h-1.5 rounded-full ${edgeFunctionStatus === 'live' ? 'bg-emerald-500' : 'bg-amber-500'}`
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 251,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        children: edgeFunctionStatus === 'live' ? 'EDGE LIVE' : 'FALLBACK MODE'
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 254,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 250,
                                columnNumber: 11
                            }, this),
                            edgeFunctionStatus === 'live' ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$wifi$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Wifi$3e$__["Wifi"], {
                                className: "w-3 h-3 text-emerald-500"
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 257,
                                columnNumber: 15
                            }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$wifi$2d$off$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__WifiOff$3e$__["WifiOff"], {
                                className: "w-3 h-3 text-amber-500"
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 258,
                                columnNumber: 15
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 247,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 214,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: `min-h-screen font-sans flex flex-col overflow-hidden transition-colors duration-200 ${theme === 'light' ? 'bg-[#f4f5f7] text-gray-800' : 'bg-[#06070a] text-gray-200'}`,
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: `md:hidden flex items-center justify-between px-4 py-3 border-b ${theme === 'light' ? 'bg-white border-gray-200' : 'bg-[#0a0b10] border-gray-900'}`,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "flex items-center gap-2",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "w-6 h-6 bg-amber-500 rounded flex items-center justify-center font-bold text-black text-xs",
                                children: "CP"
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 278,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                className: `text-sm font-bold uppercase ${theme === 'light' ? 'text-gray-900' : 'text-white'}`,
                                children: "ClearPort"
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 279,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 277,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                        onClick: ()=>setIsMobileSidebarOpen(true),
                        className: `p-2 rounded-lg ${theme === 'light' ? 'hover:bg-gray-100' : 'hover:bg-gray-900'}`,
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$menu$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Menu$3e$__["Menu"], {
                            className: "w-5 h-5"
                        }, void 0, false, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 285,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 281,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 274,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "flex flex-1 overflow-hidden",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("aside", {
                        className: `hidden md:flex w-64 flex-col justify-between shrink-0 select-none z-20 transition-colors duration-200 ${theme === 'light' ? 'bg-white border-r border-gray-200 text-gray-800' : 'bg-[#0a0b10] border-r border-gray-900 text-gray-200'}`,
                        children: sidebarContent
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 291,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$components$2f$AnimatePresence$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["AnimatePresence"], {
                        children: isMobileSidebarOpen && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Fragment"], {
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["motion"].div, {
                                    initial: {
                                        opacity: 0
                                    },
                                    animate: {
                                        opacity: 1
                                    },
                                    exit: {
                                        opacity: 0
                                    },
                                    onClick: ()=>setIsMobileSidebarOpen(false),
                                    className: "md:hidden fixed inset-0 bg-black/60 z-40"
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 303,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["motion"].aside, {
                                    initial: {
                                        x: -300
                                    },
                                    animate: {
                                        x: 0
                                    },
                                    exit: {
                                        x: -300
                                    },
                                    transition: {
                                        type: 'tween',
                                        duration: 0.2
                                    },
                                    className: `md:hidden fixed left-0 top-0 bottom-0 w-64 flex flex-col justify-between z-50 ${theme === 'light' ? 'bg-white border-r border-gray-200' : 'bg-[#0a0b10] border-r border-gray-900'}`,
                                    children: [
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                            onClick: ()=>setIsMobileSidebarOpen(false),
                                            className: "absolute top-4 right-4 p-1 rounded",
                                            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$x$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__X$3e$__["X"], {
                                                className: "w-5 h-5"
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 325,
                                                columnNumber: 19
                                            }, this)
                                        }, void 0, false, {
                                            fileName: "[project]/src/app/page.tsx",
                                            lineNumber: 321,
                                            columnNumber: 17
                                        }, this),
                                        sidebarContent
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 310,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, void 0, true)
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 300,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("main", {
                        className: "flex-1 flex flex-col overflow-hidden relative min-w-0",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("header", {
                                className: `h-14 backdrop-blur border-b px-6 flex items-center justify-between shrink-0 select-none z-10 transition-colors duration-200 ${theme === 'light' ? 'bg-white/80 border-gray-200' : 'bg-[#0a0b10]/60 border-gray-900'}`,
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "flex items-center gap-2 font-mono text-xs text-gray-500 uppercase tracking-widest truncate",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$cpu$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Cpu$3e$__["Cpu"], {
                                                className: "w-4 h-4 text-gray-500 shrink-0"
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 342,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "hidden sm:inline",
                                                children: "CORE NODE:"
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 343,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "hidden sm:inline text-gray-600",
                                                children: "SECURE SUITE"
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 344,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "text-gray-600 hidden sm:inline",
                                                children: "/"
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 345,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: `font-bold truncate ${theme === 'light' ? 'text-gray-800' : 'text-gray-400'}`,
                                                children: getViewTitle()
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 346,
                                                columnNumber: 15
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 341,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "flex items-center gap-4 shrink-0",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                                onClick: ()=>setIsSupabaseOpen(true),
                                                className: `border px-2.5 py-1 rounded-md flex items-center gap-1.5 font-mono text-[10px] transition-all cursor-pointer hover:scale-[1.02] active:scale-[0.98] ${supabaseStatus === 'connected' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : supabaseStatus === 'loading' ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 animate-pulse' : supabaseStatus === 'error_tables' ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-gray-500/5 border-gray-700 text-gray-500'}`,
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$database$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Database$3e$__["Database"], {
                                                        className: "w-3.5 h-3.5"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 365,
                                                        columnNumber: 17
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "font-extrabold uppercase hidden sm:inline",
                                                        children: [
                                                            "SUPABASE: ",
                                                            supabaseStatus === 'connected' ? 'LIVE SYNC' : supabaseStatus === 'loading' ? 'CONNECTING...' : supabaseStatus === 'error_tables' ? 'TABLES MISSING' : 'OFFLINE'
                                                        ]
                                                    }, void 0, true, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 366,
                                                        columnNumber: 17
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "font-extrabold uppercase sm:hidden",
                                                        children: supabaseStatus === 'connected' ? 'LIVE' : supabaseStatus === 'loading' ? '...' : 'OFF'
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 373,
                                                        columnNumber: 17
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 353,
                                                columnNumber: 15
                                            }, this),
                                            userOrgs.length > 1 && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                className: "relative",
                                                ref: orgMenuRef,
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                                        onClick: ()=>setIsOrgMenuOpen((v)=>!v),
                                                        className: `border px-2.5 py-1 rounded-md flex items-center gap-1.5 font-mono text-[10px] transition-all cursor-pointer hover:scale-[1.02] active:scale-[0.98] ${theme === 'light' ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-amber-500/10 border-amber-500/30 text-amber-400'}`,
                                                        title: "Switch organization",
                                                        children: [
                                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                                className: "font-extrabold uppercase hidden sm:inline",
                                                                children: "ORG:"
                                                            }, void 0, false, {
                                                                fileName: "[project]/src/app/page.tsx",
                                                                lineNumber: 392,
                                                                columnNumber: 21
                                                            }, this),
                                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                                className: "font-bold uppercase max-w-[140px] truncate",
                                                                children: currentOrgName
                                                            }, void 0, false, {
                                                                fileName: "[project]/src/app/page.tsx",
                                                                lineNumber: 393,
                                                                columnNumber: 21
                                                            }, this),
                                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("svg", {
                                                                className: `w-3 h-3 transition-transform ${isOrgMenuOpen ? 'rotate-180' : ''}`,
                                                                fill: "none",
                                                                stroke: "currentColor",
                                                                viewBox: "0 0 24 24",
                                                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("path", {
                                                                    strokeLinecap: "round",
                                                                    strokeLinejoin: "round",
                                                                    strokeWidth: 2.5,
                                                                    d: "M19 9l-7 7-7-7"
                                                                }, void 0, false, {
                                                                    fileName: "[project]/src/app/page.tsx",
                                                                    lineNumber: 398,
                                                                    columnNumber: 23
                                                                }, this)
                                                            }, void 0, false, {
                                                                fileName: "[project]/src/app/page.tsx",
                                                                lineNumber: 394,
                                                                columnNumber: 21
                                                            }, this)
                                                        ]
                                                    }, void 0, true, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 383,
                                                        columnNumber: 19
                                                    }, this),
                                                    isOrgMenuOpen && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                        className: `absolute right-0 mt-1 min-w-[200px] rounded-md border shadow-lg z-30 overflow-hidden ${theme === 'light' ? 'bg-white border-gray-200' : 'bg-[#0d0e14] border-gray-800'}`,
                                                        children: [
                                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                                className: `px-3 py-1.5 text-[9px] font-mono uppercase tracking-wider border-b ${theme === 'light' ? 'text-gray-400 border-gray-200' : 'text-gray-500 border-gray-900'}`,
                                                                children: "Switch Organization"
                                                            }, void 0, false, {
                                                                fileName: "[project]/src/app/page.tsx",
                                                                lineNumber: 409,
                                                                columnNumber: 23
                                                            }, this),
                                                            userOrgs.map((org)=>{
                                                                const isActive = org.org_id === currentOrgId;
                                                                return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                                                    onClick: ()=>{
                                                                        switchOrg(org.org_id);
                                                                        setIsOrgMenuOpen(false);
                                                                    },
                                                                    className: `w-full text-left px-3 py-2 flex items-center justify-between gap-2 transition-colors ${isActive ? theme === 'light' ? 'bg-amber-50 text-amber-700' : 'bg-amber-500/10 text-amber-400' : theme === 'light' ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-900/60'}`,
                                                                    children: [
                                                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                                            className: "text-xs font-semibold truncate",
                                                                            children: org.org_name
                                                                        }, void 0, false, {
                                                                            fileName: "[project]/src/app/page.tsx",
                                                                            lineNumber: 433,
                                                                            columnNumber: 29
                                                                        }, this),
                                                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                                            className: `text-[9px] font-mono uppercase shrink-0 ${isActive ? theme === 'light' ? 'text-amber-600' : 'text-amber-500' : theme === 'light' ? 'text-gray-400' : 'text-gray-500'}`,
                                                                            children: org.role
                                                                        }, void 0, false, {
                                                                            fileName: "[project]/src/app/page.tsx",
                                                                            lineNumber: 434,
                                                                            columnNumber: 29
                                                                        }, this)
                                                                    ]
                                                                }, org.org_id, true, {
                                                                    fileName: "[project]/src/app/page.tsx",
                                                                    lineNumber: 417,
                                                                    columnNumber: 27
                                                                }, this);
                                                            })
                                                        ]
                                                    }, void 0, true, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 402,
                                                        columnNumber: 21
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 382,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                className: "hidden lg:flex items-center gap-1.5 font-mono text-[10px] text-gray-500 uppercase",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        children: "LOCAL_TIME:"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 451,
                                                        columnNumber: 17
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: `font-bold ${theme === 'light' ? 'text-gray-800' : 'text-gray-300'}`,
                                                        children: currentTime || '—'
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 452,
                                                        columnNumber: 17
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 450,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                className: `border px-3 py-1 rounded-md flex items-center gap-1.5 font-mono text-[10px] transition-colors duration-200 ${theme === 'light' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-black/40 border-gray-900 text-emerald-400'}`,
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$lucide$2d$react$2f$dist$2f$esm$2f$icons$2f$shield$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$export__default__as__Shield$3e$__["Shield"], {
                                                        className: "w-3.5 h-3.5 text-emerald-500"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 463,
                                                        columnNumber: 17
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "font-extrabold uppercase hidden md:inline",
                                                        children: "SECURE CHANNEL // ACTIVE"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 464,
                                                        columnNumber: 17
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "font-extrabold uppercase md:hidden",
                                                        children: "SECURE"
                                                    }, void 0, false, {
                                                        fileName: "[project]/src/app/page.tsx",
                                                        lineNumber: 465,
                                                        columnNumber: 17
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 458,
                                                columnNumber: 15
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 351,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 336,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$AlertBanner$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {}, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 474,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "flex-1 overflow-hidden relative",
                                children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$components$2f$AnimatePresence$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["AnimatePresence"], {
                                    mode: "wait",
                                    children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$framer$2d$motion$2f$dist$2f$es$2f$render$2f$components$2f$motion$2f$proxy$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["motion"].div, {
                                        initial: {
                                            opacity: 0,
                                            y: 8
                                        },
                                        animate: {
                                            opacity: 1,
                                            y: 0
                                        },
                                        exit: {
                                            opacity: 0,
                                            y: -8
                                        },
                                        transition: {
                                            duration: 0.15
                                        },
                                        className: "w-full h-full",
                                        children: renderActiveView()
                                    }, activeTab, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 479,
                                        columnNumber: 15
                                    }, this)
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 478,
                                    columnNumber: 13
                                }, this)
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 477,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("footer", {
                                className: `h-8 border-t flex items-center justify-between px-4 text-[9px] font-mono shrink-0 ${theme === 'light' ? 'bg-white border-gray-200 text-gray-400' : 'bg-[#08090d] border-gray-900 text-gray-600'}`,
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "truncate",
                                        children: "CLEARPORT v5.0 // CUSTOMS COMPLIANCE PLATFORM"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 498,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "hidden md:inline flex-1 text-center",
                                        children: edgeFunctionStatus === 'live' ? 'EDGE FUNCTIONS LIVE • GEMINI EXTRACTION ACTIVE' : 'FALLBACK MODE • DEPLOY EDGE FUNCTIONS FOR FULL CAPABILITY'
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 499,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "flex items-center gap-3 shrink-0",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
                                                href: "/terms",
                                                className: "hover:text-gray-300 transition-colors hidden sm:inline",
                                                title: "Terms of Use",
                                                children: "Terms"
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 507,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
                                                href: "/privacy",
                                                className: "hover:text-gray-300 transition-colors hidden sm:inline",
                                                title: "Privacy Policy",
                                                children: "Privacy"
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 514,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
                                                href: "/legal",
                                                className: "hover:text-gray-300 transition-colors hidden sm:inline",
                                                title: "AI Disclaimer & Legal Overview",
                                                children: "AI Disclaimer"
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 521,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "text-gray-700 hidden sm:inline",
                                                children: "|"
                                            }, void 0, false, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 528,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                children: [
                                                    entries.length,
                                                    " SHIPMENTS"
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/src/app/page.tsx",
                                                lineNumber: 529,
                                                columnNumber: 15
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 505,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 493,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 334,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 289,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$SupabaseSyncPanel$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
                isOpen: isSupabaseOpen,
                onClose: ()=>setIsSupabaseOpen(false)
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 536,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/app/page.tsx",
        lineNumber: 266,
        columnNumber: 5
    }, this);
}
_s(AppShell, "TEJGd4f8DU/OGz1+fzfpnRFxzl8=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$context$2f$ClearPortContext$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useClearPort"]
    ];
});
_c = AppShell;
function MasterPage() {
    _s1();
    const [mounted, setMounted] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"](false);
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"]({
        "MasterPage.useEffect": ()=>{
            setMounted(true);
        }
    }["MasterPage.useEffect"], []);
    if (!mounted) {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "min-h-screen bg-[#06070a] flex items-center justify-center",
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "text-gray-500 font-mono text-xs animate-pulse",
                children: "INITIALIZING CLEARPORT..."
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 551,
                columnNumber: 9
            }, this)
        }, void 0, false, {
            fileName: "[project]/src/app/page.tsx",
            lineNumber: 550,
            columnNumber: 7
        }, this);
    }
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$context$2f$ClearPortContext$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ClearPortProvider"], {
        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$clearport$2f$ErrorBoundary$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["default"], {
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(AppShell, {}, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 564,
                columnNumber: 9
            }, this)
        }, void 0, false, {
            fileName: "[project]/src/app/page.tsx",
            lineNumber: 563,
            columnNumber: 7
        }, this)
    }, void 0, false, {
        fileName: "[project]/src/app/page.tsx",
        lineNumber: 557,
        columnNumber: 5
    }, this);
}
_s1(MasterPage, "LrrVfNW3d1raFE0BNzCTILYmIfo=");
_c1 = MasterPage;
var _c, _c1;
__turbopack_context__.k.register(_c, "AppShell");
__turbopack_context__.k.register(_c1, "MasterPage");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(__turbopack_context__.m, globalThis.$RefreshHelpers$);
}
}),
]);

//# debugId=b67180eb-53c1-b4e9-185a-ebff08fbeb11
//# sourceMappingURL=src_566ceb36._.js.map
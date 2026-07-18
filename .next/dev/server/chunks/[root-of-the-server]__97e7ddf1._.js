;!function(){try { var e="undefined"!=typeof globalThis?globalThis:"undefined"!=typeof global?global:"undefined"!=typeof window?window:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&((e._debugIds|| (e._debugIds={}))[n]="b7e058df-d645-27f1-d28a-1e0a31d66293")}catch(e){}}();
module.exports = [
"[externals]/next/dist/server/app-render/work-async-storage.external.js [external] (next/dist/server/app-render/work-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-async-storage.external.js", () => require("next/dist/server/app-render/work-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/work-unit-async-storage.external.js [external] (next/dist/server/app-render/work-unit-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/work-unit-async-storage.external.js", () => require("next/dist/server/app-render/work-unit-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/lib/incremental-cache/tags-manifest.external.js [external] (next/dist/server/lib/incremental-cache/tags-manifest.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/lib/incremental-cache/tags-manifest.external.js", () => require("next/dist/server/lib/incremental-cache/tags-manifest.external.js"));

module.exports = mod;
}),
"[externals]/next/dist/server/app-render/after-task-async-storage.external.js [external] (next/dist/server/app-render/after-task-async-storage.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/server/app-render/after-task-async-storage.external.js", () => require("next/dist/server/app-render/after-task-async-storage.external.js"));

module.exports = mod;
}),
"[externals]/node:async_hooks [external] (node:async_hooks, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:async_hooks", () => require("node:async_hooks"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/next-server/app-page-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/app-page-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/app-page-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[project]/src/lib/observability/logger.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "clearRequestContext",
    ()=>clearRequestContext,
    "createRequestContext",
    ()=>createRequestContext,
    "endStage",
    ()=>endStage,
    "getRequestContext",
    ()=>getRequestContext,
    "log",
    ()=>log,
    "logger",
    ()=>logger,
    "startStage",
    ()=>startStage,
    "traceExternalCall",
    ()=>traceExternalCall,
    "traceRequest",
    ()=>traceRequest
]);
// ============================================================================
// ClearPort — Observability System
// ============================================================================
// Structured JSON logging + request lifecycle tracing + latency tracking.
// Every log includes: request_id, user_id, organization_id, action, timestamp.
// ============================================================================
// ---------------------------------------------------------------------------
// Edge-safe UUID generation
// ---------------------------------------------------------------------------
// `import { randomUUID } from 'crypto'` is Node-only and breaks Next.js
// middleware (which runs on the Edge runtime). The global `crypto.randomUUID()`
// is available in Node 19+, all evergreen browsers, and the Edge runtime.
// We fall back to a timestamp+random string only if `crypto` is missing
// entirely (very old environments).
function safeUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
// AsyncLocalStorage equivalent using module-level state
let _currentContext = null;
function createRequestContext(action, userId, orgId) {
    const ctx = {
        request_id: safeUUID(),
        user_id: userId,
        organization_id: orgId,
        action,
        start_time: performance.now(),
        stages: []
    };
    _currentContext = ctx;
    return ctx;
}
function getRequestContext() {
    return _currentContext;
}
function clearRequestContext() {
    _currentContext = null;
}
function startStage(name) {
    const ctx = getRequestContext();
    if (!ctx) return;
    ctx.stages.push({
        name,
        start_time: performance.now(),
        status: 'running'
    });
    log('debug', `Stage started: ${name}`, {
        stage: name
    });
}
function endStage(name, status = 'success', error) {
    const ctx = getRequestContext();
    if (!ctx) return;
    const stage = ctx.stages.find((s)=>s.name === name && s.status === 'running');
    if (!stage) return;
    stage.end_time = performance.now();
    stage.duration_ms = Math.round(stage.end_time - stage.start_time);
    stage.status = status;
    stage.error = error;
    log(status === 'failed' ? 'error' : 'debug', `Stage ${status}: ${name}`, {
        stage: name,
        duration_ms: stage.duration_ms,
        ...error ? {
            error
        } : {}
    });
}
function log(level, message, extra) {
    const ctx = getRequestContext();
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...ctx?.request_id ? {
            request_id: ctx.request_id
        } : {},
        ...ctx?.user_id ? {
            user_id: ctx.user_id
        } : {},
        ...ctx?.organization_id ? {
            organization_id: ctx.organization_id
        } : {},
        ...ctx?.action ? {
            action: ctx.action
        } : {},
        ...extra
    };
    // Output as JSON (machine-queryable)
    const json = JSON.stringify(entry);
    // Route to correct console method (human-readable in dev)
    switch(level){
        case 'fatal':
        case 'error':
            console.error(json);
            break;
        case 'warn':
            console.warn(json);
            break;
        case 'info':
            console.info(json);
            break;
        default:
            console.log(json);
    }
}
const logger = {
    debug: (msg, extra)=>log('debug', msg, extra),
    info: (msg, extra)=>log('info', msg, extra),
    warn: (msg, extra)=>log('warn', msg, extra),
    error: (msg, extra)=>log('error', msg, extra),
    fatal: (msg, extra)=>log('fatal', msg, extra)
};
function traceRequest(action, fn, options) {
    const ctx = createRequestContext(action, options?.userId, options?.orgId);
    return new Promise((resolve, reject)=>{
        startStage('request_start');
        fn(ctx).then((result)=>{
            endStage('request_start', 'success');
            const total_ms = Math.round(performance.now() - ctx.start_time);
            log('info', `Request completed: ${action}`, {
                duration_ms: total_ms,
                stages: ctx.stages.map((s)=>({
                        name: s.name,
                        status: s.status,
                        duration_ms: s.duration_ms
                    }))
            });
            clearRequestContext();
            resolve(result);
        }).catch((err)=>{
            endStage('request_start', 'failed', err instanceof Error ? err.message : String(err));
            const total_ms = Math.round(performance.now() - ctx.start_time);
            log('error', `Request failed: ${action}`, {
                duration_ms: total_ms,
                error_type: err instanceof Error ? err.constructor.name : 'Unknown',
                error_code: err?.code || 'INTERNAL',
                stack_trace: err instanceof Error ? err.stack : undefined,
                stages: ctx.stages.map((s)=>({
                        name: s.name,
                        status: s.status,
                        duration_ms: s.duration_ms
                    }))
            });
            clearRequestContext();
            reject(err);
        });
    });
}
async function traceExternalCall(serviceName, operation, fn) {
    const ctx = getRequestContext();
    const startTime = performance.now();
    log('debug', `External API call: ${serviceName}.${operation}`, {
        external_service: serviceName,
        external_operation: operation
    });
    try {
        const result = await fn();
        const duration = Math.round(performance.now() - startTime);
        log('info', `External API success: ${serviceName}.${operation}`, {
            external_service: serviceName,
            external_operation: operation,
            duration_ms: duration
        });
        return result;
    } catch (err) {
        const duration = Math.round(performance.now() - startTime);
        log('error', `External API failed: ${serviceName}.${operation}`, {
            external_service: serviceName,
            external_operation: operation,
            duration_ms: duration,
            error_type: err instanceof Error ? err.constructor.name : 'Unknown',
            error_message: err instanceof Error ? err.message : String(err),
            stack_trace: err instanceof Error ? err.stack : undefined
        });
        throw err;
    }
}
}),
"[project]/src/lib/errors/index.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "BusinessError",
    ()=>BusinessError,
    "ClearPortError",
    ()=>ClearPortError,
    "ExternalAPIError",
    ()=>ExternalAPIError,
    "InfrastructureError",
    ()=>InfrastructureError,
    "ValidationError",
    ()=>ValidationError,
    "getHttpStatus",
    ()=>getHttpStatus,
    "toErrorResponse",
    ()=>toErrorResponse
]);
// ============================================================================
// ClearPort — Error Handling System
// ============================================================================
// Strict error taxonomy: ValidationError, BusinessError, InfrastructureError,
// ExternalAPIError. Every error has code, message, context, severity.
// No generic "Something went wrong" allowed.
// ============================================================================
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/observability/logger.ts [middleware] (ecmascript)");
;
class ClearPortError extends Error {
    context;
    userMessage;
    retryable;
    statusCode;
    constructor(message, options){
        super(message);
        this.name = this.constructor.name;
        this.context = options?.context || {};
        this.userMessage = options?.userMessage || message;
        this.retryable = options?.retryable || false;
        this.statusCode = options?.statusCode || 500;
        if (options?.cause) {
            this.cause = options.cause;
        }
    }
    toJSON() {
        return {
            code: this.code,
            category: this.category,
            message: this.userMessage,
            severity: this.severity,
            retryable: this.retryable,
            context: this.context
        };
    }
}
class ValidationError extends ClearPortError {
    category = 'validation';
    severity = 'warning';
    field;
    suggestion;
    constructor(field, message, options){
        super(message, {
            context: {
                field,
                ...options?.context
            },
            userMessage: options?.userMessage || message,
            statusCode: 422,
            ...options
        });
        this.field = field;
        this.suggestion = options?.suggestion;
    }
    get code() {
        return `VALIDATION_${this.field?.toUpperCase() || 'ERROR'}`;
    }
}
class BusinessError extends ClearPortError {
    category = 'business';
    severity = 'error';
    constructor(code, message, options){
        super(message, {
            context: options?.context,
            userMessage: options?.userMessage || message,
            statusCode: 403,
            retryable: options?.retryable || false,
            ...options
        });
        // Override code via a property since it's abstract
        this._code = code;
    }
    get code() {
        return this._code || 'BUSINESS_ERROR';
    }
}
class InfrastructureError extends ClearPortError {
    category = 'infrastructure';
    severity = 'error';
    constructor(service, message, options){
        super(message, {
            context: {
                service,
                ...options?.context
            },
            userMessage: options?.userMessage || `${service} is temporarily unavailable. Please try again.`,
            statusCode: 503,
            retryable: options?.retryable ?? true,
            cause: options?.cause
        });
        this._service = service;
    }
    get code() {
        return `INFRA_${this._service?.toUpperCase() || 'ERROR'}`;
    }
}
class ExternalAPIError extends ClearPortError {
    category = 'external_api';
    severity = 'error';
    serviceName;
    constructor(serviceName, message, options){
        super(message, {
            context: {
                service: serviceName,
                ...options?.context
            },
            userMessage: options?.userMessage || `${serviceName} service is unavailable. Please try again later.`,
            statusCode: options?.statusCode || 502,
            retryable: options?.retryable ?? true,
            cause: options?.cause
        });
        this.serviceName = serviceName;
    }
    get code() {
        return `EXTERNAL_${this.serviceName.toUpperCase()}`;
    }
}
function toErrorResponse(err, requestId) {
    if (err instanceof ClearPortError) {
        // Log the error with full context
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["logger"].error(`[${err.category}] ${err.code}: ${err.message}`, {
            error_code: err.code,
            error_category: err.category,
            error_severity: err.severity,
            error_context: err.context,
            stack_trace: err.stack,
            request_id: requestId
        });
        return {
            error: {
                code: err.code,
                category: err.category,
                message: err.userMessage,
                severity: err.severity,
                retryable: err.retryable,
                ...err instanceof ValidationError ? {
                    field: err.field,
                    suggestion: err.suggestion
                } : {},
                // Only include context if it's safe (no secrets)
                context: sanitizeContext(err.context),
                ...requestId ? {
                    request_id: requestId
                } : {}
            }
        };
    }
    // Unknown error — log full detail, return generic-safe message
    __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["logger"].error('[unknown] Unexpected error', {
        error_type: err instanceof Error ? err.constructor.name : 'Unknown',
        error_message: err instanceof Error ? err.message : String(err),
        stack_trace: err instanceof Error ? err.stack : undefined,
        request_id: requestId
    });
    return {
        error: {
            code: 'INTERNAL_ERROR',
            category: 'infrastructure',
            message: 'An unexpected error occurred. Our team has been notified.',
            severity: 'error',
            retryable: false,
            ...requestId ? {
                request_id: requestId
            } : {}
        }
    };
}
/**
 * Remove sensitive data from context before sending to UI.
 */ function sanitizeContext(context) {
    const sanitized = {
        ...context
    };
    const sensitiveKeys = [
        'password',
        'token',
        'secret',
        'key',
        'authorization',
        'api_key'
    ];
    for (const key of Object.keys(sanitized)){
        if (sensitiveKeys.some((s)=>key.toLowerCase().includes(s))) {
            delete sanitized[key];
        }
    }
    return sanitized;
}
function getHttpStatus(err) {
    if (err instanceof ClearPortError) return err.statusCode;
    return 500;
}
}),
"[project]/src/middleware/index.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "healthCheck",
    ()=>healthCheck,
    "requestMiddleware",
    ()=>requestMiddleware,
    "withMiddleware",
    ()=>withMiddleware
]);
// ============================================================================
// ClearPort — Request Middleware
// ============================================================================
// Two distinct concerns live here:
//
//   1. `requestMiddleware` — a Next.js middleware (activated by src/middleware.ts)
//      that runs on every matched request, generates a request_id, logs the
//      request, and stamps the response with `X-Request-Id`. Lightweight by
//      design — no DB calls, no auth, no body parsing.
//
//   2. `withMiddleware` — a per-route-handler wrapper that adds structured
//      logging + error handling around an individual API route. Opt-in per
//      route; not currently used by the live routes (see worklog P5).
//
// Both share the observability logger so all output is structured JSON.
// ============================================================================
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/server.js [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/observability/logger.ts [middleware] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$errors$2f$index$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/errors/index.ts [middleware] (ecmascript)");
;
;
;
// ---------------------------------------------------------------------------
// Public routes — no auth required
// ---------------------------------------------------------------------------
// These routes are accessible without a session: the auth pages themselves,
// the legal pages, and the invite-acceptance flow (which handles its own auth).
const PUBLIC_ROUTES = new Set([
    '/login',
    '/signup',
    '/reset-password',
    '/accept-invite',
    '/terms',
    '/privacy',
    '/legal'
]);
function isPublicRoute(pathname) {
    // Exact match for static public routes
    if (PUBLIC_ROUTES.has(pathname)) return true;
    // API routes handle their own auth (Bearer token check in requireOrgRole)
    if (pathname.startsWith('/api/')) return true;
    // Next.js internal routes
    if (pathname.startsWith('/_next/')) return true;
    return false;
}
async function requestMiddleware(req) {
    const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const method = req.method;
    const path = req.nextUrl.pathname;
    // Lightweight per-request log line. Structured JSON so it's grep-able in
    // dev.log and shippable to a log aggregator in prod.
    __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["logger"].info(`[middleware] ${method} ${path}`, {
        request_id: requestId,
        method,
        path
    });
    // Propagate request_id to downstream route handlers via a custom header
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-request-id', requestId);
    // ── Auth guard ──
    // Check for a Supabase session on non-public, non-API routes. If no session
    // and demo mode is off, redirect to /login.
    if (!isPublicRoute(path)) {
        const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
        if (!demoMode) {
            // Read the session token from the supabase auth cookie. The cookie name
            // follows the pattern sb-<project-ref>-auth-token. We check for its
            // presence — the actual session validation happens server-side in the
            // API routes via requireOrgRole(). This is just a redirect guard to
            // avoid a flash of "logged out" content.
            const hasAuthCookie = req.cookies.getAll().some((c)=>c.name.startsWith('sb-') && c.name.includes('auth-token'));
            if (!hasAuthCookie) {
                const loginUrl = new URL('/login', req.url);
                loginUrl.searchParams.set('redirect', path);
                const redirectResponse = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["NextResponse"].redirect(loginUrl);
                redirectResponse.headers.set('X-Request-Id', requestId);
                return redirectResponse;
            }
        }
    }
    const response = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["NextResponse"].next({
        request: {
            headers: requestHeaders
        }
    });
    // Surface request_id on the response so the UI / client can correlate.
    response.headers.set('X-Request-Id', requestId);
    return response;
}
function withMiddleware(handler) {
    return async (req)=>{
        const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const action = `${req.method} ${new URL(req.url).pathname}`;
        // Extract user_id and org_id from headers if available
        const userId = req.headers.get('x-user-id') || undefined;
        const orgId = req.headers.get('x-org-id') || undefined;
        return (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["traceRequest"])(action, async (ctx)=>{
            __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["logger"].info(`Request started: ${action}`, {
                method: req.method,
                path: new URL(req.url).pathname
            });
            try {
                const response = await handler(req, {
                    request_id: ctx.request_id,
                    user_id: userId,
                    organization_id: orgId
                });
                // If it's a NextResponse, add request_id header
                if (response instanceof __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["NextResponse"]) {
                    response.headers.set('X-Request-Id', ctx.request_id);
                }
                return response;
            } catch (err) {
                __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$observability$2f$logger$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["logger"].error(`Unhandled error in route: ${action}`, {
                    error_type: err instanceof Error ? err.constructor.name : 'Unknown',
                    error_message: err instanceof Error ? err.message : String(err),
                    stack_trace: err instanceof Error ? err.stack : undefined
                });
                const errorResponse = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$errors$2f$index$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["toErrorResponse"])(err, ctx.request_id);
                const status = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$errors$2f$index$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["getHttpStatus"])(err);
                return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["NextResponse"].json(errorResponse, {
                    status,
                    headers: {
                        'X-Request-Id': ctx.request_id
                    }
                });
            }
        }, {
            userId,
            orgId
        }).catch(()=>{
            // traceRequest already logged + rejected — return a fallback response
            // This should never execute because traceRequest resolves/rejects internally,
            // but if it does, we return a safe error.
            return __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$server$2e$js__$5b$middleware$5d$__$28$ecmascript$29$__["NextResponse"].json({
                error: {
                    code: 'INTERNAL_ERROR',
                    message: 'An unexpected error occurred.',
                    severity: 'error',
                    retryable: false
                }
            }, {
                status: 500,
                headers: {
                    'X-Request-Id': requestId
                }
            });
        });
    };
}
async function healthCheck() {
    const services = {};
    // Check Supabase
    try {
        const start = performance.now();
        const supabaseUrl = ("TURBOPACK compile-time value", "https://apfsceomnnhefxkvjhkz.supabase.co");
        if ("TURBOPACK compile-time truthy", 1) {
            const res = await fetch(`${supabaseUrl}/rest/v1/`, {
                headers: {
                    apikey: ("TURBOPACK compile-time value", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwZnNjZW9tbm5oZWZ4a3ZqaGt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MDI0ODQsImV4cCI6MjA5OTA3ODQ4NH0.TN_HXmJlNBw94ikW0zeTCgG7uEiZX1dpzVazau0pQ1s") || ''
                },
                signal: AbortSignal.timeout(5000)
            });
            services.supabase = {
                status: res.ok ? 'healthy' : 'degraded',
                latency_ms: Math.round(performance.now() - start)
            };
        } else //TURBOPACK unreachable
        ;
    } catch (err) {
        services.supabase = {
            status: 'unhealthy'
        };
    }
    // Check edge functions
    try {
        const start = performance.now();
        const supabaseUrl = ("TURBOPACK compile-time value", "https://apfsceomnnhefxkvjhkz.supabase.co");
        if ("TURBOPACK compile-time truthy", 1) {
            const res = await fetch(`${supabaseUrl}/functions/v1/get-shipments`, {
                method: 'POST',
                headers: {
                    apikey: ("TURBOPACK compile-time value", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwZnNjZW9tbm5oZWZ4a3ZqaGt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MDI0ODQsImV4cCI6MjA5OTA3ODQ4NH0.TN_HXmJlNBw94ikW0zeTCgG7uEiZX1dpzVazau0pQ1s") || '',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({}),
                signal: AbortSignal.timeout(5000)
            });
            services.edge_functions = {
                status: res.status === 401 ? 'healthy' : 'degraded',
                latency_ms: Math.round(performance.now() - start)
            };
        } else //TURBOPACK unreachable
        ;
    } catch  {
        services.edge_functions = {
            status: 'unhealthy'
        };
    }
    // Overall status
    const allHealthy = Object.values(services).every((s)=>s.status === 'healthy' || s.status === 'unconfigured');
    const anyUnhealthy = Object.values(services).some((s)=>s.status === 'unhealthy');
    return {
        status: anyUnhealthy ? 'unhealthy' : allHealthy ? 'healthy' : 'degraded',
        services
    };
}
}),
"[project]/src/proxy.ts [middleware] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "config",
    ()=>config,
    "default",
    ()=>__TURBOPACK__default__export__
]);
// ============================================================================
// ClearPort — Next.js Proxy Entry Point (replaces deprecated middleware.ts)
// ============================================================================
// Next.js 16 deprecated the `middleware.ts` convention in favor of `proxy.ts`.
// This file serves the same role: it runs on every matched request, generates
// a request_id, logs the request, and stamps the response with X-Request-Id.
//
// The implementation lives in `src/middleware/index.ts` so it can be unit
// tested and co-located with the per-route `withMiddleware` wrapper. This
// file just re-exports the default + the matcher config.
// ============================================================================
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$middleware$2f$index$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/middleware/index.ts [middleware] (ecmascript)");
;
const __TURBOPACK__default__export__ = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$middleware$2f$index$2e$ts__$5b$middleware$5d$__$28$ecmascript$29$__["requestMiddleware"];
const config = {
    matcher: [
        '/((?!_next/static|_next/image|favicon.ico).*)'
    ]
};
}),
];

//# debugId=b7e058df-d645-27f1-d28a-1e0a31d66293
//# sourceMappingURL=%5Broot-of-the-server%5D__97e7ddf1._.js.map
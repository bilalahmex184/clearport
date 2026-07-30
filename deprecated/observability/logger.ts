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
function safeUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Log Levels
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

// ---------------------------------------------------------------------------
// Structured Log Entry
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  request_id?: string;
  user_id?: string;
  organization_id?: string;
  action?: string;
  stage?: string;
  duration_ms?: number;
  error_type?: string;
  error_code?: string;
  stack_trace?: string;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Request Context — thread-local equivalent for request-scoped data
// ---------------------------------------------------------------------------

export interface RequestContext {
  request_id: string;
  user_id?: string;
  organization_id?: string;
  action?: string;
  start_time: number;
  stages: RequestStage[];
}

export interface RequestStage {
  name: string;
  start_time: number;
  end_time?: number;
  duration_ms?: number;
  status: 'running' | 'success' | 'failed' | 'skipped';
  error?: string;
}

// AsyncLocalStorage equivalent using module-level state
let _currentContext: RequestContext | null = null;

export function createRequestContext(action: string, userId?: string, orgId?: string): RequestContext {
  const ctx: RequestContext = {
    request_id: safeUUID(),
    user_id: userId,
    organization_id: orgId,
    action,
    start_time: performance.now(),
    stages: [],
  };
  _currentContext = ctx;
  return ctx;
}

export function getRequestContext(): RequestContext | null {
  return _currentContext;
}

export function clearRequestContext(): void {
  _currentContext = null;
}

// ---------------------------------------------------------------------------
// Stage Tracking
// ---------------------------------------------------------------------------

export function startStage(name: string): void {
  const ctx = getRequestContext();
  if (!ctx) return;
  ctx.stages.push({
    name,
    start_time: performance.now(),
    status: 'running',
  });
  log('debug', `Stage started: ${name}`, { stage: name });
}

export function endStage(name: string, status: 'success' | 'failed' = 'success', error?: string): void {
  const ctx = getRequestContext();
  if (!ctx) return;
  const stage = ctx.stages.find((s) => s.name === name && s.status === 'running');
  if (!stage) return;
  stage.end_time = performance.now();
  stage.duration_ms = Math.round(stage.end_time - stage.start_time);
  stage.status = status;
  stage.error = error;

  log(status === 'failed' ? 'error' : 'debug', `Stage ${status}: ${name}`, {
    stage: name,
    duration_ms: stage.duration_ms,
    ...(error ? { error } : {}),
  });
}

// ---------------------------------------------------------------------------
// Core Logger — JSON only, machine-queryable + human-readable
// ---------------------------------------------------------------------------

export function log(level: LogLevel, message: string, extra?: Record<string, any>): void {
  const ctx = getRequestContext();

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(ctx?.request_id ? { request_id: ctx.request_id } : {}),
    ...(ctx?.user_id ? { user_id: ctx.user_id } : {}),
    ...(ctx?.organization_id ? { organization_id: ctx.organization_id } : {}),
    ...(ctx?.action ? { action: ctx.action } : {}),
    ...extra,
  };

  // Output as JSON (machine-queryable)
  const json = JSON.stringify(entry);

  // Route to correct console method (human-readable in dev)
  switch (level) {
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

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

export const logger = {
  debug: (msg: string, extra?: Record<string, any>) => log('debug', msg, extra),
  info: (msg: string, extra?: Record<string, any>) => log('info', msg, extra),
  warn: (msg: string, extra?: Record<string, any>) => log('warn', msg, extra),
  error: (msg: string, extra?: Record<string, any>) => log('error', msg, extra),
  fatal: (msg: string, extra?: Record<string, any>) => log('fatal', msg, extra),
};

// ---------------------------------------------------------------------------
// Request Lifecycle Tracer
// ---------------------------------------------------------------------------

export function traceRequest<T>(
  action: string,
  fn: (ctx: RequestContext) => Promise<T>,
  options?: { userId?: string; orgId?: string },
): Promise<T> {
  const ctx = createRequestContext(action, options?.userId, options?.orgId);

  return new Promise<T>((resolve, reject) => {
    startStage('request_start');

    fn(ctx)
      .then((result) => {
        endStage('request_start', 'success');
        const total_ms = Math.round(performance.now() - ctx.start_time);
        log('info', `Request completed: ${action}`, {
          duration_ms: total_ms,
          stages: ctx.stages.map((s) => ({ name: s.name, status: s.status, duration_ms: s.duration_ms })),
        });
        clearRequestContext();
        resolve(result);
      })
      .catch((err) => {
        endStage('request_start', 'failed', err instanceof Error ? err.message : String(err));
        const total_ms = Math.round(performance.now() - ctx.start_time);
        log('error', `Request failed: ${action}`, {
          duration_ms: total_ms,
          error_type: err instanceof Error ? err.constructor.name : 'Unknown',
          error_code: (err as any)?.code || 'INTERNAL',
          stack_trace: err instanceof Error ? err.stack : undefined,
          stages: ctx.stages.map((s) => ({ name: s.name, status: s.status, duration_ms: s.duration_ms })),
        });
        clearRequestContext();
        reject(err);
      });
  });
}

// ---------------------------------------------------------------------------
// External API Call Tracer
// ---------------------------------------------------------------------------

export async function traceExternalCall<T>(
  serviceName: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = getRequestContext();
  const startTime = performance.now();

  log('debug', `External API call: ${serviceName}.${operation}`, {
    external_service: serviceName,
    external_operation: operation,
  });

  try {
    const result = await fn();
    const duration = Math.round(performance.now() - startTime);
    log('info', `External API success: ${serviceName}.${operation}`, {
      external_service: serviceName,
      external_operation: operation,
      duration_ms: duration,
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
      stack_trace: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
}

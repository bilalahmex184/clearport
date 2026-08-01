// ============================================================================
// logger.ts — The ONE shared structured logger for the entire monorepo
// ============================================================================
// WHAT THIS IS
//   The single logging function every Worker, API route, and service routes
//   through. Closes the "two parallel logging stacks" problem from the
//   earlier audit — there is now exactly ONE logger.
//
//   Every log line includes the fields Phase 5 Step 4 requires:
//     - job_id:     the extraction job (omitted for non-job logs)
//     - org_id:     the organization (omitted for system-level logs)
//     - step:       where in the pipeline (e.g. "tier_1_ai", "verbatim_anchor_check")
//     - latency_ms: where applicable (omitted for non-timed logs)
//     - outcome:    "success" | "failure" | "skipped" | "warning" | "info"
//     - message:    human-readable detail
//     - plus any extra context fields passed in `meta`
//
// SHIPPING
//   Two modes, controlled by env vars (no code change to switch):
//   1. CONSOLE (default): structured JSON to console.log. Cloudflare Workers
//      captures these and they appear in `wrangler tail` + the dashboard.
//      This is the zero-config mode — works out of the box.
//   2. HTTP SHIPPER (when LOGSHIP_URL + LOGSHIP_TOKEN are set): batches log
//      lines and POSTs them to an external log service (Axiom, Better Stack,
//      Logtail, Datadog — any service that accepts JSON over HTTP). The
//      request is fire-and-forget with a 3s timeout so logging never blocks
//      the request path.
//
//   To switch to Axiom: set LOGSHIP_URL=https://api.axiom.co/api/v1/datasets/NAME/_ingest
//   and LOGSHIP_TOKEN=xaat-...  To switch to Better Stack: set
//   LOGSHIP_URL=https://in.logs.betterstack.com  and LOGSHIP_TOKEN=...  No
//   code change — just env vars.
// ============================================================================

// ---------------------------------------------------------------------------
// LogContext — the structured fields every log call can carry.
// ---------------------------------------------------------------------------
export interface LogContext {
  /** The extraction job ID (omit for non-job logs). */
  job_id?: string;
  /** The organization ID (omit for system-level logs). */
  org_id?: string;
  /** Where in the pipeline this log comes from. */
  step?: string;
  /** Measured latency in milliseconds, where applicable. */
  latency_ms?: number;
}

export type LogOutcome = 'success' | 'failure' | 'skipped' | 'warning' | 'info';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// The logger. Pure function — no global state, no side effects beyond the
// console.log / HTTP ship. Safe to call from any runtime (Worker, Node,
// browser). The env is passed in (not read from process.env) so it's
// testable and runtime-agnostic.
// ---------------------------------------------------------------------------

export interface LoggerEnv {
  /** HTTP endpoint for external log shipping. When set + LOGSHIP_TOKEN, logs are POSTed. */
  LOGSHIP_URL?: string;
  /** Bearer token for the HTTP shipper. */
  LOGSHIP_TOKEN?: string;
  /** Optional: filter logs below this level. Default: 'info'. */
  LOG_LEVEL?: LogLevel;
  /** Optional: service name to include in every log line. Default: 'clearport'. */
  SERVICE_NAME?: string;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10, info: 20, warn: 30, error: 40,
};

// In-memory batch buffer for HTTP shipping. Flushed every 5s or when it
// reaches 50 lines. In Cloudflare Workers, each invocation is short-lived,
// so the buffer flushes at the end of the request via `flushLogger()`.
// For the console mode, no buffering — each log is a console.log call.
let _httpBuffer: Array<Record<string, unknown>> = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5_000;

/**
 * The one shared logger function. Call this everywhere — never console.log.
 *
 *   log(env, 'info', 'tier_1_ai completed',
 *       { job_id, org_id, step: 'tier_1_ai', latency_ms: 4200 },
 *       { model: 'qwen3-vl-32b', fields_extracted: 12 });
 *
 * The `context` carries the required Phase 5 fields; `meta` carries any
 * extra fields specific to this log call.
 */
export function log(
  env: LoggerEnv | undefined,
  level: LogLevel,
  message: string,
  context: LogContext = {},
  meta: Record<string, unknown> = {},
): void {
  const minLevel: LogLevel = env?.LOG_LEVEL || 'info';
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const outcome: LogOutcome = level === 'error' ? 'failure'
    : level === 'warn' ? 'warning'
    : level === 'debug' ? 'info'
    : 'info';

  const line: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service: env?.SERVICE_NAME || 'clearport',
    message,
    outcome,
    ...context,
    ...meta,
  };

  // Always console.log (Cloudflare captures these even when HTTP shipping is on).
  // JSON.stringify for structured capture; fallback to the object if circular.
  try {
    console[level === 'debug' ? 'log' : level](JSON.stringify(line));
  } catch {
    console[level === 'debug' ? 'log' : level](line);
  }

  // If HTTP shipping is configured, buffer the line for batch flush.
  if (env?.LOGSHIP_URL && env?.LOGSHIP_TOKEN) {
    _httpBuffer.push(line);
    if (_httpBuffer.length >= BATCH_SIZE) {
      void flushLogger(env).catch(() => { /* swallow — logging never throws */ });
    } else if (!_flushTimer) {
      _flushTimer = setTimeout(() => {
        void flushLogger(env).catch(() => {});
        _flushTimer = null;
      }, FLUSH_INTERVAL_MS);
    }
  }
}

/**
 * Flush the buffered log lines to the HTTP shipper. Call this at the end of
 * a request handler (via `ctx.waitUntil(flushLogger(env))`) so logs aren't
 * dropped when the Worker terminates.
 *
 * Fire-and-forget with a 3s timeout — logging never blocks the request path
 * and never throws (errors are swallowed + logged to console).
 */
export async function flushLogger(env: LoggerEnv | undefined): Promise<void> {
  if (!env?.LOGSHIP_URL || !env?.LOGSHIP_TOKEN) return;
  if (_httpBuffer.length === 0) return;

  const batch = _httpBuffer.splice(0, _httpBuffer.length);
  _flushTimer = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    await fetch(env.LOGSHIP_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.LOGSHIP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    // Logging never throws. Log the shipping failure to console (meta-logging).
    // Don't re-buffer — if the shipper is down, we'd loop forever.
    console.error(`[logger] HTTP ship failed (${batch.length} lines dropped):`,
      err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers — the common log calls with less boilerplate.
// ---------------------------------------------------------------------------

export function logInfo(env: LoggerEnv | undefined, message: string, context: LogContext = {}, meta: Record<string, unknown> = {}): void {
  log(env, 'info', message, context, meta);
}
export function logWarn(env: LoggerEnv | undefined, message: string, context: LogContext = {}, meta: Record<string, unknown> = {}): void {
  log(env, 'warn', message, context, meta);
}
export function logError(env: LoggerEnv | undefined, message: string, context: LogContext = {}, meta: Record<string, unknown> = {}): void {
  log(env, 'error', message, context, meta);
}
export function logDebug(env: LoggerEnv | undefined, message: string, context: LogContext = {}, meta: Record<string, unknown> = {}): void {
  log(env, 'debug', message, context, meta);
}

/**
 * A timing helper: wraps an async function, logs the latency, returns the
 * result. Use this to instrument every tier + validation step.
 *
 *   const result = await withTiming(env, 'tier_1_ai', { job_id, org_id },
 *     () => callOpenRouterExtraction(env, input, deadline));
 *
 * Logs { step, latency_ms, outcome: 'success'|'failure' } automatically.
 */
export async function withTiming<T>(
  env: LoggerEnv | undefined,
  step: string,
  context: LogContext,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    const latencyMs = Date.now() - start;
    log(env, 'info', `${step} completed`, { ...context, step, latency_ms: latencyMs }, { outcome: 'success' });
    return result;
  } catch (err) {
    const latencyMs = Date.now() - start;
    log(env, 'error', `${step} failed`, { ...context, step, latency_ms: latencyMs },
      { outcome: 'failure', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

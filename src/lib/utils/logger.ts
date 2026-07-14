// ============================================================================
// ClearPort — Structured Logger
// Replaces ad-hoc console.log/warn/error calls with a single consistent
// JSON-formatted entry. Safe to call from browser, server components, route
// handlers, and edge functions (no Node-only APIs used).
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

function log(level: LogLevel, message: string, data?: Record<string, any>) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data ? { data } : {}),
  };

  const prefix =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.log;

  prefix(JSON.stringify(entry));
}

export const logger = {
  debug: (msg: string, data?: Record<string, any>) => log('debug', msg, data),
  info: (msg: string, data?: Record<string, any>) => log('info', msg, data),
  warn: (msg: string, data?: Record<string, any>) => log('warn', msg, data),
  error: (msg: string, data?: Record<string, any>) => log('error', msg, data),
};

export { log };
export default logger;

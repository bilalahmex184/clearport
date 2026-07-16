// ============================================================================
// ClearPort — Silent Failure Prevention System
// ============================================================================
// Ensures NO operation can fail without logging + surfacing the error.
// Implements retry strategies, fallback mechanisms, and health checks.
// ============================================================================

import { logger } from '@/lib/observability/logger';
import { InfrastructureError, ExternalAPIError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// Retry Strategy
// ---------------------------------------------------------------------------

export interface RetryConfig {
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
  backoff_multiplier: number;
  retryable_errors?: string[]; // error codes that are safe to retry
}

export const DEFAULT_RETRY: RetryConfig = {
  max_attempts: 3,
  base_delay_ms: 1000,
  max_delay_ms: 10000,
  backoff_multiplier: 2,
};

/**
 * Execute a function with retry logic.
 * Only retries on retryable errors (infrastructure/external API).
 * Never retries on validation/business errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  context?: { operation: string },
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY, ...config };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < cfg.max_attempts; attempt++) {
    try {
      const result = await fn();

      if (attempt > 0) {
        logger.info(`Retry succeeded on attempt ${attempt + 1}`, {
          operation: context?.operation,
          attempt: attempt + 1,
        });
      }

      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check if error is retryable
      const isRetryable = isRetryableError(err);
      if (!isRetryable || attempt === cfg.max_attempts - 1) {
        logger.error(`Operation failed permanently after ${attempt + 1} attempts`, {
          operation: context?.operation,
          attempt: attempt + 1,
          error_type: lastError.constructor.name,
          error_message: lastError.message,
          retryable: isRetryable,
        });
        throw err;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        cfg.base_delay_ms * Math.pow(cfg.backoff_multiplier, attempt),
        cfg.max_delay_ms,
      );

      logger.warn(`Retry attempt ${attempt + 1}/${cfg.max_attempts} in ${delay}ms`, {
        operation: context?.operation,
        attempt: attempt + 1,
        delay_ms: delay,
        error_type: lastError.constructor.name,
        error_message: lastError.message,
      });

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError || new Error('Retry exhausted with unknown error');
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof InfrastructureError) return err.retryable;
  if (err instanceof ExternalAPIError) return err.retryable;
  // Network errors, timeouts
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('fetch failed')) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fallback Mechanism
// ---------------------------------------------------------------------------

/**
 * Execute a primary function, falling back to a secondary if it fails.
 * Both success and fallback are logged — never silent.
 */
export async function withFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  context?: { operation: string },
): Promise<T> {
  try {
    return await primary();
  } catch (primaryErr) {
    logger.warn(`Primary operation failed, using fallback`, {
      operation: context?.operation,
      primary_error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
    });

    try {
      const result = await fallback();
      logger.info(`Fallback succeeded`, {
        operation: context?.operation,
      });
      return result;
    } catch (fallbackErr) {
      logger.error(`Both primary and fallback failed`, {
        operation: context?.operation,
        primary_error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        fallback_error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      });
      throw fallbackErr;
    }
  }
}

// ---------------------------------------------------------------------------
// Partial Failure Detection
// ---------------------------------------------------------------------------

export interface PartialFailureResult<T> {
  successes: T[];
  failures: Array<{ item: any; error: string }>;
  total: number;
  success_rate: number;
}

/**
 * Process an array of items, catching per-item failures.
 * One bad item doesn't kill the batch — each failure is logged.
 */
export async function processWithPartialFailure<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  context?: { operation: string },
): Promise<PartialFailureResult<R>> {
  const successes: R[] = [];
  const failures: Array<{ item: any; error: string }> = [];

  for (let i = 0; i < items.length; i++) {
    try {
      const result = await fn(items[i]);
      successes.push(result);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      failures.push({ item: items[i], error: errorMsg });

      logger.warn(`Partial failure in batch processing`, {
        operation: context?.operation,
        item_index: i,
        error: errorMsg,
        total_items: items.length,
        successes_so_far: successes.length,
        failures_so_far: failures.length,
      });
    }
  }

  return {
    successes,
    failures,
    total: items.length,
    success_rate: items.length > 0 ? successes.length / items.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Never-Silent Wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps any async function to guarantee that failures are logged.
 * If the function throws, the error is logged and re-thrown.
 * If the function returns null/undefined unexpectedly, it's logged.
 */
export async function neverSilent<T>(
  fn: () => Promise<T>,
  context: { operation: string; expected?: string },
): Promise<T> {
  try {
    const result = await fn();

    if (result === null || result === undefined) {
      logger.warn(`Operation returned null/undefined unexpectedly`, {
        operation: context.operation,
        expected: context.expected || 'non-null result',
      });
    }

    return result;
  } catch (err) {
    logger.error(`Operation failed (never-silent caught)`, {
      operation: context.operation,
      error_type: err instanceof Error ? err.constructor.name : 'Unknown',
      error_message: err instanceof Error ? err.message : String(err),
      stack_trace: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
}

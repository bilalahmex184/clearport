// ============================================================================
// ClearPort — UI Error & Feedback System
// ============================================================================
// User-facing error patterns: field-specific, actionable, no generic messages.
// Supports inline validation, form-level errors, global errors, loading states.
// ============================================================================

import * as React from 'react';

// ---------------------------------------------------------------------------
// UI Error Types
// ---------------------------------------------------------------------------

export type UIErrorType =
  | 'missing_field'
  | 'validation_error'
  | 'low_confidence'
  | 'system_error'
  | 'network_error'
  | 'permission_error'
  | 'not_found';

export interface UIError {
  type: UIErrorType;
  message: string;
  field?: string;
  suggestion?: string;
  severity: 'error' | 'warning';
  retryable?: boolean;
}

// ---------------------------------------------------------------------------
// Error → UI Message Mapping
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, { message: string; suggestion?: string }> = {
  VALIDATION_INVOICENO: {
    message: 'Invoice number is required.',
    suggestion: 'Check that the invoice number field is filled and try again.',
  },
  VALIDATION_HTSCODE: {
    message: 'HTS code format is invalid.',
    suggestion: 'HTS codes must be in XXXX.XX.XXXX format (e.g., 8471.30.0100).',
  },
  VALIDATION_DECLAREDVALUE: {
    message: 'Declared value is missing or invalid.',
    suggestion: 'Enter a positive dollar amount (e.g., $12,500.00).',
  },
  VALIDATION_COUNTRYOFORIGIN: {
    message: 'Country of origin must be a 2-letter code.',
    suggestion: 'Use ISO 3166-1 alpha-2 format (e.g., US, CN, DE).',
  },
  BUSINESS_RULE_VIOLATION: {
    message: 'This action violates a business rule.',
    suggestion: 'Review the exception details and correct the flagged field.',
  },
  INFRA_SUPABASE: {
    message: 'Database is temporarily unavailable.',
    suggestion: 'Please wait a moment and try again.',
  },
  EXTERNAL_GEMINI: {
    message: 'AI extraction service is temporarily unavailable.',
    suggestion: 'Your document will be processed using the fallback extractor.',
  },
  INSUFFICIENT_ROLE: {
    message: 'You do not have permission to perform this action.',
    suggestion: 'Contact your organization admin if you need elevated access.',
  },
  NO_ORG_MEMBERSHIP: {
    message: 'You are not a member of any organization.',
    suggestion: 'Ask your admin to send you an invite, or create a new organization.',
  },
  FORBIDDEN_ORG: {
    message: 'You do not have access to this organization.',
    suggestion: 'Switch to your organization using the org switcher in the header.',
  },
  INVITE_INVALID: {
    message: 'This invite link is invalid or has expired.',
    suggestion: 'Ask your admin to send a new invite.',
  },
  EMAIL_MISMATCH: {
    message: 'This invite was sent to a different email address.',
    suggestion: 'Sign in with the email address that received the invite.',
  },
  RATE_LIMIT_EXCEEDED: {
    message: 'Too many requests. Please slow down.',
    suggestion: 'Wait a few minutes before uploading more documents.',
  },
};

/**
 * Convert an API error response to a UI-safe error.
 *
 * Accepts BOTH the canonical flat shape produced by `errorResponse()` in
 * @/lib/errors:
 *   { error: <message>, code: <code>, details: <details> }
 * AND (for backward-compat) the legacy nested shape from the old
 * ClearPortError taxonomy:
 *   { error: { code, message, severity, retryable, field?, suggestion?, ... } }
 *
 * Also accepts an ApiFetchError (from @/lib/supabase) which carries code +
 * details directly on the thrown error object.
 */
export function toUIError(error: any): UIError {
  // ApiFetchError (thrown by apiFetch) — carries code/details on the error
  // itself, no .error wrapper.
  if (error?.code && typeof error.code === 'string' && error?.message) {
    const code = error.code;
    const mapped = ERROR_MESSAGES[code];
    return {
      type: mapCodeToType(code),
      message: mapped?.message || error.message || 'An error occurred.',
      suggestion: mapped?.suggestion,
      field: error?.details?.field,
      severity:
        (error?.details?.severity === 'warning' ? 'warning' : 'error'),
      retryable: error?.details?.retryable,
    };
  }

  // Canonical flat shape: { error: <string>, code: <string>, details: {...} }
  if (error?.error && typeof error.error === 'string' && error?.code) {
    const code = error.code;
    const mapped = ERROR_MESSAGES[code];
    return {
      type: mapCodeToType(code),
      message: mapped?.message || error.error || 'An error occurred.',
      suggestion: mapped?.suggestion,
      field: error?.details?.field,
      severity:
        error?.details?.severity === 'warning' ? 'warning' : 'error',
      retryable: error?.details?.retryable,
    };
  }

  // Legacy nested shape: { error: { code, message, severity, ... } }
  if (error?.error?.code) {
    const code = error.error.code;
    const mapped = ERROR_MESSAGES[code];

    return {
      type: mapCodeToType(code),
      message: mapped?.message || error.error.message || 'An error occurred.',
      suggestion: mapped?.suggestion || error.error.suggestion,
      field: error.error.field,
      severity: error.error.severity === 'warning' ? 'warning' : 'error',
      retryable: error.error.retryable,
    };
  }

  // Network error
  if (error?.message?.includes('fetch') || error?.message?.includes('network')) {
    return {
      type: 'network_error',
      message: 'Network connection failed.',
      suggestion: 'Check your internet connection and try again.',
      severity: 'error',
      retryable: true,
    };
  }

  // Unknown error — never show "Something went wrong"
  return {
    type: 'system_error',
    message: error?.message || 'An unexpected error occurred.',
    suggestion: 'Try again. If the problem persists, contact support with the request ID.',
    severity: 'error',
    retryable: false,
  };
}

function mapCodeToType(code: string): UIErrorType {
  if (code.startsWith('VALIDATION_')) return 'validation_error';
  if (code.startsWith('BUSINESS_')) return 'validation_error';
  if (code.startsWith('INFRA_')) return 'system_error';
  if (code.startsWith('EXTERNAL_')) return 'system_error';
  if (code === 'INSUFFICIENT_ROLE' || code === 'FORBIDDEN_ORG' || code === 'NO_ORG_MEMBERSHIP') return 'permission_error';
  if (code === 'INVITE_INVALID' || code === 'EMAIL_MISMATCH') return 'validation_error';
  if (code === 'RATE_LIMIT_EXCEEDED') return 'system_error';
  return 'system_error';
}

// ---------------------------------------------------------------------------
// React Hook: useUIError
// ---------------------------------------------------------------------------

/**
 * React hook for managing UI errors in components.
 * Provides error state, setters, and auto-dismiss.
 */
export function useUIError(autoDismissMs?: number) {
  const [error, setError] = React.useState<UIError | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, UIError>>({});

  const showError = React.useCallback((err: UIError | any) => {
    const uiError = err instanceof Object && err.type ? err : toUIError(err);
    setError(uiError);

    if (uiError.field) {
      setFieldErrors((prev) => ({ ...prev, [uiError.field!]: uiError }));
    }

    if (autoDismissMs) {
      setTimeout(() => {
        setError(null);
      }, autoDismissMs);
    }
  }, [autoDismissMs]);

  const clearError = React.useCallback(() => {
    setError(null);
  }, []);

  const clearFieldError = React.useCallback((field: string) => {
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const clearAll = React.useCallback(() => {
    setError(null);
    setFieldErrors({});
  }, []);

  return {
    error,
    fieldErrors,
    showError,
    clearError,
    clearFieldError,
    clearAll,
  };
}

// ---------------------------------------------------------------------------
// React Hook: useAsyncAction
// ---------------------------------------------------------------------------

/**
 * React hook for managing async actions with loading/error/success states.
 */
export function useAsyncAction<T>() {
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<UIError | null>(null);
  const [data, setData] = React.useState<T | null>(null);

  const execute = React.useCallback(async (
    fn: () => Promise<T>,
    onSuccess?: (data: T) => void,
    onError?: (error: UIError) => void,
  ) => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await fn();
      setData(result);
      onSuccess?.(result);
      return result;
    } catch (err) {
      const uiError = toUIError(err);
      setError(uiError);
      onError?.(uiError);
      throw uiError;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const reset = React.useCallback(() => {
    setIsLoading(false);
    setError(null);
    setData(null);
  }, []);

  return { isLoading, error, data, execute, reset };
}

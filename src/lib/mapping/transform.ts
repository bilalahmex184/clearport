// ============================================================================
// ClearPort — Transform Interpreter
// Applies typed transforms to field values during import/export.
// ============================================================================

export type TransformType = 'date_format' | 'round' | 'concat' | 'lookup_table' | 'currency_convert' | 'uppercase' | 'lowercase' | 'trim';

export interface TransformConfig {
  type: TransformType;
  [key: string]: any;
}

/**
 * Apply a transform to a value.
 * Returns the transformed value, or the original if the transform fails.
 */
export function applyTransform(value: string, transform: TransformConfig | null | undefined): string {
  if (!transform || !transform.type) return value;
  if (value === null || value === undefined) return '';

  try {
    switch (transform.type) {
      case 'date_format':
        return transformDate(value, transform.from || 'YYYY-MM-DD', transform.to || 'MM/DD/YYYY');

      case 'round':
        return transformRound(value, transform.decimals ?? 2);

      case 'concat':
        return transformConcat(value, transform.prefix || '', transform.suffix || '');

      case 'lookup_table':
        return transformLookup(value, transform.table || {});

      case 'currency_convert':
        // For now, just normalize the currency symbol
        return transformCurrency(value, transform.to || 'USD');

      case 'uppercase':
        return value.toUpperCase();

      case 'lowercase':
        return value.toLowerCase();

      case 'trim':
        return value.trim();

      default:
        return value;
    }
  } catch {
    return value; // On transform failure, return original
  }
}

/**
 * Apply multiple transforms in sequence.
 */
export function applyTransforms(value: string, transforms: TransformConfig[] | null | undefined): string {
  if (!transforms || !Array.isArray(transforms)) return value;
  let result = value;
  for (const transform of transforms) {
    result = applyTransform(result, transform);
  }
  return result;
}

// ============================================================================
// Individual transform implementations
// ============================================================================

function transformDate(value: string, fromFormat: string, toFormat: string): string {
  // Parse common date formats
  let year: string, month: string, day: string;

  if (fromFormat === 'YYYY-MM-DD') {
    const m = value.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return value;
    [, year, month, day] = m;
  } else if (fromFormat === 'MM/DD/YYYY') {
    const m = value.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return value;
    [, month, day, year] = m;
  } else if (fromFormat === 'DD.MM.YYYY') {
    const m = value.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (!m) return value;
    [, day, month, year] = m;
  } else {
    return value;
  }

  // Pad to 2 digits
  month = month.padStart(2, '0');
  day = day.padStart(2, '0');

  // Format output
  if (toFormat === 'YYYY-MM-DD') return `${year}-${month}-${day}`;
  if (toFormat === 'MM/DD/YYYY') return `${month}/${day}/${year}`;
  if (toFormat === 'DD.MM.YYYY') return `${day}.${month}.${year}`;
  return value;
}

function transformRound(value: string, decimals: number): string {
  const num = parseFloat(value.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(num)) return value;
  return num.toFixed(decimals);
}

function transformConcat(value: string, prefix: string, suffix: string): string {
  return `${prefix}${value}${suffix}`;
}

function transformLookup(value: string, table: Record<string, string>): string {
  const normalized = value.toLowerCase().trim();
  return table[normalized] || table[value] || value;
}

function transformCurrency(value: string, toCurrency: string): string {
  // Strip existing currency symbol
  const num = value.replace(/[$€£¥]/g, '').trim();
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
  const symbol = symbols[toCurrency] || '$';
  return `${symbol}${num}`;
}

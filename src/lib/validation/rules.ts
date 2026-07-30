// ============================================================================
// rules.ts — Business validation rules for customs documents
// ============================================================================
// Validates extracted data against real-world business logic:
//   - Line items total must match subtotal (±$1 tolerance)
//   - Subtotal + tax must match total_amount (±$1 tolerance)
//   - Required fields must be present
//   - HTS code format must be XXXX.XX.XXXX
//   - Country of origin must be ISO alpha-2
//   - Dates must be realistic (not future, not pre-1900)
//   - Net weight must not exceed gross weight
//
// Returns a list of validation errors that feed into the confidence scorer.
// ============================================================================

export interface ValidationRule {
  field: string;
  rule: string;
  error: string;
  severity: 'error' | 'warning';
}

export interface LineItem {
  description?: string;
  quantity?: number;
  unit_price?: number;
  total?: number;
}

export interface ExtractionDataForValidation {
  invoiceNo?: string | null;
  invoiceDate?: string | null;
  shipper?: string | null;
  consignee?: string | null;
  declaredValue?: number | null;
  currency?: string | null;
  htsCode?: string | null;
  netWeight?: string | null;
  grossWeight?: string | null;
  countryOfOrigin?: string | null;
  // Line items (for total validation)
  lineItems?: LineItem[];
  subtotal?: number | null;
  tax?: number | null;
  totalAmount?: number | null;
}

const TOLERANCE = 1; // $1 tolerance for total matching (handles rounding)
const REQUIRED_FIELDS = ['invoiceNo', 'shipper', 'consignee', 'declaredValue', 'htsCode'];

/**
 * Run all business validation rules against extracted data.
 */
export function validateBusinessRules(data: ExtractionDataForValidation): ValidationRule[] {
  const rules: ValidationRule[] = [];

  // 1. Required fields
  for (const field of REQUIRED_FIELDS) {
    const value = (data as any)[field];
    if (!value || (typeof value === 'string' && value.trim() === '')) {
      rules.push({
        field,
        rule: 'required',
        error: `Required field "${field}" is missing or empty`,
        severity: 'error',
      });
    }
  }

  // 2. Line items total must match subtotal
  if (data.lineItems && data.lineItems.length > 0 && data.subtotal !== null && data.subtotal !== undefined) {
    const itemsTotal = data.lineItems.reduce((sum, item) => {
      const itemTotal = item.total ?? (item.quantity && item.unit_price ? item.quantity * item.unit_price : 0);
      return sum + (itemTotal || 0);
    }, 0);

    if (Math.abs(itemsTotal - data.subtotal) > TOLERANCE) {
      rules.push({
        field: 'subtotal',
        rule: 'line_items_match',
        error: `Line items total (${itemsTotal.toFixed(2)}) does not match subtotal (${data.subtotal.toFixed(2)})`,
        severity: 'error',
      });
    }
  }

  // 3. Subtotal + tax must match total_amount
  if (data.subtotal !== null && data.subtotal !== undefined &&
      data.totalAmount !== null && data.totalAmount !== undefined) {
    const expectedTotal = data.subtotal + (data.tax || 0);
    if (Math.abs(expectedTotal - data.totalAmount) > TOLERANCE) {
      rules.push({
        field: 'totalAmount',
        rule: 'total_match',
        error: `Subtotal (${data.subtotal.toFixed(2)}) + tax (${(data.tax || 0).toFixed(2)}) does not match total (${data.totalAmount.toFixed(2)})`,
        severity: 'error',
      });
    }
  }

  // 4. Date format + realism
  if (data.invoiceDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.invoiceDate)) {
      rules.push({
        field: 'invoiceDate',
        rule: 'date_format',
        error: `Date "${data.invoiceDate}" is not in ISO format (YYYY-MM-DD)`,
        severity: 'warning',
      });
    } else {
      const date = new Date(data.invoiceDate);
      const now = new Date();
      const minDate = new Date('1900-01-01');
      if (date > now) {
        rules.push({ field: 'invoiceDate', rule: 'future_date', error: 'Date is in the future', severity: 'warning' });
      } else if (date < minDate) {
        rules.push({ field: 'invoiceDate', rule: 'old_date', error: 'Date is before 1900', severity: 'warning' });
      }
    }
  }

  // 5. HTS code format
  if (data.htsCode) {
    if (!/^\d{4}\.\d{2}\.\d{4}$/.test(data.htsCode)) {
      rules.push({
        field: 'htsCode',
        rule: 'format',
        error: `HTS code "${data.htsCode}" does not match format XXXX.XX.XXXX`,
        severity: 'warning',
      });
    }
  }

  // 6. Country of origin format
  if (data.countryOfOrigin) {
    if (!/^[A-Z]{2}$/.test(data.countryOfOrigin)) {
      rules.push({
        field: 'countryOfOrigin',
        rule: 'format',
        error: `Country "${data.countryOfOrigin}" is not ISO 3166-1 alpha-2`,
        severity: 'warning',
      });
    }
  }

  // 7. Net weight ≤ gross weight
  if (data.netWeight && data.grossWeight) {
    const netNum = parseFloat(data.netWeight.replace(/[^0-9.]/g, ''));
    const grossNum = parseFloat(data.grossWeight.replace(/[^0-9.]/g, ''));
    if (!isNaN(netNum) && !isNaN(grossNum) && netNum > grossNum) {
      rules.push({
        field: 'netWeight',
        rule: 'cross_field',
        error: `Net weight (${netNum}) > gross weight (${grossNum}) — values may be swapped`,
        severity: 'error',
      });
    }
  }

  // 8. Declared value must be positive
  if (data.declaredValue !== null && data.declaredValue !== undefined && data.declaredValue <= 0) {
    rules.push({
      field: 'declaredValue',
      rule: 'positive',
      error: `Declared value must be positive (got ${data.declaredValue})`,
      severity: 'error',
    });
  }

  return rules;
}

/**
 * Quick check: does the data have enough structure for line-items validation?
 * Used to decide whether to run the expensive totals check.
 */
export function hasLineItems(data: any): boolean {
  return Array.isArray(data?.lineItems) && data.lineItems.length > 0;
}

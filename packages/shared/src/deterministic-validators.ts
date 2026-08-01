// ============================================================================
// deterministic-validators.ts — Pure deterministic validation logic
// ============================================================================
// WHAT THIS IS
//   The single home for the deterministic (non-LLM) validation logic that
//   runs on EVERY extracted field set. Ports the pure logic from three
//   previously-orphaned sources into one shared package:
//
//     1. supabase/functions/math-validate/index.ts (433 lines) — the
//        math/cross-field checks (net vs gross weight, line-item sums,
//        date sequence, currency consistency). The Deno/Supabase plumbing
//        is dropped; only the parsing helpers + check functions are kept.
//     2. supabase/functions/cross-validate/index.ts (323 lines) — the
//        cross-document reconciliation (container number on B/L must match
//        the one on the invoice, etc.). The Gemini/Supabase plumbing is
//        dropped; the pure per-field-pair comparison is kept.
//     3. src/lib/extraction/pipeline.ts (152 lines) — the format validators
//        (validateContainerNumber ISO 6346 check digit, validateBlNumber
//        carrier prefix + pattern, validateIncoterms Incoterms 2020 set,
//        normalizeCountry, normalizePort, validateHsCode) and the
//        fuzzyNameMatch / valuesMatchWithinTolerance helpers used by
//        reconciliation.
//
// WHY
//   The LLM must NEVER compute totals, sums, or date comparisons — it
//   hallucinates arithmetic. These functions do that work deterministically,
//   and the consumer Worker calls runDeterministicValidation() on every
//   job to produce a combined ValidationException[] list. Each exception
//   is tagged with one of three exception_type values so the downstream
//   routing / audit ledger can distinguish math errors from cross-doc
//   mismatches from schema errors.
//
// PURITY
//   This module has zero runtime deps on Deno, Supabase, fetch, or env vars.
//   It imports only the CanonicalField type from ./extraction-schema. That
//   makes it unit-testable in pure-logic (vitest, node env) and Worker-safe
//   (no Node-only builtins).
// ============================================================================

import type { CanonicalField, FieldDefinition } from './extraction-schema';
import { FIELD_REGISTRY } from './extraction-schema';

// ---------------------------------------------------------------------------
// §1. Public types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  reason: string;
  computed?: string;
  normalized?: string;
}

export interface ValidationException {
  field_key: string;
  reason: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  exception_type: 'math_error' | 'cross_doc_mismatch' | 'schema_error';
  value_a?: string;
  value_b?: string;
}

// ---------------------------------------------------------------------------
// §2. Number / weight parsing helpers (ported verbatim from math-validate)
// ---------------------------------------------------------------------------

/**
 * Pull a numeric value out of a messy string like "$1,234.56 USD" or "1234 kg".
 * Returns null for non-numeric input. Strips commas, spaces, currency symbols,
 * and unit suffixes — anything that isn't a digit, decimal point, or minus.
 */
export function parseNumber(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).replace(/[, ]/g, '').replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize unit strings to canonical short forms BEFORE any comparison.
 *   "lbs", "lb", "pounds", "pound"      -> "lbs"
 *   "kg", "kgs", "kilograms", "kilogram" -> "kg"
 *   "g", "gram", "grams"                 -> "g"
 *   "oz", "ounce", "ounces"              -> "oz"
 *   "ton", "tons", "tonne", "tonnes"     -> "tons"
 * Anything else is returned lowercased as-is so unknown units don't silently
 * collapse together (which would cause false-positive mismatches).
 */
export function normalizeUnit(raw: string | null | undefined): string {
  if (!raw) return '';
  const u = String(raw).trim().toLowerCase();
  if (u === 'lb' || u === 'lbs' || u === 'pound' || u === 'pounds') return 'lbs';
  if (u === 'kg' || u === 'kgs' || u === 'kilogram' || u === 'kilograms') return 'kg';
  if (u === 'g' || u === 'gram' || u === 'grams') return 'g';
  if (u === 'oz' || u === 'ounce' || u === 'ounces') return 'oz';
  if (u === 'ton' || u === 'tons' || u === 'tonne' || u === 'tonnes') return 'tons';
  return u;
}

/**
 * Pull weight number + unit from "1234 kg" / "1,234.5 lb" / "500g" /
 * "500 pounds". The unit is normalized to its canonical short form via
 * normalizeUnit(). Returns null if the input doesn't match the expected
 * shape (number, optional unit).
 */
export function parseWeight(
  v: string | null | undefined,
): { value: number; unit: string } | null {
  if (!v) return null;
  // Accept spelled-out unit forms (pounds, kilograms, etc.) in addition to
  // the short forms handled previously.
  const m = String(v).match(
    /^([\d,]+(?:\.\d+)?)\s*(kg|kgs|kilograms?|lbs?|pounds?|g|grams?|oz|ounces?|tons?|tonnes?)?$/i,
  );
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ''));
  const unit = normalizeUnit(m[2]);
  if (!Number.isFinite(value)) return null;
  return { value, unit };
}

/**
 * Convert a parsed weight to kg for comparison. Uses the canonical unit
 * produced by normalizeUnit() so we don't need to handle every spelling here.
 * An empty/unspecified unit is assumed to be kg (the SI default for cargo).
 */
export function toKg(w: { value: number; unit: string }): number {
  switch (w.unit) {
    case 'lbs':
      return w.value * 0.45359237;
    case 'g':
      return w.value / 1000;
    case 'oz':
      return w.value * 0.0283495231;
    case 'tons':
      return w.value * 907.18474; // assume short ton
    case 'kg':
    case '': // unspecified — assume kg
    default:
      return w.value;
  }
}

// ---------------------------------------------------------------------------
// §3. Internal helpers for CanonicalField lookups
// ---------------------------------------------------------------------------

/** Find the first field with the given canonical key (or any alias). */
function findField(fields: CanonicalField[], key: string): CanonicalField | undefined {
  return fields.find((f) => f.field_key === key);
}

/** Find ALL fields with the given canonical key (some docs have multi-value fields). */
function findAllFields(fields: CanonicalField[], key: string): CanonicalField[] {
  return fields.filter((f) => f.field_key === key);
}

/** Look up the FIELD_REGISTRY definition for a canonical key. */
function lookupFieldDef(fieldKey: string): FieldDefinition | undefined {
  return FIELD_REGISTRY.find((d) => d.key === fieldKey);
}

// ---------------------------------------------------------------------------
// §4. Math validation checks (ported from math-validate)
// ---------------------------------------------------------------------------

/**
 * Check net_weight <= gross_weight (within tolerance — 0.5% relative to the
 * gross, with a 0.01 kg floor to avoid false positives on tiny rounding
 * errors). If net > gross beyond tolerance, that's CRITICAL — physically
 * impossible (cargo can't weigh more without its packaging).
 *
 * Compares in kg via toKg() so different units (lbs vs kg) reconcile
 * correctly. Returns [] if either weight is missing or unparseable.
 */
export function checkNetVsGrossWeight(fields: CanonicalField[]): ValidationException[] {
  const netField = findField(fields, 'net_weight');
  const grossField = findField(fields, 'gross_weight');
  if (!netField || !grossField) return [];

  const netW = parseWeight(netField.value);
  const grossW = parseWeight(grossField.value);
  if (!netW || !grossW) return [];

  const netKg = toKg(netW);
  const grossKg = toKg(grossW);
  const tolerance = Math.max(0.01, grossKg * 0.005);
  if (netKg > grossKg + tolerance) {
    return [{
      field_key: 'net_weight',
      reason: `Net weight (${netField.value} = ${netKg.toFixed(3)} kg) exceeds gross weight (${grossField.value} = ${grossKg.toFixed(3)} kg) — physically impossible (net must be <= gross).`,
      severity: 'CRITICAL',
      exception_type: 'math_error',
      value_a: netField.value,
      value_b: grossField.value,
    }];
  }
  return [];
}

/**
 * Check sum(line_items.quantity × line_items.unit_price) ≈ subtotal.
 * Tolerance is 0.1% (relative to the larger of sum | subtotal). Mismatch = MAJOR.
 *
 * Line items are read from the `line_items` field's `line_items_array` — the
 * structured array the LLM returns (NOT free text). Each line item is
 * expected to have quantity + unit_price; we defensively try several common
 * key spellings (qty, unit_price, unitPrice, price). Returns [] if the
 * line_items_array is absent or subtotal is missing/unparseable.
 */
export function checkLineItemsSum(fields: CanonicalField[]): ValidationException[] {
  const lineItemsField = findField(fields, 'line_items');
  const subtotalField = findField(fields, 'subtotal');
  if (!lineItemsField || !lineItemsField.line_items_array) return [];
  if (!subtotalField) return [];

  const subtotal = parseNumber(subtotalField.value);
  if (subtotal == null) return [];

  const items = lineItemsField.line_items_array;
  let sum = 0;
  let counted = 0;
  for (const item of items) {
    const qty = parseNumber(
      String(item.quantity ?? item.qty ?? item.count ?? ''),
    );
    const price = parseNumber(
      String(item.unit_price ?? item.unitPrice ?? item.price ?? ''),
    );
    if (qty != null && price != null) {
      sum += qty * price;
      counted++;
    }
  }
  // If we couldn't parse any line item, don't flag — the array shape was off.
  if (counted === 0) return [];

  const tolerance = Math.max(Math.abs(sum), Math.abs(subtotal), 1) * 0.001;
  if (Math.abs(sum - subtotal) > tolerance) {
    return [{
      field_key: 'subtotal',
      reason: `Line items sum to ${sum.toFixed(2)} but subtotal is ${subtotal.toFixed(2)} — difference exceeds 0.1% tolerance.`,
      severity: 'MAJOR',
      exception_type: 'math_error',
      value_a: String(sum.toFixed(2)),
      value_b: String(subtotal.toFixed(2)),
    }];
  }
  return [];
}

/**
 * Check subtotal + tax + discount ≈ total_value (within 0.1% tolerance).
 * Missing values default to 0. Mismatch = MAJOR.
 *
 * NOTE: the spec literally says "subtotal + tax + discount". We follow the
 * spec text here. If `discount` is stored signed (negative for a reduction),
 * this works correctly. If `discount` is stored as a positive magnitude and
 * you'd prefer subtotal - discount + tax = total, that's a future tuning
 * decision — the current code matches the spec wording.
 */
export function checkSubtotalPlusTaxEqualsTotal(
  fields: CanonicalField[],
): ValidationException[] {
  const subtotalField = findField(fields, 'subtotal');
  const totalField = findField(fields, 'total_value');
  if (!subtotalField || !totalField) return [];

  const subtotal = parseNumber(subtotalField.value);
  const total = parseNumber(totalField.value);
  if (subtotal == null || total == null) return [];

  const taxField = findField(fields, 'tax');
  const discountField = findField(fields, 'discount');
  const tax = taxField ? parseNumber(taxField.value) ?? 0 : 0;
  const discount = discountField ? parseNumber(discountField.value) ?? 0 : 0;

  const computed = subtotal + tax + discount;
  const tolerance = Math.max(Math.abs(computed), Math.abs(total), 1) * 0.001;
  if (Math.abs(computed - total) > tolerance) {
    return [{
      field_key: 'total_value',
      reason: `subtotal (${subtotal}) + tax (${tax}) + discount (${discount}) = ${computed.toFixed(2)} but total_value is ${total.toFixed(2)} — difference exceeds 0.1% tolerance.`,
      severity: 'MAJOR',
      exception_type: 'math_error',
      value_a: String(computed.toFixed(2)),
      value_b: String(total.toFixed(2)),
    }];
  }
  return [];
}

/**
 * Check invoice_date < shipped_on_board_date < delivery_date when all are
 * present. Out-of-order = CRITICAL (delivery before shipment is impossible).
 * Equal dates are OK (same-day shipment is valid). Returns [] unless at
 * least two of the three are present and parseable as ISO dates.
 */
export function checkDateSequence(fields: CanonicalField[]): ValidationException[] {
  const invoice = findField(fields, 'invoice_date');
  const shipped = findField(fields, 'shipped_on_board_date');
  const delivery = findField(fields, 'delivery_date');

  const exceptions: ValidationException[] = [];

  // Parse ISO date strings (YYYY-MM-DD). Strings that don't parse are skipped
  // (we don't flag unparseable dates here — that's a schema_error, not math).
  const dInvoice = invoice ? parseDate(invoice.value) : null;
  const dShipped = shipped ? parseDate(shipped.value) : null;
  const dDelivery = delivery ? parseDate(delivery.value) : null;

  // invoice_date < shipped_on_board_date
  if (dInvoice != null && dShipped != null && dShipped < dInvoice) {
    exceptions.push({
      field_key: 'shipped_on_board_date',
      reason: `Shipped-on-board date (${shipped!.value}) is before invoice date (${invoice!.value}) — goods can't ship before the invoice is issued.`,
      severity: 'CRITICAL',
      exception_type: 'math_error',
      value_a: invoice!.value,
      value_b: shipped!.value,
    });
  }

  // shipped_on_board_date < delivery_date
  if (dShipped != null && dDelivery != null && dDelivery < dShipped) {
    exceptions.push({
      field_key: 'delivery_date',
      reason: `Delivery date (${delivery!.value}) is before shipped-on-board date (${shipped!.value}) — goods can't be delivered before they ship.`,
      severity: 'CRITICAL',
      exception_type: 'math_error',
      value_a: shipped!.value,
      value_b: delivery!.value,
    });
  }

  // invoice_date < delivery_date (transitive check — catches the case where
  // shipped_on_board_date is missing but invoice is after delivery)
  if (dInvoice != null && dDelivery != null && dDelivery < dInvoice) {
    exceptions.push({
      field_key: 'delivery_date',
      reason: `Delivery date (${delivery!.value}) is before invoice date (${invoice!.value}) — goods can't be delivered before the invoice is issued.`,
      severity: 'CRITICAL',
      exception_type: 'math_error',
      value_a: invoice!.value,
      value_b: delivery!.value,
    });
  }

  return exceptions;
}

/**
 * Parse a date string as YYYY-MM-DD. Returns ms-since-epoch or null.
 * Accepts a few common variants (YYYY/MM/DD, YYYY.MM.DD) by normalizing
 * separators to dashes first.
 */
function parseDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const normalized = String(s).trim().replace(/[/.]/g, '-');
  // Strict YYYY-MM-DD
  const m = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [_, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  // Construct UTC midnight so timezones don't shift the day.
  const ms = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * Check that all financial field values reference the same currency as the
 * `currency` field (if set). Mismatch = MINOR (often an extraction artifact,
 * not a hard error). The currency is extracted from each financial value by
 * looking for a 3-letter ISO currency code (USD, EUR, GBP, JPY, etc.).
 * Values without a recognizable currency code are skipped (don't flag a
 * bare "$1,234" — the symbol-based check is too noisy).
 */
export function checkCurrencyConsistency(fields: CanonicalField[]): ValidationException[] {
  const currencyField = findField(fields, 'currency');
  if (!currencyField) return [];
  const expected = String(currencyField.value).trim().toUpperCase();
  if (!expected) return [];

  const exceptions: ValidationException[] = [];
  const financialCategories = new Set(['financial']);
  const financialFields = fields.filter(
    (f) => financialCategories.has(f.category) && f.field_key !== 'currency',
  );

  for (const f of financialFields) {
    const found = extractCurrencyCode(f.value);
    if (found && found !== expected) {
      exceptions.push({
        field_key: f.field_key,
        reason: `Financial field ${f.field_key} references currency '${found}' but the shipment currency is '${expected}'.`,
        severity: 'MINOR',
        exception_type: 'math_error',
        value_a: found,
        value_b: expected,
      });
    }
  }
  return exceptions;
}

/** Extract a 3-letter ISO currency code from a value string, if present. */
function extractCurrencyCode(s: string): string | null {
  if (!s) return null;
  // Common ISO 4217 codes (extend as needed). Matched as a whole word so
  // "USD" doesn't match inside "URSDOM".
  const m = String(s).toUpperCase().match(/\b(USD|EUR|GBP|JPY|CAD|CNY|INR|AUD|CHF|HKD|SGD|AED|SAR|BDT|PKR|MYR|THB|VND|IDR|PHP|KRW|TWD|NZD|MXN|BRL|ZAR|TRY|RUB|SEK|NOK|DKK|PLN|CZK|HUF|ILS)\b/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// §5. Cross-document reconciliation (ported from cross-validate + the
//     fuzzyNameMatch / valuesMatchWithinTolerance helpers from pipeline.ts)
// ---------------------------------------------------------------------------

/**
 * Compare two name strings using Jaccard similarity on word sets. Threshold
 * default 0.85 (85% word overlap). Ported from pipeline.ts.
 */
export function fuzzyNameMatch(a: string, b: string, threshold = 0.85): ValidationResult {
  const na = (a || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
  const nb = (b || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
  const wa = new Set(na.split(/\s+/));
  const wb = new Set(nb.split(/\s+/));
  const inter = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  const r = union > 0 ? inter / union : 0;
  if (r < threshold) return { valid: false, reason: `similarity ${r.toFixed(2)} below ${threshold}` };
  return { valid: true, reason: `similarity ${r.toFixed(2)}` };
}

/**
 * Compare two numbers within a percentage tolerance. Default 2.0%.
 * Ported from pipeline.ts. Returns valid:false if either is zero (can't
 * meaningfully compute a relative difference).
 */
export function valuesMatchWithinTolerance(a: number, b: number, tol = 2.0): ValidationResult {
  if (a === 0 || b === 0) return { valid: false, reason: 'zero' };
  const d = (Math.abs(a - b) / Math.max(a, b)) * 100;
  if (d > tol) return { valid: false, reason: `${a} vs ${b} differ by ${d.toFixed(2)}%` };
  return { valid: true, reason: 'within tolerance' };
}

/** Field keys that are identity-critical — a mismatch is CRITICAL. */
const CRITICAL_ID_KEYS = new Set([
  'container_number',
  'container_numbers',
  'seal_number',
  'seal_numbers',
  'bl_number',
  'carrier_ref',
  'invoice_number',
]);

/** Field keys that are party names — use fuzzy matching, mismatch = MAJOR. */
const NAME_KEYS = new Set([
  'shipper_name',
  'consignee_name',
  'notify_party',
  'carrier',
]);

/** Field keys that are numeric/financial — use tolerance matching, mismatch = MINOR. */
const NUMERIC_KEYS = new Set([
  'total_value',
  'subtotal',
  'tax',
  'net_weight',
  'gross_weight',
  'quantity',
]);

/**
 * Reconcile fields that appear in 2+ documents of the same shipment.
 *   - ID fields (container_number, seal_number, bl_number, etc.): exact
 *     comparison (case-insensitive, non-alphanumerics stripped). CRITICAL on
 *     mismatch — a container can't have two numbers.
 *   - Name fields (shipper_name, consignee_name, etc.): fuzzy Jaccard
 *     match, threshold 0.85. MAJOR on mismatch.
 *   - Numeric fields (total_value, weights): tolerance 2.0%. MINOR on
 *     mismatch (weights/values vary slightly across docs due to rounding).
 *   - Other fields: exact-string compare (case-insensitive). MINOR.
 *
 * Returns [] if allDocsFields has < 2 documents or no field appears in
 * 2+ documents. Only the FIRST mismatch per (field_key, doc pair) is
 * flagged — we don't want to spam the exception list.
 */
export function reconcileCrossDocument(
  allDocsFields: Array<{ doc_id: string; doc_type: string; fields: CanonicalField[] }>,
): ValidationException[] {
  if (!allDocsFields || allDocsFields.length < 2) return [];

  // Group every field instance by field_key across all docs.
  const grouped: Record<string, Array<{
    doc_id: string;
    doc_type: string;
    field: CanonicalField;
  }>> = {};
  for (const doc of allDocsFields) {
    for (const field of doc.fields) {
      if (!grouped[field.field_key]) grouped[field.field_key] = [];
      grouped[field.field_key].push({ doc_id: doc.doc_id, doc_type: doc.doc_type, field });
    }
  }

  const exceptions: ValidationException[] = [];

  for (const [fieldKey, instances] of Object.entries(grouped)) {
    if (instances.length < 2) continue;
    // Compare every pair (i, j) for i < j. Stop at the first mismatch per
    // pair to avoid duplicate exceptions for the same pair.
    for (let i = 0; i < instances.length; i++) {
      for (let j = i + 1; j < instances.length; j++) {
        const a = instances[i];
        const b = instances[j];
        const r = compareCrossDocPair(fieldKey, a.field.value, b.field.value);
        if (!r.ok) {
          exceptions.push({
            field_key: fieldKey,
            reason: `Cross-document mismatch for "${fieldKey}": "${a.field.value}" (${a.doc_type}) vs "${b.field.value}" (${b.doc_type}) — ${r.reason}`,
            severity: r.severity,
            exception_type: 'cross_doc_mismatch',
            value_a: a.field.value,
            value_b: b.field.value,
          });
        }
      }
    }
  }

  return exceptions;
}

/** Compare two values for cross-doc reconciliation; returns severity + ok flag. */
function compareCrossDocPair(
  fieldKey: string,
  a: string,
  b: string,
): { ok: boolean; reason: string; severity: 'CRITICAL' | 'MAJOR' | 'MINOR' } {
  if (a == null || b == null || a === '' || b === '') {
    return { ok: true, reason: 'empty value skipped', severity: 'MINOR' };
  }

  if (CRITICAL_ID_KEYS.has(fieldKey)) {
    const na = normalizeId(a);
    const nb = normalizeId(b);
    if (na === nb) return { ok: true, reason: 'exact id match', severity: 'CRITICAL' };
    return { ok: false, reason: `'${a}' != '${b}'`, severity: 'CRITICAL' };
  }

  if (NAME_KEYS.has(fieldKey)) {
    const r = fuzzyNameMatch(a, b);
    return { ok: r.valid, reason: r.reason, severity: 'MAJOR' };
  }

  if (NUMERIC_KEYS.has(fieldKey)) {
    const na = parseNumber(a);
    const nb = parseNumber(b);
    if (na == null || nb == null) {
      // Fall back to exact string compare if either side doesn't parse.
      return a.trim().toLowerCase() === b.trim().toLowerCase()
        ? { ok: true, reason: 'string match', severity: 'MINOR' }
        : { ok: false, reason: `'${a}' != '${b}'`, severity: 'MINOR' };
    }
    const r = valuesMatchWithinTolerance(na, nb, 2.0);
    return { ok: r.valid, reason: r.reason, severity: 'MINOR' };
  }

  // Default: case-insensitive exact compare.
  return a.trim().toLowerCase() === b.trim().toLowerCase()
    ? { ok: true, reason: 'string match', severity: 'MINOR' }
    : { ok: false, reason: `'${a}' != '${b}'`, severity: 'MINOR' };
}

/** Normalize an ID for exact comparison: uppercase, strip non-alphanumerics. */
function normalizeId(v: string): string {
  return (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// §6. Format validators (ported from pipeline.ts — these are the canonical
//     home now; pipeline.ts keeps its own copies for backwards compat but
//     imports should be from here)
// ---------------------------------------------------------------------------

// ISO 6346 letter values (assigns 10-38, skipping multiples of 11).
const LETTER_VALUES: Record<string, number> = {
  A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19,
  J: 20, K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29,
  S: 30, T: 31, U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
};

/**
 * Validate a container number per ISO 6346 (format + check digit).
 * Format: 4 letters (owner code + category identifier U/J/Z) + 7 digits,
 * where the 7th digit is a check digit computed from the first 10 chars.
 */
export function validateContainerNumber(raw: string): ValidationResult {
  const val = (raw || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(val)) {
    return { valid: false, reason: `Format invalid (expected 4 letters + 7 digits, got '${val}')` };
  }
  const body = val.slice(0, 10);
  const given = parseInt(val[10], 10);
  let total = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const v = LETTER_VALUES[ch] ?? parseInt(ch, 10);
    total += v * Math.pow(2, i);
  }
  const rem = total % 11;
  const comp = rem === 10 ? 0 : rem;
  if (comp !== given) {
    return {
      valid: false,
      reason: `ISO 6346 check-digit mismatch: computed ${comp}, document shows ${given}`,
      computed: String(comp),
    };
  }
  return { valid: true, reason: 'ISO 6346 check-digit valid', normalized: val };
}

/**
 * Validate a B/L (bill of lading) number against known carrier prefix patterns.
 * Each carrier has a 4-letter prefix (MAEU, HLCU, MSCU, etc.) followed by a
 * carrier-specific number pattern. Unknown prefixes are rejected.
 */
const CARRIER_BL: Record<string, RegExp> = {
  MAEU: /^MAEU\d{9}(-[A-Z]{2})?$/,
  HLCU: /^HLCU[A-Z0-9]{10}$/,
  MSCU: /^MSCU[A-Z0-9]{10}$/,
  SCLU: /^SCLU[A-Z0-9]{10}$/,
  OOLU: /^OOLU[A-Z0-9]{10}$/,
  COSU: /^COSU[A-Z0-9]{10}$/,
  ONEU: /^ONEU[A-Z0-9]{10}$/,
};

export function validateBlNumber(raw: string): ValidationResult {
  const val = (raw || '').replace(/\s+/g, '').toUpperCase();
  const pfx = val.slice(0, 4);
  const pat = CARRIER_BL[pfx];
  if (!pat) return { valid: false, reason: `Unknown carrier prefix '${pfx}'` };
  if (!pat.test(val)) return { valid: false, reason: `'${val}' doesn't match ${pfx} pattern` };
  return { valid: true, reason: 'matches', normalized: val };
}

/** Incoterms 2020 codes (11 total). */
const INCOTERMS_2020 = new Set([
  'EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP',
]);

/**
 * Validate an Incoterms 2020 string. The first token must be a valid code.
 * CIF/CFR/FOB/FAS (port-based terms) require a named port after the code.
 */
export function validateIncoterms(raw: string): ValidationResult {
  const parts = (raw || '').trim().split(/\s+/);
  if (!parts.length || parts[0] === '') return { valid: false, reason: 'empty' };
  const code = parts[0].toUpperCase();
  const place = parts.length > 1 ? parts.slice(1).join(' ') : null;
  if (!INCOTERMS_2020.has(code)) return { valid: false, reason: `'${code}' not valid Incoterms 2020` };
  if (['CIF', 'CFR', 'FOB', 'FAS'].includes(code) && !place) {
    return { valid: false, reason: `${code} requires named port` };
  }
  return { valid: true, reason: 'valid', normalized: `${code} ${place || ''}`.trim() };
}

/** Common country names → ISO2 codes. Extend as needed for new markets. */
const COUNTRY_TO_ISO2: Record<string, string> = {
  PAKISTAN: 'PK', 'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US', USA: 'US',
  CHINA: 'CN', GERMANY: 'DE', INDIA: 'IN', BANGLADESH: 'BD', VIETNAM: 'VN',
  JAPAN: 'JP', 'UNITED KINGDOM': 'GB', CANADA: 'CA', MEXICO: 'MX', NETHERLANDS: 'NL',
};

export function normalizeCountry(raw: string): ValidationResult {
  const key = (raw || '').trim().toUpperCase();
  if (COUNTRY_TO_ISO2[key]) return { valid: true, reason: 'normalized', normalized: COUNTRY_TO_ISO2[key] };
  if (/^[A-Z]{2}$/.test(key)) return { valid: true, reason: 'already ISO', normalized: key };
  return { valid: false, reason: `Unrecognized '${raw}'` };
}

/** Common port cities → UN/LOCODE. Extend as needed. */
const PORT_TO_LOCODE: Record<string, string> = {
  'LONG BEACH': 'USLGB', 'LOS ANGELES': 'USLAX', KARACHI: 'PKKHI', OAKLAND: 'USOAK',
  'NEW YORK': 'USNYC', SHANGHAI: 'CNSHA', SHENZHEN: 'CNSZN', SINGAPORE: 'SGSIN',
  ROTTERDAM: 'NLRTM', HAMBURG: 'DEHAM',
};

export function normalizePort(raw: string): ValidationResult {
  const text = (raw || '').toUpperCase();
  const m = text.match(/\(([A-Z]{5})\)/);
  if (m) return { valid: true, reason: 'LOCODE present', normalized: m[1] };
  for (const [city, code] of Object.entries(PORT_TO_LOCODE)) {
    if (text.includes(city)) return { valid: true, reason: `matched ${city}`, normalized: code };
  }
  return { valid: false, reason: `Can't resolve '${raw}'` };
}

/**
 * Validate HS/HTS codes. Accepts comma-separated list. Each code must be
 * 6, 8, or 10 digits (after stripping non-digits). 6 = international
 * harmonized, 8/10 = country-specific (US 10-digit HTS, EU 8-digit CN).
 */
export function validateHsCode(raw: string): ValidationResult {
  const codes = (raw || '').split(',').map((c) => c.trim()).filter(Boolean);
  if (!codes.length) return { valid: false, reason: 'none' };
  const bad: string[] = [];
  for (const c of codes) {
    const d = c.replace(/\D/g, '');
    if (![6, 8, 10].includes(d.length)) bad.push(`'${c}'(${d.length})`);
  }
  if (bad.length) return { valid: false, reason: `Invalid: ${bad.join(', ')}` };
  return { valid: true, reason: 'valid', normalized: raw };
}

// ---------------------------------------------------------------------------
// §7. Schema validator dispatch — apply the right validator to a field
//     based on its FIELD_REGISTRY `validator` tag. Container-number failures
//     are CRITICAL (matches pipeline.ts severity policy); other schema
//     failures are MINOR.
// ---------------------------------------------------------------------------

/** Map a FIELD_REGISTRY validator name to the function that implements it. */
function runSchemaValidator(validatorName: FieldDefinition['validator'], value: string): ValidationResult {
  switch (validatorName) {
    case 'container_number': return validateContainerNumber(value);
    case 'bl_number': return validateBlNumber(value);
    case 'incoterms': return validateIncoterms(value);
    case 'country': return normalizeCountry(value);
    case 'port': return normalizePort(value);
    case 'hs_code': return validateHsCode(value);
    case 'date': {
      // For 'date' validator, just check it parses as YYYY-MM-DD.
      const ms = parseDate(value);
      return ms != null
        ? { valid: true, reason: 'parseable date', normalized: value }
        : { valid: false, reason: `Date '${value}' is not YYYY-MM-DD` };
    }
    case 'currency': {
      // For 'currency' validator, accept 3-letter ISO codes or strings
      // containing one (parseNumber already strips the currency symbol).
      const code = extractCurrencyCode(value);
      const n = parseNumber(value);
      if (code == null && n == null) return { valid: false, reason: `'${value}' has no parseable amount or currency` };
      return { valid: true, reason: 'parseable currency', normalized: code || value };
    }
    case 'weight': {
      const w = parseWeight(value);
      return w != null
        ? { valid: true, reason: 'parseable weight', normalized: `${w.value} ${w.unit}` }
        : { valid: false, reason: `'${value}' is not a parseable weight` };
    }
    default:
      return { valid: true, reason: 'no validator' };
  }
}

/**
 * For each CanonicalField, look up its validator (if any) in FIELD_REGISTRY
 * and run it. Container-number failures are CRITICAL; all other schema
 * failures are MINOR (matches pipeline.ts severity policy).
 */
export function runSchemaValidatorsForFields(fields: CanonicalField[]): ValidationException[] {
  const exceptions: ValidationException[] = [];
  for (const field of fields) {
    const def = lookupFieldDef(field.field_key);
    if (!def?.validator) continue;
    // Skip empty values — missing fields are flagged elsewhere (required-field
    // checks), not here.
    if (field.value == null || field.value === '') continue;
    const r = runSchemaValidator(def.validator, field.value);
    if (!r.valid) {
      const severity: ValidationException['severity'] =
        def.validator === 'container_number' ? 'CRITICAL' : 'MINOR';
      exceptions.push({
        field_key: field.field_key,
        reason: r.reason,
        severity,
        exception_type: 'schema_error',
      });
    }
  }
  return exceptions;
}

// ---------------------------------------------------------------------------
// §8. Single entry point — runs ALL the checks and returns a combined list.
//     This is what the consumer calls on every extracted field set.
// ---------------------------------------------------------------------------

/**
 * Run every deterministic check on a single document's field set, plus
 * optional cross-document reconciliation if a multi-doc field set is provided.
 *
 *   fields       — the CanonicalField[] for THIS document (math + schema checks)
 *   allDocsFields — optional array of {doc_id, doc_type, fields} for every
 *                   document in the shipment. When provided AND containing
 *                  >= 2 documents, cross-document reconciliation runs.
 *
 * Returns a combined ValidationException[] list. Each exception is tagged
 * with one of:
 *   - math_error        — net>gross, line-item sum mismatch, date sequence,
 *                          subtotal/tax/total mismatch, currency mismatch.
 *   - schema_error      — container number check-digit failure, B/L pattern
 *                          failure, invalid Incoterms, unparseable date, etc.
 *   - cross_doc_mismatch — same field has different values across documents.
 */
export function runDeterministicValidation(
  fields: CanonicalField[],
  allDocsFields?: Array<{ doc_id: string; doc_type: string; fields: CanonicalField[] }>,
): ValidationException[] {
  const exceptions: ValidationException[] = [];

  // --- Math checks (math_error) ---
  exceptions.push(...checkNetVsGrossWeight(fields));
  exceptions.push(...checkLineItemsSum(fields));
  exceptions.push(...checkSubtotalPlusTaxEqualsTotal(fields));
  exceptions.push(...checkDateSequence(fields));
  exceptions.push(...checkCurrencyConsistency(fields));

  // --- Schema checks (schema_error) ---
  exceptions.push(...runSchemaValidatorsForFields(fields));

  // --- Cross-doc reconciliation (cross_doc_mismatch) ---
  if (allDocsFields && allDocsFields.length >= 2) {
    exceptions.push(...reconcileCrossDocument(allDocsFields));
  }

  return exceptions;
}

// ============================================================================
// regex-fallback.ts — Regex-based field extraction (Tier 2/3/4 fallback)
// ============================================================================
// This is a Workers-compatible copy of src/lib/extraction/regex-extract.ts.
// The original lives in the Next.js app and can't be imported by the consumer
// Worker (different workspace package). The logic is IDENTICAL — pure regex
// + string operations, no Node deps.
//
// Used by the pipeline-hook when AI extraction (Tier 1) fails but a text
// layer is available (Tier 2 PDF text, Tier 3 Cloud Vision, Tier 4 Tesseract).
// The regex extractor pulls fields from the text using pattern matching.
//
// Returns the raw field_key variants (invoiceNo, shipper, htsCode, etc.)
// which mapToCanonicalSchema (from extraction-schema.ts) normalizes to the
// canonical keys (invoice_number, shipper_name, hs_codes).
// ============================================================================

export interface ExtractedField {
  field_key: string;
  field_label: string;
  extracted_value: string;
  confidence: number; // 0-100
}

// Normalize UTF-8 foreign characters for ASCII-only compliance systems.
function normalizeUtf8(val: string): string {
  return val.trim()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .replace(/é/g, 'e').replace(/è/g, 'e').replace(/ê/g, 'e').replace(/ë/g, 'e')
    .replace(/á/g, 'a').replace(/à/g, 'a').replace(/â/g, 'a')
    .replace(/í/g, 'i').replace(/ì/g, 'i').replace(/î/g, 'i')
    .replace(/ó/g, 'o').replace(/ò/g, 'o').replace(/ô/g, 'o')
    .replace(/ú/g, 'u').replace(/ù/g, 'u').replace(/û/g, 'u')
    .replace(/ñ/g, 'n').replace(/ç/g, 'c')
    .replace(/[^\x00-\x7F]/g, '')
    .trim();
}

/**
 * Regex-based fallback extractor. Pulls fields from plain-text documents
 * using pattern matching. Handles multi-line tables, currency, UTF-8,
 * sparse formats, multiple languages (EN/DE/FR).
 *
 * Returns an empty array for empty/garbage input — never throws.
 * The field_key values are the LEGACY variants (invoiceNo, shipper, htsCode,
 * etc.) — mapToCanonicalSchema normalizes them to canonical keys.
 */
export function regexExtract(text: string): ExtractedField[] {
  if (!text) return [];

  const fields: ExtractedField[] = [];
  const fullText = text;

  const patterns: Array<{ key: string; label: string; regexes: RegExp[]; conf: number }> = [
    { key: 'invoiceNo', label: 'Commercial Invoice #', conf: 85, regexes: [
      /(?:invoice\s*(?:number|no\.?|#|num)\s*[:\-]?\s*)([A-Z0-9][A-Z0-9\-]+)/i,
      /(?:inv\.?\s*(?:no\.?|#|num)\s*[:\-]?\s*)([A-Z0-9][A-Z0-9\-]+)/i,
      /(?:^|\n)(INV[\-\d]+)/i,
    ]},
    { key: 'invoiceDate', label: 'Invoice Date', conf: 82, regexes: [
      /(?:invoice\s*date\s*[:\-]?\s*)(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\.\d{1,2}\.\d{4})/i,
      /(?:date\s*[:\-]\s*)(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\.\d{1,2}\.\d{4})/i,
    ]},
    { key: 'shipper', label: 'Shipper/Exporter', conf: 80, regexes: [
      /(?:shipper(?:\/exporter)?\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
      /(?:exporter\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
      /(?:from\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
    ]},
    { key: 'consignee', label: 'Consignee/Importer', conf: 80, regexes: [
      /(?:consignee(?:\/importer)?\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
      /(?:importer\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
      /(?:to\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
    ]},
    { key: 'declaredValue', label: 'Total Declared Value', conf: 88, regexes: [
      /(?:total\s*(?:declared\s*)?value\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
      /(?:declared\s*value\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
      /(?:grand\s*total\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
      /(?:invoice\s*total\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
      /(?:total\s*[:\-]?\s*)([$€£¥][\d,]+\.?\d*)/i,
    ]},
    { key: 'htsCode', label: 'HTS Code', conf: 90, regexes: [
      /(?:hts\s*(?:code)?\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i,
      /(?:hs\s*code\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i,
      /(?:tariff\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i,
      /\b(\d{4}\.\d{2}\.\d{4})\b/,
    ]},
    { key: 'netWeight', label: 'Net Weight', conf: 85, regexes: [
      /(?:net\s*weight\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?|g|grams?|oz|ounces?))/i,
      /(?:net\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?))/i,
      /(?:weight\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?))/i,
    ]},
    { key: 'grossWeight', label: 'Gross Weight', conf: 85, regexes: [
      /(?:gross\s*weight\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?|g|grams?|oz|ounces?))/i,
      /(?:gross\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?))/i,
    ]},
    { key: 'countryOfOrigin', label: 'Country of Origin', conf: 78, regexes: [
      /(?:country\s*of\s*origin\s*[:\-]?\s*)([A-Z]{2})/i,
      /(?:origin\s*[:\-]?\s*)([A-Z]{2})\b/i,
      /(?:country\s*[:\-]?\s*)([A-Z]{2})\b/i,
    ]},
    { key: 'carrier', label: 'Carrier', conf: 75, regexes: [
      /(?:carrier\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
      /(?:shipping\s*carrier\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
    ]},
    { key: 'portOfEntry', label: 'Port of Entry', conf: 75, regexes: [
      /(?:port\s*of\s*entry\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
      /(?:port\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
    ]},
    { key: 'billOfLading', label: 'Bill of Lading #', conf: 82, regexes: [
      /(?:bill\s*of\s*lading\s*(?:#|no\.?)?\s*[:\-]?\s*)([A-Z0-9\-]+)/i,
      /(?:bol\s*(?:#|no\.?)?\s*[:\-]?\s*)([A-Z0-9\-]+)/i,
    ]},
    { key: 'consigneeAddress', label: 'Consignee Address', conf: 72, regexes: [
      /(?:consignee\s*address\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
      /(?:address\s*[:\-]?\s*)(\d+.+?(?:\n|$))/i,
    ]},
  ];

  for (const { key, label, regexes, conf } of patterns) {
    for (const regex of regexes) {
      const match = fullText.match(regex);
      if (match && match[1]) {
        let value = match[1].trim();
        // UTF-8 normalization for name/address fields
        if (key === 'shipper' || key === 'consignee' || key === 'consigneeAddress' || key === 'carrier' || key === 'portOfEntry') {
          value = normalizeUtf8(value);
        }
        value = value.replace(/[,;]+$/, '').trim();
        if (value.length > 0 && value.length < 200) {
          fields.push({ field_key: key, field_label: label, extracted_value: value, confidence: conf });
          break; // first match wins
        }
      }
    }
  }

  // --- Sparse document handling: bare-value extraction ---
  if (fields.length < 3) {
    if (!fields.find((f) => f.field_key === 'invoiceNo')) {
      const m = fullText.match(/\b(INV[\-A-Z0-9]+)\b/i);
      if (m) fields.push({ field_key: 'invoiceNo', field_label: 'Commercial Invoice #', extracted_value: m[1], confidence: 70 });
    }
    if (!fields.find((f) => f.field_key === 'declaredValue')) {
      const m = fullText.match(/([$€£¥][\d,]+\.?\d*)/);
      if (m) fields.push({ field_key: 'declaredValue', field_label: 'Total Declared Value', extracted_value: m[1], confidence: 65 });
    }
    if (!fields.find((f) => f.field_key === 'htsCode')) {
      const m = fullText.match(/\b(\d{4}\.\d{2}\.\d{4})\b/);
      if (m) fields.push({ field_key: 'htsCode', field_label: 'HTS Code', extracted_value: m[1], confidence: 75 });
    }
    if (!fields.find((f) => f.field_key === 'countryOfOrigin')) {
      const m = fullText.match(/(?:^|\n)\s*([A-Z]{2})\s*(?:\n|$)/m);
      if (m) fields.push({ field_key: 'countryOfOrigin', field_label: 'Country of Origin', extracted_value: m[1], confidence: 60 });
    }
    if (!fields.find((f) => f.field_key === 'netWeight')) {
      const m = fullText.match(/(\d[\d,]*\.?\d*\s*(?:lbs?|kg|kgs|pounds?))/i);
      if (m) fields.push({ field_key: 'netWeight', field_label: 'Net Weight', extracted_value: m[1], confidence: 65 });
    }
  }

  return fields;
}

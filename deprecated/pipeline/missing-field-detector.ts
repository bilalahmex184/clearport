// ============================================================================
// ClearPort — Missing Field Detection System
// ============================================================================
// Detects fields that are missing, low-confidence, or invalid format.
// Produces MissingField[] for the pipeline contract.
// ============================================================================

import type { MissingField, ExtractedField } from "./types";

// Required fields for a customs invoice (configurable per org)
export const REQUIRED_FIELDS = [
  { key: "invoiceNo", label: "Commercial Invoice #", min_confidence: 60 },
  { key: "shipper", label: "Shipper/Exporter", min_confidence: 60 },
  { key: "consignee", label: "Consignee/Importer", min_confidence: 60 },
  { key: "declaredValue", label: "Total Declared Value", min_confidence: 60 },
] as const;

// Optional but recommended fields
export const RECOMMENDED_FIELDS = [
  { key: "invoiceDate", label: "Invoice Date", min_confidence: 60 },
  { key: "htsCode", label: "HTS Code", min_confidence: 60 },
  { key: "netWeight", label: "Net Weight", min_confidence: 60 },
  { key: "countryOfOrigin", label: "Country of Origin", min_confidence: 60 },
  { key: "carrier", label: "Carrier", min_confidence: 60 },
] as const;

/**
 * Detect missing, low-confidence, and invalid-format fields.
 */
export function detectMissingFields(
  extractedFields: ExtractedField[],
  rules?: { required?: string[]; min_confidence?: number },
): MissingField[] {
  const missing: MissingField[] = [];
  const fieldMap = new Map<string, ExtractedField>();

  // Build a map of extracted fields by key
  for (const f of extractedFields) {
    if (f.value !== null && f.value !== undefined && String(f.value).trim() !== "") {
      fieldMap.set(String(f.value), f);
    }
  }

  // Use custom required list or defaults
  const requiredFields = rules?.required
    ? rules.required.map((key) => ({ key, label: key, min_confidence: rules.min_confidence || 60 }))
    : REQUIRED_FIELDS;

  // Check required fields
  for (const req of requiredFields) {
    const field = fieldMap.get(req.key);
    if (!field) {
      missing.push({
        field: req.key,
        reason: "missing",
      });
    } else if (field.confidence < req.min_confidence) {
      missing.push({
        field: req.key,
        reason: "low_confidence",
        confidence: field.confidence,
      });
    }
  }

  // Check format validity for specific fields
  const htsField = fieldMap.get("htsCode");
  if (htsField && htsField.value) {
    if (!/^\d{4}\.\d{2}\.\d{4}$/.test(String(htsField.value))) {
      missing.push({
        field: "htsCode",
        reason: "invalid_format",
        confidence: htsField.confidence,
      });
    }
  }

  const countryField = fieldMap.get("countryOfOrigin");
  if (countryField && countryField.value) {
    if (!/^[A-Z]{2}$/.test(String(countryField.value))) {
      missing.push({
        field: "countryOfOrigin",
        reason: "invalid_format",
        confidence: countryField.confidence,
      });
    }
  }

  return missing;
}

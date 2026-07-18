// ============================================================================
// ClearPort — Shared Regex Extraction Logic
// ----------------------------------------------------------------------------
// This module is a verbatim, framework-agnostic port of the `regexExtract`
// fallback extractor that lives inside the `extract-document` edge function
// (supabase/functions/extract-document/index.ts). The edge function version is
// Deno-only and can't be imported by the Next.js app or by unit tests, so the
// pure logic is duplicated here under a stable, typed surface.
//
// WHY THIS EXISTS (P13):
//   The regex extractor is the last-line-of-defense fallback when Gemini is
//   unavailable. Bugs in it ship undetected because the function only runs
//   inside Deno and is never exercised by the vitest suite. Promoting it to
//   a shared module lets `tests/unit-pure/05-regex-extraction.test.ts` lock
//   down its behavior (commercial invoices, sparse docs, German UTF-8, CSV,
//   empty input) without a network or a Deno runtime.
//
// KEEP IN SYNC: any change to the extraction logic in
// supabase/functions/extract-document/index.ts MUST be mirrored here (and
// vice versa). The two implementations are intentionally identical.
// ============================================================================

export interface ExtractedField {
  field_key: string;
  field_label: string;
  extracted_value: string;
  confidence: number;
}

export interface LineItem {
  description: string;
  qty: number;
  htsCode: string;
  value: string;
  secondaryLines: string[];
}

export const FIELD_DEFINITIONS: Array<{ key: string; label: string }> = [
  { key: "invoiceNo", label: "Commercial Invoice #" },
  { key: "invoiceDate", label: "Invoice Date" },
  { key: "shipper", label: "Shipper/Exporter" },
  { key: "consignee", label: "Consignee/Importer" },
  { key: "consigneeAddress", label: "Consignee Address" },
  { key: "declaredValue", label: "Total Declared Value" },
  { key: "htsCode", label: "HTS Code" },
  { key: "netWeight", label: "Net Weight" },
  { key: "grossWeight", label: "Gross Weight" },
  { key: "portOfEntry", label: "Port of Entry" },
  { key: "carrier", label: "Carrier" },
  { key: "billOfLading", label: "Bill of Lading #" },
  { key: "countryOfOrigin", label: "Country of Origin" },
];

/**
 * Normalize UTF-8 foreign characters for ASCII-only compliance systems.
 * Returns both the original UTF-8 (preserved) and an ASCII-folded variant.
 */
export function normalizeUtf8(val: string): { utf8: string; ascii: string } {
  const utf8 = val.trim();
  const ascii = utf8
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .replace(/é/g, "e").replace(/è/g, "e").replace(/ê/g, "e").replace(/ë/g, "e")
    .replace(/á/g, "a").replace(/à/g, "a").replace(/â/g, "a")
    .replace(/í/g, "i").replace(/ì/g, "i").replace(/î/g, "i")
    .replace(/ó/g, "o").replace(/ò/g, "o").replace(/ô/g, "o")
    .replace(/ú/g, "u").replace(/ù/g, "u").replace(/û/g, "u")
    .replace(/ñ/g, "n").replace(/ç/g, "c")
    .replace(/[^\x00-\x7F]/g, "")
    .trim();
  return { utf8, ascii };
}

/**
 * Parse multi-line table rows. Groups secondary lines with preceding line item.
 */
export function parseTableRows(text: string): { lineItems: LineItem[]; totalValue: string | null } {
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
  const lineItems: LineItem[] = [];
  let totalValue: string | null = null;

  const itemPattern = /^(.+?)\s+(\d+)\s+(\d{4}\.\d{2}\.\d{4}|\d{8,})\s+([$€£¥]?[\d,]+\.?\d*)\s*$/i;
  const totalPattern = /^(?:total|grand\s*total|invoice\s*total|total\s*value)\s*[:\-]?\s*([$€£¥][\d,]+\.?\d*)/i;

  for (const line of lines) {
    const totalMatch = line.match(totalPattern);
    if (totalMatch && totalMatch[1]) {
      totalValue = totalMatch[1].trim();
      continue;
    }
    const itemMatch = line.match(itemPattern);
    if (itemMatch) {
      const [, desc, qty, hts, value] = itemMatch;
      lineItems.push({
        description: desc.trim(),
        qty: parseInt(qty),
        htsCode: hts.trim(),
        value: value.trim(),
        secondaryLines: [],
      });
      continue;
    }
    const isSecondary = /^(shipping\s*(?:cost|fee)?|insurance(?:\s*cost)?|freight|handling|duty|tax|discount|subtotal|other)\s*[:\-]?\s*([$€£¥]?[\d,]+\.?\d*)?/i.test(line);
    if (isSecondary && lineItems.length > 0) {
      lineItems[lineItems.length - 1].secondaryLines.push(line);
    }
  }
  return { lineItems, totalValue };
}

/**
 * Parse CSV content as structured fields. Expects rows with headers or
 * key-value pairs. Returns [] if the input doesn't look like CSV.
 */
export function parseCSV(text: string): ExtractedField[] {
  const fields: ExtractedField[] = [];
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return fields;

  // Detect delimiter (comma, semicolon, tab)
  const firstLine = lines[0];
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(';') ? ';' : ',';

  // Check if it's a header-based CSV
  const headers = firstLine.split(delimiter).map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));

  // Map CSV headers to our field keys
  const headerMap: Record<string, string> = {
    invoice: 'invoiceNo', invoicenumber: 'invoiceNo', invoiceno: 'invoiceNo', invoicenum: 'invoiceNo',
    date: 'invoiceDate', invoicedate: 'invoiceDate',
    shipper: 'shipper', exporter: 'shipper', shipperexporter: 'shipper',
    consignee: 'consignee', importer: 'consignee', consigneeimporter: 'consignee',
    value: 'declaredValue', totalvalue: 'declaredValue', declaredvalue: 'declaredValue', total: 'declaredValue', amount: 'declaredValue',
    hts: 'htsCode', htscode: 'htsCode', tariff: 'htsCode', hscode: 'htsCode',
    weight: 'netWeight', netweight: 'netWeight', net: 'netWeight',
    grossweight: 'grossWeight', gross: 'grossWeight',
    origin: 'countryOfOrigin', countryoforigin: 'countryOfOrigin', country: 'countryOfOrigin',
    carrier: 'carrier',
    port: 'portOfEntry', portofentry: 'portOfEntry',
    bol: 'billOfLading', billoflading: 'billOfLading',
    address: 'consigneeAddress', consigneeaddress: 'consigneeAddress',
  };

  // If first line looks like headers
  const hasHeaders = headers.some(h => headerMap[h]);

  if (hasHeaders && lines.length >= 2) {
    // Header-based CSV: use first data row
    const values = lines[1].split(delimiter).map(v => v.trim().replace(/^["']|["']$/g, ''));
    headers.forEach((header, idx) => {
      const fieldKey = headerMap[header];
      if (fieldKey && values[idx]) {
        const def = FIELD_DEFINITIONS.find(d => d.key === fieldKey);
        fields.push({
          field_key: fieldKey,
          field_label: def?.label || fieldKey,
          extracted_value: values[idx],
          confidence: 85,
        });
      }
    });
  } else {
    // Key-value CSV: "Invoice Number,INV-001" format
    for (const line of lines) {
      const parts = line.split(delimiter).map(p => p.trim().replace(/^["']|["']$/g, ''));
      if (parts.length >= 2) {
        const key = parts[0].toLowerCase().replace(/[^a-z0-9]/g, '');
        const value = parts[1];
        const fieldKey = headerMap[key];
        if (fieldKey && value) {
          const def = FIELD_DEFINITIONS.find(d => d.key === fieldKey);
          fields.push({
            field_key: fieldKey,
            field_label: def?.label || fieldKey,
            extracted_value: value,
            confidence: 80,
          });
        }
      }
    }
  }

  return fields;
}

/**
 * Regex-based fallback extractor. When Gemini is unavailable (invalid key,
 * rate limit, etc.), this extracts fields from plain-text documents using
 * pattern matching.
 *
 * Handles: multi-line table rows, currency sanitization, UTF-8 foreign chars,
 * sparse/minimal formats, multiple languages, CSV.
 *
 * Returns an empty array for empty/garbage input — never throws.
 */
export function regexExtract(text: string): ExtractedField[] {
  if (!text) return [];

  // Try CSV parsing first if the content looks like CSV
  const csvFields = parseCSV(text);
  if (csvFields.length >= 3) {
    return csvFields;
  }

  const fields: ExtractedField[] = [];
  const lines = text.split(/\n/).map(l => l.trim());
  const fullText = text;

  // --- Flexible field patterns ---
  // Each pattern has multiple aliases to handle different formats/languages
  const patterns: Array<{ key: string; label: string; regexes: RegExp[]; conf: number }> = [
    {
      key: "invoiceNo",
      label: "Commercial Invoice #",
      conf: 85,
      regexes: [
        /(?:invoice\s*(?:number|no\.?|#|num)\s*[:\-]?\s*)([A-Z0-9][A-Z0-9\-]+)/i,
        /(?:inv\.?\s*(?:no\.?|#|num)\s*[:\-]?\s*)([A-Z0-9][A-Z0-9\-]+)/i,
        /(?:^|\n)(INV[\-\d]+)/i,  // Bare INV-001 on its own line
        /(?:facture\s*(?:no\.?|n°|#)\s*[:\-]?\s*)([A-Z0-9][A-Z0-9\-]+)/i,  // French
        /(?:rechnung\s*(?:nr\.?|#)\s*[:\-]?\s*)([A-Z0-9][A-Z0-9\-]+)/i,  // German
      ],
    },
    {
      key: "invoiceDate",
      label: "Invoice Date",
      conf: 82,
      regexes: [
        /(?:invoice\s*date\s*[:\-]?\s*)(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\.\d{1,2}\.\d{4})/i,
        /(?:date\s*[:\-]\s*)(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\.\d{1,2}\.\d{4})/i,
        /(?:datum\s*[:\-]\s*)(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})/i,  // German
      ],
    },
    {
      key: "shipper",
      label: "Shipper/Exporter",
      conf: 80,
      regexes: [
        /(?:shipper(?:\/exporter)?\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:exporter\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:from\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:absender\s*[:\-]?\s*)(.+?)(?:\n|$)/i,  // German
        /(?:expéditeur\s*[:\-]?\s*)(.+?)(?:\n|$)/i,  // French
      ],
    },
    {
      key: "consignee",
      label: "Consignee/Importer",
      conf: 80,
      regexes: [
        /(?:consignee(?:\/importer)?\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:importer\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:to\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:empfänger\s*[:\-]?\s*)(.+?)(?:\n|$)/i,  // German
        /(?:destinataire\s*[:\-]?\s*)(.+?)(?:\n|$)/i,  // French
      ],
    },
    {
      key: "declaredValue",
      label: "Total Declared Value",
      conf: 88,
      regexes: [
        /(?:total\s*(?:declared\s*)?value\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
        /(?:declared\s*value\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
        /(?:grand\s*total\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
        /(?:invoice\s*total\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
        /(?:total\s*[:\-]?\s*)([$€£¥][\d,]+\.?\d*)/i,  // "Total: $1,000"
        /(?:amount\s*[:\-]?\s*)([$€£¥]?[\d,]+\.?\d*)/i,
        /(?:value\s*[:\-]?\s*)([$€£¥][\d,]+\.?\d*)/i,  // "Value: $1,000" (requires symbol)
        // Bare value on its own line: "$5,000" or "€15,300.00"
        /(?:^|\n)\s*([$€£¥][\d,]+\.?\d*)\s*(?:\n|$)/m,
      ],
    },
    {
      key: "htsCode",
      label: "HTS Code",
      conf: 90,
      regexes: [
        /(?:hts\s*(?:code)?\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i,
        /(?:hts\s*[:\-]\s*)(\d{4}\.\d{2}\.\d{4})/i,
        /(?:hs\s*code\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i,
        /(?:tariff\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i,
        // Bare HTS: "HTS: 8471.30.0100" or "HTS 8471.30.0100"
        /(?:hts\s*[:\-]?\s*)(\d{4}\.\d{2}\.\d{4})/i,
        // From table line items: "8471.30.0100"
        /\b(\d{4}\.\d{2}\.\d{4})\b/,
      ],
    },
    {
      key: "netWeight",
      label: "Net Weight",
      conf: 85,
      regexes: [
        /(?:net\s*weight\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?|g|grams?|oz|ounces?))/i,
        /(?:net\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?))/i,
        /(?:weight\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?))/i,
        /(?:gewicht\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:kg|lbs?))/i,  // German
      ],
    },
    {
      key: "grossWeight",
      label: "Gross Weight",
      conf: 85,
      regexes: [
        /(?:gross\s*weight\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?|g|grams?|oz|ounces?))/i,
        /(?:gross\s*[:\-]?\s*)([\d,]+\.?\d*\s*(?:lbs?|kg|kgs|pounds?|kilograms?))/i,
      ],
    },
    {
      key: "countryOfOrigin",
      label: "Country of Origin",
      conf: 78,
      regexes: [
        /(?:country\s*of\s*origin\s*[:\-]?\s*)([A-Z]{2})/i,
        /(?:origin\s*[:\-]?\s*)([A-Z]{2})\b/i,
        /(?:country\s*[:\-]?\s*)([A-Z]{2})\b/i,
        /(?:herkunft\s*[:\-]?\s*)([A-Z]{2})/i,  // German
      ],
    },
    {
      key: "carrier",
      label: "Carrier",
      conf: 75,
      regexes: [
        /(?:carrier\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:shipping\s*carrier\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
      ],
    },
    {
      key: "portOfEntry",
      label: "Port of Entry",
      conf: 75,
      regexes: [
        /(?:port\s*of\s*entry\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:port\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
      ],
    },
    {
      key: "billOfLading",
      label: "Bill of Lading #",
      conf: 82,
      regexes: [
        /(?:bill\s*of\s*lading\s*(?:#|no\.?)?\s*[:\-]?\s*)([A-Z0-9\-]+)/i,
        /(?:bol\s*(?:#|no\.?)?\s*[:\-]?\s*)([A-Z0-9\-]+)/i,
      ],
    },
    {
      key: "consigneeAddress",
      label: "Consignee Address",
      conf: 72,
      regexes: [
        /(?:consignee\s*address\s*[:\-]?\s*)(.+?)(?:\n|$)/i,
        /(?:address\s*[:\-]?\s*)(\d+.+?(?:\n|$))/i,
      ],
    },
  ];

  // Try each pattern with all its regexes
  for (const { key, label, regexes, conf } of patterns) {
    for (const regex of regexes) {
      const match = fullText.match(regex);
      if (match && match[1]) {
        let value = match[1].trim();

        // UTF-8 normalization for name/address fields
        if (key === "shipper" || key === "consignee" || key === "consigneeAddress" || key === "carrier" || key === "portOfEntry") {
          const normalized = normalizeUtf8(value);
          value = normalized.utf8;
        }

        // Clean up trailing punctuation
        value = value.replace(/[,;]+$/, '').trim();

        if (value.length > 0 && value.length < 200) {
          fields.push({ field_key: key, field_label: label, extracted_value: value, confidence: conf });
          break; // Use first match
        }
      }
    }
  }

  // --- Multi-line table parsing (for line items + totals) ---
  const { lineItems, totalValue } = parseTableRows(fullText);

  // If we found a total value from the table but not from the standard pattern, use it
  if (totalValue && !fields.find(f => f.field_key === "declaredValue")) {
    fields.push({
      field_key: "declaredValue",
      field_label: "Total Declared Value",
      extracted_value: totalValue,
      confidence: 90,
    });
  }

  // If we found line items with HTS codes, use the first valid one
  if (lineItems.length > 0 && !fields.find(f => f.field_key === "htsCode")) {
    const firstWithHts = lineItems.find(li => li.htsCode && /^\d{4}\.\d{2}\.\d{4}$/.test(li.htsCode));
    if (firstWithHts) {
      fields.push({
        field_key: "htsCode",
        field_label: "HTS Code",
        extracted_value: firstWithHts.htsCode,
        confidence: 88,
      });
    }
  }

  // --- Sparse document handling ---
  // If we extracted fewer than 3 fields, try bare-value extraction
  if (fields.length < 3) {
    // Look for bare invoice number (INV-XXX pattern)
    if (!fields.find(f => f.field_key === "invoiceNo")) {
      const invMatch = fullText.match(/\b(INV[\-A-Z0-9]+)\b/i);
      if (invMatch) {
        fields.push({ field_key: "invoiceNo", field_label: "Commercial Invoice #", extracted_value: invMatch[1], confidence: 70 });
      }
    }

    // Look for bare currency value
    if (!fields.find(f => f.field_key === "declaredValue")) {
      const valMatch = fullText.match(/([$€£¥][\d,]+\.?\d*)/);
      if (valMatch) {
        fields.push({ field_key: "declaredValue", field_label: "Total Declared Value", extracted_value: valMatch[1], confidence: 65 });
      }
    }

    // Look for bare HTS code
    if (!fields.find(f => f.field_key === "htsCode")) {
      const htsMatch = fullText.match(/\b(\d{4}\.\d{2}\.\d{4})\b/);
      if (htsMatch) {
        fields.push({ field_key: "htsCode", field_label: "HTS Code", extracted_value: htsMatch[1], confidence: 75 });
      }
    }

    // Look for bare country code (2 uppercase letters on their own line)
    if (!fields.find(f => f.field_key === "countryOfOrigin")) {
      const countryMatch = fullText.match(/(?:^|\n)\s*([A-Z]{2})\s*(?:\n|$)/m);
      if (countryMatch) {
        fields.push({ field_key: "countryOfOrigin", field_label: "Country of Origin", extracted_value: countryMatch[1], confidence: 60 });
      }
    }

    // Look for bare weight
    if (!fields.find(f => f.field_key === "netWeight")) {
      const weightMatch = fullText.match(/(\d[\d,]*\.?\d*\s*(?:lbs?|kg|kgs|pounds?))/i);
      if (weightMatch) {
        fields.push({ field_key: "netWeight", field_label: "Net Weight", extracted_value: weightMatch[1], confidence: 65 });
      }
    }

    // Look for company name (first line that's not a keyword/number)
    if (!fields.find(f => f.field_key === "shipper")) {
      for (const line of lines) {
        const trimmed = line.trim();
        // Skip empty lines, numbers, dates, currency values, keywords
        if (trimmed.length < 3 || trimmed.length > 60) continue;
        if (/^\d/.test(trimmed)) continue;
        if (/[$€£¥]/.test(trimmed)) continue;
        if (/^(invoice|inv|date|shipper|consignee|total|hts|net|gross|country|carrier|port|bill)/i.test(trimmed)) continue;
        if (/^(INV|SHIP|DOC)/i.test(trimmed)) continue;
        // Looks like a company name
        if (/^[A-Z][a-zA-Z\s&.,]+$/.test(trimmed)) {
          fields.push({ field_key: "shipper", field_label: "Shipper/Exporter", extracted_value: trimmed, confidence: 55 });
          break;
        }
      }
    }
  }

  return fields;
}

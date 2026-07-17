// ============================================================================
// P13 — Pure unit tests for the shared regex extractor
// ----------------------------------------------------------------------------
// Exercises src/lib/extraction/regex-extract.ts (a verbatim port of the
// `regexExtract` fallback that ships inside supabase/functions/extract-document).
// Because the edge function is Deno-only, this shared module lets us lock down
// the extraction behavior in a vitest suite — no network, no Gemini, no Deno.
//
// Covers: full commercial invoices, sparse docs, German UTF-8 preservation,
// CSV parsing (header + key-value), and empty/garbage input handling.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  regexExtract,
  parseCSV,
  parseTableRows,
  normalizeUtf8,
  FIELD_DEFINITIONS,
} from '@/lib/extraction/regex-extract';

describe('regex extraction (P13)', () => {
  // =========================================================================
  // 1. Full commercial invoice
  // =========================================================================
  describe('full commercial invoice', () => {
    const cleanInvoice = [
      'COMMERCIAL INVOICE',
      'Invoice Number: INV-2026-001',
      'Invoice Date: 2026-01-15',
      'Shipper: Acme Industries Ltd.',
      'Consignee: Beta Manufacturing Corp',
      'Total Declared Value: $12,500.00',
      'HTS Code: 8471.30.0100',
      'Net Weight: 450 lbs',
      'Gross Weight: 520 lbs',
      'Country of Origin: US',
      'Carrier: FedEx International',
      'Port of Entry: Los Angeles (LAX - 2720)',
    ].join('\n');

    const fields = regexExtract(cleanInvoice);
    const keys = fields.map((f) => f.field_key);

    it('extracts the invoice number', () => {
      expect(keys).toContain('invoiceNo');
      const f = fields.find((x) => x.field_key === 'invoiceNo');
      expect(f?.extracted_value).toBe('INV-2026-001');
    });

    it('extracts the invoice date', () => {
      expect(keys).toContain('invoiceDate');
      const f = fields.find((x) => x.field_key === 'invoiceDate');
      expect(f?.extracted_value).toBe('2026-01-15');
    });

    it('extracts the shipper', () => {
      expect(keys).toContain('shipper');
      const f = fields.find((x) => x.field_key === 'shipper');
      expect(f?.extracted_value).toBe('Acme Industries Ltd.');
    });

    it('extracts the consignee', () => {
      expect(keys).toContain('consignee');
      const f = fields.find((x) => x.field_key === 'consignee');
      expect(f?.extracted_value).toBe('Beta Manufacturing Corp');
    });

    it('extracts the declared value with currency symbol', () => {
      expect(keys).toContain('declaredValue');
      const f = fields.find((x) => x.field_key === 'declaredValue');
      expect(f?.extracted_value).toBe('$12,500.00');
    });

    it('extracts the HTS code', () => {
      expect(keys).toContain('htsCode');
      const f = fields.find((x) => x.field_key === 'htsCode');
      expect(f?.extracted_value).toBe('8471.30.0100');
    });

    it('extracts net weight', () => {
      expect(keys).toContain('netWeight');
      const f = fields.find((x) => x.field_key === 'netWeight');
      expect(f?.extracted_value).toBe('450 lbs');
    });

    it('extracts gross weight', () => {
      expect(keys).toContain('grossWeight');
      const f = fields.find((x) => x.field_key === 'grossWeight');
      expect(f?.extracted_value).toBe('520 lbs');
    });

    it('extracts country of origin (2-letter code)', () => {
      expect(keys).toContain('countryOfOrigin');
      const f = fields.find((x) => x.field_key === 'countryOfOrigin');
      expect(f?.extracted_value).toBe('US');
    });

    it('extracts carrier', () => {
      expect(keys).toContain('carrier');
      const f = fields.find((x) => x.field_key === 'carrier');
      expect(f?.extracted_value).toBe('FedEx International');
    });

    it('extracts port of entry', () => {
      expect(keys).toContain('portOfEntry');
      const f = fields.find((x) => x.field_key === 'portOfEntry');
      expect(f?.extracted_value).toBe('Los Angeles (LAX - 2720)');
    });

    it('extracts at least 11 distinct fields', () => {
      // Sanity: clean invoice has 11 labeled lines (skipping the "COMMERCIAL
      // INVOICE" header which has no field key).
      expect(fields.length).toBeGreaterThanOrEqual(11);
    });

    it('every extracted field has the four required properties', () => {
      for (const f of fields) {
        expect(f).toHaveProperty('field_key');
        expect(f).toHaveProperty('field_label');
        expect(f).toHaveProperty('extracted_value');
        expect(f).toHaveProperty('confidence');
        expect(typeof f.confidence).toBe('number');
        expect(f.confidence).toBeGreaterThanOrEqual(0);
        expect(f.confidence).toBeLessThanOrEqual(100);
      }
    });
  });

  // =========================================================================
  // 2. Sparse document (only bare values, no labels)
  // =========================================================================
  describe('sparse document (bare values, no labels)', () => {
    const sparse = [
      'INV-2026-006',
      'Acme Corp',
      'Beta Inc',
      '$5,000',
      '100 lbs',
      'US',
    ].join('\n');

    const fields = regexExtract(sparse);
    const keys = fields.map((f) => f.field_key);

    it('extracts the bare invoice number via the INV-XXX fallback', () => {
      expect(keys).toContain('invoiceNo');
      const f = fields.find((x) => x.field_key === 'invoiceNo');
      expect(f?.extracted_value).toBe('INV-2026-006');
    });

    it('extracts the bare currency value', () => {
      expect(keys).toContain('declaredValue');
      const f = fields.find((x) => x.field_key === 'declaredValue');
      expect(f?.extracted_value).toBe('$5,000');
    });

    it('extracts the bare country code', () => {
      expect(keys).toContain('countryOfOrigin');
      const f = fields.find((x) => x.field_key === 'countryOfOrigin');
      expect(f?.extracted_value).toBe('US');
    });

    it('extracts the bare weight', () => {
      expect(keys).toContain('netWeight');
      const f = fields.find((x) => x.field_key === 'netWeight');
      expect(f?.extracted_value).toBe('100 lbs');
    });

    it('falls back to "looks like a company name" for shipper', () => {
      expect(keys).toContain('shipper');
      const f = fields.find((x) => x.field_key === 'shipper');
      expect(f?.extracted_value).toBe('Acme Corp');
    });

    it('extracts at least 4 fields despite the sparse input', () => {
      expect(fields.length).toBeGreaterThanOrEqual(4);
    });
  });

  // =========================================================================
  // 3. German document — UTF-8 foreign characters preserved
  // =========================================================================
  describe('German document with umlauts', () => {
    const german = [
      'HANDELSRECHNUNG',
      'Invoice Number: INV-2026-004',
      'Invoice Date: 2026-04-10',
      'Shipper: Präzisions GmbH',
      'Consignee: Midwest Machinery Works',
      'Consignee Address: Industriestraße 14, 80331 München, DE',
      'Total Declared Value: €28,900.00',
      'HTS Code: 8480.71.8010',
      'Net Weight: 2,500 kg',
      'Gross Weight: 2,800 kg',
      'Country of Origin: DE',
      'Carrier: Lufthansa Cargo',
    ].join('\n');

    const fields = regexExtract(german);

    it('preserves "ä" in shipper name "Präzisions GmbH"', () => {
      const f = fields.find((x) => x.field_key === 'shipper');
      expect(f?.extracted_value).toBe('Präzisions GmbH');
    });

    it('preserves "ß" and "ü" in consignee address', () => {
      const f = fields.find((x) => x.field_key === 'consigneeAddress');
      expect(f?.extracted_value).toBe('Industriestraße 14, 80331 München, DE');
    });

    it('extracts EUR declared value', () => {
      const f = fields.find((x) => x.field_key === 'declaredValue');
      expect(f?.extracted_value).toBe('€28,900.00');
    });

    it('extracts HTS code', () => {
      const f = fields.find((x) => x.field_key === 'htsCode');
      expect(f?.extracted_value).toBe('8480.71.8010');
    });

    it('extracts net weight in kg', () => {
      const f = fields.find((x) => x.field_key === 'netWeight');
      expect(f?.extracted_value).toBe('2,500 kg');
    });

    it('extracts gross weight in kg', () => {
      const f = fields.find((x) => x.field_key === 'grossWeight');
      expect(f?.extracted_value).toBe('2,800 kg');
    });

    it('extracts country of origin DE', () => {
      const f = fields.find((x) => x.field_key === 'countryOfOrigin');
      expect(f?.extracted_value).toBe('DE');
    });
  });

  // =========================================================================
  // 4. CSV-format document — header-based parsing path
  // =========================================================================
  describe('CSV (header-based)', () => {
    const csv = [
      'Invoice Number,Shipper,Consignee,Total,HTS Code',
      'INV-2026-CSV-1,Acme Industries,Beta Corp,$5250.00,8471.30.0100',
    ].join('\n');

    const fields = regexExtract(csv);
    const keys = fields.map((f) => f.field_key);

    it('parses all 5 columns', () => {
      expect(fields.length).toBe(5);
    });

    it('maps "Invoice Number" → invoiceNo', () => {
      expect(keys).toContain('invoiceNo');
      const f = fields.find((x) => x.field_key === 'invoiceNo');
      expect(f?.extracted_value).toBe('INV-2026-CSV-1');
    });

    it('maps "Shipper" → shipper', () => {
      expect(keys).toContain('shipper');
      const f = fields.find((x) => x.field_key === 'shipper');
      expect(f?.extracted_value).toBe('Acme Industries');
    });

    it('maps "Total" → declaredValue', () => {
      expect(keys).toContain('declaredValue');
      const f = fields.find((x) => x.field_key === 'declaredValue');
      expect(f?.extracted_value).toBe('$5250.00');
    });

    it('maps "HTS Code" → htsCode', () => {
      expect(keys).toContain('htsCode');
      const f = fields.find((x) => x.field_key === 'htsCode');
      expect(f?.extracted_value).toBe('8471.30.0100');
    });

    it('uses confidence=85 for CSV-sourced fields', () => {
      for (const f of fields) {
        expect(f.confidence).toBe(85);
      }
    });
  });

  // =========================================================================
  // 4b. CSV-format document — key-value parsing path
  // --------------------------------------------------------------------------
  // parseCSV only takes the key-value branch when the FIRST line has no
  // recognizable header column (otherwise it treats lines[0] as headers and
  // lines[1] as the single data row). We use a "Foo,Bar" first line to force
  // the key-value branch.
  // =========================================================================
  describe('CSV (key-value)', () => {
    const csv = [
      'Foo,Bar',
      'InvoiceNumber,INV-2026-KV-9',
      'Shipper,Global Traders LLC',
      'Total,$9999.99',
    ].join('\n');

    const fields = regexExtract(csv);
    const keys = fields.map((f) => f.field_key);

    it('parses 3 key-value rows (skips the non-matching Foo,Bar header)', () => {
      expect(fields.length).toBe(3);
    });

    it('extracts invoiceNo from the second row', () => {
      expect(keys).toContain('invoiceNo');
      const f = fields.find((x) => x.field_key === 'invoiceNo');
      expect(f?.extracted_value).toBe('INV-2026-KV-9');
    });

    it('extracts shipper', () => {
      expect(keys).toContain('shipper');
      const f = fields.find((x) => x.field_key === 'shipper');
      expect(f?.extracted_value).toBe('Global Traders LLC');
    });

    it('extracts declaredValue', () => {
      expect(keys).toContain('declaredValue');
      const f = fields.find((x) => x.field_key === 'declaredValue');
      expect(f?.extracted_value).toBe('$9999.99');
    });

    it('uses confidence=80 for key-value CSV fields', () => {
      for (const f of fields) {
        expect(f.confidence).toBe(80);
      }
    });
  });

  // =========================================================================
  // 5. Empty / garbage input — never crashes
  // =========================================================================
  describe('empty / garbage input', () => {
    it('returns [] for empty string', () => {
      expect(regexExtract('')).toEqual([]);
    });

    it('returns [] for null', () => {
      expect(regexExtract(null as unknown as string)).toEqual([]);
    });

    it('returns [] for undefined', () => {
      expect(regexExtract(undefined as unknown as string)).toEqual([]);
    });

    it('returns [] (or a small set) for pure garbage with no recognizable patterns', () => {
      const garbage = '!!! random text with no patterns 12345 !!!';
      const fields = regexExtract(garbage);
      // We don't strictly require zero fields, but the result should never
      // crash and never include hallucinated structured data.
      expect(Array.isArray(fields)).toBe(true);
      // This particular garbage string has no extractable patterns:
      expect(fields.length).toBe(0);
    });

    it('handles a single-line invoice number with no other context', () => {
      // The bare INV-XXX pattern is `INV[\-\d]+` (digits + hyphens only),
      // so we use a digits-only invoice number here.
      const fields = regexExtract('INV-2026-007');
      const f = fields.find((x) => x.field_key === 'invoiceNo');
      expect(f?.extracted_value).toBe('INV-2026-007');
    });

    it('never throws on binary-ish / control-char input', () => {
      const weird = '\x00\x01\x02\n\x03\x04\r\n\t\t';
      expect(() => regexExtract(weird)).not.toThrow();
    });
  });

  // =========================================================================
  // Exposed helpers
  // =========================================================================
  describe('exposed helpers', () => {
    describe('parseCSV', () => {
      it('returns [] for empty input', () => {
        expect(parseCSV('')).toEqual([]);
      });

      it('returns [] when no headers match known field keys', () => {
        expect(parseCSV('foo,bar\nbaz,qux')).toEqual([]);
      });

      it('detects tab delimiter', () => {
        const csv = 'Invoice Number\tTotal\nINV-001\t$100.00';
        const fields = parseCSV(csv);
        expect(fields.length).toBe(2);
        expect(fields.find((f) => f.field_key === 'invoiceNo')?.extracted_value).toBe('INV-001');
      });

      it('detects semicolon delimiter', () => {
        const csv = 'Invoice Number;Total\nINV-001;$100.00';
        const fields = parseCSV(csv);
        expect(fields.length).toBe(2);
      });

      it('strips surrounding quotes from values', () => {
        const csv = 'Invoice Number,Total\n"INV-001","$100.00"';
        const fields = parseCSV(csv);
        const inv = fields.find((f) => f.field_key === 'invoiceNo');
        expect(inv?.extracted_value).toBe('INV-001');
      });
    });

    describe('parseTableRows', () => {
      it('returns no line items for plain prose', () => {
        const result = parseTableRows('just some text\nno table here');
        expect(result.lineItems).toEqual([]);
        expect(result.totalValue).toBeNull();
      });

      it('extracts a total line', () => {
        const result = parseTableRows('Total: $5,250.00');
        expect(result.totalValue).toBe('$5,250.00');
      });

      it('extracts "Grand Total" line', () => {
        const result = parseTableRows('Grand Total: $1,234.56');
        expect(result.totalValue).toBe('$1,234.56');
      });

      it('extracts a line item with description, qty, hts, value', () => {
        const text = 'Widgets 10 8471.30.0100 $5,250.00';
        const result = parseTableRows(text);
        expect(result.lineItems.length).toBe(1);
        const li = result.lineItems[0];
        expect(li.description).toBe('Widgets');
        expect(li.qty).toBe(10);
        expect(li.htsCode).toBe('8471.30.0100');
        expect(li.value).toBe('$5,250.00');
      });

      it('groups secondary lines (shipping/insurance) with the preceding item', () => {
        const text = [
          'Widgets 10 8471.30.0100 $5,250.00',
          'Shipping Cost: $50.00',
          'Insurance: $25.00',
        ].join('\n');
        const result = parseTableRows(text);
        expect(result.lineItems.length).toBe(1);
        expect(result.lineItems[0].secondaryLines.length).toBe(2);
      });
    });

    describe('normalizeUtf8', () => {
      it('returns both utf8 (preserved) and ascii (folded)', () => {
        const r = normalizeUtf8('Präzisions Straße');
        expect(r.utf8).toBe('Präzisions Straße');
        // ä → ae, ß → ss
        expect(r.ascii).toBe('Praezisions Strasse');
      });

      it('folds French accents to plain ASCII', () => {
        const r = normalizeUtf8('café résumé');
        expect(r.ascii).toBe('cafe resume');
      });

      it('folds Spanish ñ', () => {
        const r = normalizeUtf8('España');
        expect(r.ascii).toBe('Espana');
      });

      it('strips non-ASCII chars that have no fold rule', () => {
        const r = normalizeUtf8('日本 Tokyo');
        // "日本" gets stripped by the [^\x00-\x7F] fallthrough.
        expect(r.ascii).toBe('Tokyo');
      });

      it('trims surrounding whitespace', () => {
        const r = normalizeUtf8('  hello  ');
        expect(r.utf8).toBe('hello');
      });
    });

    describe('FIELD_DEFINITIONS', () => {
      it('defines all the field keys used by the extractor', () => {
        const keys = FIELD_DEFINITIONS.map((d) => d.key);
        for (const expected of [
          'invoiceNo',
          'invoiceDate',
          'shipper',
          'consignee',
          'consigneeAddress',
          'declaredValue',
          'htsCode',
          'netWeight',
          'grossWeight',
          'portOfEntry',
          'carrier',
          'billOfLading',
          'countryOfOrigin',
        ]) {
          expect(keys).toContain(expected);
        }
      });

      it('every definition has a non-empty label', () => {
        for (const def of FIELD_DEFINITIONS) {
          expect(def.key.length).toBeGreaterThan(0);
          expect(def.label.length).toBeGreaterThan(0);
        }
      });
    });
  });
});

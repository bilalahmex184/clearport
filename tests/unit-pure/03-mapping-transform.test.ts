// ============================================================================
// P13 — Pure unit tests for the broker template transform interpreter
// ----------------------------------------------------------------------------
// Exercises src/lib/mapping/transform.ts: applyTransform + applyTransforms.
// These transforms run during CSV/Excel import+export through broker
// templates, so a regression here silently corrupts every mapped field.
//
// No network, no Supabase — pure string functions.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  applyTransform,
  applyTransforms,
  type TransformConfig,
} from '@/lib/mapping/transform';

describe('mapping/transform (P13)', () => {
  // =========================================================================
  // applyTransform — no-op / null guards
  // =========================================================================
  describe('null / null-transform guards', () => {
    it('returns original value when transform is null', () => {
      expect(applyTransform('hello', null)).toBe('hello');
    });

    it('returns original value when transform is undefined', () => {
      expect(applyTransform('hello', undefined)).toBe('hello');
    });

    it('returns original value when transform has no type', () => {
      expect(applyTransform('hello', { foo: 'bar' } as any)).toBe('hello');
    });

    it('returns "" for null input value', () => {
      expect(applyTransform(null as any, { type: 'uppercase' })).toBe('');
    });

    it('returns "" for undefined input value', () => {
      expect(applyTransform(undefined as any, { type: 'uppercase' })).toBe('');
    });

    it('returns original value for unknown transform type (default branch)', () => {
      expect(
        applyTransform('hello', { type: 'nonexistent_transform' as any }),
      ).toBe('hello');
    });
  });

  // =========================================================================
  // date_format
  // =========================================================================
  describe('date_format', () => {
    it('converts YYYY-MM-DD → MM/DD/YYYY', () => {
      const t: TransformConfig = {
        type: 'date_format',
        from: 'YYYY-MM-DD',
        to: 'MM/DD/YYYY',
      };
      expect(applyTransform('2026-01-15', t)).toBe('01/15/2026');
    });

    it('converts MM/DD/YYYY → YYYY-MM-DD', () => {
      const t: TransformConfig = {
        type: 'date_format',
        from: 'MM/DD/YYYY',
        to: 'YYYY-MM-DD',
      };
      expect(applyTransform('01/15/2026', t)).toBe('2026-01-15');
    });

    it('converts DD.MM.YYYY → YYYY-MM-DD (European → ISO)', () => {
      const t: TransformConfig = {
        type: 'date_format',
        from: 'DD.MM.YYYY',
        to: 'YYYY-MM-DD',
      };
      expect(applyTransform('15.01.2026', t)).toBe('2026-01-15');
    });

    it('returns original value when source format does not match', () => {
      const t: TransformConfig = {
        type: 'date_format',
        from: 'YYYY-MM-DD',
        to: 'MM/DD/YYYY',
      };
      expect(applyTransform('not-a-date', t)).toBe('not-a-date');
    });

    it('uses default from=YYYY-MM-DD to=MM/DD/YYYY when not specified', () => {
      const t: TransformConfig = { type: 'date_format' };
      expect(applyTransform('2026-01-15', t)).toBe('01/15/2026');
    });
  });

  // =========================================================================
  // round
  // =========================================================================
  describe('round', () => {
    it('rounds a plain numeric string to 2 decimals (default)', () => {
      expect(applyTransform('3.14159', { type: 'round' })).toBe('3.14');
    });

    it('rounds to 0 decimals when decimals=0', () => {
      expect(applyTransform('3.14159', { type: 'round', decimals: 0 })).toBe('3');
    });

    it('strips currency symbols and commas before rounding', () => {
      expect(
        applyTransform('$1,234.567', { type: 'round', decimals: 1 }),
      ).toBe('1234.6');
    });

    it('preserves negative numbers', () => {
      expect(applyTransform('-42.678', { type: 'round', decimals: 1 })).toBe(
        '-42.7',
      );
    });

    it('returns original value when input is non-numeric', () => {
      expect(applyTransform('abc', { type: 'round' })).toBe('abc');
    });
  });

  // =========================================================================
  // concat
  // =========================================================================
  describe('concat', () => {
    it('prepends prefix and appends suffix', () => {
      const t: TransformConfig = {
        type: 'concat',
        prefix: 'PRE-',
        suffix: '-POST',
      };
      expect(applyTransform('mid', t)).toBe('PRE-mid-POST');
    });

    it('with empty prefix/suffix returns original', () => {
      const t: TransformConfig = { type: 'concat' };
      expect(applyTransform('mid', t)).toBe('mid');
    });

    it('only prefix when suffix omitted', () => {
      const t: TransformConfig = { type: 'concat', prefix: 'P-' };
      expect(applyTransform('mid', t)).toBe('P-mid');
    });
  });

  // =========================================================================
  // lookup_table
  // =========================================================================
  describe('lookup_table', () => {
    it('maps a known key (case-insensitive, trimmed)', () => {
      const t: TransformConfig = {
        type: 'lookup_table',
        table: { us: 'United States', de: 'Germany' },
      };
      expect(applyTransform('  US ', t)).toBe('United States');
    });

    it('returns original value for unknown key', () => {
      const t: TransformConfig = {
        type: 'lookup_table',
        table: { us: 'United States' },
      };
      expect(applyTransform('FR', t)).toBe('FR');
    });

    it('falls back to original-case exact match if normalized lookup misses', () => {
      const t: TransformConfig = {
        type: 'lookup_table',
        table: { FR: 'France' }, // key only matches exact "FR"
      };
      // "fr" normalizes to "fr" which isn't a key; "fr" original isn't a key
      // either, so falls back to original value.
      expect(applyTransform('fr', t)).toBe('fr');
      // "FR" original is a key → mapped.
      expect(applyTransform('FR', t)).toBe('France');
    });
  });

  // =========================================================================
  // currency_convert
  // =========================================================================
  describe('currency_convert', () => {
    it('strips existing symbol and prefixes target symbol (USD)', () => {
      const t: TransformConfig = { type: 'currency_convert', to: 'USD' };
      expect(applyTransform('€1,234.56', t)).toBe('$1,234.56');
    });

    it('prefixes € for EUR target', () => {
      const t: TransformConfig = { type: 'currency_convert', to: 'EUR' };
      expect(applyTransform('$100', t)).toBe('€100');
    });

    it('prefixes £ for GBP target', () => {
      const t: TransformConfig = { type: 'currency_convert', to: 'GBP' };
      expect(applyTransform('$100', t)).toBe('£100');
    });

    it('prefixes ¥ for JPY target', () => {
      const t: TransformConfig = { type: 'currency_convert', to: 'JPY' };
      expect(applyTransform('$100', t)).toBe('¥100');
    });

    it('falls back to $ when target currency unknown', () => {
      const t: TransformConfig = { type: 'currency_convert', to: 'XYZ' };
      expect(applyTransform('$100', t)).toBe('$100');
    });
  });

  // =========================================================================
  // uppercase / lowercase / trim
  // =========================================================================
  describe('uppercase / lowercase / trim', () => {
    it('uppercase: converts to upper case', () => {
      expect(applyTransform('hello World', { type: 'uppercase' })).toBe(
        'HELLO WORLD',
      );
    });

    it('lowercase: converts to lower case', () => {
      expect(applyTransform('Hello WORLD', { type: 'lowercase' })).toBe(
        'hello world',
      );
    });

    it('trim: strips whitespace from both ends', () => {
      expect(applyTransform('  hello  ', { type: 'trim' })).toBe('hello');
    });
  });

  // =========================================================================
  // applyTransforms — chained
  // =========================================================================
  describe('applyTransforms (chained)', () => {
    it('applies multiple transforms in order', () => {
      const transforms: TransformConfig[] = [
        { type: 'trim' },
        { type: 'uppercase' },
        { type: 'concat', prefix: '[', suffix: ']' },
      ];
      expect(applyTransforms('  hello  ', transforms)).toBe('[HELLO]');
    });

    it('returns original value when transforms is null', () => {
      expect(applyTransforms('hello', null)).toBe('hello');
    });

    it('returns original value when transforms is undefined', () => {
      expect(applyTransforms('hello', undefined)).toBe('hello');
    });

    it('returns original value when transforms is not an array', () => {
      expect(applyTransforms('hello', { type: 'uppercase' } as any)).toBe(
        'hello',
      );
    });

    it('returns original value for empty transforms array', () => {
      expect(applyTransforms('hello', [])).toBe('hello');
    });

    it('chain: round then currency_convert', () => {
      const transforms: TransformConfig[] = [
        { type: 'round', decimals: 2 },
        { type: 'currency_convert', to: 'USD' },
      ];
      // "$1,234.5678" → round → "1234.57" → currency_convert → "$1234.57"
      expect(applyTransforms('$1,234.5678', transforms)).toBe('$1234.57');
    });
  });

  // =========================================================================
  // Failure isolation: a throwing transform should fall back to original
  // =========================================================================
  describe('failure isolation', () => {
    it('returns original value when a transform throws (caught)', () => {
      // Build a transform that throws inside its handler. We force a throw
      // by giving lookup_table a `table` whose `[]` lookup throws.
      const t: TransformConfig = {
        type: 'lookup_table',
        // A Proxy that throws on property access — forces the catch branch.
        get table() {
          throw new Error('boom');
        },
      } as any;
      // The try/catch in applyTransform should swallow the throw and return
      // the original value.
      expect(applyTransform('hello', t)).toBe('hello');
    });
  });
});

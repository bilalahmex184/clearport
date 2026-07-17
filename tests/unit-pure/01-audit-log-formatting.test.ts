// ============================================================================
// P13 — Pure unit tests for audit-log message formatting
// ----------------------------------------------------------------------------
// These tests exercise the message-formatting logic embedded inside
// src/lib/services/audit-log.service.ts WITHOUT touching a real Supabase
// project. They use a tiny mock client that records `.from(table).insert(row)`
// calls so we can assert on the produced `text` field.
//
// Why this matters: the previous signature of `logRulesUpdate` accepted
// threshold-only fields ({invoiceThreshold, htsThreshold, partiesThreshold})
// which didn't match any of the actual call sites in
// /api/rules/validation/* — those pass {action, ruleName, ruleType, ruleId,
// changes}. The bug shipped undetected because there was no isolated test of
// the message format. The `logRulesUpdate` tests below would have caught it:
// they pass the call-site shape and assert that the rule name + action appear
// in the produced text.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  logRulesUpdate,
  logExport,
  logResolve,
  logUpload,
  logExtraction,
  logDelete,
} from '@/lib/services/audit-log.service';

// ---------------------------------------------------------------------------
// Mock Supabase client — records every `.from(t).insert(r)` call.
// Returns `{ error: null }` so the audit-log service treats the insert as
// successful and never falls into its `logger.warn` branch.
// ---------------------------------------------------------------------------
interface RecordedInsert {
  table: string;
  row: Record<string, unknown>;
}

function createMockClient() {
  const inserts: RecordedInsert[] = [];
  const mockClient = {
    from: (table: string) => ({
      insert: (row: any) => {
        inserts.push({ table, row });
        return Promise.resolve({ error: null });
      },
    }),
  };
  return { client: mockClient as any, inserts };
}

// Helper: find the single audit_logs insert recorded by a call.
function auditText(inserts: RecordedInsert[]): string {
  const auditInserts = inserts.filter((i) => i.table === 'audit_logs');
  if (auditInserts.length !== 1) {
    throw new Error(
      `expected exactly 1 audit_logs insert, got ${auditInserts.length} (total inserts: ${inserts.length})`,
    );
  }
  return String(auditInserts[0].row.text ?? '');
}

describe('audit-log message formatting (P13)', () => {
  // =========================================================================
  // logRulesUpdate — would have caught the Prompt 2 signature-mismatch bug
  // =========================================================================
  describe('logRulesUpdate', () => {
    it('action=created → text contains "created" and the rule name', async () => {
      const { client, inserts } = createMockClient();
      await logRulesUpdate(client, 'user@test.com', {
        action: 'created',
        ruleName: 'My Rule',
        ruleType: 'confidence_threshold',
      });

      const text = auditText(inserts);
      expect(text).toContain('created');
      expect(text).toContain('My Rule');
      expect(text).toContain('confidence_threshold');
      expect(text).toContain('user@test.com');
      // Sanity: structured prefix tag should always be present.
      expect(text.startsWith('[rules]')).toBe(true);
    });

    it('action=updated → text contains "updated" and "changes="', async () => {
      const { client, inserts } = createMockClient();
      await logRulesUpdate(client, 'admin@clearport.corp', {
        action: 'updated',
        ruleId: 'abc-123',
        ruleName: 'HTS confidence check',
        ruleType: 'confidence_threshold',
        changes: { severity: 'block', min_confidence: 90 },
      });

      const text = auditText(inserts);
      expect(text).toContain('updated');
      expect(text).toContain('changes=');
      expect(text).toContain('abc-123');
      expect(text).toContain('severity');
      expect(text).toContain('block');
    });

    it('action=deleted → text contains "deleted" and "id="', async () => {
      const { client, inserts } = createMockClient();
      await logRulesUpdate(client, 'admin@clearport.corp', {
        action: 'deleted',
        ruleId: 'abc-123',
      });

      const text = auditText(inserts);
      expect(text).toContain('deleted');
      expect(text).toContain('id=abc-123');
    });

    it('rejects the legacy threshold-only signature shape (regression guard)', async () => {
      // The PREVIOUS (buggy) signature accepted
      //   { invoiceThreshold, htsThreshold, partiesThreshold }
      // and silently ignored them — producing an empty `()` body. This test
      // asserts the CURRENT signature honors the call-site shape by checking
      // that supplying `ruleName` actually surfaces in the text. If a future
      // refactor reverts to the threshold-only signature, `ruleName` won't
      // appear and this test will fail.
      const { client, inserts } = createMockClient();
      // @ts-expect-error — intentionally exercise the new-shape contract
      await logRulesUpdate(client, 'u@x.com', {
        action: 'created',
        ruleName: 'Regression Guard Rule',
        ruleType: 'regex_format',
      });

      const text = auditText(inserts);
      expect(text).toContain('Regression Guard Rule');
      expect(text).not.toMatch(/\(\s*\)/); // no empty parens body
    });
  });

  // =========================================================================
  // logExport
  // =========================================================================
  describe('logExport', () => {
    it('text contains "exported" and the format', async () => {
      const { client, inserts } = createMockClient();
      await logExport(client, 'user@test.com', 'SHIP-2026-001', 'CSV');

      const text = auditText(inserts);
      expect(text).toContain('exported');
      expect(text).toContain('CSV');
      expect(text).toContain('SHIP-2026-001');
      expect(text.startsWith('[export]')).toBe(true);
    });

    it('preserves JSON format string', async () => {
      const { client, inserts } = createMockClient();
      await logExport(client, 'user@test.com', 'SHIP-2026-002', 'JSON');

      const text = auditText(inserts);
      expect(text).toContain('JSON');
    });
  });

  // =========================================================================
  // logResolve
  // =========================================================================
  describe('logResolve', () => {
    it('action=Corrected → text contains old and new values', async () => {
      const { client, inserts } = createMockClient();
      await logResolve(
        client,
        'anon-abc123',
        'SHIP-2026-001',
        'netWeight',
        'Corrected',
        '12,450 lbs',
        '14,250 lbs',
      );

      const text = auditText(inserts);
      expect(text).toContain('Corrected');
      expect(text).toContain('12,450 lbs');
      expect(text).toContain('14,250 lbs');
      expect(text).toContain('netWeight');
      expect(text.startsWith('[resolve]')).toBe(true);
    });

    it('action=Accepted → text contains "Accepted"', async () => {
      const { client, inserts } = createMockClient();
      await logResolve(
        client,
        'anon-abc123',
        'SHIP-2026-001',
        'htsCode',
        'Accepted',
      );

      const text = auditText(inserts);
      expect(text).toContain('Accepted');
      expect(text).toContain('htsCode');
      expect(text.startsWith('[resolve]')).toBe(true);
    });

    it('action=Rejected → text contains "Rejected"', async () => {
      const { client, inserts } = createMockClient();
      await logResolve(
        client,
        'anon-abc123',
        'SHIP-2026-001',
        'declaredValue',
        'Rejected',
      );

      const text = auditText(inserts);
      expect(text).toContain('Rejected');
      expect(text).toContain('declaredValue');
    });
  });

  // =========================================================================
  // logUpload
  // =========================================================================
  describe('logUpload', () => {
    it('text contains file name and a human-readable size', async () => {
      const { client, inserts } = createMockClient();
      await logUpload(client, 'anon-abc123', 'SHIP-2026-001', 'invoice.pdf', 126976);

      const text = auditText(inserts);
      expect(text).toContain('invoice.pdf');
      expect(text).toContain('SHIP-2026-001');
      // 126976 bytes = 124.0KB after the formatFileSize helper (toFixed(1)).
      expect(text).toMatch(/\d+(\.\d+)?(B|KB|MB)/);
      expect(text).toContain('124.0KB');
      expect(text.startsWith('[upload]')).toBe(true);
    });

    it('formats small files as plain bytes', async () => {
      const { client, inserts } = createMockClient();
      await logUpload(client, 'anon-abc123', 'SHIP-2026-001', 'tiny.txt', 512);

      const text = auditText(inserts);
      expect(text).toContain('512B');
    });
  });

  // =========================================================================
  // logExtraction
  // =========================================================================
  describe('logExtraction', () => {
    it('text contains field count and model', async () => {
      const { client, inserts } = createMockClient();
      await logExtraction(
        client,
        'anon-abc123',
        'SHIP-2026-001',
        8,
        'gemini-2.5-pro',
      );

      const text = auditText(inserts);
      expect(text).toContain('8');
      expect(text).toContain('gemini-2.5-pro');
      expect(text).toContain('fields'); // "extracted 8 fields"
      expect(text.startsWith('[extract]')).toBe(true);
    });

    it('uses singular "field" when count is 1', async () => {
      const { client, inserts } = createMockClient();
      await logExtraction(client, null, 'SHIP-2026-009', 1, 'gemini-2.5-flash');

      const text = auditText(inserts);
      // "extracted 1 field" (singular)
      expect(text).toMatch(/extracted 1 field\b/);
      expect(text).not.toMatch(/extracted 1 fields/);
    });
  });

  // =========================================================================
  // logDelete
  // =========================================================================
  describe('logDelete', () => {
    it('text contains shipment ID', async () => {
      const { client, inserts } = createMockClient();
      await logDelete(client, 'admin@clearport.corp', 'SHIP-2026-001');

      const text = auditText(inserts);
      expect(text).toContain('deleted');
      expect(text).toContain('SHIP-2026-001');
      expect(text).toContain('admin@clearport.corp');
      expect(text.startsWith('[delete]')).toBe(true);
    });
  });

  // =========================================================================
  // Cross-cutting: every helper writes exactly one audit_logs insert
  // =========================================================================
  describe('insert contract', () => {
    it('every helper writes a single audit_logs row with type+timestamp', async () => {
      const { client, inserts } = createMockClient();
      await logUpload(client, 'u', 'S1', 'a.pdf', 10);
      await logExport(client, 'u', 'S1', 'CSV');
      await logDelete(client, 'u', 'S1');
      await logExtraction(client, 'u', 'S1', 3, 'm');
      await logResolve(client, 'u', 'S1', 'f', 'Accepted');
      await logRulesUpdate(client, 'u', { action: 'created', ruleName: 'R' });

      expect(inserts.length).toBe(6);
      for (const ins of inserts) {
        expect(ins.table).toBe('audit_logs');
        expect(ins.row.text).toEqual(expect.any(String));
        expect(ins.row.type).toEqual(expect.any(String));
        expect(ins.row.timestamp).toEqual(expect.any(String));
        expect(ins.row.id).toEqual(expect.any(String));
      }
    });
  });
});

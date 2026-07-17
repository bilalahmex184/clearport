// ============================================================================
// P13 — Pure unit tests for Zod shipment validators
// ----------------------------------------------------------------------------
// Locks down the createShipmentSchema and updateShipmentSchema contracts.
// These schemas are the single source of truth for inbound shipment payloads
// shared by every /api/shipments route handler, so a regression here would
// silently let bad data into Postgres.
//
// No network, no Supabase, no env vars — pure Zod parsing.
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  createShipmentSchema,
  updateShipmentSchema,
} from '@/lib/validators/shipment.validator';

describe('shipment.validator (P13)', () => {
  // =========================================================================
  // createShipmentSchema
  // =========================================================================
  describe('createShipmentSchema', () => {
    it('accepts a valid minimal shipment payload', () => {
      const parsed = createShipmentSchema.safeParse({
        shipper: 'Acme Industries Ltd.',
        consignee: 'Beta Manufacturing Corp',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        // Defaults applied
        expect(parsed.data.docsCount).toBe(0);
        expect(parsed.data.urgency).toBe('PENDING');
      }
    });

    it('accepts a full payload with all fields', () => {
      const parsed = createShipmentSchema.safeParse({
        shipper: 'Acme',
        consignee: 'Beta',
        docsCount: 5,
        urgency: '01:42:15',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.docsCount).toBe(5);
        expect(parsed.data.urgency).toBe('01:42:15');
      }
    });

    it('rejects missing required shipper field', () => {
      const parsed = createShipmentSchema.safeParse({
        consignee: 'Beta',
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.path.join('.'));
        expect(issues).toContain('shipper');
      }
    });

    it('rejects missing required consignee field', () => {
      const parsed = createShipmentSchema.safeParse({
        shipper: 'Acme',
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => i.path.join('.'));
        expect(issues).toContain('consignee');
      }
    });

    it('rejects empty-string shipper', () => {
      const parsed = createShipmentSchema.safeParse({
        shipper: '',
        consignee: 'Beta',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects negative docsCount', () => {
      const parsed = createShipmentSchema.safeParse({
        shipper: 'Acme',
        consignee: 'Beta',
        docsCount: -1,
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects docsCount above 100', () => {
      const parsed = createShipmentSchema.safeParse({
        shipper: 'Acme',
        consignee: 'Beta',
        docsCount: 101,
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects non-integer docsCount', () => {
      const parsed = createShipmentSchema.safeParse({
        shipper: 'Acme',
        consignee: 'Beta',
        docsCount: 1.5,
      });
      expect(parsed.success).toBe(false);
    });
  });

  // =========================================================================
  // updateShipmentSchema — status enum
  // =========================================================================
  describe('updateShipmentSchema — status', () => {
    it.each(['Under Review', 'Approved', 'Exported'])(
      'accepts status="%s"',
      (status) => {
        const parsed = updateShipmentSchema.safeParse({ status });
        expect(parsed.success).toBe(true);
      },
    );

    it('rejects invalid status', () => {
      const parsed = updateShipmentSchema.safeParse({ status: 'Random Status' });
      expect(parsed.success).toBe(false);
    });

    it('rejects empty-string status', () => {
      const parsed = updateShipmentSchema.safeParse({ status: '' });
      expect(parsed.success).toBe(false);
    });

    it('accepts omitted status (optional)', () => {
      const parsed = updateShipmentSchema.safeParse({ urgency: 'PENDING' });
      expect(parsed.success).toBe(true);
    });
  });

  // =========================================================================
  // updateShipmentSchema — validation_status enum
  // =========================================================================
  describe('updateShipmentSchema — validation_status', () => {
    it.each(['pending', 'running', 'completed', 'failed', 'degraded'])(
      'accepts validation_status="%s"',
      (validation_status) => {
        const parsed = updateShipmentSchema.safeParse({ validation_status });
        expect(parsed.success).toBe(true);
      },
    );

    it('rejects invalid validation_status', () => {
      const parsed = updateShipmentSchema.safeParse({
        validation_status: 'invalid_state',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects capitalized "Pending" (enum is lowercase)', () => {
      const parsed = updateShipmentSchema.safeParse({
        validation_status: 'Pending',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects "succeeded" (not in enum)', () => {
      const parsed = updateShipmentSchema.safeParse({
        validation_status: 'succeeded',
      });
      expect(parsed.success).toBe(false);
    });
  });

  // =========================================================================
  // updateShipmentSchema — optional fields
  // =========================================================================
  describe('updateShipmentSchema — optional fields', () => {
    it('accepts empty object (everything optional)', () => {
      const parsed = updateShipmentSchema.safeParse({});
      expect(parsed.success).toBe(true);
    });

    it('accepts shipper + consignee patch', () => {
      const parsed = updateShipmentSchema.safeParse({
        shipper: 'New Shipper',
        consignee: 'New Consignee',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects empty-string shipper (min(1) on optional too)', () => {
      const parsed = updateShipmentSchema.safeParse({ shipper: '' });
      expect(parsed.success).toBe(false);
    });

    it('accepts last_validated_at as ISO string', () => {
      const parsed = updateShipmentSchema.safeParse({
        last_validated_at: '2026-01-15T10:30:00Z',
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts pipeline_trace_id', () => {
      const parsed = updateShipmentSchema.safeParse({
        pipeline_trace_id: 'trace-abc-123',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects urgency string longer than 50 chars', () => {
      const parsed = updateShipmentSchema.safeParse({
        urgency: 'x'.repeat(51),
      });
      expect(parsed.success).toBe(false);
    });
  });
});

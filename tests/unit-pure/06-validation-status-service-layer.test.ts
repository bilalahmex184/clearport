// ============================================================================
// 06-validation-status-service-layer.test.ts
// ============================================================================
// REGRESSION TEST for the validation_status silent-drop bug.
//
// This test calls the REAL updateShipment() function in
// src/lib/services/shipment.service.ts with a mocked Supabase client that
// records what patch object was passed to .update(). This exercises the
// SERVICE-LAYER ALLOWLIST (the `allowed` array at line ~284) — which is where
// the actual bug lived.
//
// The bug: the Zod schema accepted validation_status, the API route mapped it,
// but updateShipment()'s allowlist didn't include it → the field was silently
// stripped and never written to the DB. This test would have caught that bug
// because it asserts the patch object sent to the DB client actually contains
// validation_status.
//
// A test that only exercises updateShipmentSchema.safeParse() does NOT satisfy
// this requirement — that's the input-validation layer, not the service-layer
// allowlist where the bug was.
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { updateShipment } from '@/lib/services/shipment.service';
import type { DbShipment } from '@/lib/clearport-types';

// ---------------------------------------------------------------------------
// Mock Supabase client — records the patch object passed to .update()
// ---------------------------------------------------------------------------
function createMockClient(capturedPatch: { patch: Record<string, unknown> | null }) {
  // The mock must mimic the Supabase query builder chain:
  //   client.from('shipments').update(patch).eq('id', id).eq('org_id', orgId).select().maybeSingle()
  const mockQuery = {
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        id: 'SHIP-TEST-001',
        shipper: 'Test Shipper',
        consignee: 'Test Consignee',
        status: 'Under Review',
        docs_count: 1,
        urgency: '08:30:00',
        initial_confidence: 0,
        current_confidence: 0,
        validation_status: 'failed',
        last_validated_at: '2024-01-01T00:00:00Z',
        pipeline_trace_id: 'trace-123',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      } as DbShipment,
      error: null,
    }),
  };

  const mockClient = {
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockImplementation((patch: Record<string, unknown>) => {
        // Capture the patch object so the test can assert on it
        capturedPatch.patch = patch;
        return mockQuery;
      }),
    }),
  };

  return mockClient as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('updateShipment() — validation_status allowlist regression (§5)', () => {
  it('passes validation_status through to the DB patch object', async () => {
    const captured: { patch: Record<string, unknown> | null } = { patch: null };
    const client = createMockClient(captured);

    await updateShipment(client, 'SHIP-TEST-001', {
      validation_status: 'failed',
    } as Partial<DbShipment>);

    // The patch object sent to client.from('shipments').update(patch) MUST
    // contain validation_status. If someone removes 'validation_status' from
    // the `allowed` array in updateShipment(), this assertion fails because
    // the field would be silently stripped.
    expect(captured.patch).not.toBeNull();
    expect(captured.patch).toHaveProperty('validation_status', 'failed');
  });

  it('passes last_validated_at through to the DB patch object', async () => {
    const captured: { patch: Record<string, unknown> | null } = { patch: null };
    const client = createMockClient(captured);

    await updateShipment(client, 'SHIP-TEST-001', {
      validation_status: 'completed',
      last_validated_at: '2024-09-15T12:00:00Z',
    } as Partial<DbShipment>);

    expect(captured.patch).toHaveProperty('last_validated_at', '2024-09-15T12:00:00Z');
  });

  it('passes pipeline_trace_id through to the DB patch object', async () => {
    const captured: { patch: Record<string, unknown> | null } = { patch: null };
    const client = createMockClient(captured);

    await updateShipment(client, 'SHIP-TEST-001', {
      pipeline_trace_id: 'trace-abc-123',
    } as Partial<DbShipment>);

    expect(captured.patch).toHaveProperty('pipeline_trace_id', 'trace-abc-123');
  });

  it('passes all three validation fields through simultaneously', async () => {
    const captured: { patch: Record<string, unknown> | null } = { patch: null };
    const client = createMockClient(captured);

    await updateShipment(client, 'SHIP-TEST-001', {
      validation_status: 'degraded',
      last_validated_at: '2024-09-15T12:00:00Z',
      pipeline_trace_id: 'trace-xyz',
    } as Partial<DbShipment>);

    // All three must be present — this is the exact bug that was fixed:
    // all three were missing from the allowlist simultaneously.
    expect(captured.patch).toHaveProperty('validation_status', 'degraded');
    expect(captured.patch).toHaveProperty('last_validated_at', '2024-09-15T12:00:00Z');
    expect(captured.patch).toHaveProperty('pipeline_trace_id', 'trace-xyz');
  });

  it('strips unknown fields NOT in the allowlist (defense in depth)', async () => {
    const captured: { patch: Record<string, unknown> | null } = { patch: null };
    const client = createMockClient(captured);

    await updateShipment(client, 'SHIP-TEST-001', {
      validation_status: 'failed',
      // @ts-expect-error — intentionally pass an unknown field
      malicious_field: 'should be stripped',
    } as Partial<DbShipment>);

    // validation_status should pass through...
    expect(captured.patch).toHaveProperty('validation_status', 'failed');
    // ...but unknown fields should be stripped by the allowlist.
    expect(captured.patch).not.toHaveProperty('malicious_field');
  });

  it('adds updated_at timestamp to every patch', async () => {
    const captured: { patch: Record<string, unknown> | null } = { patch: null };
    const client = createMockClient(captured);

    await updateShipment(client, 'SHIP-TEST-001', {
      shipper: 'New Shipper',
    } as Partial<DbShipment>);

    expect(captured.patch).toHaveProperty('updated_at');
    expect(typeof captured.patch!.updated_at).toBe('string');
  });

  it('returns the updated shipment row from the DB', async () => {
    const client = createMockClient({ patch: null });

    const result = await updateShipment(client, 'SHIP-TEST-001', {
      validation_status: 'failed',
    } as Partial<DbShipment>);

    // The return value comes from the mock's maybeSingle() response, which
    // simulates the DB returning the updated row. This verifies the function
    // correctly returns the DB response, not just a success boolean.
    expect(result).toBeDefined();
    expect(result.id).toBe('SHIP-TEST-001');
    expect(result.validation_status).toBe('failed');
  });
});

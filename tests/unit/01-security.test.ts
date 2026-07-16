// ============================================================================
// Section 1: Security / Multi-tenant Boundary Tests
// ============================================================================
// These test the things that, if broken, hurt a customer's trust in the product.
// Every test that's supposed to fail must assert the SPECIFIC failure code,
// not just "not 200".
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  createTestOrg,
  apiCall,
  directSupabaseInsert,
  cleanupOrg,
  type TestUser,
} from '../helpers/test-utils';

describe('Section 1: Security / Multi-tenant Boundary Tests', () => {

  // =========================================================================
  // 1.1 Cross-org data isolation
  // =========================================================================
  describe('1.1 Cross-org data isolation', () => {
    let userA: TestUser, userB: TestUser;
    let orgA: string, orgB: string;
    let shipmentId: string;

    beforeAll(async () => {
      userA = await createTestUser();
      userB = await createTestUser();
      orgA = await createTestOrg(userA, 'Org A');
      orgB = await createTestOrg(userB, 'Org B');
      shipmentId = `SHIP-ISO-${Date.now()}`;

      // User A creates a shipment in Org A
      await apiCall(userA, 'POST', '/api/shipments', {
        id: shipmentId,
        shipper: 'Secret Shipper',
        consignee: 'Secret Consignee',
        status: 'Under Review',
        docs_count: 1,
        urgency: '08:00:00',
        initial_confidence: 70,
        current_confidence: 70,
      }, orgA);
    });

    afterAll(async () => {
      await cleanupOrg(orgA);
      await cleanupOrg(orgB);
    });

    it('User B listing shipments does NOT see Org A shipments', async () => {
      const res = await apiCall(userB, 'GET', '/api/shipments', undefined, orgB);

      expect(res.status).toBe(200);
      const shipmentIds = (res.data?.data || []).map((s: any) => s.id);
      expect(shipmentIds).not.toContain(shipmentId);
    });

    it('User B directly GET /api/shipments/[id] for Org A shipment returns 403 or 404', async () => {
      const res = await apiCall(userB, 'GET', `/api/shipments/${shipmentId}`, undefined, orgB);

      // Must be 403 (forbidden) or 404 (not found) — NOT 200 with data
      expect([403, 404]).toContain(res.status);
      expect(res.data?.id).not.toBe(shipmentId);
      expect(res.data?.shipper).not.toBe('Secret Shipper');
    });

    it('User B using Org A header gets 403 (not a member of Org A)', async () => {
      const res = await apiCall(userB, 'GET', '/api/shipments', undefined, orgA);

      expect(res.status).toBe(403);
      expect(res.data?.code).toBe('FORBIDDEN_ORG');
    });
  });

  // =========================================================================
  // 1.2 RLS self-insert regression (migration 011 fix)
  // =========================================================================
  describe('1.2 RLS self-insert regression', () => {
    let attacker: TestUser;
    let victimOrg: string;

    beforeAll(async () => {
      const victim = await createTestUser();
      victimOrg = await createTestOrg(victim, 'Victim Org');
      attacker = await createTestUser();
    });

    afterAll(async () => {
      await cleanupOrg(victimOrg);
    });

    it('authenticated user cannot self-insert as admin into another org', async () => {
      const res = await directSupabaseInsert(attacker, 'organization_members', {
        org_id: victimOrg,
        user_id: attacker.id,
        role: 'admin',
      });

      // Must be rejected by RLS — 403 or specific PostgREST error
      expect(res.status).toBe(403);
      expect(res.data?.code).toBe('42501'); // insufficient_privilege / RLS violation
    });

    it('authenticated user cannot self-insert as viewer without invite', async () => {
      const res = await directSupabaseInsert(attacker, 'organization_members', {
        org_id: victimOrg,
        user_id: attacker.id,
        role: 'viewer',
      });

      expect(res.status).toBe(403);
      expect(res.data?.code).toBe('42501');
    });

    it('authenticated user cannot self-insert as operator into another org', async () => {
      const res = await directSupabaseInsert(attacker, 'organization_members', {
        org_id: victimOrg,
        user_id: attacker.id,
        role: 'operator',
      });

      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // 1.3 Role hierarchy enforcement
  // =========================================================================
  describe('1.3 Role hierarchy enforcement', () => {
    let admin: TestUser, operator: TestUser, viewer: TestUser;
    let orgId: string;

    beforeAll(async () => {
      // Create admin + org
      admin = await createTestUser();
      orgId = await createTestOrg(admin, 'Role Test Org');

      // Admin invites operator and viewer
      // We'll use the admin API to add them directly
      operator = await createTestUser();
      viewer = await createTestUser();

      // Add operator via admin API
      await apiCall(admin, 'POST', `/api/organizations/${orgId}/members`, {
        userId: operator.id,
        role: 'operator',
      }, orgId);

      // Add viewer via admin API
      await apiCall(admin, 'POST', `/api/organizations/${orgId}/members`, {
        userId: viewer.id,
        role: 'viewer',
      }, orgId);
    });

    afterAll(async () => {
      await cleanupOrg(orgId);
    });

    it('viewer cannot create validation rules (403 with INSUFFICIENT_ROLE)', async () => {
      const res = await apiCall(viewer, 'POST', '/api/rules/validation', {
        name: 'Test Rule',
        field_key: 'htsCode',
        rule_type: 'regex_format',
        config: { pattern: '^\\d{4}\\.\\d{2}\\.\\d{4}$' },
        severity: 'flag',
        is_active: true,
      }, orgId);

      expect(res.status).toBe(403);
      expect(res.data?.code).toBe('INSUFFICIENT_ROLE');
    });

    it('viewer cannot create broker templates (403)', async () => {
      const res = await apiCall(viewer, 'POST', '/api/broker-templates', {
        name: 'Test Template',
        direction: 'export',
      }, orgId);

      expect(res.status).toBe(403);
      expect(res.data?.code).toBe('INSUFFICIENT_ROLE');
    });

    it('viewer can still read shipments (200)', async () => {
      const res = await apiCall(viewer, 'GET', '/api/shipments', undefined, orgId);
      expect(res.status).toBe(200);
    });

    it('operator cannot manage validation rules (403)', async () => {
      const res = await apiCall(operator, 'POST', '/api/rules/validation', {
        name: 'Test Rule',
        field_key: 'htsCode',
        rule_type: 'regex_format',
        config: { pattern: '^\\d{4}\\.\\d{2}\\.\\d{4}$' },
        severity: 'flag',
        is_active: true,
      }, orgId);

      expect(res.status).toBe(403);
      expect(res.data?.code).toBe('INSUFFICIENT_ROLE');
    });

    it('operator can upload shipments (not 403)', async () => {
      const res = await apiCall(operator, 'POST', '/api/shipments', {
        id: `SHIP-OP-${Date.now()}`,
        shipper: 'Test',
        consignee: 'Test',
        status: 'Under Review',
        docs_count: 0,
        urgency: '08:00:00',
        initial_confidence: 70,
        current_confidence: 70,
      }, orgId);

      expect(res.status).not.toBe(403);
    });

    it('admin can create validation rules (201)', async () => {
      const res = await apiCall(admin, 'POST', '/api/rules/validation', {
        name: 'Admin Test Rule',
        field_key: 'htsCode',
        rule_type: 'regex_format',
        config: { pattern: '^\\d{4}\\.\\d{2}\\.\\d{4}$' },
        severity: 'flag',
        is_active: true,
      }, orgId);

      expect(res.status).toBe(201);
    });
  });

  // =========================================================================
  // 1.4 No-org-membership path
  // =========================================================================
  describe('1.4 No-org-membership path', () => {
    it('fresh user with zero org memberships hits requireOrgRole route → 403 with NO_ORG_MEMBERSHIP', async () => {
      const freshUser = await createTestUser();

      const res = await apiCall(freshUser, 'GET', '/api/shipments');

      expect(res.status).toBe(403);
      expect(res.data?.code).toBe('NO_ORG_MEMBERSHIP');
    });

    it('fresh user can still list organizations (bootstrap path)', async () => {
      const freshUser = await createTestUser();

      const res = await apiCall(freshUser, 'GET', '/api/organizations');

      expect(res.status).toBe(200);
      expect(res.data?.organizations).toEqual([]);
    });
  });

  // =========================================================================
  // 1.5 Invite token validation
  // =========================================================================
  describe('1.5 Invite token validation', () => {
    let admin: TestUser, invitee: TestUser;
    let orgId: string;
    let validToken: string;

    beforeAll(async () => {
      admin = await createTestUser();
      orgId = await createTestOrg(admin, 'Invite Test Org');

      // Create a user with a known email — but anonymous users don't have emails.
      // For this test, we'll use the invite API and test the token flow.
      // Since anonymous users don't have emails, the invite acceptance will fail
      // with EMAIL_MISMATCH — which is exactly what we want to test.
    });

    afterAll(async () => {
      await cleanupOrg(orgId);
    });

    it('admin can create an invite (201)', async () => {
      const res = await apiCall(admin, 'POST', `/api/organizations/${orgId}/invites`, {
        email: 'test-invitee@example.com',
        role: 'operator',
      }, orgId);

      expect(res.status).toBe(201);
      expect(res.data?.invite?.token).toBeTruthy();
      validToken = res.data?.invite?.token;
    });

    it('accepting with a non-existent token returns INVITE_INVALID (400)', async () => {
      const randomUser = await createTestUser();
      const res = await apiCall(randomUser, 'POST', '/api/invites/accept', {
        token: '00000000-0000-0000-0000-000000000000',
      });

      expect(res.status).toBe(400);
      expect(res.data?.code).toBe('INVITE_INVALID');
    });

    it('accepting with a valid token but wrong email returns EMAIL_MISMATCH (403)', async () => {
      // The invite was sent to test-invitee@example.com, but anonymous users
      // don't have that email — so this should fail with EMAIL_MISMATCH
      const randomUser = await createTestUser();
      const res = await apiCall(randomUser, 'POST', '/api/invites/accept', {
        token: validToken,
      });

      expect(res.status).toBe(403);
      expect(res.data?.code).toBe('EMAIL_MISMATCH');
    });
  });
});

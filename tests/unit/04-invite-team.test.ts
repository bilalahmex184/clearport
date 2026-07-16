// ============================================================================
// Section 4: Invite / Team Management Tests
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser, createTestOrg, apiCall, cleanupOrg, type TestUser,
} from '../helpers/test-utils';

describe('Section 4: Invite / Team Management', () => {
  let admin: TestUser;
  let orgId: string;

  beforeAll(async () => {
    admin = await createTestUser();
    orgId = await createTestOrg(admin, 'Team Test Org');
  });

  afterAll(async () => {
    await cleanupOrg(orgId);
  });

  // =========================================================================
  // 4.1 Invite creation + listing
  // =========================================================================
  describe('4.1 Invite creation + listing', () => {
    it('admin can create an invite (201)', async () => {
      const res = await apiCall(admin, 'POST', `/api/organizations/${orgId}/invites`, {
        email: 'teammate@example.com',
        role: 'operator',
      }, orgId);

      expect(res.status).toBe(201);
      expect(res.data?.invite?.token).toBeTruthy();
      expect(res.data?.invite?.email).toBe('teammate@example.com');
      expect(res.data?.invite?.role).toBe('operator');
      expect(res.data?.invite?.accepted_at).toBeNull();
      expect(res.data?.inviteUrl).toContain('/accept-invite?token=');
    });

    it('admin can list pending invites', async () => {
      const res = await apiCall(admin, 'GET', `/api/organizations/${orgId}/invites`, undefined, orgId);

      expect(res.status).toBe(200);
      expect(res.data?.invites).toBeDefined();
      expect(Array.isArray(res.data.invites)).toBe(true);
      expect(res.data.invites.length).toBeGreaterThan(0);

      const invite = res.data.invites[0];
      expect(invite.email).toBeTruthy();
      expect(invite.role).toBeTruthy();
      expect(invite.token).toBeTruthy();
    });

    it('viewer cannot create invites (403)', async () => {
      // Create a viewer user
      const viewer = await createTestUser();
      // Admin adds viewer directly
      await apiCall(admin, 'POST', `/api/organizations/${orgId}/members`, {
        userId: viewer.id,
        role: 'viewer',
      }, orgId);

      const res = await apiCall(viewer, 'POST', `/api/organizations/${orgId}/invites`, {
        email: 'should-fail@example.com',
        role: 'viewer',
      }, orgId);

      expect(res.status).toBe(403);
      expect(res.data?.code).toBe('INSUFFICIENT_ROLE');
    });

    it('viewer cannot list invites (403)', async () => {
      const viewer = await createTestUser();
      await apiCall(admin, 'POST', `/api/organizations/${orgId}/members`, {
        userId: viewer.id,
        role: 'viewer',
      }, orgId);

      const res = await apiCall(viewer, 'GET', `/api/organizations/${orgId}/invites`, undefined, orgId);
      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // 4.2 Invite acceptance flow
  // =========================================================================
  describe('4.2 Invite acceptance', () => {
    it('non-existent token → INVITE_INVALID (400)', async () => {
      const randomUser = await createTestUser();
      const res = await apiCall(randomUser, 'POST', '/api/invites/accept', {
        token: '00000000-0000-0000-0000-000000000000',
      });

      expect(res.status).toBe(400);
      expect(res.data?.code).toBe('INVITE_INVALID');
    });

    it('valid token but wrong email → EMAIL_MISMATCH (403)', async () => {
      // Create invite for a specific email
      const inviteRes = await apiCall(admin, 'POST', `/api/organizations/${orgId}/invites`, {
        email: 'someone-else@example.com',
        role: 'viewer',
      }, orgId);
      const token = inviteRes.data?.invite?.token;

      // A different user (anonymous, no email) tries to accept
      const randomUser = await createTestUser();
      const res = await apiCall(randomUser, 'POST', '/api/invites/accept', { token });

      expect(res.status).toBe(403);
      expect(res.data?.code).toBe('EMAIL_MISMATCH');
    });

    it('invite appears in audit logs after creation', async () => {
      const logsRes = await apiCall(admin, 'GET', '/api/audit-logs', undefined, orgId);
      expect(logsRes.status).toBe(200);

      const inviteLogs = (logsRes.data?.logs || []).filter(
        (l: any) => l.text?.includes('[invite]'),
      );
      expect(inviteLogs.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4.3 Member management
  // =========================================================================
  describe('4.3 Member management', () => {
    it('admin can add a member directly', async () => {
      const newMember = await createTestUser();
      const res = await apiCall(admin, 'POST', `/api/organizations/${orgId}/members`, {
        userId: newMember.id,
        role: 'operator',
      }, orgId);

      // Should succeed (admin can add members)
      expect([200, 201]).toContain(res.status);
    });

    it('operator cannot add members (403)', async () => {
      const operator = await createTestUser();
      // Admin adds operator
      await apiCall(admin, 'POST', `/api/organizations/${orgId}/members`, {
        userId: operator.id,
        role: 'operator',
      }, orgId);

      const newMember = await createTestUser();
      const res = await apiCall(operator, 'POST', `/api/organizations/${orgId}/members`, {
        userId: newMember.id,
        role: 'viewer',
      }, orgId);

      expect(res.status).toBe(403);
      expect(res.data?.code).toBe('INSUFFICIENT_ROLE');
    });

    it('admin can list members', async () => {
      const res = await apiCall(admin, 'GET', `/api/organizations/${orgId}/members`, undefined, orgId);

      expect(res.status).toBe(200);
      expect(res.data?.members).toBeDefined();
      expect(Array.isArray(res.data.members)).toBe(true);
      expect(res.data.members.length).toBeGreaterThan(0);

      // Admin should be in the list
      const adminMember = res.data.members.find((m: any) => m.user_id === admin.id);
      expect(adminMember).toBeDefined();
      expect(adminMember.role).toBe('admin');
    });
  });
});

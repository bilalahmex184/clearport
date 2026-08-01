// ============================================================================
// 13-storage-cross-org-isolation.test.ts — Integration test for Issue #39 fix
// ============================================================================
// Verifies that packages/shared/src/storage.ts#createSignedDownloadUrl
// enforces org-scoped access on the `documents` Supabase Storage bucket:
//
//   - org_a uploads a file → org_a CAN retrieve a signed URL for it.
//   - org_b CANNOT retrieve a signed URL for org_a's file (membership
//     check throws "Access denied" before createSignedUrl is ever called).
//
// This is the integration counterpart to tests/unit-pure/09-storage-key-
// validation.test.ts (which tests the pure key-building logic). This test
// hits a real Supabase project configured in .env. If it fails, that IS
// the finding — do not "fix" the test, fix the RLS policy or the helper.
//
// Prerequisite:
//   - supabase/migrations-new/001_baseline_schema.sql applied to the target
//     project (creates the org_members_access_documents_bucket policy).
//   - The `documents` bucket exists (private, 20MB limit).
//
// Runs only when NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY
// are set; otherwise skipped (no backend in CI sandbox).
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  buildStorageKey,
  createSignedDownloadUrl,
  parseStorageKey,
} from '../../packages/shared/src/storage';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

const shouldRun = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

describe.skipIf(!shouldRun)(
  'Storage cross-org isolation (createSignedDownloadUrl)',
  () => {
    let clientA: SupabaseClient;
    let clientB: SupabaseClient;
    let userAId: string;
    let userBId: string;
    let orgAId: string;
    let orgBId: string;
    let uploadedKey: string;

    beforeAll(async () => {
      const admin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

      // Two anonymous users = two different orgs.
      const { data: authA } = await admin.auth.signInAnonymously();
      const { data: authB } = await admin.auth.signInAnonymously();
      expect(authA.session).toBeTruthy();
      expect(authB.session).toBeTruthy();
      userAId = authA.user!.id;
      userBId = authB.user!.id;

      clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${authA.session!.access_token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      clientB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${authB.session!.access_token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });

      // Create an org for each user via the create_organization RPC.
      const { data: orgARes } = await clientA.rpc('create_organization', {
        p_org_name: `Storage Test Org A ${Date.now()}`,
        p_creator_uid: userAId,
      });
      const { data: orgBRes } = await clientB.rpc('create_organization', {
        p_org_name: `Storage Test Org B ${Date.now()}`,
        p_creator_uid: userBId,
      });
      expect(orgARes?.[0]?.org_id).toBeTruthy();
      expect(orgBRes?.[0]?.org_id).toBeTruthy();
      orgAId = orgARes[0].org_id;
      orgBId = orgBRes[0].org_id;
    }, 30000);

    afterAll(async () => {
      // Best-effort cleanup: remove the uploaded object if it exists.
      if (uploadedKey) {
        const admin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        await admin.storage.from('documents').remove([uploadedKey]);
      }
    });

    it('org_a can upload and retrieve its own file via signed URL', async () => {
      // Build the key using the validated helper — org_id is the first segment.
      uploadedKey = buildStorageKey(orgAId, 'SHIP-TEST-A', 'invoice.pdf');
      const parsed = parseStorageKey(uploadedKey);
      expect(parsed.orgId).toBe(orgAId);

      // Upload a minimal valid PDF (%PDF magic bytes) as org_a.
      const pdfBytes = new Uint8Array([
        0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, // %PDF-1.4
        ...new Array(50).fill(0x20),                       // padding
      ]);
      const { error: uploadErr } = await clientA.storage
        .from('documents')
        .upload(uploadedKey, pdfBytes, { contentType: 'application/pdf' });
      expect(uploadErr).toBeNull();

      // org_a requests a signed URL via the helper — membership check passes.
      const urlData = await createSignedDownloadUrl(clientA, uploadedKey, userAId, 60);
      expect(urlData.signedUrl).toBeTruthy();
      expect(urlData.path).toBe(uploadedKey);
    }, 15000);

    it('org_b CANNOT retrieve a signed URL for org_a file (membership denied)', async () => {
      // org_b tries to get a signed URL for org_a's object. The helper
      // validates the key structure (passes — it's a valid UUID key) then
      // checks membership: org_b's user is NOT a member of org_a, so it
      // throws before ever calling createSignedUrl.
      await expect(
        createSignedDownloadUrl(clientB, uploadedKey, userBId, 60),
      ).rejects.toThrow(/Access denied|not a member/i);

      // Belt-and-suspenders: even if the membership check were bypassed,
      // the underlying Supabase Storage RLS policy should also deny org_b
      // a direct createSignedUrl call (the policy is org_id-scoped).
      const { data, error } = await clientB.storage
        .from('documents')
        .createSignedUrl(uploadedKey, 60);
      // Supabase returns an error object (not a throw) when RLS denies.
      expect(error || !data?.signedUrl).toBeTruthy();
    }, 15000);

    it('rejects a signed-URL request for a malformed key structure', async () => {
      // The helper must throw BEFORE any DB membership query when the key
      // structure is invalid (no valid UUID in the first segment).
      await expect(
        createSignedDownloadUrl(clientA, '../etc/passwd/ship/file.pdf', userAId, 60),
      ).rejects.toThrow(/Invalid key structure/i);

      await expect(
        createSignedDownloadUrl(clientA, 'not-a-uuid/ship/file.pdf', userAId, 60),
      ).rejects.toThrow(/Invalid key structure/i);
    }, 10000);
  },
);

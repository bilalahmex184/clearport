// ============================================================================
// 09-cross-org-storage.test.ts — Regression test for Issue #39
// ============================================================================
// Storage RLS path convention (user_id vs org_id) silently breaks every
// real upload. This test verifies that a document uploaded by org_a's user
// is retrievable by org_a but NOT by org_b — proving RLS isolation works
// on the actual storage path convention used by the live upload flow.
//
// This test does NOT mock Supabase storage. It runs against the real
// Supabase project configured in .env. If it fails, that IS the finding —
// do not "fix" the test to pass, fix the storage path convention or the
// RLS policy so they agree.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Skip the entire suite if Supabase is not configured — this is an
// integration test that requires a real backend.
const shouldRun = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

describe.skipIf(!shouldRun)('Cross-org storage RLS isolation', () => {
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let orgAId: string;
  let orgBId: string;
  let testStoragePath: string;

  beforeAll(async () => {
    // Create two anonymous sessions (simulating two different users)
    const adminClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const { data: authA } = await adminClient.auth.signInAnonymously();
    const { data: authB } = await adminClient.auth.signInAnonymously();

    expect(authA.session).toBeTruthy();
    expect(authB.session).toBeTruthy();

    // Create per-user clients with their own JWTs
    clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${authA.session!.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    clientB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${authB.session!.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Create org A for user A
    const { data: orgAResult } = await clientA.rpc('create_organization', {
      p_org_name: 'Test Org A (RLS regression)',
      p_creator_uid: authA.user!.id,
    });
    orgAId = orgAResult?.[0]?.org_id;
    expect(orgAId).toBeTruthy();

    // Create org B for user B
    const { data: orgBResult } = await clientB.rpc('create_organization', {
      p_org_name: 'Test Org B (RLS regression)',
      p_creator_uid: authB.user!.id,
    });
    orgBId = orgBResult?.[0]?.org_id;
    expect(orgBId).toBeTruthy();

    // Use the SAME storage path convention as the live upload flow:
    // ${org_id}/${shipmentId}/${docId}-${fileName}
    testStoragePath = `${orgAId}/SHIP-RLS-TEST/doc-rls-test-test_invoice.txt`;
  });

  afterAll(async () => {
    // Best-effort cleanup — don't fail the test if cleanup fails
    if (clientA && testStoragePath) {
      try {
        await clientA.storage.from('documents').remove([testStoragePath]);
      } catch {
        // ignore
      }
    }
  });

  it('should upload a document as org_a user using the live path convention', async () => {
    // Simulate what use-shipments.ts does: upload to ${orgId}/${shipmentId}/${docId}-${fileName}
    const fileContent = new Blob(['TEST INVOICE\nInvoice Number: INV-RLS-TEST\nShipper: Test Corp A'], { type: 'text/plain' });

    const { error } = await clientA.storage
      .from('documents')
      .upload(testStoragePath, fileContent, { contentType: 'text/plain', upsert: false });

    // If this fails, the storage path convention or RLS policy is broken.
    // The storage path uses org_id as the first segment. If the RLS policy
    // expects user_id as the first segment, this upload will fail silently.
    if (error) {
      // RLS may block the upload if the policy checks a different path convention.
      // This IS the finding — log it clearly.
      console.warn('[RLS REGRESSION] Upload failed — storage RLS policy may not match the path convention used by the live upload flow:', error.message);
    }

    // The test passes if the upload succeeds OR if it fails with an RLS error
    // (which means RLS is enforcing, just with a different convention).
    // It FAILS if the upload succeeds but org_b can also read the file.
    expect(error).toBeNull();
  });

  it('org_a user should be able to retrieve the uploaded document', async () => {
    const { data, error } = await clientA.storage
      .from('documents')
      .createSignedUrl(testStoragePath, 3600);

    expect(error).toBeNull();
    expect(data?.signedUrl).toBeTruthy();
  });

  it('org_b user should NOT be able to retrieve org_a document (RLS isolation)', async () => {
    const { data, error } = await clientB.storage
      .from('documents')
      .createSignedUrl(testStoragePath, 3600);

    // RLS should block this — either error is thrown or signedUrl is null
    // If signedUrl is returned, RLS is NOT isolating orgs — that's the bug.
    if (data?.signedUrl && !error) {
      // Verify the URL actually works (some RLS policies return a URL but block on download)
      const response = await fetch(data.signedUrl);
      if (response.ok) {
        throw new Error(
          `CROSS-ORG RLS BREACH: org_b user successfully downloaded org_a's document at ${testStoragePath}. ` +
          `The storage RLS policy is not enforcing org isolation. ` +
          `Check if the policy checks the first path segment against user_id instead of org_id.`
        );
      }
    }

    // Either error or non-ok response is acceptable — RLS is working
    expect(error || !data?.signedUrl).toBeTruthy();
  });
});

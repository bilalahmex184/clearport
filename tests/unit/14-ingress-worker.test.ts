// ============================================================================
// 14-ingress-worker.test.ts — Integration tests for the ClearPort ingress
// ============================================================================
// WHAT THIS TEST VERIFIES
//   (a) Byte-identical re-upload returns the SAME job_id without creating a
//       duplicate job or enqueuing a second queue message (idempotency).
//   (b) A non-member attempting to upload to an org they don't belong to is
//       rejected with 403 BEFORE any file processing or Storage write.
//
// HOW IT RUNS THE WORKER
//   The Worker's `handleUpload(req, env, ctx)` is called directly with a
//   constructed Request — no HTTP server, no wrangler. The Cloudflare Queue
//   binding (EXTRACTION_QUEUE) is stubbed with an object whose `send()`
//   method records calls into an array; the test asserts on the array
//   length to confirm idempotent re-uploads don't enqueue duplicates.
//
// PREREQUISITES
//   - supabase/migrations-new/001_baseline_schema.sql applied (organizations,
//     organization_members, documents, shipments, create_organization RPC).
//   - supabase/migrations-new/002_async_jobs.sql applied (jobs table +
//     get_or_create_job + complete_job).
//   - SUPABASE_SERVICE_ROLE_KEY set in .env (the Worker uses it for service-
//     role REST calls — org-membership check, job RPC, Storage upload,
//     documents insert).
//
// SKIP BEHAVIOR
//   describe.skipIf(!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY)
//   — skips cleanly in CI sandboxes without a backend. The service-role key
//   is required because the Worker is a trusted server-side runtime; without
//   it, the membership check + Storage upload + job RPC would all 500.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestUser,
  createTestOrg,
  cleanupOrg,
  type TestUser,
} from '../helpers/test-utils';
import { handleUpload } from '../../apps/ingress/src/index';
import type { Env, ExtractionJobMessage } from '../../apps/ingress/src/env';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// The Worker is a trusted server-side runtime. It uses the service-role key
// for org-membership check, job RPC, Storage upload, documents insert — all
// of which would 500 without it. Require it here.
const shouldRun =
  !!SUPABASE_URL && !!SUPABASE_ANON_KEY && !!SUPABASE_SERVICE_ROLE_KEY;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal valid PDF bytes — starts with `%PDF-1.4` magic bytes followed by
 * enough padding to pass the size check (>0 bytes). The file-validation
 * helper only inspects the first 8 bytes for magic-byte matching, so this
 * is enough to be accepted as `application/pdf`.
 */
function minimalPdfBytes(): Uint8Array {
  const header = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]; // %PDF-1.4
  const padding = new Array(64).fill(0x20); // spaces
  return new Uint8Array([...header, ...padding]);
}

/**
 * Construct a multipart/form-data Request that mimics what a real client
 * would send to the ingress Worker:
 *   - Authorization: Bearer <jwt>
 *   - X-Org-Id: <orgId>
 *   - body: FormData with `file` (Blob) + `shipment_id` (string)
 */
function makeUploadRequest(
  user: TestUser,
  orgId: string,
  shipmentId: string,
  bytes: Uint8Array,
  fileName: string,
): Request {
  const form = new FormData();
  form.append(
    'file',
    new Blob([bytes], { type: 'application/pdf' }),
    fileName,
  );
  form.append('shipment_id', shipmentId);
  return new Request('https://ingress.test/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.token}`,
      'X-Org-Id': orgId,
    },
    body: form,
  });
}

/**
 * Build a stubbed Env with a recording EXTRACTION_QUEUE. Each `send()` call
 * appends the message to `queueCalls` so the test can assert on the count
 * and contents. RATE_LIMIT_KV is stubbed with an in-memory Map (Phase 5
 * Step 1) — the rate limiter increments a count per org per hour; the
 * default 50/hour cap is more than these integration tests exercise, so
 * the limiter effectively always allows here.
 */
function makeStubEnv(
  queueCalls: ExtractionJobMessage[],
): Env {
  const kvStore = new Map<string, string>();
  return {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    EXTRACTION_QUEUE: {
      send: async (msg: ExtractionJobMessage): Promise<void> => {
        queueCalls.push(msg);
      },
    },
    RATE_LIMIT_KV: {
      get: async (key: string) => kvStore.get(key) ?? null,
      put: async (key: string, value: string) => { kvStore.set(key, value); },
    },
  };
}

/**
 * Create a shipment row — the documents table has a FK constraint on
 * shipment_id → shipments.id, so the shipment must exist before the Worker
 * inserts a document. Mirrors the helper in 12-usage-limit-enforcement.test.
 */
async function createShipment(
  user: TestUser,
  orgId: string,
  prefix: string,
): Promise<string> {
  const shipmentId = `SHIP-${prefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const { error } = await user.client.from('shipments').insert({
    id: shipmentId,
    org_id: orgId,
    user_id: user.id,
    shipper: 'Ingress Test Shipper',
    consignee: 'Ingress Test Consignee',
    status: 'Under Review',
    docs_count: 0,
    urgency: '08:00:00',
    initial_confidence: 0,
    current_confidence: 0,
  });
  if (error) {
    throw new Error(`Failed to create test shipment: ${error.message}`);
  }
  return shipmentId;
}

// ===========================================================================
// Test suite
// ===========================================================================

describe.skipIf(!shouldRun)(
  'Ingress Worker (Phase 3 Step 1)',
  () => {
    // -----------------------------------------------------------------------
    // Shared fixtures — created in beforeAll, cleaned in afterAll.
    // -----------------------------------------------------------------------
    let userA: TestUser;
    let userB: TestUser;
    let orgAId: string;
    let orgBId: string;

    beforeAll(async () => {
      userA = await createTestUser();
      userB = await createTestUser();
      orgAId = await createTestOrg(userA, 'Ingress Test Org A');
      orgBId = await createTestOrg(userB, 'Ingress Test Org B');
    }, 30000);

    afterAll(async () => {
      // Cascade: deleting the org deletes organization_members, documents,
      // jobs, job_attempts, shipments (all FK ON DELETE CASCADE). Storage
      // objects are NOT cascade-deleted (Storage isn't tied to the org DB
      // row) — they're orphaned in the bucket but harmless; the test
      // uploads a 72-byte PDF and the bucket has a 20MB cap, so we won't
      // fill it.
      await cleanupOrg(orgAId);
      await cleanupOrg(orgBId);
    }, 30000);

    // =======================================================================
    // (a) Byte-identical re-upload returns the same job_id without
    //     creating a duplicate job or enqueuing a second queue message.
    // =======================================================================
    it(
      'byte-identical re-upload is idempotent — same job_id, single queue send',
      async () => {
        // Setup: a shipment for the documents FK + a stable set of bytes.
        const shipmentId = await createShipment(userA, orgAId, 'IDEM');
        const pdfBytes = minimalPdfBytes();

        // First upload — should create a new job and enqueue exactly once.
        const queueCalls: ExtractionJobMessage[] = [];
        const env = makeStubEnv(queueCalls);

        const req1 = makeUploadRequest(
          userA,
          orgAId,
          shipmentId,
          pdfBytes,
          'invoice.pdf',
        );
        const res1 = await handleUpload(req1, env);
        const body1 = (await res1.json()) as {
          job_id: string;
          status: string;
        };

        // The first response MUST be 202 Accepted with a pending job.
        expect(res1.status).toBe(202);
        expect(body1.job_id).toBeTruthy();
        expect(body1.status).toBe('pending');

        // Exactly one queue message should have been sent for the new job.
        expect(queueCalls).toHaveLength(1);
        expect(queueCalls[0].job_id).toBe(body1.job_id);

        // ---------------------------------------------------------------
        // Second upload — SAME bytes, DIFFERENT filename. The Worker
        // hashes the bytes (not the name), so the idempotency key is the
        // same → get_or_create_job returns the existing job with
        // created_now=false → no Storage upload, no documents insert, no
        // queue send. The response is 200 (not 202) with the existing
        // job_id and a "Job already in progress" message.
        // ---------------------------------------------------------------
        const req2 = makeUploadRequest(
          userA,
          orgAId,
          shipmentId,
          pdfBytes, // SAME bytes
          'different-filename.pdf', // DIFFERENT name
        );
        const res2 = await handleUpload(req2, env);
        const body2 = (await res2.json()) as {
          job_id: string;
          status: string;
          message?: string;
        };

        // The second response MUST be 200 (not 202) with the SAME job_id.
        expect(res2.status).toBe(200);
        expect(body2.job_id).toBe(body1.job_id);

        // The job is still 'pending' (the consumer Worker isn't running in
        // this test, so nothing claimed it). The Worker surfaces this as
        // "Job already in progress".
        expect(body2.status).toBe('pending');
        expect(body2.message).toMatch(/already in progress/i);

        // CRITICAL: the queueCalls array must STILL have length 1 — no
        // second message was enqueued for the duplicate upload. This is
        // the spec's core idempotency assertion: a client retry after a
        // network blip doesn't double-enqueue.
        expect(queueCalls).toHaveLength(1);
      },
      30000,
    );

    // =======================================================================
    // (b) Non-member upload is rejected with 403 before any file processing.
    // =======================================================================
    it(
      'non-member upload is rejected with 403 (no queue send, no Storage write)',
      async () => {
        const shipmentId = await createShipment(userB, orgBId, 'XORG');
        const pdfBytes = minimalPdfBytes();

        const queueCalls: ExtractionJobMessage[] = [];
        const env = makeStubEnv(queueCalls);

        // user_b claims to be uploading to org_a — they're not a member.
        // The Worker must reject this BEFORE parsing the file body,
        // uploading to Storage, or enqueuing.
        const req = makeUploadRequest(
          userB,
          orgAId, // ← user_b is NOT a member of org_a
          shipmentId,
          pdfBytes,
          'cross-org-attempt.pdf',
        );
        const res = await handleUpload(req, env);
        const body = (await res.json()) as {
          error?: string;
          code?: string;
        };

        expect(res.status).toBe(403);
        expect(body.code).toBe('FORBIDDEN');
        expect(body.error).toMatch(/not a member/i);

        // No queue message should have been sent. No Storage write should
        // have happened. (We can't easily verify the Storage side from
        // here without listing bucket objects, but the queue assertion
        // is the contract: the authz gate runs before any side effect.)
        expect(queueCalls).toHaveLength(0);
      },
      30000,
    );

    // =======================================================================
    // (c) Sanity: a member upload to their own org works (control case).
    // =======================================================================
    // This is a control for test (b) — it proves the 403 in (b) is because
    // of the membership check, not because of some other config issue with
    // user_b / org_b.
    // =======================================================================
    it(
      'member upload to own org succeeds (control for the 403 case)',
      async () => {
        const shipmentId = await createShipment(userB, orgBId, 'CTRL');
        const pdfBytes = minimalPdfBytes();

        const queueCalls: ExtractionJobMessage[] = [];
        const env = makeStubEnv(queueCalls);

        const req = makeUploadRequest(
          userB,
          orgBId, // ← user_b IS a member of org_b
          shipmentId,
          pdfBytes,
          'control.pdf',
        );
        const res = await handleUpload(req, env);
        const body = (await res.json()) as {
          job_id: string;
          status: string;
        };

        expect(res.status).toBe(202);
        expect(body.job_id).toBeTruthy();
        expect(body.status).toBe('pending');
        expect(queueCalls).toHaveLength(1);
      },
      30000,
    );
  },
);

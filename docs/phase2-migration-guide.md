# Phase 2 — Data, Storage & Security: Migration Guide

**Status**: Phase 2 complete. Old Supabase project stays **live and untouched** until Phase 6 confirms the cutover.

**Issues closed**: #9, #18, #39 (fully closed), #42, #44.

---

## What Changed

Phase 2 stands up a **fresh Supabase project account** with a clean schema, rather than patching the old project in place. The old project's history (four RLS-recursion fix migrations 002–006, the user_id-vs-org_id Storage mismatch #39, and service-role keys that lived in a codebase with a documented security-patch trail) made a clean break the safer call.

| Step | Deliverable | Location |
|------|-------------|----------|
| 0 | Clean consolidated baseline schema (no bug-trail replay) | `supabase/migrations-new/001_baseline_schema.sql` |
| 1 | Validated storage key builder + org-scoped signed-URL helper | `packages/shared/src/storage.ts` |
| 1 | Cross-org storage isolation integration test | `tests/unit/13-storage-cross-org-isolation.test.ts` |
| 1 | Pure-logic path-injection unit tests | `tests/unit-pure/09-storage-key-validation.test.ts` |
| 2 | Durable async jobs table + per-tier attempt ledger | `supabase/migrations-new/002_async_jobs.sql` |
| 3 | Server-side magic-byte MIME validation | `packages/shared/src/file-validation.ts` |
| 3 | File validation unit tests | `tests/unit-pure/10-file-validation.test.ts` |
| 4 | Atomic usage-limit enforcement (FOR UPDATE lock) | `supabase/migrations/026_usage_limit_atomic.sql` |
| 4 | `enforceUsageLimitOrThrow` TypeScript wrapper | `src/lib/services/billing.service.ts` |
| 4 | Concurrency regression test | `tests/unit/12-usage-limit-enforcement.test.ts` |

---

## Step 0 — Provision the Fresh Project Account

> **Decision**: Staying on Supabase Storage. No Cloudflare R2, no new vendor. A fresh project under a new account/organization, not a patch on the old one.

### Manual steps (cannot be automated from code)

1. **Create a new Supabase organization + project** at https://supabase.com/dashboard
   - Use a new organization (do NOT reuse the old project's org).
   - Region: pick the same region as the old project to minimize migration latency in Phase 6.
2. **Generate fresh API keys** (Dashboard → Settings → API):
   - `anon` key — safe to expose in client builds (RLS-protected).
   - `service_role` key — **SERVER-SIDE ONLY**. Never in frontend/client/shared packages/browser logs.
3. **Apply the baseline schema**:
   ```bash
   # From the project root, against the NEW project:
   supabase db push --db-url "postgresql://postgres:[NEW_DB_PASSWORD]@db.[NEW_PROJECT_REF].supabase.co:5432/postgres" \
     --file supabase/migrations-new/001_baseline_schema.sql
   supabase db push --db-url "..." \
     --file supabase/migrations-new/002_async_jobs.sql
   # Then the usage-limit enforcement function:
   supabase db push --db-url "..." \
     --file supabase/migrations/026_usage_limit_atomic.sql
   ```
4. **Store the new keys** in the env-var scheme from Phase 1 Step 2 (`.env`, never committed):
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://[NEW_PROJECT_REF].supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=[NEW_ANON_KEY]
   SUPABASE_SERVICE_ROLE_KEY=[NEW_SERVICE_ROLE_KEY]   # SERVER-SIDE ONLY
   ```

### Why a fresh project, not a patch

The old project's `supabase/migrations/` directory contains 26 files (000–025), including **four consecutive RLS-recursion fix migrations** (002, 003, 004, 005) plus a cleanup pass (006). Replaying those into a new project would import the exact bug trail this plan exists to leave behind. `001_baseline_schema.sql` collapses all 26 into one file representing the **current correct end-state** as if the bugs never happened — the Storage RLS policy is written against `org_id` from the start (the #39 fix), not patched from `user_id`.

### Hard key security rule

- `anon` key: safe in client builds (RLS-protected).
- `service_role` key: **NEVER** in frontend code, client builds, shared packages, or browser logs. Only loaded in secure server runtimes (Next.js API routes, Cloudflare Workers) via encrypted env vars.
- The **old** project's service_role key is treated as **potentially exposed** (it lived in a codebase with a documented security-patch history). The fresh project generates a NEW key; the old one is rotated/revoked in Phase 6 after data migration.

### The old project stays live

Do **not** decommission the old Supabase project yet. Phase 6 covers migrating real data (auth users, orgs, shipments, documents, Storage objects) from old → new. The old project is only shut down after that migration is verified. Standing up the new project now doesn't mean cutting over now.

---

## Step 1 — Storage RLS Fix (Issue #39)

### The root cause

| | Old project (broken) | New project (fixed) |
|---|---|---|
| **RLS policy** | `auth.uid()::text = (storage.foldername(name))[1]` | `EXISTS (SELECT 1 FROM organization_members om WHERE om.org_id = (storage.foldername(name))[1]::uuid AND om.user_id = auth.uid())` |
| **Upload path** | `{org_id}/{shipment_id}/{filename}` | `{org_id}/{shipment_id}/{uuid}-{sanitized}` |
| **Result** | Policy and code disagreed → cross-org isolation silently broken | Policy and code agree → `::uuid` cast rejects path injection |

The `::uuid` cast in the new policy is the critical defense: it rejects any storage key whose first segment isn't a valid UUID, so a malicious key like `../../etc/passwd/...` fails the cast before the membership check ever runs.

### The helper (`packages/shared/src/storage.ts`)

Single source of truth for storage key construction across the monorepo:

- `buildStorageKey(orgId, shipmentId, fileName)` — validates `orgId` (UUID) and `shipmentId` (charset `[a-zA-Z0-9_-]`) before constructing the key; sanitizes the filename (strips `/`, `\`, `..`, non-allowlist chars).
- `parseStorageKey(key)` — validates structure (3 segments, UUID first segment) before returning parts. Throws `"Invalid key structure"` on tampering.
- `createSignedDownloadUrl(client, key, callerUserId, expiresInSec)` — **validation order matters**: (1) parse key structure → (2) query `organization_members` for membership → (3) only then call `createSignedUrl`. A non-member never reaches step 3.

### Tests

- **Pure logic**: `tests/unit-pure/09-storage-key-validation.test.ts` (53 tests) — path injection, malicious filenames, malformed keys, round-trip.
- **Integration**: `tests/unit/13-storage-cross-org-isolation.test.ts` — org_a uploads + retrieves; org_b is denied a signed URL; malformed keys throw before the DB query.

---

## Step 2 — Async Jobs Table

`002_async_jobs.sql` defines the successor to `processing_jobs` (migration 018):

| Table | Purpose |
|-------|---------|
| `jobs` | Durable, idempotent queue. `(org_id, idempotency_key)` UNIQUE means a retried upload returns the existing job, not a duplicate. |
| `job_attempts` | Per-tier, per-attempt audit ledger (successor to `extraction_attempts`). One row per (job, attempt, tier) — full forensic history. |

### Claim lock with 5-minute TTL auto-recovery

```sql
UPDATE jobs
SET status = 'processing', claimed_at = now(), attempts = attempts + 1
WHERE id = $1
  AND (status = 'pending'
       OR (status = 'processing' AND claimed_at < now() - interval '5 minutes'))
RETURNING *;
```

The `OR (status = 'processing' AND claimed_at < ...)` clause is the TTL recovery: a worker that crashed mid-extraction leaves the job in `processing` forever without it. After 5 minutes, the next `claim_job` call accepts it again. `reclaim_stuck_jobs_v2()` (cron-callable every minute) sweeps all stuck jobs back to `pending`.

### Functions provided

- `claim_job(p_job_id)` — atomic claim of a specific job (with TTL recovery).
- `claim_next_pending_job()` — claim the oldest pending job (`FOR UPDATE SKIP LOCKED`).
- `complete_job(p_job_id, p_success, p_error, p_result)` — mark done, or retry/dead-letter based on `attempts < max_attempts`.
- `record_job_attempt(...)` — append a tier outcome to the ledger.
- `get_or_create_job(...)` — idempotent creation (revives `dead_letter` jobs on re-upload).

---

## Step 3 — Server-Side File Validation

`packages/shared/src/file-validation.ts` runs BEFORE any Storage write or DB row creation:

| Check | On failure |
|-------|-----------|
| Empty file (`size === 0`) | `EMPTY_FILE` → HTTP 400 |
| Size > 20MB | `FILE_TOO_LARGE` → HTTP 413 |
| Magic bytes don't match PDF/PNG/JPEG/TIFF | `UNKNOWN_FILE_TYPE` → HTTP 415 |
| Extension doesn't match detected MIME | `EXTENSION_MISMATCH` → HTTP 415 |

Magic-byte signatures:
- PDF: `25 50 44 46` (`%PDF`)
- PNG: `89 50 4E 47` (`\x89PNG`)
- JPEG: `FF D8 FF`
- TIFF: `49 49 2A 00` (LE) **or** `4D 4D 00 2A` (BE)

**Wiring point** (Phase 3): the Cloudflare ingress Worker and/or the Next.js `/api/internal/extract-and-validate` route should call `validateUploadedFile({ name, size, bytes })` as the first operation. On caught `FileValidationError`, return `NextResponse.json({ error: e.message, code: e.code }, { status: e.statusCode })` before touching Storage or the DB.

---

## Step 4 — Atomic Usage-Limit Enforcement

### The race condition this closes

The old `checkUsageLimit` was read-only: it counted documents and returned `{ exceeded }`. Under burst load (50 concurrent uploads), all 50 could read `count=24` (under the free limit of 25), all pass the check, then all insert — busting the cap by 49. The new `enforce_usage_limit` SQL function holds a `FOR UPDATE` lock on the `usage_limits` row for the org's plan across the check, serializing concurrent requests so only one can pass at a time.

### What was added (additive, no breaking changes)

| Artifact | Change |
|----------|--------|
| `supabase/migrations/026_usage_limit_atomic.sql` | `enforce_usage_limit(p_org_id)` — locks + checks + raises SQLSTATE `42901` if over. `insert_job_with_usage_check(...)` — atomic check + insert. `insert_document_with_usage_check(...)` — atomic check + document insert. |
| `src/lib/services/billing.service.ts` | `enforceUsageLimitOrThrow(client, orgId)` — calls the RPC, maps `42901` → `UsageLimitExceededError` (HTTP 429). `checkUsageLimit` (read path, for UI) is **unchanged** — it still works for display. |

### Read path vs write path

- **Read path** (`checkUsageLimit`): for the UI's "12/25 documents this month" progress display. Non-locking, eventually consistent. Fine for display.
- **Write path** (`enforceUsageLimitOrThrow` / `insert_document_with_usage_check`): for the upload flow. Locking, atomic. Must be used before any document/job creation.

---

## Running the Tests

### Pure-logic tests (no Supabase needed, run in CI sandbox)

```bash
bunx vitest run tests/unit-pure/09-storage-key-validation.test.ts
bunx vitest run tests/unit-pure/10-file-validation.test.ts
```

### Integration tests (require the new Supabase project + migrations applied)

```bash
# Set in .env first:
#   NEXT_PUBLIC_SUPABASE_URL=https://[NEW_PROJECT_REF].supabase.co
#   NEXT_PUBLIC_SUPABASE_ANON_KEY=[NEW_ANON_KEY]
# Apply migrations:
#   supabase/migrations-new/001_baseline_schema.sql
#   supabase/migrations-new/002_async_jobs.sql
#   supabase/migrations/026_usage_limit_atomic.sql

bunx vitest run tests/unit/13-storage-cross-org-isolation.test.ts
bunx vitest run tests/unit/12-usage-limit-enforcement.test.ts
```

These tests `describe.skipIf(!SUPABASE_URL || !SUPABASE_ANON_KEY)` — they skip cleanly in CI sandboxes without a backend, and run for real when credentials are present.

---

## What Phase 2 Does NOT Do

- **Does not cut over to the new project.** The old project is live and serving traffic. Phase 6 handles the data migration + cutover.
- **Does not delete old migrations.** `supabase/migrations/` (000–026) stays in the repo as the old project's history. The new project uses `supabase/migrations-new/`. Phase 6 will reconcile.
- **Does not wire the ingress Worker.** The Cloudflare Worker scaffolding is Phase 3. The file-validation + storage helpers are ready for it to import.
- **Does not decommission edge functions.** The old edge functions (in `supabase/functions/`) are already classified DEAD in `docs/actual-architecture.md`; their removal is Phase 6.

---

## Next: Phase 3

Phase 3 scaffolds the Cloudflare ingress Worker (`apps/ingress/`) which will:
1. Import `validateUploadedFile` from `@clearport/shared/file-validation` — reject invalid payloads before any Storage write.
2. Import `buildStorageKey` from `@clearport/shared/storage` — construct the org-scoped key.
3. Call `get_or_create_job` RPC — idempotent job creation.
4. Call `enforceUsageLimitOrThrow` — reject with HTTP 429 if over limit.
5. Upload to the `documents` bucket + insert a `documents` row.
6. Return HTTP 202 (async processing pattern preserved).

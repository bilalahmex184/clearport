# Phase 6 — Migration & Cutover Runbook

**Status**: Code complete. Operational execution is the operator's responsibility.

**Issues closed**: #11 (fully), #19 (fully), #21 (fully), #40 (fully).

---

## Overview

This is the two-project cutover from the OLD Supabase project (known-broken RLS history, potentially-exposed service-role key) to the NEW project (fresh account, clean schema from `001_baseline_schema.sql`). Because storage stayed on Supabase (Phase 2 decision), this is a **two-project cutover**, not just a storage move.

The migration is **gated by a per-org feature flag** (`use_new_pipeline` on the OLD project's `organizations` table). Every org starts on `FALSE` (old path) and is flipped to `TRUE` individually after its data is migrated + verified. **Rollback is a single column update** — flip the flag back to `FALSE` and the org immediately routes to the old path.

---

## The 5 steps

### Step 1 — Feature flag + dual-project selection ✅ (code complete)

| Artifact | Location |
|----------|----------|
| Feature flag migration | `supabase/migrations/007_feature_flag_cutover.sql` — adds `use_new_pipeline BOOLEAN DEFAULT FALSE` to `organizations` + `is_org_on_new_pipeline()` RPC |
| Dual-project credential selection | `apps/ingress/src/project-config.ts` — `resolveProject(env, orgId)` reads the flag from the OLD project per-request, returns the NEW or OLD `ProjectConfig` |
| Ingress Worker wiring | `apps/ingress/src/index.ts` — calls `resolveProject` after auth, passes `ProjectConfig` to all supabase-client calls |
| Auth always checks OLD | `apps/ingress/src/auth.ts` — JWT + membership verification always goes to the OLD project (authoritative for users during transition) |

**How it works**: The ingress Worker has both projects' credentials in its env (`OLD_SUPABASE_*` + `NEW_SUPABASE_*`). For every upload request, it reads the flag from the OLD project. If `TRUE`, the upload + job creation go to the NEW project; if `FALSE`, they stay on the OLD path. Fail-safe: on any flag-check error, route to OLD (the known-good path).

**Rollback**: `UPDATE organizations SET use_new_pipeline = FALSE WHERE id = '{org_id}';` — the org immediately reverts to the old path. No data loss (both projects are live).

### Step 2 — Migration scripts ✅ (code complete, reusable)

The three scripts are **reusable functions** — run them twice: once for the test org, once for remaining orgs in batches.

#### Step 2a — Auth users
| Artifact | Location |
|----------|----------|
| Script | `scripts/migrate-auth-users.ts` |
| Test | `tests/unit/17-migrate-auth-users.test.ts` (18 tests) |

**What it does**: Exports users from the OLD project via the Management API, filters to the target org's members, re-creates them in the NEW project (no password — forces magic-link re-auth), builds a `{oldUserId → newUserId}` map file, sends a password-reset email to each migrated user.

**Critical**: Supabase auth users don't port cleanly (password hashes are project-scoped). **Tell your users this is coming BEFORE you run it**, not after — they'll get a magic-link email to set up access to the new project.

**Usage**:
```bash
bun run scripts/migrate-auth-users.ts <orgId> [--dry-run]
# Env: OLD_SUPABASE_REF, NEW_SUPABASE_REF, SUPABASE_MANAGEMENT_TOKEN,
#      OLD_SUPABASE_URL, OLD_SUPABASE_SERVICE_ROLE_KEY,
#      NEW_SUPABASE_URL, NEW_SUPABASE_ANON_KEY
# Output: scripts/migration-output/{orgId}-user-id-map.json
```

#### Step 2b — Business tables
| Artifact | Location |
|----------|----------|
| Script | `scripts/migrate-business-tables.ts` |
| Test | `tests/unit/18-migrate-business-tables.test.ts` (6 tests) |

**What it does**: Exports the org's data from 16 tables (organizations, organization_members, shipments, documents, document_fields, exceptions, etc.) from the OLD project, remaps `user_id` columns using the map from Step 2a, inserts into the NEW project in dependency order. Idempotent (re-running skips existing rows). Skips `usage_limits` (config, already seeded).

**Usage**:
```bash
bun run scripts/migrate-business-tables.ts <orgId> [--dry-run]
# Env: OLD_SUPABASE_URL, OLD_SUPABASE_SERVICE_ROLE_KEY,
#      NEW_SUPABASE_URL, NEW_SUPABASE_SERVICE_ROLE_KEY,
#      USER_ID_MAP_FILE=scripts/migration-output/{orgId}-user-id-map.json
```

#### Step 2c — Storage objects
| Artifact | Location |
|----------|----------|
| Script | `scripts/migrate-storage-objects.ts` |
| Test | `tests/unit/19-migrate-storage-objects.test.ts` (7 tests) |

**What it does**: Downloads each document from the OLD project's `documents` bucket, **re-keys to the corrected convention** (`{org_id}/{shipment_id}/{uuid}-{sanitized}` from Phase 2 Step 1 — NOT a literal copy of the old broken `{user_id}/...` paths), uploads to the NEW project's bucket, **verifies byte-for-byte integrity** (SHA-256 hash comparison), updates the `documents` row with the new `storage_path`.

**Usage**:
```bash
bun run scripts/migrate-storage-objects.ts <orgId> [--dry-run]
# Env: OLD_SUPABASE_URL, OLD_SUPABASE_SERVICE_ROLE_KEY,
#      NEW_SUPABASE_URL, NEW_SUPABASE_SERVICE_ROLE_KEY
```

### Step 3 — Test org verification (OPERATIONAL — you execute)

**This is the step that takes "a few real business days."** I can't automate it — it requires running real documents through the new path and observing the results.

#### 3.1 Run the migration scripts for your test org
```bash
# In order:
bun run scripts/migrate-auth-users.ts <your-test-org-id>
bun run scripts/migrate-business-tables.ts <your-test-org-id>
bun run scripts/migrate-storage-objects.ts <your-test-org-id>
```

#### 3.2 Flip the feature flag
```sql
-- On the OLD project:
UPDATE organizations SET use_new_pipeline = TRUE WHERE id = '<your-test-org-id>';
```

#### 3.3 Run real documents through it
Upload real business documents (not just synthetic fixtures) via the app. Confirm:
- **Uploads succeed** — files appear in the NEW project's `documents` bucket + `documents` table.
- **Files are retrievable by org members** — the `createSignedDownloadUrl` helper works against the NEW project.
- **Files are NOT retrievable by other orgs** — re-run the cross-org isolation test (`tests/unit/20-cutover-verification.test.ts` + `13-storage-cross-org-isolation.test.ts`) against the NEW project's data shape.
- **Extraction quality matches or exceeds the old path** — compare the extracted fields + confidence on the same document uploaded to both paths.
- **Dead-letter + retry behavior works** — induce a real failure:
  1. Temporarily revoke the OpenRouter key (`wrangler secret put OPENROUTER_API_KEY` with an invalid value in the consumer Worker).
  2. Upload a document.
  3. Confirm the job falls through to Tesseract (Tier 4) rather than getting stuck in 'processing'.
  4. Confirm a `job_attempts` row exists for tier 1 with `status='failure'`.
  5. Restore the OpenRouter key.
- **Do NOT delete anything in the old project for this org yet** — leave it as a fallback until every remaining org has also been migrated.

#### 3.4 Run the verification tests
```bash
# Set env vars for both projects, then:
bunx vitest run tests/unit/20-cutover-verification.test.ts
```

These tests verify the test org exists in the NEW project, cross-org isolation holds, and the graceful-failure path works.

### Step 4 — Batch migration (OPERATIONAL — you execute)

Only after Step 3 passes across real usage for a few business days:

1. **Pick a batch** of orgs (not all at once — start with 2-3 low-traffic orgs).
2. **Run the migration scripts** (2a → 2b → 2c) for each org in the batch.
3. **Flip each org's feature flag** to `TRUE` immediately after its data lands + passes verification.
4. **Watch the Phase 5 dashboard** (`/api/metrics`) for error-rate changes after each batch:
   - Tier success rate should stay stable.
   - Dead-letter queue depth should stay near zero.
   - p95/p99 latency should stay within the `PIPELINE_DEADLINE_MS` budget.
5. **If any batch shows problems**: flip the flag back to `FALSE` for the affected orgs (instant rollback), investigate, fix, re-migrate.
6. **Repeat** until all orgs are migrated.

### Step 5 — Final cleanup (OPERATIONAL — you execute)

Only after ALL orgs are migrated AND stable on the new path for a **full billing cycle**:

1. **Take a final export/backup** of the old Supabase project (in case you need data from it later).
2. **Run the cleanup script**:
   ```bash
   ./scripts/cleanup-deprecated.sh
   ```
   This deletes (not quarantines):
   - `/deprecated/` (the Phase 1 quarantine dir)
   - `supabase/functions/extract-document/`, `math-validate/`, `cross-validate/`, etc. (ported to the new architecture in Phase 4)
   - Keeps `supabase/functions/get-document-url/` (still called by `DocumentViewer.tsx` — remove after a frontend update)
3. **Pause or delete the old Supabase project** in the dashboard — it has served its purpose as the safety net during cutover and doesn't need to keep running (and billing).

---

## What I built vs what you execute

| Step | Code (I built) | Operational (you execute) |
|------|----------------|---------------------------|
| 1 — Feature flag | `007_feature_flag_cutover.sql` + `project-config.ts` + ingress wiring | Apply the migration to the OLD project |
| 2a — Auth users | `scripts/migrate-auth-users.ts` + tests | Run the script for the test org, then batches |
| 2b — Business tables | `scripts/migrate-business-tables.ts` + tests | Run the script for the test org, then batches |
| 2c — Storage objects | `scripts/migrate-storage-objects.ts` + tests | Run the script for the test org, then batches |
| 3 — Test org verification | `tests/unit/20-cutover-verification.test.ts` | Run real documents through for a few business days |
| 4 — Batch migration | (reuses Step 2 scripts) | Run for batches, watch the dashboard, rollback if needed |
| 5 — Final cleanup | `scripts/cleanup-deprecated.sh` | Take final backup, run the script, decommission old project |

---

## Rollback plan

At any point during the cutover, you can roll back an org to the old path:

```sql
-- On the OLD project:
UPDATE organizations SET use_new_pipeline = FALSE WHERE id = '{org_id}';
```

The org immediately routes to the old path again. No data loss — both projects are live during the transition. The old project stays up until Step 5 (final cleanup).

**When to roll back**:
- Extraction quality regresses for the org.
- Error rate spikes on the Phase 5 dashboard after flipping the flag.
- Cross-org isolation fails (a user sees another org's data).
- Any unexplained behavior in the new path.

Rollback is safe + instant. Investigate the issue, fix, re-migrate, re-flip.

---

## Critical reminders

1. **Tell users about the password reset BEFORE running Step 2a.** They'll get a magic-link email — if it's a surprise, they'll think it's a phishing attempt.
2. **Don't delete anything in the old project until Step 5.** The old project is the safety net. Deleting data mid-cutover removes the rollback option.
3. **Watch the dashboard after every batch.** The `/api/metrics` endpoint exists for this — check tier success rate, dead-letter depth, and latency after each flip.
4. **The feature flag is the single point of control.** One SQL query flips an org. One SQL query rolls it back. No code deploy needed.
5. **The scripts are idempotent + resumable.** If a script crashes mid-way, re-run it — it skips already-migrated rows/objects.

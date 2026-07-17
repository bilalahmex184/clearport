# ClearPort — Customs Compliance & Exception Management Platform

Production-grade customs document extraction, validation, and exception management system.

## Tech Stack
- **Frontend**: Next.js 16 + React 19 + TypeScript + Tailwind CSS
- **Backend**: Supabase (Postgres + RLS + Edge Functions + Storage + Auth)
- **AI/OCR**: Google Gemini (4-stage fallback chain) + self-hosted Tesseract.js
- **Testing**: Vitest (54 integration + 175 pure unit tests) + Playwright

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Set up environment
cp .env.example .env
# Fill in your Supabase URL, anon key, and management token

# 3. Run database migrations
# Go to Supabase SQL Editor and run migrations 000 through 016 in order
# (every file in supabase/migrations/, sorted by filename).
# 000_baseline_schema.sql creates the 6 core tables + users_profile + storage
# bucket + helper functions that migrations 001-016 ALTER.

# 4. Deploy edge functions
npx supabase login
npx supabase link --project-ref your-project-ref
npx supabase secrets set GEMINI_API_KEY=your-key
npx supabase secrets set ALLOWED_ORIGIN=http://localhost:3000
for fn in upload-document extract-document cross-validate schema-validate math-validate flag-exceptions get-shipments update-exception batch-accept export-csv get-document-url; do
  npx supabase functions deploy $fn --no-verify-jwt
done

# 5. Start the dev server
bun run dev

# 6. Run tests
bun run test
```

## Architecture

```
Upload (bulk, 3-concurrent, deduped, validated)
    ↓
Document stored, status = 'queued'
    ↓
┌──── 4-STAGE EXTRACTION FALLBACK CHAIN ────┐
│ 1. Gemini Vision (primary)                │
│    ↓ fails / quota exhausted / timeout    │
│ 2. PDF text-layer extraction              │
│    ↓ no embedded text (genuine scan)      │
│ 3. Tesseract OCR (self-hosted, free)      │
│    ↓ all three failed                     │
│ 4. Mark 'needs_manual_review'             │
│    NEVER silent zero extraction           │
│    18s wall-clock budget across all tiers │
└───────────────────────────────────────────┘
    ↓
document_fields written, tagged with extraction_source
    ↓
schema-validate / math-validate / cross-validate (parallel)
    ↓
flag-exceptions (configurable rule engine)
    ↓
Exception Desk (human review)
```

## Features
- Multi-tenant with RBAC (admin/operator/viewer)
- Org-scoped RLS on all tables
- Invite-by-email with token validation
- 4-stage extraction fallback (never silent zero, 18s wall-clock budget)
- Configurable validation rules (no redeploy to change)
- Broker template system (import/export CSV mapping)
- Audit logs with type + date range filters
- Rate limiting (50 extractions/hour/org)
- Stuck document reconciliation (pg_cron every 10 min)
- Bulk upload with concurrency limit + dedup
- 54 integration tests (security, workflow, mapping, invite, performance)
- 175 pure unit tests (no network required, run in ~2s)
- 20 test fixtures covering messy real-world documents

## Observability & Error Handling

### Live (wired into the running app)
- **Request middleware** (`src/proxy.ts` → `src/middleware/index.ts#requestMiddleware`): runs on every matched request, generates a `request_id`, emits one structured JSON log line, stamps the response with `X-Request-Id`, and propagates the id to downstream route handlers via the `x-request-id` header. Lightweight — no DB, no auth, no body parsing.
- **Structured logger** (`src/lib/utils/logger.ts`): JSON-formatted entries with timestamp/level/message/data. Used by all server-side route handlers and services.
- **Error handler** (`src/lib/utils/error-handler.ts`): `AppError` class + `errorResponse()` helper used by every live API route to normalize thrown values into `{ error, code, details }` JSON responses.
- **Validation system** (`src/lib/validation/index.ts`): Zod schemas + cross-field validators (weight consistency, HTS format, country code, declared value) + `validateOrThrow()` wrapper. Currently the only consumer of `ValidationError` from `src/lib/errors/`.

### Inert (implemented but not yet wired into live routes)
These modules exist as production-ready infrastructure but are not yet called by live route handlers. They are type-checked and compile cleanly; wiring them in is tracked as follow-up work.

- **Rich error taxonomy** (`src/lib/errors/index.ts`): `ClearPortError` base + `ValidationError`/`BusinessError`/`InfrastructureError`/`ExternalAPIError` subclasses with category/severity/retryable/context/userMessage. `toErrorResponse()` produces a richer shape (`{ error: { code, category, message, severity, retryable, field?, suggestion?, context?, request_id? } }`) than the live `errorResponse()`. Consolidating the two is a known follow-up — they currently produce different response shapes, so a switch would require auditing every route + frontend error reader + tests.
- **UI error hooks** (`src/lib/errors/ui-errors.ts`): `useUIError()` + `useAsyncAction()` React hooks with auto-dismiss + field-error tracking. Live frontend currently uses `useToast` from shadcn/ui instead.
- **Observability logger** (`src/lib/observability/logger.ts`): richer logger with request-scoped context (`createRequestContext`/`traceRequest`/`startStage`/`endStage`), `traceExternalCall()` for third-party API tracing. Used by the middleware and by the inert errors/reliability/audit modules; NOT used by live route handlers (they use the simpler `src/lib/utils/logger.ts`).
- **Reliability primitives** (`src/lib/observability/reliability.ts`): `withRetry()` (exponential backoff, retries only `InfrastructureError`/`ExternalAPIError`/network errors), `withFallback()`, `processWithPartialFailure()`, `neverSilent()`. Live code uses inline retry loops in `ClearPortContext.tsx` instead.
- **Audit trail** (`src/lib/observability/audit.ts`): `writeAuditRecord()` + `queryAuditTrail()` + `replayAction()` for deterministic replay. Live audit logging uses `audit_logs` table inserts directly via `audit-log.service.ts`.
- **Pipeline orchestrator** (`src/lib/pipeline/orchestrator.ts`): generic stage runner with trace_id, idempotency_key, degraded_mode flag, audit_trail, `runStage()` guardrails (skips if previous stage failed), `finalizePipeline()` decision (approved/rejected/needs_review). NOT a duplicate of the Supabase edge function — the edge function does OCR/extraction; this orchestrator runs at a higher level (extract → validate → flag). The inline pipeline runner in `src/context/ClearPortContext.tsx#runPipeline` does the same job browser-side; refactoring it to use the orchestrator is a known follow-up.
- **Pipeline metrics + missing-field detector + cross-validator** (`src/lib/pipeline/metrics.ts`, `missing-field-detector.ts`, `cross-validator.ts`): all type-checked, none currently invoked.
- **Per-route `withMiddleware` wrapper** (`src/middleware/index.ts#withMiddleware`): opt-in route-handler wrapper that adds `traceRequest()` + auto `toErrorResponse()` on uncaught throws. Not currently used by any live route (would require migrating routes one-by-one and updating frontend error readers to the richer error shape).

### Edge runtime note
Next.js 16 runs middleware on the Edge runtime by default. The observability logger (`src/lib/observability/logger.ts`) was made Edge-safe by replacing `import { randomUUID } from 'crypto'` with the global `crypto.randomUUID()` (available in Node 19+, browsers, and Edge). This keeps the structured logger usable from both the middleware and server-side route handlers.

### Known issues
- **Error taxonomy consolidation**: `src/lib/errors/index.ts` and `src/lib/utils/error-handler.ts` produce different error response shapes. Consolidating them requires auditing every route + frontend error reader. Tracked as follow-up.
- **Pipeline orchestrator**: `src/lib/pipeline/orchestrator.ts` is a generic stage runner that could replace the inline pipeline in `ClearPortContext.tsx#runPipeline`. Tracked as follow-up.
- **react-hooks/exhaustive-deps**: currently disabled in eslint config to avoid noise; re-enabling would surface ~15 dependency-array warnings to fix.

## Extraction Audit Ledger

Every extraction attempt — success, failure, or skip — is permanently recorded in the `extraction_attempts` table (migration 017). Each row captures: document_id, org_id, pipeline_trace_id, tier (1-4), tier_name, status (success/failure/skipped), fields_extracted, error_code, error_message, and latency_ms.

A single `pipeline_trace_id` threads through every tier for one document, so you can reconstruct the full story end-to-end:

```sql
SELECT tier, tier_name, status, fields_extracted, error_message, latency_ms, created_at
FROM extraction_attempts
WHERE document_id = '<doc-uuid>'
ORDER BY created_at;
```

### API surface
- `GET /api/documents/[id]/extraction-trace` — returns the full tier-by-tier timeline for a document (org-scoped, viewer+).
- `GET /api/extraction-health` — returns 24h success rates by tier + the manual-review queue (documents in `needs_manual_review`, oldest-first). Doubles as the operational queue an admin works from.

### UI surface
- **Extraction Trace panel** (in EntryDetailView): expandable tier-by-tier timeline with status badges, latency, and error messages.
- **Extraction Health panel** (in Dashboard/Command Center): success rate by tier over the last 24h + clickable manual-review queue, auto-refreshing every 30s.

## Cost

This pipeline runs at **$0/month** at the current 10-user MVP scale:

- **Gemini Vision** (Tier 1): Google's free tier provides 1,000+ requests/day (refreshed daily), far more than 10 users will generate. No credit card required. If volume ever exceeds the free tier, Gemini Flash is one of the cheapest paid options on the market — verify current pricing at [ai.google.dev/pricing](https://ai.google.dev/pricing) before committing.
- **Tesseract OCR** (Tier 3): self-hosted via `tesseract.js` (pure WASM, no GPU, no native binary). Runs as a Node.js API route within the existing Next.js app — no additional infrastructure cost.
- **Postgres + Storage + Auth + Edge Functions**: Supabase free tier (500MB DB, 1GB storage, 50K monthly active users). No paid dependencies.
- **Process management**: pm2 (open source, free). No external monitoring SaaS required.

The only paid cost that could arise is if Gemini volume exceeds the free tier — at which point a paid Gemini plan is the sole incremental expense. No other part of the stack has a per-request or per-user cost.


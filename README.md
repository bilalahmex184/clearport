# ClearPort — Customs Compliance & Exception Management Platform

Production-grade customs document extraction, validation, and exception management system.

## Tech Stack
- **Frontend**: Next.js 16 + React 19 + TypeScript + Tailwind CSS
- **Backend**: Supabase (Postgres + RLS + Edge Functions + Storage + Auth)
- **AI/OCR**: Google Gemini (5-tier fallback chain)
- **Testing**: Vitest (54 tests) + Playwright

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Set up environment
cp .env.example .env
# Fill in your Supabase URL, anon key, and management token

# 3. Run database migrations
# Go to Supabase SQL Editor and run all files in supabase/migrations/ in order

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
┌──── 5-TIER EXTRACTION FALLBACK CHAIN ────┐
│ 1. Gemini Pro vision (primary)            │
│    ↓ fails / quota exhausted              │
│ 2. PDF text-layer extraction              │
│    ↓ no embedded text (genuine scan)      │
│ 3. Cloud Vision OCR (placeholder)         │
│    ↓ fails / quota exhausted              │
│ 4. Tesseract OCR (local, zero quota)      │
│    ↓ all four failed                      │
│ 5. Mark 'needs_manual_review'             │
│    NEVER silent zero extraction           │
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
- 5-tier extraction fallback (never silent zero)
- Configurable validation rules (no redeploy to change)
- Broker template system (import/export CSV mapping)
- Audit logs with type + date range filters
- Rate limiting (50 extractions/hour/org)
- Stuck document reconciliation (pg_cron every 10 min)
- Bulk upload with concurrency limit + dedup
- 54 automated tests (security, workflow, mapping, invite, performance)
- 20 test fixtures covering messy real-world documents

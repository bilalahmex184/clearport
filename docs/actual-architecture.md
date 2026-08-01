# Actual Architecture — Pipeline File Classification

**Purpose**: Ground truth for the remediation plan. Every pipeline-related
file in the repo, classified as LIVE or DEAD based on tracing actual call
sites from the live upload flow (`src/context/use-shipments.ts#uploadDocuments`),
not comments or documentation.

**Generated**: Phase 0, Step 3 of the remediation plan.

---

## Live Upload Flow (traced)

```
use-shipments.ts#uploadDocuments
  ├── supabase.storage.from('documents').upload()     ← direct storage upload
  ├── supabase.from('documents').insert()              ← direct DB insert
  └── apiFetchOrg('/api/internal/extract-and-validate') ← POST to Next.js route (202 async)
        └── route.ts#processExtraction (fire-and-forget, runs after 202 response)
              ├── extractPdfText() via pdfjs-dist       ← PDF text extraction
              ├── callAIExtraction() via OpenRouter     ← AI extraction (Qwen VL)
              ├── mapToCanonicalSchema()                ← canonical field mapping
              ├── runPipeline() from pipeline.ts        ← full validation pipeline
              ├── regexExtract() from regex-extract.ts  ← regex fallback
              └── client.from('document_fields').insert() ← DB writes
```

The polling effect in `use-shipments.ts` (every 4s) calls
`GET /api/shipments/:id` to detect when `validation_status` flips to
`completed` or `degraded`.

---

## File Classification

### LIVE — Reachable from the live upload flow

| File | Evidence |
|------|----------|
| `src/context/use-shipments.ts` | Entry point. `uploadDocuments()` calls `/api/internal/extract-and-validate` via `apiFetchOrg`. Polling effect refreshes shipment status. |
| `src/app/api/internal/extract-and-validate/route.ts` | POST handler returns 202 instantly, then `processExtraction()` runs async. Imports `callAIExtraction`, `mapToCanonicalSchema`, `runPipeline`, `regexExtract`. |
| `src/lib/extraction/ai-extract.ts` | `callAIExtraction()` called by route.ts when `isAIProviderConfigured()` returns true. Calls OpenRouter API with Qwen VL models. |
| `src/lib/extraction/canonical-schema.ts` | `mapToCanonicalSchema()` called by route.ts to normalize AI field keys to canonical names. |
| `src/lib/extraction/pipeline.ts` | `runPipeline()` called by route.ts. Contains: doc classifier, schema registry, validators, severity engine, decision engine, shipment resolver, reconciliation, field discovery, OCR ensemble, confidence composite, audit trail, human review routing. |
| `src/lib/extraction/regex-extract.ts` | `regexExtract()` called by route.ts as fallback when AI returns 0 fields. Also imported by tests. |
| `src/context/use-org.ts` | Provides `apiFetchOrg` wrapper (injects X-Org-Id header) used by uploadDocuments. Also bootstraps demo org. |
| `src/lib/services/auth.service.ts` | `requireOrgRole()` called by route.ts. `ensureDemoOrg()` auto-provisions org in demo mode. |
| `src/components/clearport/DocumentViewer.tsx` | `invokeEdgeFunction('get-document-url')` called to fetch signed URLs for document preview. This is the ONLY live edge function call from the frontend. |

### DEAD — Not reachable from the live upload flow

| File | Evidence |
|------|----------|
| `src/context/inline-pipeline.ts` | DEAD — `runInlinePipeline` is defined in `use-shipments.ts` (line 502) and imports from this file, but the function is NEVER CALLED in the live flow. The upload flow calls `/api/internal/extract-and-validate` instead (line 622). The `runInlinePipeline` reference exists as a dead callback in the deps array but is never invoked. |
| `src/lib/pipeline/orchestrator.ts` | DEAD — zero import sites in `src/`. Grep confirms no file imports `pipeline/orchestrator`. |
| `src/lib/pipeline/index.ts` | DEAD — zero import sites in `src/` outside the pipeline directory itself. Nothing in the app imports from `@/lib/pipeline`. |
| `src/lib/pipeline/cross-validator.ts` | DEAD — zero import sites. Only imported by `pipeline/index.ts` which is itself dead. |
| `src/lib/pipeline/metrics.ts` | DEAD — zero import sites. |
| `src/lib/pipeline/missing-field-detector.ts` | DEAD — zero import sites. |
| `src/lib/pipeline/types.ts` | DEAD — only imported by `pipeline/orchestrator.ts` (dead) and `src/lib/rules/engine.ts`. The rules engine is not called from the upload flow. |
| `supabase/functions/extract-document/index.ts` | DEAD — the live route (`extract-and-validate/route.ts`) runs AI extraction directly in the Next.js Node runtime. The edge function is never called from the live upload flow. `inline-pipeline.ts` calls it, but `inline-pipeline.ts` is dead. |
| `supabase/functions/extract-document/lib/gemini.ts` | DEAD — only imported by the dead `extract-document/index.ts` edge function. |
| `supabase/functions/extract-document/lib/regex-extract.ts` | DEAD — only imported by the dead edge function. The live regex fallback is `src/lib/extraction/regex-extract.ts`. |
| `supabase/functions/upload-document/index.ts` | DEAD — the live upload flow uses `supabase.storage.from('documents').upload()` directly from the browser. This edge function is never called. |
| `supabase/functions/flag-exceptions/index.ts` | DEAD — exception flagging is now done inside `route.ts#processExtraction()` and `pipeline.ts#runPipeline()`. Never called from the live flow. |
| `supabase/functions/cross-validate/index.ts` | DEAD — cross-document validation is now in `pipeline.ts#reconcileCluster()`. Never called from the live flow. |
| `supabase/functions/math-validate/index.ts` | DEAD — math validation is in `pipeline.ts#runFieldValidators()`. Never called. |
| `supabase/functions/schema-validate/index.ts` | DEAD — schema validation is in `pipeline.ts#checkRequiredFields()`. Never called. |
| `supabase/functions/batch-accept/index.ts` | DEAD — not called from any live path. Was part of the old edge function chain. |
| `supabase/functions/export-csv/index.ts` | DEAD — CSV export is handled by `src/app/api/export/[id]/route.ts` (Next.js API route, not edge function). |
| `supabase/functions/get-shipments/index.ts` | DEAD — shipments are fetched via `src/app/api/shipments/route.ts` (Next.js API route). |
| `supabase/functions/update-exception/index.ts` | DEAD — exception updates go through `src/app/api/exceptions/[id]/route.ts`. |
| `supabase/functions/get-document-url/index.ts` | SEMI-LIVE — called by `DocumentViewer.tsx` via `invokeEdgeFunction('get-document-url')`. This is the ONLY edge function still called from the frontend. If Supabase edge functions are not deployed, the DocumentViewer falls back to `supabase.storage.createSignedUrl()` directly. |
| `workers/api-gateway/index.ts` | DEAD — Cloudflare Worker. Never deployed. Zero references from `src/`. |
| `workers/queue-processor/index.ts` | DEAD — Cloudflare Worker. Never deployed. Zero references from `src/`. |
| `workers/queue-processor/validator.ts` | DEAD — only imported by the dead queue-processor. |
| `workers/queue-processor/prompt.ts` | DEAD — only imported by the dead queue-processor. |
| `workers/cloudflare-types.d.ts` | DEAD — type definitions for dead Cloudflare Workers. |
| `mini-services/worker/index.ts` | DEAD — the worker polls `processing_jobs` table, but the live upload flow no longer inserts into `processing_jobs` (it calls the Next.js route directly). The worker is started by `dev.sh` but has no jobs to process. |
| `mini-services/worker/package.json` | DEAD — package definition for the dead worker. |
| `src/app/api/internal/ocr/route.ts` | DEAD — was Tier 3 of the old extraction cascade. The live route (`extract-and-validate`) uses `pdfjs-dist` for PDF text extraction, not tesseract.js. Zero call sites from the live flow. |
| `src/lib/processing/preprocess.ts` | DEAD — image preprocessing for the dead OCR route. Zero import sites outside the dead OCR route. |
| `src/lib/processing/postprocess.ts` | DEAD — OCR text cleanup for the dead OCR route. Zero import sites outside the dead OCR route. |
| `src/lib/scoring/confidence.ts` | DEAD — confidence scoring for the old pipeline. The live pipeline uses `pipeline.ts#computeComposite()` instead. |
| `src/lib/observability/reliability.ts` | DEAD — zero import sites in `src/`. |
| `src/lib/observability/audit.ts` | DEAD — zero import sites in `src/`. |
| `src/lib/observability/logger.ts` | DEAD — the live code uses `@/lib/utils/logger` instead. |

---

## Summary

| Status | Count |
|--------|-------|
| LIVE | 9 files |
| DEAD | 30+ files |
| SEMI-LIVE | 1 file (`get-document-url` edge function) |

The live extraction pipeline is **entirely contained in 6 files**:
1. `src/context/use-shipments.ts` (upload trigger)
2. `src/app/api/internal/extract-and-validate/route.ts` (async 202 handler)
3. `src/lib/extraction/ai-extract.ts` (AI extraction via OpenRouter)
4. `src/lib/extraction/canonical-schema.ts` (field mapping)
5. `src/lib/extraction/pipeline.ts` (validation + decision engine)
6. `src/lib/extraction/regex-extract.ts` (regex fallback)

Everything else — the edge functions, the Cloudflare Workers, the mini-service
worker, the old pipeline orchestrator, the OCR route, the processing libs —
is dead code that should be removed in Phase 1.

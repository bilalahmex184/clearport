# Deprecated Code — Quarantine Zone

**Status**: These files are NOT reachable from the live upload flow. They are
preserved here as a fallback in case the new pipeline needs to be rolled back.

**Scheduled removal**: Phase 6 (once the new pipeline is verified live in production).

**Do NOT import from `/deprecated/` in any new code.** A CI check
(`.github/workflows/ci.yml`) fails the build if any file outside
`/deprecated/` imports from it.

## Contents

| Path | Why it's dead |
|------|---------------|
| `inline-pipeline.ts` | Old edge function cascade (extract-document → schema-validate → math-validate → cross-validate → flag-exceptions). The live flow calls `/api/internal/extract-and-validate` instead. |
| `pipeline/` | Old pipeline orchestrator, cross-validator, metrics, missing-field-detector. Superseded by `src/lib/extraction/pipeline.ts`. |
| `ocr-route/` | Tesseract.js OCR endpoint (Tier 3 of old cascade). Live flow uses pdfjs-dist for PDF text extraction. |
| `processing/` | Image preprocessing/postprocessing for the dead OCR route. |
| `scoring/` | Old confidence scoring. Live pipeline uses `pipeline.ts#computeComposite()`. |
| `observability/` | Old audit/logger modules. Live code uses `@/lib/utils/logger`. |
| `workers/` | Cloudflare Workers (api-gateway, queue-processor). Never deployed. |
| `mini-services/` | Queue worker (polls processing_jobs table). Live flow no longer uses processing_jobs. |

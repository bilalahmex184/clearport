#!/usr/bin/env bash
# ============================================================================
# cleanup-deprecated.sh — Phase 6 Step 5 (post-cutover cleanup)
# ============================================================================
# WHAT THIS DOES
#   Deletes everything in /deprecated/ + the now-fully-ported old edge
#   functions. This runs ONLY after ALL orgs are migrated to the new
#   pipeline AND stable for a full billing cycle.
#
# WHAT GETS DELETED
#   - /deprecated/ (the Phase 1 quarantine dir: workers/, mini-services/,
#     inline-pipeline.ts, ecosystem.config.js, the Dockerfile, .zscripts/,
#     watchdog.sh, start-dev.sh, start-prod.sh)
#   - /supabase/functions/extract-document/ (ported to apps/consumer in Phase 4)
#   - /supabase/functions/math-validate/ (ported to packages/shared in Phase 4)
#   - /supabase/functions/cross-validate/ (ported to packages/shared in Phase 4)
#   - /supabase/functions/schema-validate/ (replaced by the Zod schema in Phase 4)
#   - /supabase/functions/flag-exceptions/ (replaced by the pipeline exceptions)
#   - /supabase/functions/batch-accept/ (dead — not called by the live flow)
#   - /supabase/functions/upload-document/ (replaced by the ingress Worker)
#   - /supabase/functions/get-shipments/ (replaced by the Next.js API route)
#   - /supabase/functions/update-exception/ (replaced by the Next.js API route)
#   - /supabase/functions/export-csv/ (replaced by the Next.js API route)
#
# WHAT IS KEPT
#   - /supabase/functions/get-document-url/ — SEMI-LIVE (called by
#     DocumentViewer.tsx for signed URLs; kept until the frontend is updated
#     to use createSignedDownloadUrl directly). Marked for removal in a
#     follow-up frontend task.
#   - /upload/ directory (if it exists — gitignored, transient)
#
# SAFETY
#   This script PROMPTS for confirmation before deleting. It does NOT run
#   automatically. The operator must:
#     1. Confirm all orgs are on the new pipeline (use_new_pipeline=TRUE for all).
#     2. Confirm the new pipeline has been stable for a full billing cycle.
#     3. Take a final backup/export of the old Supabase project.
#     4. Run this script.
# ============================================================================

set -euo pipefail

echo "================================================================"
echo "Phase 6 Step 5 — Deprecation cleanup"
echo "================================================================"
echo ""
echo "This script DELETES (not quarantines) the deprecated code."
echo ""
echo "PRECONDITIONS (verify before proceeding):"
echo "  1. ALL orgs have use_new_pipeline=TRUE on the old project."
echo "  2. The new pipeline has been stable for a full billing cycle."
echo "  3. You have taken a final backup/export of the old Supabase project."
echo ""
echo "This CANNOT be undone (the files are deleted, not moved)."
echo ""
read -p "Have you verified all preconditions? Type 'DELETE' to proceed: " confirm

if [ "$confirm" != "DELETE" ]; then
  echo "Aborted — no files deleted."
  exit 0
fi

echo ""
echo "Deleting deprecated files..."

# /deprecated/ — the Phase 1 quarantine dir
if [ -d "deprecated" ]; then
  echo "  rm -rf deprecated/"
  rm -rf deprecated/
fi

# Old edge functions (ported to the new architecture in Phase 4)
for fn in extract-document math-validate cross-validate schema-validate \
          flag-exceptions batch-accept upload-document get-shipments \
          update-exception export-csv; do
  if [ -d "supabase/functions/$fn" ]; then
    echo "  rm -rf supabase/functions/$fn/"
    rm -rf "supabase/functions/$fn"
  fi
done

# NOTE: get-document-url is KEPT (still called by DocumentViewer.tsx).
# Remove it in a follow-up frontend task that switches to createSignedDownloadUrl.

# /upload/ — transient, gitignored
if [ -d "upload" ]; then
  echo "  rm -rf upload/ (transient)"
  rm -rf upload/
fi

echo ""
echo "================================================================"
echo "Cleanup complete. Verifying what remains..."
echo "================================================================"
echo ""
echo "Remaining in supabase/functions/:"
ls supabase/functions/ 2>/dev/null || echo "  (empty)"
echo ""
echo "deprecated/ dir:"
ls deprecated/ 2>/dev/null || echo "  (deleted — good)"
echo ""
echo "NOTE: supabase/functions/get-document-url/ is intentionally KEPT."
echo "      It's still called by DocumentViewer.tsx. Remove it after updating"
echo "      the frontend to use createSignedDownloadUrl from @clearport/shared."
echo ""
echo "NEXT: Decommission the old Supabase project (pause or delete it in the"
echo "      dashboard). It has served its purpose as the safety net during"
echo "      cutover and doesn't need to keep running."

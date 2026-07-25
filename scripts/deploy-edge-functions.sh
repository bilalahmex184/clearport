#!/usr/bin/env bash
# ============================================================================
# ClearPort — Edge Function Deployment Script
# ============================================================================
# Deploys all 12 edge functions to Supabase.
# Run after: npx supabase login && npx supabase link --project-ref YOUR-REF
# ============================================================================

set -euo pipefail

FUNCTIONS=(
  "upload-document"
  "extract-document"
  "cross-validate"
  "schema-validate"
  "math-validate"
  "flag-exceptions"
  "update-exception"
  "batch-accept"
  "export-csv"
  "get-document-url"
  "get-shipments"
  "evaluate-custom-rules"
)

echo "============================================"
echo "ClearPort Edge Function Deployment"
echo "============================================"
echo ""

# Check if supabase CLI is available
if ! command -v npx supabase &> /dev/null; then
  echo "ERROR: supabase CLI not found. Install with: npm install -g supabase"
  exit 1
fi

# Check if linked to a project
if ! npx supabase projects list 2>/dev/null | grep -q "."; then
  echo "ERROR: Not logged in or no project linked."
  echo "Run: npx supabase login && npx supabase link --project-ref YOUR-PROJECT-REF"
  exit 1
fi

echo "Deploying ${#FUNCTIONS[@]} edge functions..."
echo ""

SUCCESS=0
FAILED=0

for fn in "${FUNCTIONS[@]}"; do
  echo -n "  Deploying $fn... "
  if npx supabase functions deploy "$fn" --no-verify-jwt 2>&1 | grep -q "Deployed"; then
    echo "✓ SUCCESS"
    ((SUCCESS++))
  else
    echo "✗ FAILED"
    ((FAILED++))
  fi
done

echo ""
echo "============================================"
echo "Deployment complete: $SUCCESS succeeded, $FAILED failed"
echo "============================================"

# Set required secrets
echo ""
echo "Now set your secrets:"
echo "  npx supabase secrets set GEMINI_API_KEY=your-key"
echo "  npx supabase secrets set ALLOWED_ORIGIN=https://your-domain.com"
echo "  npx supabase secrets set OCR_SERVICE_URL=https://your-domain.com/api/internal/ocr"
echo "  npx supabase secrets set INTERNAL_OCR_SECRET=same-value-as-in-.env"
echo "  npx supabase secrets set GOOGLE_CLOUD_VISION_API_KEY=your-key  # optional"

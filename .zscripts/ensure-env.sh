#!/bin/bash
# ============================================================================
# ensure-env.sh — Restore critical env vars if .env loses them
# ============================================================================
# The .env file in this sandbox gets overwritten/reset periodically (likely
# by the sandbox snapshot/restore mechanism). This script ensures the
# critical Supabase + OCR vars are always present before the dev server starts.
#
# Usage: source ensure-env.sh  (or run it and it will patch .env in-place)
# ============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# --- Required vars (with their values) ---
# These are safe to commit — the anon key is public (protected by RLS),
# and INTERNAL_OCR_SECRET is only used between the edge function and our own
# Node route (not exposed to users).
declare -A REQUIRED_VARS=(
  ["NEXT_PUBLIC_SUPABASE_URL"]="https://apfsceomnnhefxkvjhkz.supabase.co"
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwZnNjZW9tbm5oZWZ4a3ZqaGt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MDI0ODQsImV4cCI6MjA5OTA3ODQ4NH0.TN_HXmJlNBw94ikW0zeTCgG7uEiZX1dpzVazau0pQ1s"
  ["NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL"]="https://apfsceomnnhefxkvjhkz.supabase.co/functions/v1"
  ["ALLOWED_ORIGIN"]="http://localhost:3000"
)

# INTERNAL_OCR_SECRET is generated once and persisted — don't overwrite if it exists
MISSING=0
for var_name in "${!REQUIRED_VARS[@]}"; do
  if ! grep -q "^${var_name}=" "$ENV_FILE" 2>/dev/null; then
    MISSING=$((MISSING + 1))
  fi
done

# Check INTERNAL_OCR_SECRET separately (it's a generated secret)
if ! grep -q "^INTERNAL_OCR_SECRET=" "$ENV_FILE" 2>/dev/null; then
  MISSING=$((MISSING + 1))
fi

if [ "$MISSING" -eq 0 ]; then
  exit 0
fi

echo "[ensure-env] Restoring $MISSING missing env var(s) in .env..."

# Append missing vars (don't overwrite existing ones)
for var_name in "${!REQUIRED_VARS[@]}"; do
  if ! grep -q "^${var_name}=" "$ENV_FILE" 2>/dev/null; then
    echo "[ensure-env] + ${var_name}"
    echo "${var_name}=${REQUIRED_VARS[$var_name]}" >> "$ENV_FILE"
  fi
done

# Generate INTERNAL_OCR_SECRET if missing
if ! grep -q "^INTERNAL_OCR_SECRET=" "$ENV_FILE" 2>/dev/null; then
  SECRET=$(openssl rand -hex 32)
  echo "[ensure-env] + INTERNAL_OCR_SECRET (generated)"
  echo "INTERNAL_OCR_SECRET=${SECRET}" >> "$ENV_FILE"
fi

echo "[ensure-env] .env restored — $(grep -c '=' "$ENV_FILE") vars present"

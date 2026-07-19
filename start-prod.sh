#!/usr/bin/env bash
# ============================================================================
# start-prod.sh — legacy start script for bare-metal pm2 deployment
# ============================================================================
# Canonical deployment is Docker (see Dockerfile + README "Deployment" section).
# This script is for hosts that use pm2 instead of Docker. It starts both
# the web server and the worker via ecosystem.config.js.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# Start or restart ClearPort via pm2
if pm2 describe clearport > /dev/null 2>&1; then
  echo "[start-prod] Restarting clearport..."
  pm2 restart ecosystem.config.js
else
  echo "[start-prod] Starting clearport..."
  pm2 start ecosystem.config.js
fi

# Save the process list so pm2 resurrects it on reboot
pm2 save

echo "[start-prod] ClearPort is running. Use 'pm2 logs clearport' to view logs."
echo "[start-prod] To enable auto-restart on boot, run: pm2 startup && pm2 save"

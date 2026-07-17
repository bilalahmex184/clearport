#!/usr/bin/env bash
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

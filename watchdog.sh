#!/usr/bin/env bash
# Health check for ClearPort — can be run via cron every minute.
# pm2 handles crash restarts automatically; this just checks HTTP health
# and logs if the app is unresponsive.

set -uo pipefail

RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/ 2>/dev/null || echo "000")

if [ "$RESPONSE" != "200" ] && [ "$RESPONSE" != "307" ]; then
  echo "[watchdog] Health check FAILED (HTTP $RESPONSE) — pm2 should auto-restart. If not, run: pm2 restart clearport"
  pm2 restart clearport 2>/dev/null || true
else
  echo "[watchdog] Health check OK (HTTP $RESPONSE)"
fi

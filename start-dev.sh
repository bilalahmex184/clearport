#!/bin/bash
cd /home/z/my-project
while true; do
  bun run next dev -p 3000 --webpack >> dev.log 2>&1
  echo "[$(date)] Restarting in 2s..." >> dev.log
  sleep 2
done

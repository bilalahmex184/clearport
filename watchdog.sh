#!/bin/bash
cd /home/z/my-project
while true; do
  NODE_OPTIONS="--max-old-space-size=1536" npx next start -p 3000 >> server.log 2>&1
  echo "[$(date)] Restarting..." >> server.log
  sleep 2
done

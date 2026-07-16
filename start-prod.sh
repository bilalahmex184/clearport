#!/bin/bash
cd /home/z/my-project
while true; do
  NODE_OPTIONS="--max-old-space-size=1024" npx next start -p 3000 >> server.log 2>&1
  echo "[$(date)] Server exited, restarting in 1s..." >> server.log
  sleep 1
done

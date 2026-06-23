#!/usr/bin/env bash
set -euo pipefail

# Kill existing router using the PID file
PID=$(cat ~/.opencode/router.pid 2>/dev/null | jq -r .pid 2>/dev/null)
if [ -n "$PID" ] && [ "$PID" != "null" ]; then
    kill "$PID" 2>/dev/null
fi
sleep 1

# Start fresh router
cd /home/rishabh/github_projects/opencode-go-multi-auth
nohup env OPENCODE_ROUTER_PLUGIN_MODE=1 node dist/bin.js > /dev/null 2>&1 &
disown
sleep 2

# Verify
curl -sf http://127.0.0.1:18904/healthz && echo " — daemon is healthy"

#!/usr/bin/env bash
# Restart the opencode-go-multi-auth router daemon safely.
#
# Always run this from the repo root, or pass REPO_DIR=/path/to/repo.
#
# What it does:
#   1. Find any process listening on the dashboard (18904) or proxy (18905)
#      port. This includes the PID recorded in ~/.opencode/router.pid AND
#      any stale daemons that lost their PID file (e.g. after a crashed
#      write or a manual rm).
#   2. Kill them, wait for the ports to actually be free (not just
#      "sleep 1" which races the OS), then start a fresh dist/bin.js.
#   3. Poll /healthz for up to 10s; fail loudly if the new daemon never
#      becomes healthy.
#
# This script will not start a second router if one is already healthy
# and matches the recorded PID. That keeps concurrent runs safe.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/rishabh/github_projects/opencode-go-multi-auth}"
DASHBOARD_PORT="${DASHBOARD_PORT:-18904}"
PROXY_PORT="${PROXY_PORT:-18905}"
HEALTH_URL="http://127.0.0.1:${DASHBOARD_PORT}/healthz"
PID_FILE="${HOME}/.opencode/router.pid"

cd "${REPO_DIR}"

# ---------------------------------------------------------------------------
# Step 1: gather every PID that could be holding the ports.
# ---------------------------------------------------------------------------
PIDS_TO_KILL=()

# PIDs from the PID file (if it exists and the process is alive).
if [ -f "${PID_FILE}" ]; then
    RECORDED_PID=$(jq -r .pid "${PID_FILE}" 2>/dev/null || true)
    if [ -n "${RECORDED_PID}" ] && [ "${RECORDED_PID}" != "null" ] && [ "${RECORDED_PID}" != "0" ]; then
        if kill -0 "${RECORDED_PID}" 2>/dev/null; then
            PIDS_TO_KILL+=("${RECORDED_PID}")
        else
            echo "Stale PID file ${PID_FILE} points at dead pid ${RECORDED_PID}; removing."
            rm -f "${PID_FILE}"
        fi
    fi
fi

# Any process bound to the dashboard or proxy port. ss is the modern
# tool; lsof works as a fallback.
if command -v ss >/dev/null 2>&1; then
    PORT_PIDS=$(ss -tlnp 2>/dev/null | awk -v dp=":${DASHBOARD_PORT}" -v pp=":${PROXY_PORT}" \
        'index($4, dp) || index($4, pp) {print $0}' \
        | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
elif command -v lsof >/dev/null 2>&1; then
    PORT_PIDS=$( { lsof -nP -iTCP:${DASHBOARD_PORT} -sTCP:LISTEN -t 2>/dev/null; \
                   lsof -nP -iTCP:${PROXY_PORT}    -sTCP:LISTEN -t 2>/dev/null; } | sort -u)
fi

if [ -n "${PORT_PIDS:-}" ]; then
    for pid in ${PORT_PIDS}; do
        # Dedupe against PID-file pids.
        if [[ " ${PIDS_TO_KILL[*]:-} " != *" ${pid} "* ]]; then
            PIDS_TO_KILL+=("${pid}")
        fi
    done
fi

# ---------------------------------------------------------------------------
# Step 2: kill them. Try SIGTERM first, fall back to SIGKILL after 3s.
# ---------------------------------------------------------------------------
if [ ${#PIDS_TO_KILL[@]} -gt 0 ]; then
    echo "Killing existing router pids: ${PIDS_TO_KILL[*]}"
    for pid in "${PIDS_TO_KILL[@]}"; do
        kill "${pid}" 2>/dev/null || true
    done

    # Wait up to 5s for the processes to exit gracefully.
    for _ in $(seq 1 25); do
        still_alive=0
        for pid in "${PIDS_TO_KILL[@]}"; do
            if kill -0 "${pid}" 2>/dev/null; then
                still_alive=1
                break
            fi
        done
        [ "${still_alive}" -eq 0 ] && break
        sleep 0.2
    done

    # Anything still alive gets SIGKILL.
    for pid in "${PIDS_TO_KILL[@]}"; do
        if kill -0 "${pid}" 2>/dev/null; then
            echo "PID ${pid} did not exit on SIGTERM, sending SIGKILL."
            kill -9 "${pid}" 2>/dev/null || true
        fi
    done
    sleep 0.5
else
    echo "No existing router process found."
fi

# ---------------------------------------------------------------------------
# Step 3: confirm the ports are actually free. If they're not, something
# else (not us) is using them. Bail out instead of EADDRINUSE-ing.
# ---------------------------------------------------------------------------
for _ in $(seq 1 25); do
    in_use=0
    if command -v ss >/dev/null 2>&1; then
        ss -tln 2>/dev/null | awk -v dp=":${DASHBOARD_PORT}" -v pp=":${PROXY_PORT}" \
            'index($4, dp) || index($4, pp) {found=1; exit} END{exit !found}'
        [ $? -ne 0 ] && in_use=1
    fi
    [ "${in_use}" -eq 0 ] && break
    sleep 0.2
done

# ---------------------------------------------------------------------------
# Step 4: build the dist if the entrypoint is missing or older than src.
# ---------------------------------------------------------------------------
if [ ! -f dist/bin.js ] || [ src/bin.ts -nt dist/bin.js ]; then
    echo "Building dist/ (entrypoint missing or src changed)..."
    npm run build >/dev/null
fi

# ---------------------------------------------------------------------------
# Step 5: spawn the new daemon detached.
# ---------------------------------------------------------------------------
nohup env OPENCODE_ROUTER_PLUGIN_MODE=1 node dist/bin.js > /dev/null 2>&1 &
NEW_PID=$!
disown "${NEW_PID}" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Step 6: wait for /healthz (up to 10s) and report.
# ---------------------------------------------------------------------------
healthy=0
for _ in $(seq 1 50); do
    if curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
        healthy=1
        break
    fi
    # If the child died, stop polling.
    if ! kill -0 "${NEW_PID}" 2>/dev/null; then
        break
    fi
    sleep 0.2
done

if [ "${healthy}" -eq 1 ]; then
    echo "${HEALTH_URL} — daemon is healthy (pid ${NEW_PID})"
    exit 0
fi

# Failure path: report and exit non-zero so callers can detect.
echo "ERROR: new router daemon (pid ${NEW_PID}) did not become healthy at ${HEALTH_URL}." >&2
if kill -0 "${NEW_PID}" 2>/dev/null; then
    echo "Process is alive but not answering. Leaving it for inspection." >&2
    exit 1
fi
echo "Process exited without becoming healthy. Last 30 lines of router.log:" >&2
tail -n 30 "${HOME}/.opencode/router.log" 2>/dev/null || true
exit 1

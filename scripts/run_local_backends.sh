#!/usr/bin/env bash
set -e

# Always run from repo root
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[local] Killing any old dev servers on v1/v2 ports (best effort)..."

# v1 pool: 5000–5004
pids_v1=$(lsof -ti tcp:5000-5004 2>/dev/null || true)
if [ -n "$pids_v1" ]; then
  echo "[local] Killing v1 pids: $pids_v1"
  kill $pids_v1 2>/dev/null || true
fi

# v2 pool: 6001–6004 (since we’re avoiding 6000)
pids_v2=$(lsof -ti tcp:6001-6004 2>/dev/null || true)
if [ -n "$pids_v2" ]; then
  echo "[local] Killing v2 pids: $pids_v2"
  kill $pids_v2 2>/dev/null || true
fi

echo "[local] Starting Flask v1 (backend.api)..."
python -m backend.api &
PID_V1=$!

echo "[local] Starting FastAPI v2 (backend.fastapi_app)..."
python -m backend.fastapi_app &
PID_V2=$!

echo "[local] v1 PID = $PID_V1"
echo "[local] v2 PID = $PID_V2"
echo "[local] Press Ctrl+C to stop both."

# When you Ctrl+C, kill both children
cleanup() {
  echo
  echo "[local] Stopping backends..."
  kill "$PID_V1" "$PID_V2" 2>/dev/null || true
  wait || true
}
trap cleanup INT TERM

# Wait for both to exit
wait

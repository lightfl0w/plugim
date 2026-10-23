#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP=/tmp/plugim-smoke-$$
mkdir -p "$TMP"
export PORT=3999
export PLUGIM_INSTALL_FILE="$TMP/install.json"
export PLUGIM_DB_FILE="$TMP/plugim.db"
export PLUGIM_LOG_DIR="$TMP/logs"
export PLUGIM_STORAGE_DIR="$TMP/storage"
export PLUGIM_WEB_DIST=""
export PLUGIM_NO_RESPAWN=1
export PLUGIM_REPO="$TMP/non-git"
export PLUGIM_LINK_ALLOW_PRIVATE=1
export PLUGIM_BACKUP_DIR="$TMP/backups"
export PLUGIM_BACKUP_KEEP=3

BIN="$ROOT/apps/server/target/debug/plugim-server"
if [ ! -x "$BIN" ]; then
    echo "missing $BIN, run: pnpm check:server" >&2
    exit 1
fi

"$BIN" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
BASE=http://127.0.0.1:3999 BASE_TMP="$TMP" bash "$ROOT/scripts/smoke.sh"
status=$?
if [ $status -ne 0 ]; then
    echo "--- server log tail ---"
    tail -40 "$TMP/server.log"
fi
echo "tmp: $TMP"
exit $status

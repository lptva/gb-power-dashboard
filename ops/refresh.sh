#!/bin/bash
# Refresh the GB power dashboard dataset.
#
# Designed to be run by launchd (see com.gb-power-dashboard-2.refresh.plist)
# or by hand. Logs to ops/logs/refresh_YYYY-MM-DD.log and exits non-zero on
# any failure so the scheduler records the run as failed.
#
# Runs an incremental update (append new settlement periods, ~10 HTTP calls,
# ~30 s). Falls back to a full rebuild automatically when no readable
# dataset exists. See plan/02-incremental-etl.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_ROOT="$(cd "$PROJECT_ROOT/../.." && pwd)"
PYTHON="$WORKSPACE_ROOT/.venv/bin/python"

LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/refresh_$(date +%F).log"
mkdir -p "$LOG_DIR"

{
  echo "=== refresh started $(date -u +%FT%TZ) ==="

  if [ ! -x "$PYTHON" ]; then
    echo "ERROR: venv python not found at $PYTHON" >&2
    exit 1
  fi

  cd "$PROJECT_ROOT"
  "$PYTHON" etl/build_dataset.py --incremental

  # Observed dispatch snapshot (plan/05 Phase B). Non-fatal: a BOALF or PN
  # hiccup must not fail the core dataset refresh.
  "$PYTHON" etl/build_bmu_snapshot.py \
    || echo "WARNING: bmu snapshot refresh failed (core dataset unaffected)"

  # AI overnight summary (dashboard-watcher subagent → overnight_summary.json).
  # Non-fatal: an LLM/CLI failure must not fail the dataset refresh, and a
  # failed run leaves the previously published summary untouched.
  bash "$SCRIPT_DIR/run_overnight_summary.sh" \
    || echo "WARNING: overnight summary failed (core dataset unaffected)"

  echo "=== refresh finished $(date -u +%FT%TZ) ==="
} >> "$LOG_FILE" 2>&1

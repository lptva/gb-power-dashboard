#!/bin/bash
# Refresh the GB power dashboard dataset.
#
# Designed to be run by launchd (see com.gb-power-dashboard-2.refresh.plist.template)
# or by hand. Logs to ops/logs/refresh_YYYY-MM-DD.log and exits non-zero on
# any failure so the scheduler records the run as failed.
#
# Runs an incremental update (append new settlement periods, ~10 HTTP calls,
# ~30 s). Falls back to a full rebuild automatically when no readable
# dataset exists. See plan/02-incremental-etl.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Python resolution, most portable first: a repo-local venv (created by the
# installer), then the pre-portability workspace-level venv two directories
# up (kept so existing scheduled installs keep working), then python3 on
# PATH — which must be able to import certifi, the ETL's only dependency.
if [ -x "$PROJECT_ROOT/.venv/bin/python" ]; then
  PYTHON="$PROJECT_ROOT/.venv/bin/python"
elif [ -x "$PROJECT_ROOT/../../.venv/bin/python" ]; then
  PYTHON="$PROJECT_ROOT/../../.venv/bin/python"
elif command -v python3 >/dev/null 2>&1 \
    && python3 -c "import certifi" >/dev/null 2>&1; then
  PYTHON="$(command -v python3)"
else
  echo "ERROR: no usable Python found. Create a repo-local venv with:" >&2
  echo "  python3 -m venv .venv && .venv/bin/pip install certifi" >&2
  exit 1
fi

LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/refresh_$(date +%F).log"
mkdir -p "$LOG_DIR"

{
  echo "=== refresh started $(date -u +%FT%TZ) ==="
  echo "using python: $PYTHON"

  cd "$PROJECT_ROOT"
  "$PYTHON" etl/build_dataset.py --incremental

  # Observed dispatch snapshot (plan/05 Phase B). Non-fatal: a BOALF or PN
  # hiccup must not fail the core dataset refresh.
  "$PYTHON" etl/build_bmu_snapshot.py \
    || echo "WARNING: bmu snapshot refresh failed (core dataset unaffected)"

  # Counterparty zone context (append-only history, ~6 kB/day/zone —
  # ~15 MB/yr across all seven). --days 7 keeps runs cheap; merge handles
  # the overlap. Non-fatal per zone: a TSO hiccup must not fail the GB
  # refresh.
  for z in FR NL BE NO_2 DK_1 IE DE_LU; do
    "$PYTHON" etl/fetch_entsoe.py --zone "$z" --days 7 \
      || echo "WARNING: zone $z refresh failed (GB dataset unaffected)"
  done

  # AI overnight summary (dashboard-watcher subagent → overnight_summary.json).
  # Non-fatal: an LLM/CLI failure must not fail the dataset refresh, and a
  # failed run leaves the previously published summary untouched.
  bash "$SCRIPT_DIR/run_overnight_summary.sh" \
    || echo "WARNING: overnight summary failed (core dataset unaffected)"

  echo "=== refresh finished $(date -u +%FT%TZ) ==="
} >> "$LOG_FILE" 2>&1

#!/bin/bash
# Back-compat shim: the refresh pipeline moved to ops/refresh.py (portable,
# Mac/Windows). Existing LaunchAgents that point here keep working; new
# installs invoke refresh.py directly. Safe to delete once no scheduler
# references this file.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for CANDIDATE in "$SCRIPT_DIR/../.venv/bin/python" \
                 "$SCRIPT_DIR/../../../.venv/bin/python" \
                 "$(command -v python3 || true)"; do
  if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ]; then
    exec "$CANDIDATE" "$SCRIPT_DIR/refresh.py" "$@"
  fi
done

echo "ERROR: python3 not found" >&2
exit 1

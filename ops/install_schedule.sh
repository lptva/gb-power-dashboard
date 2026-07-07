#!/bin/bash
# Install (or reinstall) the daily refresh LaunchAgent for the current user.
# Opt-in by design: run this yourself; nothing installs it automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_NAME="com.gb-power-dashboard-2.refresh"
SRC="$SCRIPT_DIR/$PLIST_NAME.plist.template"
DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

mkdir -p "$HOME/Library/LaunchAgents"

# launchd's PATH is minimal, so resolve an absolute interpreter now:
# repo-local venv (created by install.py) → legacy workspace venv →
# python3 from the caller's shell.
if [ -x "$PROJECT_ROOT/.venv/bin/python" ]; then
  PYTHON_BIN="$PROJECT_ROOT/.venv/bin/python"
elif [ -x "$PROJECT_ROOT/../../.venv/bin/python" ]; then
  PYTHON_BIN="$(cd "$PROJECT_ROOT/../.." && pwd)/.venv/bin/python"
else
  PYTHON_BIN="$(command -v python3)" || {
    echo "ERROR: python3 not found — install Python first" >&2; exit 1; }
fi

# Unload a previous copy if present (ignore failure: not loaded is fine).
launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true

# Keep a rollback copy of whatever was installed before.
[ -f "$DST" ] && cp "$DST" "$DST.bak"

# The AI summary step needs the claude CLI, which usually lives outside
# launchd's minimal PATH; append its directory when present (optional
# feature — empty is fine).
CLAUDE_BIN="$(command -v claude || true)"
EXTRA_PATH=""
[ -n "$CLAUDE_BIN" ] && EXTRA_PATH=":$(dirname "$CLAUDE_BIN")"

# launchd requires absolute paths, so the tracked file is a template and
# the machine-specific plist is generated here from wherever the repo
# actually lives.
sed -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" \
    -e "s|__PYTHON__|$PYTHON_BIN|g" \
    -e "s|__EXTRA_PATH__|$EXTRA_PATH|g" "$SRC" > "$DST"
launchctl bootstrap "gui/$(id -u)" "$DST"

echo "Installed and loaded $PLIST_NAME (daily 07:00)."
echo "Check status : launchctl list | grep gb-power-dashboard"
echo "Run now      : launchctl kickstart gui/$(id -u)/$PLIST_NAME"
echo "Uninstall    : launchctl bootout gui/$(id -u)/$PLIST_NAME && rm '$DST'"

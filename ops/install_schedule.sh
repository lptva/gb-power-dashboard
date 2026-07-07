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

# Unload a previous copy if present (ignore failure: not loaded is fine).
launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true

# launchd requires absolute paths, so the tracked file is a template and
# the machine-specific plist is generated here from wherever the repo
# actually lives.
sed "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" "$SRC" > "$DST"
launchctl bootstrap "gui/$(id -u)" "$DST"

echo "Installed and loaded $PLIST_NAME (daily 07:00)."
echo "Check status : launchctl list | grep gb-power-dashboard"
echo "Run now      : launchctl kickstart gui/$(id -u)/$PLIST_NAME"
echo "Uninstall    : launchctl bootout gui/$(id -u)/$PLIST_NAME && rm '$DST'"

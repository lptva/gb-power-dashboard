# Milestone 1 — Scheduled refresh

## Goal

Re-run the ETL on a recurring basis without manual intervention, and document
the mechanism honestly (including what happens when the laptop is asleep).

## Decision: launchd, not cron

This project runs on a MacBook, not a server. Under macOS:

- **cron** silently skips any run scheduled while the machine is asleep.
- **launchd** with `StartCalendarInterval` runs a missed job as soon as the
  machine wakes, which is the behaviour we actually want for a "refresh the
  data each morning" job.

A cron alternative is documented for completeness, but launchd is the
recommended path.

## Deliverables

| File | Purpose |
|---|---|
| `ops/refresh.sh` | Wrapper: venv activation, ETL run, dated log file, non-zero exit on failure |
| `ops/com.gb-power-dashboard-2.refresh.plist` | launchd job, daily 07:00 local time |
| `ops/install_schedule.sh` | One-command install into `~/Library/LaunchAgents` (opt-in) |
| `ops/README.md` | Install/uninstall/verify instructions, cron alternative, sleep caveats |

## Design notes

- `refresh.sh` uses `set -euo pipefail`, resolves the project root from its own
  location (so it works regardless of cwd), and logs to
  `ops/logs/refresh_YYYY-MM-DD.log`.
- Until Milestone 2 lands, the script runs a full rebuild
  (`build_dataset.py --days 365`). Milestone 2 switches it to `--incremental`.
- The plist is **not** auto-installed by this milestone. Installing a
  LaunchAgent changes system state outside the project folder, so it is left
  as a documented one-command step for the user (`ops/install_schedule.sh`).
- 07:00 local is chosen because all upstream sources publish yesterday's data
  well before then (Elexon FUELHH/INDO/MID are half-hourly with same-day
  publication; PV_Live similar; gas SAP is D+1).

## Verification

1. `bash ops/refresh.sh` runs end-to-end, exit 0, log file created, all three
   JSON outputs freshly timestamped.
2. `plutil -lint ops/com.gb-power-dashboard-2.refresh.plist` passes.
3. Original folder untouched.

## Status

Done. Verified 2026-07-01: `refresh.sh` ran end-to-end (exit 0, dated log,
fresh `built_at`), plist lints clean, app renders the updated methodology
text with no console errors. LaunchAgent deliberately not auto-installed —
run `bash ops/install_schedule.sh` to activate the daily 07:00 job.

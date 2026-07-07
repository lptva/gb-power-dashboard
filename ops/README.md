# Ops — scheduled refresh

Everything needed to re-run the ETL on a schedule, without manual steps.
All the logic is in Python and runs identically on Mac and Windows; only
the scheduler registration is platform-specific (launchd vs Task
Scheduler, one script each).

## What runs

`python3 ops/refresh.py` (stdlib-only orchestrator; `refresh.sh` remains
as a thin back-compat shim for schedulers that still point at it) → steps
in order:

1. `python etl/build_dataset.py --incremental` — append new settlement
   periods (~10 HTTP calls, seconds; falls back to a full rebuild if no
   readable dataset exists).
2. `python etl/build_bmu_snapshot.py` — the observed-dispatch panel's
   latest settlement period (non-fatal if it fails).
2b. `python etl/fetch_entsoe.py --zone <Z> --days 7` for each of the seven
   European zones — appends onto the accumulated zone history (non-fatal
   per zone).
3. `python3 ops/run_overnight_summary.py` — **opt-in only**: skipped with
   a log line unless `ENABLE_AI_SUMMARY=true` is set in the project-root
   `.env` (or the environment). The flag is checked before the claude CLI
   is even looked for, so a subscription that happens to be signed in on
   the machine is never spent without an explicit decision (this is the
   project's only paid feature). When enabled, it precomputes every statistic
   the summary needs (`ops/panel_facts.py`: overnight-vs-baseline stats,
   z-scores, spread percentiles and decomposition, cable facts, merit
   figures) and injects it into the **dashboard-watcher subagent**, invoked
   headlessly (`claude --agent dashboard-watcher -p …`, model: sonnet — a
   real LLM call, single-turn by design: measured $0.36 API-equivalent vs
   $1.20 for the earlier tool-driven design). Writes the JSON analysis to
   `app/data/overnight_summary.json` plus a human-readable
   `overnight_summary.md`. The JSON carries one analysis section per
   dashboard tab (`tabs.overview` / `merit_order` / `spreads` / `flows`);
   the validator refuses to publish missing sections, empty
   takeaway/analysis strings, more than two findings per tab, or a missing
   merit-order figures block. The merit figures themselves are computed
   deterministically (`ops/merit_panel_figures.py`, mirroring the panel's
   model in `app/js/metrics.js`), injected into the prompt, and
   cross-checked on publish — a summary whose figures deviate from the
   panel's own numbers is rejected. Non-fatal: a failed run leaves the previously
   published summary untouched (agent stderr lands in
   `ops/logs/overnight.err.log`). The dashboard renders the active tab's
   section in the collapsible "Overnight summary" panel, badged
   AI-generated — it is model interpretation, not a data series.

Output goes to `app/data/`, logs to `ops/logs/refresh_YYYY-MM-DD.log`.
Non-zero exit if the core dataset refresh fails.

## Install the schedule (one command, opt-in)

**Mac:**

```bash
bash ops/install_schedule.sh
```

This generates the plist from
`com.gb-power-dashboard-2.refresh.plist.template` — substituting the
repository location and an absolute Python interpreter, both of which
launchd requires — backs up any previously installed copy to `*.bak`,
writes it into `~/Library/LaunchAgents` and loads it. The job then runs
**daily at 07:00 local time**.

Useful commands afterwards:

```bash
launchctl list | grep gb-power-dashboard          # is it loaded?
launchctl kickstart gui/$(id -u)/com.gb-power-dashboard-2.refresh   # run now
launchctl bootout  gui/$(id -u)/com.gb-power-dashboard-2.refresh    # stop it
```

**Windows** (untested on a real Windows machine at the time of writing —
logic-reviewed only):

```powershell
powershell -ExecutionPolicy Bypass -File ops\install_schedule.ps1
```

This registers a Task Scheduler job, "GB power dashboard refresh", running
`.venv\Scripts\python.exe ops\refresh.py` daily at 07:00 with
*StartWhenAvailable* — the closest equivalent of launchd's run-on-wake. It
needs the repo-local `.venv` (run `install.bat` first). Status / run now /
uninstall commands print on completion.

## Why launchd and not cron

This runs on a laptop. cron **silently skips** any job scheduled while the
machine is asleep; launchd with `StartCalendarInterval` runs the missed job
as soon as the machine wakes. On a MacBook that is closed overnight the
practical difference is "refresh happens when you open the lid" versus
"refresh never happens".

If you prefer cron anyway (e.g. on an always-on machine), the equivalent —
with the path replaced by wherever you cloned the repository — is:

```cron
0 7 * * * /usr/bin/env python3 /path/to/gb-power-dashboard/ops/refresh.py
```

## Honest caveats

- **Sleep**: with launchd the job fires on wake after a missed 07:00, but if
  the laptop stays asleep all day the dataset simply stays stale — nothing
  retries in the background of a closed laptop. For guaranteed daily runs,
  this belongs on an always-on host or a CI schedule (GitHub Actions cron
  publishing `app/` to static hosting — tracked in the repository's
  GitHub Issues).
- **Failures land in the log, not in your face.** Check
  `ops/logs/` occasionally, or `launchctl list` — a non-zero
  `LastExitStatus` means the last run failed. The dashboard footer's
  "Dataset built …" timestamp is the user-visible staleness signal.
- **07:00 rationale**: all upstream sources have published yesterday's data
  well before 07:00 (Elexon and PV_Live publish intraday; gas SAP is D+1;
  carbon/coal/FX are monthly).

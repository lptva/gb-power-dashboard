# Ops — scheduled refresh

Everything needed to re-run the ETL on a schedule, without manual steps.

## What runs

`refresh.sh` → three steps, in order:

1. `python etl/build_dataset.py --incremental` — append new settlement
   periods (~10 HTTP calls, seconds; falls back to a full rebuild if no
   readable dataset exists).
2. `python etl/build_bmu_snapshot.py` — the observed-dispatch panel's
   latest settlement period (non-fatal if it fails).
3. `bash ops/run_overnight_summary.sh` — invokes the **dashboard-watcher
   subagent** headlessly (`claude --agent dashboard-watcher -p …`, model:
   sonnet — a real LLM call) and writes its JSON analysis to
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

```bash
bash ops/install_schedule.sh
```

This copies `com.gb-power-dashboard-2.refresh.plist` into
`~/Library/LaunchAgents` and loads it. The job then runs **daily at 07:00
local time**.

Useful commands afterwards:

```bash
launchctl list | grep gb-power-dashboard          # is it loaded?
launchctl kickstart gui/$(id -u)/com.gb-power-dashboard-2.refresh   # run now
launchctl bootout  gui/$(id -u)/com.gb-power-dashboard-2.refresh    # stop it
```

## Why launchd and not cron

This runs on a laptop. cron **silently skips** any job scheduled while the
machine is asleep; launchd with `StartCalendarInterval` runs the missed job
as soon as the machine wakes. On a MacBook that is closed overnight the
practical difference is "refresh happens when you open the lid" versus
"refresh never happens".

If you prefer cron anyway (e.g. on an always-on machine), the equivalent is:

```cron
0 7 * * * /bin/bash /Users/lptva/Documents/energy-modelling/03_projects/gb-power-dashboard-2/ops/refresh.sh
```

## Honest caveats

- **Sleep**: with launchd the job fires on wake after a missed 07:00, but if
  the laptop stays asleep all day the dataset simply stays stale — nothing
  retries in the background of a closed laptop. For guaranteed daily runs,
  this belongs on an always-on host or a CI schedule (GitHub Actions cron
  publishing `app/` to static hosting — noted in the README's
  productionisation list).
- **Failures land in the log, not in your face.** Check
  `ops/logs/` occasionally, or `launchctl list` — a non-zero
  `LastExitStatus` means the last run failed. The dashboard footer's
  "Dataset built …" timestamp is the user-visible staleness signal.
- **07:00 rationale**: all upstream sources have published yesterday's data
  well before 07:00 (Elexon and PV_Live publish intraday; gas SAP is D+1;
  carbon/coal/FX are monthly).

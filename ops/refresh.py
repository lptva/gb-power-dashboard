#!/usr/bin/env python3
"""Daily refresh for the GB power dashboard — cross-platform (Mac/Windows).

Run by the scheduler (launchd on macOS via install_schedule.sh, Task
Scheduler on Windows via install_schedule.ps1) or by hand:

    python3 ops/refresh.py        # any Python 3.10+; stdlib only

Pipeline: incremental dataset update (falls back to a full rebuild when
no readable dataset exists) → BMU dispatch snapshot (non-fatal) →
system-stress metrics append (non-fatal) → seven ENTSO-E zone refreshes
(non-fatal per zone) → AI overnight summary (non-fatal, and OPT-IN:
skipped unless ENABLE_AI_SUMMARY=true, regardless of whether the claude
CLI is installed — see ops/env_flags.py). Logs to
ops/logs/refresh_YYYY-MM-DD.log and exits non-zero only if the core
dataset refresh fails, so the scheduler records the run correctly.

The core dataset step is retried (3 attempts, 2- then 5-minute waits)
before it is treated as fatal, because a 07:00 fire on a just-woken
laptop can race a not-yet-connected network. Every run — success or
fatal — writes app/data/refresh_status.json (the dashboard header's
staleness signal); see write_status().

This orchestrator needs only the standard library. The ETL child
processes need certifi, so the child interpreter is resolved separately:
repo-local .venv (created by install.py) → legacy workspace venv (the
pre-portability layout) → this interpreter, if it can import certifi.
"""

import datetime
import json
import os
import subprocess
import sys
import time
from pathlib import Path

OPS = Path(__file__).resolve().parent
ROOT = OPS.parent
ZONES = ["FR", "NL", "BE", "NO_2", "DK_1", "IE", "DE_LU"]

# Retry schedule for the core dataset step only: waits (seconds) after the
# 1st and 2nd failure. Three attempts total; a not-yet-connected network on
# wake is transient and usually up within a couple of minutes.
CORE_RETRY_WAITS = (120, 300)

# The dashboard header consumes refresh_status.json (a separate UI chunk
# owns the reader); its schema is a fixed contract — see write_status().
# app/data/ is gitignored, so neither file is tracked.
STATUS_PATH = ROOT / "app" / "data" / "refresh_status.json"
SUMMARY_PATH = ROOT / "app" / "data" / "overnight_summary.json"

sys.path.insert(0, str(OPS))
from env_flags import ai_summary_enabled  # noqa: E402


def resolve_child_python():
    candidates = [
        ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt"
                          else "bin/python"),
        ROOT.parent.parent / ".venv" / "bin" / "python",  # legacy layout
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    try:
        import certifi  # noqa: F401 — probe only
        return sys.executable
    except ImportError:
        sys.exit("ERROR: no usable Python found for the ETL. Create one "
                 "with:\n  python3 -m venv .venv && "
                 ".venv/bin/pip install certifi\n(or run install.py)")


def _utc_now_iso():
    return (datetime.datetime.now(datetime.timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%SZ"))


def summary_ran_today(summary_path, today):
    """True when overnight_summary.json was already generated today (UTC),
    so a second daily fire doesn't pay for a second LLM run. `today` is a
    datetime.date. Unreadable or absent file → False (proceed normally)."""
    try:
        data = json.loads(Path(summary_path).read_text(encoding="utf-8"))
        generated = str(data["generated_at"])[:10]
    except (OSError, ValueError, KeyError, TypeError):
        return False
    return generated == today.isoformat()


def run_core_with_retry(run_once, note, sleep, waits=CORE_RETRY_WAITS):
    """Retry the core dataset step. `run_once()` returns an exit code; on a
    non-zero code we log the failed attempt, log and take a wait, then try
    again, up to len(waits)+1 attempts. Returns (final_code, attempts).
    `sleep` and `note` are injected so tests neither block nor go to disk."""
    total = len(waits) + 1
    attempts = 0
    while True:
        attempts += 1
        code = run_once()
        if code == 0:
            return code, attempts
        note("WARNING: core dataset refresh failed (exit {}) on attempt "
             "{}/{}".format(code, attempts, total))
        if attempts > len(waits):
            return code, attempts
        wait = waits[attempts - 1]
        note("retrying core dataset refresh in {}s".format(wait))
        sleep(wait)


def write_status(path, outcome, failed_step, error, steps_completed,
                 attempts, ts=None):
    """Write refresh_status.json atomically (tmp + os.replace, matching the
    ETL's publication-safety convention). Called on every run — success or
    the fatal-exit path — so the dashboard header always has a fresh verdict.
    `outcome` reflects only whether the run as a whole survived: a failed
    non-fatal step does not make it "failed"."""
    status = {
        "ts": ts or _utc_now_iso(),
        "outcome": outcome,
        "failed_step": failed_step,
        "error": error,
        "steps_completed": list(steps_completed),
        "attempts": attempts,
    }
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(status, indent=1), encoding="utf-8")
    os.replace(tmp, path)
    return status


def main():
    python = resolve_child_python()
    log_dir = OPS / "logs"
    log_dir.mkdir(exist_ok=True)
    log_path = log_dir / "refresh_{}.log".format(
        datetime.date.today().isoformat())

    steps_completed = []
    attempts = 1
    outcome = "ok"
    failed_step = None
    error = None

    with open(log_path, "a", encoding="utf-8") as log:

        def note(line):
            log.write(line + "\n")
            log.flush()

        def run(args, label):
            """Run a step with output into the dated log; returns its exit
            code and records the label on success (exit 0)."""
            code = subprocess.run(args, cwd=str(ROOT), stdout=log,
                                  stderr=subprocess.STDOUT).returncode
            if code == 0:
                steps_completed.append(label)
            return code

        def run_non_fatal(args, label):
            """A TSO or LLM hiccup must not fail the core dataset refresh —
            warn and continue."""
            code = run(args, label)
            if code != 0:
                note("WARNING: {} failed (exit {}) — core dataset "
                     "unaffected".format(label, code))

        try:
            note("=== refresh started {}Z ===".format(
                datetime.datetime.now(datetime.timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%S")))
            note("using python: {}".format(python))

            # Tells build_dataset.py it was launched by this orchestrator, so
            # its standalone-run notice (core dataset only, other steps did
            # not run) does not print for an orchestrated refresh.
            os.environ["GB_DASH_ORCHESTRATED"] = "1"

            # Core dataset — the only fatal step, and the only one retried.
            core_args = [python, str(ROOT / "etl" / "build_dataset.py"),
                         "--incremental"]
            code, attempts = run_core_with_retry(
                lambda: run(core_args, "core dataset refresh"),
                note, time.sleep)
            if code != 0:
                note("ERROR: core dataset refresh failed (exit {}) after "
                     "{} attempts".format(code, attempts))
                outcome = "failed"
                failed_step = "core dataset refresh"
                error = ("core dataset refresh failed (exit {}) after {} "
                         "attempts".format(code, attempts))
                sys.exit(code)

            # Observed dispatch snapshot (plan/05 Phase B).
            run_non_fatal([python, str(ROOT / "etl" / "build_bmu_snapshot.py")],
                          "bmu snapshot refresh")

            # System-stress daily metrics + anomaly flags (plan/06 workstream
            # B). Incremental append; the one-off historical build is
            # `python etl/fetch_stress.py --backfill 365`, run once by hand.
            run_non_fatal([python, str(ROOT / "etl" / "fetch_stress.py")],
                          "stress metrics refresh")

            # Counterparty zone context (append-only history, ~6 kB/day/zone).
            # --days 7 keeps runs cheap; the merge handles the overlap.
            for zone in ZONES:
                run_non_fatal([python, str(ROOT / "etl" / "fetch_entsoe.py"),
                               "--zone", zone, "--days", "7"],
                              "zone {} refresh".format(zone))

            # AI overnight summary — the only paid feature, gated on an
            # explicit opt-in BEFORE the claude CLI is even considered: a
            # working Claude subscription on the machine must never be
            # spent without ENABLE_AI_SUMMARY=true. A failed run leaves the
            # previously published summary untouched.
            if ai_summary_enabled(ROOT):
                # Once-per-day gate: the 09:00 fallback fire must not pay for
                # a second LLM run when the 07:00 run already produced today's.
                if summary_ran_today(
                        SUMMARY_PATH,
                        datetime.datetime.now(datetime.timezone.utc).date()):
                    note("overnight summary skipped: already ran today")
                else:
                    run_non_fatal(
                        [python, str(OPS / "run_overnight_summary.py")],
                        "overnight summary")
            else:
                note("overnight summary skipped: not enabled (opt-in — set "
                     "ENABLE_AI_SUMMARY=true in the project-root .env; it "
                     "spends your Claude subscription's usage allowance. "
                     "See the README's AI summary section)")

            note("=== refresh finished {}Z ===".format(
                datetime.datetime.now(datetime.timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%S")))
        except SystemExit:
            raise  # deliberate exit — the fatal core path set the fields
        except BaseException as exc:
            # A crashed run must never report ok: an unexpected error — a
            # vanished child interpreter, a disk failure, Ctrl-C — is
            # recorded before the traceback propagates unchanged.
            outcome = "failed"
            failed_step = failed_step or "orchestrator"
            error = error or "unexpected error: {!r}".format(exc)
            raise
        finally:
            # Every run writes status — including the sys.exit path above, so
            # a fatal core failure still surfaces in the dashboard header.
            write_status(STATUS_PATH, outcome, failed_step, error,
                         steps_completed, attempts)


if __name__ == "__main__":
    main()

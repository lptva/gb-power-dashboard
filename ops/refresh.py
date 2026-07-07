#!/usr/bin/env python3
"""Daily refresh for the GB power dashboard — cross-platform (Mac/Windows).

Run by the scheduler (launchd on macOS via install_schedule.sh, Task
Scheduler on Windows via install_schedule.ps1) or by hand:

    python3 ops/refresh.py        # any Python 3.10+; stdlib only

Pipeline, matching the retired refresh.sh exactly: incremental dataset
update (falls back to a full rebuild when no readable dataset exists) →
BMU dispatch snapshot (non-fatal) → seven ENTSO-E zone refreshes
(non-fatal per zone) → AI overnight summary (non-fatal, and OPT-IN:
skipped unless ENABLE_AI_SUMMARY=true, regardless of whether the claude
CLI is installed — see ops/env_flags.py). Logs to
ops/logs/refresh_YYYY-MM-DD.log and exits non-zero only if the core
dataset refresh fails, so the scheduler records the run correctly.

This orchestrator needs only the standard library. The ETL child
processes need certifi, so the child interpreter is resolved separately:
repo-local .venv (created by install.py) → legacy workspace venv (the
pre-portability layout) → this interpreter, if it can import certifi.
"""

import datetime
import os
import subprocess
import sys
from pathlib import Path

OPS = Path(__file__).resolve().parent
ROOT = OPS.parent
ZONES = ["FR", "NL", "BE", "NO_2", "DK_1", "IE", "DE_LU"]

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


def main():
    python = resolve_child_python()
    log_dir = OPS / "logs"
    log_dir.mkdir(exist_ok=True)
    log_path = log_dir / "refresh_{}.log".format(
        datetime.date.today().isoformat())

    with open(log_path, "a", encoding="utf-8") as log:

        def note(line):
            log.write(line + "\n")
            log.flush()

        def run(args, label, fatal):
            """Run a step with output into the dated log. Non-fatal steps
            warn and continue — a TSO or LLM hiccup must not fail the
            core dataset refresh."""
            code = subprocess.run(args, cwd=str(ROOT), stdout=log,
                                  stderr=subprocess.STDOUT).returncode
            if code != 0:
                if fatal:
                    note("ERROR: {} failed (exit {})".format(label, code))
                    sys.exit(code)
                note("WARNING: {} failed (exit {}) — core dataset "
                     "unaffected".format(label, code))

        note("=== refresh started {}Z ===".format(
            datetime.datetime.now(datetime.timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%S")))
        note("using python: {}".format(python))

        # Core dataset — the only fatal step.
        run([python, str(ROOT / "etl" / "build_dataset.py"),
             "--incremental"], "core dataset refresh", fatal=True)

        # Observed dispatch snapshot (plan/05 Phase B).
        run([python, str(ROOT / "etl" / "build_bmu_snapshot.py")],
            "bmu snapshot refresh", fatal=False)

        # Counterparty zone context (append-only history, ~6 kB/day/zone).
        # --days 7 keeps runs cheap; the merge handles the overlap.
        for zone in ZONES:
            run([python, str(ROOT / "etl" / "fetch_entsoe.py"),
                 "--zone", zone, "--days", "7"],
                "zone {} refresh".format(zone), fatal=False)

        # AI overnight summary — the only paid feature, gated on an
        # explicit opt-in BEFORE the claude CLI is even considered: a
        # working Claude subscription on the machine must never be
        # spent without ENABLE_AI_SUMMARY=true. A failed run leaves the
        # previously published summary untouched.
        if ai_summary_enabled(ROOT):
            run([python, str(OPS / "run_overnight_summary.py")],
                "overnight summary", fatal=False)
        else:
            note("overnight summary skipped: not enabled (opt-in — set "
                 "ENABLE_AI_SUMMARY=true in the project-root .env; it "
                 "spends your Claude subscription's usage allowance. "
                 "See the README's AI summary section)")

        note("=== refresh finished {}Z ===".format(
            datetime.datetime.now(datetime.timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%S")))


if __name__ == "__main__":
    main()

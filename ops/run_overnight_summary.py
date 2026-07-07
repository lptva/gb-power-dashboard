#!/usr/bin/env python3
"""Generate the AI overnight summary for the dashboard — cross-platform.

Invokes the dashboard-watcher subagent (defined in this repo at
.claude/agents/dashboard-watcher.md — resolved from the project root this
script chdirs into) headlessly via `claude --agent … -p`, validates the
result with ops/validate_overnight.py (imported directly — same code the
unit tests exercise) and publishes app/data/overnight_summary.json + .md
atomically. On any failure the previously published summary is left
untouched and the exit code is non-zero; ops/refresh.py treats that as
non-fatal.

This is a real LLM invocation (agent model: sonnet) and the ONLY part of
the project that needs the claude CLI or any subscription — the dashboard
itself runs without it. The output is an AI-generated interpretation of
the published dataset and is badged as such in the app.
"""

import datetime
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

OPS = Path(__file__).resolve().parent
ROOT = OPS.parent
sys.path.insert(0, str(OPS))

from merit_panel_figures import compute  # noqa: E402
import validate_overnight  # noqa: E402

PROMPT_TEMPLATE = """Run your overnight analysis on the dashboard dataset in this
directory (app/data/series_hh.json, series_daily.json, meta.json) exactly
per your procedure: one section per tab (overview, merit_order, spreads,
flows), analysis-first. The Merit order panel's own headline figures,
computed with the panel's exact model, are below — copy the 'figures'
object VERBATIM into tabs.merit_order.figures and base the merit_order
analysis on these numbers and the inputs shown (your job is the causal
explanation of the gap, not the arithmetic). The 'reference_assumptions'
block gives the dashboard's documented efficiency and carbon-intensity
values: anywhere your prose (any tab) quotes an efficiency or a carbon
intensity, use ONLY these values on their stated basis — the publisher
rejects any other efficiency or tCO2/MWh figure:
{merit_figures}
JSON output mode: respond with ONLY the raw JSON object per your schema —
the first character of your reply must be '{{', no Markdown fences, no
prose before or after it."""


def main():
    claude = shutil.which("claude")
    if claude is None:
        sys.exit("overnight summary skipped: claude CLI not found on PATH "
                 "(optional feature — see the README's AI summary section)")

    os.chdir(ROOT)

    # The Merit order panel's own figures, computed deterministically
    # (merit_panel_figures.py mirrors metrics.js). Injected into the prompt
    # so the agent analyses the panel's numbers instead of inventing its
    # own SRMC arithmetic; validate_overnight refuses figures that deviate.
    reference = compute(ROOT / "app" / "data")
    prompt = PROMPT_TEMPLATE.format(merit_figures=json.dumps(reference,
                                                             indent=1))

    log_dir = OPS / "logs"
    log_dir.mkdir(exist_ok=True)

    def log_metrics(raw_envelope, attempt, outcome):
        """One line per attempt into overnight.metrics.log: duration,
        turns, tokens and API-equivalent cost from the CLI envelope —
        cost/runtime transparency for an LLM feature should be a logged
        fact, not an estimate."""
        try:
            envelope = json.loads(raw_envelope)
        except ValueError:
            envelope = {}
        usage = envelope.get("usage") or {}
        line = json.dumps({
            "ts": datetime.datetime.now(datetime.timezone.utc)
                  .isoformat(timespec="seconds"),
            "attempt": attempt, "outcome": outcome,
            "duration_ms": envelope.get("duration_ms"),
            "num_turns": envelope.get("num_turns"),
            "input_tokens": usage.get("input_tokens"),
            "cache_read_tokens": usage.get("cache_read_input_tokens"),
            "cache_creation_tokens": usage.get("cache_creation_input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "total_cost_usd": envelope.get("total_cost_usd"),
        })
        with open(log_dir / "overnight.metrics.log", "a",
                  encoding="utf-8") as metrics:
            metrics.write(line + "\n")

    def one_attempt(attempt):
        """Run the agent once; returns validated data or raises
        ValidationError. Rejected raw replies are persisted for
        post-mortem — the first malformed-output incident was
        undiagnosable because only the first 200 chars survived."""
        # --output-format json wraps the agent's final text in a result
        # envelope with error metadata — plain text mode proved unreliable
        # (empty stdout on an otherwise-successful run). A normal run
        # takes ~8 minutes (agentic session: dataset reads + baseline
        # maths + four sections); the timeout only exists so a hung CLI
        # can never hang the scheduled refresh with it.
        with open(log_dir / "overnight.err.log", "a",
                  encoding="utf-8") as err:
            try:
                result = subprocess.run(
                    [claude, "--agent", "dashboard-watcher", "-p", prompt,
                     "--allowedTools", "Read Grep Glob Bash",
                     "--output-format", "json"],
                    capture_output=True, text=True, timeout=20 * 60)
            except subprocess.TimeoutExpired:
                err.write("timed out after 20 minutes\n")
                sys.exit("overnight summary timed out after 20 minutes — "
                         "previously published summary left in place")
            err.write(result.stderr)
        if result.returncode != 0:
            log_metrics(result.stdout, attempt, "cli_error")
            sys.exit("claude CLI exited {} (stderr in ops/logs/"
                     "overnight.err.log)".format(result.returncode))
        try:
            data = validate_overnight.extract_inner_json(
                result.stdout.strip())
            validate_overnight.validate_summary(data, reference)
        except validate_overnight.ValidationError:
            stamp = datetime.datetime.now(datetime.timezone.utc)\
                .strftime("%Y%m%dT%H%M%SZ")
            rejected = log_dir / "overnight.rejected-{}.txt".format(stamp)
            rejected.write_text(result.stdout, encoding="utf-8")
            log_metrics(result.stdout, attempt, "rejected")
            print("attempt {} rejected — full reply saved to {}".format(
                attempt, rejected), flush=True)
            raise
        log_metrics(result.stdout, attempt, "published")
        return data

    # Structurally invalid replies happen (observed ~1 in 5 runs), so one
    # retry is built in; a second failure leaves the previous summary in
    # place and exits non-zero for the orchestrator's WARNING line.
    try:
        data = one_attempt(1)
    except validate_overnight.ValidationError:
        print("retrying once…", flush=True)
        try:
            data = one_attempt(2)
        except validate_overnight.ValidationError as error:
            sys.exit("REFUSING TO PUBLISH (both attempts): {}".format(error))
    validate_overnight.publish(data, ROOT / "app" / "data")

    n_findings = sum(len(data["tabs"][t].get("findings", []))
                     for t in validate_overnight.TABS)
    print("Wrote overnight_summary.json (4 tab sections, {} findings, {} "
          "data-quality flags)".format(n_findings,
                                       len(data["data_quality"])))


if __name__ == "__main__":
    main()

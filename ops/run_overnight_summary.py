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
itself runs without it. It is OPT-IN: nothing runs (and nothing is spent)
unless ENABLE_AI_SUMMARY=true is set in the environment or the
project-root .env, even when the claude CLI is present and signed in. The
output is an AI-generated interpretation of the published dataset and is
badged as such in the app.
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

from env_flags import ai_summary_enabled  # noqa: E402
from panel_facts import compute_facts  # noqa: E402
import validate_overnight  # noqa: E402

PROMPT_TEMPLATE = """Write the overnight analysis exactly per your procedure: one section
per tab (overview, merit_order, spreads, flows), analysis-first. Every
statistic you need is PRECOMPUTED below with the dashboard's exact
formulas (ops/panel_facts.py) — overnight-vs-baseline stats with
z-scores, spread levels/percentiles/decomposition, per-cable facts, the
merit panel's figures and data-quality facts. Do NOT recompute anything
and do NOT read the dataset files; use a tool only if a specific
qualitative check is truly essential (it rarely is). Copy 'window'
VERBATIM into your window field and merit.figures VERBATIM into
tabs.merit_order.figures — the publisher rejects deviations. The
reference_assumptions inside 'merit' are the only efficiency and
carbon-intensity values your prose may quote:
{facts}
JSON output mode: respond with ONLY the raw JSON object per your schema —
the first character of your reply must be '{{', no Markdown fences, no
prose before or after it."""


def main():
    # Consent gate FIRST, capability check second: a claude CLI that
    # happens to be installed and signed in (for unrelated work) must
    # never be enough to spend the machine owner's usage allowance.
    # One-off override without editing .env:
    #   ENABLE_AI_SUMMARY=true python3 ops/run_overnight_summary.py
    if not ai_summary_enabled(ROOT):
        sys.exit("overnight summary skipped: AI summary is opt-in and not "
                 "enabled. Set ENABLE_AI_SUMMARY=true in the project-root "
                 ".env (or the environment) to enable it — it spends your "
                 "Claude subscription's usage allowance. See the README's "
                 "AI summary section.")
    claude = shutil.which("claude")
    if claude is None:
        sys.exit("overnight summary skipped: claude CLI not found on PATH "
                 "(optional feature — see the README's AI summary section)")

    os.chdir(ROOT)

    # Everything the agent needs, computed deterministically outside the
    # LLM (panel_facts.py; merit figures inside it still mirror
    # metrics.js). Injected so the agent writes analysis instead of
    # re-deriving statistics through tool calls — the tool-driven design
    # measured $1.20/run over 18 turns, dominated by that re-derivation.
    facts = compute_facts(ROOT / "app" / "data")
    reference = facts["merit"]
    prompt = PROMPT_TEMPLATE.format(facts=json.dumps(facts, indent=1))

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
            validate_overnight.validate_summary(
                data, reference, expected_window=facts["window"])
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

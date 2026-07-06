#!/bin/bash
# Generate the AI overnight summary for the dashboard.
#
# Invokes the dashboard-watcher subagent (defined in this repo at
# .claude/agents/dashboard-watcher.md — resolved from the project root this
# script cds into) headlessly via `claude --agent … -p`,
# asks for its JSON output mode, validates the result and writes it
# atomically to app/data/overnight_summary.json (plus a human-readable
# overnight_summary.md). On any failure the previously published summary is
# left untouched and the script exits non-zero — refresh.sh treats that as
# non-fatal.
#
# Note this is a real LLM invocation (agent model: sonnet): the output is an
# AI-generated interpretation of the published dataset, and the dashboard
# badges it as such — it is not an observed or estimated data series.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: claude CLI not found on PATH" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

# The Merit order panel's own figures, computed deterministically with the
# panel's exact model (ops/merit_panel_figures.py mirrors metrics.js).
# Injected into the prompt so the agent analyses the panel's numbers instead
# of inventing its own SRMC arithmetic; the validator below refuses to
# publish figures that disagree.
MERIT_FIGURES="$(/usr/bin/env python3 ops/merit_panel_figures.py app/data)"

PROMPT="Run your overnight analysis on the dashboard dataset in this
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
$MERIT_FIGURES
JSON output mode: respond with ONLY the raw JSON object per your schema —
the first character of your reply must be '{', no Markdown fences, no
prose before or after it."
# --output-format json wraps the agent's final text in a result envelope
# with error metadata — plain text mode proved unreliable (empty stdout on
# an otherwise-successful run).
RAW="$(claude --agent dashboard-watcher -p "$PROMPT" \
        --allowedTools "Read Grep Glob Bash" --output-format json \
        2>>"$SCRIPT_DIR/logs/overnight.err.log")"

# Validate + publish via ops/validate_overnight.py (importable so the unit
# tests in tests/ exercise the same code the pipeline runs — schema,
# merit-figure cross-check, assumption vocabulary, atomic writes).
# The payload goes via temp files: a pipe would conflict with stdin use.
RAW_FILE="$(mktemp)"
FIG_FILE="$(mktemp)"
trap 'rm -f "$RAW_FILE" "$FIG_FILE"' EXIT
printf '%s' "$RAW" > "$RAW_FILE"
printf '%s' "$MERIT_FIGURES" > "$FIG_FILE"

/usr/bin/env python3 ops/validate_overnight.py \
  "$PROJECT_ROOT/app/data" "$RAW_FILE" "$FIG_FILE"

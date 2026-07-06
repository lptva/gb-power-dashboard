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

# Validate + write atomically; also render the human-readable variant.
# The payload goes via a temp file: a pipe would be silently overridden by
# the heredoc (both claim stdin), leaving the validator reading nothing.
RAW_FILE="$(mktemp)"
FIG_FILE="$(mktemp)"
trap 'rm -f "$RAW_FILE" "$FIG_FILE"' EXIT
printf '%s' "$RAW" > "$RAW_FILE"
printf '%s' "$MERIT_FIGURES" > "$FIG_FILE"

/usr/bin/env python3 - "$PROJECT_ROOT/app/data" "$RAW_FILE" "$FIG_FILE" <<'PY'
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path

out_dir = Path(sys.argv[1])
raw = Path(sys.argv[2]).read_text().strip()
try:
    envelope = json.loads(raw)
except ValueError as error:
    sys.exit(f"REFUSING TO PUBLISH: CLI envelope is not valid JSON ({error}); "
             f"first 200 chars: {raw[:200]!r}")
if envelope.get("is_error") or envelope.get("subtype") != "success":
    sys.exit("REFUSING TO PUBLISH: agent run failed "
             f"(subtype={envelope.get('subtype')!r}, "
             f"api_error_status={envelope.get('api_error_status')!r})")
inner = (envelope.get("result") or "").strip()
# Tolerate a fenced or prose-prefixed response despite instructions: slice
# from the first '{' to the last '}' — the schema checks below still gate
# what gets published.
if not inner.startswith("{") and "{" in inner and "}" in inner:
    inner = inner[inner.index("{"):inner.rindex("}") + 1]
try:
    data = json.loads(inner)
except ValueError as error:
    sys.exit(f"REFUSING TO PUBLISH: agent output is not valid JSON ({error}); "
             f"first 200 chars: {inner[:200]!r}")
if "error" in data:
    sys.exit(f"REFUSING TO PUBLISH: agent reported an error: {data['error']}")
# Per-tab schema (see .claude/agents/dashboard-watcher.md): every tab
# section must exist with non-empty takeaway + analysis, and merit_order
# must carry its figures object (null values allowed — missing inputs are
# reported, not guessed).
TABS = ("overview", "merit_order", "spreads", "flows")
for key in ("window", "tabs", "data_quality"):
    if key not in data:
        sys.exit(f"REFUSING TO PUBLISH: missing key {key!r}")
if not isinstance(data["window"], dict) \
        or not all(isinstance(data["window"].get(k), str)
                   for k in ("from", "to")):
    sys.exit("REFUSING TO PUBLISH: window must be an object with "
             f"'from'/'to' strings, got {data['window']!r}")
if not isinstance(data["data_quality"], list):
    sys.exit("REFUSING TO PUBLISH: data_quality is not a list")
for tab in TABS:
    section = data["tabs"].get(tab)
    if not isinstance(section, dict):
        sys.exit(f"REFUSING TO PUBLISH: missing tab section {tab!r}")
    for field in ("takeaway", "analysis"):
        if not isinstance(section.get(field), str) or not section[field].strip():
            sys.exit(f"REFUSING TO PUBLISH: {tab}.{field} missing or empty")
    findings = section.get("findings", [])
    if not isinstance(findings, list) or len(findings) > 2:
        sys.exit(f"REFUSING TO PUBLISH: {tab}.findings must be a list of <=2 "
                 f"(analysis over enumeration — got {findings!r})")
figures = data["tabs"]["merit_order"].get("figures")
FIG_KEYS = ("observed_price_gbp_mwh", "implied_clearing_gbp_mwh",
            "marginal_technology", "gap_pct")
if not isinstance(figures, dict) or not set(FIG_KEYS) <= figures.keys():
    sys.exit("REFUSING TO PUBLISH: merit_order.figures missing or incomplete")
# Cross-check against the deterministic recompute injected into the prompt:
# the agent must carry the panel's own numbers, not its own model.
reference = json.loads(Path(sys.argv[3]).read_text())
if "error" in reference:
    if any(figures[k] is not None for k in FIG_KEYS):
        sys.exit("REFUSING TO PUBLISH: panel inputs are missing "
                 f"({reference}) so merit figures must be null, got {figures}")
else:
    for k in FIG_KEYS:
        want, got = reference["figures"][k], figures[k]
        same = (want == got if isinstance(want, str) or want is None
                else isinstance(got, (int, float))
                     and abs(got - want) < 0.005)
        if not same:
            sys.exit(f"REFUSING TO PUBLISH: merit figure {k} = {got!r} "
                     f"disagrees with the panel's own value {want!r}")
# Vocabulary check on quoted assumptions: any efficiency ("NN% efficiency",
# "η 0.NN") or carbon intensity ("0.NN tCO2/MWh...") in the prose must come
# from the documented reference set injected into the prompt — this is the
# failure class where the model previously invented "55% efficiency,
# 0.40 tCO2/MWh". Prices like £52/tCO2 do not match the intensity pattern.
import re
ALLOWED_ETA = {"45", "50", "57", "32", "40", "33", "36", "39",
               "0.45", "0.50", "0.5", "0.57", "0.32", "0.40", "0.4",
               "0.33", "0.36", "0.39"}
ALLOWED_INTENSITY = {"0.184", "0.34"}
def prose_strings():
    for tab in TABS:
        section = data["tabs"][tab]
        yield tab, section["takeaway"]
        yield tab, section["analysis"]
        for finding in section.get("findings", []):
            yield tab, f"{finding.get('title', '')} {finding.get('detail', '')}"
for tab, text in prose_strings():
    for m in re.finditer(r"(\d{1,2}(?:\.\d+)?)\s*%\s*efficien|"
                         r"(?:η|eta)\s*(?:=|of|at)?\s*(0\.\d+)", text):
        value = m.group(1) or m.group(2)
        if value not in ALLOWED_ETA:
            sys.exit(f"REFUSING TO PUBLISH: {tab} prose quotes efficiency "
                     f"{value!r}, not in the documented reference set")
    for m in re.finditer(r"(0\.\d+)\s*tCO2", text):
        if m.group(1) not in ALLOWED_INTENSITY:
            sys.exit(f"REFUSING TO PUBLISH: {tab} prose quotes carbon "
                     f"intensity {m.group(1)!r} tCO2, not in the documented "
                     "reference set (thermal basis: 0.184 gas, 0.34 coal)")
# Publication metadata, not model content: always stamp the real time (the
# model has no reliable clock).
data["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

tmp = out_dir / "overnight_summary.json.tmp"
tmp.write_text(json.dumps(data, indent=1))
os.replace(tmp, out_dir / "overnight_summary.json")

TITLES = {"overview": "Overview", "merit_order": "Merit order",
          "spreads": "Spreads", "flows": "Flows"}
lines = [f"# Overnight summary — generated {data['generated_at']} (AI)"]
for tab in TABS:
    section = data["tabs"][tab]
    lines += ["", f"## {TITLES[tab]}", "", f"**{section['takeaway']}**", "",
              section["analysis"]]
    if tab == "merit_order":
        f = figures
        lines += ["", f"Observed £{f['observed_price_gbp_mwh']} vs implied "
                  f"clearing £{f['implied_clearing_gbp_mwh']} "
                  f"({f['marginal_technology']}), gap {f['gap_pct']}%"]
    for finding in section.get("findings", []):
        lines.append(f"- **{finding.get('title')}** — {finding.get('detail')}")
lines += ["", "## Data quality", ""]
lines += [f"- {f}" for f in data["data_quality"]] or []
if not data["data_quality"]:
    lines.append("No flags.")
md_tmp = out_dir / "overnight_summary.md.tmp"
md_tmp.write_text("\n".join(lines) + "\n")
os.replace(md_tmp, out_dir / "overnight_summary.md")
n_findings = sum(len(data["tabs"][t].get("findings", [])) for t in TABS)
print(f"Wrote overnight_summary.json (4 tab sections, {n_findings} "
      f"findings, {len(data['data_quality'])} data-quality flags)")
PY

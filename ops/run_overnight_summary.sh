#!/bin/bash
# Generate the AI overnight summary for the dashboard.
#
# Invokes the dashboard-watcher subagent (defined at the workspace root in
# .claude/agents/dashboard-watcher.md) headlessly via `claude --agent … -p`,
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

PROMPT='Run your overnight analysis on the dashboard dataset in this
directory (app/data/series_hh.json, series_daily.json, meta.json) exactly
per your procedure. JSON output mode: respond with ONLY the raw JSON object
per your schema — no Markdown fences, no prose before or after it.'

cd "$PROJECT_ROOT"
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
trap 'rm -f "$RAW_FILE"' EXIT
printf '%s' "$RAW" > "$RAW_FILE"

/usr/bin/env python3 - "$PROJECT_ROOT/app/data" "$RAW_FILE" <<'PY'
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
# Tolerate a fenced response despite instructions — strip fences if present.
if inner.startswith("```"):
    inner = inner[inner.index("{"):inner.rindex("}") + 1]
try:
    data = json.loads(inner)
except ValueError as error:
    sys.exit(f"REFUSING TO PUBLISH: agent output is not valid JSON ({error}); "
             f"first 200 chars: {inner[:200]!r}")
if "error" in data:
    sys.exit(f"REFUSING TO PUBLISH: agent reported an error: {data['error']}")
for key in ("summary", "metrics", "anomalies", "data_quality"):
    if key not in data:
        sys.exit(f"REFUSING TO PUBLISH: missing key {key!r}")
# Publication metadata, not model content: always stamp the real time (the
# model has no reliable clock).
data["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

tmp = out_dir / "overnight_summary.json.tmp"
tmp.write_text(json.dumps(data, indent=1))
os.replace(tmp, out_dir / "overnight_summary.json")

lines = [f"# Overnight summary — generated {data['generated_at']} (AI)", "",
         data["summary"], "", "## Anomalies"]
if data["anomalies"]:
    lines += [f"- **{a.get('metric')}**: {a.get('value')} (z={a.get('z')}) — "
              f"{a.get('hypothesis', '')}" for a in data["anomalies"]]
else:
    lines.append("None detected (|z| ≤ 2 across tracked metrics).")
lines += ["", "## Data quality"]
lines += [f"- {f}" for f in data["data_quality"]] or []
if not data["data_quality"]:
    lines.append("No flags.")
md_tmp = out_dir / "overnight_summary.md.tmp"
md_tmp.write_text("\n".join(lines) + "\n")
os.replace(md_tmp, out_dir / "overnight_summary.md")
print(f"Wrote overnight_summary.json ({len(data.get('anomalies', []))} "
      f"anomalies, {len(data.get('data_quality', []))} data-quality flags)")
PY

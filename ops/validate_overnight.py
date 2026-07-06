#!/usr/bin/env python3
"""Validate and publish the dashboard-watcher's overnight summary.

Called by run_overnight_summary.sh as
    validate_overnight.py <out_dir> <raw_envelope_file> <merit_figures_file>
and importable by the unit tests (tests/test_overnight_validator.py), which
is why every check lives in a function that raises ValidationError instead
of exiting: the shell entry point turns that into a REFUSING TO PUBLISH
message and a non-zero exit, leaving the previously published summary
untouched.

Checks, in order: CLI envelope success → JSON extraction (tolerates fences
or a prose prefix by slicing first '{' to last '}') → per-tab schema (all
four sections, non-empty takeaway/analysis, at most two findings each) →
merit figures equal to the deterministic recompute injected into the prompt
(ops/merit_panel_figures.py) → assumption vocabulary (any efficiency or
carbon intensity quoted in prose must come from the documented reference
set — the failure class where the model invented "55% efficiency,
0.40 tCO2/MWh"). Stdlib only.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

TABS = ("overview", "merit_order", "spreads", "flows")
TITLES = {"overview": "Overview", "merit_order": "Merit order",
          "spreads": "Spreads", "flows": "Flows"}
FIG_KEYS = ("observed_price_gbp_mwh", "implied_clearing_gbp_mwh",
            "marginal_technology", "gap_pct")

# Documented reference values (methodology.md / state.js defaults): CCGT
# band 0.45-0.57 + spark reference 0.50, OCGT 0.32-0.40, coal 0.33-0.39 +
# dark reference 0.36; intensities THERMAL basis 0.184 gas / 0.34 coal.
ALLOWED_ETA = {"45", "50", "57", "32", "40", "33", "36", "39",
               "0.45", "0.50", "0.5", "0.57", "0.32", "0.40", "0.4",
               "0.33", "0.36", "0.39"}
ALLOWED_INTENSITY = {"0.184", "0.34"}

ETA_RE = re.compile(r"(\d{1,2}(?:\.\d+)?)\s*%\s*efficien|"
                    r"(?:η|eta)\s*(?:=|of|at)?\s*(0\.\d+)")
INTENSITY_RE = re.compile(r"(0\.\d+)\s*tCO2")


class ValidationError(Exception):
    pass


def assumption_violations(text):
    """Efficiency / carbon-intensity numbers in `text` outside the
    documented reference set. Returns [(kind, value), ...] — empty when
    clean. Carbon PRICES (e.g. £52.41/tCO2) do not match the intensity
    pattern, which requires a 0.xx value."""
    violations = []
    for m in ETA_RE.finditer(text):
        value = m.group(1) or m.group(2)
        if value not in ALLOWED_ETA:
            violations.append(("efficiency", value))
    for m in INTENSITY_RE.finditer(text):
        if m.group(1) not in ALLOWED_INTENSITY:
            violations.append(("intensity", m.group(1)))
    return violations


def extract_inner_json(envelope_text):
    """Agent JSON out of the CLI --output-format json envelope."""
    try:
        envelope = json.loads(envelope_text)
    except ValueError as error:
        raise ValidationError(
            f"CLI envelope is not valid JSON ({error}); "
            f"first 200 chars: {envelope_text[:200]!r}")
    if envelope.get("is_error") or envelope.get("subtype") != "success":
        raise ValidationError(
            "agent run failed "
            f"(subtype={envelope.get('subtype')!r}, "
            f"api_error_status={envelope.get('api_error_status')!r})")
    inner = (envelope.get("result") or "").strip()
    # Tolerate a fenced or prose-prefixed response despite instructions.
    if not inner.startswith("{") and "{" in inner and "}" in inner:
        inner = inner[inner.index("{"):inner.rindex("}") + 1]
    try:
        data = json.loads(inner)
    except ValueError as error:
        raise ValidationError(
            f"agent output is not valid JSON ({error}); "
            f"first 200 chars: {inner[:200]!r}")
    return data


def prose_strings(data):
    for tab in TABS:
        section = data["tabs"][tab]
        yield tab, section["takeaway"]
        yield tab, section["analysis"]
        for finding in section.get("findings", []):
            yield tab, f"{finding.get('title', '')} {finding.get('detail', '')}"


def validate_summary(data, reference):
    """Schema + merit-figure + vocabulary checks. `reference` is the parsed
    output of merit_panel_figures.py. Raises ValidationError."""
    if "error" in data:
        raise ValidationError(f"agent reported an error: {data['error']}")
    for key in ("window", "tabs", "data_quality"):
        if key not in data:
            raise ValidationError(f"missing key {key!r}")
    if not isinstance(data["window"], dict) \
            or not all(isinstance(data["window"].get(k), str)
                       for k in ("from", "to")):
        raise ValidationError("window must be an object with 'from'/'to' "
                              f"strings, got {data['window']!r}")
    if not isinstance(data["data_quality"], list):
        raise ValidationError("data_quality is not a list")
    for tab in TABS:
        section = data["tabs"].get(tab)
        if not isinstance(section, dict):
            raise ValidationError(f"missing tab section {tab!r}")
        for field in ("takeaway", "analysis"):
            if not isinstance(section.get(field), str) \
                    or not section[field].strip():
                raise ValidationError(f"{tab}.{field} missing or empty")
        findings = section.get("findings", [])
        if not isinstance(findings, list) or len(findings) > 2:
            raise ValidationError(
                f"{tab}.findings must be a list of <=2 (analysis over "
                f"enumeration — got {findings!r})")

    figures = data["tabs"]["merit_order"].get("figures")
    if not isinstance(figures, dict) or not set(FIG_KEYS) <= figures.keys():
        raise ValidationError("merit_order.figures missing or incomplete")
    # Cross-check against the deterministic recompute injected into the
    # prompt: the agent must carry the panel's own numbers, not its own.
    if "error" in reference:
        if any(figures[k] is not None for k in FIG_KEYS):
            raise ValidationError(
                f"panel inputs are missing ({reference}) so merit figures "
                f"must be null, got {figures}")
    else:
        for k in FIG_KEYS:
            want, got = reference["figures"][k], figures[k]
            same = (want == got if isinstance(want, str) or want is None
                    else isinstance(got, (int, float))
                         and abs(got - want) < 0.005)
            if not same:
                raise ValidationError(
                    f"merit figure {k} = {got!r} disagrees with the "
                    f"panel's own value {want!r}")

    for tab, text in prose_strings(data):
        for kind, value in assumption_violations(text):
            raise ValidationError(
                f"{tab} prose quotes {kind} {value!r}, not in the "
                "documented reference set (thermal basis: 0.184 gas, "
                "0.34 coal; documented η values only)")


def render_markdown(data):
    figures = data["tabs"]["merit_order"]["figures"]
    lines = [f"# Overnight summary — generated {data['generated_at']} (AI)"]
    for tab in TABS:
        section = data["tabs"][tab]
        lines += ["", f"## {TITLES[tab]}", "", f"**{section['takeaway']}**",
                  "", section["analysis"]]
        if tab == "merit_order":
            lines += ["", f"Observed £{figures['observed_price_gbp_mwh']} vs "
                      f"implied clearing £{figures['implied_clearing_gbp_mwh']} "
                      f"({figures['marginal_technology']}), "
                      f"gap {figures['gap_pct']}%"]
        for finding in section.get("findings", []):
            lines.append(f"- **{finding.get('title')}** — "
                         f"{finding.get('detail')}")
    lines += ["", "## Data quality", ""]
    lines += [f"- {f}" for f in data["data_quality"]] or []
    if not data["data_quality"]:
        lines.append("No flags.")
    return "\n".join(lines) + "\n"


def publish(data, out_dir):
    """Stamp publication time and write json + md atomically."""
    out_dir = Path(out_dir)
    # Publication metadata, not model content: always stamp the real time
    # (the model has no reliable clock).
    data["generated_at"] = datetime.now(timezone.utc).isoformat(
        timespec="seconds")
    tmp = out_dir / "overnight_summary.json.tmp"
    tmp.write_text(json.dumps(data, indent=1))
    os.replace(tmp, out_dir / "overnight_summary.json")
    md_tmp = out_dir / "overnight_summary.md.tmp"
    md_tmp.write_text(render_markdown(data))
    os.replace(md_tmp, out_dir / "overnight_summary.md")


def main(argv):
    out_dir, raw_file, fig_file = argv[1], argv[2], argv[3]
    reference = json.loads(Path(fig_file).read_text())
    try:
        data = extract_inner_json(Path(raw_file).read_text().strip())
        validate_summary(data, reference)
    except ValidationError as error:
        sys.exit(f"REFUSING TO PUBLISH: {error}")
    publish(data, out_dir)
    n_findings = sum(len(data["tabs"][t].get("findings", [])) for t in TABS)
    print(f"Wrote overnight_summary.json (4 tab sections, {n_findings} "
          f"findings, {len(data['data_quality'])} data-quality flags)")


if __name__ == "__main__":
    main(sys.argv)

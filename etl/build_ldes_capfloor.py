"""
LDES cap-and-floor Window 1 reference payload (plan/10 Phase 2, B1)
====================================================================
Writes app/data/ldes_capfloor.json: the vendored reference table behind
the Window 1 cap-and-floor card on the Batteries tab —

  * `status` — where the regime stands ("minded-to", key dates, the
    caveat that final awards supersede this list);
  * `totals` — the headline cut (16 projects, 7,645 MW, ~136.9 GWh);
  * `regime` — the Financial Framework building blocks (floor/cap
    returns, soft cap, MAT, BSUoS funding, FA threshold, RAV basis);
  * `projects` — the 16 minded-to projects (EA rank, name, technology,
    region, MW, duration, track, first-operation year);
  * `sources` — the two Ofgem publications every figure traces to.

This table is VENDORED, the same precedent as the TNUoS zone table in
etl/build_bess_units.py (fetch_tnuos, plan/09 D24) — except Ofgem
publishes PDFs, so there is no machine-readable source to poll at all:
the constants below were transcribed from the Ofgem "LDES Window 1:
minded-to decisions" consultation (published 26 June 2026) and the
September 2025 Financial Framework decision, all figures verified
28–29 Aug 2026. This build step exists to validate the table against
its own cross-checks on every run and to republish the payload (and
its manifest registration) atomically — it is updated BY HAND when
Ofgem publishes, next expected at final awards in autumn 2026 (see
plan/10's Watch row).

Unlike the sibling ETL modules this one deliberately does NOT import
etl/build_dataset.py: that module builds its SSL context from
certifi.where() at import time, and a vendored table with zero network
calls should stay runnable (and testable) on a bare stdlib
interpreter. The atomic tmp+rename write and the manifest registration
are small, and mirrored here verbatim (build_dataset._atomic_write;
build_bess_units.update_manifest).

Four tripwires (house convention — a hand-edit slip must raise, never
ship a corrupted reference card):
  * the project table must carry exactly 16 rows, every row complete
    and in range (duration 8–32 h, track 1 or 2, first operation
    2029–2033), with EA ranks strictly increasing and exactly the
    published set — the gaps (ranks 10, 11, 13) are real, those ranks
    were not selected;
  * the per-project MW must sum exactly to the published 7,645 MW
    total, and MW x duration must agree with the published ~136.9 GWh
    to within 0.1 GWh;
  * the regime block must carry the six key parameters (25-yr default,
    4.47 %/7.48 % CPIH-real indicative returns, 30 % soft-cap
    retention, 0.60 FA threshold, CPIH indexation) at their published
    values;
  * the payload must serialise under 16 kB and `status.stage` must
    still say "minded-to" — when final awards publish, the table, the
    stage and this module's docstring all change together.

Usage:
    python etl/build_ldes_capfloor.py
"""

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
OUT_DIR = PROJECT_DIR / "app" / "data"
OUT_PATH = OUT_DIR / "ldes_capfloor.json"

SCHEMA_VERSION = 1
PAYLOAD_BUDGET_BYTES = 16 * 1024

NAME = "LDES cap-and-floor: Window 1 reference (Ofgem)"
SOURCE = ("Ofgem LDES Window 1 minded-to decisions (26 June 2026) and "
          "LDES Window 1 Financial Framework decision (23 September "
          "2025) — vendored reference table, no live source to poll.")
QUALITY = ("reference (vendored regulatory table — minded-to positions "
           "and indicative rates, not final awards; transcribed from "
           "Ofgem publications, figures verified 28-29 Aug 2026; "
           "updated by hand when Ofgem publishes)")

# ---------------------------------------------------------------------------
# The vendored table — every figure traces to the two SOURCES entries
# ---------------------------------------------------------------------------

STATUS = {
    "stage": "minded-to",
    "published": "2026-06-26",
    "consultation_closed": "2026-08-14",
    "final_awards_expected": "autumn 2026",
    "note": ("16 of 73 eligible projects; superseded when final awards "
             "publish"),
}

TOTALS = {"projects": 16, "mw": 7645, "gwh_approx": 136.9}

REGIME = {
    "duration_years_default": 25,
    "floor_return_pct_cpih_real_indicative": 4.47,
    "floor_basis": ("iBoxx GBP Non-Financials 15+ BBB, 20-day average "
                    "before FID"),
    "cap_return_pct_cpih_real_indicative": 7.48,
    "cap_basis": "CAPM: beta 1.125, RFR 2.26%, TMR 6.9%",
    "soft_cap_retention_pct": 30,
    "indexation": "CPIH",
    "floor_condition": ("Minimum Availability Target (MAT), clawback if "
                        "missed"),
    "funding": "BSUoS via NESO",
    "fa_threshold": 0.60,
    "applied_to": ("100% of RAV (devex + capex + repex + decommex + IDC "
                   "+ transaction costs)"),
}

PROJECT_FIELDS = ("ea_rank", "name", "technology", "region", "mw",
                  "duration_h", "track", "first_operation")


def _project(ea_rank, name, technology, region, mw, duration_h, track,
             first_operation):
    return dict(zip(PROJECT_FIELDS, (ea_rank, name, technology, region,
                                     mw, duration_h, track,
                                     first_operation)))


PROJECTS = [
    _project(1, "Loch Kemp Storage", "PSH", "North Scotland", 660, 22.3, 1, 2030),
    _project(2, "Coire Glas", "PSH", "North Scotland", 1440, 32, 2, 2033),
    _project(3, "TeesCAES", "CAES", "North East England", 50, 30, 1, 2029),
    _project(4, "Earba PSH", "PSH", "North Scotland", 1800, 15, 2, 2033),
    _project(5, "Field Netherton", "Li-ion BESS", "North Scotland", 400, 16.3, 1, 2030),
    _project(6, "Field New Deer", "Li-ion BESS", "North Scotland", 400, 18.03, 1, 2030),
    _project(7, "Field Rigifa", "Li-ion BESS", "North Scotland", 200, 18.03, 1, 2030),
    _project(8, "Field Fyrish", "Li-ion BESS", "North Scotland", 200, 16.5, 1, 2030),
    _project(9, "Field Long Stratton", "Li-ion BESS", "East England", 400, 16.05, 2, 2033),
    _project(12, "East Claydon Storage", "Li-ion BESS", "East England", 500, 12, 1, 2030),
    _project(14, "Ocker Hill BESS", "Li-ion BESS", "West Midlands", 145, 8, 1, 2029),
    _project(15, "Sundon Storage", "Li-ion BESS", "East England", 500, 8, 1, 2030),
    _project(16, "Drakelow (Innova)", "Li-ion BESS", "West Midlands", 385, 8.7, 1, 2030),
    _project(17, "Frontier Legacy", "Vanadium flow/zinc hybrid", "North Wales", 65, 8, 1, 2029),
    _project(18, "Springwell", "Li-ion BESS", "East Midlands", 400, 11.1, 1, 2030),
    _project(19, "Thornton BESS 2", "Li-ion BESS", "East Midlands", 100, 11.11, 1, 2029),
]

# The gaps are real — Ofgem's EA ranking ran past 19, and ranks 10, 11
# and 13 were not selected (Kincardine, rank 13, excluded on diversity;
# see plan/10's source-base table).
EXPECTED_RANKS = (1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 14, 15, 16, 17, 18, 19)

SOURCES = [
    {"label": "Ofgem minded-to decisions (26 Jun 2026)",
     "url": ("https://www.ofgem.gov.uk/consultation/long-duration-"
             "electricity-storage-window-1-minded-decisions")},
    {"label": "Financial Framework decision (23 Sep 2025)",
     "url": ("https://www.ofgem.gov.uk/sites/default/files/2025-09/"
             "LDES%20Window%201%20Financial%20Framework%20Decision.pdf")},
]

# Methodology-tab provenance, in the exact meta.json series vocabulary
# (name/source/endpoint/unit/resolution/update_frequency/quality/
# transformations/notes) — the same in-payload registration
# etl/build_bess_revenue.py's SOURCE_META uses, because app/data/
# meta.json itself is regenerated wholesale by etl/build_dataset.py on
# every core refresh (and app/data/ is gitignored): an entry hand-edited
# there would be silently reverted the next morning. The UI reads this
# block from the payload instead.
SOURCE_META = {
    "ldes_capfloor": {
        "name": NAME,
        "source": ("Ofgem: LDES Window 1 minded-to decisions (26 June "
                   "2026) + Financial Framework decision (23 September "
                   "2025)"),
        "endpoint": ("none — vendored from Ofgem PDF publications (see "
                     "the payload's sources block for the two URLs)"),
        "unit": "mixed (MW, hours, %, years)",
        "resolution": "event/reference",
        "update_frequency": ("on Ofgem publication only — updated by "
                             "hand; next expected: final awards, autumn "
                             "2026"),
        "quality": QUALITY,
        "transformations": ("none — transcribed as published; totals "
                            "cross-checked against the per-project list "
                            "on every build"),
        "notes": ("16 of 73 eligible projects, 7,645 MW / ~136.9 GWh. "
                  "EA-rank gaps are real (ranks 10, 11 and 13 were not "
                  "selected). Floor/cap returns are indicative and "
                  "refix at each project's FID; per-project floor/cap "
                  "levels are withheld by Ofgem as commercially "
                  "sensitive."),
    },
}


# ---------------------------------------------------------------------------
# Tripwires — pure logic, everything the unit tests exercise
# ---------------------------------------------------------------------------

class ProjectTableError(RuntimeError):
    """Tripwire 1: the project table must carry exactly the 16 published
    rows, complete and in range, EA ranks strictly increasing with
    exactly the published gaps — a hand-edit slip (a dropped row, a
    typo'd duration, a duplicated rank) must raise, never ship."""


def assert_project_table(projects, expected_ranks=EXPECTED_RANKS):
    if len(projects) != len(expected_ranks):
        raise ProjectTableError(
            f"project table has {len(projects)} rows, expected "
            f"{len(expected_ranks)}")
    for row in projects:
        missing = [f for f in PROJECT_FIELDS if f not in row]
        if missing:
            raise ProjectTableError(
                f"project {row.get('name', row.get('ea_rank', '?'))!r} "
                f"is missing field(s) {missing}")
        extra = [f for f in row if f not in PROJECT_FIELDS]
        if extra:
            raise ProjectTableError(
                f"project {row['name']!r} carries unknown field(s) "
                f"{extra}")
        if not isinstance(row["ea_rank"], int):
            raise ProjectTableError(f"{row['name']!r}: ea_rank must be int")
        for field in ("name", "technology", "region"):
            if not (isinstance(row[field], str) and row[field]):
                raise ProjectTableError(
                    f"{row['name']!r}: {field} must be a non-empty string")
        if not (isinstance(row["mw"], (int, float)) and row["mw"] > 0):
            raise ProjectTableError(f"{row['name']!r}: mw must be positive")
        if not (isinstance(row["duration_h"], (int, float))
                and 8 <= row["duration_h"] <= 32):
            raise ProjectTableError(
                f"{row['name']!r}: duration_h {row['duration_h']!r} "
                "outside the published 8-32 h range")
        if row["track"] not in (1, 2):
            raise ProjectTableError(
                f"{row['name']!r}: track {row['track']!r} not in {{1, 2}}")
        if not (isinstance(row["first_operation"], int)
                and 2029 <= row["first_operation"] <= 2033):
            raise ProjectTableError(
                f"{row['name']!r}: first_operation "
                f"{row['first_operation']!r} outside 2029-2033")
    ranks = [row["ea_rank"] for row in projects]
    if any(ranks[i] >= ranks[i + 1] for i in range(len(ranks) - 1)):
        raise ProjectTableError("ea_rank not strictly increasing")
    if tuple(ranks) != tuple(expected_ranks):
        raise ProjectTableError(
            f"ea_rank set {ranks} != published {list(expected_ranks)} "
            "(the gaps at 10, 11 and 13 are real and must stay)")


class TotalsMismatch(RuntimeError):
    """Tripwire 2: the published headline totals must agree with the
    per-project list they summarise — 7,645 MW exactly, ~136.9 GWh to
    within 0.1 GWh."""


def assert_totals(projects, totals, gwh_tolerance=0.1):
    if totals["projects"] != len(projects):
        raise TotalsMismatch(
            f"totals.projects {totals['projects']} != {len(projects)} rows")
    mw_sum = sum(row["mw"] for row in projects)
    if mw_sum != totals["mw"]:
        raise TotalsMismatch(
            f"per-project MW sums to {mw_sum}, published total is "
            f"{totals['mw']}")
    gwh = sum(row["mw"] * row["duration_h"] for row in projects) / 1000
    if abs(gwh - totals["gwh_approx"]) > gwh_tolerance:
        raise TotalsMismatch(
            f"MW x duration sums to {gwh:.4f} GWh, published "
            f"~{totals['gwh_approx']} GWh (tolerance {gwh_tolerance})")


class RegimeParameterError(RuntimeError):
    """Tripwire 3: the six key Financial Framework parameters must sit at
    their published values — the card's regime panel quotes these
    directly."""


REGIME_KEY_PARAMS = {
    "duration_years_default": 25,
    "floor_return_pct_cpih_real_indicative": 4.47,
    "cap_return_pct_cpih_real_indicative": 7.48,
    "soft_cap_retention_pct": 30,
    "fa_threshold": 0.60,
    "indexation": "CPIH",
}


def assert_regime(regime, expected=REGIME_KEY_PARAMS):
    for key, value in expected.items():
        if key not in regime:
            raise RegimeParameterError(f"regime block is missing {key!r}")
        if regime[key] != value:
            raise RegimeParameterError(
                f"regime.{key} is {regime[key]!r}, published value is "
                f"{value!r}")
    for key in ("floor_basis", "cap_basis", "floor_condition", "funding",
                "applied_to"):
        if not regime.get(key):
            raise RegimeParameterError(f"regime block is missing {key!r}")


class StatusStageError(RuntimeError):
    """Tripwire 4a: the payload still says "minded-to" — when Ofgem's
    final awards publish, the stage, the table and the module docstring
    change together, not piecemeal."""


def assert_status(status):
    if status.get("stage") != "minded-to":
        raise StatusStageError(
            f"status.stage is {status.get('stage')!r}, this vintage of "
            "the table is the minded-to list")
    for key in ("published", "consultation_closed",
                "final_awards_expected", "note"):
        if not status.get(key):
            raise StatusStageError(f"status block is missing {key!r}")


class PayloadBudgetError(RuntimeError):
    """Tripwire 4b: the serialised payload must stay under the 16 kB
    budget — a reference card, not a dataset."""


def assert_payload_budget(blob_bytes, budget=PAYLOAD_BUDGET_BYTES):
    if len(blob_bytes) > budget:
        raise PayloadBudgetError(
            f"payload is {len(blob_bytes)} bytes, over the {budget}-byte "
            "budget")


def build_payload(built_at=None):
    """Assemble the full payload dict — pure, deterministic apart from
    the timestamp (injectable for the file-matches-builder test)."""
    return {
        "built_at": built_at or datetime.now(timezone.utc)
                                        .isoformat(timespec="seconds"),
        "schema": SCHEMA_VERSION,
        "name": NAME,
        "source": SOURCE,
        "quality": QUALITY,
        "status": STATUS,
        "totals": TOTALS,
        "regime": REGIME,
        "projects": PROJECTS,
        "sources": SOURCES,
        "meta": {"series": SOURCE_META},
    }


def validate_payload(payload):
    """Run every tripwire over a payload dict (the builder's own output
    or the shipped app/data file re-read from disk)."""
    assert_status(payload["status"])
    assert_regime(payload["regime"])
    assert_project_table(payload["projects"])
    assert_totals(payload["projects"], payload["totals"])
    assert_payload_budget(json.dumps(payload).encode())


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _atomic_write(path, text):
    """Write via tmp + rename so a crash never leaves a half-written file
    (build_dataset._atomic_write, mirrored — see the module docstring
    for why build_dataset is not imported here)."""
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def update_manifest(out_dir=None):
    """Register ldes_capfloor.json in the manifest — same pattern as
    every other ETL module (build_bess_units.update_manifest), stdlib
    reimplementation for the same no-certifi reason as _atomic_write."""
    out_dir = Path(out_dir) if out_dir else OUT_DIR
    manifest_path = out_dir / "manifest.json"
    if not manifest_path.exists():
        return
    manifest = json.loads(manifest_path.read_text())
    files = manifest.setdefault("files", {})
    blob = (out_dir / OUT_PATH.name).read_bytes()
    files["ldes_capfloor.json"] = {
        "sha256": hashlib.sha256(blob).hexdigest(),
        "bytes": len(blob),
    }
    manifest["version"] += 1
    _atomic_write(manifest_path, json.dumps(manifest, indent=2))


def build(out_dir=None):
    out_dir = Path(out_dir) if out_dir else OUT_DIR
    print("ldes cap-and-floor pipeline (Window 1 vendored reference, "
          "plan/10 B1)")

    payload = build_payload()
    validate_payload(payload)
    blob = json.dumps(payload).encode()

    out_dir.mkdir(parents=True, exist_ok=True)
    _atomic_write(out_dir / OUT_PATH.name, json.dumps(payload))
    update_manifest(out_dir)

    mw = sum(row["mw"] for row in payload["projects"])
    print(f"\nWrote {out_dir / OUT_PATH.name} ({len(blob) / 1024:.2f} kB, "
          f"budget {PAYLOAD_BUDGET_BYTES / 1024:.0f} kB): "
          f"{len(payload['projects'])} projects, {mw:,} MW, "
          f"~{payload['totals']['gwh_approx']} GWh; stage "
          f"{payload['status']['stage']!r}, final awards expected "
          f"{payload['status']['final_awards_expected']}")


if __name__ == "__main__":
    build()

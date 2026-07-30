"""
BESS observable activity tracker (plan/06 workstream C, #24)
==============================================================
Writes app/data/bess_activity.json: a signed daily/half-hourly stack of
accepted Balancing Mechanism offer MWh (+) vs bid MWh (-) for the identified
GB battery fleet, plus the fleet identification list and the per-day
normalisation denominator used to turn it into a per-MW intensity figure.

Phase A investigation (2026-07-29, live keyless Elexon Insights) required
three deviations from the plan/06 Workstream C shape — see
scratchpad/phaseA/phaseA_spec.md §0 for the full evidence:

  A. Physical boundary is "E_" and "T_" only. "V_" is the Virtual Lead
     Party (aggregator) namespace, not a physical-unit prefix — its
     portfolios mix batteries with DSR and are out of scope (a future,
     separate issue).
  B. The activity series is accepted BM volumes, NOT integrated BOALF
     levels. Integrating BOALF gives the unit's delivered position, not the
     accepted volume (acceptance level minus the FPN baseline, which is
     routinely non-zero for batteries); Elexon already publishes the
     correct figure directly. No BOALF call is needed at all.
  C. The caption never expresses identified capacity as a percentage of
     REPD (identified MW is 135% of REPD's operational figure — a
     ">100% coverage" caption would read as a data error). REPD is cited
     context prose only (meta.repd_context).

400-day window addendum (2026-07-30, scratchpad/phaseA/addendum_400d.md)
extends the above to align with plan/08's revenue payload. Five changes,
all evidence-driven:

  A. Per-day `denominator_mw` on a cumulative-entry rule (the summed
     registered capacity of identified units whose first observed non-zero
     accepted volume falls on or before that day). `fleet.window_active`
     is demoted from THE divisor to a caption/backwards-compatibility
     statistic equal to the last day's `denominator_mw`. A single
     build-level divisor was measured to understate the earliest 30 days
     of a 400-day window by 43% and to reverse the sign of the headline
     utilisation trend (+50% become a -15%) — the identified cohort's
     active capacity grew 2,316 to 4,276 MW over the window. This is NOT
     the per-day active-capacity divisor Phase A rejected (§4c below):
     that candidate is endogenous to the dispatch being measured (a quiet
     day shrinks it); a cumulative first-entry series is not (it only
     grows, and only on an entry, never on a quiet day).
  B. Tiered retention: every day carries daily totals, counts and the
     denominator (400 days); the newest 90 also carry the 48-slot HH
     arrays and `active_idx`; the newest 30 also carry `unit_acceptances`.
     One dict per day with optional fields, not two schema-versioned
     sections — the tier is implied by which optional fields are present
     and consumers never branch on it.
  C. Fetch shape: one call per side per day for the WHOLE fleet
     (BATCH_SIZE raised from a 30-unit test ceiling to 150; the 123-unit
     fleet fits one URL with zero stray rows), `accept_gzip=True` measured
     24.1x on this endpoint.
  D. `active_idx` stops being the divisor's state; `fleet.list[].
     first_active` takes over — the cumulative rule needs a first-seen
     date per unit, not a per-day set of active indices.
  E. Backfill by payload checkpoint (`_atomic_write` every
     CHECKPOINT_DAYS fetched days) instead of `USE_CACHE = True`: at 430
     fetched days the disk cache would be ~2.1 GB of decoded JSON for a
     225 kB payload.

Identification rule (§4a, recomputed fresh from the registry every run —
zero manual maintenance; see `identify()`):
    physical boundary  elexonBmUnit starts with E_ or T_
    capacity floor     generationCapacity >= 5 MW (excludes station-aux/GT
                       stubs; registry capacity fields are STRINGS and
                       must be coerced)
    demand exclusion   not a site-auxiliary/demand BMU (id ~ /D-\\d+$/ or
                       name containing "Demand")
    AND at least one of:
      structural  generationCapacity > 0 AND demandCapacity < 0 AND
                  |demandCapacity|/generationCapacity in [0.5, 1.5] AND
                  fuelType in (null, OTHER) AND not an interconnector
      name        (batter|bess|energy\\s*stor|\\bstorage\\b|\\bess\\b|
                  \\bbat\\d?\\b) matched against bmUnitName + elexonBmUnit +
                  nationalGridBmUnit ONLY — leadPartyName is deliberately
                  excluded (party names like "... Energy Storage Ltd" can
                  own non-battery plant).
Measured 2026-07-29: 123 units, 6,400 MW. Gates G1-G4 (recall, precision,
REPD-plausibility, payload budget) all PASS — see phaseA_spec.md §6.

Data source (§4b / addendum §D/§C): per day, per side (offer|bid), one
call for the WHOLE fleet (batched at BATCH_SIZE=150 unit ids, well above
the 123-unit fleet — the fleet would have to reach 300 units before the
call count changes from 2/day): GET /balancing/settlement/acceptance/
volumes/all/{side}/{date}?bmUnit=...&bmUnit=... with accept_gzip=True
(measured 24.1x on the wire). Unfiltered whole-day responses are 3.5-8 MB
per side, so filtering by unit is mandatory, not an optimisation. The same
acceptanceId can appear in BOTH the bid and offer response for a unit (0.0
on the side it did not use) — acceptance counts dedupe acceptanceId across
both sides, or every count doubles.

Normalisation (addendum §A, meta.normalisation): the per-MW toggle divides
each day by that day's own `denominator_mw` — the summed registered
capacity of identified units whose first observed non-zero accepted volume
falls on or before that day (`fleet.list[].first_active`). Monotone by
construction; a unit leaves the denominator only by leaving the BMU
registry or the identification rule, NEVER by going quiet (a quiet-day
exit would be endogenous to the activity being measured, exactly the
defect that ruled out a per-day active-capacity divisor: corr +0.355
between per-day `active_mw` and daily throughput over the stored window,
vs -0.086 for the cumulative-entry series). NOT `fleet.mw` either
(includes dormant/pre-commercial units, which would understate
utilisation for a reason that has nothing to do with dispatch).

Incremental state lives in the output file itself (the `days` dict), no
side-car state file — the `load_stress()` pattern. `fleet.list` is rebuilt
from the registry every run and reflects the CURRENT registry only:
historical days keep the volumes they were built with, a unit entering the
registry mid-window is not backfilled, and `cap_mw` is the unit's current
registered capacity applied to every historical day (an uprate silently
restates history; no capacity history is built). Because `fleet.list` is
rebuilt and re-sorted by capacity every run, a single new registry entry
shifts every later index — every retained HH-tier day's `active_idx` is
remapped by id before anything else touches it (`remap_active_idx()`), and
`first_active`/`last_active` are carried forward by id
(`carry_forward_activity_dates()`), or a reshuffled registry would silently
corrupt the divisor.

API traps carried from the verified Phase A investigation:
  * The acceptance-volumes endpoint accepts repeated `bmUnit=` params
    (tested to 150 per call, verified live 2026-07-30 with the whole
    123-unit fleet in one URL, zero stray rows) and returns only the units
    asked for — but per fetch_stress's FREQ precedent, the returned-range
    assertion is still mandatory: every row must carry the requested
    settlementDate and a bmUnit inside the requested batch, or the
    response is discarded.
  * `totalVolumeAccepted` is per (acceptance x settlement period); no
    duplicate (side, bmUnit, acceptanceId, settlementPeriod) tuples were
    found — safe to sum directly.
  * Revisions: a 3-day re-fetch tail is used for late acceptances and
    settlement restatements (longer than fetch_stress's 1-day tail —
    accepted volumes need it, per Phase A §2 endpoint notes).
  * B1610 (metered delivered output) is NOT fetched by this ETL: it
    publishes ~7 days in arrears, which is disqualifying for a
    same-day-updated panel. It remains a possible future "delivered vs
    instructed" overlay.

Usage:
    python etl/build_bess_activity.py                # daily incremental
    python etl/build_bess_activity.py --backfill 400  # one-off historical,
                                                       # ~430 fetched days
                                                       # (400 shipped + 30
                                                       # burn-in), ~50 min,
                                                       # checkpointed every
                                                       # CHECKPOINT_DAYS
                                                       # fetched days so an
                                                       # interruption
                                                       # resumes.
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))

PROJECT_DIR = Path(__file__).resolve().parents[1]
OUT_DIR = PROJECT_DIR / "app" / "data"
ACTIVITY_PATH = OUT_DIR / "bess_activity.json"

LONDON = ZoneInfo("Europe/London")

SCHEMA_VERSION = 2

RETAIN_DAYS = 400              # every day: totals + counts + denominator
HH_DAYS = 90                   # newest N also carry the 48-slot arrays
UNIT_DETAIL_DAYS = 30          # newest N also carry unit_acceptances
BURN_IN_DAYS = 30              # fetched to seed first_active; never stored
REFETCH_TAIL_DAYS = 3          # late acceptances / settlement restatements
BATCH_SIZE = 150               # max bmUnit= params per call, verified §D
CHECKPOINT_DAYS = 20           # backfill payload checkpoint interval
PAYLOAD_GUARD_BYTES = 300 * 1024
TOP_N_UNIT_DETAIL = 20         # payload-guard fallback, step 1 of §C

CAP_FLOOR = 5.0
RATIO_LO, RATIO_HI = 0.5, 1.5
PHYSICAL_PREFIXES = ("E_", "T_")
DEMAND_ID_RE = re.compile(r"D-\d+$")
DEMAND_NAME_RE = re.compile(r"\bdemand\b", re.I)
NAME_PAT = re.compile(
    r"(batter|bess|energy\s*stor|\bstorage\b|\bess\b|\bbat\d?\b)", re.I)

IDENTIFICATION_META = {
    "rule": "elexonBmUnit prefix E_/T_; generationCapacity >= 5 MW; not a "
            "site demand BMU (id ~ /D-\\d+$/ or name containing 'Demand'); "
            "and (structural signature OR battery name pattern)",
    "structural": "generationCapacity > 0 AND demandCapacity < 0 AND "
                  "|demandCapacity|/generationCapacity in [0.5, 1.5] AND "
                  "fuelType in (null, OTHER) AND not an interconnector",
    "name_pattern": "(batter|bess|energy\\s*stor|\\bstorage\\b|\\bess\\b|"
                    "\\bbat\\d?\\b) over bmUnitName + elexonBmUnit + "
                    "nationalGridBmUnit",
    "boundary_note": "Virtual Lead Party units (V_) are excluded: that "
                     "prefix is the aggregator namespace and its "
                     "portfolios mix batteries with DSR.",
    "measured": {
        "recall_structural_on_named": 0.97,    # 72/74, 2026-07-29
        "confirmed_mw_share": 0.75,            # §1c, sample week
    },
}

NORMALISATION_META = {
    "divisor": "days[].denominator_mw",
    "definition": "registry generationCapacity of the identified units "
                  "whose first observed non-zero accepted volume falls on "
                  "or before that day; recomputed every build, one value "
                  "per day",
    "why_cumulative": "the identified cohort's active capacity grew "
                      "2,316 to 4,276 MW over the stored window, so one "
                      "build-level divisor understates the earliest 30 "
                      "days by 43% and reverses the sign of the "
                      "utilisation trend",
    "why_not_per_day": "a same-day active-capacity divisor is endogenous "
                       "to the dispatch being measured (corr +0.355 over "
                       "the stored window, +0.88 on the Phase A sample "
                       "week); the cumulative series is not (corr -0.086)",
    "why_not_total_fleet": "identified capacity includes registered but "
                           "dormant/pre-commercial units (32 units, "
                           "2,124 MW never observed dispatched), which "
                           "would understate utilisation",
    "exit_rule": "a unit leaves the denominator only by leaving the BMU "
                 "registry or the identification rule, never by going "
                 "quiet: a quiet-day exit would be endogenous",
}

SERIES_META = {
    "name": "GB battery fleet: accepted Balancing Mechanism volumes",
    "source": "Elexon Insights API, balancing settlement acceptance volumes",
    "endpoint": "/balancing/settlement/acceptance/volumes/all/{bid|offer}/"
               "{date}",
    "unit": "MWh per settlement period",
    "resolution": "30 min",
    "update_frequency": "same day (interim settlement runs; values may be "
                        "restated by later runs)",
    "quality": "observed",
    "transformations": "summed across the identified units; offer volumes "
                       "positive, bid volumes negative; acceptance counts "
                       "dedupe acceptanceId across the bid and offer "
                       "responses",
    "notes": "Accepted volume is the instructed deviation from each unit's "
            "own notified position, not delivered energy: an offer means "
            "'go above your notified level' (discharge more or charge "
            "less), a bid means 'go below it'. Metered delivered output "
            "(B1610) is not used because it publishes about seven days in "
            "arrears. No prices, revenues or state of charge are derived.",
}

REPD_CONTEXT = {                   # CONTEXT ONLY — never a divisor (§0C)
    "sites": 171, "mw": 4755, "vintage": "Q1 2026",
    "source": "REPD, gov.uk, OGL v3.0",
    "note": "Planning-derived and site-level; it does not enumerate BM "
           "Unit ids and is not directly comparable with the BM-registered "
           "capacity identified here.",
}


def _core():
    """The shared HTTP/cache layer, imported lazily so the pure identify/
    aggregate logic below stays importable where certifi is absent (the CI
    test runner is stdlib-only)."""
    import build_dataset
    return build_dataset


# ---------------------------------------------------------------------------
# Pure logic — identification (no I/O) — §4a / §7 items 1-11
# ---------------------------------------------------------------------------

def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _unit_blob(row):
    return " ".join(str(row.get(key) or "") for key in
                    ("bmUnitName", "elexonBmUnit", "nationalGridBmUnit"))


def _name_match(row):
    return bool(NAME_PAT.search(_unit_blob(row)))


def _is_demand_bmu(row):
    return bool(DEMAND_ID_RE.search(row.get("elexonBmUnit") or "")
                or DEMAND_NAME_RE.search(str(row.get("bmUnitName") or "")))


def _structural(row):
    gen, dem = _num(row.get("generationCapacity")), _num(row.get("demandCapacity"))
    if gen is None or dem is None or gen <= 0 or dem >= 0:
        return False
    if not (RATIO_LO <= abs(dem) / gen <= RATIO_HI):
        return False
    if row.get("fuelType") not in (None, "OTHER"):
        return False
    if row.get("interconnectorId") or (row.get("elexonBmUnit") or "").startswith("I_"):
        return False
    return True


def identify(row):
    """§4a rule, exact. Returns the matched leg ("structural", "name" or
    "structural+name") or None. Recomputed fresh from the registry every
    refresh — zero manual maintenance."""
    unit_id = row.get("elexonBmUnit") or ""
    if not unit_id.startswith(PHYSICAL_PREFIXES):
        return None
    gen = _num(row.get("generationCapacity"))
    if gen is None or gen < CAP_FLOOR:
        return None
    if _is_demand_bmu(row):
        return None
    is_structural = _structural(row)
    is_name = _name_match(row)
    if not (is_structural or is_name):
        return None
    if is_structural and is_name:
        return "structural+name"
    return "structural" if is_structural else "name"


def identify_fleet(rows):
    """Registry rows -> the identified fleet, sorted by cap_mw desc (ties
    broken by id for determinism). One row per qualifying unit."""
    fleet = []
    for row in rows:
        leg = identify(row)
        if leg is None:
            continue
        fleet.append({
            "id": row.get("elexonBmUnit"),
            "ng": row.get("nationalGridBmUnit"),
            "name": row.get("bmUnitName"),
            "party": row.get("leadPartyName"),
            "cap_mw": round(_num(row.get("generationCapacity")), 1),
            "leg": leg,
        })
    fleet.sort(key=lambda u: (-u["cap_mw"], u["id"]))
    return fleet


# ---------------------------------------------------------------------------
# Pure logic — aggregation (no I/O) — §7 items 12-17
# ---------------------------------------------------------------------------

class RangeViolation(RuntimeError):
    """Acceptance volumes returned a row outside the requested day or unit
    batch — the FREQ-style silent-parameter trap, carried from
    fetch_stress. The response must be discarded, never stored."""


def check_returned_range(rows, day, unit_ids):
    """Mandatory returned-range assertion (§4b): every row must carry the
    requested settlementDate and a bmUnit inside the requested batch."""
    allowed = set(unit_ids)
    for row in rows:
        if row.get("settlementDate") != str(day):
            raise RangeViolation(
                f"acceptance volumes: asked {day}, got "
                f"{row.get('settlementDate')!r}")
        if row.get("bmUnit") not in allowed:
            raise RangeViolation(
                f"acceptance volumes: bmUnit {row.get('bmUnit')!r} outside "
                "the requested batch")


def sp_count_for_day(day):
    """Half-hour settlement periods in a local calendar day: 46/48/50 on
    clock-change days. Arrays must not hard-code 48 (§4c)."""
    start = datetime(day.year, day.month, day.day, tzinfo=LONDON)
    end = start + timedelta(days=1)
    seconds = (end.astimezone(timezone.utc)
              - start.astimezone(timezone.utc)).total_seconds()
    return round(seconds / 1800)


def aggregate_day(rows, sp_count):
    """One day's rows (each with side "offer"|"bid", bmUnit,
    settlementPeriod, totalVolumeAccepted, acceptanceId) -> the day's
    signed HH stack + acceptance counts. `acceptances` and `active_units`
    dedupe acceptanceId across both sides (§2/§7 item 13); zero-volume rows
    count towards neither (item 14) and never raise."""
    offer = [0.0] * sp_count
    bid = [0.0] * sp_count
    day_acceptance_ids = set()
    unit_acceptance_ids = {}
    for row in rows:
        vol = row.get("totalVolumeAccepted")
        if vol is None:
            continue
        sp = row.get("settlementPeriod")
        if sp is None or not (1 <= sp <= sp_count):
            continue
        idx = sp - 1
        if row.get("side") == "offer":
            offer[idx] += vol
        elif row.get("side") == "bid":
            bid[idx] += vol
        if vol:
            day_acceptance_ids.add(row.get("acceptanceId"))
            unit = row.get("bmUnit")
            if unit:
                unit_acceptance_ids.setdefault(unit, set()).add(
                    row.get("acceptanceId"))
    return {
        "offer_mwh": [round(v, 1) for v in offer],
        "bid_mwh": [round(v, 1) for v in bid],
        "acceptances": len(day_acceptance_ids),
        "active_units": set(unit_acceptance_ids),
        "unit_acceptance_counts": {u: len(ids)
                                   for u, ids in unit_acceptance_ids.items()},
    }


# ---------------------------------------------------------------------------
# Pure logic — schema-1 -> schema-2 migration (addendum §B2 step 2 / §E1)
# ---------------------------------------------------------------------------

def migrate_days(days):
    """schema 1 -> 2: derive `offer_mwh_total` / `bid_mwh_total` from the
    HH arrays wherever a day does not already carry them. Idempotent — a
    day that already has the totals (already schema 2, or freshly fetched
    this run) is left untouched. Must run BEFORE `downgrade_hh()`, which
    deletes the HH arrays these totals are derived from (test 25)."""
    for entry in days.values():
        if "offer_mwh_total" not in entry and "offer_mwh" in entry:
            entry["offer_mwh_total"] = round(sum(entry["offer_mwh"]), 1)
        if "bid_mwh_total" not in entry and "bid_mwh" in entry:
            entry["bid_mwh_total"] = round(sum(entry["bid_mwh"]), 1)
    return days


def seed_first_active_from_active_idx(fleet_list, days):
    """§B2 step 6 / §E1: schema-1 upgrade path. For each unit, the
    earliest stored day (sorted date order) on which its (already
    remapped) index appears in that day's `active_idx`. A unit absent from
    every day's `active_idx` gets `None` (never observed dispatched in the
    stored window) — correct in form, left-censored in value (the backfill
    corrects it via `merge_first_active`, earliest wins)."""
    first = {u["id"]: None for u in fleet_list}
    for key in sorted(days):
        idx = days[key].get("active_idx")
        if not idx:
            continue
        for i in idx:
            if 0 <= i < len(fleet_list):
                unit_id = fleet_list[i]["id"]
                if first[unit_id] is None or key < first[unit_id]:
                    first[unit_id] = key
    return first


def merge_first_active(carried, observed):
    """Earliest of the carried and the observed value wins, per unit id
    (§B2 step 8 / §E1). Makes the schema-1 migration seed idempotent and
    the backfill correct regardless of the order days are fetched in: a
    burn-in day observed after the main fetch still revises a later seed
    downward."""
    merged = dict(carried)
    for unit_id, day in observed.items():
        if day is None:
            continue
        if merged.get(unit_id) is None or day < merged[unit_id]:
            merged[unit_id] = day
    return merged


def carry_forward_activity_dates(prev_fleet_list, fleet_list):
    """§B2 step 4: `first_active` / `last_active` carried forward BY ID
    from the previous fleet.list to the rebuilt one (fleet.list is
    re-sorted by capacity every run, so position cannot be trusted). A
    unit new to the registry this run starts at `None` (never observed); a
    unit that has left the identified set is simply absent from the
    returned dicts."""
    prev_first = {u["id"]: u.get("first_active") for u in prev_fleet_list}
    prev_last = {u["id"]: u.get("last_active") for u in prev_fleet_list}
    first_active = {u["id"]: prev_first.get(u["id"]) for u in fleet_list}
    last_active = {u["id"]: prev_last.get(u["id"]) for u in fleet_list}
    return first_active, last_active


# ---------------------------------------------------------------------------
# Pure logic — divisor / incremental remap / retention / tiering
# — §7 items 15, 18-23 + addendum §G items 24-31
# ---------------------------------------------------------------------------

def remap_active_idx(old_fleet_list, new_fleet_list, active_idx):
    """Convert a day's active_idx from indices into old_fleet_list to
    indices into new_fleet_list, by unit id (§4d). fleet.list is rebuilt
    and re-sorted from the registry every run, so a single new entry shifts
    every later index; this must run before ANY retained HH-tier day is
    otherwise touched. Ids no longer present in new_fleet_list (a
    de-registered unit, or the rule no longer matching it) are dropped —
    never raises."""
    old_ids = [u["id"] for u in old_fleet_list]
    new_index = {u["id"]: i for i, u in enumerate(new_fleet_list)}
    ids = (old_ids[i] for i in active_idx if 0 <= i < len(old_ids))
    return sorted({new_index[i] for i in ids if i in new_index})


def active_index_union(days):
    """Union of active_idx across every HH-tier day in the dict — retained
    only for the fleet-table `window_active` flag's backwards-compatible
    sibling and audit purposes; it is NOT the divisor's state (addendum
    §D)."""
    idx = set()
    for entry in days.values():
        idx.update(entry.get("active_idx") or [])
    return idx


def denominator_mw_series(fleet_list, first_active, days):
    """Per-day cumulative-entry denominator (addendum §A3): the summed
    cap_mw of identified units whose first_active falls on or before that
    day. Monotone non-decreasing by construction — a unit only ever
    enters, never exits on a quiet day (exit is by registry only, §A4) —
    and therefore uncorrelated with same-day dispatch (§A2), unlike the
    per-day active-capacity candidate Phase A already rejected. `days` is
    a sorted iterable of ISO day strings; `first_active` maps unit id ->
    first-active day string or None (never observed)."""
    out = []
    for day in days:
        total = sum(u["cap_mw"] for u in fleet_list
                    if first_active.get(u["id"]) is not None
                    and first_active[u["id"]] <= day)
        out.append(round(total, 1))
    return out


def denominator_units_series(fleet_list, first_active, days):
    """Companion unit count to denominator_mw_series, for
    days[].denominator_units."""
    out = []
    for day in days:
        count = sum(1 for u in fleet_list
                    if first_active.get(u["id"]) is not None
                    and first_active[u["id"]] <= day)
        out.append(count)
    return out


class DenominatorInvariantError(RuntimeError):
    """A build-time invariant on denominator_mw or first_active failed
    (§B3) — the divisor's correctness is load-bearing enough that a
    violation must not ship silently."""


def assert_invariants(sorted_days, days, denom_mw, fleet_list, first_active,
                      prev_first_active=None):
    """§B3, cheap build-time checks:
      * denominator_mw is non-decreasing over sorted(days) and > 0 on
        every day (the only legitimate zero is a payload whose every day
        precedes any observed activity, which should never ship);
      * every HH-tier day's active_idx resolves to units with
        first_active <= that day;
      * first_active never moves later for a unit that already had one
        (checked against `prev_first_active`, the pre-merge carried
        dict, if supplied — merge_first_active guarantees this by
        construction, so this is a defensive re-check, not new logic).
    Warns (does not raise) if the window opens below 20% of its closing
    value — that signals a lost or unseeded first_active, whose failure
    mode is a divisor near zero and per-MW figures an order of magnitude
    too large."""
    for i in range(1, len(denom_mw)):
        if denom_mw[i] < denom_mw[i - 1]:
            raise DenominatorInvariantError(
                f"denominator_mw decreased on {sorted_days[i]}: "
                f"{denom_mw[i - 1]} -> {denom_mw[i]}")
    for day, value in zip(sorted_days, denom_mw):
        if value <= 0:
            raise DenominatorInvariantError(
                f"denominator_mw is {value} on {day}: every shipped day "
                "should follow at least one unit's first observed "
                "activity")

    ids_by_index = [u["id"] for u in fleet_list]
    for day in sorted_days:
        idx = days.get(day, {}).get("active_idx")
        if not idx:
            continue
        for i in idx:
            if 0 <= i < len(ids_by_index):
                unit_id = ids_by_index[i]
                fa = first_active.get(unit_id)
                if fa is None or fa > day:
                    raise DenominatorInvariantError(
                        f"{day}: active_idx unit {unit_id} has "
                        f"first_active {fa!r} after the day itself")

    if prev_first_active:
        for unit_id, prev_day in prev_first_active.items():
            if prev_day is None:
                continue
            new_day = first_active.get(unit_id)
            if new_day is None or new_day > prev_day:
                raise DenominatorInvariantError(
                    f"first_active for {unit_id} moved later: "
                    f"{prev_day} -> {new_day}")

    if denom_mw and denom_mw[0] < 0.2 * denom_mw[-1]:
        print(f"  WARNING: denominator_mw opens at {denom_mw[0]:.1f} MW "
              f"against {denom_mw[-1]:.1f} MW at window close (< 20%) — "
              "check first_active is seeded/merged correctly")


def trim_retention(days, retain_days=RETAIN_DAYS):
    """Oldest-first trim to at most `retain_days` days (§4d)."""
    if len(days) <= retain_days:
        return days
    keep = sorted(days)[-retain_days:]
    return {k: days[k] for k in keep}


def downgrade_hh(days, hh_days=HH_DAYS):
    """§B2 step 10: drop `offer_mwh` / `bid_mwh` / `active_idx` from every
    day older than the newest `hh_days`. The totals those arrays feed
    (`offer_mwh_total` / `bid_mwh_total`) must already be written — by
    `aggregate_day`'s fresh fetch or by `migrate_days()` for a day
    inherited from schema 1 — or the day's totals are lost outright (test
    25 pins this ordering)."""
    if not days:
        return days
    tail = set(sorted(days)[-hh_days:]) if hh_days > 0 else set()
    for key, entry in days.items():
        if key not in tail:
            entry.pop("offer_mwh", None)
            entry.pop("bid_mwh", None)
            entry.pop("active_idx", None)
    return days


def trim_unit_detail(days, unit_detail_days=UNIT_DETAIL_DAYS):
    """Strip unit_acceptances from days outside the most-recent
    `unit_detail_days` tail; the daily totals and denominator are kept for
    the full retention window (§4d)."""
    if not days:
        return days
    tail = set(sorted(days)[-unit_detail_days:])
    for key, entry in days.items():
        if key not in tail:
            entry.pop("unit_acceptances", None)
    return days


# ---------------------------------------------------------------------------
# Fetchers (verified in Phase A / addendum §C-§D; see module docstring)
# ---------------------------------------------------------------------------

def _rows(payload):
    if isinstance(payload, list):
        return payload
    return payload.get("data", [])


def fetch_registry():
    core = _core()
    return _rows(json.loads(core.http(f"{core.ELEXON}/reference/bmunits/all")))


def fetch_acceptance_day(day, unit_ids):
    """Both sides of accepted volumes for `day`, filtered to `unit_ids` in
    batches of BATCH_SIZE (2 calls for the whole 123-unit fleet — verified
    live 2026-07-30, 123 ids in one URL, zero stray rows). Raises
    RangeViolation (discard, never store) if any batch's response strays
    outside the requested day or unit set. accept_gzip=True: measured
    24.1x smaller on the wire on this endpoint (addendum §D)."""
    core = _core()
    rows = []
    for side in ("offer", "bid"):
        for i in range(0, len(unit_ids), BATCH_SIZE):
            batch = unit_ids[i:i + BATCH_SIZE]
            query = "&".join(f"bmUnit={u}" for u in batch)
            url = (f"{core.ELEXON}/balancing/settlement/acceptance/volumes/"
                   f"all/{side}/{day}?{query}")
            batch_rows = _rows(json.loads(core.http(url, accept_gzip=True)))
            check_returned_range(batch_rows, day, batch)
            for row in batch_rows:
                row["side"] = side
                rows.append(row)
    return rows


def active_units_for_day(day, unit_ids):
    """Burn-in helper (addendum §A5): the set of unit ids with at least
    one non-zero accepted volume on `day`, without building or storing a
    full day entry. Same fetch as fetch_acceptance_day + aggregate_day,
    just discarding everything but the active-unit set."""
    rows = fetch_acceptance_day(day, unit_ids)
    return aggregate_day(rows, sp_count_for_day(day))["active_units"]


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def load_activity():
    try:
        return json.loads(ACTIVITY_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def apply_payload_guard(payload):
    """§C: if the serialised payload exceeds the 300 kB budget, degrade in
    the ordered sequence below and log which steps fired. NEVER drops
    `denominator_mw` or `fleet.list[].first_active` — those are the
    divisor. (The old guard note protecting `active_idx` instead no
    longer holds: the divisor's state moved to `first_active` under the
    400-day addendum.)

      1. unit_acceptances -> top 20 units/day (saves ~28 kB over the tail)
      2. drop active_idx from the HH tier entirely (saves ~29 kB, costs
         only the §B1(3) active_idx self-check)
      3. cut the HH tier from 90 to 60 days (saves ~28 kB)
    """
    text = json.dumps(payload)
    if len(text.encode()) <= PAYLOAD_GUARD_BYTES:
        return text

    steps = []
    for entry in payload["days"].values():
        counts = entry.get("unit_acceptances")
        if counts and len(counts) > TOP_N_UNIT_DETAIL:
            entry["unit_acceptances"] = dict(
                sorted(counts.items(), key=lambda kv: -kv[1])[:TOP_N_UNIT_DETAIL])
    steps.append("unit_acceptances trimmed to the top 20 units/day")
    text = json.dumps(payload)

    if len(text.encode()) > PAYLOAD_GUARD_BYTES:
        for entry in payload["days"].values():
            entry.pop("active_idx", None)
        steps.append("active_idx dropped from the HH tier")
        text = json.dumps(payload)

    if len(text.encode()) > PAYLOAD_GUARD_BYTES:
        downgrade_hh(payload["days"], hh_days=60)
        steps.append("HH tier cut from 90 to 60 days")
        text = json.dumps(payload)

    print(f"  WARNING: payload {len(text.encode()) / 1024:.0f} kB exceeded "
          f"the {PAYLOAD_GUARD_BYTES / 1024:.0f} kB guard, degraded: "
          + "; ".join(steps))
    return text


def update_manifest():
    """Register bess_activity.json in the manifest, same pattern as
    fetch_stress.update_manifest()."""
    core = _core()
    manifest_path = OUT_DIR / "manifest.json"
    if not manifest_path.exists():
        return
    manifest = json.loads(manifest_path.read_text())
    files = manifest.setdefault("files", {})
    blob = ACTIVITY_PATH.read_bytes()
    files["bess_activity.json"] = {"sha256": hashlib.sha256(blob).hexdigest(),
                                   "bytes": len(blob)}
    manifest["version"] += 1
    core._atomic_write(manifest_path, json.dumps(manifest, indent=2))


def _assemble_and_write(fleet_list, days, first_active, last_active, failures,
                        prev_first_active=None, checkpoint=False):
    """§B2 steps 9-15: trim retention, downgrade the HH/unit-detail tiers,
    compute the per-day denominator, run the build-time invariants, apply
    the payload guard and write. Shared by the mid-backfill checkpoint
    writes and the final write so a checkpoint is always a fully valid,
    self-consistent schema-2 payload — an interrupted backfill resumes
    from one, not from a special partial format."""
    core = _core()
    days = trim_retention(days, RETAIN_DAYS)          # step 9
    days = downgrade_hh(days, HH_DAYS)                # step 10
    days = trim_unit_detail(days, UNIT_DETAIL_DAYS)   # step 11

    sorted_days = sorted(days)
    denom_mw = denominator_mw_series(fleet_list, first_active, sorted_days)   # step 12
    denom_units = denominator_units_series(fleet_list, first_active, sorted_days)
    for key, mw, units in zip(sorted_days, denom_mw, denom_units):
        days[key]["denominator_mw"] = mw
        days[key]["denominator_units"] = units

    window_active_mw = denom_mw[-1] if denom_mw else 0.0        # step 13
    window_active_units = denom_units[-1] if denom_units else 0
    for unit in fleet_list:
        unit["first_active"] = first_active.get(unit["id"])
        unit["last_active"] = last_active.get(unit["id"])
        unit["window_active"] = unit["first_active"] is not None

    assert_invariants(sorted_days, days, denom_mw, fleet_list,             # step 14
                      first_active, prev_first_active=prev_first_active)

    fleet_mw = round(sum(u["cap_mw"] for u in fleet_list), 1)
    built_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    window = {"from": min(days), "to": max(days)} if days else None

    payload = {
        "meta": {
            "built_at": built_at,
            "schema": SCHEMA_VERSION,
            "window": window,
            "tiers": {
                "retention_days": RETAIN_DAYS,
                "hh_days": HH_DAYS,
                "unit_detail_days": UNIT_DETAIL_DAYS,
                "burn_in_days": BURN_IN_DAYS,
            },
            "quality": "observed (Elexon settlement accepted volumes); the "
                      "identified fleet is derived from observed registry "
                      "attributes by the deterministic rule below, not "
                      "asserted",
            "identification": IDENTIFICATION_META,
            "normalisation": NORMALISATION_META,
            "series": SERIES_META,
            "repd_context": REPD_CONTEXT,
            "notes": [
                "fleet is rebuilt from the BMU registry every run and "
                "reflects the current registry only; a unit's cap_mw is "
                "its CURRENT registered generationCapacity, applied to "
                "every historical day (an uprate silently restates "
                "history; no capacity history is built).",
                "a unit leaves the denominator only by leaving the BMU "
                "registry or the identification rule (rare, disclosed "
                "here); it never leaves by going quiet, because a "
                "quiet-day exit would be endogenous to the activity "
                "being measured.",
                "acceptance volume requests carry a mandatory "
                "returned-range assertion (the FREQ-style "
                "silent-parameter trap, carried from fetch_stress).",
            ],
            "fetch_failures": failures or [],
        },
        "fleet": {
            "units": len(fleet_list),
            "mw": fleet_mw,
            "window_active": {
                "units": window_active_units,
                "mw": window_active_mw,
                "definition": "identified units first dispatched on or "
                              "before the last stored day; equal to that "
                              "day's denominator_mw. Retained for the "
                              "fleet caption and for backwards "
                              "compatibility with a reader written "
                              "against schema 1, which divided everything "
                              "by this value.",
            },
            "list": fleet_list,
        },
        "days": {k: days[k] for k in sorted_days},
    }

    text = apply_payload_guard(payload)
    core._atomic_write(ACTIVITY_PATH, text)
    if not checkpoint:
        update_manifest()

    size_kb = len(text.encode()) / 1024
    label = "checkpoint" if checkpoint else "Wrote bess_activity.json"
    print(f"  {label} ({size_kb:.0f} kB, {len(days)} days): "
          f"{len(fleet_list)} units / {fleet_mw:.0f} MW identified, "
          f"denominator {denom_mw[0] if denom_mw else 0:.0f} -> "
          f"{denom_mw[-1] if denom_mw else 0:.0f} MW", flush=True)
    return days


def build(backfill_days=None):
    core = _core()
    core.USE_CACHE = False   # §E2: always fresh, backfill included — a 430
                             # day disk cache is ~2.1 GB for a 225 kB payload

    yesterday = date.today() - timedelta(days=1)
    prev = load_activity()
    prev_schema = (prev or {}).get("meta", {}).get("schema", 1)
    prev_fleet_list = (prev or {}).get("fleet", {}).get("list", [])
    days = {k: dict(v) for k, v in (prev or {}).get("days", {}).items()}
    days = migrate_days(days)   # §B2 step 2

    if backfill_days:
        start = yesterday - timedelta(days=backfill_days - 1)
        burn_in_start = start - timedelta(days=BURN_IN_DAYS)
        mode = f"backfill {backfill_days}d"
    else:
        if days:
            start = date.fromisoformat(max(days)) - timedelta(
                days=REFETCH_TAIL_DAYS - 1)
        else:
            start = yesterday
        burn_in_start = None
        mode = "incremental"
    if start > yesterday:
        print("Nothing to fetch — dataset already ends at yesterday")
        return
    print(f"bess activity pipeline [{mode}]: {start} -> {yesterday}")

    print("  BMU registry…")
    fleet_list = identify_fleet(fetch_registry())
    id_index = {u["id"]: i for i, u in enumerate(fleet_list)}
    cap_by_id = {u["id"]: u["cap_mw"] for u in fleet_list}
    unit_ids = sorted(id_index)
    print(f"  identified {len(fleet_list)} units / "
          f"{sum(u['cap_mw'] for u in fleet_list):.1f} MW")

    # §B2 step 4: carry first_active/last_active forward BY ID.
    first_active, last_active = carry_forward_activity_dates(
        prev_fleet_list, fleet_list)
    prev_first_active_snapshot = dict(first_active)

    # §B2 step 5: remap active_idx on every retained HH-tier day — must
    # precede everything else that touches a retained day.
    for entry in days.values():
        if "active_idx" in entry:
            entry["active_idx"] = remap_active_idx(
                prev_fleet_list, fleet_list, entry.get("active_idx") or [])

    # §B2 step 6 / §E1: a schema-1 payload (no unit carries a first_active
    # yet) is seeded from the remapped active_idx.
    if days and not any(v is not None for v in first_active.values()):
        first_active = seed_first_active_from_active_idx(fleet_list, days)
        prev_first_active_snapshot = dict(first_active)
        print(f"  seeded first_active for {sum(1 for v in first_active.values() if v)}"
              " units from active_idx (schema-1 upgrade)")

    # Burn-in (backfill only, §A5): fetch window_start-30..window_start-1,
    # seed first_active ONLY — never stored in `days`. Refetched on every
    # backfill invocation (including a resumed one); at ~60 calls this is
    # acceptable (§E2).
    if burn_in_start:
        burn_in_days = [burn_in_start + timedelta(days=i)
                        for i in range((start - burn_in_start).days)]
        print(f"  burn-in: {len(burn_in_days)} days ({burn_in_start} -> "
              f"{start - timedelta(days=1)}), seeding first_active only")
        burn_in_observed = {}
        for day in burn_in_days:
            try:
                active_ids = active_units_for_day(day, unit_ids)
            except (RangeViolation, RuntimeError) as error:
                print(f"    burn-in {day}: unavailable ({error}) — skipped")
                continue
            key = str(day)
            for unit in active_ids:
                if unit not in burn_in_observed or key < burn_in_observed[unit]:
                    burn_in_observed[unit] = key
        first_active = merge_first_active(first_active, burn_in_observed)

    target = [start + timedelta(days=i)
              for i in range((yesterday - start).days + 1)]

    # §E2 resumability: on a backfill, skip a target day already present
    # in `days` at schema >= 2 (a checkpoint from an earlier, interrupted
    # run of THIS backfill) unless it is inside the 3-day refetch tail. A
    # day inherited from a schema-1 shipped payload IS refetched once: it
    # needs the burn-in-corrected first_active merge, and costs only the
    # 31 pre-existing days of the ~430 fetched.
    skip_days = set()
    if backfill_days and prev_schema >= 2:
        tail = {str(yesterday - timedelta(days=i))
               for i in range(REFETCH_TAIL_DAYS)}
        skip_days = {k for k in days if k not in tail}

    observed_first_active = {}
    failures = []
    fetched_count = 0
    for i, day in enumerate(target):
        key = str(day)
        if key in skip_days:
            continue
        try:
            rows = fetch_acceptance_day(day, unit_ids)
        except (RangeViolation, RuntimeError) as error:
            failures.append(key)
            print(f"  {key}: acceptance volumes unavailable ({error}) — "
                  "day skipped")
            continue
        agg = aggregate_day(rows, sp_count_for_day(day))
        active_ids = agg["active_units"]
        days[key] = {
            "offer_mwh": agg["offer_mwh"],
            "bid_mwh": agg["bid_mwh"],
            "offer_mwh_total": round(sum(agg["offer_mwh"]), 1),
            "bid_mwh_total": round(sum(agg["bid_mwh"]), 1),
            "acceptances": agg["acceptances"],
            "active_units": len(active_ids),
            "active_mw": round(sum(cap_by_id.get(u, 0.0)
                                   for u in active_ids), 1),
            "active_idx": sorted(id_index[u] for u in active_ids
                                 if u in id_index),
            "unit_acceptances": agg["unit_acceptance_counts"],
        }
        for unit in active_ids:
            if unit not in observed_first_active or key < observed_first_active[unit]:
                observed_first_active[unit] = key
            if last_active.get(unit) is None or key > last_active[unit]:
                last_active[unit] = key
        fetched_count += 1
        if (i + 1) % 10 == 0 or day == yesterday:
            print(f"  fetched {i + 1}/{len(target)} days", flush=True)

        # §E2 checkpoint: write a fully-assembled, valid payload every
        # CHECKPOINT_DAYS fetched days during a backfill, so an
        # interruption resumes from the checkpoint rather than from
        # scratch.
        if backfill_days and fetched_count % CHECKPOINT_DAYS == 0:
            merged_first_active = merge_first_active(
                first_active, observed_first_active)
            _assemble_and_write(
                fleet_list, {k: dict(v) for k, v in days.items()},
                merged_first_active, last_active, failures,
                prev_first_active=prev_first_active_snapshot,
                checkpoint=True)

    # §B2 step 8: merge first_active with what was actually observed this
    # run — earliest wins, so the backfill corrects a left-censored
    # migration seed regardless of fetch order.
    first_active = merge_first_active(first_active, observed_first_active)

    days = _assemble_and_write(
        fleet_list, days, first_active, last_active, failures,
        prev_first_active=prev_first_active_snapshot, checkpoint=False)

    if failures:
        print(f"  {len(failures)} day(s) skipped (range violation): "
              f"{failures}")


if __name__ == "__main__":
    cli = argparse.ArgumentParser(
        description="GB battery fleet BM activity tracker (plan/06 "
                    "workstream C, #24)")
    cli.add_argument("--backfill", type=int, default=None, metavar="DAYS",
                     help="one-off historical build over the last N days "
                          "shipped (400 recommended; fetches N + "
                          f"{BURN_IN_DAYS} burn-in days)")
    args = cli.parse_args()
    build(backfill_days=args.backfill)

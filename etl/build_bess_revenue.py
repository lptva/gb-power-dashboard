"""
Observable revenue stack — GB battery fleet (plan/08, issue #47)
==================================================================
Writes app/data/bess_revenue.json: EAC availability-auction revenue
(twelve products, signed £/kW/day) for the identified physical battery
cohort, plus a separate Balancing Mechanism gross cashflow sub-series
that is NEVER summed into the availability stack (D18).

Two public, keyless sources:
  * NESO Data Portal (CKAN) — EAC auction results, "Results By Unit"
    resources (the current FY resource + FY archives), queried with
    `datastore_search_sql`.
  * Elexon Insights API — EBOCF (indicative BM Unit cashflows) and
    DISPTAV (indicative accepted volumes), both bid/offer sides.

Cohort (D13): EAC technologyType == 'Batteries', joined to the Elexon
BM Unit registry on exact, uppercase, whitespace-stripped
auctionUnit == nationalGridBmUnit; kept only if elexonBmUnit starts
E_/T_ and registered generationCapacity > 0. Denominator (time-varying,
D13): per day, the summed nameplate of cohort units whose first
appearance in the fetched EAC history is on or before that day.

History (D14): EAC only, from the current FY resource + whichever FY
archive(s) overlap the display window (resolved at runtime — no FY
year is ever hardcoded, so the April rollover needs no code change).
The full history of every relevant resource is always fetched (cheap:
~2 calls total), even though only the trailing 400 days are shipped —
first-appearance would otherwise misdate any unit that pre-dates the
display window (D13). BM cashflow has no history constraint and is
backfilled to the same 400-day boundary, but incrementally (it is the
expensive leg — see the module-level cost note below).

D18 — BM cashflow ships as a SEPARATE signed series (bid £/kW/day,
offer £/kW/day, plus a net-MWh companion), never summed into the
availability stack: the design doc's seven-sample-day probe shows its
sign tracks whether the fleet happened to net-charge or net-discharge
that day, not a margin — stacking it would both dominate the chart and
misrepresent it as revenue.

Two verified NESO CKAN WAF traps: `EXTRACT(...)` and `date(...)` both
return HTTP 403. Day-bucketing therefore uses
`to_char("deliveryStart", 'YYYY-MM-DD')`; window-length verification
uses interval subtraction (`"deliveryEnd" - "deliveryStart"`). Neither
is blocked (verified live, 2026-07-29).

Deviations from plan/08, both forced by this task's file allowlist
(etl/build_bmu_snapshot.py was explicitly out of scope for this build):
  * plan/08 asks to extend `build_bmu_snapshot.fetch_registry` (keep
    `demandCapacity`/`elexonBmUnit`, which it currently discards) and
    re-point the snapshot builder at the extended version. This module
    instead carries its own self-contained `fetch_registry()`, which is
    NOT a fork of the shared helper — it is a separate function that
    happens to hit the same endpoint. `build_bmu_snapshot.py` itself is
    unmodified, so its own registry fetch still discards those fields;
    only this module's copy carries them. Flagged for the orchestrator
    in case the shared-helper extension is still wanted separately.
  * The EAC "daily append" is a single one-day-filtered call per
    plan/08's cost table. This module instead always re-fetches each
    relevant resource's FULL span (still ~2 calls, ~10 s) on every run,
    backfill or incremental. This trades ~9 s/day of extra NESO traffic
    for a materially simpler and more correct implementation: it avoids
    having to persist and version the cohort/first-seen state between
    runs (which would otherwise need its own migration/remap logic, in
    the style of bess_activity's `active_idx` remap) purely to save one
    cheap call. BM history (the actually expensive leg, ~1,600 calls for
    a full backfill) IS fetched incrementally, exactly as specified.

Usage:
    python etl/build_bess_revenue.py                       # daily incremental
    python etl/build_bess_revenue.py --backfill             # one-off, 400 days
    python etl/build_bess_revenue.py --backfill 800         # explicit depth
    python etl/build_bess_revenue.py --backfill --force-backfill
"""

import argparse
import hashlib
import json
import re
import sys
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PROJECT_DIR = Path(__file__).resolve().parents[1]
OUT_DIR = PROJECT_DIR / "app" / "data"
OUT_PATH = OUT_DIR / "bess_revenue.json"

NESO_CKAN = "https://api.neso.energy/api/3/action"
EAC_PACKAGE_ID = "eac-auction-results"
# Matches "NESO Response-Reserve Results By Unit" and its "... FYxxxx
# (Archive)" siblings, but NOT "NESO Response-Reserve Daily Results By
# Unit" (different word order) — verified against the live package,
# 2026-07-29.
EAC_RESOURCE_NAME_RE = re.compile(r"^NESO Response-Reserve Results By Unit")

SCHEMA_VERSION = 1
RETAIN_DAYS = 400
DEFAULT_BACKFILL_DAYS = 400
MAX_BACKFILL_DAYS = 800

REPD_OPERATIONAL_MW = 4755
REPD_VINTAGE = "Q1 2026"
COHORT_METHOD = (
    "NESO EAC auction results technologyType='Batteries', joined on "
    "auctionUnit == nationalGridBmUnit (exact, uppercase); physical "
    "units only (elexonBmUnit prefix E_ or T_) with registered "
    "generationCapacity > 0")

# Static per-product display metadata. window_h is a documented fallback
# only — every build re-derives and overwrites it from the live
# window-assertion query (assert_windows), never hard-coded in the
# shipped payload.
PRODUCTS = {
    "DCL": {"service": "Dynamic Containment", "code": "DC", "direction": "low",  "window_h": 4.0},
    "DCH": {"service": "Dynamic Containment", "code": "DC", "direction": "high", "window_h": 4.0},
    "DML": {"service": "Dynamic Moderation",  "code": "DM", "direction": "low",  "window_h": 4.0},
    "DMH": {"service": "Dynamic Moderation",  "code": "DM", "direction": "high", "window_h": 4.0},
    "DRL": {"service": "Dynamic Regulation",  "code": "DR", "direction": "low",  "window_h": 4.0},
    "DRH": {"service": "Dynamic Regulation",  "code": "DR", "direction": "high", "window_h": 4.0},
    "PBR": {"service": "Balancing Reserve",   "code": "BR", "direction": "positive", "window_h": 0.5},
    "NBR": {"service": "Balancing Reserve",   "code": "BR", "direction": "negative", "window_h": 0.5},
    "PQR": {"service": "Quick Reserve",       "code": "QR", "direction": "positive", "window_h": 0.5},
    "NQR": {"service": "Quick Reserve",       "code": "QR", "direction": "negative", "window_h": 0.5},
    "PSR": {"service": "Slow Reserve",        "code": "SR", "direction": "positive", "window_h": 0.5},
    "NSR": {"service": "Slow Reserve",        "code": "SR", "direction": "negative", "window_h": 0.5},
}
PRODUCT_KEYS = tuple(PRODUCTS)  # fixed order, always emitted (zero-filled)

# Methodology-tab provenance, in the exact meta.json series vocabulary
# (name/source/endpoint/unit/resolution/update_frequency/quality/
# transformations/notes — same shape build_dataset.py uses for
# Data.meta.series and etl/build_bess_activity.py mirrors for
# bess_activity.json). This payload spans two distinct sources, so it is
# a dict of two entries rather than the single-series shape those two
# modules use: "eac" (NESO availability-auction revenue) and "bm" (Elexon
# Balancing Mechanism cashflow, D18). Rendered by app/js/ui.js as two
# extra rows appended to the central "Sources, field mapping,
# transformations" table on the GB Methodology tab, not as a standalone
# mini-table — see that file's renderMethodology().
SOURCE_META = {
    "eac": {
        "name": "GB battery fleet: EAC availability revenue",
        "source": ("NESO Data Portal (CKAN), dataset eac-auction-results, "
                   "Results By Unit resources (current FY + FY archives)"),
        "endpoint": "/api/3/action/datastore_search_sql",
        "unit": "£/kW/day, signed, per auction product",
        "resolution": "daily",
        "update_frequency": (
            "day-ahead (the current FY resource carries delivery windows "
            "one day ahead of the build date)"),
        "quality": "observed",
        "transformations": (
            "executedQuantity x clearingPrice x window_h, summed per day "
            "per auction product across the identified cohort "
            "(technologyType='Batteries', joined to the Elexon BM Unit "
            "registry on exact, uppercase auctionUnit == "
            "nationalGridBmUnit, restricted to physical units with "
            "elexonBmUnit prefix E_ or T_ and generationCapacity > 0), "
            "divided by that day's time-varying cohort nameplate (kW)"),
        "notes": (
            "Twelve auction products (Dynamic Containment, Moderation "
            "and Regulation, each low/high; Balancing, Quick and Slow "
            "Reserve, each positive/negative) are always shipped in full "
            "and zero-filled where a product cleared no battery volume "
            "that day. Delivery-window length is asserted constant per "
            "product on every run rather than hard-coded, because a "
            "silent product-length change would otherwise corrupt the "
            "arithmetic. Denominator coverage (cohort MW against REPD) "
            "and numerator coverage (share of all EAC battery-labelled "
            "gross £ the cohort earns) are reported separately in the "
            "coverage caption, because aggregator and virtual-lead-party "
            "auction units earn revenue that cannot enter a per-kW "
            "metric."),
    },
    "bm": {
        "name": ("GB battery fleet: Balancing Mechanism cashflow (gross, "
                 "includes the energy leg)"),
        "source": ("Elexon Insights API, EBOCF (indicative Bid-Offer "
                   "Cashflow) and DISPTAV (indicative accepted volumes)"),
        "endpoint": (
            "/balancing/settlement/indicative/cashflows/all/{bid|offer}/"
            "{date}; /balancing/settlement/indicative/volumes/all/"
            "{bid|offer}/{date}"),
        "unit": ("£/kW/day (cashflow, bid and offer sides separate) and "
                 "MWh (net volume companion)"),
        "resolution": "daily",
        "update_frequency": (
            "same evening to next day (EBOCF publishes the same evening "
            "the settlement day runs; the daily append requests D-2 "
            "through D-1 and tolerates absence rather than assuming "
            "same-day completeness)"),
        "quality": "observed",
        "transformations": (
            "summed across all twelve bid-offer pair keys on both the "
            "bid and offer endpoints, restricted to cohort elexonBmUnit "
            "values, per day; cashflow divided by that day's cohort "
            "nameplate. DISPTAV rows are filtered to "
            "dataType='Original'."),
        "notes": (
            "Gross settlement cashflow, not margin: a heavy-charging day "
            "settles deep negative because energy was bought, not lost. "
            "Never summed into the EAC availability stack, because its "
            "sign follows whether the fleet net-charged or "
            "net-discharged that day rather than a trading outcome; it "
            "ships as its own signed series with its own heading and the "
            "net MWh companion on a secondary axis. 'Indicative' names "
            "the II settlement run vintage, not an estimate."),
    },
}

# The twelve bid-offer pair keys carried by both EBOCF's
# bidOfferPairCashflows and DISPTAV's pairVolumes.
PAIR_KEYS = tuple(f"{sign}{i}" for i in range(1, 7)
                  for sign in ("negative", "positive"))

# #24's D9 structural-or-name signature (plan/06 D9, phaseA spec §4a),
# reimplemented here ONLY for the cross-check cited in the coverage
# caption (D13's "signature_agreement"). etl/build_bess_activity.py does
# not exist yet, so this is not a shared import — it is the same public
# rule applied independently against the same registry.
D9_NAME_RE = re.compile(
    r"(batter|bess|energy\s*stor|\bstorage\b|\bess\b|\bbat\d?\b)", re.I)
D9_DEMAND_ID_RE = re.compile(r"D-\d+$")
D9_DEMAND_NAME_RE = re.compile(r"\bdemand\b", re.I)


def _core():
    """The shared HTTP/cache layer, imported lazily so the pure logic
    below stays importable where certifi is absent (the CI test runner
    is stdlib-only) — same pattern as fetch_stress.py."""
    import build_dataset
    return build_dataset


# ---------------------------------------------------------------------------
# Pure logic (no I/O) — everything the unit tests exercise
# ---------------------------------------------------------------------------

def normalize_key(value):
    """D13 join key: exact, uppercase, whitespace-stripped."""
    return (value or "").strip().upper()


def parse_interval_hours(text):
    """Parse a Postgres interval string of the shape 'H:MM:SS' (CKAN's
    rendering of "deliveryEnd" - "deliveryStart") into hours."""
    text = text.strip()
    sign = 1
    if text.startswith("-"):
        sign = -1
        text = text[1:]
    h, m, s = text.split(":")
    return sign * (int(h) + int(m) / 60 + float(s) / 3600)


def eac_query_sql(resource_id, day_from, day_to_exclusive):
    """Grouped revenue-ingredient query for one EAC resource: day x
    auctionUnit x auctionProduct, summed executedQuantity*clearingPrice
    (the window-hours multiplication happens client-side, once per
    product, after assert_windows). Uses to_char() for day bucketing —
    NESO's CKAN WAF returns HTTP 403 for EXTRACT(...) and date(...);
    to_char() is not blocked (verified live, 2026-07-29)."""
    return (
        "SELECT to_char(\"deliveryStart\", 'YYYY-MM-DD') AS day, "
        "\"auctionUnit\" AS unit, \"auctionProduct\" AS product, "
        "sum(\"executedQuantity\" * \"clearingPrice\") AS gbp_ex_window "
        f"FROM \"{resource_id}\" "
        "WHERE \"technologyType\" = 'Batteries' "
        f"AND \"deliveryStart\" >= '{day_from}' "
        f"AND \"deliveryStart\" < '{day_to_exclusive}' "
        "GROUP BY day, \"auctionUnit\", \"auctionProduct\""
    )


def window_query_sql(resource_id, day_from, day_to_exclusive, exclude_days=()):
    """Per-product min/max delivery-window length for one resource — the
    guard against a silent product-length change. Same WAF constraint as
    eac_query_sql: interval subtraction, never EXTRACT()/date().

    `exclude_days` (ISO date strings) are dropped from the aggregation —
    see clock_change_day_strings() below for why this is needed and why
    it does not weaken the guard."""
    exclusion = ""
    if exclude_days:
        quoted = ", ".join(f"'{d}'" for d in exclude_days)
        exclusion = (" AND to_char(\"deliveryStart\", 'YYYY-MM-DD') "
                    f"NOT IN ({quoted})")
    return (
        "SELECT \"auctionProduct\" AS product, "
        "min(\"deliveryEnd\" - \"deliveryStart\") AS minw, "
        "max(\"deliveryEnd\" - \"deliveryStart\") AS maxw "
        f"FROM \"{resource_id}\" "
        "WHERE \"technologyType\" = 'Batteries' "
        f"AND \"deliveryStart\" >= '{day_from}' "
        f"AND \"deliveryStart\" < '{day_to_exclusive}'"
        f"{exclusion} "
        "GROUP BY \"auctionProduct\""
    )


def bounds_query_sql(resource_id):
    """A resource's own delivery-start bounds — used to resolve which FY
    resources are relevant at runtime, with no FY year hardcoded."""
    return (f"SELECT min(\"deliveryStart\") AS lo, "
            f"max(\"deliveryStart\") AS hi FROM \"{resource_id}\"")


def uk_clock_change_days(year):
    """The two GB clock-change Sundays in a calendar year (last Sunday of
    March, last Sunday of October), each with a +/-1 day buffer for the
    delivery-day bucketing offset observed live (the anomalous 'day'
    bucket landed one day before the Sunday itself — EAC's day boundary
    runs 22:00-22:00, not local midnight)."""
    def last_sunday(y, month):
        next_month = date(y + 1, 1, 1) if month == 12 else date(y, month + 1, 1)
        d = next_month - timedelta(days=1)
        while d.weekday() != 6:  # Sunday
            d -= timedelta(days=1)
        return d

    days = set()
    for month in (3, 10):
        pivot = last_sunday(year, month)
        for offset in (-1, 0, 1):
            days.add(pivot + timedelta(days=offset))
    return days


def clock_change_day_strings(day_from, day_to_exclusive):
    """ISO date strings to exclude from the window-length assertion: the
    GB clock-change dates within [day_from, day_to_exclusive).

    On these two days a year, one EFA block genuinely spans a different
    UTC-elapsed duration than its product's true (wall-clock) window
    length — verified live, 2026-07-29: the FY2025 archive shows exactly
    one DCH block on 2025-10-25 lasting 5:00:00 (the repeated hour when
    clocks go back) and exactly one DCH block on 2026-03-28 lasting
    3:00:00 (the skipped hour when clocks go forward), against 4:00:00
    for every other Response-product block that year. This is a real,
    predictable, twice-yearly artifact of a wall-clock-defined EFA block
    crossing a clock change — NOT a silent product-length change, which
    is what assert_windows() exists to catch. Excluding these two narrow,
    named, calendar-derived dates from the INPUT keeps the guard itself
    unweakened: it still raises on any other, unexplained, mismatch."""
    start = date.fromisoformat(day_from)
    end = date.fromisoformat(day_to_exclusive) - timedelta(days=1)
    days = set()
    for year in range(start.year, end.year + 1):
        days |= uk_clock_change_days(year)
    return sorted(str(d) for d in days if start <= d <= end)


def revenue_gbp(quantity, price, window_h):
    """Pay-as-clear revenue for one row: executedQuantity (MW) x
    clearingPrice (£/MW/h) x window length (h). Signed — a negative
    clearingPrice yields negative revenue (the unit paid for capacity)."""
    return quantity * price * window_h


class WindowMismatch(RuntimeError):
    """A product's delivery-window length is not constant across the
    fetched range — the guard plan/08 requires against a silent
    product-length change."""


def assert_windows(window_rows):
    """window_rows: [{'product', 'minw', 'maxw'}, ...] from one or more
    resource-scoped window queries. Returns {product: hours}, taking the
    true global min/max per product across every supplied row (so a
    cross-resource disagreement is caught too, not just a within-resource
    one). Raises WindowMismatch if the global min != max for any
    product."""
    lo, hi = {}, {}
    for row in window_rows:
        product = row["product"]
        row_lo = parse_interval_hours(row["minw"])
        row_hi = parse_interval_hours(row["maxw"])
        lo[product] = row_lo if product not in lo else min(lo[product], row_lo)
        hi[product] = row_hi if product not in hi else max(hi[product], row_hi)
    hours = {}
    for product in lo:
        if lo[product] != hi[product]:
            raise WindowMismatch(
                f"{product}: delivery-window length not constant "
                f"({lo[product]}h vs {hi[product]}h)")
        hours[product] = lo[product]
    return hours


def registry_capacity_mw(entry):
    try:
        return float(entry.get("generationCapacity") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def registry_demand_mw(entry):
    try:
        return float(entry.get("demandCapacity") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def qualifies_d13(entry):
    """D13 cohort rule, applied to an already-joined registry entry:
    physical unit (elexonBmUnit prefix E_ or T_) with registered
    generationCapacity > 0. The join itself (exact, uppercase,
    whitespace-stripped auctionUnit == nationalGridBmUnit) is the
    caller's responsibility — see build_cohort()."""
    elexon_id = entry.get("elexonBmUnit") or ""
    if not (elexon_id.startswith("E_") or elexon_id.startswith("T_")):
        return False
    return registry_capacity_mw(entry) > 0


def matches_d9_signature(entry):
    """#24's structural-or-name signature (see module docstring) — used
    only to compute the "signature_agreement" cross-check figure."""
    elexon_id = entry.get("elexonBmUnit") or ""
    if not (elexon_id.startswith("E_") or elexon_id.startswith("T_")):
        return False
    gen = registry_capacity_mw(entry)
    if gen < 5.0:
        return False
    name = entry.get("bmUnitName") or ""
    if D9_DEMAND_ID_RE.search(elexon_id) or D9_DEMAND_NAME_RE.search(name):
        return False
    dem = registry_demand_mw(entry)
    fuel = entry.get("fuelType")
    structural = False
    if (gen > 0 and dem < 0 and fuel in (None, "OTHER")
            and not entry.get("interconnectorId")
            and not elexon_id.startswith("I_")):
        ratio = abs(dem) / gen
        structural = 0.5 <= ratio <= 1.5
    haystack = " ".join([name, elexon_id, entry.get("nationalGridBmUnit") or ""])
    return structural or bool(D9_NAME_RE.search(haystack))


class CohortSanityError(RuntimeError):
    """The identified cohort is empty, or its MW falls outside a
    plausible band vs the REPD reference — a cheap tripwire on a
    registry or schema change (plan/08 §ETL design, step 4)."""


def build_cohort(registry, eac_unit_ids):
    """D13 join + cohort rule.

    `registry` maps normalize_key(nationalGridBmUnit) -> entry dict
    (elexonBmUnit, generationCapacity, demandCapacity, fuelType,
    interconnectorId, bmUnitName, nationalGridBmUnit).
    `eac_unit_ids` is every distinct auctionUnit seen with
    technologyType == 'Batteries' over the fetched EAC history.

    Returns (cohort, signature_hits): cohort maps the ORIGINAL (as-seen)
    auctionUnit string -> {"elexon_id", "cap_mw"}; signature_hits is the
    subset of cohort auctionUnits also caught by matches_d9_signature.
    """
    cohort = {}
    signature_hits = set()
    for unit_id in eac_unit_ids:
        entry = registry.get(normalize_key(unit_id))
        if entry is None or not qualifies_d13(entry):
            continue
        cohort[unit_id] = {
            "elexon_id": entry.get("elexonBmUnit"),
            "cap_mw": registry_capacity_mw(entry),
        }
        if matches_d9_signature(entry):
            signature_hits.add(unit_id)
    return cohort, signature_hits


def validate_cohort_mw(cohort_mw, repd_mw=REPD_OPERATIONAL_MW):
    """Tripwire: cohort must be non-empty and within 50-120% of the REPD
    operational figure (plan/08 measured 89%; a registry or schema
    change producing e.g. 400% or 2% should fail loudly, not silently
    ship a corrupted panel)."""
    if cohort_mw <= 0:
        raise CohortSanityError("identified cohort is empty")
    ratio = cohort_mw / repd_mw
    if not (0.5 <= ratio <= 1.2):
        raise CohortSanityError(
            f"cohort {cohort_mw} MW is {ratio:.1%} of REPD {repd_mw} MW: "
            "outside the 50-120% plausibility band")
    return ratio


def cohort_coverage_block(cohort, signature_hits, cohort_gross, all_gross,
                          repd_mw=REPD_OPERATIONAL_MW,
                          repd_vintage=REPD_VINTAGE):
    """The `cohort` block of the payload (D13's two coverage figures +
    the #24 signature cross-check)."""
    units = len(cohort)
    mw = sum(info["cap_mw"] for info in cohort.values())
    validate_cohort_mw(mw, repd_mw)
    return {
        "units": units,
        "mw": round(mw, 1),
        "method": COHORT_METHOD,
        "repd_operational_mw": repd_mw,
        "repd_vintage": repd_vintage,
        "coverage_repd": round(mw / repd_mw, 4) if repd_mw else None,
        "coverage_eac_gross": (round(cohort_gross / all_gross, 4)
                               if all_gross else None),
        "signature_agreement": (round(len(signature_hits) / units, 4)
                                if units else None),
    }


def first_seen_days(eac_rows):
    """Earliest 'day' string seen per auctionUnit across ALL fetched EAC
    rows (spanning every relevant FY resource's full history — wider
    than the shipped 400-day window; see module docstring). Used as the
    observable commissioning proxy for the time-varying denominator."""
    first = {}
    for row in eac_rows:
        unit, day = row["unit"], row["day"]
        if unit not in first or day < first[unit]:
            first[unit] = day
    return first


def denominator_kw_series(days, cohort, first_seen):
    """Per-day summed nameplate (kW) of cohort units whose first EAC
    appearance is on or before that day (D13 time-varying rule)."""
    out = []
    for day in days:
        total_mw = sum(info["cap_mw"] for unit, info in cohort.items()
                       if first_seen.get(unit, day) <= day)
        out.append(round(total_mw * 1000))
    return out


def percentile(values, q):
    """Linear-interpolation percentile of an unsorted sequence; None if
    empty (matches fetch_stress.py's method)."""
    xs = sorted(values)
    if not xs:
        return None
    idx = (len(xs) - 1) * q
    lo = int(idx)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo)


def aggregate_eac(eac_rows, cohort, window_hours, days):
    """Applies window_hours to every row's gbp_ex_window, then splits
    into:
      day_product_gbp: {day: {product: total £}} — cohort units only,
                        restricted to `days`
      day_unit_gbp:     {day: {unit: total £}} — cohort units only,
                        summed across all twelve products, restricted to
                        `days` (feeds the per-unit spread)
      cohort_gross:     total £ earned by cohort units, over ALL fetched
                        rows (not just `days` — the numerator of
                        coverage_eac_gross)
      all_gross:        total £ earned by every battery-labelled auction
                        unit (cohort or not), over ALL fetched rows (the
                        denominator of coverage_eac_gross)
    """
    day_set = set(days)
    day_product_gbp = {d: {p: 0.0 for p in PRODUCT_KEYS} for d in days}
    day_unit_gbp = {d: {u: 0.0 for u in cohort} for d in days}
    cohort_gross = 0.0
    all_gross = 0.0

    for row in eac_rows:
        product = row["product"]
        window_h = window_hours.get(product)
        if window_h is None:
            continue  # outside the twelve-key vocabulary — ignore
        revenue = revenue_gbp(row["gbp_ex_window"], 1.0, window_h)
        all_gross += revenue
        unit = row["unit"]
        if unit not in cohort:
            continue
        cohort_gross += revenue
        day = row["day"]
        if day in day_set:
            if product in day_product_gbp[day]:
                day_product_gbp[day][product] += revenue
            day_unit_gbp[day][unit] += revenue

    return day_product_gbp, day_unit_gbp, cohort_gross, all_gross


def eac_gbp_per_kw_day_series(days, day_product_gbp, denominator_kw):
    """Fleet-level £/kW/day per product, using the time-varying
    denominator (D13) — twelve keys, always all twelve, zero-filled."""
    out = {p: [] for p in PRODUCT_KEYS}
    for i, day in enumerate(days):
        kw = denominator_kw[i]
        for p in PRODUCT_KEYS:
            value = day_product_gbp[day][p]
            out[p].append(round(value / kw, 5) if kw else 0.0)
    return out


def unit_spread_series(days, day_unit_gbp, cohort):
    """Per-day p10/p50/p90 of (unit's own total EAC £/kW/day, all twelve
    products summed) across cohort units, each divided by that SAME
    unit's OWN registered capacity — the peer-group overlay. This is
    deliberately a different denominator from eac_gbp_per_kw_day_series
    (which uses the fleet-wide time-varying total): a per-unit spread
    must be normalised per-unit, not by the fleet total."""
    p10, p50, p90 = [], [], []
    for day in days:
        values = []
        for unit, gbp in day_unit_gbp[day].items():
            cap_kw = cohort[unit]["cap_mw"] * 1000
            values.append(gbp / cap_kw if cap_kw else 0.0)
        p10.append(round(percentile(values, 0.10), 5))
        p50.append(round(percentile(values, 0.50), 5))
        p90.append(round(percentile(values, 0.90), 5))
    return {"p10": p10, "p50": p50, "p90": p90}


def sum_pair_cashflows(pairs):
    """Sum of the (up to twelve) non-null bid-offer-pair values in an
    EBOCF/DISPTAV row's bidOfferPairCashflows/pairVolumes dict."""
    return sum(v for v in (pairs or {}).values() if v is not None)


def reconcile_ebocf(volume_mwh, bod_price, tlm):
    """EBOCF = DISPTAV volume x BOD price x transmission loss multiplier
    (plan/08's hand-reconciliation identity, exact to machine precision
    on the probed T_THURB-1 example) — a regression fixture, not
    something this module computes at runtime (EBOCF is fetched
    pre-calculated from Elexon)."""
    return volume_mwh * bod_price * tlm


def sum_cohort_pairs(rows, cohort_elexon_ids, pair_field):
    """Sum bid-offer-pair values (cashflow or volume) across every row
    whose bmUnit is in the cohort, using the explicit twelve-key
    summation (not the endpoint's own totalCashflow/totalVolumeAccepted
    field) per plan/08's sign-conventions note: both the bid-endpoint
    and the offer-endpoint acceptances on the SAME pair key are real and
    distinct (a negative pair's "offer" acceptance is the unit coming
    back up toward its notification and settles positive)."""
    return sum(sum_pair_cashflows(row.get(pair_field))
              for row in rows if row.get("bmUnit") in cohort_elexon_ids)


def filter_original(rows):
    """DISPTAV carries four dataType values; only 'Original' is kept
    (plan/08, 'Alternatives ruled out')."""
    return [r for r in rows if r.get("dataType") == "Original"]


def merge_bm_days(existing_by_day, new_by_day):
    """Read-back merge: new days win, existing days not re-fetched this
    run are carried forward unchanged."""
    merged = dict(existing_by_day)
    merged.update(new_by_day)
    return merged


def trim_to_retain(days_list, retain_days):
    """Most recent `retain_days` entries of a sorted day-string list."""
    if retain_days <= 0 or len(days_list) <= retain_days:
        return list(days_list)
    return list(days_list[-retain_days:])


def latest_day_with_data(by_day):
    """The most recent key in a {day: value-or-None} mapping whose value
    is present (used to derive state.bm_last_day)."""
    present = [d for d, v in by_day.items() if v is not None]
    return max(present) if present else None


def bm_fetch_range(existing_bm_by_day, shipped_days, backfill_days,
                   force_backfill, today):
    """Which of `shipped_days` need a fresh BM fetch this run.

    Backfill (`backfill_days` truthy): the most recent `backfill_days` of
    `shipped_days`, skipping days already present unless
    `force_backfill`.

    Incremental (`backfill_days` falsy): always (re-)requests the D-2
    through D-1 tail (EBOCF's same-evening-to-next-day publication lag;
    plan/08 — "tolerates absence, rather than assuming same-day
    completeness"), plus any gap since the last successfully-fetched BM
    day (so a missed run's backlog is picked up rather than silently
    skipped).
    """
    if backfill_days:
        window = shipped_days[-backfill_days:]
        if force_backfill:
            return list(window)
        return [d for d in window if d not in existing_bm_by_day]

    tail_start = today - timedelta(days=2)
    known_days = sorted(existing_bm_by_day)
    gap_start = (date.fromisoformat(known_days[-1]) + timedelta(days=1)
                if known_days else tail_start)
    start = min(tail_start, gap_start)
    end = today - timedelta(days=1)
    if start > end:
        return []
    wanted = {str(start + timedelta(days=i))
             for i in range((end - start).days + 1)}
    return [d for d in shipped_days if d in wanted]


def assemble_payload(built_at, cohort_block, days, denominator_kw,
                     eac_series, spread_series, bm_out, products, state,
                     source):
    """The final JSON-serialisable payload (app/data/bess_revenue.json
    schema, plan/08)."""
    return {
        "built_at": built_at,
        "schema": SCHEMA_VERSION,
        "source": source,
        "meta": {"series": SOURCE_META},
        "cohort": cohort_block,
        "days": days,
        "denominator_kw": denominator_kw,
        "eac_gbp_per_kw_day": eac_series,
        "eac_unit_spread_gbp_per_kw_day": spread_series,
        "bm": bm_out,
        "products": products,
        "state": state,
    }


# ---------------------------------------------------------------------------
# Fetchers (impure — hit the network via the shared _core() HTTP layer)
# ---------------------------------------------------------------------------

def _ckan_sql(sql):
    core = _core()
    url = f"{NESO_CKAN}/datastore_search_sql?" + urllib.parse.urlencode(
        {"sql": sql})
    return json.loads(core.http(url))["result"]["records"]


def list_eac_resource_candidates():
    core = _core()
    url = f"{NESO_CKAN}/package_show?" + urllib.parse.urlencode(
        {"id": EAC_PACKAGE_ID})
    data = json.loads(core.http(url))
    return [r for r in data["result"]["resources"]
            if EAC_RESOURCE_NAME_RE.match(r.get("name") or "")]


def resource_bounds(resource_id):
    rec = _ckan_sql(bounds_query_sql(resource_id))[0]
    return rec["lo"][:10], rec["hi"][:10]


def resolve_relevant_resources(display_start):
    """Resources (current + any FY archive) whose data extends into or
    past `display_start` (an ISO date string) — resolved by probing each
    candidate's own delivery bounds. No FY year is ever hardcoded, so the
    April rollover needs no code change."""
    relevant = []
    for res in list_eac_resource_candidates():
        lo, hi = resource_bounds(res["id"])
        if hi >= display_start:
            relevant.append({"id": res["id"], "name": res["name"],
                             "lo": lo, "hi": hi})
    if not relevant:
        raise RuntimeError(
            f"No EAC resource covers the display window from "
            f"{display_start}: refusing to build an incomplete cohort")
    return relevant


def fetch_eac_rows_and_windows(resources):
    """Full history of every relevant resource (see module docstring for
    why this is not clipped to the shipped display window)."""
    rows, window_rows = [], []
    for res in resources:
        day_from = res["lo"]
        day_to_excl = str(date.fromisoformat(res["hi"]) + timedelta(days=1))
        for rec in _ckan_sql(eac_query_sql(res["id"], day_from, day_to_excl)):
            rows.append({"day": rec["day"], "unit": rec["unit"],
                        "product": rec["product"],
                        "gbp_ex_window": float(rec["gbp_ex_window"])})
        exclude_days = clock_change_day_strings(day_from, day_to_excl)
        window_rows.extend(_ckan_sql(
            window_query_sql(res["id"], day_from, day_to_excl, exclude_days)))
    return rows, window_rows


def fetch_registry():
    """BM Unit registry, keyed by normalize_key(nationalGridBmUnit) — the
    D13 join key. Captures the fields the D13 cohort rule and the D9
    cross-check both need (fuelType, demandCapacity, interconnectorId,
    bmUnitName), which build_bmu_snapshot.fetch_registry discards. NOT a
    fork of that helper — see the module docstring's deviation note."""
    core = _core()
    data = json.loads(core.http(f"{core.ELEXON}/reference/bmunits/all"))
    rows = data if isinstance(data, list) else data.get("data", [])
    registry = {}
    for row in rows:
        ng = row.get("nationalGridBmUnit")
        if not ng:
            continue
        registry[normalize_key(ng)] = {
            "elexonBmUnit": row.get("elexonBmUnit"),
            "nationalGridBmUnit": ng,
            "generationCapacity": row.get("generationCapacity"),
            "demandCapacity": row.get("demandCapacity"),
            "fuelType": row.get("fuelType"),
            "interconnectorId": row.get("interconnectorId"),
            "bmUnitName": row.get("bmUnitName"),
        }
    return registry


def fetch_bm_side(day, side, kind):
    """kind: 'ebocf' (cashflow) or 'disptav' (volume). Whole-market fetch
    per day/side, gzip on, filtered to the cohort client-side — no
    bmUnit query-param filtering (the cost is dominated by call count,
    not per-call bytes once gzipped; filtering would multiply calls
    across batches instead of shrinking the ~1,600-call backfill)."""
    core = _core()
    path = ("balancing/settlement/indicative/cashflows/all" if kind == "ebocf"
            else "balancing/settlement/indicative/volumes/all")
    url = f"{core.ELEXON}/{path}/{side}/{day}?format=json"
    data = json.loads(core.http(url, accept_gzip=True))
    return data if isinstance(data, list) else data.get("data", [])


def bm_day_values(day, cohort_elexon_ids):
    """Raw (not-yet-per-kW) cohort totals for one day: both EBOCF sides
    and both DISPTAV sides must be fetched — neither side alone is
    meaningful (D18 sign-conventions note)."""
    bid_cf = fetch_bm_side(day, "bid", "ebocf")
    offer_cf = fetch_bm_side(day, "offer", "ebocf")
    bid_vol = filter_original(fetch_bm_side(day, "bid", "disptav"))
    offer_vol = filter_original(fetch_bm_side(day, "offer", "disptav"))
    return {
        "bid_gbp": sum_cohort_pairs(bid_cf, cohort_elexon_ids,
                                    "bidOfferPairCashflows"),
        "offer_gbp": sum_cohort_pairs(offer_cf, cohort_elexon_ids,
                                      "bidOfferPairCashflows"),
        "bid_mwh": sum_cohort_pairs(bid_vol, cohort_elexon_ids,
                                    "pairVolumes"),
        "offer_mwh": sum_cohort_pairs(offer_vol, cohort_elexon_ids,
                                      "pairVolumes"),
    }


# ---------------------------------------------------------------------------
# Incremental state / merge
# ---------------------------------------------------------------------------

def load_existing():
    try:
        return json.loads(OUT_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def bm_by_day_from_payload(payload):
    """Previously-published per-kW BM values, keyed by day. Only kept
    where at least one field is non-null (a day the previous build never
    reached has all-null BM fields and is treated as absent, so it will
    be attempted again)."""
    if not payload:
        return {}
    days = payload.get("days", [])
    bm = payload.get("bm", {})
    out = {}
    for i, day in enumerate(days):
        entry, has_any = {}, False
        for key in ("bid_gbp_per_kw_day", "offer_gbp_per_kw_day",
                    "bid_mwh", "offer_mwh"):
            arr = bm.get(key, [])
            value = arr[i] if i < len(arr) else None
            entry[key] = value
            has_any = has_any or value is not None
        if has_any:
            out[day] = entry
    return out


def _resource_label(name):
    suffix = name.replace("NESO Response-Reserve Results By Unit", "").strip()
    return suffix if suffix else "current FY"


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def update_manifest():
    """Register bess_revenue.json in the manifest for cache-busting —
    same pattern as build_bmu_snapshot.py / fetch_stress.py."""
    core = _core()
    manifest_path = OUT_DIR / "manifest.json"
    if not manifest_path.exists():
        return
    manifest = json.loads(manifest_path.read_text())
    files = manifest.setdefault("files", {})
    blob = OUT_PATH.read_bytes()
    files["bess_revenue.json"] = {"sha256": hashlib.sha256(blob).hexdigest(),
                                  "bytes": len(blob)}
    manifest["version"] += 1
    core._atomic_write(manifest_path, json.dumps(manifest, indent=2))


def build(backfill_days=None, force_backfill=False):
    core = _core()
    today = date.today()
    mode = f"backfill {backfill_days}d" if backfill_days else "incremental"
    core.USE_CACHE = bool(backfill_days)  # resumable backfill; fresh daily
    print(f"bess revenue pipeline [{mode}]")

    existing = load_existing()
    existing_bm_by_day = bm_by_day_from_payload(existing)

    display_start_guess = str(today - timedelta(days=RETAIN_DAYS + 30))
    print("  Resolving EAC resources…")
    resources = resolve_relevant_resources(display_start_guess)
    for res in resources:
        print(f"    {res['name']}: {res['lo']} -> {res['hi']}")

    print("  Fetching EAC revenue rows + window assertion…")
    eac_rows, window_rows = fetch_eac_rows_and_windows(resources)
    window_hours = assert_windows(window_rows)
    print(f"    {len(eac_rows)} rows; window hours: {window_hours}")

    print("  Fetching BM Unit registry…")
    registry = fetch_registry()

    eac_unit_ids = sorted({row["unit"] for row in eac_rows})
    cohort, signature_hits = build_cohort(registry, eac_unit_ids)
    print(f"    cohort: {len(cohort)} units, "
         f"{sum(i['cap_mw'] for i in cohort.values()):.1f} MW")

    res_lo = min(date.fromisoformat(r["lo"]) for r in resources)
    res_hi = max(date.fromisoformat(r["hi"]) for r in resources)
    all_days = [str(res_lo + timedelta(days=i))
               for i in range((res_hi - res_lo).days + 1)]
    shipped_days = trim_to_retain(all_days, RETAIN_DAYS)

    first_seen = first_seen_days(eac_rows)
    denominator_kw = denominator_kw_series(shipped_days, cohort, first_seen)

    day_product_gbp, day_unit_gbp, cohort_gross, all_gross = aggregate_eac(
        eac_rows, cohort, window_hours, shipped_days)
    cohort_block = cohort_coverage_block(cohort, signature_hits,
                                         cohort_gross, all_gross)

    eac_series = eac_gbp_per_kw_day_series(shipped_days, day_product_gbp,
                                           denominator_kw)
    spread_series = unit_spread_series(shipped_days, day_unit_gbp, cohort)

    cohort_elexon_ids = {info["elexon_id"] for info in cohort.values()
                         if info["elexon_id"]}
    bm_days_to_fetch = bm_fetch_range(existing_bm_by_day, shipped_days,
                                      backfill_days, force_backfill, today)
    print(f"  BM cashflow: {len(bm_days_to_fetch)} day(s) to fetch")
    denom_by_day = dict(zip(shipped_days, denominator_kw))
    new_bm_by_day = {}
    failures = []
    for n, day in enumerate(bm_days_to_fetch, 1):
        try:
            raw = bm_day_values(day, cohort_elexon_ids)
        except RuntimeError as error:
            print(f"    {day}: BM fetch FAILED ({error}) — keeping prior value")
            failures.append(day)
            continue
        kw = denom_by_day.get(day) or 0
        new_bm_by_day[day] = {
            "bid_gbp_per_kw_day": round(raw["bid_gbp"] / kw, 5) if kw else None,
            "offer_gbp_per_kw_day": round(raw["offer_gbp"] / kw, 5) if kw else None,
            "bid_mwh": round(raw["bid_mwh"], 1),
            "offer_mwh": round(raw["offer_mwh"], 1),
        }
        if n % 20 == 0 or n == len(bm_days_to_fetch):
            print(f"    fetched {n}/{len(bm_days_to_fetch)} BM days", flush=True)

    merged_bm_by_day = merge_bm_days(existing_bm_by_day, new_bm_by_day)
    bm_out = {"bid_gbp_per_kw_day": [], "offer_gbp_per_kw_day": [],
             "bid_mwh": [], "offer_mwh": []}
    for day in shipped_days:
        entry = merged_bm_by_day.get(day)
        for key in bm_out:
            bm_out[key].append(entry[key] if entry else None)
    bm_last_day = latest_day_with_data(
        {d: merged_bm_by_day.get(d) for d in shipped_days})

    products_out = {k: {**v, "window_h": round(window_hours.get(k, v["window_h"]), 4)}
                    for k, v in PRODUCTS.items()}
    resource_labels = ", ".join(_resource_label(r["name"]) for r in resources)
    source = ("NESO Data Portal EAC auction results (Results By Unit, "
             f"{resource_labels} resources) joined to the Elexon BM Unit "
             "registry; Elexon Insights EBOCF and DISPTAV for Balancing "
             "Mechanism cashflow and volume.")

    built_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    state = {"eac_last_day": shipped_days[-1] if shipped_days else None,
            "bm_last_day": bm_last_day}
    payload = assemble_payload(built_at, cohort_block, shipped_days,
                               denominator_kw, eac_series, spread_series,
                               bm_out, products_out, state, source)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    core._atomic_write(OUT_PATH, json.dumps(payload))
    update_manifest()

    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"\nWrote {OUT_PATH} ({size_kb:.1f} kB, budget 150 kB): "
         f"{cohort_block['units']} units / {cohort_block['mw']} MW cohort "
         f"({cohort_block['coverage_repd']:.1%} of REPD), "
         f"{len(shipped_days)} days, eac_last_day={state['eac_last_day']}, "
         f"bm_last_day={bm_last_day}"
         + (f" — {len(failures)} BM day(s) failed this run" if failures else ""))


if __name__ == "__main__":
    cli = argparse.ArgumentParser(
        description="Observable BESS revenue stack (plan/08, issue #47)")
    cli.add_argument("--backfill", type=int, nargs="?",
                     const=DEFAULT_BACKFILL_DAYS, default=None, metavar="DAYS",
                     help=f"one-off historical BM cashflow build (default "
                          f"{DEFAULT_BACKFILL_DAYS}, hard-capped at "
                          f"{MAX_BACKFILL_DAYS}); EAC history is always "
                          "fetched in full regardless of this flag")
    cli.add_argument("--force-backfill", action="store_true",
                     help="refetch BM days already present in the payload")
    args = cli.parse_args()
    backfill_arg = min(args.backfill, MAX_BACKFILL_DAYS) if args.backfill else None
    build(backfill_days=backfill_arg, force_backfill=args.force_backfill)

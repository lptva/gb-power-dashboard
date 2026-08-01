"""
BESS profitability calculator support payload (plan/09, issue #49)
====================================================================
Writes app/data/bess_units.json: the blocks the profitability
calculator card needs (D33/D34) —

  * `percentiles` — the CROSS-UNIT distribution of per-unit
    trailing-365-day EAC availability revenue, £/kW/day. The percentile
    control on the calculator card reads this block directly.
    `percentiles.families` (v1.5, D34 amendment item 2) adds, for each
    shipped percentile, the six-family (DC/DM/DR/BR/QR/SR) £/kW/day
    split D21's family toggles subtract from — see
    `family_percentile_components()`'s docstring for the method and
    the additivity guarantee (family components sum EXACTLY to the
    published percentile total) it rests on.
  * `tnuos` — the 27-zone TNUoS Onshore Generator Tariffs table
    (vendored from the highest `Year_FY` carrying `Publication` =
    'Final'), the reference table behind the zone dropdown.
  * `inflation` (owner request, 2026-08-01) — the ONS CPI 12-month rate,
    the OPEX escalation field's shipped default; null (not a missing
    key — see `fetch_inflation()`) when the ONS fetch fails, which must
    never fail this build. PPI is investigated in `fetch_inflation()`'s
    own docstring and not shipped — see there for why.

Both/all three blocks are cheap and small (~2.5 kB together, D33's v1
measured figure, plus a few hundred bytes for the v1.5 family split and
the inflation block). The full
per-unit aggregation (`units`) and the monthly Sell Orders
acceptance-rate table (`acceptance`) are v2 work — see plan/09 D34's
phasing note: "v1's ETL already computes the full per-unit
aggregation internally, because that is what the percentiles are
computed from. v1 simply does not write it out." This module's
`per_unit_kw_day()` (and, since v1.5, `per_unit_family_kw_day()`) is
exactly that internal aggregation; only `build_and_write()` decides
what gets serialised.

Reuses `etl/build_bess_revenue.py`'s EAC join wholesale (D13 cohort
rule, resource resolution, the WAF-safe SQL, the registry fetch) per
plan/09's ETL design step 1 ("reuse the extended registry helper
plan/08 introduced") — this is NOT a fork: build_bess_units imports
build_bess_revenue's functions directly, rather than recopying the
EAC/registry plumbing a second time. The only new fetch this module
adds is the TNUoS Onshore Generator Tariffs resource (S4), one grouped
`datastore_search_sql` call, keyless, NESO Open Data Licence.

Five tripwires (the first four apply from v1, the fifth from v1.5 —
plan/09 ETL design section):
  * the cohort must be non-empty and its unit count within 50-150% of
    the sibling bess_revenue.json's cohort.units (same D13 rule, two
    independent builds — a silent registry or schema change should
    raise, not ship a corrupted percentile);
  * the capacity-weighted mean must agree with bess_revenue.json's own
    window mean to within 10%;
  * the zone table must carry exactly 27 rows and a Published_Date;
  * the payload must serialise under 40 kB;
  * the six family components of every shipped percentile must sum
    exactly (to floating-point precision) to that percentile's own
    published total (D34 v1.5 item 2, D36's workbook check row).

Usage:
    python etl/build_bess_units.py
"""

import hashlib
import json
import sys
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_bess_revenue as bess_revenue  # noqa: E402 — reused join/fetch logic

PROJECT_DIR = Path(__file__).resolve().parents[1]
OUT_DIR = PROJECT_DIR / "app" / "data"
OUT_PATH = OUT_DIR / "bess_units.json"
SIBLING_PATH = OUT_DIR / "bess_revenue.json"

SCHEMA_VERSION = 1
WINDOW_DAYS = 365
PAYLOAD_BUDGET_BYTES = 40 * 1024

TNUOS_RESOURCE_ID = "ffc0adb8-5426-474e-94a3-a5f3f01a0cdb"  # Onshore Generator
                                                             # Tariffs (S4)

# OPEX escalation default (owner request, 2026-08-01): ONS's v1 API, not
# the v0 "/timeseries/{id}/dataset/{ds}/data" shape a first guess would
# reach for — that API was retired 2024-10-14 (see
# developer.ons.gov.uk/retirement/v0api/) and now 404s. The v1 data
# endpoint takes an evergreen `uri` (ONS's own migration guide's word for
# it — stable across editions/releases) rather than a dataset+cdid pair;
# this one was resolved via /v1/search?content_type=timeseries&cdids=d7g7
# and verified live (see fetch_inflation()'s docstring).
ONS_API = "https://api.beta.ons.gov.uk/v1/data"
ONS_CPI_URI = "/economy/inflationandpriceindices/timeseries/d7g7/mm23"

SOURCE = ("NESO Data Portal EAC auction results (Results By Unit) joined to "
         "the Elexon BM Unit registry, restricted to the trailing 365-day "
         "window; NESO TNUoS Onshore Generator Tariffs (Onshore Generator "
         "Tariffs resource).")


def _core():
    """Lazy import, same reasoning as every other ETL module in this repo:
    the pure logic below must stay importable where certifi is absent."""
    import build_dataset
    return build_dataset


# ---------------------------------------------------------------------------
# Pure logic — everything the unit tests exercise
# ---------------------------------------------------------------------------

def trailing_window(res_hi, window_days=WINDOW_DAYS):
    """[day_from, day_to] (inclusive, ISO strings) for the trailing window
    ending at `res_hi` (a date), plus the day count."""
    day_to = res_hi
    day_from = day_to - timedelta(days=window_days - 1)
    return str(day_from), str(day_to), window_days


def per_unit_totals(eac_rows, cohort, window_hours, day_from, day_to):
    """Per-unit total £ earned across all twelve EAC products, summed over
    [day_from, day_to] inclusive (ISO date strings) — the internal
    aggregation the percentiles are computed from (D34's implementer
    note). Returns (totals, active_days): `totals` maps unit -> total £
    (cohort units only); `active_days` maps unit -> the set of days on
    which it earned any non-zero EAC volume (S6's "34 of 123 fleet units
    earned no EAC revenue" distinction, kept here for the v2 `units`
    block even though v1 does not write per-unit detail out)."""
    totals = {u: 0.0 for u in cohort}
    active_days = {u: set() for u in cohort}
    for row in eac_rows:
        unit = row["unit"]
        if unit not in cohort:
            continue
        if not (day_from <= row["day"] <= day_to):
            continue
        window_h = window_hours.get(row["product"])
        if window_h is None:
            continue
        gbp = bess_revenue.revenue_gbp(row["gbp_ex_window"], 1.0, window_h)
        totals[unit] += gbp
        if gbp:
            active_days[unit].add(row["day"])
    return totals, active_days


def per_unit_kw_day(totals, cohort, n_days):
    """£/kW/day per unit over the window, cohort units with positive
    registered capacity only (a zero-capacity entry cannot be normalised
    and would divide by zero)."""
    out = {}
    for unit, total in totals.items():
        cap_kw = cohort[unit]["cap_mw"] * 1000
        if cap_kw <= 0:
            continue
        out[unit] = total / cap_kw / n_days
    return out


def cross_unit_percentiles(kw_day_by_unit, totals, cohort, n_days):
    """The `percentiles` payload block: p10/p25/p50/p75/p90 of the
    cross-unit £/kW/day distribution (D21 — never a fleet mean times a
    win probability), plus the capacity-weighted mean as the cross-check
    against bess_revenue.json's own fleet figure (S6)."""
    values = list(kw_day_by_unit.values())
    mw_total = sum(cohort[u]["cap_mw"] for u in kw_day_by_unit)
    gbp_total = sum(totals[u] for u in kw_day_by_unit)
    mean_cap_weighted = (gbp_total / (mw_total * 1000) / n_days
                        if mw_total else None)
    return {
        "p10": round(bess_revenue.percentile(values, 0.10), 4),
        "p25": round(bess_revenue.percentile(values, 0.25), 4),
        "p50": round(bess_revenue.percentile(values, 0.50), 4),
        "p75": round(bess_revenue.percentile(values, 0.75), 4),
        "p90": round(bess_revenue.percentile(values, 0.90), 4),
        "mean_cap_weighted": (round(mean_cap_weighted, 4)
                              if mean_cap_weighted is not None else None),
    }


FAMILIES = ("DC", "DM", "DR", "BR", "QR", "SR")  # fixed order — matches the
                                                  # v2 `units.f` example in
                                                  # plan/09's payload section
                                                  # and D34 v1.5 item 2


def per_unit_family_totals(eac_rows, cohort, window_hours, day_from, day_to):
    """Per-unit, per-family (DC/DM/DR/BR/QR/SR) total £ earned over
    [day_from, day_to] inclusive — same window, same rows and the same
    revenue_gbp() conversion as `per_unit_totals`, just split by service
    family (bess_revenue.PRODUCTS[product]['code']) instead of summed
    across all twelve products. This is what the family percentile
    components (D34 v1.5 item 2) are computed from; every cohort unit
    gets an entry, all-zero families included, so a unit that earned
    nothing in one family is distinguishable from one absent from the
    cohort entirely."""
    totals = {u: {f: 0.0 for f in FAMILIES} for u in cohort}
    for row in eac_rows:
        unit = row["unit"]
        if unit not in cohort:
            continue
        if not (day_from <= row["day"] <= day_to):
            continue
        product = bess_revenue.PRODUCTS.get(row["product"])
        window_h = window_hours.get(row["product"])
        if product is None or window_h is None:
            continue
        gbp = bess_revenue.revenue_gbp(row["gbp_ex_window"], 1.0, window_h)
        totals[unit][product["code"]] += gbp
    return totals


def per_unit_family_kw_day(family_totals, cohort, n_days):
    """£/kW/day per unit per family — same cohort filter as
    `per_unit_kw_day` (positive registered capacity only, a zero-capacity
    entry cannot be normalised)."""
    out = {}
    for unit, by_family in family_totals.items():
        cap_kw = cohort[unit]["cap_mw"] * 1000
        if cap_kw <= 0:
            continue
        out[unit] = {f: v / cap_kw / n_days for f, v in by_family.items()}
    return out


def family_percentile_components(kw_day_by_unit, family_kw_day_by_unit,
                                 percentiles, scale=10000):
    """The additive family breakdown behind D21's six family toggles
    (plan/09 v1.5 item 2, D34): for each shipped percentile, the family
    components of the RANK-REPRESENTATIVE unit(s) at that percentile —
    NOT six independently-ranked family percentiles, which is the
    definition D34 explicitly rejects because it does not sum back to
    the published total (and would break D36's workbook check row).

    Method (HARD REQUIREMENT: family components must sum EXACTLY to the
    percentile total, never merely approximately):

    `cross_unit_percentiles` computes each pXX with linear-interpolation
    percentile (`bess_revenue.percentile`): sort the cross-unit £/kW/day
    values, then the value at quantile q is a weighted blend of the unit
    ranked at floor((n-1)*q) and the next one up, weighted by the
    fractional part of (n-1)*q. This function applies that SAME pair of
    ranks and that SAME weight to each family's £/kW/day value for those
    same two units. That is exact by construction: summing a linear
    interpolation of six family values commutes with interpolating the
    (pre-summed) total, so before any display rounding the six family
    components always sum to the total to floating-point precision —
    there is no "small band of nearby units" averaging step, because
    the two ranked units the total's own interpolation already uses are
    the only rank-representative units this percentile has.

    What is left is display rounding: `cross_unit_percentiles` rounds
    each total to 4dp. Each family component is independently rounded
    to the same precision (integer ten-thousandths, i.e. `scale=10000`),
    which can leave a residual of a few units in the fourth decimal
    place against the ROUNDED total. That residual is folded into
    whichever family has the largest rounded magnitude, so the
    published, rounded figures sum EXACTLY — not just to floating-point
    precision — to the published, rounded percentile total.

    Returns {percentile_key: {family_code: value}}."""
    order = sorted(kw_day_by_unit, key=lambda u: kw_day_by_unit[u])
    n = len(order)
    out = {}
    for key, q in (("p10", 0.10), ("p25", 0.25), ("p50", 0.50),
                  ("p75", 0.75), ("p90", 0.90)):
        if n == 0:
            out[key] = {f: 0.0 for f in FAMILIES}
            continue
        idx = (n - 1) * q
        lo = int(idx)
        hi = min(lo + 1, n - 1)
        frac = idx - lo
        u_lo, u_hi = order[lo], order[hi]
        rounded = {}
        for f in FAMILIES:
            v_lo = family_kw_day_by_unit[u_lo].get(f, 0.0)
            v_hi = family_kw_day_by_unit[u_hi].get(f, 0.0)
            raw = v_lo + (v_hi - v_lo) * frac
            rounded[f] = round(raw * scale)
        target = round(percentiles[key] * scale)
        residual = target - sum(rounded.values())
        if residual:
            biggest = max(rounded, key=lambda f: abs(rounded[f]))
            rounded[biggest] += residual
        out[key] = {f: rounded[f] / scale for f in FAMILIES}
    return out


class FamilyAdditivityError(RuntimeError):
    """Tripwire 5 (v1.5): the six family components published for a
    percentile must sum EXACTLY to that percentile's own published
    total — the hard invariant D34 v1.5 item 2 and D36's workbook check
    row both rest on. A mismatch here means
    `family_percentile_components`'s rounding-residual step has a bug,
    not a data problem, and must never ship."""


def assert_family_additivity(percentiles, families, tolerance=1e-9):
    for key, components in families.items():
        total = sum(components.values())
        if abs(total - percentiles[key]) > tolerance:
            raise FamilyAdditivityError(
                f"family components for {key} sum to {total}, expected "
                f"{percentiles[key]} (diff {abs(total - percentiles[key])})")


class CohortCountMismatch(RuntimeError):
    """Tripwire 1: this build's EAC-active cohort count has drifted too far
    from the sibling bess_revenue.json's cohort — both apply the same D13
    rule independently, so a wide gap signals a registry or schema change,
    not noise."""


def assert_cohort_count(this_units, sibling_units):
    if this_units <= 0:
        raise CohortCountMismatch("EAC-active cohort is empty")
    if sibling_units is None:
        return  # sibling payload absent (fresh clone) — nothing to check
    ratio = this_units / sibling_units
    if not (0.5 <= ratio <= 1.5):
        raise CohortCountMismatch(
            f"cohort {this_units} units is {ratio:.1%} of "
            f"bess_revenue.json's {sibling_units}: outside the 50-150% "
            "plausibility band")
    return ratio


class MeanAgreementMismatch(RuntimeError):
    """Tripwire 2: the capacity-weighted mean must agree with
    bess_revenue.json's own window mean to within 10% (S6's cross-check
    that the two aggregations agree; measured 0.0293 vs 0.0296)."""


def assert_mean_agreement(this_mean, sibling_mean, tolerance=0.10):
    if sibling_mean is None or not sibling_mean:
        return  # sibling payload absent or degenerate — nothing to check
    if this_mean is None:
        raise MeanAgreementMismatch("this build's capacity-weighted mean "
                                    "is undefined")
    diff = abs(this_mean - sibling_mean) / abs(sibling_mean)
    if diff > tolerance:
        raise MeanAgreementMismatch(
            f"capacity-weighted mean {this_mean} disagrees with "
            f"bess_revenue.json's {sibling_mean} by {diff:.1%} "
            f"(tolerance {tolerance:.0%})")
    return diff


class ZoneTableError(RuntimeError):
    """Tripwire 3: the TNUoS zone table must carry exactly 27 rows and a
    Published_Date — every historical (Publication, Year_FY,
    Published_Date) triple in the source has exactly 27 (S4)."""


def assert_zone_table(zones, published_date):
    if len(zones) != 27:
        raise ZoneTableError(
            f"TNUoS zone table has {len(zones)} rows, expected exactly 27")
    if not published_date:
        raise ZoneTableError("TNUoS zone table is missing Published_Date")


class PayloadBudgetError(RuntimeError):
    """Tripwire 4: the serialised payload must stay under the 40 kB budget
    (D33) that applies to both v1 and v2."""


def assert_payload_budget(blob_bytes, budget=PAYLOAD_BUDGET_BYTES):
    if len(blob_bytes) > budget:
        raise PayloadBudgetError(
            f"payload is {len(blob_bytes)} bytes, over the {budget}-byte "
            "budget")


def sibling_cohort_stats(window_days=WINDOW_DAYS):
    """Read bess_revenue.json's own cohort.units and a capacity-weighted
    mean £/kW/day comparable to this module's own `mean_cap_weighted`, for
    the two cross-build tripwires above.

    bess_revenue.json's shipped `eac_gbp_per_kw_day` divides each day by
    that day's TIME-VARYING denominator (D13: the summed nameplate of
    cohort units first seen on or before that day), which is smaller than
    the final cohort MW early in its 400-day window — so its raw series
    mean runs noticeably higher than a constant-capacity-weighted mean
    (measured: ~24-29% apart, not a rounding difference). To get a
    genuinely comparable figure, each day's total £ is recovered
    (per_kw_day x that day's own denominator_kw) and then renormalised by
    the FINAL, constant cohort MW over the trailing `window_days` — the
    same construction this module's own `cross_unit_percentiles` uses.
    Measured agreement doing it this way: 0.0293 vs 0.0293-0.0294, i.e.
    the S6 cross-check plan/09 cites (0.0293 against plan/08's 0.0296).

    Returns (units, mean_gbp_per_kw_day), either possibly None if the
    sibling payload is absent, unreadable or too sparse to compare — the
    tripwires degrade to a no-op in that case (a fresh clone with neither
    payload built yet), never a crash."""
    try:
        payload = json.loads(SIBLING_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None, None
    units = (payload.get("cohort") or {}).get("units")
    series = payload.get("eac_gbp_per_kw_day") or {}
    days = payload.get("days") or []
    denom_kw = payload.get("denominator_kw") or []
    final_kw = (payload.get("cohort") or {}).get("mw", 0) * 1000
    if not days or not series or not denom_kw or not final_kw:
        return units, None
    n = min(window_days, len(days))
    totals_gbp = [sum(series[p][i] for p in series) * denom_kw[i]
                 for i in range(len(days) - n, len(days))]
    mean = sum(totals_gbp) / (final_kw * n) if n else None
    return units, mean


def parse_cpi_months(months):
    """The pure half of fetch_inflation() below (owner request,
    2026-08-01), split out so the ONS response SHAPE has a test that
    needs no network: `months` is ONS's own array (list of
    {"date": "2026 JUN", "value": "2.6", ...} dicts, chronological,
    a not-yet-published latest period carrying a blank `value` rather
    than being absent). Returns (cpi_annual_pct, cpi_period) from the
    LATEST entry with a non-blank value — never `months[-1]` unguarded,
    since that can be the blank stub. Raises ValueError when no month
    has ever published a value (an empty or entirely-blank array);
    fetch_inflation() is what turns that into a non-fatal None, not
    this function — a pure parser should fail loudly on bad input, the
    same discipline ops/xlsx_eval.py's closed grammar uses."""
    published = [m for m in months if str(m.get("value", "")).strip()]
    if not published:
        raise ValueError("no published CPI month in the response")
    latest = published[-1]
    return round(float(latest["value"]), 1), latest["date"]


# ---------------------------------------------------------------------------
# Fetchers (impure)
# ---------------------------------------------------------------------------

def fetch_tnuos():
    """One grouped query for the highest `Year_FY` with
    `Publication = 'Final'` (D24), asserting exactly 27 rows (S4)."""
    year_sql = (f'SELECT max("Year_FY") AS y FROM "{TNUOS_RESOURCE_ID}" '
               'WHERE "Publication" = \'Final\'')
    year_row = bess_revenue._ckan_sql(year_sql)
    year_fy = year_row[0]["y"] if year_row else None
    if year_fy is None:
        raise ZoneTableError("no Final-publication Year_FY found")

    zones_sql = (
        'SELECT "Zone_No", "Zone_Name", "Published_Date", '
        '"SystemPeak_£/kW", "SharedYearRound_£/kW", '
        '"NotSharedYearRound_£/kW", "Residual_£/kW", '
        '"SmallGenDiscount_£/kW" '
        f'FROM "{TNUOS_RESOURCE_ID}" '
        f'WHERE "Year_FY" = {int(year_fy)} AND "Publication" = \'Final\' '
        'ORDER BY "Zone_No"')
    rows = bess_revenue._ckan_sql(zones_sql)
    published_date = rows[0]["Published_Date"] if rows else None
    zones = [{
        "n": int(row["Zone_No"]),
        "name": row["Zone_Name"],
        "peak": round(float(row["SystemPeak_£/kW"]), 3),
        "yr_shared": round(float(row["SharedYearRound_£/kW"]), 3),
        "yr_notshared": round(float(row["NotSharedYearRound_£/kW"]), 3),
        "residual": round(float(row["Residual_£/kW"]), 3),
        "small_gen_discount": round(float(row["SmallGenDiscount_£/kW"]), 3),
    } for row in rows]
    assert_zone_table(zones, published_date)
    return {"year_fy": int(year_fy), "publication": "Final",
           "published": published_date, "zones": zones}


def fetch_inflation():
    """CPI 12-month rate (owner request, 2026-08-01) — the calculator's
    OPEX escalation field's shipped DEFAULT, the same category as the
    TNUoS zone defaults above: a last-published observed statistic, not
    a forecast. ONS timeseries d7g7 ("CPI ANNUAL RATE 00: ALL ITEMS
    2015=100", dataset MM23), confirmed live against ONS's own
    /v1/search?content_type=timeseries&cdids=d7g7, whose one result's
    `uri` is ONS_CPI_URI above; fetched from `months`, not the
    `description.number` convenience mirror, because `months` is the
    series of record and the one place a not-yet-published latest month
    (blank value) is visible and skippable.

    PPI: investigated and NOT shipped. The headline "output (factory
    gate), all manufacturing" 12-month RATE the owner asked for has no
    cdid this ETL could verify with confidence — the pre-2026 headline
    index series (GB7S, FUBK) stopped updating in early 2025, the
    Producer Price Inflation bulletin's own scope changed to "including
    services" partway through this year, and neither the search API nor
    the dataset endpoints surface a distinctly-labelled annual-rate
    series for the new scope the way d7g7 does for CPI. Guessing a cdid
    here would ship a silently-wrong default; the owner's own fallback
    instruction is followed instead: ship CPI only, ppi_annual_pct/
    ppi_period stay null.

    NON-FATAL by construction, matching how ops/refresh.py already runs
    this whole builder (a print() warning, never an exception): the
    calculator's own default logic (bessCalcOpexEscDefault) already
    treats an absent/null inflation block as "no default available",
    the same graceful-degradation path as a missing bess_units.json
    fetch entirely — this one fetch failing must never fail the whole
    payload build. Catches EVERYTHING (network, JSON, and
    parse_cpi_months' own ValueError alike) for exactly that reason;
    parse_cpi_months is the pure, separately-tested half."""
    core = _core()
    try:
        url = f"{ONS_API}?" + urllib.parse.urlencode({"uri": ONS_CPI_URI})
        data = json.loads(core.http(url))
        cpi_pct, cpi_period = parse_cpi_months(data.get("months", []))
        return {
            "cpi_annual_pct": cpi_pct,
            "cpi_period": cpi_period,
            "ppi_annual_pct": None,
            "ppi_period": None,
            "source": "ONS",
            "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
    except Exception as error:  # noqa: BLE001 — non-fatal, see docstring
        print(f"  WARNING: ONS inflation fetch failed, no OPEX escalation "
             f"default shipped this build: {error}")
        return None


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def update_manifest():
    """Register bess_units.json in the manifest — same pattern as every
    other ETL module (build_bmu_snapshot.py:178-186)."""
    core = _core()
    manifest_path = OUT_DIR / "manifest.json"
    if not manifest_path.exists():
        return
    manifest = json.loads(manifest_path.read_text())
    files = manifest.setdefault("files", {})
    blob = OUT_PATH.read_bytes()
    files["bess_units.json"] = {"sha256": hashlib.sha256(blob).hexdigest(),
                               "bytes": len(blob)}
    manifest["version"] += 1
    core._atomic_write(manifest_path, json.dumps(manifest, indent=2))


def build():
    core = _core()
    core.USE_CACHE = False
    print("bess units pipeline (calculator support payload, v1 + v1.5 families)")

    display_start_guess = str(date.today() - timedelta(days=WINDOW_DAYS + 30))
    print("  Resolving EAC resources…")
    resources = bess_revenue.resolve_relevant_resources(display_start_guess)
    for res in resources:
        print(f"    {res['name']}: {res['lo']} -> {res['hi']}")

    print("  Fetching EAC revenue rows + window assertion…")
    eac_rows, window_rows = bess_revenue.fetch_eac_rows_and_windows(resources)
    window_hours = bess_revenue.assert_windows(window_rows)
    print(f"    {len(eac_rows)} rows; window hours: {window_hours}")

    print("  Fetching BM Unit registry…")
    registry = bess_revenue.fetch_registry()
    eac_unit_ids = sorted({row["unit"] for row in eac_rows})
    cohort, _signature_hits = bess_revenue.build_cohort(registry, eac_unit_ids)
    print(f"    cohort: {len(cohort)} units, "
         f"{sum(i['cap_mw'] for i in cohort.values()):.1f} MW")

    res_hi = max(date.fromisoformat(r["hi"]) for r in resources)
    day_from, day_to, n_days = trailing_window(res_hi)
    print(f"  Trailing window: {day_from} -> {day_to} ({n_days} days)")

    totals, active_days = per_unit_totals(eac_rows, cohort, window_hours,
                                         day_from, day_to)
    active_units = {u for u, days in active_days.items() if days}
    print(f"    {len(active_units)} of {len(cohort)} cohort units earned "
         "EAC revenue in the window")

    kw_day = per_unit_kw_day(totals, cohort, n_days)
    percentiles = cross_unit_percentiles(kw_day, totals, cohort, n_days)

    family_totals = per_unit_family_totals(eac_rows, cohort, window_hours,
                                           day_from, day_to)
    family_kw_day = per_unit_family_kw_day(family_totals, cohort, n_days)
    percentiles["families"] = family_percentile_components(
        kw_day, family_kw_day, percentiles)
    percentiles["family_method"] = (
        "Family components are the DC/DM/DR/BR/QR/SR split of the same "
        "rank-interpolated unit pair cross_unit_percentiles uses for the "
        "total (the unit at floor((n-1)q) and the next one up, blended "
        "by the same fractional weight), so they sum exactly to the "
        "published total; not six independently-ranked family "
        "percentiles, which would not.")
    assert_family_additivity(percentiles, percentiles["families"])

    sibling_units, sibling_mean = sibling_cohort_stats()
    assert_cohort_count(len(cohort), sibling_units)
    assert_mean_agreement(percentiles["mean_cap_weighted"], sibling_mean)

    print("  Fetching TNUoS Onshore Generator Tariffs…")
    tnuos = fetch_tnuos()
    print(f"    FY{tnuos['year_fy']} {tnuos['publication']}, "
         f"published {tnuos['published']}, {len(tnuos['zones'])} zones")

    # Non-fatal (owner request, 2026-08-01): unlike tnuos above, a failed
    # inflation fetch must not fail the whole build — fetch_inflation()
    # itself never raises, returning None with its own warning instead.
    print("  Fetching ONS inflation (CPI 12-month rate)…")
    inflation = fetch_inflation()
    if inflation:
        print(f"    CPI {inflation['cpi_annual_pct']}% "
             f"({inflation['cpi_period']})")

    built_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    payload = {
        "built_at": built_at,
        "schema": SCHEMA_VERSION,
        "source": SOURCE,
        "window": {"from": day_from, "to": day_to, "days": n_days},
        "percentiles": percentiles,
        "tnuos": tnuos,
        "inflation": inflation,
    }

    blob = json.dumps(payload).encode()
    assert_payload_budget(blob)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    core._atomic_write(OUT_PATH, json.dumps(payload))
    update_manifest()

    size_kb = len(blob) / 1024
    print(f"\nWrote {OUT_PATH} ({size_kb:.2f} kB, budget "
         f"{PAYLOAD_BUDGET_BYTES / 1024:.0f} kB): "
         f"percentiles p50={percentiles['p50']} £/kW/day "
         f"({percentiles['p50'] * 365:.2f} £/kW/yr), "
         f"{len(tnuos['zones'])} TNUoS zones FY{tnuos['year_fy']}")


if __name__ == "__main__":
    build()

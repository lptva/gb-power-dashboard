"""
ENTSO-E Transparency fetcher — Europe extension (design: plan/04)
==================================================================
Fetches day-ahead prices (A44), actual generation per production type (A75)
and actual total load (A65/A16) for one bidding zone and writes the same
columnar schema as the GB dataset, under app/data/zones/<ZONE>/.

Access is free but gated: register at https://transparency.entsoe.eu, then
email transparency@entsoe.eu with subject "RESTful API access" and your
registered address in the body (granted within ~3 working days). Export the
token as ENTSOE_TOKEN. Without it this script prints these instructions and
exits cleanly — it never writes placeholder data.

Usage:
    ENTSOE_TOKEN=… python fetch_entsoe.py --zone FR --days 30

Honest caveats (also in plan/04-europe-extension.md):
  * ENTSO-E "Fossil Gas" does not split CCGT/OCGT — it is mapped to CCGT and
    the OCGT column stays empty; per-technology merit assumptions therefore
    do not transfer to ENTSO-E zones.
  * Wind Onshore + Offshore are summed into WIND, which includes most
    onshore wind — unlike Elexon's transmission-only WIND. Residual-load
    formulas are zone-specific and must not be reused blindly.
  * The A44 day-ahead price is a true auction price, unlike GB's MID proxy.
"""

import argparse
import json
import os
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Reuse the shared HTTP/caching helpers and output location.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_dataset import HALF_HOUR, OUT_DIR, http  # noqa: E402

API = "https://web-api.tp.entsoe.eu/api"

# Zone set logic (stated explicitly — see plan/04 and README):
#   "interconnected" = GB's physical counterparty bidding zones, one per
#   cable landing market: FR (IFA/IFA2/ElecLink), NL (BritNed), BE (Nemo),
#   NO_2 (North Sea Link), DK_1 (Viking Link), IE/SEM (Moyle, EWIC,
#   Greenlink).
#   "reference" = NOT physically connected to GB; included only as a price
#   anchor for context and labelled as such in the UI.
# IE note — two current EICs for different AREA TYPES (neither is
# deprecated): ENTSO-E publishes day-ahead prices [12.1.D] against the SEM
# bidding-zone EIC (10Y1001A1001A59C) and actual total load [6.1.A] against
# the Ireland control-area EIC (10YIE-1001A00010); generation per type
# [16.1.B&C] accepts either (verified empirically against both). alt_eic is
# the control-area fallback used for load.
ZONES = {
    "FR":    {"eic": "10YFR-RTE------C", "label": "France",
              "kind": "interconnected"},
    "NL":    {"eic": "10YNL----------L", "label": "Netherlands",
              "kind": "interconnected"},
    "BE":    {"eic": "10YBE----------2", "label": "Belgium",
              "kind": "interconnected"},
    "NO_2":  {"eic": "10YNO-2--------T", "label": "Norway (NO2)",
              "kind": "interconnected"},
    "DK_1":  {"eic": "10YDK-1--------W", "label": "Denmark (DK1)",
              "kind": "interconnected"},
    "IE":    {"eic": "10Y1001A1001A59C", "label": "Ireland (SEM)",
              "kind": "interconnected", "alt_eic": "10YIE-1001A00010"},
    "DE_LU": {"eic": "10Y1001A1001A82H", "label": "Germany–Luxembourg",
              "kind": "reference"},
}

# ENTSO-E PSR type → nearest Elexon-style column (see plan/04 for mismatches)
PSR_MAP = {
    "B01": "BIOMASS", "B02": "COAL", "B04": "CCGT", "B05": "COAL",
    "B06": "OIL", "B10": "PS", "B11": "NPSHYD", "B12": "NPSHYD",
    "B14": "NUCLEAR", "B16": "solar", "B18": "WIND", "B19": "WIND",
}
OTHER = "OTHER"

NO_TOKEN_MESSAGE = """\
No ENTSOE_TOKEN set — nothing fetched (this is expected until you register).

To get a free token:
  1. Register at https://transparency.entsoe.eu (Sign in → Register).
  2. Email transparency@entsoe.eu, subject "RESTful API access", with your
     registered email address in the body. Access arrives within ~3 working
     days.
  3. export ENTSOE_TOKEN=<your token>, or put ENTSOE_TOKEN=<your token> in
     a .env file at the PROJECT ROOT (never under app/ — app/ is served by
     the web server), and re-run this script.
"""


def _load_dotenv() -> None:
    """Minimal stdlib .env support: fill ENTSOE_TOKEN from the project-root
    .env when it is not already in the environment. Only this one key is
    read; the value is never printed."""
    if os.environ.get("ENTSOE_TOKEN", "").strip():
        return
    env_path = Path(__file__).resolve().parents[1] / ".env"
    try:
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == "ENTSOE_TOKEN":
                os.environ["ENTSOE_TOKEN"] = value.strip().strip("'\"")
                return
    except OSError:
        pass  # no .env — the environment variable path still applies


def _period(day_from: date, day_to: date) -> dict:
    return {
        "periodStart": f"{day_from:%Y%m%d}0000",
        "periodEnd": f"{day_to + timedelta(days=1):%Y%m%d}0000",
    }


def _get_xml(token: str, **params) -> ET.Element:
    query = urllib.parse.urlencode({"securityToken": token, **params})
    return ET.fromstring(http(f"{API}?{query}"))


def _strip(tag: str) -> str:
    return tag.split("}", 1)[-1]


def _points_to_hh(period_el, ns: str,
                  curve_type: str = "A01") -> dict[int, float]:
    """One <Period> into {half-hour epoch: value}, normalising resolution.

    PT60M values are repeated across both half-hours; PT15M pairs are
    averaged; PT30M passes through. Positions may be sparse: under
    curveType A03 (variable-sized block) an omitted position carries the
    previous value forward to the period's DECLARED END — e.g. IE solar
    publishes one point spanning days — so A03 fills to the end of the
    timeInterval, while other curve types fill only up to the last point
    present (never inventing data past it).
    """
    start = datetime.fromisoformat(
        period_el.find(f"{ns}timeInterval/{ns}start").text
        .replace("Z", "+00:00"))
    end = datetime.fromisoformat(
        period_el.find(f"{ns}timeInterval/{ns}end").text
        .replace("Z", "+00:00"))
    resolution = period_el.find(f"{ns}resolution").text
    step = {"PT15M": 900, "PT30M": 1800, "PT60M": 3600}.get(resolution)
    if step is None:
        return {}
    raw = {}
    for point in period_el.findall(f"{ns}Point"):
        pos = int(point.find(f"{ns}position").text)
        qty = point.find(f"{ns}quantity")
        if qty is None:
            qty = point.find(f"{ns}price.amount")
        raw[pos] = float(qty.text)
    if not raw:
        return {}

    n_declared = int((end - start).total_seconds() // step)
    limit = n_declared if curve_type == "A03" else max(raw)
    values, last = [], None
    for pos in range(1, limit + 1):
        last = raw.get(pos, last)
        values.append(last)

    start_ts = int(start.timestamp())
    out: dict[int, float] = {}
    if step == 1800:
        for i, value in enumerate(values):
            out[start_ts + i * 1800] = value
    elif step == 3600:  # repeat each hourly value across both half-hours
        for i, value in enumerate(values):
            out[start_ts + i * 3600] = value
            out[start_ts + i * 3600 + HALF_HOUR] = value
    else:  # PT15M — average each pair of quarter-hours into a half-hour
        for i in range(0, len(values) - 1, 2):
            out[start_ts + (i // 2) * 1800] = (values[i] + values[i + 1]) / 2
    return out


def fetch_zone(token: str, zone: str, start: date, end: date):
    """All three document types for one zone → (columnar dict, currency).

    The settlement currency is read from the A44 response itself
    (currency_Unit.name) rather than assumed. For zones with an alt_eic
    (IE/SEM), generation and load fall back to the control-area EIC when
    the bidding-zone EIC returns nothing — ENTSO-E publishes load against
    the control area, prices against the bidding zone (both EICs current).
    """
    cfg = ZONES[zone]
    eic = cfg["eic"]
    ns_of = lambda root: "{" + root.tag.split("}")[0].strip("{") + "}"  # noqa: E731

    print(f"  A44 day-ahead prices {zone}…")
    price: dict[int, float] = {}
    currency = None
    root = _get_xml(token, documentType="A44", in_Domain=eic,
                    out_Domain=eic, **_period(start, end))
    ns = ns_of(root)
    for series in root.iter():
        if _strip(series.tag) != "TimeSeries":
            continue
        if currency is None:
            cur_el = series.find(f"{ns}currency_Unit.name")
            currency = cur_el.text if cur_el is not None else None
        curve = series.find(f"{ns}curveType")
        curve = curve.text if curve is not None else "A01"
        for period_el in series.findall(f"{ns}Period"):
            price.update(_points_to_hh(period_el, ns, curve))

    def _fetch_gen(domain: str) -> dict:
        collected: dict[str, dict[int, float]] = {}
        root = _get_xml(token, documentType="A75", processType="A16",
                        in_Domain=domain, **_period(start, end))
        ns = ns_of(root)
        for series in root.iter():
            if _strip(series.tag) != "TimeSeries":
                continue
            psr = series.find(f"{ns}MktPSRType/{ns}psrType")
            column = PSR_MAP.get(psr.text if psr is not None else "", OTHER)
            curve = series.find(f"{ns}curveType")
            curve = curve.text if curve is not None else "A01"
            target = collected.setdefault(column, {})
            for period_el in series.findall(f"{ns}Period"):
                for ts, value in _points_to_hh(period_el, ns, curve).items():
                    target[ts] = target.get(ts, 0.0) + value
        return collected

    def _fetch_load(domain: str) -> dict:
        collected: dict[int, float] = {}
        root = _get_xml(token, documentType="A65", processType="A16",
                        outBiddingZone_Domain=domain, **_period(start, end))
        ns = ns_of(root)
        for series in root.iter():
            if _strip(series.tag) == "TimeSeries":
                curve = series.find(f"{ns}curveType")
                curve = curve.text if curve is not None else "A01"
                for period_el in series.findall(f"{ns}Period"):
                    collected.update(_points_to_hh(period_el, ns, curve))
        return collected

    print(f"  A75 generation per type {zone}…")
    gen = _fetch_gen(eic)
    if not gen and cfg.get("alt_eic"):
        print(f"    empty under {eic}; retrying with control-area EIC…")
        gen = _fetch_gen(cfg["alt_eic"])

    print(f"  A65 actual load {zone}…")
    demand = _fetch_load(eic)
    if not demand and cfg.get("alt_eic"):
        print(f"    empty under {eic}; retrying with control-area EIC…")
        demand = _fetch_load(cfg["alt_eic"])

    # Union axis, snapped to the half-hour grid: mixed-resolution ENTSO-E
    # publications (PT15M periods starting at :15/:45) produce off-grid
    # duplicates of values already present on the grid — dropped, counted.
    axis_all = sorted(set(demand) | set(price)
                      | {ts for col in gen.values() for ts in col})
    axis = [ts for ts in axis_all if ts % HALF_HOUR == 0]
    if len(axis) != len(axis_all):
        print(f"  NOTE: dropped {len(axis_all) - len(axis)} off-grid "
              "timestamps (quarter-hour period starts from mixed-resolution "
              "publications; half-hourly series remain complete)")
    hh = {
        "t": axis,
        "demand": [demand.get(ts) for ts in axis],
        "price": [round(price[ts], 2) if ts in price else None for ts in axis],
        "solar": [gen.get("solar", {}).get(ts) for ts in axis],
    }
    for column in sorted(gen):
        if column != "solar":
            hh[column] = [gen[column].get(ts) for ts in axis]
    return hh, currency


def write_zone(zone: str, hh: dict, start: date, end: date,
               currency: str | None) -> None:
    zone_dir = OUT_DIR / "zones" / zone
    zone_dir.mkdir(parents=True, exist_ok=True)
    (zone_dir / "series_hh.json").write_text(json.dumps(hh))

    # Daily means, same shape as the GB series_daily.json (the app expects
    # the file to exist for every zone).
    buckets: dict[str, dict[str, list]] = {}
    for i, ts in enumerate(hh["t"]):
        day = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        bucket = buckets.setdefault(day, {k: [] for k in hh if k != "t"})
        for key in bucket:
            if hh[key][i] is not None:
                bucket[key].append(hh[key][i])
    days_sorted = sorted(buckets)
    daily = {"d": days_sorted}
    for key in [k for k in hh if k != "t"]:
        daily[key] = [
            round(sum(buckets[d][key]) / len(buckets[d][key]), 2)
            if buckets[d][key] else None
            for d in days_sorted
        ]
    daily["price_max"] = [
        round(max(buckets[d]["price"]), 2) if buckets[d]["price"] else None
        for d in days_sorted
    ]
    (zone_dir / "series_daily.json").write_text(json.dumps(daily))
    # Per-zone data-quality notes, computed rather than assumed. A03
    # variable-block periods are already filled to their declared ends by
    # the parser, so a null here is genuinely absent from the TSO
    # submission — label it, never interpolate it.
    def _fmt(ts):
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime(
            "%d %b %H:%M")
    data_quality = []
    for column in [k for k in hh if k != "t"]:
        col = hh[column]
        present = [i for i, v in enumerate(col) if v is not None]
        if not present:
            data_quality.append(
                f"{column}: not reported by the TSO in this window — "
                "ENTSO-E generation-per-type reporting (16.1.B&C) is "
                "mandatory only for technologies above ~1% of national "
                "generation, so small fleets are legitimately absent")
            continue
        runs, start_i = [], None
        for i in range(present[0], present[-1] + 1):
            if col[i] is None and start_i is None:
                start_i = i
            elif col[i] is not None and start_i is not None:
                runs.append((start_i, i - 1))
                start_i = None
        if runs:
            missing = sum(b - a + 1 for a, b in runs)
            sample = "; ".join(f"{_fmt(hh['t'][a])}→{_fmt(hh['t'][b])}"
                               for a, b in runs[:3])
            more = f" (+{len(runs) - 3} more)" if len(runs) > 3 else ""
            data_quality.append(
                f"{column}: {missing} half-hours missing in {len(runs)} "
                f"gap(s) — absent from the TSO submission, shown as gaps, "
                f"never interpolated. E.g. {sample}{more}")

    cfg = ZONES[zone]
    meta = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "zone": zone,
        "label": cfg["label"],
        "kind": cfg["kind"],  # interconnected with GB, or reference market
        "currency": currency or "EUR",  # read from A44, not assumed
        "data_quality": data_quality,
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "timezone": "All timestamps UTC.",
        "series": {
            "price": {"name": f"{zone} day-ahead auction price",
                      "source": "ENTSO-E Transparency, document A44",
                      "unit": f"{currency or 'EUR'}/MWh",
                      "resolution": "30 min (normalised)",
                      "quality": "observed",
                      "notes": "True auction price — unlike GB's MID proxy. "
                               "Currency is EUR, not GBP."},
            "demand": {"name": f"{zone} actual total load",
                       "source": "ENTSO-E Transparency, A65/A16",
                       "unit": "MW", "resolution": "30 min (normalised)",
                       "quality": "observed"},
            "generation_by_fuel": {
                "name": f"{zone} actual generation per production type",
                "source": "ENTSO-E Transparency, A75/A16",
                "unit": "MW", "resolution": "30 min (normalised)",
                "quality": "observed",
                "notes": "Fossil Gas mapped to CCGT (ENTSO-E does not split "
                         "CCGT/OCGT); Wind On+Offshore summed into WIND — "
                         "coverage differs from Elexon's transmission-only "
                         "metering. See plan/04-europe-extension.md."},
        },
    }
    (zone_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    # Register the zone in the manifest so the app's switcher can find it.
    manifest_path = OUT_DIR / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if zone not in manifest.get("zones", []):
            manifest.setdefault("zones", ["GB"]).append(zone)
            manifest["version"] += 1
            manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"Wrote {zone_dir}/series_hh.json + meta.json "
          f"and registered zone {zone}")


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--zone", choices=sorted(ZONES), default="FR")
    cli.add_argument("--days", type=int, default=30)
    args = cli.parse_args()

    _load_dotenv()
    token = os.environ.get("ENTSOE_TOKEN", "").strip()
    if not token:
        print(NO_TOKEN_MESSAGE)
        raise SystemExit(0)

    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=args.days - 1)
    print(f"Fetching ENTSO-E {args.zone} {start} → {end}")
    hh, currency = fetch_zone(token, args.zone, start, end)
    if not hh["t"]:
        raise SystemExit("ENTSO-E returned no data — nothing written")
    write_zone(args.zone, hh, start, end, currency)

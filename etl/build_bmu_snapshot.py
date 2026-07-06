"""
Observed dispatch snapshot — BM Unit level (plan/05, Phase B)
=============================================================
Writes app/data/bmu_snapshot.json: per-unit physical notifications (PN) for
the most recent complete settlement period, joined to the BMU registry for
fuel types, plus a per-fuel count of bid-offer acceptances (BOALF) in the
same half-hour.

What this is and is not (see plan/05-plant-level-merit-order.md):
  * PN is a unit's INTENDED output level — observed intent, not metered
    generation and not a bid price. No prices exist in this data.
  * Units whose registry entry carries no fuelType (batteries, DSR, small
    aggregations) are kept and labelled null → the app shows them as an
    explicit "Unclassified" category rather than dropping them.
  * Interconnector units (fuelType INT*) are excluded: they are flows, not
    plant dispatch, and appear on the Flows tab instead.

Per-unit MW is the time-weighted mean of the notified level profile across
the half-hour (PN records are level segments with timeFrom/timeTo). Units
with |MW| < 0.05 are omitted to keep the payload small.

Usage:
    python build_bmu_snapshot.py            # latest complete period
    python build_bmu_snapshot.py --date 2026-06-30 --period 35
"""

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_dataset  # noqa: E402
from build_dataset import ELEXON, OUT_DIR, _atomic_write, http, to_epoch  # noqa: E402

# The latest period must be fresh, and the registry is one cheap call —
# bypass the permanent disk cache for everything in this script.
build_dataset.USE_CACHE = False

LONDON = ZoneInfo("Europe/London")


def latest_complete_period() -> tuple[str, int]:
    """Most recent fully elapsed settlement period (local settlement day,
    periods of 30 min from local midnight — 46/48/50 on clock-change days)."""
    now = datetime.now(LONDON)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    current = int((now - midnight).total_seconds() // 1800) + 1
    if current > 1:
        return midnight.date().isoformat(), current - 1
    yesterday = (midnight - timedelta(days=1))
    periods = int((midnight - yesterday).total_seconds() // 1800)
    return yesterday.date().isoformat(), periods


def fetch_registry() -> dict[str, dict]:
    rows = json.loads(http(f"{ELEXON}/reference/bmunits/all"))
    if isinstance(rows, dict):
        rows = rows.get("data", [])
    registry = {}
    for row in rows:
        entry = {
            "fuel": row.get("fuelType") or None,
            "name": (row.get("bmUnitName") or row.get("leadPartyName")
                     or None),
            "capacity": row.get("generationCapacity"),
        }
        for key in ("elexonBmUnit", "nationalGridBmUnit"):
            if row.get(key):
                registry[row[key]] = entry
    return registry


def fetch_pn(day: str, period: int) -> dict[str, float]:
    """Time-weighted mean notified MW per unit for one settlement period."""
    payload = json.loads(http(f"{ELEXON}/datasets/PN?settlementDate={day}"
                              f"&settlementPeriod={period}"))
    records = payload.get("data", payload if isinstance(payload, list) else [])
    mw: dict[str, float] = {}
    for r in records:
        unit = r.get("bmUnit") or r.get("nationalGridBmUnit")
        try:
            seconds = to_epoch(r["timeTo"]) - to_epoch(r["timeFrom"])
            level = (float(r["levelFrom"]) + float(r["levelTo"])) / 2
        except (KeyError, TypeError, ValueError):
            continue
        if unit and seconds > 0:
            mw[unit] = mw.get(unit, 0.0) + level * seconds / 1800
    return mw


def fetch_acceptance_counts(day: str, period: int,
                            registry: dict) -> tuple[dict, str, str]:
    """BOALF acceptances during the period's half-hour, counted per fuel."""
    start = datetime.fromisoformat(day).replace(tzinfo=LONDON) \
        + timedelta(minutes=30 * (period - 1))
    t_from = start.astimezone(timezone.utc)
    t_to = t_from + timedelta(minutes=30)
    fmt = "%Y-%m-%dT%H:%MZ"
    payload = json.loads(http(
        f"{ELEXON}/datasets/BOALF/stream"
        f"?from={t_from.strftime(fmt)}&to={t_to.strftime(fmt)}"))
    counts: dict[str, int] = {}
    for r in payload if isinstance(payload, list) else []:
        unit = r.get("bmUnit") or r.get("nationalGridBmUnit")
        fuel = (registry.get(unit) or {}).get("fuel") or "Unclassified"
        counts[fuel] = counts.get(fuel, 0) + 1
    return counts, t_from.isoformat(), t_to.isoformat()


def main(day: str | None, period: int | None) -> None:
    if day is None or period is None:
        day, period = latest_complete_period()
    print(f"Building BMU snapshot for {day} SP{period}")

    print("  BMU registry…")
    registry = fetch_registry()
    print("  Physical notifications…")
    mw = fetch_pn(day, period)
    if not mw:
        raise SystemExit(f"No PN data for {day} SP{period} — nothing written")
    print("  Bid-offer acceptances…")
    try:
        acceptances, utc_from, utc_to = fetch_acceptance_counts(
            day, period, registry)
    except Exception as error:  # noqa: BLE001 — acceptances are optional
        print(f"  WARNING: BOALF unavailable ({error}); counts omitted")
        acceptances, utc_from, utc_to = {}, None, None

    units = []
    mw_total = mw_classified = 0.0
    for unit, value in mw.items():
        if abs(value) < 0.05:
            continue
        entry = registry.get(unit) or {}
        fuel = entry.get("fuel")
        # Interconnectors are flows, not dispatch (Flows tab covers them).
        # Some I_-prefixed units carry no registry fuelType, so filter on
        # the BMU id convention as well.
        if (fuel and fuel.startswith("INT")) or unit.startswith("I_"):
            continue
        if value > 0:
            mw_total += value
            if fuel:
                mw_classified += value
        units.append({
            "id": unit,
            "name": entry.get("name"),
            "fuel": fuel,
            "mw": round(value, 1),
            "capacity_mw": entry.get("capacity"),
        })
    units.sort(key=lambda u: -u["mw"])

    snapshot = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "settlement_date": day,
        "settlement_period": period,
        "window_utc": {"from": utc_from, "to": utc_to},
        "source": "Elexon Insights: PN (physical notifications) joined to "
                  "the BM Unit registry; BOALF acceptance counts. PN is "
                  "notified intent, not metered output, and carries no "
                  "prices.",
        "coverage": {
            "units": len(units),
            "mw_total": round(mw_total),
            "mw_classified_share": round(mw_classified / mw_total, 4)
            if mw_total else None,
        },
        "acceptances_by_fuel": acceptances,
        "units": units,
    }
    _atomic_write(OUT_DIR / "bmu_snapshot.json", json.dumps(snapshot))

    # Register in the manifest so the app cache-busts the snapshot too.
    manifest_path = OUT_DIR / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        import hashlib
        blob = (OUT_DIR / "bmu_snapshot.json").read_bytes()
        manifest["files"]["bmu_snapshot.json"] = {
            "sha256": hashlib.sha256(blob).hexdigest(), "bytes": len(blob)}
        manifest["version"] += 1
        _atomic_write(manifest_path, json.dumps(manifest, indent=2))

    size_kb = (OUT_DIR / "bmu_snapshot.json").stat().st_size // 1024
    print(f"Wrote {OUT_DIR}/bmu_snapshot.json ({size_kb} kB): "
          f"{len(units)} units, {mw_total/1000:.1f} GW notified, "
          f"{snapshot['coverage']['mw_classified_share']:.1%} of MW "
          "classified")


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--date", default=None,
                     help="settlement date (default: latest complete)")
    cli.add_argument("--period", type=int, default=None,
                     help="settlement period 1–50 (default: latest complete)")
    args = cli.parse_args()
    main(args.date, args.period)

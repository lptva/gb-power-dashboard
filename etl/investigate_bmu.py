"""
Plant-level merit order — feasibility investigation (plan/05)
=============================================================
Pulls ONE sample day of BM Unit-level data from the keyless Elexon Insights
API and measures whether an "observed dispatch by unit" panel is feasible:

  1. /reference/bmunits/all      — unit registry (fuel type per BMU)
  2. /datasets/PN/stream         — physical notifications for sample periods
  3. /datasets/BOALF/stream      — bid-offer acceptances for the day

Reports row counts, distinct units, the share of PN MW joinable to a fuel
type, and payload sizes. Read-only: writes nothing to app/data. Findings are
recorded in plan/05-plant-level-merit-order.md.

Usage:
    python investigate_bmu.py [--date 2026-06-30]
"""

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_dataset import ELEXON, http  # noqa: E402

SAMPLE_PERIODS = [3, 20, 35]  # night, morning peak, afternoon


def try_json(url: str):
    """Fetch and parse, returning (data, error) — investigation must report
    endpoint failures as findings, not crash on them."""
    try:
        text = http(url)
        return json.loads(text), None
    except Exception as error:  # noqa: BLE001
        return None, str(error)


def main(sample_day: str) -> None:
    print(f"=== BM Unit feasibility investigation, sample day {sample_day} ===\n")

    # ---- 1. Unit registry --------------------------------------------------
    print("1. BMU reference list…")
    registry, error = try_json(f"{ELEXON}/reference/bmunits/all")
    fuel_of: dict[str, str] = {}
    if error:
        print(f"   FAILED: {error}")
    else:
        rows = registry if isinstance(registry, list) else registry.get("data", [])
        for row in rows:
            fuel = row.get("fuelType")
            for key in ("elexonBmUnit", "nationalGridBmUnit"):
                if row.get(key) and fuel:
                    fuel_of[row[key]] = fuel
        with_fuel = len({r.get('elexonBmUnit') for r in rows
                         if r.get('fuelType')})
        print(f"   {len(rows)} units; {with_fuel} with a fuelType "
              f"({len(set(fuel_of.values()))} distinct fuel types)")

    # ---- 2. Physical notifications for sample periods ----------------------
    print("\n2. PN stream, sample settlement periods…")
    pn_stats = []
    for period in SAMPLE_PERIODS:
        # The dataset endpoint wraps rows in {"data": […]}; the stream
        # variant 404s for settlementDate/settlementPeriod params.
        url = (f"{ELEXON}/datasets/PN?settlementDate={sample_day}"
               f"&settlementPeriod={period}")
        data, error = try_json(url)
        if data is not None and isinstance(data, dict):
            data = data.get("data", [])
        if error:
            print(f"   SP{period}: FAILED: {error}")
            continue
        payload_kb = len(json.dumps(data)) / 1024
        units = {r.get("bmUnit") or r.get("nationalGridBmUnit") for r in data}
        # MW-weighted joinability: how much of the notified level maps to a
        # known fuel type (levelTo of each record, positive levels only)
        mw_total = mw_joined = 0.0
        for r in data:
            level = max(r.get("levelTo") or 0, 0)
            mw_total += level
            unit = r.get("bmUnit") or r.get("nationalGridBmUnit")
            if fuel_of.get(unit):
                mw_joined += level
        share = (mw_joined / mw_total * 100) if mw_total else 0.0
        pn_stats.append(share)
        print(f"   SP{period}: {len(data)} records, {len(units)} units, "
              f"{payload_kb:.0f} kB, {mw_total/1000:.1f} GW notified, "
              f"{share:.1f}% of MW joins to a fuel type")

    # ---- 3. Bid-offer acceptances for the day ------------------------------
    print("\n3. BOALF stream, full day…")
    url = (f"{ELEXON}/datasets/BOALF/stream?from={sample_day}T00:00Z"
           f"&to={sample_day}T23:59Z")
    data, error = try_json(url)
    if error:
        print(f"   FAILED: {error}")
    else:
        units = {r.get("bmUnit") or r.get("nationalGridBmUnit") for r in data}
        joined = sum(1 for r in data
                     if fuel_of.get(r.get("bmUnit")
                                    or r.get("nationalGridBmUnit")))
        print(f"   {len(data)} acceptance records, {len(units)} units, "
              f"{joined}/{len(data)} records join to a fuel type, "
              f"payload {len(json.dumps(data))/1024:.0f} kB")

    # ---- Verdict ------------------------------------------------------------
    print("\n=== Verdict inputs ===")
    if pn_stats:
        print(f"PN MW join coverage across sample periods: "
              f"{min(pn_stats):.1f}–{max(pn_stats):.1f}% "
              f"(go threshold: ≥80%)")
    print("Record full findings in plan/05-plant-level-merit-order.md")


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--date",
                     default=(date.today() - timedelta(days=1)).isoformat())
    args = cli.parse_args()
    main(args.date)

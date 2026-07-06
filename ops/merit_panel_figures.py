#!/usr/bin/env python3
"""Recompute the Merit order panel's headline figures exactly as the app
does, so the overnight summary can reference the panel's own numbers.

Prints one JSON object: observed price (latest MID), implied clearing
price and marginal technology (the panel's marklines), the gap between
them, and the inputs — for injection into the dashboard-watcher prompt.
run_overnight_summary.sh refuses to publish a summary whose merit figures
disagree with this output, so the LLM cannot substitute its own model.

MIRRORS app/js/metrics.js (meritLadder, meritCurveSteps, curveClearing),
app/js/state.js (default assumptions, coalInfo) and charts.js meritCurve()
input selection, including their rounding. If those change, change this.
Stdlib only, like the rest of the ETL.
"""

import json
import math
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

# app/js/state.js default assumptions (sliders untouched)
A = {
    "etaCcgtLow": 0.45, "etaCcgtHigh": 0.57,
    "etaOcgtLow": 0.32, "etaOcgtHigh": 0.40,
    "efGas": 0.184, "vom": 3,
    "etaCoalLow": 0.33, "etaCoalHigh": 0.39, "efCoal": 0.34,
}

# app/js/data.js INTERCONNECTORS registry (netImports = per-index sum,
# nulls counted as 0 — the derived column is therefore never null)
IC_KEYS = ["INTFR", "INTIFA2", "INTELEC", "INTNED", "INTNEM", "INTNSL",
           "INTVKL", "INTIRL", "INTEW", "INTGRNL"]

DISPATCHABLE = ["NUCLEAR", "BIOMASS", "NPSHYD", "CCGT", "OCGT", "COAL"]


def js_round(value, dp):
    """Exact JS Number.prototype.toFixed semantics: round the BINARY value
    of the double (ties, which are only exactly-representable halves, go
    away from zero — the spec negates first, then picks the larger n).
    A naive decimal half-up diverges: toFixed(11.225, 2) is 11.22 because
    the double is 11.2249999…, which the parity tests caught against the
    browser. Decimal(float) expands the exact binary value."""
    sign = -1 if value < 0 else 1
    quantum = Decimal(1).scaleb(-dp)
    return sign * float(Decimal(abs(value)).quantize(quantum,
                                                     rounding=ROUND_HALF_UP))


def latest(col):
    for i in range(len(col) - 1, -1, -1):
        if col[i] is not None:
            return col[i]
    return None


def hh_quantile(col, p):
    """metrics side of Data.hhQuantile: sorted non-nulls, floor(p*n)."""
    values = sorted(v for v in col if v is not None)
    if not values:
        return None
    return values[min(len(values) - 1, int(p * len(values)))]


def merit_ladder(gas, carbon, coal_price):
    def thermal(fuel, eta_low, eta_high, ef, vom):
        return (fuel / eta_high + (ef / eta_high) * carbon + vom,
                fuel / eta_low + (ef / eta_low) * carbon + vom)

    rows = [
        {"key": "WIND", "label": "Wind", "low": 0, "high": 6},
        {"key": "solar", "label": "Solar", "low": 0, "high": 5},
        {"key": "NUCLEAR", "label": "Nuclear", "low": 5, "high": 15},
        {"key": "NPSHYD", "label": "Hydro", "low": 0, "high": 12},
        {"key": "BIOMASS", "label": "Biomass", "low": 50, "high": 90},
    ]
    lo, hi = thermal(gas, A["etaCcgtLow"], A["etaCcgtHigh"], A["efGas"], A["vom"])
    rows.append({"key": "CCGT", "label": "Gas (CCGT)", "low": lo, "high": hi})
    lo, hi = thermal(gas, A["etaOcgtLow"], A["etaOcgtHigh"], A["efGas"], A["vom"] + 4)
    rows.append({"key": "OCGT", "label": "Gas (OCGT)", "low": lo, "high": hi})
    if coal_price is not None:
        lo, hi = thermal(coal_price, A["etaCoalLow"], A["etaCoalHigh"],
                         A["efCoal"], A["vom"] + 2)
        rows.append({"key": "COAL", "label": "Coal", "low": lo, "high": hi})
    for r in rows:
        r["low"] = js_round(r["low"], 1)
        r["high"] = js_round(r["high"], 1)
    return sorted(rows, key=lambda r: r["low"] + r["high"])


def merit_curve_steps(rows, capacity_gw, tranche_gw=0.5):
    tranches = []
    for row in rows:
        cap = capacity_gw.get(row["key"])
        if cap is None or cap < 0.05:
            continue
        n = max(1, math.ceil(cap / tranche_gw))
        for i in range(n):
            tranches.append({
                "label": row["label"],
                "srmc": js_round(row["low"] + ((i + 0.5) / n)
                                 * (row["high"] - row["low"]), 2),
                "width": cap / n,
            })
    tranches.sort(key=lambda t: t["srmc"])  # stable, like modern JS sort
    cum = 0.0
    for t in tranches:
        t["x0"] = js_round(cum, 3)
        cum += t["width"]
        t["x1"] = js_round(cum, 3)
    return tranches


def compute(data_dir):
    """Full result dict for the dataset in `data_dir` — separated from
    main() so tests can call it directly (tests/test_merit_panel_figures.py
    checks parity against metrics.js outputs captured in the browser)."""
    data_dir = Path(data_dir)
    hh = json.loads((data_dir / "series_hh.json").read_text())
    daily = json.loads((data_dir / "series_daily.json").read_text())

    gas = latest(daily.get("gas_sap") or [])
    carbon = latest(daily.get("carbon_uka_month") or [])
    price = latest(hh["price"])
    demand = latest(hh["demand"])
    coal_proxy = latest(daily.get("coal_proxy_gbp_mwh") or [])
    n = len(hh["t"])
    net_imports_col = [sum((hh[k][i] or 0) for k in IC_KEYS if k in hh)
                       for i in range(n)]
    net = latest(net_imports_col)

    if gas is None or carbon is None or price is None or demand is None:
        return {"error": "missing input",
                "gas_sap": gas, "carbon_uka_month": carbon,
                "price": price, "demand": demand}

    rows = merit_ladder(gas, carbon, coal_proxy)
    cap = {k: (lambda q: None if q is None else q / 1000)
              (hh_quantile(hh.get(k) or [], 0.98)) for k in DISPATCHABLE}
    wind, solar = latest(hh.get("WIND") or []), latest(hh.get("solar") or [])
    cap["WIND"] = wind / 1000 if wind is not None else None
    cap["solar"] = solar / 1000 if solar is not None else None

    steps = merit_curve_steps(rows, cap)
    target_gw = (demand - (net or 0)) / 1000
    clearing = next((t for t in steps if target_gw <= t["x1"]), None)

    figures = {
        "observed_price_gbp_mwh": price,
        "implied_clearing_gbp_mwh": clearing["srmc"] if clearing else None,
        "marginal_technology": clearing["label"] if clearing else None,
        "gap_pct": js_round((price - clearing["srmc"]) / clearing["srmc"] * 100, 1)
                   if clearing else None,
    }
    return {
        "figures": figures,
        "inputs": {
            "gas_sap_gbp_mwh_th": gas, "carbon_uka_gbp_t": carbon,
            "demand_mw": demand, "net_imports_mw": net,
            "target_gw": js_round(target_gw, 2),
            "curve_top_gw": steps[-1]["x1"] if steps else None,
            "capacity_proxies_gw": {k: (js_round(v, 2) if v is not None else None)
                                    for k, v in cap.items()},
        },
        # The dashboard's documented reference assumptions (methodology.md /
        # state.js defaults). Injected so the agent quotes THESE — verbatim,
        # thermal basis — anywhere prose mentions an efficiency or carbon
        # intensity; the publisher rejects numbers outside this set.
        "reference_assumptions": {
            "spark_reference_ccgt": {"eta_hhv": 0.50,
                                     "ef_gas_tco2_per_mwh_thermal": 0.184,
                                     "vom_gbp_mwh": 3},
            "ccgt_fleet_eta_band": [A["etaCcgtLow"], A["etaCcgtHigh"]],
            "ocgt_eta_band": [A["etaOcgtLow"], A["etaOcgtHigh"]],
            "ocgt_vom_gbp_mwh": A["vom"] + 4,
            "dark_reference_coal": {"eta": 0.36,
                                    "eta_band": [A["etaCoalLow"], A["etaCoalHigh"]],
                                    "ef_coal_tco2_per_mwh_thermal": A["efCoal"],
                                    "vom_gbp_mwh": 5},
            "basis_note": "efficiencies are HHV; carbon intensities are per "
                          "MWh THERMAL — never quote a derived per-MWh-"
                          "electrical intensity as an assumption",
        },
    }


def main():
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "app/data"
    print(json.dumps(compute(data_dir), indent=1))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Precompute every statistic the overnight summary needs, so the LLM
writes analysis instead of re-deriving numbers through tool calls.

Measured motivation: the tool-driven agent run cost $1.20 API-equivalent
over 18 turns (12.5 min), and the dominant cost was the agent's own
Bash/Python statistical work — not the writing. This module moves all of
that into deterministic Python: overnight-vs-baseline stats and z-scores,
spread levels/percentiles/decomposition, per-cable flow facts, the merit
panel figures (via merit_panel_figures, unchanged — the publish guard
still cross-checks them) and data-quality flags.

Formulas mirror methodology.md exactly (spark: η 0.50 HHV, EF gas
0.184 tCO2/MWh th, VOM £3; dark: η 0.36, EF 0.34, VOM £5, coal proxy;
residual load = demand − transmission wind, solar deliberately not
subtracted). Stdlib only. CLI prints the facts JSON; compute_facts() is
importable (run_overnight_summary.py injects it into the agent prompt,
tests call it directly).
"""

import datetime
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merit_panel_figures import IC_KEYS, compute as merit_compute  # noqa: E402

OVERNIGHT_HH = 48          # 24 h analysis window
BASELINE_DAYS = 14

# methodology.md reference assumptions (spreads)
SPARK = {"eta": 0.50, "ef": 0.184, "vom": 3}
DARK = {"eta": 0.36, "ef": 0.34, "vom": 5}

METRIC_KEYS = ["price", "demand", "WIND", "solar", "netImports",
               "residual", "CCGT", "NUCLEAR"]


def iso(ts):
    return datetime.datetime.fromtimestamp(
        ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rnd(value, dp=2):
    return None if value is None else round(value, dp)


def stats(values, times):
    pairs = [(v, t) for v, t in zip(values, times) if v is not None]
    if not pairs:
        return None
    vs = [p[0] for p in pairs]
    lo = min(pairs, key=lambda p: p[0])
    hi = max(pairs, key=lambda p: p[0])
    # Below-zero counts give the narrative its intra-window colour
    # ("negative for eight consecutive half-hours") without shipping the
    # series itself — meaningful for price and net flows, harmlessly zero
    # elsewhere.
    below, longest, run = 0, 0, 0
    for v in vs:
        if v < 0:
            below += 1
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    return {"mean": rnd(sum(vs) / len(vs)),
            "min": rnd(lo[0]), "min_at": iso(lo[1]),
            "max": rnd(hi[0]), "max_at": iso(hi[1]),
            "below_zero_n": below,
            "below_zero_longest_consecutive": longest,
            "n": len(vs)}


def mean_std(values):
    vs = [v for v in values if v is not None]
    if len(vs) < 2:
        return None, None
    mean = sum(vs) / len(vs)
    var = sum((v - mean) ** 2 for v in vs) / (len(vs) - 1)
    return mean, math.sqrt(var)


def percentile_rank(history, latest):
    vs = sorted(v for v in history if v is not None)
    if not vs or latest is None:
        return None
    below = sum(1 for v in vs if v <= latest)
    return rnd(100 * below / len(vs), 1)


def spark_series(daily):
    out = []
    for p, g, c in zip(daily.get("price", []), daily.get("gas_sap", []),
                       daily.get("carbon_uka_month", [])):
        if None in (p, g, c):
            out.append(None)
        else:
            out.append(p - g / SPARK["eta"]
                       - (SPARK["ef"] / SPARK["eta"]) * c - SPARK["vom"])
    return out


def dark_series(daily):
    out = []
    for p, coal, c in zip(daily.get("price", []),
                          daily.get("coal_proxy_gbp_mwh", []),
                          daily.get("carbon_uka_month", [])):
        if None in (p, coal, c):
            out.append(None)
        else:
            out.append(p - coal / DARK["eta"]
                       - (DARK["ef"] / DARK["eta"]) * c - DARK["vom"])
    return out


def latest_non_null(series, dates):
    for i in range(len(series) - 1, -1, -1):
        if series[i] is not None:
            return i, dates[i], series[i]
    return None, None, None


def compute_facts(data_dir):
    data_dir = Path(data_dir)
    hh = json.loads((data_dir / "series_hh.json").read_text())
    daily = json.loads((data_dir / "series_daily.json").read_text())
    try:
        meta = json.loads((data_dir / "meta.json").read_text())
    except OSError:
        meta = {}

    t = hh["t"]
    n = len(t)
    cut = max(0, n - OVERNIGHT_HH)
    base_cut = max(0, cut - BASELINE_DAYS * 48)

    hh["netImports"] = [sum((hh[k][i] or 0) for k in IC_KEYS if k in hh)
                        for i in range(n)]
    hh["residual"] = [None if hh["demand"][i] is None
                      else hh["demand"][i] - (hh.get("WIND", [0] * n)[i] or 0)
                      for i in range(n)]

    metrics = {}
    for key in METRIC_KEYS:
        col = hh.get(key)
        if not col:
            continue
        overnight = stats(col[cut:], t[cut:])
        base_mean, base_std = mean_std(col[base_cut:cut])
        z = (rnd((overnight["mean"] - base_mean) / base_std)
             if overnight and base_mean is not None and base_std else None)
        metrics[key] = {
            "overnight": overnight,
            "baseline_14d": {"mean": rnd(base_mean), "std": rnd(base_std)},
            "z": z,
            "notable": z is not None and abs(z) > 2,
        }

    spark = spark_series(daily)
    dark = dark_series(daily)
    d = daily["d"]
    si, sd, sv = latest_non_null(spark, d)
    di, dd, dv = latest_non_null(dark, d)
    _, gd, gv = latest_non_null(daily.get("gas_sap", []), d)
    _, cd, cv = latest_non_null(daily.get("carbon_uka_month", []), d)
    spreads = {
        "clean_spark_gbp_mwh": {
            "latest": rnd(sv), "date": sd,
            "percentile_in_history_pct": percentile_rank(spark, sv),
            "value_7d_earlier": rnd(spark[si - 7]) if si is not None
                                and si >= 7 else None,
            "decomposition_at_reference": None if None in (gv, cv) else {
                "gas_cost": rnd(gv / SPARK["eta"]),
                "carbon_cost": rnd(SPARK["ef"] / SPARK["eta"] * cv),
                "vom": SPARK["vom"],
                "gas_sap_used": {"value": gv, "date": gd},
                "carbon_used": {"value": cv, "date": cd},
            },
        },
        "clean_dark_gbp_mwh": {
            "latest": rnd(dv), "date": dd,
            "percentile_in_history_pct": percentile_rank(dark, dv),
            "value_7d_earlier": rnd(dark[di - 7]) if di is not None
                                and di >= 7 else None,
        },
    }

    cables = {}
    for key in IC_KEYS:
        col = hh.get(key)
        if not col:
            continue
        o_mean, _ = mean_std(col[cut:])
        b_mean, _ = mean_std(col[base_cut:cut])
        if o_mean is None or b_mean is None:
            continue
        # Window extremes with timestamps let the narrative describe an
        # intra-window swing ("exported 1,072 MW overnight, importing
        # 1,426 MW by 15:00") — a mean alone hides the reversal's shape.
        extremes = stats(col[cut:], t[cut:]) or {}
        cables[key] = {
            "overnight_mean_mw": rnd(o_mean, 0),
            "baseline_mean_mw": rnd(b_mean, 0),
            "direction_flipped": (o_mean > 0) != (b_mean > 0)
                                 and abs(o_mean) > 50 and abs(b_mean) > 50,
            "window_min_mw": rnd(extremes.get("min"), 0),
            "window_min_at": extremes.get("min_at"),
            "window_max_mw": rnd(extremes.get("max"), 0),
            "window_max_at": extremes.get("max_at"),
        }
    dem_o = metrics.get("demand", {}).get("overnight") or {}
    net_o = metrics.get("netImports", {}).get("overnight") or {}
    dem_b = metrics.get("demand", {}).get("baseline_14d") or {}
    net_b = metrics.get("netImports", {}).get("baseline_14d") or {}
    flows = {
        "cables": cables,
        "import_dependency_pct": {
            "overnight": rnd(100 * net_o["mean"] / dem_o["mean"], 1)
                         if net_o.get("mean") is not None
                         and dem_o.get("mean") else None,
            "baseline_14d": rnd(100 * net_b["mean"] / dem_b["mean"], 1)
                            if net_b.get("mean") is not None
                            and dem_b.get("mean") else None,
        },
    }

    def ffill_days(flag_key):
        col = daily.get(flag_key)
        if not col:
            return 0
        recent = col[-2:]
        return sum(1 for v in recent if v)

    built_at = meta.get("built_at")
    build_age_h = None
    if built_at:
        try:
            built = datetime.datetime.fromisoformat(
                built_at.replace("Z", "+00:00"))
            build_age_h = rnd((datetime.datetime.now(datetime.timezone.utc)
                               - built).total_seconds() / 3600, 1)
        except ValueError:
            pass
    data_quality = {
        "carbon_ffill_recent_days": ffill_days("carbon_ffill"),
        "coal_ffill_recent_days": ffill_days("coal_ffill"),
        "overnight_nulls": {k: sum(1 for v in hh[k][cut:] if v is None)
                            for k in ("price", "demand", "solar")
                            if k in hh},
        "build_age_hours": build_age_h,
    }

    return {
        "window": {"from": iso(t[cut]), "to": iso(t[-1])},
        "baseline_days": BASELINE_DAYS,
        "metrics": metrics,
        "spreads": spreads,
        "flows": flows,
        "merit": merit_compute(data_dir),
        "data_quality_facts": data_quality,
    }


if __name__ == "__main__":
    print(json.dumps(
        compute_facts(sys.argv[1] if len(sys.argv) > 1 else "app/data"),
        indent=1))

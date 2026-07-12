"""
System-stress daily metrics + typed anomaly flags (plan/06 workstream B, #22)
=============================================================================
Writes three observed-data products under app/data/ (gitignored,
manifest-registered):

    stress_daily.json      per-day metrics + typed flags[]; append-only,
                           most recent 400 days kept (trailing-year
                           percentiles need a year of history)
    warnings.json          SYSWARN notices filtered to Electricity Margin
                           Notices + emergency instructions, verbatim,
                           with per-category counts for the stored window
    events/<date>/freq.json  15 s frequency slice for EVERY flagged day
                           (owner-revised D8, 2026-07-11: no type filter,
                           no recency cap — slices are lazy-fetched by the
                           app, so they never join the eager page payload)

Flag rules (plan/06 decisions D4/D5) — four typed families, union; each
day's flags[] records which fired, with the value and threshold used:

    FREQUENCY  seconds below 49.8 Hz >= max(trailing p99, 60 s floor)
    PRICE      daily max SSP        >= trailing p99
    EMN        >=1 EMN issued that day (publish-date attribution, UTC;
               cancellation notices are not issuances and do not count)
    ADEQUACY   daily max LoLP (1/8/12 h horizons) >= max(trailing p99, 0.01)

Trailing window = up to 365 days strictly before the day (point-in-time —
a day's own value never raises its own threshold). Percentile terms need
>= 90 days of history; with less, only EMN and the ADEQUACY floor can fire
(the absolute, regime-independent conditions). Flags are computed when a
day's data is written and persisted — they never change retroactively.

API traps carried from the verified Phase A investigation:
  * /datasets/FREQ silently ignores unknown parameter names and returns
    the latest ~5 h with HTTP 200 — the range assertion on returned
    timestamps is mandatory, and ~1 day per call is the practical limit.
  * SYSWARN warningText timestamps are UK local; publishTime is UTC.
    Bodies are stored verbatim and never parsed for times.
  * LoLP (/forecast/system/loss-of-load) is gap-free in <=4-day chunks
    (48 SP x 5 horizons = 240 rows/day; 230/250 on clock-change days).

Day granularity note: FREQ metrics are UTC days; SSP and LoLP rows carry
local settlement dates. At daily resolution the mismatch is at most the
23:00-24:00 BST hour and does not move any flag in practice; recorded in
the output meta rather than "fixed" with a false precision.

Usage:
    python etl/fetch_stress.py                 # daily incremental append
    python etl/fetch_stress.py --backfill 365  # one-off historical build
"""

import argparse
import hashlib
import json
import shutil
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PROJECT_DIR = Path(__file__).resolve().parents[1]
OUT_DIR = PROJECT_DIR / "app" / "data"
EVENTS_DIR = OUT_DIR / "events"
STRESS_PATH = OUT_DIR / "stress_daily.json"
WARNINGS_PATH = OUT_DIR / "warnings.json"

OPERATIONAL_LOW, OPERATIONAL_HIGH = 49.8, 50.2
STATUTORY_LOW = 49.5
SAMPLE_SECONDS = 15
SLOTS_PER_DAY = 86400 // SAMPLE_SECONDS  # 5760
# The FREQ feed carries occasional literal-0.0 Hz samples (instrument/feed
# artefacts — found on four days of the 2025-26 backfill, each of which
# would otherwise flag as a huge "excursion"). GB frequency has never left
# 48.8-50.5 in the modern record, so anything outside this generous band is
# a feed error and is treated as a gap, not a reading.
FREQ_PLAUSIBLE = (45.0, 55.0)

RETAIN_DAYS = 400
TRAILING_DAYS = 365
MIN_BASELINE_DAYS = 90
PCTL = 0.99
FREQ_FLOOR_SECS = 60
LOLP_FLOOR = 0.01
LOLP_HORIZONS = (1, 8, 12)

EMN_TYPE = "ELECTRICITY MARGIN NOTICE"


def _core():
    """The shared HTTP/cache layer, imported lazily so the pure flag logic
    below stays importable where certifi is absent (the CI test runner is
    stdlib-only)."""
    import build_dataset
    return build_dataset


# ---------------------------------------------------------------------------
# Pure logic (no I/O) — everything the unit tests exercise
# ---------------------------------------------------------------------------

def percentile(values, q):
    """Linear-interpolation percentile of an unsorted sequence; None if
    empty. Matches the method used in the plan/06 evidence analysis."""
    xs = sorted(values)
    if not xs:
        return None
    idx = (len(xs) - 1) * q
    lo = int(idx)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo)


def plausible_freq(value):
    return (value is not None
            and FREQ_PLAUSIBLE[0] <= value <= FREQ_PLAUSIBLE[1])


def freq_day_stats(rows):
    """Daily aggregates of 15 s frequency samples; None if no plausible
    samples. Implausible readings (see FREQ_PLAUSIBLE) count as gaps."""
    values = [r.get("frequency") for r in rows]
    freqs = [f for f in values if plausible_freq(f)]
    rejected = sum(1 for f in values if f is not None
                   and not plausible_freq(f))
    if not freqs:
        return None
    stats = {
        "freq_min": round(min(freqs), 3),
        "freq_max": round(max(freqs), 3),
        "freq_coverage_pct": round(len(freqs) / SLOTS_PER_DAY * 100, 1),
        "secs_below_49p8": sum(SAMPLE_SECONDS for f in freqs
                               if f < OPERATIONAL_LOW),
        "secs_above_50p2": sum(SAMPLE_SECONDS for f in freqs
                               if f > OPERATIONAL_HIGH),
        "secs_below_49p5": sum(SAMPLE_SECONDS for f in freqs
                               if f < STATUTORY_LOW),
    }
    if rejected:
        stats["freq_rejected_samples"] = rejected
    return stats


def is_emn_issue(warning):
    """An EMN *issuance*: cancellation notices share the warningType but
    withdraw a warning rather than raise one, so they do not count."""
    if warning.get("warningType") != EMN_TYPE:
        return False
    return "CANCELLATION" not in (warning.get("warningText") or "").upper()


def lolp_max_of(entry):
    vals = [entry.get(f"lolp_max_{h}h") for h in LOLP_HORIZONS]
    vals = [v for v in vals if v is not None]
    return max(vals) if vals else None


def drm_min_of(entry):
    vals = [entry.get(f"drm_min_{h}h") for h in LOLP_HORIZONS]
    vals = [v for v in vals if v is not None]
    return min(vals) if vals else None


def percentile_rank(values, v):
    """Midrank percentile (0-100) of v within values; None if empty.
    Ties count half — so a value equal to the whole baseline sits at 50."""
    xs = [x for x in values if x is not None]
    if not xs:
        return None
    below = sum(1 for x in xs if x < v)
    equal = sum(1 for x in xs if x == v)
    return 100.0 * (below + 0.5 * equal) / len(xs)


# Context-annotation bands (display only, plan/06 review addition
# 2026-07-11). Ranks are STRESS-ORIENTED: higher percentile = more
# stressed, so DRM's rank is inverted (p = share of trailing days that
# had MORE margin). Same cut points across metrics; DRM gets margin
# vocabulary.
STRESS_BANDS = ((99.0, "extreme"), (95.0, "very high"), (90.0, "high"),
                (50.0, "regular"))
TIGHT_BANDS = ((99.0, "extreme"), (95.0, "very tight"), (90.0, "tight"),
               (50.0, "regular"))


def stress_band(stress_rank, tight=False):
    for cut, label in (TIGHT_BANDS if tight else STRESS_BANDS):
        if stress_rank >= cut:
            return label
    return "loose" if tight else "low"


CONTEXT_METRICS = (
    ("ssp_max", lambda e: e.get("ssp_max"), False),
    ("lolp_max", lolp_max_of, False),
    ("drm_min", drm_min_of, True),
)


def compute_day_context(day_key, days):
    """Percentile-context annotations for the day's max SSP, max LoLP and
    min DRM, ranked against the SAME point-in-time trailing window the
    flags use (the day's own value never joins its own baseline; <90 days
    of history → "insufficient history", never a fabricated rank).
    Display-only: flags and thresholds are untouched."""
    d0 = date.fromisoformat(day_key)
    lo = str(d0 - timedelta(days=TRAILING_DAYS))
    trail = [days[k] for k in days if lo <= k < day_key]
    entry = days[day_key]
    out = {}
    for key, metric, tight in CONTEXT_METRICS:
        value = metric(entry)
        if value is None:
            continue
        base = [b for b in (metric(t) for t in trail) if b is not None]
        if len(base) < MIN_BASELINE_DAYS:
            out[key] = {"p": None, "band": "insufficient history"}
            continue
        rank = percentile_rank(base, value)
        stress_rank = 100.0 - rank if tight else rank
        out[key] = {"p": round(stress_rank, 1),
                    "band": stress_band(stress_rank, tight)}
    return out


def compute_day_flags(day_key, days):
    """Typed flags for one day, judged against its point-in-time trailing
    window (up to TRAILING_DAYS strictly before it, as present in `days`).
    Returns a list of {type, value, threshold} dicts."""
    d0 = date.fromisoformat(day_key)
    lo = str(d0 - timedelta(days=TRAILING_DAYS))
    trail = [days[k] for k in days if lo <= k < day_key]
    entry = days[day_key]
    flags = []

    def baseline(metric_fn):
        vals = [metric_fn(t) for t in trail]
        return [v for v in vals if v is not None]

    # FREQUENCY — excursion seconds vs max(trailing p99, 60 s floor)
    value = entry.get("secs_below_49p8")
    if value is not None:
        base = baseline(lambda t: t.get("secs_below_49p8"))
        if len(base) >= MIN_BASELINE_DAYS:
            threshold = max(percentile(base, PCTL), FREQ_FLOOR_SECS)
            if value >= threshold:
                flags.append({"type": "frequency", "value": value,
                              "threshold": round(threshold, 1)})

    # PRICE — daily max SSP vs trailing p99 (no floor)
    value = entry.get("ssp_max")
    if value is not None:
        base = baseline(lambda t: t.get("ssp_max"))
        if len(base) >= MIN_BASELINE_DAYS:
            threshold = percentile(base, PCTL)
            if value >= threshold:
                flags.append({"type": "price", "value": round(value, 2),
                              "threshold": round(threshold, 2)})

    # EMN — an issuance that day is an observed fact, no baseline needed
    if entry.get("emn_count", 0) >= 1:
        flags.append({"type": "emn", "value": entry["emn_count"],
                      "threshold": 1})

    # ADEQUACY — max LoLP across horizons vs max(trailing p99, 0.01 floor);
    # the absolute floor applies from day one (regime-independent).
    value = lolp_max_of(entry)
    if value is not None:
        base = baseline(lolp_max_of)
        if len(base) >= MIN_BASELINE_DAYS:
            threshold = max(percentile(base, PCTL), LOLP_FLOOR)
        else:
            threshold = LOLP_FLOOR
        if value >= threshold:
            flags.append({"type": "adequacy", "value": round(value, 5),
                          "threshold": round(threshold, 5)})

    return flags


def qualifying_event_days(days):
    """Days that earn a 15 s frequency slice: every flagged day, any flag
    type, oldest first (plan/06 D8 as owner-revised 2026-07-11 — slices
    are lazy-fetched, so completeness costs disk, not page load)."""
    return sorted(k for k, e in days.items() if e.get("flags"))


# ---------------------------------------------------------------------------
# Fetchers (verified in Phase A; see module docstring for the traps)
# ---------------------------------------------------------------------------

class RangeViolation(RuntimeError):
    """FREQ returned data outside the requested day — the silent-parameter
    trap. The response must be discarded, never stored."""


def _rows(payload):
    if isinstance(payload, list):
        return payload
    return payload.get("data", [])


def fetch_freq_day(day):
    core = _core()
    url = (f"{core.ELEXON}/datasets/FREQ"
           f"?measurementDateTimeFrom={day}T00:00:00Z"
           f"&measurementDateTimeTo={day}T23:59:45Z&format=json")
    rows = _rows(json.loads(core.http(url)))
    if rows:
        times = sorted(r["measurementTime"] for r in rows)
        if not (times[0][:10] == str(day) and times[-1][:10] == str(day)):
            raise RangeViolation(
                f"FREQ asked {day}, got {times[0]}..{times[-1]}")
    return rows


def fetch_lolp_days(start, end):
    """LoLP/DRM rows for [start, end], grouped by UTC start date. Fetched
    in 4-day chunks (integrity verified at that size in Phase A)."""
    core = _core()
    by_day = {}
    for lo, hi in core.day_chunks(start, end, 4):
        url = (f"{core.ELEXON}/forecast/system/loss-of-load"
               f"?from={lo}T00:00:00Z&to={hi}T23:59:59Z&format=json")
        for r in _rows(json.loads(core.http(url))):
            key = (r.get("startTime") or "")[:10]
            if key:
                by_day.setdefault(key, []).append(r)
    return by_day


def fetch_prices_day(day):
    core = _core()
    url = f"{core.ELEXON}/balancing/settlement/system-prices/{day}?format=json"
    return _rows(json.loads(core.http(url)))


def fetch_syswarn(start, end):
    """SYSWARN notices published in [start, end], fetched month-by-month
    to bound response sizes."""
    core = _core()
    warnings = []
    cursor = start
    while cursor <= end:
        month_end = min((cursor.replace(day=28) + timedelta(days=4))
                        .replace(day=1) - timedelta(days=1), end)
        url = (f"{core.ELEXON}/datasets/SYSWARN"
               f"?publishDateTimeFrom={cursor}T00:00:00Z"
               f"&publishDateTimeTo={month_end}T23:59:59Z&format=json")
        warnings.extend(_rows(json.loads(core.http(url))))
        cursor = month_end + timedelta(days=1)
    return warnings


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def day_metrics(freq_rows, lolp_rows, price_rows):
    """One day's metrics dict from raw rows (any source may be absent)."""
    entry = {}
    if freq_rows:
        stats = freq_day_stats(freq_rows)
        if stats:
            entry.update(stats)
    for horizon in LOLP_HORIZONS:
        sub = [r for r in (lolp_rows or [])
               if r.get("forecastHorizon") == horizon]
        lolps = [r["lossOfLoadProbability"] for r in sub
                 if r.get("lossOfLoadProbability") is not None]
        drms = [r["deratedMargin"] for r in sub
                if r.get("deratedMargin") is not None]
        if lolps:
            entry[f"lolp_max_{horizon}h"] = round(max(lolps), 5)
        if drms:
            entry[f"drm_min_{horizon}h"] = round(min(drms))
    prices = [r["systemSellPrice"] for r in (price_rows or [])
              if r.get("systemSellPrice") is not None]
    if prices:
        entry["ssp_max"] = round(max(prices), 2)
        entry["ssp_min"] = round(min(prices), 2)
        entry["ssp_max_sp"] = max(
            (r for r in price_rows if r.get("systemSellPrice") is not None),
            key=lambda r: r["systemSellPrice"])["settlementPeriod"]
    return entry


def load_stress():
    try:
        payload = json.loads(STRESS_PATH.read_text())
        return payload.get("days", {})
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def load_warnings_payload():
    try:
        return json.loads(WARNINGS_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def write_event_slice(day_key):
    """Grid-aligned 15 s frequency slice for one UTC day: hz[i] is the
    sample at 00:00:00Z + i*15 s, null where the feed has a gap."""
    core = _core()
    rows = fetch_freq_day(date.fromisoformat(day_key))
    day_start = datetime.fromisoformat(day_key).replace(tzinfo=timezone.utc)
    t0 = int(day_start.timestamp())
    hz = [None] * SLOTS_PER_DAY
    for r in rows:
        if not plausible_freq(r.get("frequency")):
            continue  # feed artefacts (e.g. literal 0.0 Hz) stay gaps
        slot = round((core.to_epoch(r["measurementTime"]) - t0)
                     / SAMPLE_SECONDS)
        if 0 <= slot < SLOTS_PER_DAY:
            hz[slot] = r["frequency"]
    target_dir = EVENTS_DIR / day_key
    target_dir.mkdir(parents=True, exist_ok=True)
    obj = {
        "date": day_key,
        "start_utc": day_start.isoformat(timespec="seconds"),
        "step_seconds": SAMPLE_SECONDS,
        "source": "Elexon Insights /datasets/FREQ — 15 s system frequency "
                  "(observed); null = feed gap",
        "hz": hz,
    }
    core._atomic_write(target_dir / "freq.json",
                       json.dumps(obj, separators=(",", ":")))


def prune_event_slices(keep):
    """Remove event directories beyond the retained set. Conservative:
    only date-named dirs directly under events/, only their freq.json."""
    if not EVENTS_DIR.exists():
        return []
    removed = []
    for child in EVENTS_DIR.iterdir():
        if not child.is_dir():
            continue
        try:
            date.fromisoformat(child.name)
        except ValueError:
            continue
        if child.name not in keep:
            (child / "freq.json").unlink(missing_ok=True)
            shutil.rmtree(child, ignore_errors=True)
            removed.append(child.name)
    return removed


def update_manifest(event_days, removed_event_days):
    """Register outputs for cache-busting, same pattern as the BMU
    snapshot (plan/05)."""
    core = _core()
    manifest_path = OUT_DIR / "manifest.json"
    if not manifest_path.exists():
        return
    manifest = json.loads(manifest_path.read_text())
    files = manifest.setdefault("files", {})
    for name in ("stress_daily.json", "warnings.json"):
        blob = (OUT_DIR / name).read_bytes()
        files[name] = {"sha256": hashlib.sha256(blob).hexdigest(),
                       "bytes": len(blob)}
    for day_key in event_days:
        rel = f"events/{day_key}/freq.json"
        blob = (OUT_DIR / rel).read_bytes()
        files[rel] = {"sha256": hashlib.sha256(blob).hexdigest(),
                      "bytes": len(blob)}
    for day_key in removed_event_days:
        files.pop(f"events/{day_key}/freq.json", None)
    manifest["version"] += 1
    core._atomic_write(manifest_path, json.dumps(manifest, indent=2))


RULES_META = {
    "frequency": {"metric": "secs_below_49p8",
                  "rule": "value >= max(trailing p99, 60 s floor)"},
    "price": {"metric": "ssp_max", "rule": "value >= trailing p99"},
    "emn": {"metric": "emn_count",
            "rule": ">=1 EMN issued (publish-date attribution, UTC; "
                    "cancellation notices excluded)"},
    "adequacy": {"metric": "max lolp over 1/8/12 h horizons",
                 "rule": "value >= max(trailing p99, 0.01 floor)"},
    "trailing_days": TRAILING_DAYS,
    "min_baseline_days": MIN_BASELINE_DAYS,
    "percentile": PCTL,
    "cold_start": "with under 90 days of trailing history only the EMN "
                  "flag and the ADEQUACY absolute floor can fire",
    "context_percentiles": "per-day pctl {ssp_max, lolp_max, drm_min}: "
                           "display-only midrank percentile vs the same "
                           "point-in-time trailing window, stress-oriented "
                           "(DRM inverted: p = share of trailing days with "
                           "more margin); <90 d history -> 'insufficient "
                           "history'; flags and thresholds unaffected",
}


def build(backfill_days=None):
    core = _core()
    yesterday = date.today() - timedelta(days=1)
    days = load_stress()

    if backfill_days:
        start = yesterday - timedelta(days=backfill_days - 1)
        core.USE_CACHE = True          # one-off: resumable via disk cache
        mode = f"backfill {backfill_days}d"
    else:
        core.USE_CACHE = False         # small daily fetch, always fresh
        if days:
            # Re-fetch the most recent stored day defensively (it may have
            # been fetched before all of its data had been published).
            start = date.fromisoformat(max(days))
        else:
            start = yesterday
        mode = "incremental"
    if start > yesterday:
        print("Nothing to fetch — dataset already ends at yesterday")
        return
    print(f"stress pipeline [{mode}]: {start} -> {yesterday}")

    target = [start + timedelta(days=i)
              for i in range((yesterday - start).days + 1)]

    # SYSWARN first: EMN counts feed the per-day metrics. Rebuild notices
    # over the whole retained window on backfill; merge the tail otherwise.
    oldest_retained = yesterday - timedelta(days=RETAIN_DAYS - 1)
    prev_warnings = load_warnings_payload()
    if backfill_days:
        notices = fetch_syswarn(min(start, oldest_retained), yesterday)
        # Full-inventory counts are a snapshot of this backfill's window;
        # incremental runs preserve it rather than mixing windows.
        syswarn_counts = {
            "window": {"from": str(min(start, oldest_retained)),
                       "to": str(yesterday)},
            "by_type": {},
            "note": "all SYSWARN categories over the window of the last "
                    "full backfill; the stored notices are the EMN + "
                    "emergency-instruction subset only",
        }
        for n in notices:
            wtype = n.get("warningType") or "?"
            syswarn_counts["by_type"][wtype] = \
                syswarn_counts["by_type"].get(wtype, 0) + 1
    else:
        notices = prev_warnings.get("notices", [])
        seen = {(n.get("publishTime"), n.get("warningType"))
                for n in notices}
        fresh = fetch_syswarn(start - timedelta(days=1), yesterday)
        notices += [n for n in fresh
                    if (n.get("publishTime"), n.get("warningType"))
                    not in seen]
        syswarn_counts = (prev_warnings.get("meta") or {}) \
            .get("syswarn_counts")
    notices = [n for n in notices
               if (n.get("publishTime") or "")[:10] >= str(oldest_retained)]
    notices.sort(key=lambda n: n.get("publishTime") or "")
    emn_by_day = {}
    for n in notices:
        if is_emn_issue(n):
            key = (n.get("publishTime") or "")[:10]
            emn_by_day[key] = emn_by_day.get(key, 0) + 1

    print(f"  SYSWARN: {len(notices)} notices retained, "
          f"{sum(emn_by_day.values())} EMN issuances")

    lolp_by_day = fetch_lolp_days(start, yesterday)
    print(f"  LoLP: {len(lolp_by_day)} days with rows")

    freq_failures = []
    for i, day in enumerate(target):
        key = str(day)
        try:
            freq_rows = fetch_freq_day(day)
        except (RangeViolation, RuntimeError) as error:
            freq_failures.append(key)
            print(f"  {key}: FREQ unavailable ({error}) — day stored "
                  "without frequency metrics")
            freq_rows = []
        try:
            price_rows = fetch_prices_day(day)
        except RuntimeError as error:
            print(f"  {key}: prices unavailable ({error})")
            price_rows = []
        entry = day_metrics(freq_rows, lolp_by_day.get(key), price_rows)
        if key in emn_by_day:
            entry["emn_count"] = emn_by_day[key]
        days[key] = entry
        if (i + 1) % 25 == 0 or day == yesterday:
            print(f"  fetched {i + 1}/{len(target)} days", flush=True)

    # Retention trim, then flags for the days written this run — computed
    # point-in-time and persisted (never recomputed retroactively).
    for key in sorted(days)[:-RETAIN_DAYS] if len(days) > RETAIN_DAYS else []:
        del days[key]
    for day in target:
        key = str(day)
        if key in days:
            days[key]["flags"] = compute_day_flags(key, days)
            days[key]["pctl"] = compute_day_context(key, days)
    # One-off migration: days written before the context annotation
    # existed get theirs computed now from the stored history (identical
    # to what a backfill would have produced — same point-in-time window).
    migrated = [k for k in days if "pctl" not in days[k]]
    for key in migrated:
        days[key]["pctl"] = compute_day_context(key, days)
    if migrated:
        print(f"  context percentiles backfilled for {len(migrated)} days")
    flagged = {k: [f["type"] for f in e["flags"]]
               for k, e in days.items() if e.get("flags")}
    print(f"  flags: {len(flagged)} flagged days in window")

    window = {"from": min(days), "to": max(days)} if days else None
    built_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    event_days = qualifying_event_days(days)
    stress_payload = {
        "meta": {
            "built_at": built_at,
            "window": window,
            "event_days": event_days,
            "retention_days": RETAIN_DAYS,
            "quality": "observed metrics; flags derived from observed via "
                       "the deterministic rules below",
            "rules": RULES_META,
            "sources": {
                "frequency": "Elexon /datasets/FREQ (15 s samples, UTC days)",
                "lolp_drm": "Elexon /forecast/system/loss-of-load "
                            "(1/8/12 h horizons)",
                "ssp": "Elexon /balancing/settlement/system-prices "
                       "(local settlement days)",
                "emn": "Elexon /datasets/SYSWARN (publish-date attribution)",
            },
            "notes": [
                "FREQ requests carry a mandatory returned-range assertion "
                "(the endpoint silently ignores unknown parameters).",
                "SYSWARN body timestamps are UK local and are never parsed; "
                "only the UTC publishTime is used.",
                "Daily granularity mixes UTC days (FREQ) with local "
                "settlement days (SSP/LoLP); the mismatch is at most the "
                "23:00-24:00 BST hour.",
            ],
            "freq_gap_days": freq_failures or [],
        },
        "days": {k: days[k] for k in sorted(days)},
    }
    core._atomic_write(STRESS_PATH, json.dumps(stress_payload))

    kept = [n for n in notices
            if n.get("warningType") == EMN_TYPE
            or (n.get("warningType") == "OTHER"
                and "EMERGENCY" in (n.get("warningText") or "").upper())]
    warnings_payload = {
        "meta": {
            "built_at": built_at,
            "window": {"from": str(oldest_retained), "to": str(yesterday)},
            "quality": "observed (verbatim NESO system warnings)",
            "note": "warningText timestamps are UK local time; publishTime "
                    "is UTC. Bodies are stored verbatim, not parsed.",
            "syswarn_counts": syswarn_counts,
        },
        # Raw Elexon field names are kept so the stored notices round-trip
        # through the incremental merge above (renaming them broke the
        # merge on first contact — the loaded notices failed every filter).
        "notices": [{
            "publishTime": n.get("publishTime"),
            "warningType": n.get("warningType"),
            "kind": (("cancellation" if not is_emn_issue(n) else "issue")
                     if n.get("warningType") == EMN_TYPE else None),
            "warningText": n.get("warningText"),
        } for n in kept],
    }
    core._atomic_write(WARNINGS_PATH, json.dumps(warnings_payload))

    for key in event_days:
        if not (EVENTS_DIR / key / "freq.json").exists():
            print(f"  event slice: {key}")
            try:
                write_event_slice(key)
            except (RangeViolation, RuntimeError) as error:
                print(f"  event slice {key} FAILED: {error}")
    removed = prune_event_slices(set(event_days))

    update_manifest([k for k in event_days
                     if (EVENTS_DIR / k / "freq.json").exists()], removed)

    sizes = {p.name: p.stat().st_size
             for p in (STRESS_PATH, WARNINGS_PATH)}
    eager = sum(sizes.values())
    event_bytes = sum(f.stat().st_size
                      for f in EVENTS_DIR.glob("*/freq.json")) \
        if EVENTS_DIR.exists() else 0
    print(f"Wrote stress_daily.json ({sizes['stress_daily.json']/1024:.0f} kB, "
          f"{len(days)} days), warnings.json "
          f"({sizes['warnings.json']/1024:.0f} kB, {len(kept)} notices) — "
          f"eager payload {eager/1024:.0f} kB (budget 512 kB); "
          f"{len(event_days)} lazy event slices ({event_bytes/1024:.0f} kB "
          "on disk, fetched per view)")
    if flagged:
        print("  flagged days:")
        for k in sorted(flagged):
            print(f"    {k}: {', '.join(flagged[k])}")


if __name__ == "__main__":
    cli = argparse.ArgumentParser(
        description="Daily system-stress metrics + anomaly flags (plan/06)")
    cli.add_argument("--backfill", type=int, default=None, metavar="DAYS",
                     help="one-off historical build over the last N days")
    args = cli.parse_args()
    build(backfill_days=args.backfill)

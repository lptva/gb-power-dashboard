"""Flag-rule checks for etl/fetch_stress.py — the typed anomaly flags of
plan/06 workstream B (issue #22).

The five evidence dates from the design doc are reproduced as fixtures.
Baselines are constant series, so every threshold is exact by hand: the
p99 of a constant equals the constant, and mixed baselines are chosen so
the interpolated p99 lands on a value readable straight off the fixture.

Expectations (plan/06, verified against live data 2026-07-11):
    2026-06-23  frequency + price + emn   (delivery-driven; adequacy quiet)
    2026-01-08  adequacy only             (margin squeeze: no EMN, zero
                                           excursions, unremarkable SSP)
    2025-01-08  all four                  (true near-miss; two EMN
                                           issuances were published on the
                                           day itself, plus one the evening
                                           before and a cancellation)
    2026-01-05  price only
    2025-11-21  no flags                  (tightest-DRM day: DRM is stored
                                           context, not a trigger, and LoLP
                                           0.0075 sits below the 0.01 floor)

No file or network access — the flag engine is imported without touching
the HTTP layer (build_dataset stays unimported, so the suite runs on the
stdlib-only CI worker).
"""

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "etl"))

from fetch_stress import (  # noqa: E402
    FREQ_FLOOR_SECS,
    LOLP_FLOOR,
    compute_day_context,
    compute_day_flags,
    freq_day_stats,
    is_emn_issue,
    percentile,
    percentile_rank,
    qualifying_event_days,
    stress_band,
)


def baseline_days(day_iso, n, ssp=100.0, secs=0, lolp=0.0):
    """n consecutive baseline days ending the day before `day_iso`, all
    carrying the same values — so every trailing p99 equals the constant."""
    d0 = date.fromisoformat(day_iso)
    days = {}
    for i in range(n, 0, -1):
        days[str(d0 - timedelta(days=i))] = {
            "ssp_max": ssp,
            "secs_below_49p8": secs,
            "lolp_max_8h": lolp,
        }
    return days


def flag_types(flags):
    return sorted(f["type"] for f in flags)


class EvidenceDates(unittest.TestCase):
    """One test per design-doc evidence date."""

    def test_2026_06_23_delivery_event(self):
        # Quiet year behind it: p99(secs)=0 -> threshold is the 60 s floor;
        # p99(ssp)=100; adequacy threshold is the 0.01 floor.
        days = baseline_days("2026-06-23", 120, ssp=100.0, secs=0, lolp=0.0)
        days["2026-06-23"] = {"secs_below_49p8": 2895, "ssp_max": 800.0,
                              "lolp_max_8h": 0.0017, "emn_count": 1}
        flags = compute_day_flags("2026-06-23", days)
        self.assertEqual(flag_types(flags), ["emn", "frequency", "price"])
        by_type = {f["type"]: f for f in flags}
        self.assertEqual(by_type["frequency"]["threshold"], FREQ_FLOOR_SECS)
        self.assertEqual(by_type["price"]["threshold"], 100.0)

    def test_2026_01_08_adequacy_only(self):
        # SSP baseline 450 keeps the £435 day sub-threshold; LoLP 0.036
        # clears the absolute floor with a near-zero baseline.
        days = baseline_days("2026-01-08", 120, ssp=450.0, secs=0, lolp=0.0)
        days["2026-01-08"] = {"secs_below_49p8": 0, "ssp_max": 435.0,
                              "lolp_max_8h": 0.036}
        flags = compute_day_flags("2026-01-08", days)
        self.assertEqual(flag_types(flags), ["adequacy"])
        self.assertEqual(flags[0]["threshold"], LOLP_FLOOR)
        self.assertEqual(flags[0]["value"], 0.036)

    def test_2025_01_08_near_miss_fires_all_four(self):
        # Winter-ish baseline: excursions 300 s and SSP £480 are routine,
        # LoLP 0.002 is normal — the near-miss clears everything.
        days = baseline_days("2025-01-08", 100, ssp=480.0, secs=300,
                             lolp=0.002)
        days["2025-01-08"] = {"secs_below_49p8": 615, "ssp_max": 2900.0,
                              "lolp_max_8h": 0.294, "emn_count": 2}
        flags = compute_day_flags("2025-01-08", days)
        self.assertEqual(flag_types(flags),
                         ["adequacy", "emn", "frequency", "price"])
        by_type = {f["type"]: f for f in flags}
        self.assertEqual(by_type["frequency"]["threshold"], 300)
        self.assertEqual(by_type["price"]["threshold"], 480.0)
        # p99(lolp)=0.002 < floor -> the floor is the operative threshold
        self.assertEqual(by_type["adequacy"]["threshold"], LOLP_FLOOR)
        self.assertEqual(by_type["emn"]["value"], 2)

    def test_2026_01_05_price_only(self):
        # 225 s of excursions is below a 300 s-routine baseline; £750 is not.
        days = baseline_days("2026-01-05", 100, ssp=470.0, secs=300,
                             lolp=0.0)
        days["2026-01-05"] = {"secs_below_49p8": 225, "ssp_max": 750.0,
                              "lolp_max_8h": 0.0025}
        flags = compute_day_flags("2026-01-05", days)
        self.assertEqual(flag_types(flags), ["price"])

    def test_2025_11_21_tight_drm_no_flags(self):
        # DRM is context, not a trigger; LoLP 0.0075 < 0.01 floor; SSP
        # unremarkable; no frequency metrics stored for the day at all.
        days = baseline_days("2025-11-21", 100, ssp=470.0, secs=0, lolp=0.0)
        days["2025-11-21"] = {"ssp_max": 247.0, "lolp_max_8h": 0.0075,
                              "drm_min_1h": 2979}
        self.assertEqual(compute_day_flags("2025-11-21", days), [])


class RuleMechanics(unittest.TestCase):

    def test_cold_start_only_absolute_conditions_fire(self):
        # 30 days of history is under MIN_BASELINE_DAYS: the percentile
        # families stay silent no matter how extreme the day; EMN and the
        # adequacy floor still work (regime-independent by design).
        days = baseline_days("2026-07-01", 30, ssp=100.0, secs=0, lolp=0.0)
        days["2026-07-01"] = {"secs_below_49p8": 5000, "ssp_max": 3000.0,
                              "lolp_max_8h": 0.5, "emn_count": 1}
        flags = compute_day_flags("2026-07-01", days)
        self.assertEqual(flag_types(flags), ["adequacy", "emn"])
        by_type = {f["type"]: f for f in flags}
        self.assertEqual(by_type["adequacy"]["threshold"], LOLP_FLOOR)

    def test_frequency_floor_guards_degenerate_percentile(self):
        # All-zero excursion history -> p99 = 0 -> the 60 s floor decides.
        days = baseline_days("2026-07-01", 120, secs=0)
        days["2026-07-01"] = {"secs_below_49p8": 45}
        self.assertEqual(compute_day_flags("2026-07-01", days), [])
        days["2026-07-01"] = {"secs_below_49p8": 75}
        flags = compute_day_flags("2026-07-01", days)
        self.assertEqual(flag_types(flags), ["frequency"])
        self.assertEqual(flags[0]["threshold"], FREQ_FLOOR_SECS)

    def test_trailing_window_excludes_the_day_itself(self):
        # The day's own extreme must not raise its own threshold.
        days = baseline_days("2026-07-01", 120, ssp=100.0)
        days["2026-07-01"] = {"ssp_max": 800.0}
        flags = compute_day_flags("2026-07-01", days)
        self.assertEqual(flag_types(flags), ["price"])
        self.assertEqual(flags[0]["threshold"], 100.0)

    def test_missing_metrics_skip_their_rules(self):
        days = baseline_days("2026-07-01", 120)
        days["2026-07-01"] = {}  # nothing published for the day
        self.assertEqual(compute_day_flags("2026-07-01", days), [])

    def test_adequacy_uses_max_across_horizons(self):
        days = baseline_days("2026-07-01", 120, lolp=0.0)
        days["2026-07-01"] = {"lolp_max_1h": 0.002, "lolp_max_8h": 0.04,
                              "lolp_max_12h": 0.0}
        flags = compute_day_flags("2026-07-01", days)
        self.assertEqual(flag_types(flags), ["adequacy"])
        self.assertEqual(flags[0]["value"], 0.04)


class Percentile(unittest.TestCase):

    def test_empty_and_single(self):
        self.assertIsNone(percentile([], 0.99))
        self.assertEqual(percentile([7.0], 0.99), 7.0)

    def test_interpolation(self):
        # (len-1)*q = 0.99 -> 0 + 0.99*(10-0) = 9.9
        self.assertAlmostEqual(percentile([0.0, 10.0], 0.99), 9.9)

    def test_p99_ignores_a_single_outlier(self):
        # 98x100 + 2x480: index (99)*0.99 = 98.01 lands inside the 480s.
        values = [100.0] * 98 + [480.0, 480.0]
        self.assertEqual(percentile(values, 0.99), 480.0)


class FreqDayStats(unittest.TestCase):

    def test_hand_counted_sample(self):
        rows = [
            {"measurementTime": "t1", "frequency": 49.79},   # below 49.8
            {"measurementTime": "t2", "frequency": 49.40},   # below both
            {"measurementTime": "t3", "frequency": 50.25},   # above 50.2
            {"measurementTime": "t4", "frequency": 50.00},
        ]
        stats = freq_day_stats(rows)
        self.assertEqual(stats["secs_below_49p8"], 30)   # 2 samples x 15 s
        self.assertEqual(stats["secs_below_49p5"], 15)
        self.assertEqual(stats["secs_above_50p2"], 15)
        self.assertEqual(stats["freq_min"], 49.4)
        self.assertEqual(stats["freq_max"], 50.25)

    def test_empty_rows(self):
        self.assertIsNone(freq_day_stats([]))
        self.assertIsNone(freq_day_stats([{"frequency": None}]))

    def test_feed_artefacts_are_gaps_not_excursions(self):
        # Literal 0.0 Hz samples (seen on four days of the 2025-26
        # backfill) are instrument garbage: without the plausibility band
        # each would count as 15 s below BOTH thresholds and freq_min
        # would read 0.000. They must count as gaps instead.
        rows = [
            {"measurementTime": "t1", "frequency": 0.0},     # artefact
            {"measurementTime": "t2", "frequency": 0.0},     # artefact
            {"measurementTime": "t3", "frequency": 49.75},   # real excursion
            {"measurementTime": "t4", "frequency": 50.01},
        ]
        stats = freq_day_stats(rows)
        self.assertEqual(stats["secs_below_49p8"], 15)
        self.assertEqual(stats["secs_below_49p5"], 0)
        self.assertEqual(stats["freq_min"], 49.75)
        self.assertEqual(stats["freq_rejected_samples"], 2)
        # A day of nothing but artefacts has no usable samples at all.
        self.assertIsNone(freq_day_stats([{"frequency": 0.0}] * 10))


class EmnClassification(unittest.TestCase):

    def test_issue_counts_cancellation_does_not(self):
        issue = {"warningType": "ELECTRICITY MARGIN NOTICE",
                 "warningText": "An ELECTRICITY MARGIN NOTICE is issued..."}
        cancel = {"warningType": "ELECTRICITY MARGIN NOTICE",
                  "warningText": "NOTIFICATION CANCELLATION of GB "
                                 "TRANSMISSION SYSTEM WARNING ..."}
        other = {"warningType": "OTHER",
                 "warningText": "EMERGENCY INSTRUCTION issued to BritNed"}
        self.assertTrue(is_emn_issue(issue))
        self.assertFalse(is_emn_issue(cancel))
        self.assertFalse(is_emn_issue(other))


class PercentileContext(unittest.TestCase):
    """Display-only tooltip annotations — same point-in-time window as the
    flags, stress-oriented ranks (DRM inverted), never a fabricated rank."""

    def test_midrank_ties(self):
        self.assertIsNone(percentile_rank([], 5))
        # value equal to the entire baseline sits at the middle
        self.assertEqual(percentile_rank([0.0] * 120, 0.0), 50.0)
        # 3 below + 1 equal of 5: (3 + 0.5) / 5 = 70
        self.assertEqual(percentile_rank([1, 2, 3, 5, 9], 5), 70.0)

    def test_band_boundaries_and_vocabulary(self):
        self.assertEqual(stress_band(99.0), "extreme")
        self.assertEqual(stress_band(98.9), "very high")
        self.assertEqual(stress_band(95.0), "very high")
        self.assertEqual(stress_band(90.0), "high")
        self.assertEqual(stress_band(50.0), "regular")
        self.assertEqual(stress_band(49.9), "low")
        self.assertEqual(stress_band(96.0, tight=True), "very tight")
        self.assertEqual(stress_band(30.0, tight=True), "loose")

    def test_context_stress_orientation(self):
        # Constant baselines make every rank exact: SSP above the whole
        # baseline -> p100 extreme; DRM below the whole baseline (tighter
        # than every trailing day) -> inverted to p100 extreme; DRM above
        # (more margin) -> p0 loose.
        days = baseline_days("2026-07-01", 120, ssp=100.0, lolp=0.0)
        for k in days:
            days[k]["drm_min_1h"] = 5000
        days["2026-07-01"] = {"ssp_max": 200.0, "lolp_max_8h": 0.0,
                              "drm_min_1h": 4000}
        ctx = compute_day_context("2026-07-01", days)
        self.assertEqual(ctx["ssp_max"], {"p": 100.0, "band": "extreme"})
        self.assertEqual(ctx["drm_min"], {"p": 100.0, "band": "extreme"})
        self.assertEqual(ctx["lolp_max"], {"p": 50.0, "band": "regular"})
        days["2026-07-01"]["drm_min_1h"] = 6000
        ctx = compute_day_context("2026-07-01", days)
        self.assertEqual(ctx["drm_min"], {"p": 0.0, "band": "loose"})

    def test_zero_inflated_lolp_any_nonzero_ranks_high(self):
        # LoLP's baseline is mostly zeros, so ANY nonzero value lands at a
        # high percentile — statistically true (top of the trailing year)
        # even when the absolute level is far below the 0.01 flag floor.
        days = baseline_days("2026-07-01", 120, lolp=0.0)
        days["2026-07-01"] = {"lolp_max_8h": 0.002}
        ctx = compute_day_context("2026-07-01", days)
        self.assertEqual(ctx["lolp_max"], {"p": 100.0, "band": "extreme"})

    def test_insufficient_history_never_fabricates_a_rank(self):
        days = baseline_days("2026-07-01", 30, ssp=100.0)
        days["2026-07-01"] = {"ssp_max": 900.0}
        ctx = compute_day_context("2026-07-01", days)
        self.assertEqual(ctx["ssp_max"],
                         {"p": None, "band": "insufficient history"})

    def test_missing_metric_gets_no_annotation(self):
        days = baseline_days("2026-07-01", 120)
        days["2026-07-01"] = {"ssp_max": 120.0}
        ctx = compute_day_context("2026-07-01", days)
        self.assertIn("ssp_max", ctx)
        self.assertNotIn("drm_min", ctx)


class EventSelection(unittest.TestCase):

    def test_every_flagged_day_qualifies_unflagged_do_not(self):
        # D8 as owner-revised 2026-07-11: every flagged day gets a slice,
        # any flag type, no recency cap; quiet days never do.
        days = {}
        for i in range(1, 9):
            days[f"2026-06-{i:02d}"] = {
                "flags": [{"type": "emn" if i % 2 else "frequency",
                           "value": 1, "threshold": 1}]}
        days["2026-06-20"] = {"flags": [{"type": "price", "value": 500,
                                         "threshold": 400}]}
        days["2026-06-21"] = {"flags": []}
        days["2026-06-22"] = {}
        picked = qualifying_event_days(days)
        self.assertEqual(picked,
                         [f"2026-06-{i:02d}" for i in range(1, 9)]
                         + ["2026-06-20"])
        self.assertNotIn("2026-06-21", picked)
        self.assertNotIn("2026-06-22", picked)


if __name__ == "__main__":
    unittest.main()

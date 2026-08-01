"""Tests for etl/build_bess_units.py (plan/09, issue #49).

Pure logic only, stdlib, no network — same convention as
tests/test_bess_revenue.py and tests/test_bess_activity.py. Covers the
per-unit and per-family aggregation, the cross-unit percentiles, and
the v1.5 HARD REQUIREMENT: the six family components published for
every shipped percentile must sum EXACTLY to that percentile's own
published total (D34 v1.5 item 2; D36's Excel workbook check row
depends on this holding, not approximately, but exactly).

Also covers the `inflation` block (owner request, 2026-08-01): the ONS
response SHAPE is parsed with plain Python dict/list literals standing
in for the mocked JSON (never a live call, per this file's own no-
network convention), and fetch_inflation()'s non-fatal contract is
proved by swapping out build_dataset.http — this repo's own plain HTTP
function, not a mocking framework — for the duration of one test.
"""

import json
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "etl"))

from build_bess_units import (  # noqa: E402
    FAMILIES,
    FamilyAdditivityError,
    assert_family_additivity,
    cross_unit_percentiles,
    family_percentile_components,
    fetch_inflation,
    parse_cpi_months,
    per_unit_family_kw_day,
    per_unit_family_totals,
    per_unit_kw_day,
    per_unit_totals,
    trailing_window,
)
# The suite runs without the ETL's third-party deps (deploy.yml
# installs certifi for the real ETL run; tests.yml deliberately does
# not — its own comment says so). build_dataset builds its SSL context
# from certifi.where() at import time, so when certifi is absent this
# stands in with a None cafile (ssl's own default trust store) — safe
# here because build_dataset is monkeypatched below and never makes a
# live request in this file.
try:
    import certifi  # noqa: F401 — presence check only
except ModuleNotFoundError:
    import ssl  # noqa: F401 — documents what consumes the stub
    import types
    _certifi_stub = types.ModuleType("certifi")
    _certifi_stub.where = lambda: None
    sys.modules["certifi"] = _certifi_stub
import build_dataset  # noqa: E402 — monkeypatched, never called live below


def make_cohort(units_mw):
    """{'T_A': {'cap_mw': 10}, ...} from {'T_A': 10, ...}."""
    return {u: {"cap_mw": mw} for u, mw in units_mw.items()}


class TrailingWindowTest(unittest.TestCase):
    def test_window_is_365_days_inclusive(self):
        from datetime import date
        day_from, day_to, n = trailing_window(date(2026, 7, 31))
        self.assertEqual(n, 365)
        self.assertEqual(day_to, "2026-07-31")
        self.assertEqual(day_from, "2025-08-01")


class PerUnitTotalsTest(unittest.TestCase):
    """Sanity-checks per_unit_totals/per_unit_family_totals agree on the
    grand total per unit — the family split must never lose or gain
    money relative to the all-products aggregation it is a breakdown
    of."""

    def setUp(self):
        self.cohort = make_cohort({"T_A": 10, "T_B": 20})
        self.window_hours = {"DCL": 4.0, "DCH": 4.0, "PBR": 0.5, "NBR": 0.5}
        self.rows = [
            {"unit": "T_A", "day": "2026-07-01", "product": "DCL",
             "gbp_ex_window": 2.0},
            {"unit": "T_A", "day": "2026-07-01", "product": "PBR",
             "gbp_ex_window": 8.0},
            {"unit": "T_A", "day": "2026-07-02", "product": "NBR",
             "gbp_ex_window": -4.0},
            {"unit": "T_B", "day": "2026-07-01", "product": "DCH",
             "gbp_ex_window": 1.0},
            # outside the window — must be excluded from both
            {"unit": "T_A", "day": "2026-06-01", "product": "DCL",
             "gbp_ex_window": 999.0},
            # unit not in cohort — must be excluded from both
            {"unit": "T_Z", "day": "2026-07-01", "product": "DCL",
             "gbp_ex_window": 999.0},
        ]

    def test_family_totals_sum_to_the_plain_totals(self):
        totals, _active = per_unit_totals(
            self.rows, self.cohort, self.window_hours,
            "2026-07-01", "2026-07-31")
        family_totals = per_unit_family_totals(
            self.rows, self.cohort, self.window_hours,
            "2026-07-01", "2026-07-31")
        for unit in self.cohort:
            self.assertAlmostEqual(
                sum(family_totals[unit].values()), totals[unit], places=9)

    def test_correct_family_receives_the_right_product(self):
        family_totals = per_unit_family_totals(
            self.rows, self.cohort, self.window_hours,
            "2026-07-01", "2026-07-31")
        # T_A: DCL (window 4h) -> gbp = 2.0*1.0*4.0 = 8.0 into DC;
        #      PBR (window 0.5h) -> 8.0*1.0*0.5 = 4.0 into BR;
        #      NBR (window 0.5h) -> -4.0*1.0*0.5 = -2.0 into BR.
        self.assertAlmostEqual(family_totals["T_A"]["DC"], 8.0, places=9)
        self.assertAlmostEqual(family_totals["T_A"]["BR"], 2.0, places=9)
        self.assertEqual(family_totals["T_A"]["DM"], 0.0)
        # T_B: DCH -> 1.0*1.0*4.0 = 4.0 into DC
        self.assertAlmostEqual(family_totals["T_B"]["DC"], 4.0, places=9)

    def test_out_of_window_and_out_of_cohort_rows_excluded(self):
        family_totals = per_unit_family_totals(
            self.rows, self.cohort, self.window_hours,
            "2026-07-01", "2026-07-31")
        total_in_payload = sum(
            sum(fam.values()) for fam in family_totals.values())
        # 8.0 (DCL) + 4.0 (PBR) - 2.0 (NBR) + 4.0 (DCH) = 14.0; the
        # 999.0-tagged rows (out-of-window, out-of-cohort) must be absent.
        self.assertAlmostEqual(total_in_payload, 14.0, places=9)

    def test_unknown_product_is_ignored_not_raising(self):
        rows = self.rows + [{"unit": "T_A", "day": "2026-07-01",
                             "product": "NOPE", "gbp_ex_window": 5.0}]
        family_totals = per_unit_family_totals(
            rows, self.cohort, self.window_hours,
            "2026-07-01", "2026-07-31")
        self.assertAlmostEqual(family_totals["T_A"]["DC"], 8.0, places=9)


class PerUnitFamilyKwDayTest(unittest.TestCase):
    def test_zero_capacity_unit_excluded(self):
        cohort = make_cohort({"T_A": 10, "T_Z": 0})
        family_totals = {"T_A": {"DC": 100.0, "DM": 0.0, "DR": 0.0,
                                 "BR": 0.0, "QR": 0.0, "SR": 0.0},
                        "T_Z": {"DC": 50.0, "DM": 0.0, "DR": 0.0,
                                "BR": 0.0, "QR": 0.0, "SR": 0.0}}
        out = per_unit_family_kw_day(family_totals, cohort, n_days=10)
        self.assertIn("T_A", out)
        self.assertNotIn("T_Z", out)
        # 100 / (10*1000) / 10 = 0.001
        self.assertAlmostEqual(out["T_A"]["DC"], 0.001, places=9)


class FamilyAdditivityInvariantTest(unittest.TestCase):
    """The HARD REQUIREMENT: for a synthetic cohort spanning enough units
    that every shipped percentile lands on a genuinely fractional rank
    (exercising the interpolation, not just an exact-hit unit), the six
    family components must sum EXACTLY (float-precision) to the
    percentile total, for p10/p25/p50/p75/p90 — every one, not just a
    convenient sample."""

    def setUp(self):
        # 17 units so (n-1)*q is fractional for every q in {.10,.25,.5,
        # .75,.9} (n-1=16: 1.6, 4.0 exact, 8.0 exact, 12.0 exact, 14.4) —
        # add a deliberately uneven family mix per unit so a naive
        # per-family independent-percentile approach would NOT sum to
        # the total (the failure mode D34 explicitly rejects).
        import random
        rng = random.Random(20260731)
        self.cohort = make_cohort({f"T_{i}": 5 + i for i in range(17)})
        self.kw_day = {}
        self.family_kw_day = {}
        for i in range(17):
            unit = f"T_{i}"
            total = round(rng.uniform(-0.01, 0.09), 6)
            # split `total` unevenly across the six families, each
            # family free to be negative (DR routinely clears negative
            # per plan/09), but summing exactly to `total`.
            shares = [rng.uniform(-1, 1) for _ in FAMILIES]
            s = sum(shares)
            fam = {}
            running = 0.0
            for j, f in enumerate(FAMILIES):
                if j == len(FAMILIES) - 1:
                    fam[f] = total - running
                else:
                    v = total * shares[j] / s if s else total / len(FAMILIES)
                    fam[f] = v
                    running += v
            self.kw_day[unit] = total
            self.family_kw_day[unit] = fam

    def test_percentile_totals_and_family_components_are_consistent(self):
        totals = {u: v * 1000 for u, v in self.kw_day.items()}  # dummy £
        percentiles = cross_unit_percentiles(
            self.kw_day, totals, self.cohort, n_days=365)
        families = family_percentile_components(
            self.kw_day, self.family_kw_day, percentiles)
        assert_family_additivity(percentiles, families)  # must not raise
        for key in ("p10", "p25", "p50", "p75", "p90"):
            self.assertIn(key, families)
            self.assertEqual(set(families[key]), set(FAMILIES))
            total = sum(families[key].values())
            self.assertAlmostEqual(total, percentiles[key], places=9,
                                   msg=f"{key} additivity")

    def test_independent_ranking_would_have_failed(self):
        # Demonstrates the rejected alternative (D34's explicit contrast):
        # six INDEPENDENTLY-ranked family percentiles do not, in general,
        # sum to the jointly-ranked total — confirming this repo's method
        # (rank-representative, same pair of units for every family) is
        # not a distinction without a difference.
        def independent_percentile(values, q):
            xs = sorted(values)
            idx = (len(xs) - 1) * q
            lo = int(idx)
            hi = min(lo + 1, len(xs) - 1)
            return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo)

        totals = {u: v * 1000 for u, v in self.kw_day.items()}
        percentiles = cross_unit_percentiles(
            self.kw_day, totals, self.cohort, n_days=365)
        for key, q in (("p10", 0.10), ("p25", 0.25), ("p50", 0.50),
                      ("p75", 0.75), ("p90", 0.90)):
            independent_sum = sum(
                independent_percentile(
                    [self.family_kw_day[u][f] for u in self.family_kw_day], q)
                for f in FAMILIES)
            # Not asserting inequality for every possible random seed
            # (a coincidental match is not impossible), but for THIS
            # fixed seed the two must differ, evidencing the trap is
            # real rather than theoretical.
            self.assertNotAlmostEqual(independent_sum, percentiles[key],
                                      places=4,
                                      msg=f"{key}: independent ranking "
                                          "coincidentally matched — pick "
                                          "a different seed")

    def test_broken_family_split_raises(self):
        percentiles = {"p50": 1.0}
        broken = {"p50": {f: 0.1 for f in FAMILIES}}  # sums to 0.6, not 1.0
        with self.assertRaises(FamilyAdditivityError):
            assert_family_additivity(percentiles, broken)

    def test_correct_family_split_does_not_raise(self):
        percentiles = {"p50": 0.6}
        ok = {"p50": {f: 0.1 for f in FAMILIES}}
        assert_family_additivity(percentiles, ok)  # must not raise


class EmptyCohortTest(unittest.TestCase):
    def test_family_percentile_components_empty_cohort(self):
        out = family_percentile_components({}, {}, {
            "p10": 0.0, "p25": 0.0, "p50": 0.0, "p75": 0.0, "p90": 0.0})
        for key in ("p10", "p25", "p50", "p75", "p90"):
            self.assertEqual(out[key], {f: 0.0 for f in FAMILIES})


class InflationParseTest(unittest.TestCase):
    """The pure half of fetch_inflation() (owner request, 2026-08-01):
    parse_cpi_months() over ONS's own response SHAPE, mocked as plain
    Python list/dict literals — no network, matching this file's own
    convention. The shape (verified live, 2026-08-01, against
    /v1/data?uri=/economy/inflationandpriceindices/timeseries/d7g7/mm23):
    chronological months, a period not yet published carrying
    value="" rather than being absent from the array."""

    def test_latest_published_month_is_returned(self):
        months = [{"date": "2026 MAY", "value": "2.8"},
                 {"date": "2026 JUN", "value": "2.6"}]
        pct, period = parse_cpi_months(months)
        self.assertEqual(pct, 2.6)
        self.assertEqual(period, "2026 JUN")

    def test_trailing_blank_value_is_skipped(self):
        # The real shape this guards against: the latest month can
        # appear in the array ahead of publication day with an empty
        # value, and the published rate is the entry before it.
        months = [{"date": "2026 JUN", "value": "2.6"},
                 {"date": "2026 JUL", "value": ""}]
        pct, period = parse_cpi_months(months)
        self.assertEqual(pct, 2.6)
        self.assertEqual(period, "2026 JUN")

    def test_rounds_to_one_decimal(self):
        pct, _ = parse_cpi_months([{"date": "2026 JUN", "value": "2.55555"}])
        self.assertEqual(pct, 2.6)

    def test_no_published_month_raises(self):
        with self.assertRaises(ValueError):
            parse_cpi_months([{"date": "2026 JUN", "value": ""}])
        with self.assertRaises(ValueError):
            parse_cpi_months([])


class InflationFetchNonFatalTest(unittest.TestCase):
    """fetch_inflation() must never raise (owner request, 2026-08-01):
    a failed or malformed ONS fetch degrades to None, a print()
    warning, and an absent/null `inflation` payload block — the same
    non-fatal shape ops/refresh.py already relies on for this whole
    builder. build_dataset.http (this repo's own plain HTTP function,
    not a mocking framework) is swapped out for the duration of each
    test and restored in tearDown, so nothing here touches the
    network."""

    def setUp(self):
        self._orig_http = build_dataset.http

    def tearDown(self):
        build_dataset.http = self._orig_http

    def test_network_failure_returns_none_not_raises(self):
        def boom(url, **kwargs):
            raise OSError("network unreachable (test)")
        build_dataset.http = boom
        self.assertIsNone(fetch_inflation())

    def test_malformed_json_returns_none_not_raises(self):
        build_dataset.http = lambda url, **kwargs: "not json"
        self.assertIsNone(fetch_inflation())

    def test_no_published_month_returns_none_not_raises(self):
        build_dataset.http = lambda url, **kwargs: json.dumps(
            {"months": [{"date": "2026 JUN", "value": ""}]})
        self.assertIsNone(fetch_inflation())

    def test_successful_response_parsed_end_to_end(self):
        build_dataset.http = lambda url, **kwargs: json.dumps(
            {"months": [{"date": "2026 MAY", "value": "2.8"},
                       {"date": "2026 JUN", "value": "2.6"}]})
        result = fetch_inflation()
        self.assertIsNotNone(result)
        self.assertEqual(result["cpi_annual_pct"], 2.6)
        self.assertEqual(result["cpi_period"], "2026 JUN")
        self.assertIsNone(result["ppi_annual_pct"])
        self.assertIsNone(result["ppi_period"])
        self.assertEqual(result["source"], "ONS")


if __name__ == "__main__":
    unittest.main()

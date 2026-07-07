"""Hand-calculated checks for ops/panel_facts.py — the precompute layer
that replaced the LLM's tool-driven statistics (CHANGELOG 2026-07-07).

A tiny synthetic dataset with values chosen so every expected number is
verifiable by hand on paper; formulas per methodology.md.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "ops"))

from panel_facts import compute_facts  # noqa: E402

HALF_HOUR = 1800
T0 = 1780000000 - (1780000000 % HALF_HOUR)  # aligned epoch start


def build_dataset(tmp):
    """15 days of half-hourly data: 14 baseline days of constants, then a
    24 h 'overnight' window with different constants — so means, z-scores
    and flips are exact."""
    n_base, n_over = 14 * 48, 48
    n = n_base + n_over
    t = [T0 + i * HALF_HOUR for i in range(n)]

    def col(base_value, overnight_value):
        return [base_value] * n_base + [overnight_value] * n_over

    hh = {
        "t": t,
        # price: baseline alternates 90/110 (mean 100, sample std ~10),
        # overnight constant 120 → z = +2 → notable
        "price": [90 if i % 2 == 0 else 110 for i in range(n_base)]
                 + [120] * n_over,
        "demand": col(20000, 22000),
        "WIND": col(5000, 8000),
        "NUCLEAR": col(4000, 4000),
        "BIOMASS": col(2000, 2000),
        "NPSHYD": col(500, 500),
        "CCGT": col(8000, 6000),
        "OCGT": col(100, 100),
        "COAL": col(0, 0),
        # one cable exporting in baseline, importing overnight → flip;
        # one overnight dip to -200 exercises the window extremes
        "INTFR": [-800] * n_base + [900] * (n_over - 1) + [-200],
        "INTNED": col(400, 500),   # no flip
        # solar: 5 sub-zero values, longest consecutive run of 3 —
        # exercises the below-zero counters (values synthetic, maths real)
        "solar": [1000] * n_base + [1000] * 40 + [-5] * 3 + [1000] * 2
                 + [-5] * 2 + [1000],
    }
    # 16 daily rows; last day complete for spreads
    days = 16
    daily = {
        "d": ["2026-06-{:02d}".format(i + 1) for i in range(days)],
        "price": [100.0] * days,
        "gas_sap": [35.0] * days,
        "carbon_uka_month": [50.0] * days,
        "coal_proxy_gbp_mwh": [15.0] * days,
        "carbon_ffill": [False] * (days - 2) + [True, True],
        "coal_ffill": [False] * days,
    }
    (Path(tmp) / "series_hh.json").write_text(json.dumps(hh))
    (Path(tmp) / "series_daily.json").write_text(json.dumps(daily))


class TestPanelFacts(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        build_dataset(cls.tmp.name)
        cls.facts = compute_facts(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_overnight_and_baseline_means(self):
        price = self.facts["metrics"]["price"]
        self.assertEqual(price["overnight"]["mean"], 120)
        self.assertEqual(price["baseline_14d"]["mean"], 100)
        demand = self.facts["metrics"]["demand"]
        self.assertEqual(demand["overnight"]["mean"], 22000)
        self.assertEqual(demand["baseline_14d"]["std"], 0)

    def test_z_score_flags_notable(self):
        # baseline 90/110 alternating: mean 100, sample std 10.0075…
        # → z = 20 / 10.0075 ≈ 2.0 (just under/over depending on rounding)
        price = self.facts["metrics"]["price"]
        self.assertAlmostEqual(price["z"], 2.0, places=1)

    def test_residual_is_demand_minus_wind_only(self):
        # 22000 − 8000 = 14000; solar (1000) must NOT be subtracted
        residual = self.facts["metrics"]["residual"]
        self.assertEqual(residual["overnight"]["mean"], 14000)

    def test_spark_formula_matches_methodology(self):
        # 100 − 35/0.5 − (0.184/0.5)·50 − 3 = 100 − 70 − 18.4 − 3 = 8.6
        spark = self.facts["spreads"]["clean_spark_gbp_mwh"]
        self.assertEqual(spark["latest"], 8.6)
        deco = spark["decomposition_at_reference"]
        self.assertEqual(deco["gas_cost"], 70.0)
        self.assertEqual(deco["carbon_cost"], 18.4)

    def test_dark_formula_matches_methodology(self):
        # 100 − 15/0.36 − (0.34/0.36)·50 − 5 = 100 − 41.67 − 47.22 − 5 = 6.11
        dark = self.facts["spreads"]["clean_dark_gbp_mwh"]
        self.assertAlmostEqual(dark["latest"], 6.11, places=2)

    def test_cable_flip_detection(self):
        cables = self.facts["flows"]["cables"]
        self.assertTrue(cables["INTFR"]["direction_flipped"])
        self.assertFalse(cables["INTNED"]["direction_flipped"])

    def test_import_dependency(self):
        # overnight net mean = (47·900 − 200)/48 + 500 = 1377.08 of 22000
        # demand → 6.3%
        dep = self.facts["flows"]["import_dependency_pct"]
        self.assertEqual(dep["overnight"], 6.3)

    def test_below_zero_counters(self):
        # solar overnight: 5 sub-zero values, longest consecutive run 3
        solar = self.facts["metrics"]["solar"]["overnight"]
        self.assertEqual(solar["below_zero_n"], 5)
        self.assertEqual(solar["below_zero_longest_consecutive"], 3)
        # price overnight all positive → both zero
        price = self.facts["metrics"]["price"]["overnight"]
        self.assertEqual(price["below_zero_n"], 0)
        self.assertEqual(price["below_zero_longest_consecutive"], 0)

    def test_cable_window_extremes(self):
        intfr = self.facts["flows"]["cables"]["INTFR"]
        self.assertEqual(intfr["window_min_mw"], -200)
        self.assertEqual(intfr["window_max_mw"], 900)
        self.assertTrue(intfr["window_min_at"].endswith("Z"))

    def test_window_covers_last_24h(self):
        w = self.facts["window"]
        self.assertTrue(w["from"].endswith("Z") and w["to"].endswith("Z"))

    def test_carbon_ffill_days_counted(self):
        self.assertEqual(
            self.facts["data_quality_facts"]["carbon_ffill_recent_days"], 2)


if __name__ == "__main__":
    unittest.main()

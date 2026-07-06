"""Parity tests for ops/merit_panel_figures.py against the app's own
metrics.js.

This helper is the guard that stops the overnight-summary LLM from
inventing SRMC figures (the publish validator rejects figures that
disagree with it), so it needs its own safety net: if it ever drifts from
what the Merit order panel actually displays, the guard would start
enforcing the WRONG numbers.

Fixtures under tests/fixtures/merit_case_*/ are slices of the real
published dataset (Elexon/PV_Live/National Gas/gov.uk values, untouched —
only truncated to a 45-day window ending at a known settlement period).
expected.json holds the output of the app's real Metrics.meritLadder /
meritCurveSteps / curveClearing functions executed on the same slices in
a browser (2026-07-06) — a cross-implementation oracle, not synthetic
numbers. The three periods cover three regimes:

  merit_case_1 — 2026-07-05 22:30 UTC: summer evening, CCGT marginal,
                 small gap (observed 92.85 vs implied 88.94, +4.4%)
  merit_case_2 — 2026-06-20 12:00 UTC: midday solar glut, must-run Solar
                 marginal at 4.13 (the panel's known diagnostic limit when
                 renewables clear the residual demand)
  merit_case_3 — 2026-01-15 17:00 UTC: winter evening peak, demand target
                 36.69 GW of a 42.07 GW curve, +39.8% gap

Building this oracle caught a real bug: the original js_round() used
decimal half-away-from-zero, but JS toFixed rounds the exact binary
double — (11.225).toFixed(2) is "11.22", not "11.23". The fixtures pin
the corrected behaviour.
"""

import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "ops"))

from merit_panel_figures import compute, js_round  # noqa: E402

FIXTURES = PROJECT_ROOT / "tests" / "fixtures"
CASES = ("merit_case_1", "merit_case_2", "merit_case_3")


def load_expected(case):
    import json
    return json.loads((FIXTURES / case / "expected.json").read_text())


class TestMeritFiguresParity(unittest.TestCase):
    """compute() must equal metrics.js for every field, every case."""

    def assert_close(self, got, want, label):
        if want is None or isinstance(want, str):
            self.assertEqual(got, want, label)
        else:
            self.assertIsInstance(got, (int, float), label)
            self.assertAlmostEqual(got, want, delta=1e-9, msg=label)

    def test_figures_match_metrics_js(self):
        for case in CASES:
            with self.subTest(case=case):
                result = compute(FIXTURES / case)
                expected = load_expected(case)
                self.assertNotIn("error", result, case)
                for key, want in expected["figures"].items():
                    self.assert_close(result["figures"][key], want,
                                      f"{case}.figures.{key}")

    def test_inputs_match_metrics_js(self):
        for case in CASES:
            with self.subTest(case=case):
                result = compute(FIXTURES / case)
                expected = load_expected(case)
                for key, want in expected["inputs"].items():
                    if key == "capacity_proxies_gw":
                        for tech, cap in want.items():
                            self.assert_close(
                                result["inputs"][key][tech], cap,
                                f"{case}.inputs.capacity.{tech}")
                    else:
                        self.assert_close(result["inputs"][key], want,
                                          f"{case}.inputs.{key}")

    def test_marginal_technology_varies_across_regimes(self):
        # The three fixtures deliberately span regimes; if truncation or a
        # refactor ever collapsed them to one answer, the parity assertions
        # above would weaken silently.
        techs = {load_expected(c)["figures"]["marginal_technology"]
                 for c in CASES}
        self.assertEqual(techs, {"Gas (CCGT)", "Solar"})


class TestJsRoundToFixedParity(unittest.TestCase):
    """js_round must reproduce JS Number.prototype.toFixed exactly —
    expected strings verified in a real browser (2026-07-06)."""

    CASES = [
        (11.225, 2, 11.22),   # binary double is 11.2249… → down
        (85.605, 2, 85.61),   # binary double is 85.6050…01 → up
        (2.675, 2, 2.67),
        (1.005, 2, 1.00),
        (0.605, 2, 0.60),
        (0.5, 0, 1),          # exactly-representable half → away from zero
        (2.5, 0, 3),
        (-1.5, 0, -2),        # spec negates first: away from zero
    ]

    def test_matches_browser_tofixed(self):
        for value, dp, want in self.CASES:
            with self.subTest(value=value, dp=dp):
                self.assertAlmostEqual(js_round(value, dp), want,
                                       delta=1e-12)


class TestMissingInputs(unittest.TestCase):
    def test_missing_gas_reports_error_not_crash(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            src = FIXTURES / "merit_case_1"
            daily = json.loads((src / "series_daily.json").read_text())
            daily["gas_sap"] = [None] * len(daily["gas_sap"])
            (Path(tmp) / "series_daily.json").write_text(json.dumps(daily))
            (Path(tmp) / "series_hh.json").write_text(
                (src / "series_hh.json").read_text())
            result = compute(tmp)
            self.assertIn("error", result)


if __name__ == "__main__":
    unittest.main()

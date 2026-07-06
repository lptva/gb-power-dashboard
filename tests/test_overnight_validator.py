"""Tests for ops/validate_overnight.py — the overnight summary's publish
gate.

The assumption-vocabulary check exists because the watcher LLM twice
invented SRMC parameters in prose ("55% efficiency, 0.40 tCO2/MWh" — the
dashboard's documented reference spark is η 0.50 HHV with 0.184 tCO2/MWh
thermal). The regression case below is the verbatim sentence from that
failed run (2026-07-06); the pass cases are real sentence shapes from
accepted summaries that must never be false-positived.
"""

import json
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "ops"))

from validate_overnight import (  # noqa: E402
    ValidationError, assumption_violations, extract_inner_json,
    validate_summary,
)


class TestAssumptionVocabulary(unittest.TestCase):

    def test_rejects_the_known_bad_sentence(self):
        # Verbatim from the failed 2026-07-06 run that motivated the guard.
        text = ("The implied short-run marginal cost for a CCGT unit on "
                "5 July, using the SAP gas price of £36.45/MWh and the "
                "forward-filled May-2026 UKA carbon of £52.41/tCO2 at a "
                "standard 55% efficiency and 0.40 tCO2/MWh gas carbon "
                "intensity, was approximately £87.23/MWh.")
        violations = assumption_violations(text)
        self.assertEqual(violations,
                         [("efficiency", "55"), ("intensity", "0.40")])

    def test_rejects_invented_eta(self):
        self.assertEqual(assumption_violations("assuming η = 0.52 for the fleet"),
                         [("efficiency", "0.52")])

    def test_passes_legitimate_sentences(self):
        # Real shapes from accepted summaries — must never false-positive.
        legitimate = [
            # carbon PRICE, not intensity
            "the forward-filled May-2026 UKA carbon of £52.41/tCO2",
            # percentage of demand, not an efficiency
            "wind supplied 39% of demand (transmission only)",
            # percentile reference
            "a clean spark at the 45th percentile of the full dataset",
            "capacity proxies use the 98th percentile of observed output",
            # reference values on their documented basis
            "at reference assumptions (η = 0.50 HHV, 0.184 tCO2/MWh thermal)",
            "a unit at the top of the documented fleet band (0.57 HHV)",
            "coal fuel cost (£14.89/MWh thermal, η = 0.36) with the higher "
            "carbon intensity (0.34 tCO2/MWh thermal)",
            "the OCGT band runs η 0.32 to 0.40",
            "45% efficiency marks the bottom of the CCGT fleet band",
        ]
        for text in legitimate:
            with self.subTest(text=text[:50]):
                self.assertEqual(assumption_violations(text), [])


class TestPublishedSummariesStayValid(unittest.TestCase):
    """The currently published summary (real accepted output) must pass the
    full validation against the panel's real recompute — guards against the
    validator drifting stricter than what production publishes."""

    def test_current_published_summary_validates(self):
        data_dir = PROJECT_ROOT / "app" / "data"
        summary = json.loads((data_dir / "overnight_summary.json").read_text())
        sys.path.insert(0, str(PROJECT_ROOT / "ops"))
        from merit_panel_figures import compute
        reference = compute(data_dir)
        validate_summary(summary, reference)  # raises on failure


class TestValidateSummarySchema(unittest.TestCase):

    def setUp(self):
        # Minimal valid summary + matching reference
        section = {"takeaway": "t", "analysis": "a", "findings": []}
        self.reference = {"figures": {
            "observed_price_gbp_mwh": 92.85,
            "implied_clearing_gbp_mwh": 85.61,
            "marginal_technology": "Gas (CCGT)", "gap_pct": 8.5}}
        self.data = {
            "window": {"from": "2026-07-04T22:30:00Z",
                       "to": "2026-07-05T22:30:00Z"},
            "tabs": {
                "overview": dict(section),
                "merit_order": {**section,
                                "figures": dict(self.reference["figures"])},
                "spreads": dict(section),
                "flows": dict(section),
            },
            "data_quality": [],
        }

    def test_valid_summary_passes(self):
        validate_summary(self.data, self.reference)

    def test_rejects_figure_disagreeing_with_panel(self):
        self.data["tabs"]["merit_order"]["figures"][
            "implied_clearing_gbp_mwh"] = 87.23  # the LLM's invented value
        with self.assertRaisesRegex(ValidationError, "disagrees"):
            validate_summary(self.data, self.reference)

    def test_rejects_more_than_two_findings(self):
        self.data["tabs"]["flows"]["findings"] = [
            {"title": f"f{i}", "detail": "d"} for i in range(3)]
        with self.assertRaisesRegex(ValidationError, "<=2"):
            validate_summary(self.data, self.reference)

    def test_rejects_string_window(self):
        self.data["window"] = "2025-07-06 to 2026-07-05"  # from a real run
        with self.assertRaisesRegex(ValidationError, "window"):
            validate_summary(self.data, self.reference)

    def test_rejects_prose_violation(self):
        self.data["tabs"]["spreads"]["analysis"] = \
            "at a standard 55% efficiency this implies £87.23/MWh"
        with self.assertRaisesRegex(ValidationError, "efficiency '55'"):
            validate_summary(self.data, self.reference)

    def test_null_figures_required_when_reference_errored(self):
        reference = {"error": "missing input"}
        with self.assertRaisesRegex(ValidationError, "must be null"):
            validate_summary(self.data, reference)
        for k in self.data["tabs"]["merit_order"]["figures"]:
            self.data["tabs"]["merit_order"]["figures"][k] = None
        validate_summary(self.data, reference)  # now passes


class TestEnvelopeExtraction(unittest.TestCase):

    def test_prose_prefixed_result_is_sliced(self):
        # The failure shape from the first rework run: prose before the JSON.
        envelope = json.dumps({
            "subtype": "success",
            "result": 'Now I have everything I need. Producing the JSON '
                      'output:\n\n{"window": "x", "tabs": {}}'})
        data = extract_inner_json(envelope)
        self.assertEqual(data["window"], "x")

    def test_failed_run_is_rejected(self):
        envelope = json.dumps({"subtype": "error_during_execution",
                               "is_error": True, "result": ""})
        with self.assertRaisesRegex(ValidationError, "agent run failed"):
            extract_inner_json(envelope)


if __name__ == "__main__":
    unittest.main()

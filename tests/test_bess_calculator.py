"""Tests for the BESS profitability calculator (plan/09, issue #49).

Covers the design doc's test plan: hand-computed NPV/IRR/payback/LCOS
cases, IRR edge cases, degradation/cannibalisation compounding, the
arbitrage margin formula, TNUoS applicability, the double-count guard,
JS-to-Python parity (fixtures under tests/fixtures/bess_case_*/, captured
from the app's real Metrics functions in a browser, same convention as
tests/test_merit_panel_figures.py), the no-storage/no-URL-state source
guard, CSV-export numeric-only shape, the ETL's four tripwires, and
(WorkbookExport, D38/D39) the Excel DCF export: zip/XML structure, the
family and NPV check rows, both discounting conventions, and workbook
formulas evaluated against the same engine via ops/xlsx_eval.py.
"""

import base64
import copy
import io
import json
import re
import sys
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "ops"))
sys.path.insert(0, str(PROJECT_ROOT / "etl"))

import xlsx_eval as xe  # noqa: E402
from bess_calculator_figures import (  # noqa: E402
    annuity_payment,
    arbitrage_ceiling,
    bess_cashflow,
    compute,
    discount_exponent,
    discounted_payback,
    dscr_stats,
    irr,
    mirr,
    js_round,
    lcos,
    npv,
    observed_arbitrage_spread,
    pvi_at_commissioning,
    reanchor_npv,
    simple_payback,
    tnuos_charge,
    year_fraction_remaining,
)
from build_bess_units import (  # noqa: E402
    CohortCountMismatch,
    MeanAgreementMismatch,
    PayloadBudgetError,
    PAYLOAD_BUDGET_BYTES,
    ZoneTableError,
    assert_cohort_count,
    assert_mean_agreement,
    assert_payload_budget,
    assert_zone_table,
)

FIXTURES = PROJECT_ROOT / "tests" / "fixtures"
# The card's standing sentence, verbatim from app/js/charts.js.
BESS_STANDING_SENTENCE = (
    "Illustrative economics from the assumptions you enter, anchored on "
    "what comparable units observably earned. Not investment advice, not "
    "a valuation, and not a forecast.")
# bess_case_1..4 pin the end-of-period convention explicitly
# ("discounting": "end" in their inputs.json), captured before the
# discounting-convention feature existed. bess_case_5/6 (owner request,
# 2026-07) pin the new "mid" default: case 5 has no commissioning date
# (frac1=1, the stub formula degenerates to the general n-0.5 rule);
# case 6 has one (y0="2026-07-02"), exercising the year-1 stub midpoint
# exponent, hand-computed in DiscountingConventionTest below. bess_case_7/8
# (v1.5, D26/D21 pulled forward) exercise the arbitrage line end-to-end:
# case 7 sets sHi/sLo/k directly (the observed-ceiling path, mid-year
# discounting, and a never-quite-repays cash flow, IRR just below zero);
# case 8's `a` is the real p75 payload figure with the BR and SR family
# components subtracted off (the family-toggle path feeding the engine's
# ordinary `a` input, nothing new for bess_cashflow itself to do), plus a
# manual-override-shaped sHi/sLo=0/k=1 arbitrage input and end-of-period
# discounting with a commissioning-date stub, a clean repay case (IRR
# positive, a real simple payback). Both captured from the app's real
# Metrics functions in a live browser, same oracle convention as every
# other bess_case_*.
CASES = ("bess_case_1", "bess_case_2", "bess_case_3", "bess_case_4",
        "bess_case_5", "bess_case_6", "bess_case_7", "bess_case_8")

ZONE_1_FY2027_FINAL = {  # app/data/bess_units.json, FY2027 Final, zone 1
    "peak": 3.628, "yr_shared": 26.533, "yr_notshared": 17.675,
    "residual": -2.477,
}

CSV_COLUMNS = (
    "year", "capex_gbp", "availability_gbp", "arbitrage_gbp", "opex_gbp",
    "tnuos_gbp", "net_cashflow_gbp", "discounted_cashflow_gbp",
    "cumulative_discounted_gbp", "discharged_mwh", "usable_mwh",
    "toll_gbp", "debt_drawdown_gbp", "debt_interest_gbp",
    "debt_principal_gbp", "equity_cashflow_gbp",
)


class HandComputedTest(unittest.TestCase):
    """Test plan item 1: a one-year toy cash flow chosen so every figure
    is exact (or exact to a known fraction) by hand."""

    def setUp(self):
        # P=10 MW, C0 = 100 (£k/MW) x 1000 x 10 = 1,000,000.
        # a=120 (£/kW/yr) -> availability = 120 x 1000 x 10 = 1,200,000.
        # No opex, TNUoS or arbitrage: net cash flow year 1 = 1,200,000.
        self.inputs = {"P": 10, "E": 1, "T": 1, "C": 100, "O": 0, "r": 0.1,
                      "c": 1, "delta": 0, "eta": 1, "a": 120, "gamma": 0,
                      "zTotal": 0}

    def test_capex(self):
        cf = bess_cashflow(self.inputs)
        self.assertEqual(cf["c0"], 1_000_000)

    def test_npv_exact(self):
        cf = bess_cashflow(self.inputs)
        cashflows = [r["net_cashflow_gbp"] for r in cf["rows"] if r["year"] >= 1]
        self.assertEqual(cashflows, [1_200_000])
        result = npv(cf["c0"], cashflows, 0.1)
        self.assertAlmostEqual(result, 1_000_000 / 11, places=6)  # exact fraction

    def test_irr_exact(self):
        cf = bess_cashflow(self.inputs)
        cashflows = [r["net_cashflow_gbp"] for r in cf["rows"] if r["year"] >= 1]
        result = irr(cf["c0"], cashflows)
        self.assertAlmostEqual(result, 0.2, places=6)  # 1.2M/1M - 1 = 0.2

    def test_payback_exact(self):
        cf = bess_cashflow(self.inputs)
        cashflows = [r["net_cashflow_gbp"] for r in cf["rows"] if r["year"] >= 1]
        result = simple_payback(cf["c0"], cashflows)
        self.assertAlmostEqual(result, 5 / 6, places=6)

    def test_lcos_exact(self):
        cf = bess_cashflow(self.inputs)
        # discharged_mwh year 1 = 365 x 1 x 1 x (1-0)^0 = 365
        self.assertEqual(cf["rows"][1]["discharged_mwh"], 365)
        result = lcos(cf["c0"], cf["rows"], 0.1, 1, None)
        self.assertAlmostEqual(result, 1_000_000 * 1.1 / 365, places=4)


class IrrEdgeCasesTest(unittest.TestCase):
    """Test plan item 2."""

    def test_never_repays_returns_null_not_zero(self):
        # A cash flow that is net NEGATIVE every year (costs exceed
        # revenue, the common real case per plan/09) never crosses zero
        # anywhere in the bracket, however wide: NPV stays negative at
        # both r=-0.99 and r=1.50. A cash flow with even one positive
        # year can have a mathematical (if nonsensical) root at extreme
        # negative r, which is why this case must be net-negative
        # throughout, not merely "smaller than C0".
        result = irr(1_000_000, [-5_000] * 10)
        self.assertIsNone(result)

    def test_negative_irr_inside_bracket(self):
        # C0 = 100; single cash flow of 60 -> IRR = 60/100 - 1 = -0.4.
        result = irr(100, [60])
        self.assertIsNotNone(result)
        self.assertLess(result, 0)
        self.assertAlmostEqual(result, -0.4, places=6)

    def test_no_sign_change_returns_null(self):
        # NPV is negative at both bracket ends (an all-negative cash flow
        # against a huge C0) -> no root in [-0.99, 1.50], must be null.
        result = irr(10_000_000, [-1] * 5)
        self.assertIsNone(result)


class DegradationCannibalisationTest(unittest.TestCase):
    """Test plan item 3: year-5 usable energy is E x (1-delta)^4 exactly;
    gamma applies to availability and arbitrage but never to OPEX."""

    def test_year5_usable_energy_exact(self):
        inputs = {"P": 10, "E": 20, "T": 5, "C": 100, "O": 10, "r": 0.08,
                 "c": 1, "delta": 0.1, "eta": 0.9, "a": 50, "gamma": 0.15,
                 "zTotal": 0}
        cf = bess_cashflow(inputs)
        row5 = next(r for r in cf["rows"] if r["year"] == 5)
        expected = 20 * (1 - 0.1) ** 4
        self.assertAlmostEqual(row5["usable_mwh"], round(expected, 3), places=3)

    def test_gamma_applies_to_availability_not_opex(self):
        inputs = {"P": 10, "E": 20, "T": 3, "C": 100, "O": 10, "r": 0.08,
                 "c": 1, "delta": 0, "eta": 0.9, "a": 50, "gamma": 0.2,
                 "zTotal": 0}
        cf = bess_cashflow(inputs)
        years = [r for r in cf["rows"] if r["year"] >= 1]
        opex_values = {r["opex_gbp"] for r in years}
        self.assertEqual(len(opex_values), 1)  # constant every year
        # availability ratio year2/year1 must equal (1-gamma)^1
        ratio = years[1]["availability_gbp"] / years[0]["availability_gbp"]
        self.assertAlmostEqual(ratio, 0.8, places=6)

    def test_gamma_applies_to_arbitrage(self):
        inputs = {"P": 10, "E": 20, "T": 2, "C": 100, "O": 0, "r": 0.08,
                 "c": 1, "delta": 0, "eta": 0.85, "a": 0, "gamma": 0.3,
                 "zTotal": 0, "sHi": 100, "sLo": 40, "k": 0.5}
        cf = bess_cashflow(inputs)
        years = [r for r in cf["rows"] if r["year"] >= 1]
        self.assertGreater(years[0]["arbitrage_gbp"], 0)
        ratio = years[1]["arbitrage_gbp"] / years[0]["arbitrage_gbp"]
        self.assertAlmostEqual(ratio, 0.7, places=6)


class AugmentationDerateTest(unittest.TestCase):
    """IC-review pass, vintage revision (owner request, 2026-07-31):
    one optional augmentation event as a second cell tranche — augMwh
    of new cells at the start of augYear (partial top-up, full restore
    or expansion beyond nameplate), costed at augCostPerMwh, degrading
    at its own rate — plus an own-asset availability derate compounding
    on the CAPACITY-WEIGHTED cell age. Cannibalisation stays on the
    calendar clock and must not reset."""

    BASE = {"P": 10.0, "E": 20.0, "T": 10, "C": 300.0, "O": 15.0,
            "r": 0.09, "c": 1.0, "delta": 0.05, "eta": 0.8, "a": 50.0,
            "gamma": 0.0, "zTotal": 0.0, "discounting": "end"}
    AUG = {"augYear": 5, "augMwh": 3.0, "augCostPerMwh": 150.0}

    def test_tranche_joins_and_lands_capex(self):
        cf = bess_cashflow({**self.BASE, **self.AUG})
        row5 = cf["rows"][5]
        t1_y5 = 20 * 0.95 ** 4
        self.assertAlmostEqual(row5["usable_mwh"],
                              round(t1_y5 + 3.0, 3), places=3)
        # 3 MWh x 150 GBPk/MWh = £450k in the augmentation year only
        self.assertAlmostEqual(row5["capex_gbp"], -450_000.0, places=2)
        self.assertEqual(cf["rows"][4]["capex_gbp"], 0)
        self.assertEqual(cf["rows"][6]["capex_gbp"], 0)
        # original cells NEVER reset: year 6 original tranche has aged
        # five years; the new tranche one year at the same default rate
        expected_y6 = 20 * 0.95 ** 5 + 3.0 * 0.95
        self.assertAlmostEqual(cf["rows"][6]["usable_mwh"],
                              round(expected_y6, 3), places=3)

    def test_expansion_beyond_nameplate_is_allowed(self):
        cf = bess_cashflow({**self.BASE, "augYear": 5, "augMwh": 10.0,
                           "augCostPerMwh": 150.0})
        self.assertGreater(cf["rows"][5]["usable_mwh"], 20.0)

    def test_new_tranche_degrades_at_its_own_rate(self):
        cf = bess_cashflow({**self.BASE, **self.AUG, "augDelta": 0.02})
        expected_y7 = 20 * 0.95 ** 6 + 3.0 * 0.98 ** 2
        self.assertAlmostEqual(cf["rows"][7]["usable_mwh"],
                              round(expected_y7, 3), places=3)

    def test_all_three_fields_required_or_noop(self):
        plain = bess_cashflow(self.BASE)
        for partial in ({"augYear": 5}, {"augMwh": 3.0},
                        {"augCostPerMwh": 150.0},
                        {"augYear": 5, "augMwh": 3.0},
                        {"augYear": 5, "augCostPerMwh": 150.0},
                        {"augYear": 5, "augMwh": 0, "augCostPerMwh": 150.0}):
            cf = bess_cashflow({**self.BASE, **partial})
            self.assertEqual([r["usable_mwh"] for r in cf["rows"]],
                            [r["usable_mwh"] for r in plain["rows"]], partial)
            self.assertEqual([r["capex_gbp"] for r in cf["rows"]],
                            [r["capex_gbp"] for r in plain["rows"]], partial)

    def test_derate_compounds_on_weighted_age(self):
        plain = bess_cashflow(self.BASE)
        derated = bess_cashflow({**self.BASE, "rho": 0.03})
        # no augmentation: weighted age is exactly n-1
        ratio = (derated["rows"][3]["availability_gbp"]
                / plain["rows"][3]["availability_gbp"])
        self.assertAlmostEqual(ratio, 0.97 ** 2, places=6)
        # with a tranche: weighted age drops in proportion to its size
        aug = bess_cashflow({**self.BASE, "rho": 0.03, **self.AUG})
        t1 = 20 * 0.95 ** 4
        wage = (t1 * 4 + 3.0 * 0) / (t1 + 3.0)
        expected = 50.0 * 1000 * 10 * (1 - 0.03) ** wage
        self.assertAlmostEqual(aug["rows"][5]["availability_gbp"],
                              round(expected, 2), places=2)
        # gamma does not touch the weighted age: with gamma set, year-5
        # availability is the same figure times (1-gamma)^4
        both = bess_cashflow({**self.BASE, "rho": 0.03, "gamma": 0.1,
                             **self.AUG})
        self.assertAlmostEqual(both["rows"][5]["availability_gbp"],
                              round(expected * 0.9 ** 4, 2), places=2)

    def test_lcos_includes_augmentation_capex(self):
        base_res = compute(self.BASE)
        aug_res = compute({**self.BASE, "augYear": 8, "augMwh": 3.0,
                          "augCostPerMwh": 150.0})
        # a late augmentation adds cost with little remaining energy
        # upside inside the window, so LCOS must rise
        self.assertGreater(aug_res["lcos"], base_res["lcos"])

    def test_payback_is_first_crossing(self):
        # profitable asset that repays in ~2 years, then a huge
        # augmentation dips the cumulative line negative again: simple
        # payback must report the FIRST crossing, not the second
        inputs = {"P": 10.0, "E": 20.0, "T": 10, "C": 50.0, "O": 5.0,
                 "r": 0.08, "c": 1.0, "delta": 0.0, "eta": 0.9, "a": 40.0,
                 "gamma": 0.0, "zTotal": 0.0, "discounting": "end",
                 "augYear": 4, "augMwh": 20.0, "augCostPerMwh": 100.0}
        cf = bess_cashflow(inputs)
        flows = [r["net_cashflow_gbp"] for r in cf["rows"] if r["year"] >= 1]
        cum = -cf["c0"]
        crossings = 0
        for f in flows:
            prev, cum = cum, cum + f
            if prev < 0 <= cum:
                crossings += 1
        self.assertGreaterEqual(crossings, 2)  # the scenario really dips
        payback = simple_payback(cf["c0"], flows)
        self.assertIsNotNone(payback)
        self.assertLess(payback, 4)  # first crossing, before the dip


class OpexEscalationTest(unittest.TestCase):
    """User-reported: OPEX is flat across the model, and they want CPI/
    PPI-style indexation (owner request, 2026-08-01). opexEsc applies
    (1+e)^(n-1) to the operating-cost line ONLY — never TNUoS (a
    published tariff) and never the augmentation tranche's one-off
    cost. D23 still holds: blank/0 reproduces today's flat OPEX
    exactly, no market default ships."""

    BASE = {"P": 10.0, "E": 20.0, "T": 5, "C": 100.0, "O": 10.0,
            "r": 0.08, "c": 1.0, "delta": 0.0, "eta": 0.9, "a": 50.0,
            "gamma": 0.0, "zTotal": 0.0, "discounting": "end"}

    def test_opex_year3_equals_base_times_compound_factor(self):
        # No commissioning date -> frac1=1, so year 1 IS the unescalated
        # base: 10 GBPk/MW/yr x 1000 x 10 MW = 100,000. Year 3's
        # escalation exponent is n-1=2, so opex_3 = base x 1.025^2.
        cf = bess_cashflow({**self.BASE, "opexEsc": 0.025})
        year1 = next(r for r in cf["rows"] if r["year"] == 1)
        year3 = next(r for r in cf["rows"] if r["year"] == 3)
        base_opex = -year1["opex_gbp"]
        self.assertAlmostEqual(base_opex, 100_000.0, places=2)
        expected = base_opex * 1.025 ** 2
        self.assertAlmostEqual(-year3["opex_gbp"], round(expected, 2),
                              places=2)

    def test_esc_zero_matches_todays_flat_behaviour(self):
        flat = bess_cashflow(self.BASE)
        esc_zero = bess_cashflow({**self.BASE, "opexEsc": 0})
        self.assertEqual([r["opex_gbp"] for r in flat["rows"]],
                        [r["opex_gbp"] for r in esc_zero["rows"]])
        # blank (key absent entirely) must match the explicit-0 case too
        self.assertEqual([r["opex_gbp"] for r in flat["rows"]],
                        [r["opex_gbp"] for r in bess_cashflow(self.BASE)["rows"]])

    def test_tnuos_and_augmentation_capex_are_not_escalated(self):
        cf = bess_cashflow({**self.BASE, "zTotal": 5.0, "opexEsc": 0.1,
                           "augYear": 3, "augMwh": 3.0,
                           "augCostPerMwh": 150.0})
        tnuos_values = {r["tnuos_gbp"] for r in cf["rows"] if r["year"] >= 1}
        self.assertEqual(len(tnuos_values), 1)  # constant every year
        # the augmentation outflow lands only in its own year, unchanged
        # in magnitude by the OPEX escalation set alongside it
        row3 = next(r for r in cf["rows"] if r["year"] == 3)
        self.assertAlmostEqual(row3["capex_gbp"], -450_000.0, places=2)

    def test_lcos_moves_with_escalation(self):
        flat = compute(self.BASE)
        escalated = compute({**self.BASE, "opexEsc": 0.05})
        self.assertGreater(escalated["lcos"], flat["lcos"])


class MirrTest(unittest.TestCase):
    """MIRR (owner request, 2026-07-31): beside IRR, never instead of
    it. Negatives (incl. year-0 capex) discount to t=0, positives
    compound to the horizon, both at WACC; single-valued where a
    multi-sign-change series gives plain IRR several roots."""

    def test_hand_computed(self):
        # c0=100, flows 60/60/60, r=10%: FV_pos = 60x1.21+60x1.1+60
        # = 198.6, PV_neg = 100, MIRR = 1.986^(1/3)-1
        got = mirr(100.0, [60.0, 60.0, 60.0], 0.10)
        self.assertAlmostEqual(got, 1.986 ** (1 / 3) - 1, places=9)

    def test_none_when_no_positive_flows(self):
        self.assertIsNone(mirr(100.0, [-10.0, -10.0], 0.08))

    def test_none_when_no_negative_flows(self):
        self.assertIsNone(mirr(0.0, [10.0, 10.0], 0.08))

    def test_single_valued_with_two_sign_changes(self):
        # same shape as the first-crossing payback scenario: a series
        # with two sign changes still yields exactly one finite MIRR
        flows = [300.0, 300.0, 300.0, -2000.0, 300.0, 300.0, 300.0,
                300.0, 300.0, 300.0]
        got = mirr(500.0, flows, 0.08)
        self.assertIsNotNone(got)
        self.assertTrue(-1 < got < 1)

    def test_compute_carries_mirr(self):
        base = AugmentationDerateTest.BASE
        res = compute(base)
        cashflows = [r["net_cashflow_gbp"] for r in res["rows"]
                     if r["year"] >= 1]
        self.assertAlmostEqual(res["mirr"],
                              mirr(res["c0"], cashflows, base["r"]),
                              places=12)


class DiscountedPaybackPviDpiTest(unittest.TestCase):
    """DPP/PVI/DPI pass (owner decision, 2026-08-01): the workbook and the
    results panel both retire simple (undiscounted) payback in favour of
    a discounted payback period (DPP), interpolated on DISCOUNTED cash
    flows; a present value of investment (PVI, the discounted value of
    every pound of capital committed); and a discounted profitability
    index (DPI = 1 + NPV/PVI). simple_payback() stays in the engine for
    any external caller (HandComputedTest.test_payback_exact above still
    exercises it), but nothing in the workbook builds it any more.

    DPP is anchor-invariant (re-anchoring scales every discounted figure
    by one factor, cancelling in both the crossing test and the
    interpolation fraction) and convention-aware (it moves with the
    mid-year/end-of-period toggle, the discounted column's own
    property) — see discounted_payback's docstring for the reasoning."""

    def test_hand_computed_dpp(self):
        # c0=100, r=10%, end-of-period, flows 60/60/60: discounted
        # 54.5455/49.5868/45.0789 (60/1.1^n); cumulative -45.4545,
        # +4.1322, +49.2111. Crossing is year 2:
        # DPP = 2-1 + (dcf_2 - cum_2)/dcf_2 = 1 + 45.4545/49.5868
        # = 1.916666...  (rounds to 1.9167 at 4 dp).
        rows = [{"year": 0, "discounted_cashflow_gbp": -100.0}]
        for n in (1, 2, 3):
            rows.append({"year": n, "discounted_cashflow_gbp": 60.0 / 1.1 ** n})
        result = discounted_payback(rows)
        expected = 1 + (60.0 / 1.1 ** 2 - (-100.0 + 60.0 / 1.1 + 60.0 / 1.1 ** 2)) \
            / (60.0 / 1.1 ** 2)
        self.assertAlmostEqual(result, expected, places=9)
        self.assertAlmostEqual(result, 1.9167, places=4)

    def test_null_when_never_crosses(self):
        rows = [{"year": 0, "discounted_cashflow_gbp": -100.0}]
        for n in (1, 2, 3):
            rows.append({"year": n, "discounted_cashflow_gbp": 10.0})
        self.assertIsNone(discounted_payback(rows))

    def test_pvi_with_augmentation(self):
        # c0 = 50 (£k/MW) x 1000 x 10 MW = 500,000; one augmentation
        # event at year 4 (5 MWh at 100 £k/MWh) lands £500,000 of capex
        # in that year's row. PVI = c0 + aug/(1+r)^4, undiscounted
        # magnitude flipped positive (capex_gbp is negative in that
        # year).
        inputs = {"P": 10.0, "E": 20.0, "T": 6, "C": 50.0, "O": 5.0,
                 "r": 0.08, "c": 1.0, "delta": 0.0, "eta": 0.9, "a": 40.0,
                 "gamma": 0.0, "zTotal": 0.0, "discounting": "end",
                 "augYear": 4, "augMwh": 5.0, "augCostPerMwh": 100.0}
        cf = bess_cashflow(inputs)
        c0 = cf["c0"]
        aug_capex = -cf["rows"][4]["capex_gbp"]
        self.assertAlmostEqual(aug_capex, 500_000.0, places=2)
        result = pvi_at_commissioning(c0, cf["rows"], inputs["r"], "end", 1.0)
        expected = c0 + aug_capex / 1.08 ** 4
        self.assertAlmostEqual(result, expected, places=2)

    def test_dpi_below_one_when_npv_negative(self):
        # A clearly loss-making case (thin availability revenue against
        # a large capex) has negative NPV, so DPI = 1 + NPV/PVI must be
        # below 1 (a break-even project has DPI exactly 1; a value-
        # creating one, above).
        inputs = {"P": 10, "E": 20, "T": 3, "C": 500, "O": 50, "r": 0.1,
                 "c": 1, "delta": 0, "eta": 0.9, "a": 5, "gamma": 0,
                 "zTotal": 0, "discounting": "end"}
        result = compute(inputs)
        self.assertLess(result["npv"], 0)
        self.assertIsNotNone(result["dpi"])
        self.assertLess(result["dpi"], 1)

    def test_dpp_anchor_invariant(self):
        # Same discounted payback period with and without a
        # valuationDate in compute(): re-anchoring moves NPV (and PVI)
        # by the shared factor but leaves DPP untouched.
        base = {"P": 10.0, "E": 20.0, "T": 8, "C": 60.0, "O": 5.0,
               "r": 0.09, "c": 1.0, "delta": 0.0, "eta": 0.9, "a": 45.0,
               "gamma": 0.0, "zTotal": 0.0, "discounting": "mid",
               "y0": "2024-03-15"}
        result_plain = compute(base)
        result_valued = compute(dict(base, valuationDate="2030-01-01"))
        self.assertIsNotNone(result_plain["discounted_payback"])
        self.assertNotAlmostEqual(result_plain["npv"], result_valued["npv"],
                                  places=0)  # the valuation date DOES move NPV
        self.assertAlmostEqual(result_valued["discounted_payback"],
                              result_plain["discounted_payback"], places=9)


class TollBlendTest(unittest.TestCase):
    """Toll and financing pass (plan/10 D58/D59, 2026-08-28): for years
    1..tollTenor a share tollShare earns a fixed toll of tollPrice
    £/kW/yr — flat real, pro-rated by year 1's commissioning stub but
    never degraded, cannibalised or derated (availability guarantees
    sit with the operator); the merchant availability+arbitrage pair is
    scaled by (1-tollShare); after the tenor the asset is fully
    merchant again. All three fields set or the agreement is a no-op —
    the augmentation triple's discipline (D59)."""

    BASE = {"P": 10, "E": 20, "T": 3, "C": 100, "O": 10, "r": 0.08,
            "c": 1, "delta": 0, "eta": 0.9, "a": 100, "gamma": 0,
            "zTotal": 0, "discounting": "end"}
    TOLL = {"tollShare": 0.5, "tollPrice": 80, "tollTenor": 2}

    def test_year1_toll_and_blended_availability_by_hand(self):
        # toll_1 = 80 £/kW/yr x 1000 x 10 MW x 0.5 share = 400,000.
        # availability gross = 100 x 1000 x 10 = 1,000,000; post-blend
        # column = gross x (1-0.5) = 500,000.
        cf = bess_cashflow({**self.BASE, **self.TOLL})
        row1 = cf["rows"][1]
        self.assertAlmostEqual(row1["toll_gbp"], 400_000.0, places=2)
        self.assertAlmostEqual(row1["availability_gbp"], 500_000.0, places=2)
        # net = toll + blended availability - opex (100,000) = 800,000
        self.assertAlmostEqual(row1["net_cashflow_gbp"], 800_000.0, places=2)

    def test_toll_invariant_under_gamma_delta_rho(self):
        # Switching gamma/delta/rho on moves the merchant availability
        # line but must NOT move the toll £ (D58: flat real, never
        # degraded, cannibalised or derated). Year 2: availability =
        # 1,000,000 x (1-0.05)^1 [gamma] x (1-0.05)^1 [rho on age n-1=1]
        # x 0.5 [blend] = 451,250; toll stays 400,000.
        plain = bess_cashflow({**self.BASE, **self.TOLL})
        moved = bess_cashflow({**self.BASE, **self.TOLL, "gamma": 0.05,
                              "delta": 0.05, "rho": 0.05})
        for n in (1, 2):
            self.assertEqual(moved["rows"][n]["toll_gbp"],
                             plain["rows"][n]["toll_gbp"], n)
        self.assertAlmostEqual(moved["rows"][2]["toll_gbp"], 400_000.0,
                               places=2)
        self.assertAlmostEqual(moved["rows"][2]["availability_gbp"],
                               451_250.0, places=2)
        self.assertNotEqual(moved["rows"][2]["availability_gbp"],
                            plain["rows"][2]["availability_gbp"])

    def test_tenor_boundary_year3_fully_merchant(self):
        # tollTenor=2 on T=3: year 2 still tolls, year 3 has toll_gbp 0
        # and the availability column back at the UNSCALED merchant
        # figure (1,000,000) — (1-sEff) with sEff=0 after the tenor.
        cf = bess_cashflow({**self.BASE, **self.TOLL})
        self.assertAlmostEqual(cf["rows"][2]["toll_gbp"], 400_000.0,
                               places=2)
        self.assertEqual(cf["rows"][3]["toll_gbp"], 0)
        self.assertAlmostEqual(cf["rows"][3]["availability_gbp"],
                               1_000_000.0, places=2)

    def test_stub_pro_rates_year1_toll(self):
        # y0="2026-07-02": 182 of 365 days elapsed in 2026 (not a leap
        # year), frac1 = 183/365 = 0.5013698630136987 — computed with
        # year_fraction_remaining, the same function the engine uses.
        # toll_1 = 400,000 x 183/365 = 200,547.9452... -> 200,547.95.
        frac1 = year_fraction_remaining("2026-07-02")
        self.assertAlmostEqual(frac1, 183 / 365, places=12)
        cf = bess_cashflow({**self.BASE, **self.TOLL, "y0": "2026-07-02"})
        row1 = cf["rows"][1]
        self.assertAlmostEqual(row1["toll_gbp"],
                               js_round(400_000 * frac1, 2), places=2)
        self.assertAlmostEqual(row1["toll_gbp"], 200_547.95, places=2)
        # year 2 is a full year again: no stub carried forward
        self.assertAlmostEqual(cf["rows"][2]["toll_gbp"], 400_000.0,
                               places=2)

    def test_partial_set_is_a_noop(self):
        # Share set but price absent (and every other partial triple):
        # rows bit-identical to a base run (D59, the augmentation
        # all-or-nothing precedent).
        plain = bess_cashflow(self.BASE)
        for partial in ({"tollShare": 0.5}, {"tollPrice": 80},
                        {"tollTenor": 2},
                        {"tollShare": 0.5, "tollTenor": 2},
                        {"tollShare": 0.5, "tollPrice": 80},
                        {"tollShare": 0.5, "tollPrice": 80, "tollTenor": 0}):
            cf = bess_cashflow({**self.BASE, **partial})
            self.assertEqual(cf["rows"], plain["rows"], partial)


class DebtScheduleTest(unittest.TestCase):
    """Toll and financing pass (plan/10 D59/D61, 2026-08-28): D0 =
    gearing x C0 draws down at year 0 and repays as a level annuity at
    costOfDebt over debtTenor years — contractual-annual, never
    stub-pro-rated; a tenor past T leaves principal outstanding with no
    synthetic balloon. The layer sits BELOW the project line:
    net_cashflow_gbp stays ungeared."""

    # c0 = 200 £k/MW x 1000 x 10 MW = 2,000,000; gearing 0.5 ->
    # D0 = 1,000,000. a=60 -> availability 600,000/yr, opex 100,000/yr,
    # net 500,000/yr flat (no degradation/cannibalisation).
    BASE = {"P": 10, "E": 20, "T": 6, "C": 200, "O": 10, "r": 0.08,
            "c": 1, "delta": 0, "eta": 0.9, "a": 60, "gamma": 0,
            "zTotal": 0, "discounting": "end"}
    DEBT = {"gearing": 0.5, "costOfDebt": 0.05, "debtTenor": 4}

    def test_annuity_payment_hand_computed(self):
        # pay = 1,000,000 x 0.05 / (1 - 1.05^-4); 1.05^4 = 1.21550625,
        # 1.05^-4 = 0.8227024747918819, so the denominator is
        # 0.1772975252081181 and pay = 0.2820118326... x 1,000,000
        # = 282,011.8326...
        pay = annuity_payment(1_000_000, 0.05, 4)
        self.assertAlmostEqual(pay, 1_000_000 * 0.05 / (1 - 1.05 ** -4),
                               places=6)
        self.assertAlmostEqual(pay, 282_011.8326, places=4)

    def test_annuity_payment_zero_rate_is_straight_line(self):
        self.assertEqual(annuity_payment(1_000_000, 0.0, 4), 250_000.0)

    def test_annuity_payment_nonsense_inputs_are_inert(self):
        self.assertEqual(annuity_payment(None, 0.05, 4), 0)
        self.assertEqual(annuity_payment(0, 0.05, 4), 0)
        self.assertEqual(annuity_payment(1_000_000, 0.05, 0), 0)
        self.assertEqual(annuity_payment(1_000_000, None, 4), 0)

    def test_year1_interest_and_balance_retires(self):
        # interest_1 = D0 x 0.05 = 50,000 (column signed -50,000);
        # principal_1 = pay - 50,000 = 232,011.83; balance walks down
        # and the principal columns sum to -D0 within rounding.
        cf = bess_cashflow({**self.BASE, **self.DEBT})
        self.assertEqual(cf["d0"], 1_000_000.0)
        self.assertAlmostEqual(cf["rows"][1]["debt_interest_gbp"],
                               -50_000.0, places=2)
        pay = annuity_payment(1_000_000, 0.05, 4)
        self.assertAlmostEqual(cf["rows"][1]["debt_principal_gbp"],
                               js_round(-(pay - 50_000), 2), places=2)
        # interest_2 = (1,000,000 - 232,011.8326) x 0.05 = 38,399.41
        self.assertAlmostEqual(cf["rows"][2]["debt_interest_gbp"],
                               -38_399.41, places=2)
        total_principal = sum(r["debt_principal_gbp"] for r in cf["rows"])
        self.assertAlmostEqual(total_principal, -1_000_000.0, delta=0.05)
        # after the tenor the columns are dead zero, net stays ungeared
        for n in (5, 6):
            self.assertEqual(cf["rows"][n]["debt_interest_gbp"], 0)
            self.assertEqual(cf["rows"][n]["debt_principal_gbp"], 0)
            self.assertEqual(cf["rows"][n]["equity_cashflow_gbp"],
                             cf["rows"][n]["net_cashflow_gbp"])

    def test_zero_rate_branch_in_the_engine(self):
        # costOfDebt typed as 0 is still an ACTIVE layer (D59: "typed",
        # not "truthy"): straight-line 250,000/yr principal, no interest.
        cf = bess_cashflow({**self.BASE, "gearing": 0.5, "costOfDebt": 0.0,
                           "debtTenor": 4})
        for n in (1, 2, 3, 4):
            self.assertEqual(cf["rows"][n]["debt_interest_gbp"], 0.0)
            self.assertAlmostEqual(cf["rows"][n]["debt_principal_gbp"],
                                   -250_000.0, places=2)

    def test_year0_drawdown_and_equity_contribution(self):
        # Year 0: drawdown +D0; equity = -c0 + D0 = -1,000,000. The
        # project columns are untouched (net_cashflow_gbp stays -c0).
        cf = bess_cashflow({**self.BASE, **self.DEBT})
        row0 = cf["rows"][0]
        self.assertAlmostEqual(row0["debt_drawdown_gbp"], 1_000_000.0,
                               places=2)
        self.assertAlmostEqual(row0["equity_cashflow_gbp"], -1_000_000.0,
                               places=2)
        self.assertAlmostEqual(row0["net_cashflow_gbp"], -2_000_000.0,
                               places=2)

    def test_tenor_past_horizon_leaves_principal_outstanding(self):
        # debtTenor=10 on T=3 (D61): the walk simply stops at the
        # horizon — no synthetic balloon row, principal repaid < D0.
        cf = bess_cashflow({**self.BASE, "T": 3, "gearing": 0.5,
                           "costOfDebt": 0.05, "debtTenor": 10})
        self.assertEqual(len(cf["rows"]), 4)  # year 0 + 3 years, no extras
        total_principal = -sum(r["debt_principal_gbp"] for r in cf["rows"])
        self.assertGreater(total_principal, 0)
        self.assertLess(total_principal, 1_000_000.0)

    def test_gearing_without_cost_of_debt_is_a_noop(self):
        # The debt triple follows the same all-or-nothing discipline as
        # the toll and augmentation triples (D59): gearing alone (no
        # costOfDebt typed) must be bit-identical to the base run.
        plain = bess_cashflow(self.BASE)
        cf = bess_cashflow({**self.BASE, "gearing": 0.5})
        self.assertEqual(cf["rows"], plain["rows"])
        self.assertEqual(cf["d0"], 0)


class EquityIrrDscrTest(unittest.TestCase):
    """Toll and financing pass (plan/10 D55/D60/D65, 2026-08-28):
    equity IRR = irr() over the equity_cashflow_gbp column with
    c0 - D0 at time zero; DSCR_n = net_cashflow_gbp_n / debt service_n
    (CFADS = project net cash flow, the honest in-model reading, D60).
    Positive leverage: with the cost of debt below the project IRR, the
    equity IRR must land above it."""

    # c0 = 1,000,000; availability 500,000/yr, opex 100,000/yr -> net
    # 400,000/yr flat over 10 years; project IRR solves
    # 400,000 x annuity(r,10) = 1,000,000 -> ~38.45%, far above the 5%
    # cost of debt.
    BASE = {"P": 10, "E": 20, "T": 10, "C": 100, "O": 10, "r": 0.08,
            "c": 1, "delta": 0, "eta": 0.9, "a": 50, "gamma": 0,
            "zTotal": 0, "discounting": "end"}
    DEBT = {"gearing": 0.5, "costOfDebt": 0.05, "debtTenor": 10}

    def test_positive_leverage_lifts_equity_irr_above_project_irr(self):
        plain = compute(self.BASE)
        geared = compute({**self.BASE, **self.DEBT})
        self.assertIsNotNone(plain["irr"])
        self.assertIsNotNone(geared["equity_irr"])
        self.assertGreater(plain["irr"], self.DEBT["costOfDebt"])
        self.assertGreater(geared["equity_irr"], plain["irr"])
        # gearing never touches the project line
        self.assertEqual(geared["irr"], plain["irr"])

    def test_engine_dscr_flat_annuity_case(self):
        # Level annuity on a flat 400,000 CFADS: service is the constant
        # pay = 500,000 x 0.05 / (1 - 1.05^-10) = 64,752.29, so every
        # year's DSCR is 400,000 / 64,752.29 = 6.1774 and min == avg
        # (bar cent-level column rounding).
        res = compute({**self.BASE, **self.DEBT})
        pay = annuity_payment(500_000, 0.05, 10)
        self.assertAlmostEqual(res["dscr_min"], 400_000 / pay, places=4)
        self.assertAlmostEqual(res["dscr_min"], res["dscr_avg"], places=4)
        self.assertIsNone(res["dscr_min_toll"])  # no toll set
        self.assertEqual(res["dscr_min_post"], res["dscr_min"])

    def test_dscr_stats_hand_figures(self):
        # Synthetic rows, service 100 in years 1-3 (columns signed
        # negative), none in year 4: DSCRs 1.5 / 1.2 / 1.8. With
        # tollTenor=2: min 1.2 (year 2), avg (1.5+1.2+1.8)/3 = 1.5,
        # minToll min(1.5,1.2) = 1.2, avgToll 1.35, minPost = avgPost
        # = 1.8.
        def row(year, net, interest, principal):
            return {"year": year, "net_cashflow_gbp": net,
                    "debt_interest_gbp": interest,
                    "debt_principal_gbp": principal}
        rows = [row(0, -1000, 0, 0),
                row(1, 150.0, -50.0, -50.0),
                row(2, 120.0, -40.0, -60.0),
                row(3, 180.0, -20.0, -80.0),
                row(4, 200.0, 0, 0)]
        stats = dscr_stats(rows, 2)
        self.assertAlmostEqual(stats["min"], 1.2, places=9)
        self.assertEqual(stats["minYear"], 2)
        self.assertAlmostEqual(stats["avg"], 1.5, places=9)
        self.assertAlmostEqual(stats["minToll"], 1.2, places=9)
        self.assertAlmostEqual(stats["avgToll"], 1.35, places=9)
        self.assertAlmostEqual(stats["minPost"], 1.8, places=9)
        self.assertAlmostEqual(stats["avgPost"], 1.8, places=9)
        # tollTenor=0: everything lands in the post/merchant bucket
        merchant = dscr_stats(rows, 0)
        self.assertIsNone(merchant["minToll"])
        self.assertAlmostEqual(merchant["minPost"], 1.2, places=9)

    def test_dscr_stats_none_with_no_debt(self):
        cf = bess_cashflow(self.BASE)
        self.assertIsNone(dscr_stats(cf["rows"], 0))
        self.assertIsNone(dscr_stats([], 0))
        self.assertIsNone(dscr_stats(None, 0))

    def test_equity_irr_none_when_ungeared(self):
        # d0 == 0: an "equity IRR" would just duplicate the project IRR
        # (equity flows ARE the project flows) — compute() returns None
        # and the card shows no tile.
        res = compute(self.BASE)
        self.assertEqual(res["d0"], 0)
        self.assertIsNone(res["equity_irr"])
        self.assertIsNone(res["dscr_min"])
        self.assertIsNone(res["dscr_avg"])


class TollDebtDefaultOffTest(unittest.TestCase):
    """Plan/10's standing guarantee: defaults (tolled share 0, gearing
    0) reproduce today's engine EXACTLY — bit-for-bit row equality, not
    merely almost-equal — so the untouched bess_case_1..8 parity
    fixtures stay valid without recapture."""

    BASE = {"P": 10.0, "E": 20.0, "T": 10, "C": 300.0, "O": 15.0,
            "r": 0.09, "c": 1.0, "delta": 0.05, "eta": 0.8, "a": 50.0,
            "gamma": 0.02, "zTotal": 5.0, "discounting": "mid",
            "y0": "2026-07-02", "opexEsc": 0.02, "rho": 0.01,
            "augYear": 5, "augMwh": 3.0, "augCostPerMwh": 150.0}

    EXPLICIT_OFF = {"tollShare": 0, "tollPrice": 0, "tollTenor": 0,
                    "gearing": 0, "costOfDebt": None, "debtTenor": 0}

    def test_no_keys_vs_explicit_zeros_exact_equality(self):
        plain = bess_cashflow(self.BASE)
        explicit = bess_cashflow({**self.BASE, **self.EXPLICIT_OFF})
        self.assertEqual(plain["c0"], explicit["c0"])
        self.assertEqual(plain["d0"], explicit["d0"])
        self.assertEqual(plain["d0"], 0)
        self.assertEqual(plain["rows"], explicit["rows"])  # exact, per row

    def test_new_columns_all_zero_and_equity_equals_net(self):
        cf = bess_cashflow(self.BASE)
        for row in cf["rows"]:
            self.assertEqual(row["toll_gbp"], 0, row["year"])
            self.assertEqual(row["debt_drawdown_gbp"], 0, row["year"])
            self.assertEqual(row["debt_interest_gbp"], 0, row["year"])
            self.assertEqual(row["debt_principal_gbp"], 0, row["year"])
            self.assertEqual(row["equity_cashflow_gbp"],
                             row["net_cashflow_gbp"], row["year"])

    def test_old_fixture_inputs_still_reproduce_expected_rows(self):
        # Belt for the braces JsPythonParityTest already provides: an
        # OLD fixture inputs dict (no toll/debt keys anywhere) must
        # still produce rows matching its captured expected.json values
        # for every ORIGINAL key.
        inputs = json.loads(
            (FIXTURES / "bess_case_1" / "inputs.json").read_text())
        expected = json.loads(
            (FIXTURES / "bess_case_1" / "expected.json").read_text())
        cf = bess_cashflow(inputs)
        self.assertEqual(cf["c0"], expected["c0"])
        self.assertEqual(cf["d0"], 0)
        self.assertEqual(len(cf["rows"]), len(expected["rows"]))
        for i, (got_row, want_row) in enumerate(zip(cf["rows"],
                                                    expected["rows"])):
            for key, want in want_row.items():
                self.assertAlmostEqual(got_row[key], want, delta=1e-6,
                                       msg=f"rows[{i}].{key}")


class ArbitrageMarginFormulaTest(unittest.TestCase):
    """Test plan item 4: (s_hi - s_lo / eta), never (s_hi - s_lo) x eta.
    D26's measured d=2h figures: mean top £120.79, mean bottom £53.28,
    85% RTE -> the two formulas diverge by about 1.3%."""

    def test_correct_formula(self):
        result = arbitrage_ceiling(120.79, 53.28, 0.85)
        self.assertAlmostEqual(result, 120.79 - 53.28 / 0.85, places=6)

    def test_diverges_from_wrong_formula_by_measured_margin(self):
        correct = arbitrage_ceiling(120.79, 53.28, 0.85)
        wrong = (120.79 - 53.28) * 0.85
        diff_pct = abs(correct - wrong) / wrong
        self.assertGreater(diff_pct, 0.010)
        self.assertLess(diff_pct, 0.020)  # "about 1.3%"
        self.assertNotAlmostEqual(correct, wrong, places=1)

    def test_gap_widens_as_efficiency_falls(self):
        gap_at_85 = abs(arbitrage_ceiling(120.79, 53.28, 0.85)
                        - (120.79 - 53.28) * 0.85)
        gap_at_60 = abs(arbitrage_ceiling(120.79, 53.28, 0.60)
                        - (120.79 - 53.28) * 0.60)
        self.assertGreater(gap_at_60, gap_at_85)

    def test_null_safe(self):
        self.assertIsNone(arbitrage_ceiling(None, 50, 0.85))
        self.assertIsNone(arbitrage_ceiling(100, None, 0.85))
        self.assertIsNone(arbitrage_ceiling(100, 50, 0))


class ObservedArbitrageSpreadTest(unittest.TestCase):
    """v1.5, D26 pulled forward: the observed ceiling computed client-
    side over the already-loaded price series. Synthetic half-hourly
    series, hand-computed expectations — no network, no real payload."""

    def _day(self, day_index, prices):
        """48 half-hourly timestamps (epoch seconds) for UTC day
        `day_index`, paired with `prices` (may be shorter than 48 for an
        incomplete day)."""
        base = day_index * 86400
        return [(base + i * 1800, prices[i] if i < len(prices) else None)
               for i in range(48)]

    def test_complete_day_top2_bottom2_at_1h_duration(self):
        # d=1h -> n = round(2*1) = 2 half-hourly periods.
        prices = list(range(1, 49))  # 1..48, fully populated (48 >= 46)
        rows = self._day(0, prices)
        ts = [r[0] for r in rows]
        price = [r[1] for r in rows]
        result = observed_arbitrage_spread(ts, price, 1.0)
        self.assertIsNotNone(result)
        self.assertEqual(result["days"], 1)
        # top 2 = [47, 48] -> mean 47.5; bottom 2 = [1, 2] -> mean 1.5
        self.assertAlmostEqual(result["sHi"], 47.5, places=9)
        self.assertAlmostEqual(result["sLo"], 1.5, places=9)

    def test_incomplete_day_excluded(self):
        # Only 40 populated periods (< 46) -> the whole day is dropped.
        rows = self._day(0, list(range(1, 41)))
        ts = [r[0] for r in rows]
        price = [r[1] for r in rows]
        result = observed_arbitrage_spread(ts, price, 1.0)
        self.assertIsNone(result)

    def test_averaged_across_multiple_complete_days(self):
        day0 = self._day(0, list(range(1, 49)))      # top2=47.5, bot2=1.5
        day1 = self._day(1, [x + 100 for x in range(1, 49)])  # top2=147.5, bot2=101.5
        rows = day0 + day1
        ts = [r[0] for r in rows]
        price = [r[1] for r in rows]
        result = observed_arbitrage_spread(ts, price, 1.0)
        self.assertEqual(result["days"], 2)
        self.assertAlmostEqual(result["sHi"], (47.5 + 147.5) / 2, places=9)
        self.assertAlmostEqual(result["sLo"], (1.5 + 101.5) / 2, places=9)

    def test_duration_sets_period_count_rounds_half_up(self):
        # d=1.25h -> 2d=2.5 -> Math.round rounds HALF AWAY FROM ZERO -> 3,
        # not Python's banker's-rounding 2. Confirms the JS-matching
        # rounding, not bare Python round().
        prices = list(range(1, 49))
        rows = self._day(0, prices)
        ts = [r[0] for r in rows]
        price = [r[1] for r in rows]
        result = observed_arbitrage_spread(ts, price, 1.25)
        # top 3 = [46,47,48] -> mean 47; bottom 3 = [1,2,3] -> mean 2
        self.assertAlmostEqual(result["sHi"], 47.0, places=9)
        self.assertAlmostEqual(result["sLo"], 2.0, places=9)

    def test_no_series_returns_none(self):
        self.assertIsNone(observed_arbitrage_spread([], [], 2.0))
        self.assertIsNone(observed_arbitrage_spread(None, None, 2.0))

    def test_no_duration_returns_none(self):
        rows = self._day(0, list(range(1, 49)))
        ts = [r[0] for r in rows]
        price = [r[1] for r in rows]
        self.assertIsNone(observed_arbitrage_spread(ts, price, 0))
        self.assertIsNone(observed_arbitrage_spread(ts, price, None))

    def test_nulls_dont_count_toward_completeness(self):
        # 45 non-null + 3 nulls = 48 slots, but only 45 populated (< 46)
        prices = list(range(1, 46)) + [None, None, None]
        rows = self._day(0, prices)
        ts = [r[0] for r in rows]
        price = [r[1] for r in rows]
        self.assertIsNone(observed_arbitrage_spread(ts, price, 1.0))


class TnuosTest(unittest.TestCase):
    """Test plan item 5: distribution returns not-applicable (None), not
    zero; a zone-1 case reproduces the FY2027 Final elements; a 26-zone
    payload raises."""

    def test_distribution_connected_is_not_applicable(self):
        result = tnuos_charge("E", ZONE_1_FY2027_FINAL, 0.083)
        self.assertIsNone(result)

    def test_not_applicable_distinguishable_from_zero(self):
        # A transmission zone whose elements happen to sum to exactly
        # zero must still be a NUMBER (0.0), never confused with None.
        zero_zone = {"peak": 0, "yr_shared": 0, "yr_notshared": 0,
                    "residual": 0}
        result = tnuos_charge("T", zero_zone, 0.083)
        self.assertIsNotNone(result)
        self.assertEqual(result, 0.0)
        self.assertIsNone(tnuos_charge("E", zero_zone, 0.083))

    def test_zone_1_fy2027_final(self):
        f = 1 * 2 / 24  # c=1 cycle/day, d=2h -> f = c x d / 24
        result = tnuos_charge("T", ZONE_1_FY2027_FINAL, f)
        expected = (3.628 + f * (26.533 + 17.675) - 2.477)
        self.assertAlmostEqual(result, expected, places=6)

    def test_26_zones_raises(self):
        zones = [{"n": i, "name": str(i), "peak": 0, "yr_shared": 0,
                 "yr_notshared": 0, "residual": 0, "small_gen_discount": 0}
                for i in range(1, 27)]  # 26 entries
        with self.assertRaises(ZoneTableError):
            assert_zone_table(zones, "2026-01-30")

    def test_27_zones_with_published_date_passes(self):
        zones = [{"n": i} for i in range(1, 28)]
        assert_zone_table(zones, "2026-01-30")  # must not raise

    def test_missing_published_date_raises(self):
        zones = [{"n": i} for i in range(1, 28)]
        with self.assertRaises(ZoneTableError):
            assert_zone_table(zones, None)


class DiscountingConventionTest(unittest.TestCase):
    """Owner request (2026-07): the engine states a discounting
    convention, defaulting to mid-year, (1+r)^(n-0.5); end-of-period,
    (1+r)^n, is the original behaviour, unchanged. IRR and simple
    payback are defined on undiscounted flows and must not move between
    the two conventions.

    Hand-computed stub case, independent of bess_case_5/6's fixtures
    above (both captured from a real browser's Metrics.bessCashflow, the
    house oracle convention): P=10 MW, C0 = 100 x 1000 x 10 = 1,000,000;
    a=50 £/kW/yr -> full-year availability 50 x 1000 x 10 = 500,000;
    O=10 £k/MW/yr -> full-year opex 10 x 1000 x 10 = 100,000; no
    degradation, cannibalisation, TNUoS or arbitrage. r=10%.

    Year-1 STUB: y0="2026-07-02" -> frac1 = year_fraction_remaining(y0)
    = 0.5013698630136987 (182 of 365 days elapsed in 2026, not a leap
    year). The stub's own mid-year exponent is
    (1-frac1) + frac1/2 = 1 - frac1/2 = 0.7493150684931506, NOT the
    general n-0.5 = 0.5 a full year 1 would get. By hand:
      availability_1 = 500,000 x frac1 = 250,684.93 (rounded)
      opex_1         = 100,000 x frac1 =  50,136.99 (rounded)
      net_1          = availability_1 - opex_1 = 200,547.95 (rounded)
      discounted_1   = net_1 / 1.1^0.7493150684931506 = 186,724.8...
    which matches tests/fixtures/bess_case_6/expected.json's year-1 row
    exactly (186724.82, rounded to the cent)."""

    BASE = {"P": 10, "E": 20, "T": 3, "C": 100, "O": 10, "r": 0.1,
           "c": 1, "delta": 0, "eta": 0.9, "a": 50, "gamma": 0,
           "zTotal": 0}

    def test_end_of_period_is_the_plain_n_exponent(self):
        cf = bess_cashflow(dict(self.BASE, discounting="end"))
        year1 = next(r for r in cf["rows"] if r["year"] == 1)
        year2 = next(r for r in cf["rows"] if r["year"] == 2)
        self.assertAlmostEqual(year1["discounted_cashflow_gbp"],
                               400000 / 1.1 ** 1, places=2)
        self.assertAlmostEqual(year2["discounted_cashflow_gbp"],
                               400000 / 1.1 ** 2, places=2)

    def test_mid_year_is_the_default_with_no_discounting_field_at_all(self):
        cf = bess_cashflow(dict(self.BASE))  # no "discounting" key at all
        year1 = next(r for r in cf["rows"] if r["year"] == 1)
        year2 = next(r for r in cf["rows"] if r["year"] == 2)
        self.assertAlmostEqual(year1["discounted_cashflow_gbp"],
                               400000 / 1.1 ** 0.5, places=2)
        self.assertAlmostEqual(year2["discounted_cashflow_gbp"],
                               400000 / 1.1 ** 1.5, places=2)

    def test_stub_degenerates_to_n_minus_half_with_no_commissioning_date(self):
        # frac1=1 (no y0) -> (1-1)+1/2 = 0.5, identical to the general
        # n-0.5 rule: the stub formula is not a special case, it is the
        # same formula with frac1=1.
        self.assertAlmostEqual(discount_exponent(1, 1.0, "mid"), 0.5, places=9)

    def test_mid_year_stub_exponent_hand_computed(self):
        frac1 = year_fraction_remaining("2026-07-02")
        self.assertAlmostEqual(frac1, 0.5013698630136987, places=9)
        stub_exponent = discount_exponent(1, frac1, "mid")
        self.assertAlmostEqual(stub_exponent, 1 - frac1 / 2, places=9)
        self.assertAlmostEqual(stub_exponent, 0.7493150684931506, places=9)
        # A full (non-stub) year 1 would discount at 0.5, not 0.749...:
        # the stub is genuinely later in the year, not merely shorter.
        self.assertGreater(stub_exponent, 0.5)

        inputs = dict(self.BASE, y0="2026-07-02", T=2, discounting="mid")
        cf = bess_cashflow(inputs)
        year1 = next(r for r in cf["rows"] if r["year"] == 1)
        availability_1 = 50 * 1000 * 10 * frac1
        opex_1 = 10 * 1000 * 10 * frac1
        net_1 = availability_1 - opex_1
        expected_discounted_1 = net_1 / (1.1 ** stub_exponent)
        self.assertAlmostEqual(year1["net_cashflow_gbp"], round(net_1, 2),
                               places=2)
        self.assertAlmostEqual(year1["discounted_cashflow_gbp"],
                               expected_discounted_1, places=1)
        self.assertAlmostEqual(year1["discounted_cashflow_gbp"], 186724.82,
                               places=2)

    def test_irr_and_payback_unaffected_by_convention(self):
        cf_mid = bess_cashflow(dict(self.BASE, discounting="mid"))
        cf_end = bess_cashflow(dict(self.BASE, discounting="end"))
        cashflows_mid = [r["net_cashflow_gbp"] for r in cf_mid["rows"]
                         if r["year"] >= 1]
        cashflows_end = [r["net_cashflow_gbp"] for r in cf_end["rows"]
                         if r["year"] >= 1]
        self.assertEqual(cashflows_mid, cashflows_end)  # same undiscounted flows
        self.assertEqual(irr(cf_mid["c0"], cashflows_mid),
                         irr(cf_end["c0"], cashflows_end))
        self.assertEqual(simple_payback(cf_mid["c0"], cashflows_mid),
                         simple_payback(cf_end["c0"], cashflows_end))

    def test_npv_headline_matches_bess_cashflow_cumulative(self):
        # compute()'s headline "npv" must agree with bess_cashflow's own
        # cumulative_discounted_gbp last row under the same convention
        # (small cent-level drift is expected: compute()/npv() sum
        # unrounded per-year discounted amounts, bess_cashflow rounds
        # each year before accumulating — the same pre-existing quirk as
        # the end-of-period path, not something this feature introduces).
        result = compute(dict(self.BASE, y0="2026-07-02", T=2,
                              discounting="mid"))
        self.assertAlmostEqual(result["npv"],
                               result["rows"][-1]["cumulative_discounted_gbp"],
                               places=0)


class ReanchorNpvTest(unittest.TestCase):
    """Owner request, 2026-07: Metrics.reanchorNpv / reanchor_npv re-anchor
    the headline NPV from t=0 (commissioning) to a chosen valuation date,
    by one exact factor, (1+r)^(years between the two). Hand-computed,
    the same discipline as DiscountingConventionTest's
    test_mid_year_stub_exponent_hand_computed above: this is a short,
    exactly-checkable arithmetic identity, not something that needs a
    browser-captured oracle (there is no separate JS test runner in this
    repo; JS/Python parity for this function was additionally confirmed
    by hand against a live Metrics.reanchorNpv call in the browser during
    implementation, reproducing the same figures below to float
    precision).

    2020-01-01 to 2024-01-01 spans exactly 1,461 days (2020 and 2024 are
    both post-2000 leap years, so the span is 366+365+365+365), and
    1,461 / 365.25 = 4.0 exactly — a clean round-trip case chosen
    deliberately so the exponent is an integer and the arithmetic is
    checkable by hand: 1.08^4 = 1.36048896."""

    def test_forward_reanchor_valuation_after_commissioning(self):
        # y0 in the past, valuation date later: NPV compounds FORWARD.
        got = reanchor_npv(1000.0, 0.08, "2020-01-01", "2024-01-01")
        self.assertAlmostEqual(got, 1000.0 * 1.08 ** 4, places=6)
        self.assertAlmostEqual(got, 1360.48896, places=5)

    def test_backward_reanchor_valuation_before_commissioning(self):
        # The identity runs in reverse with no separate branch: a
        # valuation date BEFORE commissioning (a pre-decision appraisal)
        # discounts back by the same factor, inverted.
        got = reanchor_npv(1360.48896, 0.08, "2024-01-01", "2020-01-01")
        self.assertAlmostEqual(got, 1360.48896 / 1.08 ** 4, places=6)
        self.assertAlmostEqual(got, 1000.0, places=4)

    def test_round_trip_is_the_identity(self):
        # Forward then back reproduces the original NPV exactly (bar
        # float noise): the SAME function, called with its two dates
        # swapped, is its own inverse.
        forward = reanchor_npv(1000.0, 0.08, "2020-01-01", "2024-01-01")
        back = reanchor_npv(forward, 0.08, "2024-01-01", "2020-01-01")
        self.assertAlmostEqual(back, 1000.0, places=6)

    def test_blank_valuation_date_defaults_to_commissioning_factor_one(self):
        # D30's stated default: a blank valuation date is factor 1, i.e.
        # the commissioning-anchored NPV passes through unchanged.
        self.assertEqual(reanchor_npv(1000.0, 0.08, "2020-01-01", None), 1000.0)
        self.assertEqual(reanchor_npv(1000.0, 0.08, "2020-01-01", ""), 1000.0)
        # Same date on both ends is the same conclusion by another route
        # (the exponent is exactly 0).
        self.assertAlmostEqual(
            reanchor_npv(1000.0, 0.08, "2020-01-01", "2020-01-01"), 1000.0, places=9)

    def test_missing_commissioning_date_is_null_safe(self):
        # No y0 -> no reference date to measure a span against -> the
        # NPV passes through unchanged, regardless of valuationDate.
        self.assertEqual(reanchor_npv(1000.0, 0.08, None, "2024-01-01"), 1000.0)
        self.assertEqual(reanchor_npv(1000.0, 0.08, "", "2024-01-01"), 1000.0)

    def test_null_npv_passes_through(self):
        self.assertIsNone(reanchor_npv(None, 0.08, "2020-01-01", "2024-01-01"))

    def test_compute_reanchors_the_headline_npv(self):
        # compute()'s "npv" is the re-anchored figure; "npv_at_commissioning"
        # is preserved unchanged (bit-identical to what "npv" used to be,
        # and to what it still is for every fixture without a
        # valuationDate, all eight of which are exercised in
        # JsPythonParityTest above with none of this feature engaged).
        base = {"P": 10, "E": 20, "y0": "2020-01-01", "T": 2, "C": 100,
               "O": 10, "r": 0.08, "c": 1, "delta": 0, "eta": 0.9, "a": 50,
               "gamma": 0, "zTotal": 0, "discounting": "end"}
        result_plain = compute(base)
        result_reanchored = compute(dict(base, valuationDate="2024-01-01"))
        self.assertEqual(result_reanchored["npv_at_commissioning"],
                         result_plain["npv_at_commissioning"])
        self.assertEqual(result_plain["npv"], result_plain["npv_at_commissioning"])
        self.assertAlmostEqual(
            result_reanchored["npv"],
            result_reanchored["npv_at_commissioning"] * 1.08 ** 4, places=6)
        # IRR, simple payback and LCOS are untouched by the valuation date.
        self.assertEqual(result_reanchored["irr"], result_plain["irr"])
        self.assertEqual(result_reanchored["simple_payback"],
                         result_plain["simple_payback"])
        self.assertEqual(result_reanchored["lcos"], result_plain["lcos"])


class DoubleCountGuardTest(unittest.TestCase):
    """Test plan item 7: the availability term is a x 1000 x P and must
    never reference a participation/acceptance field, even when one is
    present in the inputs. A regression fixture pins a deliberately
    non-trivial participation value (0.42, matching D21's measured
    example) so a future change that starts multiplying by it would fail
    this test immediately."""

    def test_participation_field_ignored(self):
        base = {"P": 10, "E": 20, "T": 1, "C": 100, "O": 0, "r": 0.08,
               "c": 1, "delta": 0, "eta": 0.9, "a": 50, "gamma": 0,
               "zTotal": 0}
        with_participation = dict(base, participation=0.42)
        cf_a = bess_cashflow(base)
        cf_b = bess_cashflow(with_participation)
        year1_a = next(r for r in cf_a["rows"] if r["year"] == 1)
        year1_b = next(r for r in cf_b["rows"] if r["year"] == 1)
        self.assertEqual(year1_a["availability_gbp"], year1_b["availability_gbp"])
        self.assertEqual(year1_a["availability_gbp"], 50 * 1000 * 10)

    def test_source_does_not_reference_participation_or_acceptance(self):
        src = (PROJECT_ROOT / "ops" / "bess_calculator_figures.py").read_text()
        # Only this docstring/comment context may name them; the
        # arithmetic itself (the "availability" line) must not.
        for line in src.splitlines():
            if "availability = a * 1000" in line or "availability_gbp" in line:
                self.assertNotIn("participation", line)
                self.assertNotIn("acceptance", line)


class JsPythonParityTest(unittest.TestCase):
    """Test plan item 8. Fixtures captured from the app's real
    Metrics.bessCashflow/npv/irr/simplePayback/lcos in a live browser
    (2026-07-30), mirroring tests/test_merit_panel_figures.py's oracle
    convention exactly."""

    def assert_close(self, got, want, label):
        if want is None:
            self.assertIsNone(got, label)
        else:
            self.assertIsInstance(got, (int, float), label)
            self.assertAlmostEqual(got, want, delta=1e-6, msg=label)

    def test_parity_all_cases(self):
        for case in CASES:
            with self.subTest(case=case):
                inputs = json.loads((FIXTURES / case / "inputs.json").read_text())
                expected = json.loads((FIXTURES / case / "expected.json").read_text())
                result = compute(inputs)
                self.assertNotIn("error", result, case)
                self.assert_close(result["c0"], expected["c0"], f"{case}.c0")
                self.assert_close(result["npv"], expected["npv"], f"{case}.npv")
                self.assert_close(result["irr"], expected["irr"], f"{case}.irr")
                self.assert_close(result["simple_payback"],
                                  expected["simple_payback"],
                                  f"{case}.simple_payback")
                self.assert_close(result["lcos"], expected["lcos"], f"{case}.lcos")
                self.assertEqual(len(result["rows"]), len(expected["rows"]), case)
                for i, (got_row, want_row) in enumerate(
                        zip(result["rows"], expected["rows"])):
                    for key, want in want_row.items():
                        self.assert_close(got_row[key], want,
                                          f"{case}.rows[{i}].{key}")

    def test_cases_span_repay_and_never_repay(self):
        # Guards against the fixtures collapsing to one regime silently.
        outcomes = set()
        for case in CASES:
            expected = json.loads((FIXTURES / case / "expected.json").read_text())
            outcomes.add(expected["irr"] is None)
        self.assertEqual(outcomes, {True, False})


class JsRoundToFixedParityTest(unittest.TestCase):
    """js_round must reproduce JS Number.prototype.toFixed exactly — same
    cases as tests/test_merit_panel_figures.py's oracle (this module
    reuses the identical helper, not a reimplementation)."""

    CASES = [(11.225, 2, 11.22), (85.605, 2, 85.61), (0.5, 0, 1), (-1.5, 0, -2)]

    def test_matches_browser_tofixed(self):
        for value, dp, want in self.CASES:
            with self.subTest(value=value, dp=dp):
                self.assertAlmostEqual(js_round(value, dp), want, delta=1e-12)


class YearFractionRemainingTest(unittest.TestCase):
    def test_no_date_is_full_year(self):
        self.assertEqual(year_fraction_remaining(None), 1.0)

    def test_jan_1_is_full_year(self):
        self.assertAlmostEqual(year_fraction_remaining("2026-01-01"), 1.0,
                               places=6)

    def test_dec_31_is_tiny_fraction(self):
        result = year_fraction_remaining("2026-12-31")
        self.assertGreater(result, 0)
        self.assertLess(result, 1 / 300)


class NoStorageNoUrlStateGuardTest(unittest.TestCase):
    """Test plan item 9: a static source assertion, same family as
    plan/08's "no EXTRACT(" check — it cannot flake because it never
    touches a browser or the network."""

    FORBIDDEN = ("localStorage", "sessionStorage", "URLSearchParams",
                "location.search", "location.hash")

    def test_app_js_and_html_carry_no_storage_or_url_state(self):
        js_dir = PROJECT_ROOT / "app" / "js"
        files = list(js_dir.glob("*.js")) + [PROJECT_ROOT / "app" / "index.html"]
        for path in files:
            text = path.read_text()
            for token in self.FORBIDDEN:
                self.assertNotIn(token, text,
                                 f"{token!r} found in {path.name}")


class CsvExportShapeTest(unittest.TestCase):
    """Test plan item 10: every exported field parses as a number, and
    the row schema carries no unit/party/site name column — the same
    house rule Metrics.toCsv documents and the BMU snapshot table already
    applies."""

    def test_row_schema_is_exactly_the_closed_set(self):
        inputs = {"P": 10, "E": 20, "T": 3, "C": 100, "O": 10, "r": 0.08,
                 "c": 1, "delta": 0, "eta": 0.9, "a": 50, "gamma": 0,
                 "zTotal": 5}
        cf = bess_cashflow(inputs)
        for row in cf["rows"]:
            self.assertEqual(set(row.keys()), set(CSV_COLUMNS))

    def test_every_field_is_numeric(self):
        inputs = {"P": 10, "E": 20, "T": 3, "C": 100, "O": 10, "r": 0.08,
                 "c": 1, "delta": 0, "eta": 0.9, "a": 50, "gamma": 0,
                 "zTotal": 5}
        cf = bess_cashflow(inputs)
        for row in cf["rows"]:
            for key, value in row.items():
                self.assertIsInstance(value, (int, float),
                                      f"{key} is not numeric: {value!r}")
                self.assertNotIsInstance(value, bool)

    def test_no_name_like_field_in_schema(self):
        for key in CSV_COLUMNS:
            for forbidden in ("name", "party", "site", "unit", "owner"):
                self.assertNotIn(forbidden, key.lower())


class EtlTripwiresTest(unittest.TestCase):
    """Test plan item 11."""

    def test_cohort_count_within_band_passes(self):
        assert_cohort_count(89, 89)  # must not raise
        assert_cohort_count(60, 89)  # 67%, within 50-150%

    def test_cohort_count_out_of_band_raises(self):
        with self.assertRaises(CohortCountMismatch):
            assert_cohort_count(10, 89)  # 11%, below 50%

    def test_empty_cohort_raises(self):
        with self.assertRaises(CohortCountMismatch):
            assert_cohort_count(0, 89)

    def test_absent_sibling_is_a_noop(self):
        assert_cohort_count(89, None)  # fresh clone, no sibling yet

    def test_mean_agreement_within_tolerance_passes(self):
        assert_mean_agreement(0.0293, 0.0296)  # ~1% apart

    def test_mean_agreement_out_of_tolerance_raises(self):
        with self.assertRaises(MeanAgreementMismatch):
            assert_mean_agreement(0.0200, 0.0296)  # ~32% apart

    def test_mean_agreement_absent_sibling_is_a_noop(self):
        assert_mean_agreement(0.0293, None)


class PayloadBudgetTest(unittest.TestCase):
    """Test plan item 12: the built fixture (and the real payload)
    serialises under the 40 kB budget."""

    def test_budget_constant_is_40kb(self):
        self.assertEqual(PAYLOAD_BUDGET_BYTES, 40 * 1024)

    def test_small_payload_passes(self):
        assert_payload_budget(b"x" * 100)

    def test_oversized_payload_raises(self):
        with self.assertRaises(PayloadBudgetError):
            assert_payload_budget(b"x" * (41 * 1024))

    def test_real_payload_under_budget(self):
        path = PROJECT_ROOT / "app" / "data" / "bess_units.json"
        if not path.exists():
            self.skipTest("bess_units.json not built on this machine")
        assert_payload_budget(path.read_bytes())


class WorkbookExport(unittest.TestCase):
    """D38/D39: the Excel DCF export. Fixtures are
    tests/fixtures/bess_wb_case_*/{inputs.json, workbook.b64}, captured
    from the app's real "Export model (Excel)" button in a live browser
    (2026-07-31), the same oracle convention as bess_case_* above but for
    the workbook rather than the JS engine directly.

    `inputs.json` here carries the same ENGINE-level input shape
    bess_case_* already use (P, E, y0, T, C, O, r, c, delta, eta, a,
    gamma, zTotal, sHi, sLo, k, discounting), not raw UI form state: the
    app's own bessCalcEngineInputs resolves percentile/family/zone
    lookups against the live, ETL-refreshed bess_units.json payload,
    which changes daily, so a fixture pinned to raw UI state would go
    stale in a way this test could not detect. Pinning the RESOLVED
    engine inputs instead (read straight off the captured workbook's own
    Assumptions cells at capture time) keeps the fixture self-contained,
    and a workbook captured before an engine change still fails rather
    than passing quietly, exactly as D39 intends.

    Deviation from the M3 build spec's file list, noted rather than
    silently taken: the spec names tests/fixtures/bess_case_N/workbook.b64
    (reusing the eight EXISTING bess_case_* directories). Those fixtures'
    "a" and "zTotal" are arbitrary round numbers chosen for the hand-
    computed engine tests above; they are not values the live UI can
    reach (the percentile dropdown and the zone/family controls only
    ever produce whatever the real payload publishes), so they cannot be
    reproduced by driving the actual card in a browser. Two NEW fixture
    directories (bess_wb_case_1/2) are used instead, captured by
    actually filling the form; the fixture and recompute-from-stored-
    inputs discipline D39 asks for is otherwise unchanged.

    bess_wb_case_1: full asset, transmission-connected zone 1, mid-year
    discounting, arbitrage with a capture rate, the DC family switched
    off (exercises the family check row, D26's arbitrage line, D24's
    zone block and the mid-year stub together).
    bess_wb_case_2: distribution-connected (D24's "not applicable" TNUoS
    path), every family switched off and no capture rate set (zero
    availability and arbitrage revenue), end-of-period discounting, a
    cash flow that never repays (D37's "no IRR"/"no payback" edge, D30's
    requirement that this render as a named state, never a zero).
    bess_wb_case_4 (IC-review pass, 2026-07-31, vintage revision): a
    partial augmentation tranche (year, MWh and GBPk/MWh all set, own
    degradation rate) plus an availability derate on a transmission-
    connected asset with mid-year discounting and a capture rate —
    exercises the tranche rows, the capacity-weighted age, the
    augmentation capex column, LCOS's augmentation term, the MIRR rows
    and the first-crossing payback guard through the generic headline
    and cash-flow parity loops below.
    bess_wb_case_5 (toll and financing pass, plan/10 D54-D66,
    2026-08-29): the full toll triple (share, price, tenor) plus the
    full debt triple (gearing, cost of debt, debt tenor) at MODERATE
    gearing (so the native-IRR equity headline stays well inside the
    card solver's 150% bracket and the two agree), on a transmission-
    connected asset with mid-year discounting and a capture rate —
    exercises the tolled-share helper, the toll revenue row, the
    (1 - share) merchant scaling, the whole Financing section walk and
    the three geared headline rows. Inputs carry the resolved engine
    keys tollShare/tollPrice/tollTenor/gearing/costOfDebt/debtTenor
    (fractions and whole years, exactly as the Assumptions cells store
    them).

    All five re-captured 2026-08-29 (toll and financing layout pass),
    same discipline: inputs.json unchanged for cases 1/2/4 (and 3, in
    its own class below).

    Re-captured again later on 2026-08-29 (toll unit relabel, plan/10
    D67): the Assumptions toll-price unit cell now reads GBPk/MW/yr
    (numerically identical to GBP/kW/yr — display only). One cell
    changed per workbook, verified by a cell-level diff against the
    previous capture; every inputs.json is unchanged.
    """

    WB_CASES = ("bess_wb_case_1", "bess_wb_case_2", "bess_wb_case_4",
                "bess_wb_case_5")
    # Nine parts since the named-styles pass: the theme joins, because
    # the owner's vendored cell styles resolve several colours through it.
    EXPECTED_PARTS = {
        "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/theme/theme1.xml",
        "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
        "xl/worksheets/sheet3.xml",
    }

    @classmethod
    def setUpClass(cls):
        cls.cases = {}
        for case in cls.WB_CASES:
            fixdir = FIXTURES / case
            inputs = json.loads((fixdir / "inputs.json").read_text())
            xlsx_bytes = base64.b64decode((fixdir / "workbook.b64").read_text())
            model, names, sheets, parts = xe.load_workbook(xlsx_bytes)
            cls.cases[case] = {
                "inputs": inputs, "bytes": xlsx_bytes, "model": model,
                "names": names, "sheets": sheets, "parts": parts,
            }

    @staticmethod
    def _find_row(model, sheet, col_letter, text):
        """Row number whose `col_letter` cell holds the exact label
        `text` on `sheet`. Looking up by label rather than a hardcoded
        row number matches D37's own point that these labels are "load
        bearing, not decoration"."""
        col = xe.col_num(col_letter)
        for r, row in model[sheet].items():
            cell = row.get(col)
            if cell is not None and cell["t"] == "s" and cell["v"] == text:
                return r
        raise AssertionError("label %r not found on %s!%s" % (text, sheet, col_letter))

    @staticmethod
    def _tol(expected):
        return max(1e-6 * abs(expected), 0.01)

    # 1. zipfile validates every CRC and the store-only structure.
    def test_zip_is_readable(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                zf = zipfile.ZipFile(io.BytesIO(self.cases[case]["bytes"]))
                self.assertIsNone(zf.testzip())

    # 2. exactly the nine expected parts, in any order.
    def test_part_list_is_exactly_nine(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                parts = self.cases[case]["parts"]
                self.assertEqual(len(parts), 9)
                self.assertEqual(set(parts), self.EXPECTED_PARTS)

    # 3. no macro, no external link, no calc chain part.
    def test_no_macro_no_external_link_no_calcchain(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                for name in self.cases[case]["parts"]:
                    self.assertNotIn("vbaProject", name)
                    self.assertNotIn("externalLink", name)
                    self.assertNotIn("calcChain", name)

    # 4. every part is well-formed XML.
    def test_every_part_parses(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                zf = zipfile.ZipFile(io.BytesIO(self.cases[case]["bytes"]))
                for name in zf.namelist():
                    ET.fromstring(zf.read(name))

    # 5. rows ascending by r, cells ascending by column within a row.
    def test_rows_and_cells_ascending(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                zf = zipfile.ZipFile(io.BytesIO(self.cases[case]["bytes"]))
                for i in range(1, 4):
                    root = ET.fromstring(zf.read("xl/worksheets/sheet%d.xml" % i))
                    sheet_data = root.find("m:sheetData", xe.NS)
                    prev_row = -1
                    for row_el in sheet_data:
                        r = int(row_el.get("r"))
                        self.assertGreater(r, prev_row, "sheet%d row order" % i)
                        prev_row = r
                        prev_col = -1
                        for c_el in row_el:
                            m = re.match(r"([A-Z]+)([0-9]+)", c_el.get("r"))
                            col = xe.col_num(m.group(1))
                            self.assertGreater(col, prev_col,
                                              "sheet%d row %d cell order" % (i, r))
                            prev_col = col

    # 6. NPV, IRR, MIRR, discounted payback, PVI, DPI, indicative LCOS,
    # equity IRR and min/avg DSCR all match the engine. Row numbers are
    # the toll-and-financing pass's layout (BESS_DROW's own comment in
    # app/js/charts.js): two new revenue rows and the ten-row Financing
    # section push npv/irr/mirr/payback/pvi/dpi/lcos from 55-61 to
    # 67-73, and the three geared headline rows append at 74-76.
    def test_headline_formulas_match_engine(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                c = self.cases[case]
                g = xe.Grid(c["model"], c["names"])
                res = compute(c["inputs"])

                npv_got = g.value("DCF", "E67")
                self.assertAlmostEqual(npv_got, res["npv"], delta=self._tol(res["npv"]))

                irr_got = g.value("DCF", "E68")
                if res["irr"] is None:
                    self.assertEqual(irr_got, "no IRR")
                else:
                    self.assertAlmostEqual(irr_got, res["irr"], delta=self._tol(res["irr"]))

                mirr_got = g.value("DCF", "E69")
                if res["mirr"] is None:
                    self.assertEqual(mirr_got, "n/a")
                else:
                    self.assertAlmostEqual(mirr_got, res["mirr"],
                                          delta=self._tol(res["mirr"]))

                # Discounted payback period (DPP) replaces simple payback
                # in the workbook: compared against the mirror's own
                # discounted_payback(), interpolated on discounted flows.
                pay_got = g.value("DCF", "E70")
                if res["discounted_payback"] is None:
                    self.assertEqual(pay_got, "no payback")
                else:
                    self.assertAlmostEqual(pay_got, res["discounted_payback"],
                                          delta=self._tol(res["discounted_payback"]))

                pvi_got = g.value("DCF", "E71")
                self.assertAlmostEqual(pvi_got, res["pvi"], delta=self._tol(res["pvi"]))

                dpi_got = g.value("DCF", "E72")
                if res["dpi"] is None:
                    self.assertEqual(dpi_got, "n/a")
                else:
                    self.assertAlmostEqual(dpi_got, res["dpi"], delta=self._tol(res["dpi"]))

                lcos_got = g.value("DCF", "E73")
                if res["lcos"] is None:
                    self.assertEqual(lcos_got, "n/a")
                else:
                    self.assertAlmostEqual(lcos_got, res["lcos"], delta=self._tol(res["lcos"]))

                # Toll and financing pass (plan/10 D55/D60): the three
                # geared headline rows. Ungeared cases must read the
                # named "n/a (ungeared)" state on all three (never a
                # blank, an error or a fake number); the geared case is
                # compared against the Python mirror's equity_irr and
                # dscr_min/dscr_avg within the workbook tolerance.
                eq_irr_got = g.value("DCF", "E74")
                if res["equity_irr"] is None and res["d0"] == 0:
                    self.assertEqual(eq_irr_got, "n/a (ungeared)")
                else:
                    self.assertAlmostEqual(eq_irr_got, res["equity_irr"],
                                          delta=self._tol(res["equity_irr"]))

                dscr_min_got = g.value("DCF", "E75")
                if res["dscr_min"] is None and res["d0"] == 0:
                    self.assertEqual(dscr_min_got, "n/a (ungeared)")
                else:
                    self.assertAlmostEqual(dscr_min_got, res["dscr_min"],
                                          delta=self._tol(res["dscr_min"]))

                dscr_avg_got = g.value("DCF", "E76")
                if res["dscr_avg"] is None and res["d0"] == 0:
                    self.assertEqual(dscr_avg_got, "n/a (ungeared)")
                else:
                    self.assertAlmostEqual(dscr_avg_got, res["dscr_avg"],
                                          delta=self._tol(res["dscr_avg"]))

    # 7. every year column of the net-cash-flow row matches bess_cashflow.
    def test_cash_flow_row_matches_engine(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                c = self.cases[case]
                g = xe.Grid(c["model"], c["names"])
                cf = bess_cashflow(c["inputs"])
                self.assertIsNotNone(cf)
                for row in cf["rows"]:
                    # DPP/PVI/DPI pass (2026-08-01): the Total column is
                    # gone, so year 0 sits back at F (col 6) and year n
                    # at 6+n. Toll and financing pass (2026-08-29): the
                    # net cash flow row moved from 35 to 37 (two new
                    # revenue rows above it).
                    col = xe.col_name(6 + row["year"])
                    got = g.value("DCF", col + "37")
                    want = row["net_cashflow_gbp"]
                    self.assertAlmostEqual(got, want, delta=max(1e-6 * abs(want), 0.01),
                                          msg="%s year %d" % (case, row["year"]))

    # 8. flipping the mid-year flag moves NPV but not IRR. DPP is the
    # one exception to the pre-DPP-pass "IRR/payback never move" rule:
    # it interpolates on the discounted PV row, so it is
    # convention-aware by construction (discounted_payback's own
    # docstring) and DOES move here, unlike the simple payback it
    # replaced.
    def test_both_discounting_conventions(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                c = self.cases[case]
                midflag_row = self._find_row(
                    c["model"], "Assumptions", "C",
                    "Mid-year discounting (1 = yes, 0 = end of period)")
                col = xe.col_num("E")

                def figures(flag_value):
                    model = copy.deepcopy(c["model"])
                    model["Assumptions"][midflag_row][col] = {"t": "n", "v": float(flag_value)}
                    g = xe.Grid(model, c["names"])
                    return g.value("DCF", "E67"), g.value("DCF", "E68")

                npv_mid, irr_mid = figures(1)
                npv_end, irr_end = figures(0)
                self.assertGreater(abs(npv_mid - npv_end), 0.01, case)
                self.assertEqual(irr_mid, irr_end, case)

    # The native MIRR() check row (owner request, 2026-07-31) must land
    # exactly on the headline built from the two visible legs — or agree
    # that the figure is undefined ("n/a" on both) when the series lacks
    # a sign. This is the one cell where the evaluator's excel_mirr and
    # the engine's mirr() cross-check each other through real formulas.
    def test_mirr_check_row_matches_headline(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                c = self.cases[case]
                g = xe.Grid(c["model"], c["names"])
                headline_row = self._find_row(
                    c["model"], "DCF", "C",
                    "MIRR (finance and reinvestment at WACC)")
                check_row = self._find_row(
                    c["model"], "DCF", "C",
                    "Check: Excel MIRR() against the built-up rows")
                headline = g.value("DCF", "E%d" % headline_row)
                check = g.value("DCF", "E%d" % check_row)
                if headline == "n/a":
                    self.assertEqual(check, "n/a", case)
                else:
                    self.assertAlmostEqual(check, headline,
                                          delta=self._tol(headline), msg=case)

    # 9. under end-of-period, the Excel NPV() check row equals the headline.
    def test_npv_check_row_reconciles(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                c = self.cases[case]
                midflag_row = self._find_row(
                    c["model"], "Assumptions", "C",
                    "Mid-year discounting (1 = yes, 0 = end of period)")
                model = copy.deepcopy(c["model"])
                model["Assumptions"][midflag_row][xe.col_num("E")] = {"t": "n", "v": 0.0}
                g = xe.Grid(model, c["names"])
                # Toll and financing pass: the checks banner and its
                # rows moved from 63-66 to 78-81 (the Financing section
                # plus the two revenue rows and three geared headline
                # rows all sit above them); the NPV() check row is E79.
                self.assertAlmostEqual(g.value("DCF", "E67"), g.value("DCF", "E79"),
                                      delta=0.01)

    # 10. no unit/party name or post-code pattern anywhere in the file.
    def test_no_names_anywhere(self):
        bm_unit = re.compile(r"\b[TE]_[A-Z0-9]{2,}-\d+\b")
        postcode = re.compile(r"\b[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}\b")
        for case in self.WB_CASES:
            with self.subTest(case=case):
                for sheet in self.cases[case]["model"].values():
                    for row in sheet.values():
                        for cell in row.values():
                            if cell["t"] == "s":
                                self.assertNotRegex(cell["v"], bm_unit)
                                self.assertNotRegex(cell["v"], postcode)

    # 11. no em dash in any inline string.
    def test_no_em_dash_in_any_string(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                for sheet in self.cases[case]["model"].values():
                    for row in sheet.values():
                        for cell in row.values():
                            if cell["t"] == "s":
                                self.assertNotIn("\u2014", cell["v"])

    # D36's family check row: reconciles by construction (family
    # components come additive from the payload), so it must read "ok".
    def test_family_check_row_reads_ok(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                c = self.cases[case]
                g = xe.Grid(c["model"], c["names"])
                row = self._find_row(c["model"], "Assumptions", "C",
                                    "Check: families reconcile to the published total")
                self.assertEqual(g.value("Assumptions", "E%d" % row), "ok")

    # D24/test plan item 5: distribution-connected shows "not applicable",
    # never a zero that looks like a measurement, and the DCF network
    # charge row is exactly zero in every year.
    def test_distribution_connected_shows_not_applicable(self):
        c = self.cases["bess_wb_case_2"]
        g = xe.Grid(c["model"], c["names"])
        zone_row = self._find_row(c["model"], "Assumptions", "C", "Zone total")
        self.assertEqual(g.value("Assumptions", "E%d" % zone_row), "not applicable")
        tnuos_row = self._find_row(c["model"], "DCF", "C", "Network charge (TNUoS)")
        for n in range(0, c["inputs"]["T"] + 1):
            # DPP/PVI/DPI pass (2026-08-01): the Total column is gone;
            # year 0 is F (col 6) again.
            col = xe.col_name(6 + n)
            self.assertEqual(g.value("DCF", "%s%d" % (col, tnuos_row)), 0.0)

    @staticmethod
    def _cell_style(zf, sheet_index, ref):
        """Raw `s` (style index) attribute of one cell, straight off the
        worksheet XML: `xe.load_workbook`'s model deliberately drops
        styling (D38's grid only needs t/v to evaluate formulas), so
        formatting assertions read the zip directly, the same way
        test_rows_and_cells_ascending already does."""
        root = ET.fromstring(zf.read("xl/worksheets/sheet%d.xml" % sheet_index))
        for row_el in root.find("m:sheetData", xe.NS):
            for c_el in row_el:
                if c_el.get("r") == ref:
                    s = c_el.get("s")
                    return int(s) if s is not None else 0
        raise AssertionError("cell %s not found on sheet %d" % (ref, sheet_index))

    # Formatting pass, 2026-07-31 (owner request): gridlines off on every
    # sheet, matching the reference template convention.
    def test_gridlines_off_on_every_sheet(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                zf = zipfile.ZipFile(io.BytesIO(self.cases[case]["bytes"]))
                for i in range(1, 4):
                    root = ET.fromstring(zf.read("xl/worksheets/sheet%d.xml" % i))
                    sv = root.find("m:sheetViews/m:sheetView", xe.NS)
                    self.assertIsNotNone(sv, "sheet%d has no sheetView" % i)
                    self.assertEqual(sv.get("showGridLines"), "0",
                                    "sheet%d (case %s)" % (i, case))

    # Named cell styles (owner's formatted file, 2026-07-31). The
    # workbook's styles.xml IS that file's own, vendored verbatim, so
    # these assertions pin the role-to-cellXf mapping (charts.js's
    # BESS_XF) rather than any colour: a cell must carry the index its
    # role calls for, and that index must resolve to the named style
    # the role claims.
    NAMED_XF = {20: "![M]KeyOutput", 26: "![M]Check", 29: "![M]Check",
                30: "![M]Comment", 31: "![M]KeyOutput", 32: "![M]KeyOutput",
                33: "![M]Check", 34: "![M]Check", 35: "![M]Input",
                36: "![M]Input", 37: "![M]Input", 39: "![M]HardNumber",
                47: "![M]Link", 50: "![M]Formula", 51: "![M]Input",
                52: "![M]Formula", 53: "![M]Link", 55: "![M]Link",
                56: "![M]Link",
                # Owner's frame revision (2026-08-01): 57/58/59 are the
                # cellXfs appended alongside 56, same-role variants with
                # only the number format changed (see charts.js's
                # BESS_XF and xlsx.js's own comment for the map).
                57: "![M]Input", 58: "![M]HardNumber", 59: "![M]Formula",
                # Owner review (2026-08-01): 60-64 are ![M]KeyOutput with
                # the named style's thin rules overridden off and the
                # owner's own key-result grey; 64 drops the fill too (the
                # net cash flow year row). The xfId link is retained, so
                # these still resolve to the gallery entry.
                60: "![M]KeyOutput", 61: "![M]KeyOutput",
                62: "![M]KeyOutput", 63: "![M]KeyOutput",
                64: "![M]KeyOutput"}

    @staticmethod
    def _style_parents(zf):
        """Per cellXf index, the name of the cellStyle it inherits."""
        root = ET.fromstring(zf.read("xl/styles.xml"))
        names = {int(cs.get("xfId")): cs.get("name")
                 for cs in root.findall("m:cellStyles/m:cellStyle", xe.NS)}
        return [names.get(int(xf.get("xfId", "-1")), "?")
                for xf in root.findall("m:cellXfs/m:xf", xe.NS)]

    def test_named_cell_styles_are_present(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                zf = zipfile.ZipFile(io.BytesIO(self.cases[case]["bytes"]))
                root = ET.fromstring(zf.read("xl/styles.xml"))
                got = {cs.get("name")
                       for cs in root.findall("m:cellStyles/m:cellStyle", xe.NS)}
                for want in ("![M]Input", "![M]Link", "![M]Formula",
                            "![M]Percent", "![M]Date", "![M]HardNumber",
                            "![M]KeyOutput", "![M]Check", "![M]Comment",
                            "![M]KPI", "![M]Special", "![M]ChangeF",
                            "![M]Unused"):
                    self.assertIn(want, got, "%s missing (%s)" % (want, case))
                self.assertIn("xl/theme/theme1.xml", zf.namelist(), case)

    def test_cells_carry_the_right_named_style(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                model = self.cases[case]["model"]
                zf = zipfile.ZipFile(io.BytesIO(self.cases[case]["bytes"]))
                parent = self._style_parents(zf)

                def check(sheet_i, sheet, col, label, want):
                    row = self._find_row(model, sheet, "C", label)
                    ref = "%s%d" % (col, row)
                    got = self._cell_style(zf, sheet_i, ref)
                    self.assertEqual(got, want, "%s %s (%s)" % (label, ref, case))
                    if want in self.NAMED_XF:
                        self.assertEqual(parent[got], self.NAMED_XF[want],
                                        "%s parent (%s)" % (label, case))

                check(2, "Assumptions", "E", "Power", 36)
                check(2, "Assumptions", "E", "Discount rate (WACC)", 37)
                check(2, "Assumptions", "E", "Commissioning date", 51)
                check(2, "Assumptions", "E", "Duration", 50)
                # Owner's frame revision (2026-08-01): the family cells
                # (GBP/kW/day) moved to the 4 dp observed variant; the
                # TNUoS zone tariff cells (GBP/kW, a different magnitude)
                # were deliberately left on the original 1 dp style.
                check(2, "Assumptions", "E", "Dynamic Containment (DC)", 58)
                check(2, "Assumptions", "E", "SystemPeak", 39)
                check(2, "Assumptions", "E",
                      "Check: families reconcile to the published total", 29)

                # DPP/PVI/DPI pass (2026-08-01): the Total column is
                # gone, so year 0 sits back at F and the first per-year
                # formula cell (previously H) sits at G.
                check(3, "DCF", "D", "Calculation period", 47)
                check(3, "DCF", "D", "Commissioning date", 53)
                check(3, "DCF", "G", "Year fraction", 52)
                check(3, "DCF", "G", "Usable energy", 50)
                check(3, "DCF", "F", "Discharged energy", 39)
                # Owner review (2026-08-01): the key styles moved to the
                # borderless appended variants (60-64). The results block
                # carries the owner's grey; the net cash flow year row is
                # bold and unfilled (64), and DPI has its own x-multiple
                # format (63) instead of the plain 2 dp it had escaped to.
                check(3, "DCF", "G", "Net cash flow", 64)
                check(3, "DCF", "E", "NPV at valuation date", 60)
                check(3, "DCF", "E",
                      "Internal rate of return (end-of-period basis)", 61)
                check(3, "DCF", "E", "MIRR (finance and reinvestment at WACC)", 61)
                check(3, "DCF", "E", "Discounted payback period (DPP)", 62)
                check(3, "DCF", "E", "Discounted profitability index (DPI)", 63)
                check(3, "DCF", "E", "Present value of investment (PVI)", 60)
                # The calendar band's Input cell: written empty purely so
                # the medium rule runs unbroken from Metric to the last year.
                check(3, "DCF", "E", "Calendar year", 6)
                check(3, "DCF", "E", "Indicative LCOS", 60)
                check(3, "DCF", "E",
                      "Check: Excel MIRR() against the built-up rows", 34)

                # Owner's frame revision (2026-08-01): the DCF banner's
                # running section number moved from column A to B,
                # matching the Assumptions sheet's section() helper;
                # column A carries nothing on this sheet any more.
                band = self._find_row(model, "DCF", "C", "Revenue build-up")
                self.assertEqual(self._cell_style(zf, 3, "B%d" % band), 5, case)
                hdr = self._find_row(model, "DCF", "C", "Metric")
                self.assertEqual(self._cell_style(zf, 3, "C%d" % hdr), 6, case)

    # The Cover carries the owner's "Cell style map" - the legend that
    # names every style a reader will meet - plus the standing sentence
    # in ![M]Comment.
    def test_cover_style_map_present(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                model = self.cases[case]["model"]
                zf = zipfile.ZipFile(io.BytesIO(self.cases[case]["bytes"]))
                head = self._find_row(model, "Cover", "C", "Cell style map")
                for label in ("Inputs and references to them", "Calculations",
                              "Other"):
                    self.assertGreater(
                        self._find_row(model, "Cover", "C", label), head,
                        "%s (%s)" % (label, case))
                for label in ("Input data (as value)", "Hard number",
                              "Formula: number", "Key result", "Check"):
                    self._find_row(model, "Cover", "D", label)
                sentence = self._find_row(model, "Cover", "C",
                                         BESS_STANDING_SENTENCE)
                self.assertEqual(self._cell_style(zf, 1, "C%d" % sentence), 30,
                                case)

    # DPP/PVI/DPI pass (2026-08-01): the Cover headline block grows a
    # sixth row (C6-C11/E6-E11) — NPV, IRR, MIRR, DPP, DPI, LCOS — each
    # an ![M]Link mirror of the DCF sheet's own headline row, styled per
    # the magnitude the DCF cell itself carries (whole GBP, 1 dp percent,
    # 1 dp ratio). Toll and financing pass (plan/10, 2026-08-29): two
    # geared mirrors join at C12-C13 (Equity IRR, Min DSCR), same
    # ![M]Link discipline. Row and style indices read off what the
    # builder actually emits (charts.js's cover.Cn/En assignments and
    # BESS_XF), not independently guessed.
    COVER_HEADLINE = {
        6: ("NPV at valuation date", 47),        # linkNum
        7: ("Internal rate of return", 56),       # linkPct
        8: ("MIRR (reinvestment at WACC)", 56),   # linkPct
        9: ("Discounted payback (years)", 55),    # link1dp
        10: ("Profitability index (DPI)", 55),    # link1dp
        11: ("Indicative LCOS (£/MWh)", 47), # linkNum
        12: ("Equity IRR", 56),                   # linkPct
        13: ("Min DSCR (x)", 55),                 # link1dp
    }

    def test_cover_headline_rows_with_styles(self):
        for case in self.WB_CASES:
            with self.subTest(case=case):
                model = self.cases[case]["model"]
                zf = zipfile.ZipFile(io.BytesIO(self.cases[case]["bytes"]))
                for row, (label, style) in self.COVER_HEADLINE.items():
                    found_row = self._find_row(model, "Cover", "C", label)
                    self.assertEqual(found_row, row, "%s (%s)" % (label, case))
                    got = self._cell_style(zf, 1, "E%d" % row)
                    self.assertEqual(got, style, "%s style (%s)" % (label, case))


class ValuationDateWorkbookTest(unittest.TestCase):
    """Owner request, 2026-07: D35-D40's Excel export gains a Valuation
    date input, a Re-anchoring factor cell and an "NPV at valuation date"
    headline, with the commissioning-anchored figure kept as a labelled
    check row (DCF!E80 as of the toll-and-financing pass, plan/10,
    2026-08-29, moved from E65 by the two new revenue rows, the
    Financing section and the three geared headline rows; see
    BESS_AROW/BESS_DROW's comments in app/js/charts.js for the full
    shift history).

    Valuation-date-anchored grid pass (owner decision, 2026-08-01): the
    headline no longer multiplies a commissioning-anchored SUM by a
    re-anchoring factor after the fact - the year grid's own Discount
    factor row subtracts the commissioning-to-valuation-date span before
    it, so the grid discounts (or compounds forward) straight to the
    valuation date, and the headline is a plain reference to the PV
    row's Total cell. Two new rows (the years-to-valuation-date general
    assumption and the Calendar year row) push every row from the header
    down by 2 more; row numbers below carry that shift.

    Row numbers below reflect the 2026-07-31 formatting pass (banner
    rows and spacer rows added to the DCF sheet for section separation,
    see BESS_DROW's own comment): the headline/IRR/payback/LCOS rows
    that WorkbookExport above also asserts against moved from 45-48 to
    47-50 (formatting pass) and then 48-51 (IC-review pass, which
    inserted the effective-age row), and this class's own check row
    moved from 50 to 54 to 55, for both
    bess_wb_case_1/2 and bess_wb_case_3.

    tests/fixtures/bess_wb_case_3/ is a THIRD, separate fixture (not
    added to WorkbookExport.WB_CASES) because it is the one case in this
    file where the headline (E47) and the Excel-NPV() check row (E53)
    are EXPECTED to disagree: E53 is deliberately commissioning-
    anchored (D37) while E47 is now re-anchored, so it needs its own
    assertions rather than sharing WorkbookExport's generic loop.
    Captured 2026-07-31 by driving the real running card (power 50 MW,
    energy 100 MWh, commissioning 2020-06-15, valuation date 2026-07-31,
    mid-year discounting, an arbitrage capture rate, zone 1), the same
    "recompute from the workbook's own stored Assumptions cells"
    discipline the WorkbookExport docstring describes: inputs.json holds
    the resolved P/E/y0/T/C/O/r/c/delta/eta/a/gamma/zTotal/sHi/sLo/k/
    discounting/valuationDate values read straight off the captured
    workbook, not raw UI state, so this fixture cannot go stale in a way
    the test would miss."""

    @classmethod
    def setUpClass(cls):
        fixdir = FIXTURES / "bess_wb_case_3"
        cls.inputs = json.loads((fixdir / "inputs.json").read_text())
        xlsx_bytes = base64.b64decode((fixdir / "workbook.b64").read_text())
        cls.model, cls.names, cls.sheets, cls.parts = xe.load_workbook(xlsx_bytes)
        cls.grid = xe.Grid(cls.model, cls.names)

    @staticmethod
    def _find_row(model, sheet, col_letter, text):
        col = xe.col_num(col_letter)
        for r, row in model[sheet].items():
            cell = row.get(col)
            if cell is not None and cell["t"] == "s" and cell["v"] == text:
                return r
        raise AssertionError("label %r not found on %s!%s" % (text, sheet, col_letter))

    @staticmethod
    def _tol(expected):
        return max(1e-6 * abs(expected), 0.01)

    def test_zip_and_parts_are_valid(self):
        # Same structural checks WorkbookExport runs for every other
        # case (1-4 of D39's test list), just for this one fixture.
        xlsx_bytes = base64.b64decode(
            (FIXTURES / "bess_wb_case_3" / "workbook.b64").read_text())
        zf = zipfile.ZipFile(io.BytesIO(xlsx_bytes))
        self.assertIsNone(zf.testzip())
        self.assertEqual(len(self.parts), 9)
        for name in self.parts:
            self.assertNotIn("vbaProject", name)
            self.assertNotIn("externalLink", name)
            self.assertNotIn("calcChain", name)
        for name in zf.namelist():
            ET.fromstring(zf.read(name))

    def test_no_names_or_em_dash(self):
        bm_unit = re.compile(r"\b[TE]_[A-Z0-9]{2,}-\d+\b")
        postcode = re.compile(r"\b[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}\b")
        for sheet in self.model.values():
            for row in sheet.values():
                for cell in row.values():
                    if cell["t"] == "s":
                        self.assertNotRegex(cell["v"], bm_unit)
                        self.assertNotRegex(cell["v"], postcode)
                        self.assertNotIn("\u2014", cell["v"])

    def test_valuation_date_and_reanchor_factor_rows_exist(self):
        row = self._find_row(self.model, "Assumptions", "C", "Valuation date")
        got = self.grid.value("Assumptions", "E%d" % row)
        # Excel serial for 2026-07-31 (1899-12-30 epoch), matching
        # Xlsx.dateSerial's own arithmetic.
        self.assertEqual(got, xe.date_to_serial(2026, 7, 31))

        factor_row = self._find_row(
            self.model, "Assumptions", "C",
            "Re-anchoring factor, commissioning to valuation date")
        factor_got = self.grid.value("Assumptions", "E%d" % factor_row)
        factor_want = reanchor_npv(1.0, self.inputs["r"], self.inputs["y0"],
                                   self.inputs["valuationDate"])
        self.assertAlmostEqual(factor_got, factor_want, delta=1e-9)
        # Hand-computable cross-check: 2020-06-15 to 2026-07-31 is a
        # touch over 6.12 years at 8% WACC.
        self.assertAlmostEqual(factor_got, 1.6021611776563702, places=6)

    def test_headline_is_reanchored_and_check_row_is_commissioning(self):
        res = compute(self.inputs)
        npv_headline_row = self._find_row(self.model, "DCF", "C", "NPV at valuation date")
        self.assertEqual(npv_headline_row, 67)  # toll-and-financing layout
        npv_got = self.grid.value("DCF", "E%d" % npv_headline_row)
        self.assertAlmostEqual(npv_got, res["npv"], delta=self._tol(res["npv"]))

        check_row = self._find_row(
            self.model, "DCF", "C", "Check: net present value at commissioning")
        self.assertEqual(check_row, 80)  # toll-and-financing layout (was 65)
        check_got = self.grid.value("DCF", "E%d" % check_row)
        self.assertAlmostEqual(check_got, res["npv_at_commissioning"],
                              delta=self._tol(res["npv_at_commissioning"]))

        # The identity the whole feature rests on: headline = check row x
        # the re-anchoring factor cell, exactly. This still holds under
        # the valuation-date-anchored-grid pass even though the formulas
        # changed shape: the headline is now SUM of a grid already
        # compounded forward by the factor, and the check row divides
        # that factor back out, so the algebra is unchanged (D35-D40's
        # "applying that factor BY FORMULA", just relocated).
        factor_row = self._find_row(
            self.model, "Assumptions", "C",
            "Re-anchoring factor, commissioning to valuation date")
        factor = self.grid.value("Assumptions", "E%d" % factor_row)
        self.assertAlmostEqual(npv_got, check_got * factor,
                              delta=self._tol(npv_got))

    def test_discount_factor_exceeds_one_pre_valuation(self):
        # Valuation-date-anchored grid pass (owner decision, 2026-08-01):
        # the grid now discounts straight to the valuation date, so a
        # year before it is compounded FORWARD, not discounted back -
        # its factor is above 1. Case 3's valuation date (2026-07-31) is
        # years after its commissioning date (2020-06-15), so year 1
        # exercises this directly.
        factor_row = self._find_row(
            self.model, "DCF", "C", "Discount factor (to the valuation date)")
        year1_col = xe.col_name(7)  # G: first year column (Total column is gone)
        got = self.grid.value("DCF", "%s%d" % (year1_col, factor_row))
        self.assertGreater(got, 1.0)

    def test_irr_payback_lcos_unaffected_by_reanchoring(self):
        # Row numbers below are the toll-and-financing pass's layout
        # (BESS_DROW's comment); what this test actually guards is that
        # none of these figures differ from the commissioning-basis
        # engine figures (reanchorNpv must never be applied to any of
        # them — DPP is anchor-invariant by construction, not because it
        # happens to dodge re-anchoring).
        res = compute(self.inputs)
        irr_row = self._find_row(
            self.model, "DCF", "C", "Internal rate of return (end-of-period basis)")
        self.assertEqual(irr_row, 68)
        self.assertAlmostEqual(self.grid.value("DCF", "E68"), res["irr"],
                              delta=self._tol(res["irr"]))

        mirr_row = self._find_row(
            self.model, "DCF", "C", "MIRR (finance and reinvestment at WACC)")
        self.assertEqual(mirr_row, 69)
        self.assertAlmostEqual(self.grid.value("DCF", "E69"), res["mirr"],
                              delta=self._tol(res["mirr"]))

        payback_row = self._find_row(
            self.model, "DCF", "C", "Discounted payback period (DPP)")
        self.assertEqual(payback_row, 70)
        self.assertEqual(self.grid.value("DCF", "E70"), "no payback")
        self.assertIsNone(res["discounted_payback"])

        lcos_row = self._find_row(self.model, "DCF", "C", "Indicative LCOS")
        self.assertEqual(lcos_row, 73)  # was 61, before the financing pass
        self.assertAlmostEqual(self.grid.value("DCF", "E73"), res["lcos"],
                              delta=self._tol(res["lcos"]))


if __name__ == "__main__":
    unittest.main()

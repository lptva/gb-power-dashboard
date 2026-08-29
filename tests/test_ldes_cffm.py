"""Tests for the mini-CFFM engine (plan/10 Phase 3, B2).

Exercises ops/ldes_cffm_figures.py, the Python mirror of
app/js/metrics.js (cffmLevels, cffmCorridor). No external worked example
of the CFFM's ex-tax core exists, so the anchor here is the annuity
identity itself (AnnuityIdentityTest): with every side-block switched
off, the flattened ex-tax level must equal RAV x annuity factor exactly
— the classic result the NPV-neutral return base exists to guarantee.
Around it: the A1.70 IDC walk hand-computed year by year, the
depreciation total (A1.139 adapted), the transaction-cost gearing split,
the corridor arithmetic (D77), null safety, and a JS/Python shape-parity
guard in the DoubleCountGuardTest source-grep style (the engine formulas
are fingerprinted in BOTH source files, and the Python outputs are
pinned against closed-form hand derivations).
"""

import base64
import copy
import io
import json
import math
import sys
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FIXTURES = PROJECT_ROOT / "tests" / "fixtures"
sys.path.insert(0, str(PROJECT_ROOT / "ops"))

import xlsx_eval as xe  # noqa: E402

from ldes_cffm_figures import (cffm_annuitise_end_of_life,  # noqa: E402
                               cffm_corridor, cffm_csv_rows,
                               cffm_levels)


def annuity_factor(r, n):
    """A1.151: r / (1 - (1+r)^-n) — recomputed here independently so the
    tests never borrow the engine's own factor."""
    return r / (1 - (1 + r) ** -n)


class AnnuityIdentityTest(unittest.TestCase):
    """THE anchor. Single construction year, devex 0, idcRate 0, tx
    rates 0, opex/decom 0, residual 0: the RAV is then exactly the
    capex, and the ex-tax level must equal RAV x annuity factor at both
    rates. This is the loan-amortisation identity: straight-line
    depreciation plus a return of r x opening RAV, discounted at
    (1+r)^-n, telescopes to PV = RAV, and the A1.151 factor turns that
    PV back into the flat payment on principal RAV. It pins the whole
    chain (RAV build -> blocks -> NPV -> annuity) with no external
    worked example needed."""

    COMBOS = [
        # (floorRate, capRate, opYears) — includes the Ofgem defaults
        # 4.47% / 7.48% over 25 years.
        (0.0447, 0.0748, 25),
        (0.0300, 0.0600, 10),
        (0.0200, 0.0900, 40),
    ]

    @staticmethod
    def inputs(floor_rate, cap_rate, op_years):
        return {"constructionYears": 1, "devex": 0, "capex": 500,
                "idcRate": 0, "gearing": 0.5, "txDebtRate": 0,
                "txEquityRate": 0, "opexFixed": 0, "decom": 0,
                "opYears": op_years, "residualValue": 0,
                "floorRate": floor_rate, "capRate": cap_rate}

    def test_level_equals_rav_times_annuity_factor(self):
        for floor_rate, cap_rate, op_years in self.COMBOS:
            with self.subTest(floor=floor_rate, cap=cap_rate, n=op_years):
                out = cffm_levels(self.inputs(floor_rate, cap_rate, op_years))
                self.assertAlmostEqual(out["rav"], 500.0, delta=1e-12)
                self.assertAlmostEqual(
                    out["floor"]["level"],
                    500.0 * annuity_factor(floor_rate, op_years), delta=1e-8)
                self.assertAlmostEqual(
                    out["cap"]["level"],
                    500.0 * annuity_factor(cap_rate, op_years), delta=1e-8)

    def test_floor_level_below_cap_level(self):
        for floor_rate, cap_rate, op_years in self.COMBOS:
            out = cffm_levels(self.inputs(floor_rate, cap_rate, op_years))
            self.assertLess(out["floor"]["level"], out["cap"]["level"])

    def test_op_years_defaults_to_25(self):
        explicit = cffm_levels(self.inputs(0.0447, 0.0748, 25))
        omitted = dict(self.inputs(0.0447, 0.0748, 25))
        del omitted["opYears"]
        self.assertEqual(cffm_levels(omitted), explicit)


class IdcFormulaTest(unittest.TestCase):
    """A1.70 hand-computed: IDC_y = rate x (opening + additions/(2 +
    rate)). Capex 300 spread over 3 years (additions 100/yr), idcRate
    6.1%, no devex, tx rates 0 so rav is the pre-op closing itself.
    Hand walk (100/2.061 = 48.5201358563...):
      y1: idc = 0.061 x (0       + 48.52014) =  2.95972829
          closing = 102.95972829
      y2: idc = 0.061 x (102.95973 + 48.52014) =  9.24027171
          closing = 212.20000000 (the two IDC years sum to 12.2 exactly)
      y3: idc = 0.061 x (212.20000 + 48.52014) = 15.90392829
          closing = 328.10392829
    """

    BASE = {"constructionYears": 3, "devex": 0, "capex": 300,
            "idcRate": 0.061, "gearing": 0.5, "txDebtRate": 0,
            "txEquityRate": 0, "opexFixed": 0, "decom": 0, "opYears": 25,
            "residualValue": 0, "floorRate": 0.0447, "capRate": 0.0748}

    def test_three_year_walk(self):
        out = cffm_levels(self.BASE)
        self.assertAlmostEqual(out["idcTotal"], 28.103928287239205,
                               delta=1e-6)
        self.assertAlmostEqual(out["rav"], 328.1039282872392, delta=1e-6)

    def test_two_year_walk(self):
        # Same rate, capex 200 over 2 years: y1/y2 identical to the
        # first two rows above, so closing = 212.2 and total IDC = 12.2.
        out = cffm_levels(dict(self.BASE, constructionYears=2, capex=200))
        self.assertAlmostEqual(out["idcTotal"], 12.2, delta=1e-6)
        self.assertAlmostEqual(out["rav"], 212.2, delta=1e-6)

    def test_devex_lands_in_year_one_only(self):
        # Devex 20 raises year 1's additions to 120 (and only year 1's):
        #   y1: idc = 0.061 x 120/2.061          =  3.55167394
        #   y2: idc = 0.061 x (123.55167 + 48.52014) = 10.49638040
        #   y3: idc = 0.061 x (234.04805 + 48.52014) = 17.23665960
        #   closing = 351.28471394; total IDC = 31.28471394.
        out = cffm_levels(dict(self.BASE, devex=20))
        self.assertAlmostEqual(out["idcTotal"], 31.284713944687045,
                               delta=1e-6)
        self.assertAlmostEqual(out["rav"], 351.28471394468704, delta=1e-6)


class DepreciationTotalTest(unittest.TestCase):
    """A1.139 adapted: total depreciation over the operational period
    equals RAV - residualValue, with the residual left standing (and
    still earning the return) at the end."""

    BASE = {"constructionYears": 1, "devex": 0, "capex": 240,
            "idcRate": 0, "gearing": 0.5, "txDebtRate": 0,
            "txEquityRate": 0, "opexFixed": 0, "decom": 0, "opYears": 25,
            "residualValue": 40, "floorRate": 0, "capRate": 0.05}

    def test_total_depreciation_is_rav_minus_residual(self):
        # At rate 0 the level is the plain average allowance and the
        # return block is nil, so level x opYears = total depreciation
        # = 240 - 40 = 200 (annual 8).
        out = cffm_levels(self.BASE)
        self.assertAlmostEqual(out["floor"]["returnAnnuity"], 0.0,
                               delta=1e-12)
        self.assertAlmostEqual(out["floor"]["level"] * 25, 200.0,
                               delta=1e-9)
        # Flattening is idempotent on the flat depreciation stream, so
        # the cap side's depreciation block is the same annual 8.
        self.assertAlmostEqual(out["cap"]["depreciationAnnuity"], 8.0,
                               delta=1e-9)

    def test_residual_left_standing_earns_the_return(self):
        # residualValue = RAV: depreciation is zero every year, the
        # opening RAV never declines, and the level collapses to the
        # flat return on the standing residual: 0.05 x 240 = 12.
        out = cffm_levels(dict(self.BASE, residualValue=240))
        self.assertAlmostEqual(out["cap"]["depreciationAnnuity"], 0.0,
                               delta=1e-12)
        self.assertAlmostEqual(out["cap"]["level"], 12.0, delta=1e-9)


class TransactionCostTest(unittest.TestCase):
    """The one-shot transfer charge: tx = pre-op RAV x (gearing x
    txDebtRate + (1 - gearing) x txEquityRate), added to the RAV at the
    start of operations. Pre-op RAV pinned to exactly 200 (single
    construction year, no devex, no IDC)."""

    BASE = {"constructionYears": 1, "devex": 0, "capex": 200,
            "idcRate": 0, "gearing": 0.55, "txDebtRate": 0.01,
            "txEquityRate": 0.04, "opexFixed": 0, "decom": 0,
            "opYears": 25, "residualValue": 0, "floorRate": 0.0447,
            "capRate": 0.0748}

    def test_gearing_split_by_hand(self):
        # 200 x (0.55 x 0.01 + 0.45 x 0.04) = 200 x 0.0235 = 4.7.
        out = cffm_levels(self.BASE)
        self.assertAlmostEqual(out["txTotal"], 4.7, delta=1e-9)
        self.assertAlmostEqual(out["rav"], 204.7, delta=1e-9)

    def test_all_debt_and_all_equity_ends(self):
        # gearing 1 -> the debt rate alone: 200 x 0.01 = 2;
        # gearing 0 -> the equity rate alone: 200 x 0.04 = 8.
        self.assertAlmostEqual(
            cffm_levels(dict(self.BASE, gearing=1))["txTotal"], 2.0,
            delta=1e-9)
        self.assertAlmostEqual(
            cffm_levels(dict(self.BASE, gearing=0))["txTotal"], 8.0,
            delta=1e-9)


class CorridorTest(unittest.TestCase):
    """D77 corridor arithmetic, hand cases against floor 30 / cap 45
    over 25 years. Lifetime figures are annual x 25, flat and
    deliberately undiscounted."""

    LEVELS = {"floorLevel": 30.0, "capLevel": 45.0}
    GMS = {"gmLow": 24.0, "gmCentral": 40.0, "gmHigh": 55.0,
           "opYears": 25}

    def test_below_floor(self):
        # gm 24: top-up is the shortfall (30 - 24 = 6, lifetime 150);
        # nothing above the cap, so no clawback and gm kept whole.
        low = cffm_corridor(self.LEVELS, self.GMS)["low"]
        self.assertAlmostEqual(low["topUp"], 6.0, delta=1e-12)
        self.assertAlmostEqual(low["lifetimeTopUp"], 150.0, delta=1e-9)
        self.assertEqual(low["aboveCap"], 0.0)
        self.assertEqual(low["clawback"], 0.0)
        self.assertAlmostEqual(low["retained"], 24.0, delta=1e-12)

    def test_inside_corridor(self):
        # gm 40 sits between 30 and 45: both transfers are zero.
        central = cffm_corridor(self.LEVELS, self.GMS)["central"]
        self.assertEqual(central["topUp"], 0.0)
        self.assertEqual(central["clawback"], 0.0)
        self.assertAlmostEqual(central["retained"], 40.0, delta=1e-12)
        self.assertAlmostEqual(central["lifetimeRetained"], 1000.0,
                               delta=1e-9)

    def test_above_cap(self):
        # gm 55: excess 10 above the cap, clawback 0.7 x 10 = 7
        # (lifetime 175), retained 55 - 7 = 48 (lifetime 1200).
        high = cffm_corridor(self.LEVELS, self.GMS)["high"]
        self.assertEqual(high["topUp"], 0.0)
        self.assertAlmostEqual(high["aboveCap"], 10.0, delta=1e-12)
        self.assertAlmostEqual(high["clawback"], 7.0, delta=1e-12)
        self.assertAlmostEqual(high["retained"], 48.0, delta=1e-12)
        self.assertAlmostEqual(high["lifetimeClawback"], 175.0, delta=1e-9)
        self.assertAlmostEqual(high["lifetimeRetained"], 1200.0, delta=1e-9)

    def test_fa_score(self):
        # gmCentral / floorLevel: 40/30 = 1.3333...; and exactly 0.60 at
        # a 50 floor with a 30 central case (the published demotion
        # threshold is a UI concern — the engine just reports the ratio).
        out = cffm_corridor(self.LEVELS, self.GMS)
        self.assertAlmostEqual(out["faScore"], 40.0 / 30.0, delta=1e-12)
        at_060 = cffm_corridor({"floorLevel": 50.0, "capLevel": 60.0},
                               dict(self.GMS, gmCentral=30.0))
        self.assertEqual(at_060["faScore"], 0.6)

    def test_fa_score_null_for_non_positive_floor(self):
        out = cffm_corridor({"floorLevel": 0.0, "capLevel": 45.0},
                            self.GMS)
        self.assertIsNone(out["faScore"])


class NullSafetyTest(unittest.TestCase):
    """Missing/non-finite inputs return None — never a number, never an
    exception — matching the JS engine's null-guard discipline."""

    GOOD = {"constructionYears": 2, "devex": 5, "capex": 100,
            "idcRate": 0.06, "gearing": 0.5, "txDebtRate": 0.01,
            "txEquityRate": 0.04, "opexFixed": 2, "decom": 0.5,
            "opYears": 25, "residualValue": 0, "floorRate": 0.0447,
            "capRate": 0.0748}

    def test_good_inputs_do_compute(self):
        self.assertIsNotNone(cffm_levels(self.GOOD))

    def test_levels_missing_or_bad_inputs(self):
        self.assertIsNone(cffm_levels(None))
        self.assertIsNone(cffm_levels({}))
        for key in ("capex", "idcRate", "floorRate"):
            missing = dict(self.GOOD)
            del missing[key]
            self.assertIsNone(cffm_levels(missing), key)
        self.assertIsNone(cffm_levels(dict(self.GOOD, idcRate="0.06")))
        self.assertIsNone(cffm_levels(dict(self.GOOD, capex=float("nan"))))
        self.assertIsNone(cffm_levels(dict(self.GOOD,
                                           devex=float("inf"))))

    def test_levels_nonsense_years(self):
        self.assertIsNone(cffm_levels(dict(self.GOOD, opYears=0)))
        self.assertIsNone(cffm_levels(dict(self.GOOD, opYears=-5)))
        self.assertIsNone(cffm_levels(dict(self.GOOD,
                                           constructionYears=0)))

    def test_corridor_missing_or_bad_inputs(self):
        levels = {"floorLevel": 30.0, "capLevel": 45.0}
        gms = {"gmLow": 24.0, "gmCentral": 40.0, "gmHigh": 55.0,
               "opYears": 25}
        self.assertIsNone(cffm_corridor(None, gms))
        self.assertIsNone(cffm_corridor(levels, None))
        missing = dict(gms)
        del missing["gmHigh"]
        self.assertIsNone(cffm_corridor(levels, missing))
        self.assertIsNone(cffm_corridor({"floorLevel": 30.0}, gms))
        self.assertIsNone(cffm_corridor(levels, dict(gms, opYears=0)))
        self.assertIsNone(cffm_corridor(levels, dict(gms, opYears=-1)))


class AnnuitisedEndOfLifeTest(unittest.TestCase):
    """D79's converter: a one-off cost X at the end of the regime is
    NPV-equivalent to X x (1+r)^-N x AF(r, N) per year. Hand-pinned at
    the owner's own trap case — a one-off £4.5m at year 25 at the
    4.47% floor rate annuitises to ≈£0.1014m/yr, NOT the £4.5m/yr the
    field would otherwise silently multiply by 25."""

    def test_owner_trap_case_by_hand(self):
        # 4.5 x 1.0447^-25 x AF(0.0447, 25)
        #   = 4.5 x 0.33512755 x 0.06723094 = 0.10138923.
        out = cffm_annuitise_end_of_life(4.5, 0.0447, 25)
        self.assertAlmostEqual(out, 0.10138923167459345, delta=1e-9)
        # Closed form recomputed with the test's own annuity_factor —
        # never the engine's.
        self.assertAlmostEqual(
            out, 4.5 * (1.0447 ** -25) * annuity_factor(0.0447, 25),
            delta=1e-12)

    def test_zero_rate_degenerates_to_plain_spreading(self):
        self.assertAlmostEqual(cffm_annuitise_end_of_life(4.5, 0, 25),
                               0.18, delta=1e-12)

    def test_null_safety(self):
        self.assertIsNone(cffm_annuitise_end_of_life(None, 0.0447, 25))
        self.assertIsNone(cffm_annuitise_end_of_life(4.5, None, 25))
        self.assertIsNone(cffm_annuitise_end_of_life(4.5, 0.0447, 0))
        self.assertIsNone(cffm_annuitise_end_of_life(4.5, 0.0447, -1))
        self.assertIsNone(
            cffm_annuitise_end_of_life(float("nan"), 0.0447, 25))


class CsvRowsTest(unittest.TestCase):
    """D81's parameter table (cffm_csv_rows, the Python mirror of the
    export's row-builder, superseding D80's flat year table): a
    section,parameter,value row list — header row, all 17 input rows,
    the derived summary, one note row — with not_set for blanks and
    every emitted string plain ASCII (the Excel-mojibake half of the
    same owner feedback)."""

    INPUT_KEYS = ["construction_years", "capex_gbpm", "devex_gbpm",
                  "idc_rate_pct", "gearing_pct", "tx_debt_pct",
                  "tx_equity_pct", "opex_gbpm_yr", "decom_gbpm_yr",
                  "op_years", "residual_value_gbpm", "floor_return_pct",
                  "cap_return_pct", "mw", "gm_low_gbpm_yr",
                  "gm_central_gbpm_yr", "gm_high_gbpm_yr"]

    DERIVED_KEYS = (["rav_gbpm", "idc_total_gbpm", "tx_total_gbpm",
                     "floor_level_gbpm_yr", "cap_level_gbpm_yr",
                     "floor_return_annuity_gbpm",
                     "floor_depreciation_annuity_gbpm",
                     "floor_opex_block_gbpm",
                     "cap_return_annuity_gbpm",
                     "cap_depreciation_annuity_gbpm",
                     "cap_opex_block_gbpm", "fa_score"]
                    + [f"lifetime_{q}_{s}_gbpm"
                       for s in ("low", "central", "high")
                       for q in ("topup", "clawback", "retained")])

    LEVELS = {"rav": 359.54, "idcTotal": 31.28, "txTotal": 8.26,
              "floor": {"level": 30.0, "returnAnnuity": 12.0,
                        "depreciationAnnuity": 14.0, "opexBlock": 4.0},
              "cap": {"level": 45.0, "returnAnnuity": 25.0,
                      "depreciationAnnuity": 16.0, "opexBlock": 4.0}}

    # The card's raw typed state: percents as typed, gmHigh left blank.
    INPUTS = {"constructionYears": 3, "capex": 300, "devex": 20,
              "idcRate": 6.1, "gearing": 37.5, "txDebtRate": 2.5,
              "txEquityRate": 5, "opexFixed": 5, "decom": 1,
              "opYears": 25, "residualValue": 10, "floorRate": 4.47,
              "capRate": 7.48, "mw": 500, "gmLow": 24.0,
              "gmCentral": 24.0, "gmHigh": None}

    def rows(self, corridor=None, inputs=None):
        return cffm_csv_rows(self.LEVELS, corridor,
                             self.INPUTS if inputs is None else inputs)

    def corridor(self):
        # CorridorTest's hand numbers: gm 24 against floor 30 / cap 45
        # over 25 years — lifetime top-up 150, clawback 0, retained 600.
        return cffm_corridor({"floorLevel": 30.0, "capLevel": 45.0},
                             {"gmLow": 24.0, "gmCentral": 24.0,
                              "gmHigh": 24.0, "opYears": 25})

    def test_section_ordering_and_shape(self):
        rows = self.rows(self.corridor())
        self.assertEqual(rows[0], ["section", "parameter", "value"])
        self.assertEqual([r[0] for r in rows[1:]],
                         ["input"] * 17
                         + ["derived"] * len(self.DERIVED_KEYS)
                         + ["note"])
        self.assertTrue(all(len(r) == 3 for r in rows))

    def test_all_input_and_derived_keys_present_in_order(self):
        rows = self.rows(self.corridor())
        self.assertEqual([r[1] for r in rows if r[0] == "input"],
                         self.INPUT_KEYS)
        self.assertEqual([r[1] for r in rows if r[0] == "derived"],
                         self.DERIVED_KEYS)
        self.assertEqual([r[1] for r in rows if r[0] == "note"],
                         ["caveat"])

    def test_values_verbatim_inputs_and_rounded_derived(self):
        rows = self.rows(self.corridor())
        by_key = {r[1]: r[2] for r in rows[1:]}
        # Inputs verbatim, as typed (percents stay percents).
        self.assertEqual(by_key["gearing_pct"], 37.5)
        self.assertEqual(by_key["gm_central_gbpm_yr"], 24.0)
        # Derived from the levels/corridor, 4 dp.
        self.assertEqual(by_key["floor_level_gbpm_yr"], 30.0)
        self.assertEqual(by_key["cap_opex_block_gbpm"], 4.0)
        self.assertEqual(by_key["fa_score"], 0.8)
        self.assertEqual(by_key["lifetime_topup_central_gbpm"], 150.0)
        self.assertEqual(by_key["lifetime_clawback_central_gbpm"], 0.0)
        self.assertEqual(by_key["lifetime_retained_central_gbpm"], 600.0)

    def test_not_set_for_blank_inputs_and_untyped_scenarios(self):
        rows = self.rows(self.corridor())
        by_key = {r[1]: r[2] for r in rows[1:]}
        # gmHigh untyped: not_set as an input AND in its lifetime rows,
        # even though the corridor computed a defaulted high scenario.
        self.assertEqual(by_key["gm_high_gbpm_yr"], "not_set")
        for q in ("topup", "clawback", "retained"):
            self.assertEqual(by_key[f"lifetime_{q}_high_gbpm"],
                             "not_set", q)
            self.assertNotEqual(by_key[f"lifetime_{q}_low_gbpm"],
                                "not_set", q)

    def test_no_corridor_exports_not_set_scores(self):
        rows = self.rows(None, dict(self.INPUTS, gmLow=None,
                                    gmCentral=None))
        by_key = {r[1]: r[2] for r in rows[1:]}
        self.assertEqual(by_key["fa_score"], "not_set")
        for s in ("low", "central", "high"):
            self.assertEqual(by_key[f"lifetime_topup_{s}_gbpm"],
                             "not_set", s)
        # The level summary still exports — it needs no corridor.
        self.assertEqual(by_key["rav_gbpm"], 359.54)

    def test_every_emitted_string_is_ascii(self):
        # The Excel-mojibake guard: nothing beyond ASCII may enter the
        # export (the pound sign never appears here; nothing else is
        # excused either), and no value may carry a comma except the
        # one note row, which the serialiser comma-quotes.
        rows = self.rows(self.corridor())
        for section, key, value in rows:
            for cell in (section, key, value):
                if isinstance(cell, str):
                    self.assertTrue(cell.isascii(), repr(cell))
            if section != "note":
                self.assertNotIn(",", str(value), key)
        self.assertEqual(rows[-1][2], "ex-tax, flat real, indicative "
                                      "- not the CFFM, not a valuation")

    def test_null_safety(self):
        self.assertIsNone(cffm_csv_rows(None, None, self.INPUTS))
        self.assertIsNone(cffm_csv_rows(self.LEVELS, None, None))
        # An empty inputs dict is truthy in JS: all-not_set rows, not
        # None, in both languages.
        rows = cffm_csv_rows(self.LEVELS, None, {})
        self.assertEqual([r[2] for r in rows if r[0] == "input"],
                         ["not_set"] * 17)


class JsPyParityShapeTest(unittest.TestCase):
    """Mirror discipline without a JS runtime, two prongs (the
    DoubleCountGuardTest source-grep style): (1) the Python outputs for
    a full-featured case are pinned against CLOSED-FORM hand
    derivations that never run the engine's own year loop; (2) both
    source files must carry the same formula fingerprints, so a change
    to either side's IDC or annuity arithmetic that skips the mirror
    fails here by construction."""

    # Full-featured case: 3 construction years, devex 20, capex 300,
    # IDC 6.1%, gearing 0.55, tx 1%/4%, opex 5 + decom 1, 25 op years,
    # residual 10, rates 4.47%/7.48%.
    INPUTS = {"constructionYears": 3, "devex": 20, "capex": 300,
              "idcRate": 0.061, "gearing": 0.55, "txDebtRate": 0.01,
              "txEquityRate": 0.04, "opexFixed": 5, "decom": 1,
              "opYears": 25, "residualValue": 10, "floorRate": 0.0447,
              "capRate": 0.0748}

    def test_full_featured_case_pinned(self):
        # Hand derivation:
        #   IDC walk (IdcFormulaTest's devex case): pre-op closing
        #     351.28471394, IDC total 31.28471394.
        #   tx = 351.28471394 x (0.55 x 0.01 + 0.45 x 0.04)
        #      = 351.28471394 x 0.0235 = 8.25519078.
        #   RAV = 359.53990472.
        # Level, closed form (the telescoping identity — depreciation
        # plus return on opening RAV discounted at (1+r)^-n sums to
        # RAV - residual x (1+r)^-25 — plus the flat opex+decom block,
        # which annuitises to itself):
        #   level(r) = (RAV - 10 x (1+r)^-25) x AF(r) + 6
        #   AF(0.0447) = 0.06723094 -> floor level 29.94689649
        #   AF(0.0748) = 0.08955334 -> cap   level 38.05046583
        out = cffm_levels(self.INPUTS)
        self.assertAlmostEqual(out["idcTotal"], 31.284713944687045,
                               delta=1e-6)
        self.assertAlmostEqual(out["txTotal"], 8.255190777700147,
                               delta=1e-6)
        rav = 359.5399047223872
        self.assertAlmostEqual(out["rav"], rav, delta=1e-6)
        for side, r in (("floor", 0.0447), ("cap", 0.0748)):
            expected = ((rav - 10 * (1 + r) ** -25)
                        * annuity_factor(r, 25) + 6)
            self.assertAlmostEqual(out[side]["level"], expected,
                                   delta=1e-6, msg=side)
            # Flat blocks annuitise to themselves; the three blocks sum
            # to the level.
            self.assertAlmostEqual(out[side]["opexBlock"], 6.0, delta=1e-9)
            self.assertAlmostEqual(out[side]["depreciationAnnuity"],
                                   (rav - 10) / 25, delta=1e-6)
            self.assertAlmostEqual(out[side]["returnAnnuity"]
                                   + out[side]["depreciationAnnuity"]
                                   + out[side]["opexBlock"],
                                   out[side]["level"], delta=1e-9)
        self.assertAlmostEqual(out["floor"]["level"], 29.946896492071467,
                               delta=1e-6)
        self.assertAlmostEqual(out["cap"]["level"], 38.05046582991988,
                               delta=1e-6)

    def test_source_fingerprints_match_in_both_files(self):
        js = (PROJECT_ROOT / "app" / "js" / "metrics.js").read_text()
        py = (PROJECT_ROOT / "ops" / "ldes_cffm_figures.py").read_text()
        # A1.70's half-year-simple IDC denominator...
        self.assertIn("/ (2 + idcRate)", js)
        self.assertIn("/ (2 + idc_rate)", py)
        # ...and A1.151's annuity factor, in each language's idiom.
        self.assertIn("1 - Math.pow(1 +", js)
        self.assertIn("1 - (1 + r) ** -op_years", py)
        # The mirror header contract must survive edits.
        self.assertIn("MIRRORS app/js/metrics.js (cffmLevels -> "
                      "cffm_levels,\ncffmCorridor -> cffm_corridor). "
                      "If those change, change this.", py)
        # D79/D80 mirrors: the end-of-life annuitisation lump-discount
        # step, in each language's idiom...
        self.assertIn("amount * Math.pow(1 + rate, -opYears) * af", js)
        self.assertIn("amount * (1 + rate) ** -op_years * af", py)
        # ...and D81's parameter-table schema, in both: the header
        # row (same literal in both languages), the annuity sub-block
        # and lifetime key stems, and the ASCII caveat text.
        for token in ('["section", "parameter", "value"]',
                      "cap_depreciation_annuity_gbpm",
                      "lifetime_topup_", "lifetime_clawback_",
                      "lifetime_retained_",
                      "indicative - not the CFFM, not a valuation"):
            self.assertIn(token, js)
            self.assertIn(token, py)

    def test_card_uses_the_mirrored_engine_functions(self):
        """The card's live line and CSV export must go through the
        engine functions this file tests — not re-derive the annuity or
        the row schema in the view layer (charts.js has no test runner
        of its own, so this source grep is the guard)."""
        charts = (PROJECT_ROOT / "app" / "js" / "charts.js").read_text()
        self.assertIn("Metrics.cffmAnnuitiseEndOfLife", charts)
        self.assertIn("Metrics.cffmCsvRows", charts)
        self.assertIn("gb_ldes_minicffm.csv", charts)
        # Both calculator CSV downloads prepend the UTF-8 BOM (D81's
        # Excel-mojibake fix) — as the visible escape, never a literal
        # BOM character an editor could silently strip.
        self.assertEqual(charts.count('"\\uFEFF" + csv'), 2)
        self.assertNotIn("\ufeff", charts)


class WorkbookExportTest(unittest.TestCase):
    """D82: the mini-CFFM live-formula workbook export
    (gb_ldes_minicffm.xlsx), the BESS WorkbookExport discipline applied
    to the LDES card. Fixture is
    tests/fixtures/ldes_wb_case_1/{inputs.json, workbook.b64}, captured
    2026-08-29 by driving the app's real card on the dev server (:8137)
    — filling every field through the delegated input listener and
    intercepting the "Export model (Excel)" button's own Blob — so the
    bytes are exactly what a reader downloads, not a re-serialisation.

    inputs.json carries the ENGINE-level input shape (fractions, the
    same keys cffm_levels consumes) plus mw and the three gross-margin
    scenarios, read straight off the captured workbook's own Inputs
    cells at capture time — the bess_wb_case_* convention, kept even
    though this card has no daily-refreshed payload behind it, so the
    fixture stays self-contained and an engine change fails loudly.

    ldes_wb_case_1: 3 construction years, devex 4.5, capex 150, the
    Ofgem indicative rate prefills untouched (IDC 6.1%, gearing 37.5%,
    tx 2.5%/5%, floor 4.47%, cap 7.48%, 25 op years, zero residual),
    opex 3 + decom 0.3, 65 MW, GM 11.5/14.5/19 — every block of the
    Levels sheet exercised, corridor inside the floor (a positive
    central top-up, zero clawback).

    Cell addresses below are the builder's LDES_WROW/LDES_LROW row maps
    in app/js/charts.js (Inputs!E7-E29; Levels: RAV E12, levels E33/34,
    lifetime E45-47, FA E48, checks E51/52) — change a map there and
    these move with it."""

    EXPECTED_PARTS = {
        "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/theme/theme1.xml",
        "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml",
        "xl/worksheets/sheet3.xml",
    }

    # Inputs-sheet row per engine key (LDES_WROW verbatim).
    WROW = {"mw": 7, "constructionYears": 8, "devex": 9, "capex": 10,
            "idcRate": 13, "gearing": 14, "txDebtRate": 15,
            "txEquityRate": 16, "floorRate": 17, "capRate": 18,
            "opYears": 19, "residualValue": 20, "opexFixed": 23,
            "decom": 24, "gmLow": 27, "gmCentral": 28, "gmHigh": 29}

    @classmethod
    def setUpClass(cls):
        fixdir = FIXTURES / "ldes_wb_case_1"
        cls.inputs = json.loads((fixdir / "inputs.json").read_text())
        cls.xlsx_bytes = base64.b64decode((fixdir / "workbook.b64").read_text())
        cls.model, cls.names, cls.sheet_names, cls.parts = (
            xe.load_workbook(cls.xlsx_bytes))

    @staticmethod
    def _tol(expected):
        return max(1e-6 * abs(expected), 0.01)

    def _grid(self, model=None):
        return xe.Grid(model if model is not None else self.model, self.names)

    # 1. zipfile validates every CRC.
    def test_zip_is_readable(self):
        zf = zipfile.ZipFile(io.BytesIO(self.xlsx_bytes))
        self.assertIsNone(zf.testzip())

    # 2. exactly the nine expected parts; three sheets in order.
    def test_part_list_and_sheet_order(self):
        self.assertEqual(set(self.parts), self.EXPECTED_PARTS)
        self.assertEqual(len(self.parts), 9)
        self.assertEqual(self.sheet_names, ["Cover", "Inputs", "Levels"])

    # 3. no macro, no external link, no calc chain part (no cached
    # values anywhere: every derived cell ships as a bare formula).
    def test_no_macro_no_external_link_no_calcchain(self):
        for name in self.parts:
            self.assertNotIn("vbaProject", name)
            self.assertNotIn("externalLink", name)
            self.assertNotIn("calcChain", name)

    # 4. every part is well-formed XML.
    def test_every_part_parses(self):
        zf = zipfile.ZipFile(io.BytesIO(self.xlsx_bytes))
        for name in zf.namelist():
            ET.fromstring(zf.read(name))

    # 5. EVERY formula in the workbook parses and evaluates inside
    # ops/xlsx_eval.py's closed grammar — a formula outside it (or a
    # circular reference) raises here, which is the point.
    def test_every_formula_evaluates(self):
        g = self._grid()
        count = 0
        for sheet, rows in self.model.items():
            for r, row in rows.items():
                for c, cell in row.items():
                    if cell["t"] == "f":
                        g.value(sheet, "%s%d" % (xe.col_name(c), r))
                        count += 1
        # The 25-year operations grid alone is hundreds of formulas; a
        # collapse to a handful would mean the sheet lost its grid.
        self.assertGreater(count, 400)

    # 6. the Inputs cells hold exactly the engine-level fixture inputs
    # (fractions, unset-resolved) — the premise of every parity
    # assertion below.
    def test_inputs_cells_hold_the_engine_inputs(self):
        g = self._grid()
        for key, row in self.WROW.items():
            got = g.value("Inputs", "E%d" % row)
            self.assertAlmostEqual(got, self.inputs[key], delta=1e-12,
                                   msg=key)

    # 7. RAV, both levels, the FA score and the lifetime corridor cells
    # all match ops/ldes_cffm_figures within the workbook tolerance.
    def test_headline_cells_match_the_mirror(self):
        g = self._grid()
        lv = cffm_levels(self.inputs)
        corr = cffm_corridor(
            {"floorLevel": lv["floor"]["level"],
             "capLevel": lv["cap"]["level"]},
            {"gmLow": self.inputs["gmLow"],
             "gmCentral": self.inputs["gmCentral"],
             "gmHigh": self.inputs["gmHigh"],
             "opYears": self.inputs["opYears"]})
        expect = [
            ("E12", lv["rav"]),
            ("E33", lv["floor"]["level"]),
            ("E34", lv["cap"]["level"]),
            ("E45", corr["central"]["lifetimeTopUp"]),
            ("E46", corr["central"]["lifetimeClawback"]),
            ("E47", corr["central"]["lifetimeRetained"]),
            ("E48", corr["faScore"]),
        ]
        for ref, want in expect:
            got = g.value("Levels", ref)
            self.assertAlmostEqual(got, want, delta=self._tol(want),
                                   msg=ref)

    # 8. the Cover's headline mirrors are pure links to those cells.
    def test_cover_mirrors_match_levels(self):
        g = self._grid()
        for cover_ref, levels_ref in (("E6", "E12"), ("E7", "E33"),
                                      ("E8", "E34"), ("E9", "E48")):
            self.assertEqual(g.value("Cover", cover_ref),
                             g.value("Levels", levels_ref), cover_ref)

    # 9. the telescoping-identity check rows: PV(depreciation + return)
    # discounted at each rate equals RAV less the discounted residual —
    # the engine's return base exists to guarantee this, so both rows
    # must evaluate to (numerically) zero.
    def test_identity_check_rows_are_zero(self):
        g = self._grid()
        for ref in ("E51", "E52"):
            self.assertAlmostEqual(g.value("Levels", ref), 0.0,
                                   delta=1e-6, msg=ref)

    def _variant(self, **overrides):
        """Evaluate the SAME workbook with Inputs cells overridden in
        memory (the BESS test_both_discounting_conventions pattern) and
        return (grid, mirrored python inputs). The formulas are
        untouched: this is the live-formula claim under test — new
        inputs, same cells, engine-parity output."""
        model = copy.deepcopy(self.model)
        inputs = dict(self.inputs)
        for key, value in overrides.items():
            row = self.WROW[key]
            model["Inputs"][row][xe.col_num("E")] = {"t": "n",
                                                     "v": float(value)}
            inputs[key] = value
        return self._grid(model), inputs

    # 10. an ungeared/no-tx variant, evaluated in memory: with gearing
    # and both transaction-cost rates zeroed the tx cell must be
    # exactly 0, and RAV and both levels must still match the mirror
    # run on the same overridden inputs.
    def test_ungeared_variant_matches_the_mirror(self):
        g, inputs = self._variant(gearing=0.0, txDebtRate=0.0,
                                  txEquityRate=0.0)
        lv = cffm_levels(inputs)
        self.assertEqual(g.value("Levels", "E11"), 0.0)
        for ref, want in (("E12", lv["rav"]),
                          ("E33", lv["floor"]["level"]),
                          ("E34", lv["cap"]["level"])):
            self.assertAlmostEqual(g.value("Levels", ref), want,
                                   delta=self._tol(want), msg=ref)

    # 11. the card's own advertised identity (methodology: "zero opex,
    # zero residual: level = RAV x AF"), through the workbook's
    # formulas with the cost cells zeroed in memory — and the check
    # rows must stay at zero under the overrides too.
    def test_simple_variant_level_is_rav_times_annuity_factor(self):
        g, inputs = self._variant(opexFixed=0.0, decom=0.0,
                                  residualValue=0.0)
        rav = g.value("Levels", "E12")
        for ref, rate in (("E33", inputs["floorRate"]),
                          ("E34", inputs["capRate"])):
            want = rav * annuity_factor(rate, inputs["opYears"])
            self.assertAlmostEqual(g.value("Levels", ref), want,
                                   delta=self._tol(want), msg=ref)
        for ref in ("E51", "E52"):
            self.assertAlmostEqual(g.value("Levels", ref), 0.0,
                                   delta=1e-6, msg=ref)

    # 12. the annuity factor's rate-0 branch, live: floor rate 0 makes
    # the factor exactly 1/opYears and the level the mirror's own
    # rate-0 figure.
    def test_zero_rate_branch(self):
        g, inputs = self._variant(floorRate=0.0)
        lv = cffm_levels(inputs)
        self.assertAlmostEqual(g.value("Levels", "E31"),
                               1.0 / inputs["opYears"], delta=1e-12)
        want = lv["floor"]["level"]
        self.assertAlmostEqual(g.value("Levels", "E33"), want,
                               delta=self._tol(want))

    # 13. the export's ASCII rule: no em dash, and nothing non-ASCII
    # beyond the pound sign, in any inline string on any sheet.
    def test_no_em_dash_or_non_ascii_in_any_string(self):
        for sheet, rows in self.model.items():
            for r, row in rows.items():
                for c, cell in row.items():
                    if cell["t"] != "s":
                        continue
                    self.assertNotIn("—", cell["v"])
                    for ch in cell["v"]:
                        self.assertTrue(ord(ch) < 128 or ch == "£",
                                        "%s!%s%d: %r" % (sheet,
                                                         xe.col_name(c),
                                                         r, ch))

    # 14. the defined names bind the two rate cells (the workbook's
    # FLOOR_RATE/CAP_RATE, used across the Levels formulas).
    def test_defined_names(self):
        self.assertEqual(self.names.get("FLOOR_RATE"), "Inputs!$E$17")
        self.assertEqual(self.names.get("CAP_RATE"), "Inputs!$E$18")


if __name__ == "__main__":
    unittest.main()

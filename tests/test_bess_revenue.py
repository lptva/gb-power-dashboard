"""Pure-logic checks for etl/build_bess_revenue.py — the observable BESS
revenue stack of plan/08 (issue #47).

Fixtures reproduce the numbers in plan/08's evidence tables (the
BLHLB-1 DRH negative-price row, the T_THURB-1 EBOCF/DISPTAV hand
reconciliation, the SP40 cross-endpoint sign example) so each test also
serves as a regression against the design doc's own probes.

No file or network access — the pure functions are imported without
touching the HTTP layer (build_dataset stays unimported, so the suite
runs on the stdlib-only CI worker), matching the house rule in
tests/test_stress_flags.py.
"""

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "etl"))

from build_bess_revenue import (  # noqa: E402
    COHORT_METHOD,
    PAIR_KEYS,
    PRODUCT_KEYS,
    PRODUCTS,
    REPD_OPERATIONAL_MW,
    REPD_VINTAGE,
    SOURCE_META,
    CohortSanityError,
    WindowMismatch,
    aggregate_eac,
    assemble_payload,
    assert_windows,
    bm_fetch_range,
    build_cohort,
    clock_change_day_strings,
    cohort_coverage_block,
    denominator_kw_series,
    eac_gbp_per_kw_day_series,
    eac_query_sql,
    first_seen_days,
    latest_day_with_data,
    matches_d9_signature,
    merge_bm_days,
    parse_interval_hours,
    percentile,
    qualifies_d13,
    reconcile_ebocf,
    revenue_gbp,
    sum_cohort_pairs,
    sum_pair_cashflows,
    trim_to_retain,
    unit_spread_series,
    validate_cohort_mw,
    window_query_sql,
)


# ---------------------------------------------------------------------------
# 1. Revenue arithmetic
# ---------------------------------------------------------------------------

class RevenueArithmeticTest(unittest.TestCase):
    """executedQuantity x clearingPrice x window_h, on rows adjacent to
    T_THURB-1 in the design doc's probe, including the BLHLB-1 negative
    clearing-price row (plan/08, D13 evidence: 35 MW x -13.39 x 4h)."""

    def test_negative_price_row(self):
        self.assertAlmostEqual(revenue_gbp(35.0, -13.39, 4.0), -1874.60, places=6)

    def test_full_drh_day_for_blhlb1(self):
        # The six BLHLB-1 DRH rows for 2026-07-20, live-probed 2026-07-29.
        rows = [
            (35.0, -13.39), (35.0, -17.44), (30.0, -16.91),
            (35.0, -15.42), (30.0, -11.84), (35.0, -13.13),
        ]
        total = sum(revenue_gbp(q, p, 4.0) for q, p in rows)
        expected = sum(q * p * 4.0 for q, p in rows)
        self.assertAlmostEqual(total, expected, places=6)
        self.assertLess(total, 0)  # DRH cleared negative all day — units paid

    def test_positive_price_row(self):
        self.assertAlmostEqual(revenue_gbp(50.0, 5.0, 0.5), 125.0)


# ---------------------------------------------------------------------------
# 2. Window assertion
# ---------------------------------------------------------------------------

class WindowAssertionTest(unittest.TestCase):
    def test_parses_four_hour_and_half_hour(self):
        self.assertAlmostEqual(parse_interval_hours("4:00:00"), 4.0)
        self.assertAlmostEqual(parse_interval_hours("0:30:00"), 0.5)

    def test_consistent_windows_return_hours(self):
        rows = [
            {"product": "DRH", "minw": "4:00:00", "maxw": "4:00:00"},
            {"product": "PSR", "minw": "0:30:00", "maxw": "0:30:00"},
        ]
        hours = assert_windows(rows)
        self.assertEqual(hours, {"DRH": 4.0, "PSR": 0.5})

    def test_mismatched_window_raises(self):
        rows = [{"product": "DRH", "minw": "4:00:00", "maxw": "3:30:00"}]
        with self.assertRaises(WindowMismatch):
            assert_windows(rows)

    def test_mismatch_across_resources_raises(self):
        # Same product, consistent within each resource-scoped query, but
        # disagreeing between the two resources — must still be caught.
        rows = [
            {"product": "DCL", "minw": "4:00:00", "maxw": "4:00:00"},
            {"product": "DCL", "minw": "4:00:00", "maxw": "4:30:00"},
        ]
        with self.assertRaises(WindowMismatch):
            assert_windows(rows)


# ---------------------------------------------------------------------------
# 3. WAF-safe SQL — a unit test on the query builder, not a live call
# ---------------------------------------------------------------------------

class ClockChangeDayTest(unittest.TestCase):
    """Discovered live, 2026-07-29: running assert_windows() across the
    full FY2025+FY2026 history (not a single day, as plan/08's own probe
    used) surfaces a real, twice-yearly UK clock-change artifact — one
    EFA block that day genuinely spans a different UTC-elapsed duration
    (5h on the autumn change, 3h on the spring change) than its
    product's true wall-clock window. clock_change_day_strings() excludes
    exactly those calendar dates from the window-assertion query, so the
    guard itself (assert_windows, tested above) stays strict."""

    def test_known_2025_and_2026_transition_dates_are_excluded(self):
        excluded = clock_change_day_strings("2025-01-01", "2027-01-01")
        # Verified live: the FY2025 archive's actual anomalies bucket to
        # exactly these two dates.
        self.assertIn("2025-10-25", excluded)
        self.assertIn("2026-03-28", excluded)

    def test_range_outside_any_transition_excludes_nothing(self):
        excluded = clock_change_day_strings("2025-06-01", "2025-06-05")
        self.assertEqual(excluded, [])

    def test_window_query_sql_applies_the_exclusion(self):
        sql = window_query_sql("rid", "2025-06-01", "2025-06-02",
                               exclude_days=["2025-10-25"])
        self.assertIn("NOT IN ('2025-10-25')", sql)
        self.assertNotIn("EXTRACT(", sql)
        self.assertNotIn("date(", sql.lower())

    def test_window_query_sql_without_exclusion_is_unchanged(self):
        sql = window_query_sql("rid", "2025-06-01", "2025-06-02")
        self.assertNotIn("NOT IN", sql)


class WafSafeSqlTest(unittest.TestCase):
    """NESO's CKAN datastore_search_sql WAF returns HTTP 403 for
    EXTRACT(...) and date(...) (verified live, 2026-07-29). The query
    builders must never emit either."""

    def test_eac_query_avoids_both_traps(self):
        sql = eac_query_sql("some-resource-id", "2025-06-01", "2025-06-02")
        self.assertNotIn("EXTRACT(", sql)
        self.assertNotIn("date(", sql.lower())
        self.assertIn("to_char(", sql)

    def test_window_query_avoids_both_traps(self):
        sql = window_query_sql("some-resource-id", "2025-06-01", "2025-06-02")
        self.assertNotIn("EXTRACT(", sql)
        self.assertNotIn("date(", sql.lower())
        self.assertIn("-", sql)  # interval subtraction, not a function call


# ---------------------------------------------------------------------------
# 4. Join and cohort (D13)
# ---------------------------------------------------------------------------

def registry_fixture():
    """One T_, one E_, one V__ at 0.000 capacity, one 2__ — the D13
    boundary cases from plan/08's cohort evidence."""
    return {
        "TESTT-1": {"elexonBmUnit": "T_TESTT-1", "nationalGridBmUnit": "TESTT-1",
                    "generationCapacity": "50.000", "demandCapacity": "-50.000",
                    "fuelType": None, "interconnectorId": None,
                    "bmUnitName": "Test Battery T"},
        "TESTE-1": {"elexonBmUnit": "E_TESTE-1", "nationalGridBmUnit": "TESTE-1",
                    "generationCapacity": "30.000", "demandCapacity": "-30.000",
                    "fuelType": None, "interconnectorId": None,
                    "bmUnitName": "Test Battery E"},
        "TESTV-1": {"elexonBmUnit": "V__TESTV01", "nationalGridBmUnit": "TESTV-1",
                    "generationCapacity": "0.000", "demandCapacity": "0.000",
                    "fuelType": None, "interconnectorId": None,
                    "bmUnitName": "Test VLP Portfolio"},
        "TEST2-1": {"elexonBmUnit": "2__TEST2CD", "nationalGridBmUnit": "TEST2-1",
                    "generationCapacity": "40.000", "demandCapacity": "-40.000",
                    "fuelType": None, "interconnectorId": None,
                    "bmUnitName": "Test Aggregator"},
    }


class CohortJoinTest(unittest.TestCase):
    def test_cohort_is_exactly_the_t_and_e_pair(self):
        registry = registry_fixture()
        eac_unit_ids = ["TESTT-1", "TESTE-1", "TESTV-1", "TEST2-1", "UNMATCHED-1"]
        cohort, signature_hits = build_cohort(registry, eac_unit_ids)
        self.assertEqual(set(cohort), {"TESTT-1", "TESTE-1"})
        self.assertAlmostEqual(
            sum(info["cap_mw"] for info in cohort.values()), 80.0)

    def test_join_key_is_case_and_whitespace_insensitive(self):
        registry = registry_fixture()
        cohort, _ = build_cohort(registry, [" testt-1 "])
        self.assertEqual(set(cohort), {" testt-1 "})  # original string kept as key

    def test_unmatched_and_zero_capacity_v_do_not_qualify(self):
        registry = registry_fixture()
        cohort, _ = build_cohort(registry, ["TESTV-1", "TEST2-1", "NOPE-1"])
        self.assertEqual(cohort, {})

    def test_both_coverage_figures_compute(self):
        registry = registry_fixture()
        cohort, signature_hits = build_cohort(
            registry, ["TESTT-1", "TESTE-1", "TESTV-1", "TEST2-1"])
        block = cohort_coverage_block(
            cohort, signature_hits, cohort_gross=800.0, all_gross=1000.0,
            repd_mw=100.0, repd_vintage="TEST")
        self.assertEqual(block["units"], 2)
        self.assertAlmostEqual(block["mw"], 80.0)
        self.assertAlmostEqual(block["coverage_repd"], 0.8)
        self.assertAlmostEqual(block["coverage_eac_gross"], 0.8)
        self.assertEqual(block["method"], COHORT_METHOD)

    def test_cohort_sanity_tripwire_on_empty_cohort(self):
        with self.assertRaises(CohortSanityError):
            validate_cohort_mw(0.0, repd_mw=100.0)

    def test_cohort_sanity_tripwire_on_implausible_ratio(self):
        with self.assertRaises(CohortSanityError):
            validate_cohort_mw(500.0, repd_mw=100.0)  # 500% of REPD
        with self.assertRaises(CohortSanityError):
            validate_cohort_mw(10.0, repd_mw=100.0)   # 10% of REPD


class QualifiesD13Test(unittest.TestCase):
    def test_e_and_t_prefix_with_positive_capacity_qualify(self):
        self.assertTrue(qualifies_d13(
            {"elexonBmUnit": "E_TEST-1", "generationCapacity": "10.0"}))
        self.assertTrue(qualifies_d13(
            {"elexonBmUnit": "T_TEST-1", "generationCapacity": "10.0"}))

    def test_v_prefix_excluded_even_with_capacity(self):
        self.assertFalse(qualifies_d13(
            {"elexonBmUnit": "V__TEST01", "generationCapacity": "10.0"}))

    def test_supplier_prefix_excluded(self):
        self.assertFalse(qualifies_d13(
            {"elexonBmUnit": "2__TESTCD", "generationCapacity": "10.0"}))

    def test_zero_capacity_excluded(self):
        self.assertFalse(qualifies_d13(
            {"elexonBmUnit": "T_TEST-1", "generationCapacity": "0.000"}))

    def test_missing_capacity_does_not_raise(self):
        self.assertFalse(qualifies_d13(
            {"elexonBmUnit": "T_TEST-1", "generationCapacity": None}))
        self.assertFalse(qualifies_d13(
            {"elexonBmUnit": "T_TEST-1", "generationCapacity": ""}))


class D9SignatureCrossCheckTest(unittest.TestCase):
    """#24's structural-or-name signature, reimplemented here only for
    the coverage-caption cross-check (see module docstring)."""

    def test_structural_match(self):
        self.assertTrue(matches_d9_signature({
            "elexonBmUnit": "T_TEST-1", "generationCapacity": "52.0",
            "demandCapacity": "-52.0", "fuelType": None,
            "interconnectorId": None, "bmUnitName": "T_TEST-1",
            "nationalGridBmUnit": "TEST-1"}))

    def test_name_only_match_recovers_asymmetric_registration(self):
        self.assertTrue(matches_d9_signature({
            "elexonBmUnit": "E_OVRHB-1", "generationCapacity": "49.0",
            "demandCapacity": "-0.39", "fuelType": None,
            "interconnectorId": None, "bmUnitName": "Overhill BESS",
            "nationalGridBmUnit": "OVRHB-1"}))

    def test_demand_bmu_excluded(self):
        self.assertFalse(matches_d9_signature({
            "elexonBmUnit": "T_WISHD-1", "generationCapacity": "10.0",
            "demandCapacity": "-10.0", "fuelType": None,
            "interconnectorId": None, "bmUnitName": "Wishaw Demand BMU",
            "nationalGridBmUnit": "WISHD-1"}))

    def test_leadpartyname_alone_does_not_fire_name_match(self):
        # A CCGT owned by "... Energy Storage Ltd" must not match on the
        # party name — only bmUnitName/elexonBmUnit/nationalGridBmUnit.
        self.assertFalse(matches_d9_signature({
            "elexonBmUnit": "T_CCGT-1", "generationCapacity": "400.0",
            "demandCapacity": None, "fuelType": "CCGT",
            "interconnectorId": None, "bmUnitName": "CCGT Unit 1",
            "nationalGridBmUnit": "CCGT-1"}))


# ---------------------------------------------------------------------------
# 5. Time-varying denominator (D13)
# ---------------------------------------------------------------------------

class DenominatorTest(unittest.TestCase):
    def test_denominator_steps_on_first_appearance(self):
        cohort = {"A": {"elexon_id": "T_A", "cap_mw": 100.0},
                 "B": {"elexon_id": "T_B", "cap_mw": 50.0}}
        first_seen = {"A": "2025-01-01", "B": "2025-01-03"}
        days = ["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04"]
        denom = denominator_kw_series(days, cohort, first_seen)
        self.assertEqual(denom, [100000, 100000, 150000, 150000])

    def test_constant_denominator_understates_the_earlier_period(self):
        """Reproduces D13's ~40% error illustration: dividing an early
        day's revenue by the FINAL (present-day) denominator understates
        it relative to dividing by that day's own (smaller) active
        capacity."""
        cohort = {"A": {"elexon_id": "T_A", "cap_mw": 100.0},
                 "B": {"elexon_id": "T_B", "cap_mw": 50.0}}
        first_seen = {"A": "2025-01-01", "B": "2025-01-03"}
        days = ["2025-01-01", "2025-01-04"]
        denom = denominator_kw_series(days, cohort, first_seen)
        gbp_day1 = 100.0
        correct = gbp_day1 / denom[0]
        wrong_with_constant_final_denominator = gbp_day1 / denom[-1]
        self.assertLess(wrong_with_constant_final_denominator, correct)
        self.assertAlmostEqual(
            wrong_with_constant_final_denominator / correct,
            denom[0] / denom[-1])

    def test_first_seen_is_earliest_day_per_unit(self):
        rows = [
            {"day": "2025-06-02", "unit": "A", "product": "DCL", "gbp_ex_window": 1.0},
            {"day": "2025-06-01", "unit": "A", "product": "DCH", "gbp_ex_window": 1.0},
            {"day": "2025-06-05", "unit": "B", "product": "DCL", "gbp_ex_window": 1.0},
        ]
        first = first_seen_days(rows)
        self.assertEqual(first, {"A": "2025-06-01", "B": "2025-06-05"})


# ---------------------------------------------------------------------------
# 6. BM sign conventions (D18)
# ---------------------------------------------------------------------------

class BmSignConventionTest(unittest.TestCase):
    """Fixture built from the reconciled T_THURB-1 SP40 record (plan/08):
    the bid endpoint's negative1 pair settles negative (the unit paying
    to charge), the offer endpoint's acceptance on the SAME negative1
    pair settles positive (coming back up toward its notification), and
    the per-unit-period net is the sum of both endpoints."""

    BID_SP40 = -1206.17
    OFFER_SP40 = 521.91

    def _pairs(self, value):
        return {key: (value if key == "negative1" else None)
                for key in PAIR_KEYS}

    def test_bid_endpoint_negative_pair_settles_negative(self):
        row = {"bmUnit": "T_THURB-1", "bidOfferPairCashflows": self._pairs(self.BID_SP40)}
        total = sum_cohort_pairs([row], {"T_THURB-1"}, "bidOfferPairCashflows")
        self.assertAlmostEqual(total, self.BID_SP40)
        self.assertLess(total, 0)

    def test_offer_endpoint_negative_pair_settles_positive(self):
        row = {"bmUnit": "T_THURB-1", "bidOfferPairCashflows": self._pairs(self.OFFER_SP40)}
        total = sum_cohort_pairs([row], {"T_THURB-1"}, "bidOfferPairCashflows")
        self.assertAlmostEqual(total, self.OFFER_SP40)
        self.assertGreater(total, 0)

    def test_net_is_sum_of_both_endpoints(self):
        bid_row = {"bmUnit": "T_THURB-1", "bidOfferPairCashflows": self._pairs(self.BID_SP40)}
        offer_row = {"bmUnit": "T_THURB-1", "bidOfferPairCashflows": self._pairs(self.OFFER_SP40)}
        bid_total = sum_cohort_pairs([bid_row], {"T_THURB-1"}, "bidOfferPairCashflows")
        offer_total = sum_cohort_pairs([offer_row], {"T_THURB-1"}, "bidOfferPairCashflows")
        net = bid_total + offer_total
        self.assertAlmostEqual(net, self.BID_SP40 + self.OFFER_SP40)
        self.assertAlmostEqual(net, -684.26, places=6)

    def test_only_cohort_bmunits_counted(self):
        rows = [
            {"bmUnit": "T_THURB-1", "bidOfferPairCashflows": self._pairs(-100.0)},
            {"bmUnit": "T_OTHER-1", "bidOfferPairCashflows": self._pairs(-999.0)},
        ]
        total = sum_cohort_pairs(rows, {"T_THURB-1"}, "bidOfferPairCashflows")
        self.assertAlmostEqual(total, -100.0)

    def test_null_pairs_do_not_contribute(self):
        pairs = {key: None for key in PAIR_KEYS}
        pairs["positive1"] = 42.0
        self.assertAlmostEqual(sum_pair_cashflows(pairs), 42.0)
        self.assertAlmostEqual(sum_pair_cashflows(None), 0.0)
        self.assertAlmostEqual(sum_pair_cashflows({}), 0.0)


# ---------------------------------------------------------------------------
# 7. Reconciliation identity
# ---------------------------------------------------------------------------

class ReconciliationIdentityTest(unittest.TestCase):
    """DISPTAV volume x BOD price x TLM == EBOCF, exact to machine
    precision on the T_THURB-1 2026-07-20 SP20 hand reconciliation
    (plan/08). TLM = 0.9882790 (implied, recovered independently on all
    three pairs in the design doc)."""

    TLM = 0.9882790
    PAIRS = (
        # (volume MWh, BOD bid price £/MWh, published EBOCF £)
        (-9.00, 99.45, -884.55911895),
        (-9.00, 97.95, -871.21735245),
        (-2.00, 97.95, -193.60385610),
    )
    TOTAL_EBOCF = -1949.3803275

    def test_each_pair_reconciles(self):
        for volume, price, expected in self.PAIRS:
            self.assertAlmostEqual(
                reconcile_ebocf(volume, price, self.TLM), expected, places=3)

    def test_total_reconciles(self):
        total = sum(reconcile_ebocf(v, p, self.TLM) for v, p, _ in self.PAIRS)
        self.assertAlmostEqual(total, self.TOTAL_EBOCF, places=3)


# ---------------------------------------------------------------------------
# 8. Merge and retention
# ---------------------------------------------------------------------------

class MergeAndRetentionTest(unittest.TestCase):
    def test_new_days_added_existing_kept(self):
        existing = {"2025-01-01": {"bid_gbp_per_kw_day": -0.1}}
        new = {"2025-01-02": {"bid_gbp_per_kw_day": -0.05}}
        merged = merge_bm_days(existing, new)
        self.assertEqual(set(merged), {"2025-01-01", "2025-01-02"})

    def test_new_day_overwrites_existing_value(self):
        existing = {"2025-01-01": {"bid_gbp_per_kw_day": -0.1}}
        new = {"2025-01-01": {"bid_gbp_per_kw_day": -0.2}}
        merged = merge_bm_days(existing, new)
        self.assertEqual(merged["2025-01-01"]["bid_gbp_per_kw_day"], -0.2)

    def test_trim_holds_at_retain_days(self):
        days = [str(date(2025, 1, 1) + timedelta(days=i)) for i in range(31)]
        trimmed = trim_to_retain(days, 10)
        self.assertEqual(len(trimmed), 10)
        self.assertEqual(trimmed[0], days[-10])
        self.assertEqual(trimmed[-1], days[-1])

    def test_trim_is_a_noop_when_under_the_limit(self):
        days = ["2025-01-01", "2025-01-02"]
        self.assertEqual(trim_to_retain(days, 400), days)

    def test_state_last_day_advances(self):
        by_day = {"2025-01-01": {"bid_gbp_per_kw_day": -0.1}, "2025-01-02": None}
        self.assertEqual(latest_day_with_data(by_day), "2025-01-01")
        by_day["2025-01-02"] = {"bid_gbp_per_kw_day": -0.2}
        self.assertEqual(latest_day_with_data(by_day), "2025-01-02")

    def test_latest_day_with_data_handles_all_absent(self):
        self.assertIsNone(latest_day_with_data({"2025-01-01": None}))
        self.assertIsNone(latest_day_with_data({}))


class BmFetchRangeTest(unittest.TestCase):
    def test_backfill_skips_days_already_present(self):
        shipped = ["2025-01-01", "2025-01-02", "2025-01-03"]
        existing = {"2025-01-01": {}}
        wanted = bm_fetch_range(existing, shipped, backfill_days=3,
                                force_backfill=False, today=date(2025, 1, 4))
        self.assertEqual(wanted, ["2025-01-02", "2025-01-03"])

    def test_force_backfill_refetches_everything(self):
        shipped = ["2025-01-01", "2025-01-02", "2025-01-03"]
        existing = {"2025-01-01": {}}
        wanted = bm_fetch_range(existing, shipped, backfill_days=3,
                                force_backfill=True, today=date(2025, 1, 4))
        self.assertEqual(wanted, shipped)

    def test_backfill_respects_requested_depth(self):
        shipped = [str(date(2025, 1, 1) + timedelta(days=i)) for i in range(10)]
        wanted = bm_fetch_range({}, shipped, backfill_days=3,
                                force_backfill=False, today=date(2025, 1, 11))
        self.assertEqual(wanted, shipped[-3:])

    def test_incremental_tail_is_d2_through_d1(self):
        shipped = [str(date(2025, 1, 1) + timedelta(days=i)) for i in range(10)]
        today = date(2025, 1, 11)
        existing = {d: {} for d in shipped[:8]}  # known through 01-08
        wanted = bm_fetch_range(existing, shipped, backfill_days=None,
                                force_backfill=False, today=today)
        self.assertEqual(wanted, ["2025-01-09", "2025-01-10"])

    def test_incremental_catches_up_a_gap(self):
        shipped = [str(date(2025, 1, 1) + timedelta(days=i)) for i in range(10)]
        today = date(2025, 1, 11)
        existing = {d: {} for d in shipped[:5]}  # stale — known only through 01-05
        wanted = bm_fetch_range(existing, shipped, backfill_days=None,
                                force_backfill=False, today=today)
        self.assertEqual(wanted, ["2025-01-06", "2025-01-07", "2025-01-08",
                                 "2025-01-09", "2025-01-10"])


# ---------------------------------------------------------------------------
# 9. Payload budget
# ---------------------------------------------------------------------------

class PayloadBudgetTest(unittest.TestCase):
    def test_400_day_payload_serialises_under_150kb(self):
        import json

        days = [str(date(2025, 1, 1) + timedelta(days=i)) for i in range(400)]
        denom = [4000000 + i * 1000 for i in range(400)]
        eac_series = {p: [round(0.001 * ((i % 7) - 3), 5) for i in range(400)]
                     for p in PRODUCT_KEYS}
        spread = {"p10": [0.0001] * 400, "p50": [0.0002] * 400,
                 "p90": [0.0004] * 400}
        bm = {"bid_gbp_per_kw_day": [-0.01] * 400,
             "offer_gbp_per_kw_day": [0.02] * 400,
             "bid_mwh": [-100.0] * 400, "offer_mwh": [50.0] * 400}
        products = {k: dict(v) for k, v in PRODUCTS.items()}
        cohort_block = {
            "units": 89, "mw": 4224.0, "method": COHORT_METHOD,
            "repd_operational_mw": REPD_OPERATIONAL_MW,
            "repd_vintage": REPD_VINTAGE, "coverage_repd": 0.888,
            "coverage_eac_gross": 0.471, "signature_agreement": 0.989,
        }
        state = {"eac_last_day": days[-1], "bm_last_day": days[-2]}

        payload = assemble_payload(
            "2026-07-29T00:00:00+00:00", cohort_block, days, denom,
            eac_series, spread, bm, products, state, "test source")

        blob = json.dumps(payload)
        self.assertLess(len(blob.encode()), 150 * 1024,
                        f"payload is {len(blob.encode()) / 1024:.1f} kB")
        self.assertEqual(len(payload["days"]), 400)
        self.assertEqual(set(payload["eac_gbp_per_kw_day"]), set(PRODUCT_KEYS))


# ---------------------------------------------------------------------------
# 10. Methodology-tab provenance (meta.series)
# ---------------------------------------------------------------------------

class SourceMetaTest(unittest.TestCase):
    """SOURCE_META feeds app/js/ui.js's central "Sources, field mapping,
    transformations" table on the Methodology tab: it must carry exactly
    the meta.json series vocabulary (name/source/endpoint/unit/
    resolution/update_frequency/quality/transformations/notes), for both
    the "eac" (NESO availability-auction revenue) and "bm" (Elexon
    Balancing Mechanism cashflow, D18) legs, and assemble_payload must
    expose it at payload["meta"]["series"] so ui.js can append the two
    rows after the core dataset's own rows."""

    VOCAB = {"name", "source", "endpoint", "unit", "resolution",
             "update_frequency", "quality", "transformations", "notes"}

    def test_has_exactly_eac_and_bm_keys(self):
        self.assertEqual(set(SOURCE_META), {"eac", "bm"})

    def test_each_entry_has_the_full_vocabulary(self):
        for key, entry in SOURCE_META.items():
            self.assertEqual(set(entry), self.VOCAB, key)
            for field, value in entry.items():
                self.assertIsInstance(value, str, f"{key}.{field}")
                self.assertTrue(value.strip(), f"{key}.{field} is empty")

    def test_no_em_dashes_in_any_field(self):
        # Owner mandate (plan/08 provenance-merge task): British English,
        # no em-dashes anywhere in these strings — use colons, commas or
        # "because" instead.
        for key, entry in SOURCE_META.items():
            for field, value in entry.items():
                self.assertNotIn("—", value, f"{key}.{field}")

    def test_assemble_payload_carries_meta_series(self):
        payload = assemble_payload(
            "2026-07-29T00:00:00+00:00", {"units": 1}, [], [], {}, {},
            {}, {}, {}, "test source")
        self.assertEqual(payload["meta"]["series"], SOURCE_META)


# ---------------------------------------------------------------------------
# Aggregation (supporting coverage — not a numbered plan/08 item, but the
# glue between the fetched rows and the per-day series above)
# ---------------------------------------------------------------------------

class AggregationTest(unittest.TestCase):
    def test_fleet_level_and_per_unit_totals(self):
        cohort = {"A": {"elexon_id": "T_A", "cap_mw": 100.0},
                 "B": {"elexon_id": "T_B", "cap_mw": 50.0}}
        window_hours = {"DCL": 4.0, "PBR": 0.5}
        rows = [
            {"day": "2025-06-01", "unit": "A", "product": "DCL", "gbp_ex_window": 10.0},
            {"day": "2025-06-01", "unit": "B", "product": "DCL", "gbp_ex_window": 5.0},
            {"day": "2025-06-01", "unit": "A", "product": "PBR", "gbp_ex_window": 2.0},
            {"day": "2025-06-01", "unit": "NONCOHORT", "product": "DCL", "gbp_ex_window": 100.0},
        ]
        days = ["2025-06-01"]
        day_product_gbp, day_unit_gbp, cohort_gross, all_gross = aggregate_eac(
            rows, cohort, window_hours, days)

        self.assertAlmostEqual(day_product_gbp["2025-06-01"]["DCL"], 60.0)  # (10+5)*4
        self.assertAlmostEqual(day_product_gbp["2025-06-01"]["PBR"], 1.0)   # 2*0.5
        self.assertAlmostEqual(day_unit_gbp["2025-06-01"]["A"], 41.0)       # 10*4 + 2*0.5
        self.assertAlmostEqual(day_unit_gbp["2025-06-01"]["B"], 20.0)       # 5*4
        self.assertAlmostEqual(cohort_gross, 61.0)
        self.assertAlmostEqual(all_gross, 461.0)  # + non-cohort 100*4

    def test_zero_filled_products_not_seen_that_day(self):
        cohort = {"A": {"elexon_id": "T_A", "cap_mw": 100.0}}
        window_hours = {p: 1.0 for p in PRODUCT_KEYS}
        rows = [{"day": "2025-06-01", "unit": "A", "product": "DCL", "gbp_ex_window": 10.0}]
        day_product_gbp, _, _, _ = aggregate_eac(rows, cohort, window_hours, ["2025-06-01"])
        for product in PRODUCT_KEYS:
            if product != "DCL":
                self.assertEqual(day_product_gbp["2025-06-01"][product], 0.0)

    def test_eac_gbp_per_kw_day_uses_time_varying_denominator(self):
        days = ["2025-06-01", "2025-06-02"]
        day_product_gbp = {
            "2025-06-01": {p: 0.0 for p in PRODUCT_KEYS},
            "2025-06-02": {p: 0.0 for p in PRODUCT_KEYS},
        }
        day_product_gbp["2025-06-01"]["DCL"] = 100.0
        day_product_gbp["2025-06-02"]["DCL"] = 100.0
        denom = [100000, 200000]  # fleet doubled between the two days
        series = eac_gbp_per_kw_day_series(days, day_product_gbp, denom)
        self.assertAlmostEqual(series["DCL"][0], 0.001)
        self.assertAlmostEqual(series["DCL"][1], 0.0005)

    def test_unit_spread_normalises_per_unit_capacity(self):
        cohort = {"A": {"elexon_id": "T_A", "cap_mw": 100.0},
                 "B": {"elexon_id": "T_B", "cap_mw": 50.0}}
        day_unit_gbp = {"2025-06-01": {"A": 100.0, "B": 100.0}}
        spread = unit_spread_series(["2025-06-01"], day_unit_gbp, cohort)
        # A: 100 / 100000 = 0.001; B: 100 / 50000 = 0.002
        self.assertAlmostEqual(spread["p50"][0], 0.0015)
        self.assertAlmostEqual(spread["p10"][0], 0.0011)


class PercentileTest(unittest.TestCase):
    def test_empty_is_none(self):
        self.assertIsNone(percentile([], 0.5))

    def test_median_of_three(self):
        self.assertAlmostEqual(percentile([1.0, 2.0, 3.0], 0.5), 2.0)


if __name__ == "__main__":
    unittest.main()

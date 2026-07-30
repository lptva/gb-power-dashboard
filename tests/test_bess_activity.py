"""Pure-logic checks for etl/build_bess_activity.py — the BESS observable
activity tracker (plan/06 workstream C, issue #24).

House rule per tests/test_stress_flags.py: pure logic only, no network and
no file access, build_dataset never imported, so the suite runs on the
stdlib-only CI worker. Fixtures are hand-written registry rows / acceptance
rows / day dicts — no fixture directory needed.

Numbered comments (# 1, # 2, ...) tag each test against the item it covers
in scratchpad/phaseA/phaseA_spec.md §7, updated where the 400-day window
addendum (scratchpad/phaseA/addendum_400d.md §G) changes the item.
"""

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "etl"))

from build_bess_activity import (  # noqa: E402
    PAYLOAD_GUARD_BYTES,
    RangeViolation,
    active_index_union,
    aggregate_day,
    apply_payload_guard,
    carry_forward_activity_dates,
    check_returned_range,
    denominator_mw_series,
    denominator_units_series,
    downgrade_hh,
    identify,
    merge_first_active,
    migrate_days,
    remap_active_idx,
    seed_first_active_from_active_idx,
    sp_count_for_day,
    trim_retention,
    trim_unit_detail,
)


def battery_row(**overrides):
    """A canonical, name-neutral physical battery BMU: qualifies via the
    structural leg only unless a fixture overrides fields to add or break
    that. bmUnitName/elexonBmUnit/nationalGridBmUnit are deliberately free
    of every NAME_PAT trigger word (batter/bess/energy stor/storage/ess/
    bat\\d) so structural-only fixtures don't accidentally also match on
    name."""
    row = {
        "elexonBmUnit": "E_TESTU-1",
        "nationalGridBmUnit": "TESTU-1",
        "bmUnitName": "Test Generation Unit",
        "leadPartyName": "Test Energy Ltd",
        "generationCapacity": "52.000",
        "demandCapacity": "-52.000",
        "fuelType": None,
        "interconnectorId": None,
    }
    row.update(overrides)
    return row


class Identification(unittest.TestCase):

    def test_1_canonical_battery_structural(self):
        # 1: gen 52.0, dem -52.0, fuelType None, E_ -> in, leg structural.
        self.assertEqual(identify(battery_row()), "structural")

    def test_2_ratio_boundaries(self):
        # 2: 0.5 and 1.5 exactly -> in; 0.49 and 1.51 -> out.
        self.assertEqual(
            identify(battery_row(demandCapacity="-26.000")), "structural")
        self.assertEqual(
            identify(battery_row(demandCapacity="-78.000")), "structural")
        self.assertIsNone(identify(battery_row(demandCapacity="-25.48")))
        self.assertIsNone(identify(battery_row(demandCapacity="-78.52")))

    def test_3_fuel_gate_excludes_ccgt(self):
        # 3: fuelType "CCGT" with symmetric capacities -> out.
        self.assertIsNone(identify(battery_row(fuelType="CCGT")))

    def test_4_interconnector_excluded(self):
        # 4: interconnectorId set, and separately I_ prefix -> out.
        self.assertIsNone(identify(battery_row(interconnectorId="IFA")))
        self.assertIsNone(identify(battery_row(elexonBmUnit="I_TESTU-1")))

    def test_5_zero_generation_capacity_no_zero_division(self):
        # 5: gen == 0 -> out, and must not raise ZeroDivisionError (real
        # registry rows carry gen "0.000").
        row = battery_row(generationCapacity="0.000", demandCapacity="0.000")
        self.assertIsNone(identify(row))

    def test_6_capacity_string_parsing(self):
        # 6: capacity as a string ("52.000") parses; None and "" -> out.
        self.assertEqual(
            identify(battery_row(generationCapacity="52.000")), "structural")
        self.assertIsNone(identify(battery_row(generationCapacity=None)))
        self.assertIsNone(identify(battery_row(generationCapacity="")))

    def test_7_vlp_and_supplier_boundary_excluded(self):
        # 7: 2__.../S-type and V__... rows -> out (deviation A regression).
        self.assertIsNone(identify(battery_row(
            elexonBmUnit="V__FEEL001", nationalGridBmUnit="FEEL001",
            bmUnitName="EDF Battery Portfolio")))
        self.assertIsNone(identify(battery_row(
            elexonBmUnit="2__AGGR001", nationalGridBmUnit="AGGR001")))

    def test_8_demand_bmu_excluded_legit_b_suffix_not_over_matched(self):
        # 8: T_WISHD-1 / "Wishaw Demand BMU" -> out (demand-BMU rule); a
        # battery legitimately named "...B-1" -> in (must not over-match).
        demand_row = battery_row(
            elexonBmUnit="T_WISHD-1", nationalGridBmUnit="WISHD-1",
            bmUnitName="Wishaw Demand BMU")
        self.assertIsNone(identify(demand_row))
        legit_row = battery_row(
            elexonBmUnit="T_WISHB-1", nationalGridBmUnit="WISHB-1",
            bmUnitName="Wishaw Battery")
        self.assertEqual(identify(legit_row), "structural+name")

    def test_9_capacity_floor(self):
        # 9: 4.9 -> out, 5.0 -> in.
        self.assertIsNone(identify(
            battery_row(generationCapacity="4.9", demandCapacity="-4.9")))
        self.assertEqual(identify(
            battery_row(generationCapacity="5.0", demandCapacity="-5.0")),
            "structural")

    def test_10_name_only_recovery_asymmetric_registration(self):
        # 10: gen 49.0, dem -0.39, name "Overhill BESS" -> in, leg name.
        row = battery_row(
            generationCapacity="49.0", demandCapacity="-0.39",
            elexonBmUnit="E_OVRHB-1", nationalGridBmUnit="OVRHB-1",
            bmUnitName="Overhill BESS")
        self.assertEqual(identify(row), "name")

    def test_11_name_pattern_ignores_lead_party_name(self):
        # 11: name pattern does not fire on leadPartyName alone: a CCGT row
        # owned by "... Energy Storage Ltd" -> out.
        row = battery_row(
            fuelType="CCGT", leadPartyName="Acme Energy Storage Ltd",
            bmUnitName="Acme Power Station")
        self.assertIsNone(identify(row))


def acc_row(side, unit, sp, vol, acc_id):
    return {"side": side, "bmUnit": unit, "settlementPeriod": sp,
            "totalVolumeAccepted": vol, "acceptanceId": acc_id}


class Aggregation(unittest.TestCase):

    def test_12_offer_positive_bid_negative_right_sp_index(self):
        # 12: offer rows sum positive, bid rows sum negative, right SP index.
        rows = [
            acc_row("offer", "A", 1, 5.0, 100),
            acc_row("bid", "B", 2, -3.0, 101),
        ]
        agg = aggregate_day(rows, 48)
        self.assertEqual(agg["offer_mwh"][0], 5.0)
        self.assertEqual(agg["bid_mwh"][1], -3.0)
        self.assertEqual(agg["offer_mwh"][1], 0.0)
        self.assertEqual(agg["bid_mwh"][0], 0.0)

    def test_13_acceptance_id_shared_across_sides_counts_once(self):
        # 13: an acceptanceId present in BOTH the bid and offer responses
        # counts once (regression for the double-count trap, §2).
        rows = [
            acc_row("offer", "A", 1, 5.0, 100),
            acc_row("bid", "A", 1, 0.0, 100),   # same acceptanceId, unused side
        ]
        agg = aggregate_day(rows, 48)
        self.assertEqual(agg["acceptances"], 1)
        self.assertEqual(agg["unit_acceptance_counts"], {"A": 1})

    def test_14_zero_volume_does_not_count_or_raise(self):
        # 14: zero-volume acceptances do not count towards acceptances /
        # active_units, but do not raise.
        rows = [acc_row("offer", "A", 1, 0.0, 200)]
        agg = aggregate_day(rows, 48)
        self.assertEqual(agg["acceptances"], 0)
        self.assertNotIn("A", agg["active_units"])
        self.assertEqual(agg["unit_acceptance_counts"], {})

    def test_15_divisor_semantics(self):
        # 15 (addendum §G, rewritten against denominator_mw_series()):
        # 3-day fixture, A trades day1 only, B trades day3 only, C never.
        fleet_list = [{"id": "A", "cap_mw": 100.0},
                      {"id": "B", "cap_mw": 50.0},
                      {"id": "C", "cap_mw": 30.0}]
        first_active = {"A": "2026-01-01", "B": "2026-01-03", "C": None}
        days = ["2026-01-01", "2026-01-02", "2026-01-03"]
        denom = denominator_mw_series(fleet_list, first_active, days)
        # cap(A), cap(A), cap(A) + cap(B) -- a quiet day (day 2) does not
        # shrink the divisor, and dormant C never enters it.
        self.assertEqual(denom, [100.0, 100.0, 150.0])
        self.assertEqual(denom[1], denom[0])
        self.assertLess(denom[-1], sum(u["cap_mw"] for u in fleet_list))

        # per-day active_mw (informational only, NOT the divisor) is
        # 100/0/50. On day 2 and day 3 this visibly differs from the
        # denominator (0 != 100, 50 != 150) -- the whole point of the
        # cumulative rule. Day 1 is a structural special case: the first
        # day any unit is EVER observed active is necessarily also the
        # first day it enters the denominator, so active_mw and the
        # denominator coincide there for any fixture with no pre-window
        # (burn-in) activity -- that is not evidence of endogeneity, since
        # the coincidence cannot repeat once a unit has gone quiet even
        # once (see test_27_non_endogeneity for the discriminating case).
        active_mw = {"2026-01-01": 100.0, "2026-01-02": 0.0, "2026-01-03": 50.0}
        self.assertNotEqual(active_mw["2026-01-02"], denom[1])
        self.assertNotEqual(active_mw["2026-01-03"], denom[2])

    def test_16_variable_length_days(self):
        # 16: a 46-SP and a 50-SP day produce arrays of length 46 and 50.
        self.assertEqual(len(aggregate_day([], 46)["offer_mwh"]), 46)
        self.assertEqual(len(aggregate_day([], 50)["offer_mwh"]), 50)
        self.assertEqual(len(aggregate_day([], 46)["bid_mwh"]), 46)
        self.assertEqual(len(aggregate_day([], 50)["bid_mwh"]), 50)
        # sanity: real UK clock-change dates in 2026 resolve to 46/50/48.
        self.assertEqual(sp_count_for_day(date(2026, 3, 29)), 46)
        self.assertEqual(sp_count_for_day(date(2026, 10, 25)), 50)
        self.assertEqual(sp_count_for_day(date(2026, 7, 15)), 48)

    def test_17_range_assertion_discards_out_of_range_rows(self):
        # 17: rows for a date outside the request (or a unit outside the
        # requested batch) raise, rather than being silently stored.
        check_returned_range(
            [{"settlementDate": "2026-07-01", "bmUnit": "A"}],
            date(2026, 7, 1), ["A", "B"])   # no raise on a valid response
        with self.assertRaises(RangeViolation):
            check_returned_range(
                [{"settlementDate": "2026-07-02", "bmUnit": "A"}],
                date(2026, 7, 1), ["A"])
        with self.assertRaises(RangeViolation):
            check_returned_range(
                [{"settlementDate": "2026-07-01", "bmUnit": "Z"}],
                date(2026, 7, 1), ["A"])


class Retention(unittest.TestCase):

    def test_18_retention_trim_keeps_newest(self):
        # 18: > RETAIN_DAYS days -> oldest trimmed, newest kept.
        days = {f"2026-01-{i:02d}": {"n": i} for i in range(1, 11)}
        trimmed = trim_retention(days, retain_days=5)
        self.assertEqual(sorted(trimmed),
                         [f"2026-01-{i:02d}" for i in range(6, 11)])

    def test_19_unit_detail_trim_keeps_daily_totals_and_denominator(self):
        # 19 (extended, addendum §G): days older than UNIT_DETAIL_DAYS
        # lose unit_acceptances but keep offer_mwh/bid_mwh/acceptances AND
        # the always-present daily totals + denominator fields.
        days = {f"2026-01-{i:02d}": {
            "offer_mwh": [1.0], "bid_mwh": [-1.0],
            "offer_mwh_total": 1.0, "bid_mwh_total": -1.0,
            "acceptances": 1, "denominator_mw": 100.0,
            "unit_acceptances": {"A": 1}} for i in range(1, 11)}
        trimmed = trim_unit_detail(days, unit_detail_days=3)
        old_keys = sorted(trimmed)[:-3]
        tail_keys = sorted(trimmed)[-3:]
        for key in old_keys:
            self.assertNotIn("unit_acceptances", trimmed[key])
            self.assertIn("offer_mwh", trimmed[key])
            self.assertIn("bid_mwh", trimmed[key])
            self.assertIn("acceptances", trimmed[key])
            self.assertIn("offer_mwh_total", trimmed[key])
            self.assertIn("bid_mwh_total", trimmed[key])
            self.assertIn("denominator_mw", trimmed[key])
        for key in tail_keys:
            self.assertIn("unit_acceptances", trimmed[key])

    def test_20_denominator_not_ratcheted_by_retention_trim(self):
        # 20 (INVERTED, addendum §B2 -- the single most important test
        # change in the file). Old behaviour: window_active recomputed
        # after the trim, so a unit whose only activity fell in a trimmed
        # day dropped out. New behaviour: first_active is carried forward
        # ACROSS trims and never recomputed from the surviving days, so
        # the unit contributes on every retained day. Recomputing it from
        # retained days only would ratchet the whole series upward as
        # history rolls off -- exactly the defect this test now guards
        # against, the mirror image of the old assertion.
        fleet_list = [{"id": "D", "cap_mw": 10.0}, {"id": "E", "cap_mw": 20.0}]
        first_active = {"D": "2026-01-01", "E": "2026-01-02"}
        days = {
            "2026-01-01": {"active_idx": [0]},   # D's only observed activity
            "2026-01-02": {"active_idx": [1]},
            "2026-01-03": {"active_idx": [1]},
        }
        trimmed = trim_retention(days, retain_days=2)
        self.assertNotIn("2026-01-01", trimmed)
        # first_active is untouched by the trim -- D still counts on every
        # retained day, unlike the pre-addendum window_active.
        denom = denominator_mw_series(fleet_list, first_active,
                                      sorted(trimmed))
        self.assertEqual(denom, [30.0, 30.0])   # D (10) + E (20), every day

    def test_21_active_idx_round_trip_unchanged_fleet(self):
        # 21: a day loaded from the previous build and not re-fetched this
        # run still round-trips its units through remap_active_idx and
        # active_index_union unchanged. active_idx is no longer the
        # divisor's state (addendum §D), but it must still resolve
        # correctly against the current fleet for every HH-tier day (the
        # §B1(3) self-check).
        fleet_list = [{"id": "A", "cap_mw": 100.0}, {"id": "B", "cap_mw": 50.0}]
        remapped = remap_active_idx(fleet_list, fleet_list, [1])
        self.assertEqual(remapped, [1])
        days = {"2026-01-01": {"active_idx": remapped}}
        self.assertEqual(active_index_union(days), {1})

    def test_22_index_remap_on_registry_reshuffle(self):
        # 22 (§4d). Previous fleet.list == [X(100 MW), Y(50 MW)], retained
        # day active_idx == [1] (Y). A new 200 MW unit Z enters, so the
        # rebuilt list sorts to [Z, X, Y]. The retained day's active_idx
        # becomes [2] and resolves to Y, not X -- the exact
        # silent-corruption failure mode without the remap.
        old_list = [{"id": "X", "cap_mw": 100.0}, {"id": "Y", "cap_mw": 50.0}]
        new_list = [{"id": "Z", "cap_mw": 200.0}, {"id": "X", "cap_mw": 100.0},
                    {"id": "Y", "cap_mw": 50.0}]
        remapped = remap_active_idx(old_list, new_list, [1])
        self.assertEqual(remapped, [2])
        ids_by_index = [u["id"] for u in new_list]
        self.assertEqual(ids_by_index[remapped[0]], "Y")

    def test_23_dropped_unit_removed_without_raising(self):
        # 23 (extended, addendum §G): a unit present in a retained day's
        # active_idx but no longer identified (dropped from the registry,
        # or the rule stopped matching it) is removed from active_idx
        # resolution and does not raise. It also leaves first_active, and
        # therefore every day's denominator (§A4: registry exit is the
        # ONLY way out of the divisor).
        old_list = [{"id": "X", "cap_mw": 100.0}, {"id": "D", "cap_mw": 10.0}]
        new_list = [{"id": "X", "cap_mw": 100.0}]   # D de-registered
        remapped = remap_active_idx(old_list, new_list, [0, 1])
        self.assertEqual(remapped, [0])   # D's index silently dropped

        first_active, _ = carry_forward_activity_dates(
            [{"id": "X", "cap_mw": 100.0, "first_active": "2026-01-01"},
             {"id": "D", "cap_mw": 10.0, "first_active": "2026-01-01"}],
            new_list)
        self.assertEqual(first_active, {"X": "2026-01-01"})   # D absent

        denom = denominator_mw_series(new_list, first_active, ["2026-01-01"])
        self.assertEqual(denom, [100.0])   # D's capacity no longer counted


class TierAndMigration(unittest.TestCase):
    """Addendum §G items 24, 25, 28: the schema-1 -> schema-2 migration and
    the HH-tier downgrade, and the ordering dependency between them."""

    def test_24_tier_downgrade(self):
        # 24: downgrade_hh(days, hh_days=2) over 5 days: the newest 2 keep
        # offer_mwh/bid_mwh/active_idx; the older 3 lose all three and
        # keep offer_mwh_total/bid_mwh_total/acceptances/active_units/
        # active_mw. The totals stay numerically equal to the sums of the
        # arrays that were deleted.
        days = {}
        for i in range(1, 6):
            key = f"2026-01-{i:02d}"
            days[key] = {
                "offer_mwh": [float(i)], "bid_mwh": [-float(i)],
                "offer_mwh_total": float(i), "bid_mwh_total": -float(i),
                "acceptances": i, "active_units": 1, "active_mw": 10.0,
                "active_idx": [0],
            }
        downgrade_hh(days, hh_days=2)
        old_keys = sorted(days)[:-2]
        new_keys = sorted(days)[-2:]
        for key in old_keys:
            self.assertNotIn("offer_mwh", days[key])
            self.assertNotIn("bid_mwh", days[key])
            self.assertNotIn("active_idx", days[key])
            self.assertIn("offer_mwh_total", days[key])
            self.assertIn("bid_mwh_total", days[key])
            self.assertIn("acceptances", days[key])
            self.assertIn("active_units", days[key])
            self.assertIn("active_mw", days[key])
        for key in new_keys:
            self.assertIn("offer_mwh", days[key])
            self.assertIn("bid_mwh", days[key])
            self.assertIn("active_idx", days[key])
        for i, key in enumerate(sorted(days), start=1):
            self.assertAlmostEqual(days[key]["offer_mwh_total"], float(i))
            self.assertAlmostEqual(days[key]["bid_mwh_total"], -float(i))

    def test_25_downgrade_safe_after_migration_only(self):
        # 25: a schema-1 day (HH arrays, no totals) passed through
        # migrate_days() then downgrade_hh() retains correct totals;
        # passed through downgrade_hh() alone it loses the day's totals
        # outright -- pins the §B2 ordering (migrate before downgrade).
        schema1_day = {"offer_mwh": [1.0, 2.0], "bid_mwh": [-1.0, -2.0]}

        migrated = migrate_days({"2026-01-01": dict(schema1_day)})
        downgrade_hh(migrated, hh_days=0)
        self.assertAlmostEqual(migrated["2026-01-01"]["offer_mwh_total"], 3.0)
        self.assertAlmostEqual(migrated["2026-01-01"]["bid_mwh_total"], -3.0)

        unmigrated = {"2026-01-01": dict(schema1_day)}
        downgrade_hh(unmigrated, hh_days=0)
        self.assertNotIn("offer_mwh_total", unmigrated["2026-01-01"])
        self.assertNotIn("bid_mwh_total", unmigrated["2026-01-01"])

    def test_28_migration_of_schema1_fixture(self):
        # 28: a payload with no meta.schema, no first_active, days
        # carrying HH arrays and active_idx: migrate_days() adds totals
        # equal to the array sums; seed_first_active_from_active_idx()
        # gives each unit its earliest appearing day; a unit in no day's
        # active_idx gets None and is absent from every denominator.
        fleet_list = [{"id": "A", "cap_mw": 10.0}, {"id": "B", "cap_mw": 20.0},
                      {"id": "NEVER", "cap_mw": 5.0}]
        days = {
            "2026-01-01": {"offer_mwh": [1.0], "bid_mwh": [-1.0],
                          "active_idx": [0]},
            "2026-01-02": {"offer_mwh": [2.0], "bid_mwh": [-2.0],
                          "active_idx": [0, 1]},
        }
        migrated = migrate_days({k: dict(v) for k, v in days.items()})
        self.assertAlmostEqual(migrated["2026-01-01"]["offer_mwh_total"], 1.0)
        self.assertAlmostEqual(migrated["2026-01-02"]["bid_mwh_total"], -2.0)

        first_active = seed_first_active_from_active_idx(fleet_list, migrated)
        self.assertEqual(first_active["A"], "2026-01-01")
        self.assertEqual(first_active["B"], "2026-01-02")
        self.assertIsNone(first_active["NEVER"])

        denom = denominator_mw_series(fleet_list, first_active,
                                      sorted(migrated))
        self.assertEqual(denom, [10.0, 30.0])   # NEVER's 5 MW never counted


class DenominatorProperties(unittest.TestCase):
    """Addendum §G items 26, 27, 29, 30: the properties the cumulative-
    entry rule is adopted for (monotonicity, non-endogeneity), the merge
    rule that makes the backfill order-independent, and retirement."""

    def test_26_monotonicity(self):
        # 26: denominator_mw_series over a 5-day fixture with entrants on
        # days 1, 3 and 5 is non-decreasing and strictly increases only on
        # those days.
        fleet_list = [{"id": "A", "cap_mw": 10.0}, {"id": "B", "cap_mw": 20.0},
                      {"id": "C", "cap_mw": 30.0}]
        first_active = {"A": "2026-01-01", "B": "2026-01-03", "C": "2026-01-05"}
        days = [f"2026-01-{i:02d}" for i in range(1, 6)]
        denom = denominator_mw_series(fleet_list, first_active, days)
        self.assertEqual(denom, [10.0, 10.0, 30.0, 30.0, 60.0])
        for i in range(1, len(denom)):
            self.assertGreaterEqual(denom[i], denom[i - 1])
        increases_on = {days[i] for i in range(1, len(denom))
                        if denom[i] > denom[i - 1]}
        self.assertEqual(increases_on, {"2026-01-03", "2026-01-05"})

    def test_27_non_endogeneity(self):
        # 27: two units, one trading every day and one trading on day 1
        # then never again. The denominator is flat from day 1 onward
        # while per-day active_mw halves on day 2 -- the property §A2
        # buys, and the discriminating case that test_15's day-1
        # coincidence cannot repeat.
        fleet_list = [{"id": "ALWAYS", "cap_mw": 40.0},
                      {"id": "ONCE", "cap_mw": 60.0}]
        first_active = {"ALWAYS": "2026-01-01", "ONCE": "2026-01-01"}
        days = ["2026-01-01", "2026-01-02", "2026-01-03"]
        denom = denominator_mw_series(fleet_list, first_active, days)
        self.assertEqual(denom, [100.0, 100.0, 100.0])
        active_mw = {"2026-01-01": 100.0, "2026-01-02": 40.0,
                    "2026-01-03": 40.0}   # ONCE goes quiet after day 1
        self.assertNotEqual(active_mw["2026-01-02"], denom[1])
        self.assertNotEqual(active_mw["2026-01-03"], denom[2])

    def test_29_merge_first_active_takes_earliest(self):
        # 29: carried 2026-06-29, observed 2025-08-14 gives 2025-08-14;
        # carried 2025-08-14, observed 2026-01-01 stays 2025-08-14 -- what
        # makes the backfill correct the migration seed regardless of the
        # order days are fetched in.
        self.assertEqual(
            merge_first_active({"A": "2026-06-29"}, {"A": "2025-08-14"}),
            {"A": "2025-08-14"})
        self.assertEqual(
            merge_first_active({"A": "2025-08-14"}, {"A": "2026-01-01"}),
            {"A": "2025-08-14"})
        self.assertEqual(
            merge_first_active({"A": None}, {"A": "2025-08-14"}),
            {"A": "2025-08-14"})

    def test_30_retirement(self):
        # 30: a unit with a first_active but absent from the rebuilt
        # fleet_list contributes to no day's denominator and does not
        # raise.
        fleet_list = [{"id": "X", "cap_mw": 100.0}]   # "GONE" de-registered
        first_active = {"X": "2026-01-01", "GONE": "2025-01-01"}
        denom = denominator_mw_series(fleet_list, first_active,
                                      ["2026-01-01", "2026-01-02"])
        self.assertEqual(denom, [100.0, 100.0])
        units = denominator_units_series(fleet_list, first_active,
                                         ["2026-01-01", "2026-01-02"])
        self.assertEqual(units, [1, 1])


class PayloadGuard(unittest.TestCase):
    """Addendum §G item 31: the ordered degradation of §C. Pure in-memory
    dict test, no write."""

    def test_31_payload_guard_ordered_degradation(self):
        import json

        fleet_list = [{"id": f"U{i}", "cap_mw": 10.0,
                      "first_active": "2025-01-01"} for i in range(130)]
        days = {}
        for d in range(300):
            key = str(date(2025, 1, 1) + timedelta(days=d))
            days[key] = {
                "offer_mwh": [1.0] * 48, "bid_mwh": [-1.0] * 48,
                "offer_mwh_total": 48.0, "bid_mwh_total": -48.0,
                "acceptances": 100, "active_units": 120, "active_mw": 1200.0,
                "denominator_mw": 1300.0, "denominator_units": 130,
                "active_idx": list(range(120)),
                "unit_acceptances": {f"U{i}": i + 1 for i in range(120)},
            }
        payload = {
            "meta": {"schema": 2},
            "fleet": {"units": 130, "mw": 1300.0,
                      "window_active": {"units": 130, "mw": 1300.0},
                      "list": fleet_list},
            "days": days,
        }
        before = len(json.dumps(payload).encode())
        self.assertGreater(before, PAYLOAD_GUARD_BYTES)

        apply_payload_guard(payload)

        # unit_acceptances trimmed to the top 20 units/day (step 1).
        for entry in payload["days"].values():
            self.assertLessEqual(len(entry.get("unit_acceptances", {})), 20)
        # active_idx dropped from the HH tier entirely (step 2 -- the
        # fixture is large enough that step 1 alone does not clear the
        # guard, so step 2 must have fired).
        for entry in payload["days"].values():
            self.assertNotIn("active_idx", entry)
        # denominator_mw and first_active present throughout, never
        # dropped by any degradation step.
        for entry in payload["days"].values():
            self.assertIn("denominator_mw", entry)
        for unit in payload["fleet"]["list"]:
            self.assertIn("first_active", unit)


class ActiveIndexUnion(unittest.TestCase):
    """Small sanity checks on the helper both the fleet-list per-unit flag
    and the §B1(3) active_idx self-check are built from."""

    def test_union_across_days(self):
        days = {"2026-01-01": {"active_idx": [0, 2]},
               "2026-01-02": {"active_idx": [2, 3]},
               "2026-01-03": {}}
        self.assertEqual(active_index_union(days), {0, 2, 3})


if __name__ == "__main__":
    unittest.main()

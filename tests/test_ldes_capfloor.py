"""Tests for etl/build_ldes_capfloor.py (plan/10 Phase 2, B1).

Pure logic plus the real write path, stdlib, no network — the builder
is a vendored reference table with zero fetches, so unlike the sibling
ETL suites nothing here needs mocking or a certifi stub: build() runs
for real, into a temp dir.

House tripwire style: the guards must both PASS on the shipped table
and RAISE on a corrupted copy — a validator that never fires is
indistinguishable from no validator. The final class proves the file
shipped in app/data/ is what the builder produces (byte-identical
apart from built_at), so a hand-edit to the JSON that skips the
builder cannot drift past the suite.
"""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "etl"))

import build_ldes_capfloor as capfloor  # noqa: E402
from build_ldes_capfloor import (  # noqa: E402
    EXPECTED_RANKS,
    PROJECT_FIELDS,
    PayloadBudgetError,
    ProjectTableError,
    RegimeParameterError,
    StatusStageError,
    TotalsMismatch,
    assert_payload_budget,
    assert_project_table,
    assert_regime,
    assert_status,
    assert_totals,
    build_payload,
    validate_payload,
)

SHIPPED_PATH = PROJECT_ROOT / "app" / "data" / "ldes_capfloor.json"


class BuilderWritesValidJsonTest(unittest.TestCase):
    """build() end to end into a temp dir: valid JSON out, atomic write
    leaves no .tmp behind, and the manifest (when present) is bumped
    and carries the right hash — the build_bess_units.update_manifest
    contract."""

    def test_build_writes_valid_json_and_registers_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            seed = {"schema": 1, "version": 41, "built_at": "x",
                    "mode": "incremental",
                    "files": {"series_hh.json": {"sha256": "aa", "bytes": 1}},
                    "zones": ["GB"]}
            (tmp / "manifest.json").write_text(json.dumps(seed))

            capfloor.build(out_dir=tmp)

            out = tmp / "ldes_capfloor.json"
            self.assertTrue(out.exists())
            self.assertFalse((tmp / "ldes_capfloor.json.tmp").exists())
            payload = json.loads(out.read_text())
            validate_payload(payload)  # must not raise

            manifest = json.loads((tmp / "manifest.json").read_text())
            self.assertEqual(manifest["version"], 42)
            # a refresh must never de-register the core files
            self.assertIn("series_hh.json", manifest["files"])
            entry = manifest["files"]["ldes_capfloor.json"]
            self.assertEqual(entry["bytes"], len(out.read_bytes()))
            import hashlib
            self.assertEqual(entry["sha256"],
                             hashlib.sha256(out.read_bytes()).hexdigest())

    def test_absent_manifest_is_a_noop_not_a_crash(self):
        # Fresh clone: app/data may hold no manifest yet (the core build
        # creates it); the vendored step must still publish its payload.
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            capfloor.build(out_dir=tmp)
            self.assertTrue((tmp / "ldes_capfloor.json").exists())
            self.assertFalse((tmp / "manifest.json").exists())


class ProjectTableTest(unittest.TestCase):
    def setUp(self):
        self.payload = build_payload(built_at="2026-08-29T00:00:00+00:00")
        self.projects = self.payload["projects"]

    def test_sixteen_projects(self):
        self.assertEqual(len(self.projects), 16)

    def test_mw_sums_to_7645(self):
        self.assertEqual(sum(p["mw"] for p in self.projects), 7645)

    def test_every_project_has_all_eight_fields_with_sane_values(self):
        for row in self.projects:
            self.assertEqual(set(row), set(PROJECT_FIELDS))
            self.assertIsInstance(row["ea_rank"], int)
            for field in ("name", "technology", "region"):
                self.assertIsInstance(row[field], str)
                self.assertTrue(row[field])
            self.assertIsInstance(row["mw"], (int, float))
            self.assertGreater(row["mw"], 0)
            self.assertGreaterEqual(row["duration_h"], 8)
            self.assertLessEqual(row["duration_h"], 32)
            self.assertIn(row["track"], (1, 2))
            self.assertIsInstance(row["first_operation"], int)
            self.assertGreaterEqual(row["first_operation"], 2029)
            self.assertLessEqual(row["first_operation"], 2033)

    def test_ea_rank_strictly_increasing_with_the_documented_gaps(self):
        ranks = [p["ea_rank"] for p in self.projects]
        self.assertEqual(ranks, sorted(ranks))
        self.assertEqual(len(ranks), len(set(ranks)))
        self.assertEqual(tuple(ranks), EXPECTED_RANKS)
        # the gaps are real — those ranks were not selected
        self.assertEqual(sorted(set(range(1, 20)) - set(ranks)),
                         [10, 11, 13])

    def test_totals_block_agrees_with_the_list(self):
        totals = self.payload["totals"]
        self.assertEqual(totals["projects"], 16)
        self.assertEqual(totals["mw"], 7645)
        gwh = sum(p["mw"] * p["duration_h"] for p in self.projects) / 1000
        self.assertAlmostEqual(gwh, totals["gwh_approx"], delta=0.1)


class RegimeAndStatusTest(unittest.TestCase):
    def setUp(self):
        self.payload = build_payload(built_at="2026-08-29T00:00:00+00:00")

    def test_regime_carries_the_six_key_parameters(self):
        regime = self.payload["regime"]
        self.assertEqual(regime["duration_years_default"], 25)
        self.assertEqual(regime["floor_return_pct_cpih_real_indicative"],
                         4.47)
        self.assertEqual(regime["cap_return_pct_cpih_real_indicative"],
                         7.48)
        self.assertEqual(regime["soft_cap_retention_pct"], 30)
        self.assertEqual(regime["fa_threshold"], 0.60)
        self.assertEqual(regime["indexation"], "CPIH")

    def test_regime_prose_fields_present(self):
        regime = self.payload["regime"]
        for key in ("floor_basis", "cap_basis", "floor_condition",
                    "funding", "applied_to"):
            self.assertTrue(regime.get(key), key)

    def test_status_stage_is_minded_to(self):
        self.assertEqual(self.payload["status"]["stage"], "minded-to")

    def test_status_dates_and_note(self):
        status = self.payload["status"]
        self.assertEqual(status["published"], "2026-06-26")
        self.assertEqual(status["consultation_closed"], "2026-08-14")
        self.assertEqual(status["final_awards_expected"], "autumn 2026")
        self.assertIn("superseded", status["note"])

    def test_sources_and_meta_registration(self):
        sources = self.payload["sources"]
        self.assertEqual(len(sources), 2)
        for entry in sources:
            self.assertTrue(entry["label"])
            self.assertTrue(entry["url"].startswith("https://www.ofgem.gov.uk/"))
        # the in-payload meta.series entry (meta.json vocabulary — see
        # SOURCE_META's comment for why it lives here, not in meta.json)
        series = self.payload["meta"]["series"]["ldes_capfloor"]
        for key in ("name", "source", "endpoint", "unit", "resolution",
                    "update_frequency", "quality", "transformations",
                    "notes"):
            self.assertTrue(series.get(key), key)
        self.assertEqual(series["resolution"], "event/reference")


class TripwiresFireOnCorruptionTest(unittest.TestCase):
    """Every guard must RAISE on the slip it exists for — proved on
    corrupted deep copies of the shipped table."""

    def setUp(self):
        self.payload = build_payload(built_at="2026-08-29T00:00:00+00:00")

    def _projects(self):
        return copy.deepcopy(self.payload["projects"])

    def test_dropped_row_raises(self):
        with self.assertRaises(ProjectTableError):
            assert_project_table(self._projects()[:-1])

    def test_missing_field_raises(self):
        projects = self._projects()
        del projects[3]["duration_h"]
        with self.assertRaises(ProjectTableError):
            assert_project_table(projects)

    def test_unknown_field_raises(self):
        projects = self._projects()
        projects[0]["floor_gbp"] = 1.0  # commercially sensitive — never here
        with self.assertRaises(ProjectTableError):
            assert_project_table(projects)

    def test_out_of_range_duration_raises(self):
        projects = self._projects()
        projects[0]["duration_h"] = 7.9
        with self.assertRaises(ProjectTableError):
            assert_project_table(projects)
        projects[0]["duration_h"] = 32.5
        with self.assertRaises(ProjectTableError):
            assert_project_table(projects)

    def test_bad_track_raises(self):
        projects = self._projects()
        projects[0]["track"] = 3
        with self.assertRaises(ProjectTableError):
            assert_project_table(projects)

    def test_out_of_range_first_operation_raises(self):
        projects = self._projects()
        projects[0]["first_operation"] = 2028
        with self.assertRaises(ProjectTableError):
            assert_project_table(projects)

    def test_wrong_rank_set_raises(self):
        projects = self._projects()
        projects[9]["ea_rank"] = 10  # "fixing" a real gap must raise
        with self.assertRaises(ProjectTableError):
            assert_project_table(projects)

    def test_non_increasing_ranks_raise(self):
        projects = self._projects()
        projects[0]["ea_rank"], projects[1]["ea_rank"] = 2, 1
        with self.assertRaises(ProjectTableError):
            assert_project_table(projects)

    def test_mw_typo_raises(self):
        projects = self._projects()
        projects[0]["mw"] = 661
        with self.assertRaises(TotalsMismatch):
            assert_totals(projects, self.payload["totals"])

    def test_gwh_disagreement_raises(self):
        totals = dict(self.payload["totals"], gwh_approx=150.0)
        with self.assertRaises(TotalsMismatch):
            assert_totals(self._projects(), totals)

    def test_regime_value_drift_raises(self):
        regime = dict(self.payload["regime"],
                      floor_return_pct_cpih_real_indicative=4.5)
        with self.assertRaises(RegimeParameterError):
            assert_regime(regime)

    def test_regime_missing_key_raises(self):
        regime = dict(self.payload["regime"])
        del regime["fa_threshold"]
        with self.assertRaises(RegimeParameterError):
            assert_regime(regime)

    def test_stale_stage_raises(self):
        with self.assertRaises(StatusStageError):
            assert_status(dict(self.payload["status"], stage="final"))

    def test_payload_budget_raises(self):
        with self.assertRaises(PayloadBudgetError):
            assert_payload_budget(b"x" * (capfloor.PAYLOAD_BUDGET_BYTES + 1))

    def test_shipped_payload_passes_all_tripwires(self):
        validate_payload(self.payload)  # must not raise


class ShippedFileMatchesBuilderTest(unittest.TestCase):
    """The file in app/data/ is exactly what the builder produces (the
    timestamp aside) — a hand-edit that bypasses the builder cannot
    drift past this. Skipped, like every payload-reading suite in this
    repo would be, when app/data/ has not been built on this machine
    (it is gitignored)."""

    def setUp(self):
        if not SHIPPED_PATH.exists():
            self.skipTest("app/data/ldes_capfloor.json not built here — "
                          "run: python3 etl/build_ldes_capfloor.py")
        self.shipped = json.loads(SHIPPED_PATH.read_text())

    def test_shipped_file_is_the_builders_output(self):
        rebuilt = build_payload(built_at=self.shipped["built_at"])
        self.assertEqual(self.shipped, rebuilt)

    def test_shipped_file_passes_validation(self):
        validate_payload(self.shipped)  # must not raise


if __name__ == "__main__":
    unittest.main()

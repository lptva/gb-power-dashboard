"""ops/refresh.py — the daily orchestrator's resilience logic.

Pinned here without touching the network or the clock: the once-per-day
gate that stops the 09:00 fallback fire paying for a second LLM run, the
core-step retry/backoff schedule (sleep injected), the status-file writer
that the dashboard header consumes, and main()'s guarantee that a run
which dies — deliberately or by an unexpected exception — never reports
"ok".
"""

import datetime
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ops"))

import refresh  # noqa: E402
from refresh import (  # noqa: E402
    CORE_RETRY_WAITS,
    run_core_with_retry,
    summary_ran_today,
    write_status,
)


class SummaryRanTodayTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "overnight_summary.json"
        self.today = datetime.date(2026, 7, 13)

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, obj):
        self.path.write_text(json.dumps(obj), encoding="utf-8")

    # -- proceed (False) when we can't confirm today's run ----------------

    def test_absent_file_proceeds(self):
        self.assertFalse(summary_ran_today(self.path, self.today))

    def test_unreadable_json_proceeds(self):
        self.path.write_text("{not json", encoding="utf-8")
        self.assertFalse(summary_ran_today(self.path, self.today))

    def test_missing_key_proceeds(self):
        self.write({"window": {}})
        self.assertFalse(summary_ran_today(self.path, self.today))

    def test_different_date_proceeds(self):
        self.write({"generated_at": "2026-07-12T09:37:07+00:00"})
        self.assertFalse(summary_ran_today(self.path, self.today))

    # -- skip (True) when today's summary already exists ------------------

    def test_same_date_skips(self):
        self.write({"generated_at": "2026-07-13T06:59:59+00:00"})
        self.assertTrue(summary_ran_today(self.path, self.today))

    def test_date_only_string_skips(self):
        self.write({"generated_at": "2026-07-13"})
        self.assertTrue(summary_ran_today(self.path, self.today))


class _Recorder:
    """Injected note()/sleep() that record instead of writing or blocking."""

    def __init__(self):
        self.notes = []
        self.sleeps = []

    def note(self, line):
        self.notes.append(line)

    def sleep(self, seconds):
        self.sleeps.append(seconds)


class RunCoreWithRetryTest(unittest.TestCase):
    def _run_once_returning(self, codes):
        seq = iter(codes)
        return lambda: next(seq)

    def test_first_try_succeeds_no_wait(self):
        rec = _Recorder()
        code, attempts = run_core_with_retry(
            self._run_once_returning([0]), rec.note, rec.sleep)
        self.assertEqual((code, attempts), (0, 1))
        self.assertEqual(rec.sleeps, [])
        self.assertEqual(rec.notes, [])

    def test_succeeds_on_third_attempt(self):
        rec = _Recorder()
        code, attempts = run_core_with_retry(
            self._run_once_returning([1, 1, 0]), rec.note, rec.sleep)
        self.assertEqual((code, attempts), (0, 3))
        # Backoff schedule honoured: 2 minutes then 5 minutes.
        self.assertEqual(rec.sleeps, list(CORE_RETRY_WAITS))
        self.assertEqual(rec.sleeps, [120, 300])
        # Each failed attempt and each wait logged.
        self.assertEqual(len(rec.notes), 4)

    def test_all_attempts_fail_returns_last_code(self):
        rec = _Recorder()
        code, attempts = run_core_with_retry(
            self._run_once_returning([2, 2, 2]), rec.note, rec.sleep)
        self.assertEqual((code, attempts), (2, 3))
        # Only waits between attempts — no wait after the final failure.
        self.assertEqual(rec.sleeps, [120, 300])


class WriteStatusTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "refresh_status.json"

    def tearDown(self):
        self._tmp.cleanup()

    def test_ok_run_schema_round_trips(self):
        steps = ["core dataset refresh", "bmu snapshot refresh"]
        returned = write_status(
            self.path, "ok", None, None, steps, 1,
            ts="2026-07-13T09:00:12Z")
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk, returned)
        self.assertEqual(set(on_disk), {
            "ts", "outcome", "failed_step", "error",
            "steps_completed", "attempts"})
        self.assertEqual(on_disk["outcome"], "ok")
        self.assertIsNone(on_disk["failed_step"])
        self.assertIsNone(on_disk["error"])
        self.assertEqual(on_disk["steps_completed"], steps)
        self.assertEqual(on_disk["attempts"], 1)

    def test_failed_run_records_step_and_error(self):
        write_status(
            self.path, "failed", "core dataset refresh",
            "core dataset refresh failed (exit 1) after 3 attempts",
            [], 3, ts="2026-07-13T07:12:00Z")
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["outcome"], "failed")
        self.assertEqual(on_disk["failed_step"], "core dataset refresh")
        self.assertEqual(on_disk["attempts"], 3)
        self.assertEqual(on_disk["steps_completed"], [])

    def test_atomic_write_leaves_no_tmp(self):
        write_status(self.path, "ok", None, None, [], 1,
                     ts="2026-07-13T09:00:12Z")
        self.assertTrue(self.path.exists())
        siblings = list(self.path.parent.iterdir())
        self.assertEqual(siblings, [self.path])

    def test_steps_completed_snapshotted(self):
        # The writer must copy the list, not alias the caller's mutable one.
        steps = ["core dataset refresh"]
        returned = write_status(self.path, "ok", None, None, steps, 1,
                                ts="2026-07-13T09:00:12Z")
        steps.append("mutated after the call")
        self.assertEqual(returned["steps_completed"], ["core dataset refresh"])

    def test_default_ts_is_utc_z(self):
        returned = write_status(self.path, "ok", None, None, [], 1)
        self.assertTrue(returned["ts"].endswith("Z"))
        # Parses as an ISO-8601 instant.
        datetime.datetime.fromisoformat(returned["ts"].replace("Z", "+00:00"))


class MainStatusOnFailureTest(unittest.TestCase):
    """main()'s try/except/finally: a run that dies — deliberately on the
    fatal core step, or by an unexpected exception anywhere in the pipeline
    — must still write a status file, and it must never say "ok"."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        (tmp / "logs").mkdir()
        self.status_path = tmp / "refresh_status.json"
        self._patches = [
            # Logs and status go to the temp dir, not the repo.
            mock.patch.object(refresh, "OPS", tmp),
            mock.patch.object(refresh, "STATUS_PATH", self.status_path),
            # No real interpreter lookup, no real waits between attempts.
            mock.patch.object(refresh, "resolve_child_python",
                              lambda: "python3"),
            mock.patch.object(refresh.time, "sleep", lambda s: None),
        ]
        for p in self._patches:
            p.start()
        self._saved_env = os.environ.pop("GB_DASH_ORCHESTRATED", None)

    def tearDown(self):
        for p in self._patches:
            p.stop()
        os.environ.pop("GB_DASH_ORCHESTRATED", None)
        if self._saved_env is not None:
            os.environ["GB_DASH_ORCHESTRATED"] = self._saved_env
        self._tmp.cleanup()

    def read_status(self):
        return json.loads(self.status_path.read_text(encoding="utf-8"))

    def test_unexpected_exception_writes_failed_status(self):
        # subprocess.run raising (vanished interpreter, OSError) is not the
        # deliberate sys.exit path — the status must still say "failed".
        def boom(*args, **kwargs):
            raise OSError("child interpreter vanished")

        with mock.patch.object(refresh.subprocess, "run", boom):
            with self.assertRaises(OSError):
                refresh.main()
        status = self.read_status()
        self.assertEqual(status["outcome"], "failed")
        self.assertEqual(status["failed_step"], "orchestrator")
        self.assertIsNotNone(status["error"])
        self.assertIn("child interpreter vanished", status["error"])

    def test_fatal_core_exit_writes_failed_status(self):
        # Deliberate path: core step fails on every retry → SystemExit,
        # and the finally still publishes the verdict.
        failing = lambda *a, **k: types.SimpleNamespace(returncode=1)
        with mock.patch.object(refresh.subprocess, "run", failing):
            with self.assertRaises(SystemExit) as ctx:
                refresh.main()
        self.assertEqual(ctx.exception.code, 1)
        status = self.read_status()
        self.assertEqual(status["outcome"], "failed")
        self.assertEqual(status["failed_step"], "core dataset refresh")
        self.assertEqual(status["attempts"], 3)
        self.assertEqual(status["steps_completed"], [])


if __name__ == "__main__":
    unittest.main()

"""ops/run_overnight_summary.py — the transient-vs-permanent CLI error
classifier that decides whether a failed `claude` invocation is worth one
retry.

Pinned against the two real failure envelopes that motivated it (both still
on disk under ops/logs/): 13 Jul 2026 was a 401 auth error (permanent, no
retry), 14 Jul 2026 was a server-side api_error mid-response (transient,
retry once). The default for anything unrecognised is fail-closed, so an
unknown failure never spends a second paid attempt.
"""

import json
import sys
import unittest
from pathlib import Path

OPS = Path(__file__).resolve().parents[1] / "ops"
sys.path.insert(0, str(OPS))

from run_overnight_summary import cli_error_is_transient  # noqa: E402

LOGS = OPS / "logs"


def _envelope_from_dump(path):
    """Pull the raw CLI stdout back out of an overnight.cli-error-*.txt dump
    (exit code line, then '=== stdout ===' / '=== stderr ===' sections)."""
    text = path.read_text(encoding="utf-8")
    return text.split("=== stdout ===\n", 1)[1].split("\n=== stderr ===", 1)[0]


class RealEnvelopeTest(unittest.TestCase):
    """The two incidents this fix exists for."""

    def test_14jul_server_error_is_transient(self):
        dumps = sorted(LOGS.glob("overnight.cli-error-20260714T*.txt"))
        self.assertTrue(dumps, "expected the 14 Jul api_error dump on disk")
        self.assertTrue(cli_error_is_transient(_envelope_from_dump(dumps[0])))

    def test_13jul_auth_error_is_not_transient(self):
        dumps = sorted(LOGS.glob("overnight.cli-error-20260713T*.txt"))
        self.assertTrue(dumps, "expected the 13 Jul 401 dump on disk")
        self.assertFalse(cli_error_is_transient(_envelope_from_dump(dumps[0])))


class ClassifierTest(unittest.TestCase):
    # -- transient (retry once) -------------------------------------------

    def test_terminal_reason_api_error(self):
        self.assertTrue(cli_error_is_transient(json.dumps(
            {"terminal_reason": "api_error", "api_error_status": None,
             "result": "API Error: Server error mid-response."})))

    def test_5xx_status(self):
        for status in (500, 502, 503, 529, 599):
            self.assertTrue(cli_error_is_transient(
                json.dumps({"api_error_status": status})), status)

    def test_transient_message_markers(self):
        for msg in ("Overloaded", "Service Unavailable", "Bad Gateway",
                    "Request timed out", "Internal server error"):
            self.assertTrue(cli_error_is_transient(
                json.dumps({"result": msg})), msg)

    # -- permanent (fail fast, no paid retry) -----------------------------

    def test_401_auth(self):
        self.assertFalse(cli_error_is_transient(json.dumps(
            {"api_error_status": 401,
             "result": "Failed to authenticate. API Error: 401"})))

    def test_403_forbidden(self):
        self.assertFalse(cli_error_is_transient(
            json.dumps({"api_error_status": 403})))

    def test_auth_message_beats_api_error_reason(self):
        # A 401 can arrive with terminal_reason left at "completed"; the auth
        # wording must still win over any transient signal.
        self.assertFalse(cli_error_is_transient(json.dumps(
            {"terminal_reason": "completed", "api_error_status": 401,
             "result": "authentication failed"})))

    # -- fail closed on anything we can't read -----------------------------

    def test_unrecognised_error_is_not_transient(self):
        self.assertFalse(cli_error_is_transient(
            json.dumps({"result": "some brand new failure shape"})))

    def test_empty_stdout(self):
        self.assertFalse(cli_error_is_transient(""))

    def test_unparseable_stdout(self):
        self.assertFalse(cli_error_is_transient("not json at all"))

    def test_none_stdout(self):
        self.assertFalse(cli_error_is_transient(None))


if __name__ == "__main__":
    unittest.main()

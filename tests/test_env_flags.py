"""ops/env_flags.py — the consent gate for the AI overnight summary.

This flag is what stands between "claude CLI happens to be installed"
and "daily token spend", so its default and its precedence rules are
pinned here: absent means OFF, environment beats .env, and only an
explicit truthy value enables anything.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ops"))

from env_flags import FLAG, ai_summary_enabled  # noqa: E402


class EnvFlagsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._saved = os.environ.pop(FLAG, None)

    def tearDown(self):
        os.environ.pop(FLAG, None)
        if self._saved is not None:
            os.environ[FLAG] = self._saved
        self._tmp.cleanup()

    def write_dotenv(self, text):
        (self.root / ".env").write_text(text, encoding="utf-8")

    # -- the default that protects people's subscriptions ----------------

    def test_absent_everywhere_is_disabled(self):
        self.assertFalse(ai_summary_enabled(self.root))

    def test_dotenv_false_is_disabled(self):
        self.write_dotenv("ENABLE_AI_SUMMARY=false\n")
        self.assertFalse(ai_summary_enabled(self.root))

    def test_unrecognised_value_is_disabled(self):
        self.write_dotenv("ENABLE_AI_SUMMARY=maybe\n")
        self.assertFalse(ai_summary_enabled(self.root))

    def test_empty_value_is_disabled(self):
        self.write_dotenv("ENABLE_AI_SUMMARY=\n")
        self.assertFalse(ai_summary_enabled(self.root))

    # -- explicit opt-in --------------------------------------------------

    def test_dotenv_true_enables(self):
        self.write_dotenv("ENTSOE_TOKEN=abc\nENABLE_AI_SUMMARY=true\n")
        self.assertTrue(ai_summary_enabled(self.root))

    def test_truthy_variants_and_quotes(self):
        for value in ("true", "TRUE", "1", "yes", "on", '"true"', "'true'"):
            self.write_dotenv("ENABLE_AI_SUMMARY={}\n".format(value))
            self.assertTrue(ai_summary_enabled(self.root), value)

    def test_commented_line_is_ignored(self):
        self.write_dotenv("# ENABLE_AI_SUMMARY=true\n")
        self.assertFalse(ai_summary_enabled(self.root))

    # -- precedence: environment beats .env -------------------------------

    def test_environment_true_overrides_dotenv_false(self):
        self.write_dotenv("ENABLE_AI_SUMMARY=false\n")
        os.environ[FLAG] = "true"
        self.assertTrue(ai_summary_enabled(self.root))

    def test_environment_false_overrides_dotenv_true(self):
        self.write_dotenv("ENABLE_AI_SUMMARY=true\n")
        os.environ[FLAG] = "false"
        self.assertFalse(ai_summary_enabled(self.root))

    def test_empty_environment_falls_through_to_dotenv(self):
        # Matches the ENTSOE_TOKEN convention: an empty env var is "unset".
        self.write_dotenv("ENABLE_AI_SUMMARY=true\n")
        os.environ[FLAG] = ""
        self.assertTrue(ai_summary_enabled(self.root))


if __name__ == "__main__":
    unittest.main()

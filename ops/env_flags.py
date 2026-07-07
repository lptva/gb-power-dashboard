"""Opt-in flag for the AI overnight summary — the project's only paid
feature. The gate is deliberate consent, not capability detection: having
the claude CLI installed and authenticated (perhaps for entirely
unrelated work) must never be enough to start spending someone's usage
allowance on a schedule.

Same convention as ENTSOE_TOKEN in etl/fetch_entsoe.py: the environment
variable wins, otherwise the project-root .env is read (never app/,
which is web-served). Anything other than an explicit truthy value —
including the flag being absent entirely — means disabled.
"""

import os
from pathlib import Path

FLAG = "ENABLE_AI_SUMMARY"
_TRUTHY = {"true", "1", "yes", "on"}


def _dotenv_value(root, key):
    try:
        for line in (Path(root) / ".env").read_text(encoding="utf-8")\
                .splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                name, value = line.split("=", 1)
                if name.strip() == key:
                    return value
    except OSError:
        pass  # no .env — the environment-variable path still applies
    return None


def ai_summary_enabled(root):
    raw = os.environ.get(FLAG)
    if raw is None or raw.strip() == "":
        raw = _dotenv_value(root, FLAG)
    if raw is None:
        return False
    return raw.strip().strip("'\"").lower() in _TRUTHY

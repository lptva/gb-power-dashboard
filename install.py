#!/usr/bin/env python3
"""One-command installer for the GB power dashboard.

    Mac:      python3 install.py
    Windows:  double-click install.bat   (or: py install.py)

Creates a private Python environment inside the project, installs the one
dependency, builds the dataset (asks first), then starts the dashboard and
opens it in your browser. Safe to run again at any time — it skips
whatever is already done.

Flags (for people who know they want them; the defaults are right for
everyone else):
    --days N       build/refresh N days of data instead of 365
    --no-launch    set everything up but don't start the server/browser
"""

# The version guard runs before anything modern-syntax is needed, so a
# too-old Python 3 gets a helpful message instead of a traceback. (If
# Python is missing ENTIRELY, no code here can run — that case is handled
# by install.bat on Windows and by docs/SETUP.md's install steps.)
import sys

if sys.version_info < (3, 10):
    sys.stderr.write(
        "\nThis project needs Python 3.10 or newer; you are running "
        "Python {}.{}.\n\n"
        "Install the current version from https://www.python.org/downloads/\n"
        "On Windows: tick the box 'Add python.exe to PATH' on the first\n"
        "installer screen, then run this again.\n\n".format(
            sys.version_info[0], sys.version_info[1]))
    sys.exit(1)

import argparse
import os
import socket
import subprocess
import time
import venv
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
VENV_PYTHON = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
DATASET = ROOT / "app" / "data" / "series_hh.json"


def say(message):
    # flush=True: child processes share this stdout and write unbuffered,
    # so without it their output overtakes these step banners.
    print("\n==> " + message, flush=True)


def ask_yes_no(question, default_yes):
    """Prompt that survives non-interactive stdin (defaults apply)."""
    suffix = " [Y/n] " if default_yes else " [y/N] "
    try:
        answer = input(question + suffix).strip().lower()
    except EOFError:
        return default_yes
    if not answer:
        return default_yes
    return answer.startswith("y")


def ensure_venv():
    if VENV_PYTHON.exists():
        say("Private Python environment already exists (.venv) — keeping it.")
        return
    say("Creating a private Python environment inside the project (.venv)…")
    venv.EnvBuilder(with_pip=True).create(str(VENV))
    say("Installing the one dependency (certifi — security certificates)…")
    subprocess.run([str(VENV_PYTHON), "-m", "pip", "install", "--quiet",
                    "certifi"], check=True)


def ensure_dataset(days):
    if DATASET.exists():
        if not ask_yes_no("Market data already present — refresh it now?",
                          default_yes=False):
            say("Keeping the existing data.")
            return
    else:
        print("\nThe dashboard needs a year of market data, fetched from "
              "free public sources.\nThe first build makes ~160 small "
              "downloads and takes 3–5 minutes; progress\nprints as it "
              "goes.", flush=True)
        if not ask_yes_no("Build the dataset now?", default_yes=True):
            say("Skipped. Run this installer again when you're ready — "
                "the dashboard cannot start without data.")
            sys.exit(0)
    say("Building the dataset ({} days)…".format(days))
    result = subprocess.run(
        [str(VENV_PYTHON), str(ROOT / "etl" / "build_dataset.py"),
         "--days", str(days)], cwd=str(ROOT))
    if result.returncode != 0:
        sys.exit("\nThe data build failed — the messages above say why. "
                 "Common causes:\nno internet connection, or a data source "
                 "briefly unavailable. It is safe to\nrun this installer "
                 "again; already-downloaded chunks are reused.")


def free_port(preferred=8872):
    for port in range(preferred, preferred + 11):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    sys.exit("No free port found between {} and {}.".format(
        preferred, preferred + 10))


def serve():
    port = free_port()
    url = "http://localhost:{}".format(port)
    say("Starting the dashboard at {}".format(url))
    server = subprocess.Popen(
        [str(VENV_PYTHON), "-m", "http.server", str(port),
         "--directory", str(ROOT / "app"), "--bind", "127.0.0.1"])
    time.sleep(1.0)
    if server.poll() is not None:
        sys.exit("The server stopped immediately — the messages above "
                 "say why.")
    webbrowser.open(url)
    print("\nThe dashboard should now be open in your browser. If not, "
          "go to:\n\n    {}\n\nLeave this window open while you use it. "
          "Press Ctrl+C here to stop.".format(url))
    try:
        server.wait()
    except KeyboardInterrupt:
        server.terminate()
        print("\nStopped. To start again later, run this installer again — "
              "it skips\nstraight to serving once everything is set up.")


def main():
    parser = argparse.ArgumentParser(
        description="Set up and run the GB power dashboard.")
    parser.add_argument("--days", type=int, default=365,
                        help="days of history to build (default 365)")
    parser.add_argument("--no-launch", action="store_true",
                        help="set up everything but don't start the server")
    args = parser.parse_args()

    print("GB Power Market Dashboard — installer")
    print("Everything below is free and needs no account or API key.")
    ensure_venv()
    ensure_dataset(args.days)
    if args.no_launch:
        say("Setup complete. Start the dashboard any time with:\n"
            "    {} -m http.server 8872 --directory app".format(
                VENV_PYTHON.relative_to(ROOT)))
        return
    serve()


if __name__ == "__main__":
    main()

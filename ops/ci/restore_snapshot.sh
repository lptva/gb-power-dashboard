#!/usr/bin/env bash
# ops/ci/restore_snapshot.sh — restore the ETL state snapshot for the hosted
# GB power dashboard, or fall through to a cold start. This is the load-bearing
# safety mechanism of Milestone A (plan/07 §0, D8/D9): it decides warm-vs-cold
# and NEVER silently restores bad data.
#
# ── Why no `set -e` ─────────────────────────────────────────────────────────
# A cold start is a VALID outcome, not an error. `set -e`/`pipefail` would turn
# a missing release, a failed download, or a failed integrity gate into a job
# abort. Instead every check below is explicit if/else and the script exits 0
# for BOTH warm and cold. It exits non-zero ONLY for genuine programming /
# environment errors (bad CLI usage, or required CI env missing in full mode).
#
# ── Two phases (separable, so the gate logic is testable offline) ───────────
#   DOWNLOAD (CI only): resolve the `data-snapshot` DRAFT release BY ID via
#     `gh api` (drafts may not resolve by tag — plan/07 §0), fetch the two
#     assets `app-data.tar.gz` and `app-data.tar.gz.sha256` into a work dir.
#     No release / no assets → cold start, not an error.
#   GATE (pure-local, no network, no gh): three integrity gates in order, then
#     extract. See run_gates().
#
# ── Usage ───────────────────────────────────────────────────────────────────
#   restore_snapshot.sh                 Full CI behaviour: download → gates →
#                                       extract. Requires GITHUB_REPOSITORY and
#                                       the `gh` CLI (authenticated via GH_TOKEN).
#   restore_snapshot.sh --gates-only DIR
#                                       Offline: run ONLY the gate phase against
#                                       a prepared DIR (which may or may not hold
#                                       the two files). No network, no gh. This
#                                       is the entry point for the offline gate
#                                       tester.
#
# ── Inputs (env) ────────────────────────────────────────────────────────────
#   REQUESTED_COLD   "true" iff the run explicitly asked for a cold start
#                    (workflow_dispatch cold_start=true). Anything else — empty,
#                    "false", or a future schedule: trigger with no input — is
#                    treated as "not requested", so an unexpected cold start
#                    raises a ::warning:: (state-loss detection, plan/07 §0).
#   EXTRACT_ROOT     Where a validated tarball is unpacked (it contains
#                    app/data/…). Defaults to the repo root in full/CI mode.
#                    In --gates-only mode it defaults to the prepared DIR
#                    itself, so an offline test can never clobber the real
#                    working tree by omission (an explicit EXTRACT_ROOT still
#                    wins in both modes).
#
# ── Outputs ─────────────────────────────────────────────────────────────────
#   In CI (GITHUB_OUTPUT set): `warm=true|false` → $GITHUB_OUTPUT; a human line
#     → $GITHUB_STEP_SUMMARY:
#       warm → "state restored from snapshot (manifest v<N>, built <ts>)"
#       cold → "cold start: <reason>"  (+ ::warning:: when not requested)
#   Offline (GITHUB_OUTPUT unset): `warm=true|false` is printed to stdout.
#   Either way, every gate decision and reason is echoed to stdout (the log).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Remember whether the caller set EXTRACT_ROOT explicitly: --gates-only picks a
# safer default (the prepared dir) when it was omitted — a valid test tarball
# must never unpack into the real working tree by omission.
EXTRACT_ROOT_EXPLICIT="${EXTRACT_ROOT:+1}"
EXTRACT_ROOT="${EXTRACT_ROOT:-$REPO_ROOT}"

TARBALL_NAME="app-data.tar.gz"
CHECKSUM_NAME="app-data.tar.gz.sha256"
RELEASE_TAG="data-snapshot"

# Populated by run_gates() when it returns non-zero (cold), consumed by main.
GATE_REASON=""

print_help() {
  sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# sha256 verify, run inside DIR so the bare filename in the checksum resolves.
# CI (ubuntu-latest) ships coreutils `sha256sum`, which is what the publish
# side writes with; `shasum -a 256` is a compatible fallback purely so the
# offline gate tester can run on macOS, where sha256sum is absent by default.
# `--strict` is load-bearing: WITHOUT it a malformed/truncated checksum line is
# merely warned about and the check still exits 0 (fail OPEN) — with it, a
# malformed checksum fails closed, matching gate 1's "missing checksum = corrupt"
# stance. Both coreutils and Perl shasum support --strict.
sha256_check_in() {  # $1 = dir
  local dir="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$dir" && sha256sum -c --strict "$CHECKSUM_NAME" )
  elif command -v shasum >/dev/null 2>&1; then
    ( cd "$dir" && shasum -a 256 -c --strict "$CHECKSUM_NAME" )
  else
    echo "  no sha256sum/shasum available to verify the checksum" >&2
    return 2
  fi
}

manifest_field() {  # $1 = key in EXTRACT_ROOT/app/data/manifest.json
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], "?"))' \
    "$EXTRACT_ROOT/app/data/manifest.json" "$1" 2>/dev/null || echo "?"
}

# ── GATE PHASE ──────────────────────────────────────────────────────────────
# Return 0 = warm (all gates passed, tarball extracted); 1 = cold (GATE_REASON
# set). Pure-local: no network, no gh. Prints which gate failed and why.
run_gates() {
  local dir="$1"
  local tarball="$dir/$TARBALL_NAME"
  local checksum="$dir/$CHECKSUM_NAME"

  # Gate 1 — BOTH assets present. A missing checksum is treated as CORRUPT, not
  # as "skip the check": fail closed (plan/07 §0 D8, gate 1).
  if [ ! -f "$tarball" ] && [ ! -f "$checksum" ]; then
    echo "gate 1 FAILED: neither snapshot asset present"
    GATE_REASON="no snapshot found (first run, or release/assets absent)"
    return 1
  fi
  if [ ! -f "$tarball" ]; then
    echo "gate 1 FAILED: $TARBALL_NAME missing (checksum present) — treating as corrupt"
    GATE_REASON="snapshot incomplete: $TARBALL_NAME missing"
    return 1
  fi
  if [ ! -f "$checksum" ]; then
    echo "gate 1 FAILED: $CHECKSUM_NAME missing — a missing checksum is corrupt, fail closed"
    GATE_REASON="snapshot incomplete: $CHECKSUM_NAME missing (fail closed)"
    return 1
  fi
  echo "gate 1 passed: both snapshot assets present"

  # Gate 2 — sha256sum -c passes. Catches truncation, silent corruption, and a
  # complete-but-wrong file that a structural check alone would wave through.
  if sha256_check_in "$dir"; then
    echo "gate 2 passed: sha256 checksum matches"
  else
    echo "gate 2 FAILED: sha256 checksum mismatch or unverifiable"
    GATE_REASON="checksum verification failed (corrupt or truncated tarball)"
    return 1
  fi

  # Gate 3 — tar tzf passes. Structural / gzip-CRC check before anything is
  # allowed to touch app/data/.
  if tar tzf "$tarball" >/dev/null 2>&1; then
    echo "gate 3 passed: tarball structure/gzip-CRC ok"
  else
    echo "gate 3 FAILED: tarball is not a readable gzip archive"
    GATE_REASON="tarball structural check (tar tzf) failed"
    return 1
  fi

  # All three gates passed — only now touch the filesystem. The tarball holds
  # app/data/…, so extracting at EXTRACT_ROOT reproduces app/data/.
  if tar xzf "$tarball" -C "$EXTRACT_ROOT" 2>/dev/null; then
    echo "all gates passed: extracted snapshot into $EXTRACT_ROOT"
    return 0
  fi
  echo "extraction FAILED after all gates passed — falling back to cold start"
  GATE_REASON="extraction failed after validation"
  return 1
}

# ── DOWNLOAD PHASE (CI only) ────────────────────────────────────────────────
# Best-effort: populate `dest` with whatever snapshot assets exist, addressing
# the release BY ID (drafts may not resolve by tag — plan/07 §0). Any absence
# or failure just leaves `dest` short a file, and the gate phase turns that into
# a cold start. Never fails the job here.
download_snapshot() {
  local dest="$1"
  local rid aid

  rid="$(gh api "/repos/${GITHUB_REPOSITORY}/releases?per_page=100" \
         --jq "[.[] | select(.tag_name==\"$RELEASE_TAG\" and .draft==true)][0].id // empty" \
         2>/dev/null || true)"
  if [ -z "$rid" ]; then
    echo "download: no $RELEASE_TAG draft release found (expected on the first run)"
    return 0
  fi
  echo "download: resolved $RELEASE_TAG draft release id=$rid"

  local name
  for name in "$TARBALL_NAME" "$CHECKSUM_NAME"; do
    aid="$(gh api "/repos/${GITHUB_REPOSITORY}/releases/${rid}/assets?per_page=100" \
           --jq ".[] | select(.name==\"$name\") | .id" 2>/dev/null | head -n1 || true)"
    if [ -z "$aid" ]; then
      echo "download: asset $name absent on the release"
      continue
    fi
    if gh api "/repos/${GITHUB_REPOSITORY}/releases/assets/${aid}" \
         -H "Accept: application/octet-stream" > "$dest/$name" 2>/dev/null; then
      echo "download: fetched $name (asset id=$aid)"
    else
      echo "download: fetch of $name failed — dropping it (gates will cold-start)"
      rm -f "$dest/$name"
    fi
  done
  return 0
}

# ── OUTPUT HELPERS ──────────────────────────────────────────────────────────
emit_warm() {
  local ver ts line
  ver="$(manifest_field version)"
  ts="$(manifest_field built_at)"
  line="state restored from snapshot (manifest v${ver}, built ${ts})"
  echo "$line"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'warm=true\n' >> "$GITHUB_OUTPUT"
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '%s\n' "$line" >> "$GITHUB_STEP_SUMMARY"
  else
    printf 'warm=true\n'   # offline: the tester reads warm= from stdout
  fi
}

emit_cold() {
  local reason="$1"
  local line="cold start: ${reason}"
  echo "$line"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'warm=false\n' >> "$GITHUB_OUTPUT"
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '%s\n' "$line" >> "$GITHUB_STEP_SUMMARY"
  else
    printf 'warm=false\n'  # offline: the tester reads warm= from stdout
  fi
  # State-loss detection: warn ONLY when the cold start was not asked for.
  # "Not requested" = REQUESTED_COLD is anything other than the literal "true",
  # which also covers a future schedule: trigger (cold_start input absent).
  if [ "${REQUESTED_COLD:-}" != "true" ]; then
    printf '::warning::unrequested cold start — snapshot state was lost or unavailable; the site was rebuilt from scratch (%s)\n' "$reason"
  fi
}

# ── MAIN ────────────────────────────────────────────────────────────────────
main() {
  local mode="full" dir=""

  case "${1:-}" in
    --gates-only)
      mode="gates"
      dir="${2:-}"
      if [ -z "$dir" ]; then
        echo "usage: restore_snapshot.sh --gates-only <dir>" >&2
        exit 2
      fi
      # Offline safety: unless the caller set EXTRACT_ROOT explicitly, extract
      # into the prepared dir — never into the real working tree by default.
      if [ -z "$EXTRACT_ROOT_EXPLICIT" ]; then
        EXTRACT_ROOT="$dir"
      fi
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    "")
      mode="full"
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: restore_snapshot.sh [--gates-only <dir>]" >&2
      exit 2
      ;;
  esac

  if [ "$mode" = "full" ]; then
    # Genuine environment errors (NOT cold starts) — these mean CI cannot even
    # look for a snapshot, so they exit non-zero.
    if [ -z "${GITHUB_REPOSITORY:-}" ]; then
      echo "ERROR: GITHUB_REPOSITORY is unset (required in full/CI mode)" >&2
      exit 3
    fi
    if ! command -v gh >/dev/null 2>&1; then
      echo "ERROR: gh CLI not found on PATH (required in full/CI mode)" >&2
      exit 3
    fi
    dir="$(mktemp -d)"
    echo "restore: work dir = $dir"
    download_snapshot "$dir"
  else
    echo "restore: gates-only against $dir (offline; no download)"
  fi

  if run_gates "$dir"; then
    emit_warm
  else
    emit_cold "$GATE_REASON"
  fi
  # Warm and cold are both success from the job's point of view.
  exit 0
}

main "$@"

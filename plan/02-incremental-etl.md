# Milestone 2 — Incremental ETL + versioned manifest

## Goal

Append new settlement periods to the existing JSON files instead of rebuilding
the full year, and give the front end a reliable cache-busting mechanism via a
small versioned manifest.

## Design

### `--incremental` mode in `etl/build_dataset.py`

1. Read the existing `app/data/series_hh.json`, `series_daily.json`,
   `meta.json`. If any is missing or unreadable, fall back to a full build
   (with a clear log line saying so).
2. `last_ts = hh.t[-1]` → re-fetch from `date(last_ts) − 1 day` through
   yesterday. The last stored day is re-fetched **defensively**: it may have
   been partial or revised at the time of the previous run.
3. **The disk cache is bypassed entirely in incremental mode.** The cache is
   keyed on chunk-aligned URLs, so the chunk covering "the last few days"
   would otherwise be served stale. An incremental run makes only ~10 HTTP
   calls, so bypassing costs ~30 seconds, not minutes.
4. Merge new half-hourly rows onto the stored columns keyed on `t`
   (overlapping timestamps are overwritten by fresh values).
5. **Validation guard** (all must pass, otherwise exit non-zero and leave the
   published files untouched):
   - time axis strictly increasing, contiguous at 1800 s steps;
   - demand/price coverage over the merged window not lower than the previous
     build's coverage minus a small tolerance;
   - at least one new half-hour actually appended (else no-op exit 0).
6. Trim the head so the window stays **rolling 365 days** — keeps the payload
   bounded (~2.3 MB) and the front-end assumptions stable.
7. Recompute daily aggregates only for affected days (the re-fetched tail),
   drop trimmed head days, and re-run the monthly forward-fill (carbon, coal)
   over the full window — the single-call sources (gas SAP, UKA, Pink Sheet,
   BoE FX) are simply re-fetched each run; they are cheap.
8. **Atomic writes**: every output is written to `<name>.tmp` in the same
   directory then `os.replace()`d into place.

### Manifest — `app/data/manifest.json`

```json
{
  "schema": 1,
  "version": 42,
  "built_at": "2026-07-01T21:00:00+00:00",
  "mode": "incremental",
  "files": {
    "series_hh.json":    {"sha256": "…", "bytes": 2412345},
    "series_daily.json": {"sha256": "…", "bytes": 89012},
    "meta.json":         {"sha256": "…", "bytes": 5123}
  },
  "zones": ["GB"]
}
```

- `version` is a monotonically increasing integer (previous version + 1; starts
  at 1 when no manifest exists).
- `zones` future-proofs Milestone 4; only `"GB"` for now.

### Front end — `app/js/data.js`

- Fetch `data/manifest.json` with `{cache: "no-store"}` first.
- If found: fetch the three data files with `?v=<version>` appended, which
  makes browser caching safe and refresh deterministic.
- If the manifest fetch fails (older data folder): fall back to the current
  un-versioned fetch. No behaviour change for the original dashboard.

## Documentation

- `methodology.md`: "Refresh process" section rewritten; new judgement-call
  entry on the defensive last-day re-fetch and revision handling.
- `README.md`: "Next steps" items 1–2 marked done; incremental usage
  documented (`python etl/build_dataset.py --incremental`).

## Verification

1. Full build once (warm cache), then `--incremental` twice: first appends
   (or no-ops if data unchanged), second confirms idempotence; both exit 0.
2. Corrupt-input test: point incremental mode at a truncated series file →
   must fall back to full build, not crash.
3. Preview on port 8872: `manifest.json` requested with no-store, data files
   with `?v=`, all tabs render, no console errors.

## Status

Done. Verified 2026-07-01:

- incremental run: 4 s wall clock (vs 3–5 min full), exit 0, manifest v1;
- second run: correctly detected no upstream changes, wrote nothing,
  version unmoved;
- corrupt-input test: truncated `series_hh.json` → clean warning → automatic
  full rebuild → 17,520 contiguous rows, manifest bumped, sha256 verified;
- browser: manifest fetched no-store, data files fetched with `?v=3`, all
  tabs render, zero console errors.

Two deviations from the plan above, both deliberate:

1. **Axis gaps warn rather than hard-fail.** A missing upstream settlement
   period is Elexon's reality, not corruption; hard-failing would brick the
   nightly job on a data-quality event the dashboard is designed to display.
   Non-monotonic axes and coverage drops still refuse to publish.
2. **Daily aggregates are rebuilt in full from the merged half-hourly data**
   rather than per-affected-day. The in-memory rebuild costs milliseconds
   and reuses the full-build assembly code path unchanged — zero risk of the
   two modes drifting apart. The "incremental" saving is in HTTP calls.

Side benefit found in testing: the defensive tail re-fetch filled the
handful of half-hours the original build was missing (price/solar coverage
now exactly 1.0), and the head trim removed two stray half-hours from
30 June 2025 that full-build chunking lets in.

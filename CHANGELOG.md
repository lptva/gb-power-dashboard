# Changelog — gb-power-dashboard-2

Forked from `03_projects/gb-power-dashboard/` on 2026-07-01 (full copy,
including the ETL HTTP cache). The original folder is unchanged and remains
the stable reference version. All work below implements the README's
"Next steps to productionise" list; per-milestone design docs and outcomes
live in `plan/`.

## Built

### Scheduled refresh (`ops/`)
- `refresh.sh` (venv-aware, dated logs, non-zero exit on failure), a launchd
  plist for daily 07:00 local runs, and a one-command opt-in installer
  (`install_schedule.sh`). launchd chosen over cron because it runs missed
  jobs on laptop wake; cron alternative and sleep caveats documented in
  `ops/README.md`. **Not auto-installed** — run the installer yourself.

### Incremental ETL + versioned manifest (`etl/build_dataset.py`, `app/js/data.js`)
- `--incremental` re-fetches only the last two stored days plus anything
  newer (~10 HTTP calls, ~4 s measured, vs ~177 calls / 3–5 min full),
  bypassing the chunk-aligned disk cache that would serve a stale tail.
- Rolling 365-day window (head trimmed as tail grows); daily aggregates
  rebuilt from the merged half-hourly data through the unchanged full-build
  code path.
- Publication safety: atomic tmp+rename writes; a validation guard refuses
  to publish non-monotonic axes or a >2-percentage-point coverage drop; a
  no-change run writes nothing at all.
- `app/data/manifest.json`: monotonic `version`, per-file sha256/bytes,
  `mode`, `zones`. The app fetches it with `cache: "no-store"` and appends
  `?v=<version>` to data URLs; absent manifest falls back to the original
  un-versioned behaviour.
- Fallback: unreadable/missing existing dataset → automatic full rebuild
  (tested by truncating `series_hh.json`).

### Europe extension, token-ready (`etl/fetch_entsoe.py`, header zone switcher)
- Design in `plan/04-europe-extension.md`: per-zone files under
  `app/data/zones/<zone>/` (GB stays at legacy paths), starter EIC codes
  (FR, DE_LU, NL, BE, NO_2), honest ENTSO-E↔Elexon fuel-mapping table
  (no CCGT/OCGT split; wind coverage differs; zone-specific residual-load
  definitions).
- Fetcher normalises PT15M/PT30M/PT60M to the half-hourly schema, writes
  per-zone hh/daily/meta files, registers the zone in the manifest. Without
  `ENTSOE_TOKEN` it prints registration instructions and exits 0.
- Header zone `<select>` populated from `manifest.zones`; disabled while GB
  is the only zone; lazy-loads and safely reverts on a failed zone load.

### Plant-level merit order (`etl/investigate_bmu.py`, `etl/build_bmu_snapshot.py`)
- Investigation verdict **go** (83–89% of PN-notified MW joins to a registry
  fuel type; findings in `plan/05-plant-level-merit-order.md`), then built
  on user go-ahead:
- `build_bmu_snapshot.py` writes `app/data/bmu_snapshot.json` (~56 kB): the
  latest complete settlement period's per-unit physical notifications
  (time-weighted mean MW), joined to the BM Unit registry for fuel types and
  registered capacity, plus per-fuel BOALF acceptance counts. Excluding
  interconnector units lifts the classified share to ~95% of MW. Registered
  in the manifest; refreshed daily by `ops/refresh.sh` (non-fatal).
- New Merit-tab panel "Observed dispatch by unit (beta)": units grouped by
  technology in stack order and sorted by output — volumes badged
  **Observed**, tooltip SRMC cluster ranges badged **Estimated**, units
  without a registry fuel type shown as an explicit **Unclassified**
  category, charging/pumping and interconnector units excluded. PN is
  notified intent with no prices — the panel complements the modelled
  curve; it is not a bid stack (methodology judgement call 8).

### Visual redesign (2026-07-02) — CSS/presentation only, no data logic changed
- **"Implied merit order" panel removed** — fully subsumed by the merit-order
  curve (same SRMC ranges at tranche granularity, plus demand and clearing
  lines). The SRMC cost model itself is untouched; methodology retitled the
  section and records the removal.
- **Fixed per-fuel palette** (`Data.FUELS`, applied by every chart): nuclear
  violet (was yellow, clashing with solar), OCGT amber-orange (was
  near-CCGT red), oil darkened away from coal; aggregated net-imports series
  recoloured slate to stay clear of nuclear. Hardcoded per-panel colour
  literals replaced with palette references.
- **"At a glance" bar**: four large monospaced headline figures (price,
  clean spark spread, low-carbon share, net imports/exports) with quality
  dots — all values pulled from formulas already on the dashboard.
- **Tabular monospaced figures** for all numeric chart annotations (axis
  ticks, markLine labels, legends) and KPI values.
- **Muted quality badges**: desaturated outline chips per quality level in
  both themes, replacing the bright pills — legible but quieter than data.
- **Spacing audit**: uniform 14 px grid gaps and card margins, KPI cards
  compacted (120 px min-height, badge/label overlap fixed), legend
  breathing room on the generation stack.
- **Observed dispatch panel redesigned as a true dispatch curve**
  (EIA-convention): x = cumulative notified GW, y = technology-cluster SRMC
  midpoint, units sorted cheapest-first, same axes/markLines (demand − net
  imports; observed price) as the modelled merit-order curve so the two are
  directly comparable. Units with no SRMC benchmark (unclassified, PS, oil,
  other) are counted in a monospaced caption line but not plotted — their
  vertical position would be invented. Volumes remain badged Observed,
  cost attribution Estimated.

### KPI header + AI overnight summary (2026-07-02)
- **KPI card headers**: quality badge pinned to the top-right corner
  (identical position on every card); labels wrap freely with a
  first-line-only clearance spacer; two label lines are reserved so values
  align at the same height whether or not the label wraps.
- **Overnight summary panel** (below the KPI strip): renders
  `app/data/overnight_summary.json`, written by
  `ops/run_overnight_summary.sh`, which invokes the `dashboard-watcher`
  subagent headlessly (`claude --agent dashboard-watcher -p`, JSON output
  mode added to the agent definition; a human-readable
  `overnight_summary.md` is written alongside). Wired into `refresh.sh`
  after the ETL step, non-fatal, with a validation guard that refuses to
  publish non-JSON output. The panel is deliberately a different trust
  category from every data panel: dashed violet border, "✦ AI-generated"
  badge, an explicit interpretation-not-data footer, model strings
  HTML-escaped before injection, and a muted "not yet available" state when
  the file is absent.

### Europe extension live (2026-07-05)
- **Token integrated**: read from the environment or a project-root `.env`
  (stdlib parser, value never printed). The `.env` was found inside
  web-served `app/` — `GET /.env` returned HTTP 200 — and moved to the
  project root (404 verified). `.gitignore` (`.env`, `.env.*`,
  `!.env.example`) and `.env.example` in place; no git repository exists
  yet, so nothing was ever tracked.
- **Seven zones fetched** (30 days each, ~100% price coverage, grid-aligned
  and monotonic): FR, NL, BE, NO_2, DK_1, IE — GB's physical counterparty
  zones, one per cable — plus DE_LU as an explicitly labelled reference
  market (no GB cable). IE uses two current EICs for different area
  types (correction 2026-07-06 — the earlier "old control-area code"
  wording was wrong): ENTSO-E publishes day-ahead prices [12.1.D] against
  the SEM bidding-zone EIC and actual load [6.1.A] against the Ireland
  control-area EIC; generation [16.1.B&C] accepts either (verified
  empirically under both; official confirmation: ENTSO-E EDI WG, "EIC:
  Area codes analysis" v2.1, 20 Oct 2020, slide "IE: Ireland" p. 25 —
  10YIE-1001A00010 = member state/control area/scheduling area,
  10Y1001A1001A59C = bidding zone/market balance area (all-island SEM);
  eepublicdownloads.entsoe.eu/clean-documents/EDI/Library/Market_Areas_v2.1.pdf).
  Settlement currency read
  from each A44 response (EUR everywhere, NO_2 included). Off-grid
  quarter-hour timestamps from mixed-resolution publications are dropped
  with a logged count.
- **Zone switcher live**: brand mark follows the active zone, currency
  switches £/€ from zone meta, price series relabels MID → day-ahead,
  captions dual-sourced. Merit order, Spreads and Flows hide off-GB (no
  per-zone SRMC assumptions; no CCGT/OCGT split in ENTSO-E data; flows not
  fetched), as do the residual-load panels, the observed-dispatch panel and
  the AI overnight summary. Zones without a solar/wind type simply omit
  those cards.
- **Methodology tab is zone-aware**: per-zone ENTSO-E source block, the
  fuel-type mapping/mismatch table rendered in-app, and an explicit
  "what stays GB-only and why" section. GB's methodology is untouched when
  GB is selected.

### Zone polish + data-quality audit (2026-07-06)
- **CSV export zone-aware** (the defect was not a hardcoded path — the
  export already read the in-memory zone dataset): dynamic fuel-column
  list from what the zone actually reports, `price_<currency>_mwh` header
  from the zone's settlement currency, net-imports column only where
  interconnector data exists, `<zone>_market_…` filename.
- **Footer zone-aware**: GB keeps its original source list verbatim;
  ENTSO-E zones replace it with "Data: ENTSO-E Transparency Platform" plus
  the zone dataset's build timestamp.
- **A03 curve-type parser fix** (found while auditing IE "gaps"): under
  curveType A03 an omitted position legally carries the previous value to
  the period's declared END — IE solar publishes single points spanning
  days, which the parser previously wrote as one half-hour (1,377
  spuriously "missing" solar half-hours → 34 real ones after the fix).
  Remaining gaps are genuine TSO submission holes, verified against the
  raw XML (IE: ~1-hour inter-period holes from EirGrid/SONI; DK_1: one
  2.6-day all-series outage 13–16 Jun; NO_2: solar never reported —
  16.1.B&C is mandatory only above ~1% of national generation).
- **Per-zone `data_quality` notes** now computed at build time into each
  zone's meta.json (absent series get the threshold-exemption wording;
  gaps get counts and example date ranges) and rendered on the Methodology
  tab — labelled, never interpolated.
- **Git repository initialised** at the project root (first commit
  2f63860): `.env`, `data_raw/cache/` and `ops/logs/` verified untracked.
- **Same-day correction (wall-grid bucketing)**: applying the IE-style
  raw-XML audit to NO_2 exposed a second parser defect — periods starting
  off the half-hour grid (NO_2 PS at :15/:45) produced off-grid timestamps
  that the axis snap then *discarded*. The parser now buckets every point
  time-weighted onto the wall-clock half-hour grid (any period offset, any
  resolution), and an off-grid timestamp is a hard build failure instead of
  a silent drop. This retracts two "genuine TSO outage" claims from earlier
  today: NO_2's "805 missing PS half-hours" (data was present in the XML —
  now 1,440/1,488 populated) and most of DK_1's "2.6-day all-series
  outage" (now 1 missing half-hour per fuel column). NO_2 solar remains
  genuinely absent — confirmed at raw-XML level: no B16 TimeSeries in the
  A75 response. IE's inter-period gaps stand as genuine.

### IE constant-zero solar + hardcoded-label audit (2026-07-06, follow-up)
- **IE solar zeros were the TSO's own data, not a pipeline bug** — verified
  at every layer with cache bypassed: every B16 point EirGrid/SONI
  publishes (18 periods, production and consumption series alike) is
  exactly 0.0; the A03 fill faithfully expanded those zeros; `toCsv` writes
  null as empty string, never 0. SEM's ~1 GW of solar is
  distribution-connected and invisible to TSO metering, so the published
  series is a placeholder.
- **New data-quality class: "reported but constant zero"** — detected at
  build time (also caught NL hydro and BE nuclear; wording deliberately
  neutral between "genuinely idle fleet" and "unmetered-fleet placeholder").
  Constant-zero columns are excluded from KPI cards, the wind/solar chart
  and CSV exports — their zeros carry no information beyond the note — but
  raw values are retained in the data files, and the Methodology tab shows
  the note.
- **Hardcoded GB label audit**: "Solar (PV_Live)" / "Wind (transmission)" /
  "Demand (INDO)" now render only for GB ("Solar (ENTSO-E)",
  "Wind (ENTSO-E, on+offshore)", "Demand (ENTSO-E load)" elsewhere); the
  price-vs-net-load panel is hidden off-GB (its formula is the GB-specific
  INDO − transmission wind, matching the residual-load treatment).

### GB→zone context layer (2026-07-06)
- **Flows tab counterparty context card**: pick a cable (defaults to the
  largest current absolute flow) → its flow, GB MID price and the
  counterparty zone's day-ahead price on one chart, with the zone's
  generation mix stacked below and a tooltip tying flow + both prices +
  the zone's top fuels together. Remote prices convert at a new daily BoE
  EUR/GBP series (XUDLERS; direction asserted against the plausible
  EUR-per-GBP range at fetch time, verified live at 1.1673) and are badged
  Derived — day-ahead auction vs within-day MID is indicative, not a
  spread. Zone data loads lazily via `Data.loadZoneContext()` without
  touching the active GB dataset. Honesty guards: zone context is a
  rolling ~30 days so longer ranges clip to the overlap (stated in the
  panel meta line); the mix is zone-wide context, not electron
  attribution; gaps stay gaps; DE_LU (reference market, no cable) is never
  offered.
- **Import-aware low-carbon share** (GB Overview): a second dashed line
  attributing each importing cable at its counterparty zone's own
  low-carbon fraction per half-hour. First-order counterparty-mix
  attribution, not flow tracing; per-cable fallback to denominator-only
  where zone data is missing; exports excluded; no backfill beyond zone
  history. The headline KPI's definition and 365-day continuity are
  untouched — this is a second metric, not a splice.

### Zone history retention + UI polish (2026-07-06, follow-up)
- **Append-only zone retention**: `fetch_entsoe.py` now merges each fetch
  onto the published zone history instead of replacing it (fresh values win
  on overlap; a shorter-than-published or non-monotonic merge refuses to
  write; zone files now written atomically). Measured growth ~6 kB/day/zone
  → ~15 MB/yr across all seven zones (~77 MB in 5 yrs) — trivial;
  `--retain-days N` trims as a fallback if size ever matters. The daily
  refresh now includes a `--days 7` pass over all seven zones, so the
  import-aware low-carbon line and counterparty context deepen over time
  (verified: FR 1,488 → 1,728 rows with prior data retained). Captions and
  methodology rephrased from "rolling ~30 days" to accumulated history.
- **Counterparty cable selector** restyled to the header zone switcher's
  exact design language (shared CSS rules; computed styles verified
  identical across background, border, radius, font, padding and hover/
  focus states).
- **Low-carbon legend overlap fixed**: grid headroom raised to 58 px with
  legend padding; measured geometry — legend row 479 px wide (single row in
  a 629 px card), worst-case two-row height 40 px vs the "100" tick at
  58 px — no collision at any practical width.

### Overnight summary rework (2026-07-06, follow-up)
- **Per-tab analysis**: `overnight_summary.json` now carries one section per
  tab (`tabs.overview` / `merit_order` / `spreads` / `flows`) and each tab
  renders only its own — Overview, Prices and Generation share the general
  narrative; Merit order analyses the implied-clearing vs observed-price gap
  (`ops/merit_panel_figures.py` recomputes the panel's exact model — same
  ladder, tranches, rounding and capacity proxies as `metrics.js`, verified
  identical to the browser's values — and injects the figures into the
  prompt; the publisher rejects a summary whose figures deviate, so the LLM
  explains the gap but never computes it, covering gaps > ~15% via marginal
  technology, capacity binding, scarcity or known proxy limits); Spreads
  places spark/dark against their own history; Flows covers cable direction
  flips and import dependency. The card is hidden on the Methodology tab
  (it documents the dashboard, not the market).
- **Analysis over enumeration**: the `dashboard-watcher` system prompt now
  demands synthesis — at most two causally-explained findings per tab,
  correlated consecutive anomalies collapsed into one explained finding; the
  runner's validator refuses to publish more than two findings per tab or a
  missing `merit_order.figures` block (observed price, implied clearing,
  marginal technology, gap %).
- **Collapsed by default**: the panel shows badge, generated timestamp and a
  one-line takeaway; clicking (or Enter/Space — the head is a keyboard
  button) expands the full analysis, findings and data-quality flags.
  Expansion state is in-memory only, per the no-browser-storage rule.
- **Layout**: removed the 960 px `max-width` that made the first paragraph
  wrap narrower than the card; prose now uses the full container width like
  every other card body.

### Overnight summary guard scope + agent move (2026-07-06, follow-up)
- **Assumption vocabulary guard**: `merit_panel_figures.py` now injects the
  dashboard's documented reference assumptions (spark η 0.50 HHV, EF gas
  0.184 tCO2/MWh th, CCGT band 0.45–0.57, OCGT 0.32–0.40, dark η 0.36 band
  0.33–0.39, EF coal 0.34 — thermal basis stated) into the watcher prompt,
  and the publish validator rejects any efficiency or 0.xx-tCO2 intensity
  in the prose outside that closed set. Chosen over a standalone prose
  scanner because injection pins the allowed vocabulary first, making the
  check a 15-line regex instead of fragile NLP; unit-tested against the
  known-bad publish ("55% efficiency, 0.40 tCO2/MWh") — both values caught,
  zero false positives (carbon *prices* like £52.41/tCO2 pass).
- **dashboard-watcher.md moved into the repo** at
  `.claude/agents/dashboard-watcher.md` (was at the workspace root,
  untracked); resolved by `claude --agent` from the project root the runner
  cds into. Re-verified with a full production run after the move: publish
  succeeded, merit figures still exactly the panel's values, prose quotes
  only reference-set assumptions. Note: the agent is no longer discoverable
  by interactive sessions started at the workspace root.

### Unit tests for the two proven-bug guards (2026-07-06)
- `tests/` (stdlib `unittest`, no new dependency —
  `python3 -m unittest discover -s tests -v`, 17 tests).
- **Merit-figures parity**: three fixtures sliced from the real published
  dataset at three regimes (2026-07-05 22:30 CCGT-marginal +4.4% gap;
  2026-06-20 12:00 solar-glut with must-run Solar marginal; 2026-01-15
  17:00 winter peak, 36.69 GW target on a 42.07 GW curve, +39.8%);
  expected values are the app's own `metrics.js` functions executed on the
  same slices in a real browser — a cross-implementation oracle, not
  synthetic numbers. Building it immediately caught a real bug:
  `js_round()` used decimal half-away-from-zero where JS `toFixed` rounds
  the exact binary double ((11.225).toFixed(2) = "11.22"); fixed with
  `Decimal`-based exact-binary rounding, pinned by eight browser-verified
  probes.
- **Publish-gate tests**: the validator heredoc moved out of
  `run_overnight_summary.sh` into importable `ops/validate_overnight.py`
  (same checks, now unit-testable and shared with the pipeline); tests
  pin the assumption-vocabulary regex against the verbatim known-bad
  sentence ("55% efficiency, 0.40 tCO2/MWh" → both caught), nine
  legitimate sentence shapes (carbon prices, percentages of demand,
  percentiles, reference values — zero false positives), figure-mismatch
  rejection, findings cap, string-window rejection, prose-prefixed
  envelope slicing, and that the currently published summary still
  validates against the live panel recompute.

### Portability pass, from an external fresh-install review (2026-07-07)
Findings from a reviewer installing the project from scratch on his own
machine, worked through in priority order.

- **Portable paths (review item 1)**: README quick-start commands are now
  relative to the repository root (no `~/Documents/...` or username
  assumptions); `ops/refresh.sh` resolves Python instead of hardcoding a
  venv two directories above the repo (repo-local `.venv` → legacy
  workspace venv, kept so existing scheduled installs keep working →
  `python3` on PATH with a certifi check → clear error with venv
  instructions); the tracked launchd plist became
  `*.plist.template` with a `__PROJECT_ROOT__` token — launchd requires
  absolute paths, so `install_schedule.sh` now generates the
  machine-specific plist at install time (verified with `plutil -lint`);
  the ops README's cron example uses a placeholder path. `.venv/` added
  to `.gitignore` for the repo-local venv the installer will create.
- **Zero-experience setup guide (review item 2)**: `docs/SETUP.md`, linked
  from the README quick start — separate Mac and Windows tracks assuming
  no terminal or Python knowledge (ZIP download path, python.org installer
  with the PATH checkbox called out, every command with where-to-type-it
  and what-success-looks-like). Explicit `.venv/bin/python` /
  `.venv\Scripts\python` paths instead of venv activation: activation
  state silently vanishes when a novice reopens the terminal, and skipping
  `Activate.ps1` sidesteps Windows execution policy completely.
  Troubleshooting table covers the six realistic novice failures. The
  command sequence was verified end-to-end in a fresh clone with a fresh
  venv and nothing but certifi installed.
- **One-command installer (review item 3)**: `install.py` (both
  platforms) + double-clickable `install.bat` (Windows). Creates the
  repo-local venv, installs certifi, asks before the 3–5 minute data
  build, then serves and opens the browser; idempotent — re-running skips
  what's done, so it doubles as the "start the dashboard" command. Port
  8872 falls back automatically to the next free port. A missing-Python
  machine can't run install.py at all (the interpreter IS the missing
  piece), so the human-readable guidance for that case lives in
  install.bat (which tries the `py` launcher first — it works even when
  "Add to PATH" was missed) and in SETUP.md's warning box on the PATH
  checkbox, now a proper GitHub alert. No Homebrew bootstrap by decision:
  the python.org GUI installer is the simpler, more reliable novice path
  and keeps Mac and Windows on the same script. Verified in a fresh
  clone: fresh run (venv + deps + real 3-day build, exit 0), idempotent
  re-run, serve with port fallback (8872 busy → 8873, HTTP 200 on page
  and data), clean Ctrl+C. install.bat logic reviewed but not executed
  (no Windows machine here) — flagged for the next Windows tester.

## Skipped, with reasons

- **API layer (FastAPI + parquet/DuckDB)** — evaluated and deferred: one
  consumer and a 2.3 MB payload do not justify a server to operate. Explicit
  revisit triggers in `plan/03-api-layer.md`. Static JSON remains the
  interface.
- **Live ENTSO-E data** — blocked on the registration-gated (free) API
  token; everything up to the live fetch is in place and the no-token path
  degrades cleanly. Nothing was faked.
- **AuthN/AuthZ** — out of scope for this pass, as instructed.

## Differences from the original folder

- New: `ops/` (4 files), `plan/` (5 milestone docs), `CHANGELOG.md`,
  `etl/fetch_entsoe.py`, `etl/investigate_bmu.py`,
  `app/data/manifest.json`.
- Changed: `etl/build_dataset.py` (incremental mode, atomic writes,
  manifest, validation guard), `app/js/data.js` (manifest-driven
  cache-busting, zone-aware loading), `app/js/state.js` (`zone` field),
  `app/js/app.js` (zone switcher), `app/js/ui.js` (refresh-process
  methodology text), `app/index.html` (zone select), `methodology.md`
  (manifest schema section, judgement call 8 on the defensive tail
  re-fetch), `README.md` (quick-start paths/port for this copy; roadmap
  statuses).
- Data files regenerate on every refresh and now sit behind the manifest;
  the copy currently serves the same rolling window as the original, minus
  two stray half-hours from 30 June 2025 that the head-trim correctly
  removes (and with a handful of previously missing half-hours filled by
  the defensive re-fetch — price/solar coverage is now exactly 1.0).
- Serving: use port 8872 for this copy (`gb-power-dashboard-2-qa` launch
  config); the original stays on 8861/8871.

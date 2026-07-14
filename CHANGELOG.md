# Changelog — gb-power-dashboard-2

Forked from `03_projects/gb-power-dashboard/` on 2026-07-01 (full copy,
including the ETL HTTP cache). The original folder is unchanged and remains
the stable reference version. All work below implements the roadmap
formerly listed in the README as "Next steps to productionise" (removed
2026-07-07 — now tracked as GitHub Issues); per-milestone design docs and
outcomes live in `plan/`.

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
- **Ops to Python (review item 4)**: `ops/refresh.py` (stdlib-only
  orchestrator — same pipeline, dated logs and non-fatal semantics as the
  retired bash version) and `ops/run_overnight_summary.py` (imports
  `validate_overnight` directly, deleting the temp-file plumbing; gains a
  20-minute timeout so a hung CLI can never hang the scheduled refresh —
  a normal agentic run takes ~8 minutes). `refresh.sh` reduced to a
  back-compat shim for schedulers still pointing at it;
  `run_overnight_summary.sh` deleted with all references updated.
  Scheduling: launchd installer now also resolves an absolute interpreter
  and appends the claude CLI's directory to the agent's PATH (launchd's
  minimal PATH silently broke every scheduled summary regeneration —
  found in this morning's log, `claude CLI not found on PATH`); new
  `ops/install_schedule.ps1` registers the Windows Task Scheduler
  equivalent with StartWhenAvailable. **UNTESTED ON WINDOWS**:
  install_schedule.ps1 and install.bat are logic-reviewed only, pending
  a real Windows machine. Verified on macOS with a full real run through
  refresh.py (dataset v27 published, seven zones appended, BMU snapshot,
  dated log, exit 0) — during which the publish guard correctly refused a
  malformed agent reply (multiple JSON fragments) and left the previous
  summary in place, demonstrating the non-fatal path. The installed
  LaunchAgent was migrated (diff reviewed, backups kept:
  `*.pre-migration.bak`) to invoke refresh.py directly. One test fixed:
  the published-summary test no longer cross-checks live-recomputed
  figures — dataset refresh and summary regeneration legitimately drift
  apart between steps, which is a UI staleness concern (review item 7),
  not a validator one.
- **Stale overnight summary, root-caused and fixed end-to-end (review
  item 7)**: three independent causes found. (1) Every scheduled
  regeneration had failed since the feature shipped — 5 for 5 runs logged
  `claude CLI not found on PATH` under launchd's minimal PATH (fixed in
  item 4's plist PATH block). (2) `overnight_summary.json` was tracked in
  git, so a fresh clone showed the author's machine's last summary as if
  current — now untracked and git-ignored; fresh installs see the
  panel's not-enabled placeholder instead. (3) The agent occasionally
  returns structurally invalid replies (observed ~1 in 5: one prose
  prefix, one multi-fragment "Extra data" reply); the runner now retries
  once, persists every rejected raw reply to
  `ops/logs/overnight.rejected-*.txt` (the first incident was
  undiagnosable — only 200 chars survived), and logs per-attempt metrics
  (duration, turns, tokens, API-equivalent cost) to
  `ops/logs/overnight.metrics.log`. Measured on a real published run:
  18 turns, 12.5 min, 40,763 output tokens + 556k cached reads,
  **$1.20 API-equivalent per run** — the number review item 5's
  disclosure was waiting for. In the app, a summary older than 26 h now
  shows an amber "⚠ stale" flag in both collapsed and expanded states
  ("written for older data … the daily regeneration has not run since")
  — verified in-browser across fresh (no flag), 72-hour-aged (flag both
  states) and absent (placeholder) files.
- **Watcher re-architected: precompute, then write (review item 6)**:
  `ops/panel_facts.py` computes everything the summary needs outside the
  LLM — overnight-vs-baseline stats with z-scores and extreme timestamps,
  spark/dark levels + history percentiles + cost decomposition, per-cable
  means and direction flips, import dependency, merit figures (via
  merit_panel_figures, unchanged) and data-quality facts — with the
  dashboard's exact formulas, pinned by nine hand-calculated unit tests
  (suite now 26). The agent prompt injects the ~5.6 kB facts block; the
  agent doc now forbids recomputation and dataset reads; the validator
  additionally requires the window be copied verbatim from the facts.
  Measured same-day, same-model comparison: **18 turns → 1 turn, 12.5 →
  5.6 min, $1.20 → $0.36 API-equivalent (−70%)**. Quality held on
  causal-chain analysis (both designs independently converged on the same
  key values — dark spread p18, 13.5 GW solar peak, ~17% import
  dependency); the known loss is intra-window colour the facts don't
  carry (consecutive negative half-hour counts, within-window cable
  swing timelines) — recoverable by extending panel_facts if wanted.
  Model stays sonnet; a haiku-class swap is a further ~3× lever left as
  an explicit decision, not taken by default. Follow-up closed both
  flagged quality gaps: below-zero counters (total + longest consecutive
  run) per metric and per-cable window min/max with timestamps — verified
  against the tool-driven baseline's own findings (live data reproduces
  its "eight consecutive negative half-hours" as `below_zero_n: 8,
  longest: 8`, and INTVKL's −1,152 → +1,426 MW swing with times). The
  haiku comparison was explicitly declined: at $0.36/run the saving
  (~$0.25) does not justify the prose-quality risk.
- **AI subscription disclosure (review item 5)**: README section "The AI
  summary — optional, and the only thing that isn't free" directly after
  Quick start — core dashboard needs no subscription; the one exception
  is stated with **measured** figures backed by
  `ops/logs/overnight.metrics.log` ($0.36 API-equivalent per run,
  ~2× on the roughly 1-in-5 retry days, ~$11-equivalent ≈ £8–9/month,
  single 5–6 minute run inside the daily refresh). Panel decision:
  placeholder, not removal (a static site cannot detect the CLI, so
  removal would need a build flag); the not-enabled panel now shows a
  one-line honest note naming the CLI, the subscription and the usage
  cost, pointing at the README section — verified in-browser.
- **Favicon (review item 8)**: `app/favicon.svg` (the header's brand
  mark — accent-blue chip, white GB) plus a 1,150-byte hand-packed
  16×16 `favicon.ico` fallback (stdlib struct packing — the project has
  no image dependencies), linked from index.html. Both serve 200; the
  fresh-install reviewer's `/favicon.ico` 404 is gone.

### Roadmap removal follow-up: live documentation restored (2026-07-07)
- The roadmap deletion below over-reached: three pieces of it were live
  setup documentation, not roadmap, and are restored to permanent README
  homes. New "European zones (ENTSO-E)" section (token registration,
  `.env` at the project root — never under web-served `app/` — and the
  manual zone-refresh command); "Refresh process" now leads with
  `--incremental` (the daily command, previously only in the deleted
  roadmap item) and carries the Mac/Windows scheduler install
  one-liners plus what the daily job covers. API-layer deferral and
  AuthN/AuthZ stay deleted (decision record in `plan/03` and pure
  roadmap respectively).

### Roadmap moved out of the README (2026-07-07)
- **"Next steps to productionise" removed from README.md** — the roadmap
  now lives in GitHub Issues/Projects, where items carry status and can
  be closed individually; a static list duplicating that had already
  drifted into a status page. Before deletion the section was checked
  for permanent documentation: the zone-set inclusion logic (two
  inclusion rules, DE_LU as labelled reference market, currency read
  from A44, why Merit/Spreads/Flows stay GB-only, the IE dual-EIC
  quirk) was the one such passage and moved to methodology.md as
  "Zone set (Europe extension)" — plan/04 retains the fuller dated
  record with the official ENTSO-E citation. Cross-references updated
  (ops/README, this file's intro); the Known Limitations bullet that
  pointed at "the roadmap" was also stale in substance and now
  describes the shipped observed-dispatch panel correctly. AI-summary
  disclosure now leads with the sterling figure (~£8–9/month) for the
  UK audience, keeping the measured USD values as the metrics-log
  source of truth.

### AI summary made explicitly opt-in (2026-07-07)

- **`ENABLE_AI_SUMMARY` flag, default off** (`ops/env_flags.py`; read from
  the environment first, then the project-root `.env`, matching the
  `ENTSOE_TOKEN` convention). Previously the overnight summary ran
  whenever the claude CLI was found on PATH — so anyone who installed the
  scheduled refresh while having claude signed in for unrelated work was
  silently opted into daily token spend (~£8–9/month of their own
  allowance). Now consent is checked before capability: `ops/refresh.py`
  skips the step with an explanatory log line unless the flag is truthy,
  and `ops/run_overnight_summary.py` enforces the same gate first thing,
  so even a direct manual invocation refuses without the opt-in (one-off
  override: `ENABLE_AI_SUMMARY=true python3 ops/run_overnight_summary.py`).
  **Behaviour change for existing installs**: a machine that was relying
  on CLI-presence alone must add `ENABLE_AI_SUMMARY=true` to its `.env`
  or the summary stops regenerating (the panel's 26 h stale flag makes
  that visible rather than silent). Documented in the README disclosure
  section, `ops/README.md`, `.env.example` and the in-app placeholder;
  precedence and default pinned by `tests/test_env_flags.py` (10 tests —
  absent means off, environment beats `.env`, only explicit truthy
  values enable).

### Public-launch polish (2026-07-07)

- **Fresh-clone test failure fixed**: `test_current_published_summary_validates`
  read the machine-generated, deliberately untracked
  `app/data/overnight_summary.json` and errored with `FileNotFoundError`
  on any clean checkout (it only passed on machines with a locally
  published summary — found by running the suite in a fresh clone from
  GitHub). It now skips with an explanatory message when the file is
  absent, and still validates the published summary wherever one exists.
- **CI**: GitHub Actions workflow (`.github/workflows/tests.yml`) runs
  the full stdlib suite on every push to main and every pull request;
  badge added to the README header.
- **Data sources table caught up with the product**: added the Elexon
  PN/BOALF/BM-registry row (the observed-dispatch panel's inputs), the
  ENTSO-E Transparency Platform row (the seven European zones), and
  XUDLERS alongside XUDLUSS in the Bank of England row (EUR/GBP for
  counterparty price conversion). The AI-section claim "free and
  keyless" tightened to match (ENTSO-E's free token is registration-gated).
- **Doc accuracy sweep**: README Tests section now describes all four
  suites (was "two"); the Architecture block lists `manifest.json`,
  `bmu_snapshot.json` and `zones/<ZONE>/`; the case study's "seven tabs"
  parenthetical now names all seven (overview was missing).
- **README screenshots** (`docs/images/`): Overview as the hero image,
  Merit order full-width plus Prices/Flows side by side in a
  Screenshots section — real captures of live data (full-resolution
  2860 px exports, ~4.1 MB total, the repo's only binary docs).

### Dataset staleness indicator (2026-07-10)

- Header now shows "updated Xh ago" next to the data window, computed from
  `meta.built_at` at render time (`UI.renderDataAge`); turns amber with a
  "⚠ stale" prefix past 26 h — one missed daily 07:00 refresh — reusing the
  overnight card's threshold and colour. Deliberately a *freshness* signal,
  separate from the Observed/Estimated/Proxy/Assumption *provenance*
  badges. Re-rendered on zone switch (zone meta carries its own
  `built_at`) and on a one-minute in-memory timer so a long-open tab
  cannot keep claiming fresh data. No browser storage; no new data
  sources. Methodology refresh-process text updated to name both
  staleness signals.

### Interconnector utilisation ranking (#17, 2026-07-10)

- New Flows-tab panel ranking the ten cables by how often flow ran near a
  practical limit over the selected range, with the mean GB-vs-counterparty
  price differential over exactly those half-hours. GB publishes no
  per-cable limits and no flow-based shadow prices, so the working ceiling
  per direction is the highest flow sustained ≥2 h over the trailing 90
  days (Proxy — self-adjusts to de-ratings; a direction under 5% of
  nameplate reads as offline). The sustained rule replaced both simpler
  candidates after they failed on real data: a raw max is broken by
  isolated metering spikes (NSL prints 1,942 MW half-hours against a
  1,400 MW rating and a 1,398 MW p95 plateau — the spike zeroed NSL's
  utilisation count at 0.2% when the cable is in fact pegged ~55% of the
  time), and a 105%-of-nameplate cap clips genuine operation (BritNed
  sustains ~1,070 MW, 7% above its published rating, for hundreds of
  half-hours). Operator nameplate is kept as a cited reference column only
  (sources in methodology.md; constants in data.js). Near-capacity = |flow| ≥ 90% of
  the operational ceiling. Differential = GB MID − counterparty day-ahead
  £ at the daily BoE EUR/GBP rate, labelled indicative (different market
  segments) and bounded by the accumulated zone history (from 31 May 2026,
  stated in the caption). All ten cables carry a Δ: Moyle (landing in
  Northern Ireland), East-West and Greenlink share the all-island SEM
  day-ahead series, with each Δ averaged over that cable's own
  near-capacity half-hours — an earlier draft excluded Moyle's Δ on a
  "no counterparty price" premise that did not survive review (the SEM
  bidding zone covers NI). Pure
  client-side over existing JSON: `Metrics.cableUtilisation` (pure,
  returns near-capacity half-hour indices) + a `flowsUtilisation` table
  renderer; in-app methodology section (`m-utilisation`) + methodology.md
  formulas block + judgement call 10.
- View toggle: "Ranked" (near-capacity share, default) | "By market" —
  cables clustered per counterparty market with labelled group rows,
  groups ordered by each market's best near-capacity share, within-group
  order keeping the ranking. Presentation only (identical metrics); the
  `.seg` segmented control reused in-card per the "one component, two
  homes" convention; in-memory state per the no-browser-storage rule.

### Congestion-proxy flagging (#18, 2026-07-10)

- New "Congestion proxy %" column on the utilisation ranking: a half-hour
  counts only when BOTH conditions hold — flow at ≥90% of the cable's
  operational ceiling AND the GB−zone spread wide in the direction the
  flow earns (beyond the market's p75/p25 over the full accumulated zone
  window, minimum £5/MWh; thresholds fixed w.r.t. the view range and
  shared by cables landing in the same zone). Labelled "approximation —
  not a shadow price" in the column tooltip, per-row tooltip, caption,
  card blurb and methodology: GB has been outside SDAC since end-2020 and
  its cables allocate capacity via explicit day-ahead capacity auctions
  (the TCA's multi-region loose volume coupling unimplemented, verified
  2026-07-10), so no flow-based congestion rent exists to observe.
  Deliberately NOT flagged: wide spread with slack flow (outage /
  ramp-limit shaped) and at-ceiling flow against the price signal
  (emergency-action shaped, e.g. 23 Jun 2026). `Metrics.quantile` and
  `Metrics.congestionFlags` are pure and will be reused by the per-cable
  chart shading (#19). RAM decomposition (IVA/FRM/AAC/Fnrao) recorded as
  a permanent Known Limitation in the in-app methodology and
  methodology.md, per the milestone scope. Docs: m-utilisation bullet +
  methodology.md congestion block + judgement call 11.

### Per-cable chart overlays: ceilings, nameplate, congestion shading (#19, 2026-07-10)

- The Counterparty context flow chart now marks the selected cable's
  per-direction operational ceilings (dashed, cable colour, labelled
  "op. ceiling (import)" / "op. ceiling (export)" — the values are
  genuinely asymmetric per direction) and cited nameplate (dotted, dim,
  labelled on both sides), with the flow axis fixed to the design
  envelope (±1.05 × max(nameplate, ceilings)) so the design-vs-practice
  gap stays visible instead of being autoscaled away. Congestion-proxy
  half-hours — definitions identical to #18: at ceiling AND wide
  direction-consistent spread — are shaded amber via markArea, computed
  at half-hourly resolution regardless of display buckets; the axis
  tooltip appends "congestion proxy — approximation, not a shadow price"
  over shaded buckets and the caption counts shaded half-hours in view
  (or states that the proxy is unavailable when there is no zone price
  overlap). No new data sources. The zone-price-£ and spread-threshold
  logic was extracted into shared helpers (`zonePriceGbpAt`,
  `zoneSpreadThr`) used by both the utilisation table and this chart, so
  the two cannot diverge. Docs: counterparty card blurb, m-counterparty
  bullet, methodology.md counterparty block.
- Standard zoom added to the context pair: the flow chart carries the
  shared inside+slider `zoom()` config every other zoomable panel uses
  (grid deepened to fit the slider), the mix chart an inside zoom, kept
  in step through the existing "flows-context" chart group. The
  caption's congestion count recomputes from a `datazoom` listener so
  "in view" follows the zoomed window — a mechanism no other panel
  needed (their captions are static). Ceiling labels anchor at the
  chart's left end and nameplate labels at the right, so
  near-coincident lines can no longer overlay each other's labels at
  any zoom level.

### System stress anomaly detector (#22, 2026-07-11)

- `etl/fetch_stress.py` (plan/06 workstream B): daily observed stress
  metrics over the trailing year — 15 s frequency aggregates, LoLP /
  de-rated margin per 1/8/12 h horizon, settlement system prices, EMN
  counts — with four typed anomaly flags (`frequency`, `price`, `emn`,
  `adequacy`) computed at build time against point-in-time trailing
  baselines (p99, 60 s / 0.01 floors, ≥90 d history for percentile
  rules) and persisted, never recomputed retroactively. Outputs
  `stress_daily.json` (~125 kB, ≥400 d retention), `warnings.json`
  (EMNs + emergency instructions verbatim; publish stamps UTC, body
  times UK local by design), and a 15 s event slice under
  `events/<date>/` for every flagged day (D8 owner-revised at review:
  slices are lazy-fetched per view, so completeness costs disk, not
  page load — eager payload 153 kB against the 512 kB budget; 17
  slices ≈ 660 kB on disk). One-off `--backfill 365` ran gap-free on
  all three sources; the daily incremental append is wired into
  `ops/refresh.py` (non-fatal).
- Data gotcha found and filtered: the FREQ feed carries literal-0.0 Hz
  artefact samples (18 days in the backfill, worst 404 samples/day) —
  each would count as a fake excursion below both thresholds. Samples
  outside 45–55 Hz are treated as gaps; the per-day rejected count is
  stored. Signature to recognise it: `secs<49.8 == secs<49.5` with
  `freq_min = 0.000`.
- "System stress" tab (GB-only, gated like Merit/Spreads/Flows): daily
  strip chart (excursion bars + max-SSP line + amber flag markers,
  tooltip shows each flag's value against the exact threshold that
  fired; honours the global range presets), 15 s event viewer with
  operational/statutory bands (its day list follows the same range
  presets — presentation only, every flagged day keeps its slice; on a
  range change the selection survives if still in view, else falls
  back to the newest flagged day in range, else an empty state), and a
  verbatim warnings list (collapsed to the newest 5, in-memory expand
  toggle). Header gains an amber
  chip when the most recent day is flagged, naming the flag types —
  same convention as the staleness element, click-through to the tab.
  Panel copy states why the price series is SSP rather than MID: SSP
  settles the balancing actions the operator actually took — the
  realised cost of real-time scarcity — where MID measures traded
  sessions (both spiked on 23 Jun 2026: MID year-max £561, SSP
  year-max £800; the detector prices the balancing side). The
  warnings-feed composition stats moved to the methodology entry
  (not user-verifiable on the panel). Tooltips carry a display-only
  percentile context for max SSP / max LoLP / min DRM (`pctl`,
  computed in the ETL against the same point-in-time trailing window
  as the flags; stress-oriented, DRM inverted; "insufficient history"
  under 90 d; bands extreme / very high‑tight / high‑tight / regular /
  low‑loose at p99/95/90/50) — e.g. 23 Jun reads SSP p100 extreme,
  LoLP p98.6 very high, DRM p97.7 very tight. Caveat recorded: LoLP's
  zero-inflated distribution means any nonzero value ranks high —
  relative rank, not absolute severity; the 1% adequacy floor still
  decides flags. The tooltip renders as a fixed three-column monospace
  grid (metric | value | context, value and context right-aligned) so
  its width holds steady while hovering across days; and the first
  card leads with a deterministic latest-day digest line — the
  quiet-day complement to the header chip, unrelated to the AI
  overnight summary. Digest wording is operational, never a verdict:
  quiet days read "no flags fired" (no threshold crossed, not "all
  clear"), and a latest day with under 90 days of baseline says
  "baseline building" with the percentile flags inactive, rather than
  letting silence imply confidence. Chip and digest are deliberately
  range-independent (always the latest stored day); the daily chart
  and event-viewer list follow the 7D–1Y presets — an asymmetry by
  design, stated in the methodology so it is never mistaken for a
  range-selector bug.
- 18 unit tests (five evidence dates as fixtures incl. 8 Jan 2025 —
  live SYSWARN showed two same-day EMN issuances, so publish-date
  attribution fires all four flags there — plus rule mechanics and the
  artefact filter). Live retro-test outcomes recorded in plan/06:
  23 Jun 2026 fires frequency+price+emn exactly as designed; 8 Jan
  2026 fires adequacy+price (£434.85 was the year's 4th-highest SSP
  day — the design's "adequacy only" guess corrected); early-window
  frequency flags (21 Nov, 5 Jan) fire against thin point-in-time
  baselines, accepted as-is since every flag carries its threshold.

### Glossary tab + single-source term definitions (2026-07-12)

- `app/js/terms.js`: one map of ~34 plain-language term definitions —
  the single source of truth for the new Glossary tab and (next pass)
  for metric hover tooltips, so wording is never maintained twice.
  Each entry: one tooltip-ready sentence, optional glossary-only
  extra, a `gb: true` tag for GB-market-specific terms, a link to the
  formal Elexon BSC glossary definition where one exists (ten pages
  verified live 2026-07-12: SSP, LoLP, DRM forecast, MID, PN, BM
  Unit, NIV, Settlement Period, System Warning, Bid-Offer
  Acceptance — linked, never copied: BSC wording is code/legal
  language, ours deliberately is not), and a methodology anchor.
- "Glossary" nav tab, zone-neutral by design: the terms document the
  app, so the tab stays visible on non-GB zones; GB-specific entries
  carry a visible "GB market term" tag and the intro explains why
  they remain listed. Flat, alphabetical, one entry per term —
  Methodology explains how things are computed, the Glossary is the
  lookup; entries deep-link into the relevant methodology section and
  both methodology variants (GB + zone) open with a pointer back.

### methodology.md plain-language pass (2026-07-12)

- Sentence-level rewrite of the repo methodology doc: shorter, direct
  sentences; jargon-second phrasing; em-dashes cut back to where they
  earn their place. A language pass, not a content pass — every
  threshold, date, formula, source citation, quality label and caveat
  is unchanged (point-in-time baselines, thin-history warnings, the
  four-flag union, the ceiling failure modes, the congestion-proxy
  exclusions, the RAM limitation, judgement calls 1–12 all survive
  verbatim in substance). One factual fix folded in: the manifest
  paragraph claimed the zones list was "currently [GB]" — stale since
  the Europe extension; it now says GB plus any fetched ENTSO-E zones.
  Tables untouched. The in-app Methodology tab keeps its original
  denser style for now; aligning it is a scoped follow-up awaiting a
  go-ahead.
- Review round (2026-07-12): hard line-wrapping removed (paragraphs
  are single logical lines that reflow with the viewer); all internal
  planning-doc references dropped (D-number decision labels, plan/06
  and plan/04 pointers — meaningless to readers without the private
  plan docs; the substance stays, the history lives here instead);
  punctuation pass — em dashes to en dashes or commas (13 → 0),
  semicolons split into sentences (27 → 0), formula minus signs
  untouched; the two schema tables normalized to one compact style;
  and a "Price series scope: MID, not day-ahead" note added at the
  top with a forward pointer to the System stress section's
  deliberate SSP exception. Glossary review fixes same day: duplicate
  CSS block removed (its leaked margins caused the pill indent and
  the intro tag misalignment), definition text now fills the entry
  width (max-width dropped), and a sticky A–Z letter rail added,
  mirroring the methodology contents rail (instant jumps).

### Methodology layout, glossary polish, dev cache-buster (2026-07-12)

- Methodology tab layout (CSS + a post-render wrapper only — the text
  templates are untouched): each h3-headed topic now wraps into its own
  card-styled section with a bordered header, so topics separate
  visually instead of reading as one wall of text with bold pop-outs.
  A sticky mini-contents rail (18 entries on GB, 5 on zones — built
  from the headings at render time, so it can never drift) jumps
  instantly to any section; anchor targets land below the sticky
  topbar via scroll-margin. Works identically for the zone variant;
  collapses to one column under 980px.
- Glossary polish: A–Z letter dividers, each term in a subtle raised
  row with tighter typographic hierarchy, the "GB market term" tag as
  a small outline pill, and the Elexon / methodology links as pill
  buttons instead of bare inline links. terms.js copy got the same
  plain-language pass as methodology.md (wording only — every
  definition's facts unchanged; no Elexon re-fetch).
- Stress daily chart: the "min below 49.8 Hz" axis title was clipped
  by the 52px left gutter (ECharts centres axis names on the axis
  line); now anchored left so the full label reads over the chart's
  top band.
- DEV-CACHE-BUSTER (two clearly-marked blocks in index.html, dev only):
  `python -m http.server` sends no cache headers, so browsers
  heuristically cache the app's JS/CSS and serve stale code after
  edits — the recurring "the fix isn't on screen" gremlin. When served
  from localhost, a fresh `?v=` is appended to the app's own JS/CSS on
  every load; on any other host the emitted tags are byte-identical to
  the plain ones and normal HTTP caching applies. (A `<meta
  cache-control>` hint could not do this: it does not apply to
  subresources in modern browsers.) Review/strip before any hosted
  build — grep DEV-CACHE-BUSTER.

### Glossary + Methodology search (2026-07-12)

- Shared `.tab-search` box at the top of both tabs (matches the
  existing input language: raised bg, bordered, magnifier icon, ×
  clear button, Esc to clear). Client-side substring filter,
  case-insensitive, instant (no debounce — matching 34 terms / ~18
  sections is nanoseconds).
- Glossary: matches term title + full definition + extra text, so
  "loss" finds Loss of Load Probability and "cash-out" surfaces SSP
  (not in its title). Non-matching entries and their now-empty letter
  dividers hide; the A–Z rail greys (and disables) letters with no
  matches. Empty state when nothing matches.
- Methodology: matches the whole section (heading + body), so a term
  only mentioned in passing still surfaces its section (e.g. "spark"
  also finds the Overnight-summary section that references it).
  Non-matching section cards hide and the contents rail greys to the
  matching sections. Resets on zone switch so a new zone opens
  unfiltered. (Chosen over header-only matching for usefulness — say
  the word if you'd prefer headers-only, it's a one-line change.)
- Scroll behaviour: filtering shrinks page height. The sticky rails
  use CSS `position: sticky` and self-correct (never break). The
  browser natively clamps scrollTop so a shrink can't strand you in
  empty space. A small guard additionally brings the search box back
  into view if a deep-scrolled search would otherwise leave it above
  the fold; it no-ops during normal top-of-tab searching (gated on the
  box being scrolled off-screen), and runs synchronously rather than
  via requestAnimationFrame so it works in degraded renderers.

### Search refinements + back-to-top (2026-07-12)

- Empty-state fix: the "no results" message was a `<p>` below the grid,
  so it rendered ~400px under the tall greyed A–Z rail and off-screen
  (reported: nonsense search showed a greyed rail and no message). Moved
  into the content column so it appears beside the rail top. Message
  reworded to "Nothing found for "…"" on both tabs.
- Match highlighting: the matched substring is wrapped in
  `<mark class="search-hl">` wherever it appears — glossary titles and
  definitions, methodology headers and section bodies — in its original
  case (case-insensitive match). Implemented by walking text nodes, so
  tables/formulas/links are never corrupted; the link/label pills are
  skipped. Subtle blue accent highlight (rgba(78,161,255,.28)), never
  the default yellow `<mark>`. Clears and re-merges text on reset.
- Search input colour pinned to the cool UI grey (`--text`) with
  `-webkit-text-fill-color` and an autofill override so no warm
  webkit/UA fill can bleed through; placeholder set to `--text-dim`.
- Back to top: one global button, fixed bottom-right, card-styled
  circle with an up-arrow. Hidden until scrolled past ~500px, instant
  scroll-to-top on click (matching the rails). Bottom-right corner
  keeps it clear of the top search bar and the sticky rails; z-index 45
  sits above content, below the sticky topbar's 50. Scroll-driven, so
  it only appears on tabs long enough to scroll (Methodology, Glossary,
  System stress, the chart tabs) and never on short ones.

### Reference-tab polish (2026-07-12)

- Market KPI strip (glance + KPI cards) hidden on Glossary and
  Methodology — they are static reference tabs, and live metrics above
  them implied a time-sensitivity they don't have. Driven by the tab
  (REFERENCE_TABS in app.js); shown unchanged on every other tab.
- Search box colours pinned to exact requested values (confirmed with
  getComputedStyle): typed text, placeholder and webkit/autofill fill
  all `rgb(102,112,125)`. Note: that value has no dark-theme token (it
  is the light theme's `--text-dim`), so it is a documented literal.
- Search box fill aligned to the cards it sits among: `--bg-card`
  (`rgb(21,27,35)`), replacing the lighter `--bg-raised`. The border
  was already on the shared `--border` token (`rgb(35,44,56)`) — the
  `rgb(27,35,48)` seen earlier was the old fill, not a stray border
  value.
- Reference-tab intro cards fit their content: the card-head
  paragraph's 10px bottom margin was stacking on the card's 14px
  bottom padding (~25px of dead space under the text). Collapsed the
  paragraph margin and set padding-bottom to 12px, scoped to the two
  intro cards only — gap now ~13px on both.

### Sticky-rail + scroll-jump offset fix (2026-07-12)

- Both reference-tab rails (Glossary A–Z, Methodology TOC) were pinned
  with a hardcoded `top: 66px`, and jump targets used a hardcoded
  `scroll-margin-top: 76px`. The sticky topbar is actually taller and
  variable — its nav wraps to 2–3 rows at narrower widths and grows on
  font-load reflow (measured 143px at 1280px). So the rail pinned
  *under* the topbar (clipping the first entry) and rail/deep-link jumps
  landed with the target's header hidden behind it.
- Both offsets now derive from the topbar's measured height, published
  as `--topbar-h`: the rails pin at `calc(var(--topbar-h) + 8px)` and
  jump targets use `scroll-margin-top: calc(var(--topbar-h) + 12px)`.
  `--topbar-h` is set synchronously at init and kept current by a
  `ResizeObserver` on the topbar, `document.fonts.ready` (font-load
  reflow fires no resize event), and a window `resize` listener — so it
  tracks the topbar through wraps and font loads rather than guessing.
- Verified with a mid-list item on both tabs: the full rail is visible
  (first entry sits below the topbar, not clipped) and jumped-to card
  headers clear the topbar. The resize listener was confirmed to update
  the value to match a changed topbar height.

### Methodology jump-landing + rail parity (2026-07-12)

- Jumping to a Methodology section (TOC click, glossary "Methodology →"
  pill, or an ⓘ mark) landed the section card's top border flush under
  the sticky topbar: the `scroll-margin-top` was on the `<h3>`, which
  sits ~15px inside the card (its padding + border), so the card border
  cleared the topbar by 15px less than the heading did. Now all three
  jump paths scroll the `.method-section` card via one helper
  (`UI.jumpToMethodology`), and `.method-section` carries the same
  `scroll-margin-top: calc(var(--topbar-h) + 12px)` as `.gloss-letter`
  — so a section card lands at the identical 12px gap the Glossary
  letter dividers do.
- Rail parity: the TOC and A–Z rails already pinned at the identical
  `calc(var(--topbar-h) + 8px)` (verified 8px below the topbar on both);
  the only remaining difference was 2px more internal padding on the
  TOC rail, now unified to match — the two rails are pixel-identical
  (8px pin gap, 17px to first content). Any earlier "tighter" look was
  a transient pre-font-load `--topbar-h` state, closed by the layered
  triggers added with the sticky-offset fix.
- Follow-up: both rails now pin at `+12px` — the same N as the jump
  targets' scroll-margin — so the frozen rail's top edge aligns exactly
  with a jumped-to card's top edge (verified 155px == 155px on both
  tabs; previously the rail sat 4px higher than the card beside it).
  Back-to-top icon swapped from a stemmed arrow to an 18px chevron,
  matching the app's caret language (▾/▴ toggles), verified centred.

### Search-highlight spacing, the real fix (2026-07-12)

- Single-letter/mid-word searches visibly split words in glossary TERM
  TITLES ("Derived flags ( Syste m stress)"). Two stacked causes: the
  mark's 1px horizontal padding (fixed earlier — that one was real but
  only covered the plain-paragraph definition bodies), and the actual
  title culprit: `.gloss-term` is a flex container with `gap: 8px`, and
  when the highlighter splits the title's text around a <mark>, every
  fragment becomes its own (anonymous) flex item — so the flex gap
  rendered as fake 8px spaces mid-word. Fix: no gap on `.gloss-term`;
  the title↔pill spacing moved to the pill's own margin-left. Verified
  by raster: titles render intact with flush highlights, pill spacing
  unchanged.
- Post-mortem on the earlier false "verified": the check measured the
  flex CONTAINER's width, which spans the row regardless of content —
  it could never catch inter-item gaps. Lesson recorded: verify layout
  bugs at the fragment level (client rects / raster), not container
  boxes.
- Related filter-spacing fix: with a search active, stray space
  appeared above the first result group — the "A" divider's compact
  `:first-child` margin stopped applying once "A" was hidden, so the
  first VISIBLE divider kept the full 18px group margin. Replaced with
  a sibling rule (`.gloss-entry:not(.hidden) ~ .gloss-letter`): the
  compact 4px is now the base and only dividers with visible entries
  above them get 18px — filtered and unfiltered lists start at the
  identical 19px from the card top (verified both states + raster).

### In-app Methodology tab synced to methodology.md (2026-07-12)

- Both in-app methodology templates (GB + zone variants in ui.js) now
  carry methodology.md's approved plain-language register — ported, not
  reinvented; sections with no repo-doc counterpart (overnight summary,
  refresh process, known limitations, the UI-specific stress bullets)
  got the same style pass with substance intact. Punctuation now
  matches the doc: no em dashes or prose semicolons in the templates
  (the pre-existing pointer line and the stressFeedNote variable are
  the two deliberate carve-outs). Improvements folded in during the
  sync: nameplate reference values now render dynamically from
  `Data.INTERCONNECTORS` (cannot drift from the constants), the CCGT
  SRMC formula + η∈[0.45, 0.57] band and the 2 pp validation-guard
  detail are now stated in-app, and the zone variant gained the IE
  EIC-split paragraph.
- New: inline glossary term links in the methodology prose (28 across
  both variants, first mention per section) — dotted-underline
  `.term-link`s that jump to the Glossary entry, mirroring the
  glossary→methodology pills that already existed. Glossary entries
  gained the standard scroll-margin so the jump lands below the topbar.
- Execution was delegated (Sonnet) with orchestrator review: full
  constants audit passed (one verified figure — the 8 Jan 2025 LoLP
  0.294 example — was dropped as "uncorroborated" and restored in
  review; it is live-verified against Elexon). Rendered output
  spot-checked word-for-word against methodology.md; term-link
  click-through, zone variant, and console verified in-browser.
- Glossary highlight, structural fix: term titles now wrap their text
  in a `.gloss-term-name` span, so search marks split text in a normal
  inline context. Bare text fragments as anonymous flex items broke
  both ways — flex gap rendered fake mid-word spaces, no-gap swallowed
  real inter-word spaces ("BalancingMechanism"). With the span, the
  title's rendered width is byte-stable under highlighting, and the
  original flex gap (title↔pill) plus the intro tag's flush alignment
  both return.

### Refresh resilience + pipeline-skip guard (#32, 2026-07-13)

- Root cause 1 (silent partial refreshes): running `build_dataset.py`
  directly updates the core dataset only — the other four pipeline
  steps (BMU snapshot, stress metrics, zone data, AI summary) live
  exclusively in `ops/refresh.py` and were left silently stale
  (verified: a manual `--days 365` run left all four a day behind).
  Now `build_dataset.py` prints a standalone-run notice on stderr
  naming the four skipped steps and pointing at `ops/refresh.py`;
  the orchestrator suppresses it via a `GB_DASH_ORCHESTRATED` env
  handshake. The stale-tooltip advice in the header (which
  recommended exactly the standalone command) and the README's
  refresh section now lead with `python3 ops/refresh.py`.
- Root cause 2 (fragile schedule): the 07:00 launchd fire raced a
  not-yet-connected network on wake (2026-07-13: DNS failure at step
  1 killed all five steps, no retry, no visible signal). The core
  dataset step is now retried — 3 attempts, 2- then 5-minute waits —
  before it is fatal; the plist template gains a 09:00 fallback fire
  (existing installs: re-run `bash ops/install_schedule.sh`), with
  the paid AI-summary step gated to once per UTC day so the second
  fire never re-pays for it.
- Proactive failure surfacing: every run — success, fatal exit, or
  unexpected crash (a crashed run must never report ok; covered by a
  regression test) — atomically writes `app/data/refresh_status.json`
  (ts, outcome, failed_step, error, steps_completed, attempts). The
  header renders it as an amber chip next to the age badge — "⚠ last
  refresh attempt failed Nh ago (step)" with the error and recovery
  command in the tooltip — quiet on ok and on absent file, zone-
  neutral, distinct from the age badge (which cannot tell "no attempt
  yet" from "attempt failed").
- Diagnosability: a non-zero claude CLI exit in the overnight-summary
  runner now persists stdout+stderr to a timestamped
  `ops/logs/overnight.cli-error-*.txt` (the 2026-07-13 incident —
  exit 1 in under a second, empty stderr — was undiagnosable; the
  first real dump immediately identified it as a 401 expired CLI
  session).
- 16 new unit tests (retry backoff, status-file schema/atomicity,
  once-per-day gate, main()'s fatal and crash paths); suite 78 green.
  Execution was delegated (chunk A Opus, B/C/D Sonnet) with
  orchestrator review; one review fix (crash path wrote "ok") and one
  cosmetic tooltip fix applied on top.

<<<<<<< HEAD
### Per-tab CSV exports (#31, 2026-07-13)

- What was wrong: the ⤓ CSV button had two paths, not five. Overview,
  Prices and Generation correctly got the market file, but Flows and
  System stress silently exported that same generic market file instead
  of their own data, Merit order exported its cost-model *inputs*
  (gas SAP, UKA) rather than the plotted curve, and the button stayed
  live on the Glossary and Methodology reference tabs, where there is no
  data behind either view to export.
- What shipped: a `CSV_BUILDERS` registry keyed by tab (`app/js/ui.js`,
  falls back to the market builder for any unmapped tab) and five
  builders — `buildMarketCsv` (unchanged schema, now zone-aware and
  currency-labelled), `buildSpreadsCsv` (existing daily columns plus the
  conditional coal trio), `buildMeritCsv` (new
  `gb_merit_<date>.csv`, one row per plotted SRMC tranche, sourced from
  the same `Metrics.meritLadder` → `meritCurveSteps` path the chart uses),
  `buildFlowsCsv` (new `gb_flows_<from>_<to>_<res>.csv`, one signed MW
  column per cable) and `buildStressCsv` (new
  `gb_stress_<from>_<to>.csv`, the daily metric columns plus `emn_count`
  and a `+`-joined `flags` column). The merit builder now shares
  `Data.meritCapacityGw()` with the chart rather than recomputing the
  capacity proxy, so chart and export cannot drift apart. The export
  button is hidden on Glossary and Methodology. `Metrics.toCsv` does no
  comma-escaping, so every builder was audited to keep every column a
  number, ISO date/timestamp, boolean or fixed token set — merit's `note`
  field is dropped for exactly this reason.
- Two deliberate omissions, not oversights: the flows export carries no
  utilisation or congestion columns, because both are window-level views
  built from a rolling 90-day ceiling (see the Utilisation ranking and
  Congestion proxy sections), not a quantity the tab computes per row —
  methodology.md states the reproduction path (a 30-minute, trailing
  90-day export plus the documented rules) and the hard limit (the
  congestion proxy also needs the counterparty day-ahead series, which
  no export carries). The stress export carries no per-flag
  thresholds/values or the display-only `pctl` percentile context; it
  points at `stress_daily.json`, the source of truth, rather than
  duplicating it into every CSV.
- Docs: a new "CSV downloads" section in `methodology.md` (between
  Formulas and Zone set) and matching `m-csv` sections in both in-app
  Methodology templates (`app/js/ui.js`) — GB's between Refresh process
  and Known limitations, the zone variant's noting that only the market
  file exists off GB, since the GB-only tabs and files behind it are
  hidden for those zones.
=======
### Overnight summary: retry transient CLI errors (#35, 2026-07-14)

- Root cause: on 2026-07-14 the scheduled summary failed on a transient
  Anthropic API error (server drop mid-response, `terminal_reason:
  api_error`) and was never retried. `run_overnight_summary.py` retried
  only malformed replies (`ValidationError`); a non-zero CLI exit called
  `sys.exit` on the spot. The 09:00 fallback fire did not stand in for the
  missing retry: the Mac slept through the morning, so the 07:00 run was
  suspended and stretched across the 09:00 slot (finished 09:20 BST), and
  launchd had nothing to fire into — one attempt total, no second.
- Fix: a `cli_error_is_transient` classifier reads the CLI result envelope
  and retries once (45 s backoff) on a transient failure — a 5xx status,
  `terminal_reason: api_error`, or a known transient message (overloaded,
  timeout, server error mid-response). A permanent failure (401/403 auth,
  or anything unrecognised) still fails fast, so no paid attempt is spent
  on a request that cannot succeed. Mirrors the existing malformed-reply
  retry; a second failure still leaves the previous summary in place and
  exits non-zero for the orchestrator's WARNING line.
- Deliberately no scheduling change: a third fire or later fallback depends
  on the Mac being awake and does not fix the transient-error root cause.
  The `ops/README.md` sleep caveat now states the 09:00 fallback's real
  limitation (it cannot second-attempt a slow, sleep-suspended run).
- 12 new unit tests pin the classifier against the two real failure
  envelopes on disk (13 Jul 401 -> no retry, 14 Jul api_error -> retry)
  plus synthetic transient/permanent/unparseable cases; suite 90 green.
>>>>>>> 1f966f1 (bug fix: retry transient Claude API errors (#35) + updated screenshot)

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

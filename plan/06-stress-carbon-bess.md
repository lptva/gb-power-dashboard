# Milestone 6 — System stress, carbon intensity, BESS activity (issues #22–#24)

Design-first, per house convention (plan/05 precedent). Covers GitHub issues
#22, #23, #24. One doc for three workstreams: they share no code paths, but
they share one delivery branch, the same ETL/manifest/badge conventions, and
all are GB-only observability extensions — one milestone, independently
buildable workstreams, separate commits per workstream.

## Status

Design approved 2026-07-11 (decisions D1–D12 resolved by owner). Workstreams
B (#22) and C (#24) are cleared for build, in that order; workstream A (#23)
is **closed as no-build** with the rationale recorded below — issue #23 to be
closed.

Workstream B progress (2026-07-11): etl/fetch_stress.py built with the
365-day backfill run and verified (payloads 386 kB of the 512 kB budget);
flag rules live, with retro-test outcomes recorded under the flag-rules
section; 18 unit tests added (five evidence dates + rule mechanics + the
FREQ artefact filter). Pending owner review of the data before the UI tab,
header chip, and ops/refresh.py wiring are built.

---

## Workstream A — Carbon intensity indicator (issue #23) — CLOSED, no build

**Resolution (D1, 2026-07-11): no-go.** Neither the actual-only nor the
forecast-first variant is built. Rationale recorded here so it is not
re-investigated:

- **Actual-only is redundant.** The dashboard already carries a half-hourly
  low-carbon share (data.js:49 — biomass included, PV_Live embedded solar
  included). NESO's outturn intensity is driven by the same mix and would
  track that share almost perfectly (inverted), adding a familiar headline
  number rather than a new signal — while introducing a second,
  methodologically incompatible carbon metric (the Carbon Intensity API's mix
  taxonomy differs: embedded solar included, single "gas" category, imports
  as a fuel; verified live 2026-07-11).
- **Forecast-first was the only non-redundant variant** (NESO's ~48 h forward
  intensity — the only forward-looking official series available keyless),
  but it would require introducing a first-ever "Forecast" badge class — a
  taxonomy change to the four-class system that is not justified for a single
  metric.
- **Revisit trigger**: only if a forward-looking layer is ever wanted for
  multiple series, making a Forecast badge class worth designing in its own
  right.

**Badging precedent worth keeping** (from this investigation): PV_Live solar
is badged Observed because it is a published estimate of a physically real,
in-principle-measurable quantity (national solar output). Carbon intensity is
different in kind — mix × assumed emission factors, with no physical ground
truth; different factor sets legitimately publish different "actuals" for the
same hours. Rule of thumb for future sources: published estimate of a
measurable quantity → Observed; published calculated construct → Estimated.

---

## Workstream B — System stress anomaly detector (issue #22) — approved

### Scope

Two parts as filed: (1) a daily metrics pipeline (stress_daily.json,
warnings.json, curated event slices, <0.5 MB total budget); (2) deterministic
threshold-based anomaly flagging. Out of scope per the issue's own text: any
claim about causation, governance, or intent — panel and methodology copy
stay strictly operational-metrics-only.

### Evidence behind the flag design

An earlier draft excluded LoLP/DRM as flag inputs, generalising from one
event (23 Jun 2026, max LoLP 0.0017). Pressure-testing across events showed
that was wrong:

| date       | event type                | max LoLP (best horizon) | min DRM  | max SSP | EMN | freq excursions |
|------------|---------------------------|-------------------------|----------|---------|-----|-----------------|
| 2025-01-08 | margin near-miss          | **0.294** (8h, SP35)    | 510 MW   | £2,900  | yes | 615 s           |
| 2026-01-08 | adequacy squeeze, managed | **0.036** (8h)          | 1,967 MW | £435    | no  | 0 s             |
| 2025-11-21 | tightest DRM of window    | 0.0075                  | 2,979 MW | £247    | no  | not sampled     |
| 2026-01-05 | price spike               | 0.0025                  | 3,790 MW | £750    | no  | 225 s           |
| 2026-06-23 | delivery/forecast-error   | 0.0017                  | 4,111 MW | £800    | yes | 2,895 s         |

(8 Jan 2025 verified live from the Elexon API 2026-07-11; other rows from the
Phase A investigation's full-year daily scan. Window distributions: p99 of
daily-max LoLP(8h) = 0.0019, window max 0.036; no window day reached 0.05,
against 0.294 on the true near-miss.)

Reading: **LoLP/DRM are leading indicators for margin-driven events;
frequency/SSP/EMN are outcome indicators for delivery-driven events.** The
families are complementary — 8 Jan 2026 is flagged only by adequacy metrics;
23 Jun 2026 only by outcome metrics. A stress detector needs both. LoLP did
not foresee 23 Jun because that event was a demand-forecast error inside
otherwise healthy margins — a documented property of the metric, stated in
the methodology entry.

### Verified endpoint traps the fetcher must carry

- Elexon `/datasets/FREQ` silently ignores unknown params (returns latest
  ~5 h with HTTP 200) → range assertion on returned timestamps is mandatory;
  ~1 day per call.
- The FREQ feed also carries literal-0.0 Hz artefact samples (found on 18
  days of the 2025-26 backfill, worst 404 samples in one day) — without a
  plausibility band each counts as a giant fake excursion below both
  thresholds. Samples outside 45-55 Hz are treated as gaps, never readings
  (GB has never left 48.8-50.5 in the modern record).
- SYSWARN notice **bodies** are UK local time; **publish stamps** are UTC —
  never mix.
- NESO CKAN: exact `filters={...}`, never fuzzy `q=` (matches any column).
- LoLP/SSP are gap-free over 365 d, and LoLP history serves back to at least
  Jan 2025 (verified live) — the adequacy flag is backfillable.
- Reusable, already-verified row-builders from the Phase A investigation:
  `freq_day_stats` (min/max/excursion seconds at 15 s per sample),
  `excursion_episodes` (contiguous below-threshold runs).

### Design

- New `etl/fetch_stress.py` (imports http/caching from build_dataset, like
  fetch_entsoe) → app/data/:
  - `stress_daily.json` (~40 kB): per day — freq min/max; seconds below
    49.8 Hz / above 50.2 Hz / below 49.5 Hz; max LoLP per horizon (1/8/12 h);
    min DRM per horizon; max/min SSP; EMN count; `flags[]` (typed, below).
    Append-only, keep ≥400 days — trailing-year percentiles need a year;
    retention is independent of the GB core dataset's rolling trim.
  - `warnings.json` (~100 kB): SYSWARN filtered to EMNs + emergency
    instructions + per-category counts (full-year raw SYSWARN ≈ 400 kB;
    filtering keeps budget).
  - `events/<slug>/freq.json`: 15 s slices for qualifying flagged days
    (rule below).
  - Total payload budget < 0.5 MB. Manifest entries + version bump via the
    same self-update pattern as build_bmu_snapshot.py:178-186.
- **Flag rules (resolved D4/D5) — four typed families, union; `flags[]`
  records which fired and the UI shows the type:**
  1. FREQUENCY: excursion seconds below 49.8 Hz ≥ max(trailing-365d p99,
     60 s floor) — the floor guards the degenerate percentile (most days
     are 0 s).
  2. PRICE: daily max SSP ≥ trailing-365d p99 of daily-max SSP.
  3. EMN: ≥1 Electricity Margin Notice issued that day (observed fact).
  4. ADEQUACY: daily max LoLP (any horizon) ≥ max(trailing-365d p99, **0.01
     floor**) — the floor targets true near-misses (8 Jan 2025 class, ≈1
     day/yr) rather than routine winter tightness. DRM is stored for context
     but is not a flag trigger.
  Flags are computed in the ETL and shipped in the JSON — deterministic, no
  client-side statistics. The five table dates are unit-test fixtures.

  **Live retro-test outcomes (365-day backfill, 2026-07-11)** — the approved
  rules run on real data:
  - 23 Jun 2026 fires FREQUENCY+PRICE+EMN as expected (2,895 s vs threshold
    415.5 s; £800 vs £356.87; every metric matches Phase A to the digit).
  - 8 Jan 2026 fires ADEQUACY **and PRICE** — the design guessed "adequacy
    only", but £434.85 was legitimately the 4th-highest SSP day of the year
    (trailing p99 £355.96). Adequacy fired via the 0.01 floor, not the
    percentile term (trailing LoLP p99 sat below the floor).
  - 8 Jan 2025 is outside the window; fixture-verified — and live SYSWARN
    shows two EMN issuances published on the day itself, so publish-date
    attribution fires all four on that day's data too.
  - Calibration note, historical window only: 21 Nov 2025 (240 s) and
    5 Jan 2026 (225 s — by 8 seconds) fire FREQUENCY against thin
    point-in-time baselines (133 / 178 days of history in the backfill's
    early months); a full-year baseline puts the same threshold at
    ~400-500 s. Every day from launch forward is judged against a full
    365-day window, so the effect is confined to the backfill's first ~6
    months and scrolls out with retention. Accepted as-is — flags carry
    value + threshold, so the surface shows the context. (The alternative,
    raising min-baseline from 90 to 180 days, would also silence the
    Oct-2025 price cluster; not taken.)
  - Whole-window yield: 17 flagged days of 365 (8 frequency, 7 price,
    6 EMN, 1 adequacy; some days multi-flag) — a sensible "notable
    days" rate.
- **Backfill (resolved D6)**: one-off 365-day FREQ/LoLP/SSP backfill (~365
  FREQ calls, one evening run, ~150 MB local cache), then daily append.
  Ran 2026-07-11: gap-free on all three sources. Actual payloads:
  stress_daily.json 125 kB (the ~40 kB estimate predated per-horizon
  fields and flag detail), warnings.json 27 kB, six event slices 234 kB —
  total 386 kB against the 512 kB budget.
- **Event slices (resolved D8; owner-revised 2026-07-11 after review)**:
  auto-generated for **every flagged day**, any flag type, no recency cap.
  Original D8 (EMN/frequency only, 6 most recent) was superseded once the
  cost was scoped: slices are lazy-fetched per view, so lifting the cap
  changes on-disk size only (~40 kB per flagged day; 17 days ≈ 680 kB),
  never the eager page payload — the <0.5 MB budget is restated as
  applying to the eagerly-fetched files (stress_daily + warnings,
  ~152 kB). The viewer's day list additionally follows the global range
  presets — presentation only; slice generation stays range-independent,
  so no cap logic returns through the back door.
- **UI (resolved D7)**: new GB-only "System stress" tab (nav button + panel +
  renderTab case + GB_ONLY_TABS entry, app.js:67): daily strip chart
  (excursion-seconds bars + max-SSP line + adequacy markers, flagged days
  amber), warnings timeline, per-event 15 s frequency viewer. Plus a small
  amber chip in the header next to the staleness element when the latest day
  is flagged, chip text naming the flag type(s) — reusing the #16 visual
  pattern (.data-age.stale, style.css:76).
- ops/refresh.py: one new non-fatal step after the BMU snapshot.

### Design-principle notes

- No fabricated data ✓ — every stored figure is observed; flags are
  deterministic arithmetic over observed metrics. Metrics badged Observed;
  the flag itself labelled "derived from observed — rule stated in the
  caption" (congestion-proxy convention).
- Keyless ✓ (Elexon Insights + NESO CKAN). No browser storage ✓.
- Neutral operational framing; no causation/governance claims.

### Resolved decisions

D4 outcome thresholds = frequency p99 + 60 s floor, SSP p99 · D5 adequacy
floor = 0.01, DRM not a trigger · D6 = 365-day one-off backfill · D7 = tab +
header chip · D8 = slice every flagged day, no cap (owner-revised
2026-07-11; originally EMN/FREQUENCY-only capped at 6 — see the event-
slices bullet for the cost scoping that motivated the revision).

---

## Workstream C — BESS observable activity tracker (issue #24) — approved

### Market question

**How actively does NESO dispatch the GB battery fleet in the Balancing
Mechanism, relative to installed capacity** — dispatch MWh and cycling
against a nameplate denominator.

Why not the alternatives: "how much BESS capacity exists" is a
quarterly-static figure answerable by one cited REPD number — no pipeline
needed, and it arrives for free as this panel's denominator/context line;
revenue stacking and state-of-charge remain excluded (no public data —
simulating would violate no-fabricated-data). The chosen question aligns with
the dashboard's dispatch/merit identity, runs on live keyless Elexon data,
and its commercial equivalent (Modo's indices) is paywalled — genuinely novel
free content.

### Premise corrections vs the issue text

1. **No battery fuel type exists** in the Elexon registry (3,025 units:
   battery-named units carry fuelType OTHER ×17 / null ×14 of 31
   name-matched; no BATTERY code, no psrType field). "Extend the fuel-type
   filter" cannot work as written — identification is the core design
   problem, not a co-located-site edge case.
2. **The pipeline precedent is partial**: build_bmu_snapshot.py uses PN
   levels plus BOALF only as per-fuel acceptance counts (lines 102-109);
   per-unit BOALF aggregation with history is new code. Reusable: the
   registry join (fetch_registry, line 59), the BOALF /stream endpoint
   pattern with UTC from/to, and the documented 6.3 MB/day size constraint
   (aggregate in the ETL, ship small JSON).

### Identification (resolved D9/D10) — investigated 2026-07-11

Constraint (owner): a manually curated unit list is not sustainable and is
ruled out. Sources investigated:

- **Modo Energy methodology** (modoenergy.com/methodology/gb): no public
  constituent list; units matched manually on their side from mixed sources;
  indices and methodology proprietary. **Ruled out** as a citable mapping.
- **REPD Q1 2026** (gov.uk, OGL v3.0, quarterly): verified from the extract —
  **171 operational battery sites, 4,755 MW** (plus 112 under construction).
  Site-level only, no BMU ids → the **denominator and audit baseline**, not
  the identification mechanism.
- **Capacity Market Register** (NESO CKAN, keyless): clean battery
  classification (Primary Fuel "Storage - Battery", duration classes such as
  "Storage (Duration 4h)") but **no BMU field** in the current published
  schema — 830 unique battery CMU ids matched 0 ids in the Elexon registry.
  Possible future cited duration-class context; not the join.
- **Structural signature (adopted)**: batteries register near-symmetric
  generation and demand capacity on the same BMU (they charge and discharge
  through it). Filter: gen > 0, dem < 0, |dem|/gen ∈ [0.5, 1.5], fuelType ∈
  {null, OTHER}, non-interconnector. Tested against the cached registry:
  catches **29 of 31** name-matched battery units (recall ≈94% on the
  labelled subset); raw candidate set 231 units / 10.0 GW, inflated by
  supplier/aggregator units.

**Adopted mechanism (D9)**: structural signature ∪ name-pattern,
auto-recomputed from the registry on every refresh (zero manual maintenance),
with a Phase A precision pass and coverage disclosed in the panel caption as
% of the REPD denominator ("identified BM fleet: N units, X MW ≈ Y% of GB
operational BESS, REPD Q1 2026").

**Fleet boundary (D10)**: physical units only (E_/T_/V_ types) for v1;
supplier/aggregator (2__/S-type) VLP portfolios are excluded — they mix
batteries with DSR and would muddy the denominator. A VLP/aggregator activity
layer could be a future separate issue if wanted.

### Design — two-phase, investigation-first (plan/05 convention)

**Phase A — investigation (go/no-go gates before the panel is built):**
- Precision pass on the signature within the physical-unit boundary;
  cross-check candidates for actual two-sided operation in PN/B1610 over a
  sample week.
- Probe **B1610** (metered per-unit output) vs BOALF instructed volumes as
  the primary activity series — metered is truer (delivered, not instructed)
  if it covers battery units. Resolved inside this gate: if B1610 coverage is
  good, it becomes the activity series and BOALF keeps the cycling counts.
- Confirm signed handling end-to-end (charging = negative; the current
  snapshot renderer drops negative-MW units — this panel must not).
- Gates: identified fleet ≥ threshold % of REPD MW (set at kickoff); payload
  within budget.

**Phase B — build (shape, subject to Phase A):**
- New `etl/build_bess_activity.py` → `app/data/bess_activity.json`: per-HH
  fleet accepted offer/bid MWh (signed, time-weighted integration as in
  fetch_pn), per-day per-unit acceptance counts (cycling proxy),
  identified-fleet registry capacity + REPD context figure. Append-only
  retention; **30-day one-off BOALF backfill then daily append (D11)**;
  manifest self-update; non-fatal refresh.py step.
- **UI (D12)**: card on the Merit tab, beta label, alongside the
  observed-dispatch panel: signed fleet activity chart + caption (units
  identified / MW / method / coverage vs REPD). Utilisation uses **matched
  denominators** — activity of identified units ÷ registry capacity of the
  same units; the REPD total is context, never the divisor.
- Badges: volumes Observed; nameplate/REPD figures as cited reference data
  (prose treatment, not a badge class). No meritLadder row for batteries —
  SRMC is ill-defined for storage (arbitrage/opportunity cost, not fuel
  cost); a Data.FUELS display entry (label/colour only) is a build-time
  detail.

### Design-principle notes

- No fabricated data: identification is deterministic and disclosed (rule +
  measured coverage), not asserted; misidentification risk is handled by the
  Phase A precision pass and the published coverage figure, not by claiming
  completeness.
- Keyless ✓ (Elexon + gov.uk OGL + NESO CKAN). One-zone-at-a-time unaffected
  (GB-only; Merit tab already gated). No browser storage ✓.
- Out of scope recorded: revenue/arbitrage P&L, state-of-charge, FFR/DC
  volumes (future spike), VLP/aggregator layer (future separate issue).

### Resolved decisions

D9 = structural signature ∪ name-pattern with REPD-audited coverage ·
D10 = physical units (E_/T_/V_) only, VLPs excluded · D11 = 30-day one-off
BOALF backfill then daily append · D12 = Merit-tab card, beta label.

---

## Cross-cutting

- **Numbering**: this doc takes plan/06 (highest existing is 05) and subsumes
  the previously drafted Phase B stress scope.
- **Sequencing**: B (#22) → C (#24); A (#23) closed. Separate commits per
  workstream on feature/issues-22-24.
- **Both builds are GB-only** (GB_ONLY_TABS for the stress tab; Merit tab
  already gated).
- **Payloads**: stress < 0.5 MB hard budget; BESS ≈ 0.1–0.2 MB. app/data
  stays fully gitignored.
- **Tests** (stdlib unittest, house rule): flag-rule fixtures from the five
  evidence dates incl. the degenerate-percentile case (#22); signed MWh
  integration + signature-identification fixtures (#24).
- **Recorded out-of-scope** (do not re-investigate without new data): carbon
  intensity in any variant (closed above, with revisit trigger); the CM
  register as a BMU mapping (no BMU field — verified 2026-07-11); Modo as a
  citable source (proprietary); flow-traced carbon attribution; battery
  revenue/SoC/FFR; causation/governance claims; RAM decomposition (already in
  methodology Known Limitations).

## Verification (per workstream, before its PR)

Run the new ETL against live APIs; check output sizes against budget; run the
unittest suite incl. the five-date flag fixtures; serve on the 8872 QA port
and verify panels via accessibility tree + getOption dumps (house rule:
screenshots unreliable in this project); confirm manifest version bump and
cache-bust; confirm non-GB zones hide the new surfaces.

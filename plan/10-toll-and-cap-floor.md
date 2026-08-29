# 10 — Battery toll calculator and LDES cap-and-floor module

**Status: D54–D57 signed off by the owner 2026-08-28. D58–D72 recorded below. Phase 1 (Feature A, toll + financing block) implemented across all five mirrored surfaces. Phase 2 (B1, Window 1 reference card) implemented 2026-08-29: data layer (`etl/build_ldes_capfloor.py` → `app/data/ldes_capfloor.json`, manifest + refresh + tests) and UI layer (card, glossary, methodology). Same day, two owner requests: the calculator's input groups are collapsible (D71) and the reference card moved to its own LDES tab (D72, superseding D56's placement). Phase 3 not started (blocked on the CFFM Handbook read, work item 3.0).**
Drafted 28 Aug 2026 from a full read of the source base below.

---

## Why

Two adjacent features, one theme: what a fixed revenue layer does to battery economics.

- **A toll calculator** answers the private-market version: a trader pays a fixed £/kW/yr for the rights to operate the asset; contracted cash flow unlocks debt; debt levers equity returns. Big GB theme since 2024. Needs no new data — the toll is a user assumption laid over the calculator's existing observed merchant anchor.
- **A cap-and-floor module** answers the regulated version: Ofgem's LDES Window 1 regime guarantees a revenue floor (debt-level return) in exchange for a soft cap (equity-level return, 30 % retained above it). Minded-to list published 26 Jun 2026; final awards due autumn 2026 — a timely reference card, and greenfield in this repo (zero existing mentions of cap and floor or LDES).

Client-question framing the module should answer: *"Where will Ofgem set my floor?"* · *"What's my dispatch behaviour under a floor?"* · *"Does the cap kill my upside case?"*

## Source base (all read 28 Aug 2026)

| Source | What it gave us |
|---|---|
| Modo Energy, *How tolling agreements unlock leverage for German batteries* (2025 DE data, ~90 % readable) | Toll model structure: inputs {tolled share, toll price, gearing} → levered equity returns. Calibration anchors: DE 2-hr merchant €85k/MW/yr (GB ≈ €46k, "85 % above GB"); toll deals fix 70–100 % of capacity, tenor 5–10 yr; mini-perm debt (7-yr maturity, ≥60 % amortised, 40 % balloon, amortisation notionally over warranty life 15–20 yr); debt cost 4–6 %, equity hurdle 12–18 %; lender downside case €65k/MW/yr; IRR-vs-tolled-share curves flip sign at toll ≈ 110–115 % of expected merchant revenue and flatten above 80–90 % share where debt capacity binds |
| Ofgem *Financial Framework* decision (23 Sep 2025) | The building blocks. Floor return: iBoxx GBP Non-Financials 15+ BBB, 20-day pre-FID average, indicative **4.47 % CPIH-real**; ACOD floor option for project finance. Cap return: CAPM (beta 1.125, RFR 2.26 %, TMR 6.9 %) → indicative **7.48 % CPIH-real**. Both applied to 100 % of RAV (devex + capex + repex + decommex + IDC + transaction costs). Fixed opex is a separate allowance; non-controllable opex pass-through; marginal cycling costs netted off Assessed Revenue (gross-margin comparison). **Soft cap: project retains 30 % above the cap.** Floor conditional on a Minimum Availability Target (MAT), clawback if missed. Funding via BSUoS, NESO intermediary. Default 25-yr regime (min 20, biddable), zero residual value (biddable), CPIH-indexed levels. Overruns to RAV up to submitted P90 (= Project Cost Ceiling). IDC indicative 6.03–6.11 %; gearing cap 80 % |
| Ofgem *minded-to decisions* (26 Jun 2026) + Q&A appendix (31 Jul 2026) | **16 of 73 eligible projects, 7,645 MW, ~136.9 GWh, durations 8–32 h** (Loch Kemp 660 MW/22.3 h, Coire Glas 1,440 MW/32 h, Earba 1,800 MW/15 h, TeesCAES 50 MW/30 h, six Field Li-ion 16–18 h, five 8–12 h Li-ion, Frontier Legacy VFB/Zn 65 MW/8 h). FA score = lifetime revenue ÷ project floor; **0.60 demotion threshold** disclosed; per-project £ floor/cap levels withheld as commercially sensitive. EA weights: BCR 40 %, SoS 19 %, ARC 15 %, SO 12 %, WESI 8 %, RTF 4 %, OV 1 %. Kincardine (rank 13) excluded on diversity; Frontier Legacy included on diversity despite Below-threshold FA. Final awards autumn 2026; Window 2 consultation in 2026, position confirmed by 2027 |
| Cost Assessment guidance + MCA Framework (23 Sep 2025) | £2024-real CPI-H cost base; P10/P50/P90 scenarios, P90 = cost ceiling; four-part revenue assessment (arbitrage initial commitment + re-optimisation uplift, non-energy BM, ancillary, CM); FA score mechanics; cohort benchmarking (middle quartiles pass) |
| NESO CBA methodology (Sep 2025) | PLEXOS welfare CBA — context only, not reimplementable at dashboard scale. Liftable: eligibility (≥8 h at full power, ≥100 MW stream 1 / ≥50 MW stream 2), LDES revenue = DA arbitrage + BM, marginal-addition counterfactual (B − 0.5·C(x)) |
| Four DSF workbooks (V3) | Ofgem's input taxonomy — the natural input schema for a mini-CFFM: split charge/discharge efficiency, fade rates %/yr, availability %, cycling limits; devex/capex/opex/repex/decommex categories; six-row revenue stack 2025–2079 |
| CFFM Handbook v2.0 (9 Oct 2025) — **not yet read** | The exact floor/cap level arithmetic. Must be read before Phase 3 (work item 3.0) |

## Feature A — toll and financing block in the BESS calculator

Extends the existing calc card (plan/09). This **reverses two recorded decisions** — "ungeared, no debt schedule" (metrics.js header, plan/09 out-of-scope list) — so it gets new numbered decisions here (D54+) and its own methodology prose. The default state (tolled share 0, gearing 0) must reproduce today's engine bit-for-bit, so existing fixtures stay valid.

**Model.** Per year *n* of the calculation period:

- `merchant_gbp` = existing availability + arbitrage lines (unchanged engine).
- During toll tenor: `revenue = s·toll_gbp_per_kw_yr·1000·MW + (1−s)·merchant_gbp`; after tenor: fully merchant. Toll is flat real over the tenor (engine is real, pre-tax); merchant share keeps degradation/derate/cannibalisation. Assumption to document: the toll £ is not degraded (availability guarantees sit with the operator).
- Debt: `D₀ = g · capex`; level annuity at real cost of debt over debt tenor. Report **min and average DSCR** (CFADS ÷ debt service), split toll-period vs post-toll. Optional helper: "max debt at target DSCR" given contracted + downside-merchant cash flow — the bankability readout (lenders size off the downside case). Mini-perm/balloon deliberately not modelled (D-candidate: note only).
- Equity flows = project flows − drawdown/service; **equity IRR** tile alongside the untouched project-level NPV/IRR.

**New chart** (toggle on the existing calc chart): equity IRR vs tolled share, one curve per toll price around the observed merchant anchor — the Modo chart, GB-calibrated by the user's own inputs.

**Surfaces touched (all five mirrors):** `metrics.js`, `charts.js` (inputs group "Route to market & financing", tiles, chart, CSV header, XLSX workbook), `ops/bess_calculator_figures.py`, `tests/fixtures/bess_case_*` (+ new toll/gearing fixtures), `ui.js` methodology + `methodology.md` Formulas. Badges: toll price/tenor/share, gearing, cost of debt = **assumption**; merchant anchor stays **observed**.

## Feature B — LDES cap-and-floor module

New card(s) on the Batteries tab (not a new tab — D56; superseded for the reference card by D72, which gave it its own LDES tab). Two parts, phased separately.

**B1. Window 1 reference card (small, timely).** Vendored static dataset `app/data/ldes_capfloor.json` (TNUoS-vendoring precedent, `build_bess_units.py:443-476`): the 16 minded-to projects (name, tech, MW, duration, region, track, first-op year) + regime parameters (25 yr, 4.47 %/7.48 % CPIH-real indicative, soft cap 30 %, MAT, BSUoS, FA 0.60, key dates) + a `status` field ("minded-to, 26 Jun 2026; final awards expected autumn 2026"). Registered in `meta.json` + `manifest.json`; new `ops/refresh.py` non-fatal step (validate/copy only — no live source to poll). Card: sortable table + capacity-by-technology/duration mini-chart; card-meta carries the status caveat. Glossary: cap and floor, RAV, building blocks, soft cap, MAT, FA score, BCR, BSUoS, tolling agreement, DSCR, gearing.

**B2. Mini-CFFM calculator ("where will Ofgem set my floor?").** All-assumption card, clearly badged, answering the three client questions:

1. *Floor/cap levels*: inputs MW, MWh, devex+capex £m, fixed opex £/yr, regime duration, residual value, floor/cap returns (defaults 4.47 %/7.48 %) → RAV (incl. simplified IDC) → annual floor and cap levels (return + depreciation + opex allowance), in £m/yr and £/kW/yr. Formulas aligned to the CFFM Handbook (work item 3.0) — until then this card does not ship.
2. *Corridor behaviour*: user gross-margin scenario band (low/central/high £/kW/yr) vs the corridor → PV of expected floor top-ups, cap clawback (70 %) and retained upside (30 %); FA-score analogue (GM ÷ floor) with the 0.60 marker.
3. *Dispatch under a floor*: prose, not simulation — MAT conditionality, cycling costs deliberately not passed through, soft cap preserving upside incentive.

**Hard limits to state in methodology:** dashboard fleet data is 1–2 h BESS — no observed LDES revenue anchor exists here, so B2 is arithmetic on user assumptions, not a backcast; per-project Ofgem levels are commercially sensitive and cannot be validated; indicative rates move with the iBoxx/gilts at each project's FID.

## Phasing

| Phase | Scope | Size | Depends on |
|---|---|---|---|
| 1 | Toll + gearing in the calc card (A, incl. tests, exports, methodology) | Large — five mirrored surfaces | D54, D55 |
| 2 | Window 1 reference card + glossary (B1) | Small | D56 |
| 3 | 3.0 read CFFM Handbook v2.0 → 3.1 mini-CFFM card (B2) | Medium | Phase 2, D57 |
| Watch | Autumn 2026 final awards → update `ldes_capfloor.json` status + list; Window 2 consultation (2026, position by 2027); rates finalised at FID | — | — |

Recommended order: 1 → 2 → 3. Phase 1 has no data dependency and the highest fit with the existing card; Phase 2 is cheap and most time-sensitive (final awards imminent); Phase 3 only after the handbook read.

## Open decisions (need sign-off)

- **D54** — toll block lives inside the existing calc card as a "Route to market & financing" group (recommended) vs a separate card.
- **D55** — gearing/debt included in Phase 1 (recommended; toll without leverage misses the point) vs toll-only first. Default-off preserves current behaviour and fixtures.
- **D56** — cap-and-floor as card(s) on the Batteries tab (recommended) vs a new tab. *Superseded for the reference card by D72, owner request 2026-08-29: the card now lives on its own LDES tab.*
- **D57** — Capacity Market stays excluded from the calculator (recommended, upholds the plan/09 exclusion) even though GB lenders count CM revenue; revisit only with a real CM data source, not a manual assumption line.

## Out of scope (upholding plan/09 lines)

No forecasting, no perfect-foresight dispatch backcasts, no per-project floor "predictions" for named Window 1 projects, no tax, no browser storage. The toll-vs-merchant comparison uses only the existing observed anchor + user assumptions, on the same footing as the current capture-rate line.

## Phase 1 decisions (D58–D67)

Recorded 2026-08-28, at implementation, continuing the global numbering
from plan/09 (D19–D53) and this plan's own D54–D57 above.

### D58: toll unit and stub pro-rating

*(Unit relabelled to £k/MW/yr, owner request 2026-08-29 — numerically
identical, display only; see D67.)*

**The toll is priced in £/kW/yr, the card's native revenue unit, and is
pro-rated by year 1's commissioning stub but never degraded,
cannibalised or derated.**

- £/kW/yr is what the observed percentile anchor and every other
  revenue figure on the card already speak; the ×1000 conversion to
  £/MW/yr is stated in the field note and the glossary rather than
  silently applied.
- The toll £ stays outside the degradation, cannibalisation and derate
  factors because under a toll the availability guarantee sits with the
  operator, not the model: the fee does not fall with the cells. The
  merchant share keeps all three effects (metrics.js:623–630).
- The commissioning stub still applies — a toll on an asset that
  operates for four months of year 1 pays four months of toll.

### D59: activation triples, no defaults

**The toll is active iff share > 0 AND price > 0 AND tenor ≥ 1; the
debt layer iff gearing > 0 AND a cost of debt is typed AND debt
tenor ≥ 1. A partial set leaves that half entirely inert, with a live
line naming the missing piece. No field ships a default.**

- The augmentation triple's all-or-no-op discipline
  (charts.js:3293–3300) is the established precedent, and it is what
  makes the default-off bit-for-bit guarantee provable.
- A defaulted debt tenor (or any other field) would ship a market
  figure the dashboard has not measured — the D23 line holds.

### D60: CFADS and DSCR definitions

**CFADS is the project's net cash flow in each operating year,
augmentation capex included; DSCRₙ = net_cashflow_gbpₙ ÷ debt
serviceₙ; average DSCR is the mean of the annual DSCRs.**

- Including augmentation capex is the honest in-model reading: the
  engine has no tax or working-capital lines to adjust for, and hiding
  a funded outflow from the cover ratio would flatter it. Lenders
  typically carve funded capex out of CFADS — the methodology states
  the convention rather than adopting it.
- For a level annuity the mean of annual DSCRs equals ΣCFADS ÷
  Σservice, which is what the workbook's SUMPRODUCT-based average row
  computes — the two definitions coincide by construction.

### D61: contractual-annual debt service

**Debt service is contractual-annual, never stub-pro-rated; a debt
tenor past the calculation period leaves principal outstanding at the
horizon with a stated warning; no balloon and no mini-perm.**

- A loan repays on its contractual schedule regardless of when in the
  calendar year the asset commissioned — pro-rating the annuity by the
  stub would misstate the lender's cash flow.
- Synthetic balloon repayment at the horizon would invent a
  refinancing event; leaving the balance outstanding and saying so is
  the honest treatment (metrics.js:644–649).

### D62: extend the row schema, not a separate debt layer

**Five new always-numeric row columns — toll_gbp, debt_drawdown_gbp,
debt_interest_gbp, debt_principal_gbp, equity_cashflow_gbp — rather
than a parallel debt structure beside the rows.**

- The rows are the single source of truth the CSV, chart and workbook
  parity all hang off; one closed-set update keeps them that way.
- Every prior engine feature (augmentation, derate, OPEX escalation)
  went into `bessCashflow`'s rows for the same reason.
- DSCR is deliberately NOT a row field — it is a ratio, undefined in
  no-service years, and would break the all-numeric closed set; it
  lives in the `dscrStats` helper instead (metrics.js:471).

### D63: third chart mode

**A third chart toggle, equity IRR vs tolled share: x from 0 to 100%
in steps of 5, three curves at 0.8×, 1.0× and 1.2× the anchor toll
price (the entered price, else the observed year-1 merchant
£/kW/yr).**

- The Modo-style curve, GB-calibrated by the user's own inputs — the
  one picture that shows where the toll flips from levering returns up
  to capping them.
- Percent-vs-percent axes obey the one-unit-per-axis house rule
  (charts.js:5367–5379).

### D64: sensitivity strip and matrix untouched

**No toll axis joins the existing sensitivity strip or matrix.**

- The third chart mode IS the toll sensitivity view; a matrix axis
  would duplicate it in a cramped form.
- `bessCalcNpvAt`'s shallow-merge carries the new keys automatically,
  so the existing sensitivities remain correct with the block active.

### D65: merchant-only leverage allowed

**Gearing without a toll is allowed, with a stated live-line note that
lenders would size smaller off a downside merchant case — stated, not
blocked. The workbook carries overall min and average DSCR only; the
toll-period/post-toll split is a card-tile read-out.**

- Blocking the combination would encode a lending policy the dashboard
  has no data for; naming it keeps the arithmetic honest.
- The split rows would roughly double the Financing section for a
  figure the card already shows; the workbook keeps the headline pair.

### D66: no new defined names in the workbook

**The Financing section references cells via the symbolic row maps,
like every other block; the workbook's single defined name (WACC)
stays the only one.**

- The row-map convention (BESS_AROW/BESS_DROW) is what keeps row
  insertion a one-place change; defined names would add a second
  addressing scheme to maintain for no reader benefit.

### D67: toll unit relabelled to £k/MW/yr

Recorded 2026-08-29 (owner request), superseding D58's label only.

**The toll price is displayed as £k/MW/yr everywhere — card label and
footnote, live line (both sides of the toll-vs-merchant comparison),
equity-IRR chart series and caption, CSV header key
(`toll_price_gbpk_per_mw_yr`, the `capex_gbpk_per_mw` house
convention), workbook Assumptions unit cell, docstrings, methodology
and glossary. Numerically identical to £/kW/yr: no formula, engine
value, stored State value or fixture input changes.**

- £k/MW/yr is the unit toll quotes are actually made in — the Modo
  research this feature is calibrated to quotes it — so the card now
  reads like the market rather than asking the reader to convert.
- Reader-feedback precedent: the 2026-08 John Perkins pass moved the
  BESS revenue display to £/MW/day for the same per-kW readability
  reason (commit 1dd1265); this applies the same judgement to the toll.
- £100/kW/yr ≡ £100k/MW/yr — the numeral is identical, so per-kW
  readers lose nothing and every captured figure carries over
  unchanged. The `tollPrice × 1000 × P` engine term is untouched under
  either reading.
- The workbook fixtures were re-captured (unit-cell string only;
  inputs.json unchanged) because the byte-compared workbook carries the
  Assumptions unit text.

## Phase 2 decisions (D68–D70)

Recorded 2026-08-29, at implementation of B1.

### D68: reference card layout

**One `span-2` card after the calculator: a sortable table of the 16
minded-to projects (default order EA rank ascending), a regime-parameters
definition run, and an MW-by-technology mini-chart, in that order.**

- The table is the payload: what a reader wants from a reference card is
  the list, so it leads. Click-to-sort on every column (plain DOM, the
  `.util-table` classes, no library) with an arrow on the active header;
  sort state is module-local presentation, like the calc view toggles,
  never stored.
- EA rank ascending is the default because it is Ofgem's own published
  ordering, and the rank gaps (10, 11, 13 — projects not selected) are
  visible evidence of the assessment rather than a defect to sort away.
- The regime strip is a definition run, not a second table: seven
  parameters with glossary term-links, small enough to read as a caption
  for the corridor rather than a dataset of its own.
- The mini-chart is one horizontal bar series, MW by technology computed
  from the project list (never hard-coded), one unit per axis; per-project
  duration lives in the tooltip rather than as a second series, upholding
  the one-unit-per-axis house rule without a dual axis.
- Lazily fetched via `Data.loadLdesCapfloor()` (the `bess_units`
  precedent, D33): a vendored reference table nobody scrolling the other
  Batteries panels pays a byte for.

### D69: no £ levels shown or estimated

**The card shows no per-project £ floor or cap level, and the dashboard
never estimates one.**

- Ofgem withholds them as commercially sensitive; only the indicative
  sector-level returns (4.47%/7.48% CPIH-real, refixed at FID) are
  public, and no per-project RAV is published to apply them to.
- A dashboard-side estimate would dress an unpublished commercial number
  in observed clothing — a reference card must not invite false
  precision. Reference only; per-project floor arithmetic waits for
  Phase 3's all-assumption mini-CFFM (B2), where the user supplies every
  input and owns the result.
- Mirrored as methodology.md judgement call 17, so the choice is never
  re-litigated as an omission.

### D70: hand-updated vendored dataset

**`ldes_capfloor.json` has no live source: the daily refresh re-validates
and republishes it but can never change its contents. The update trigger
is an Ofgem publication, applied by hand.**

- There is nothing to poll — the source is a pair of PDF decisions. A
  scraper would be pure fragility with no freshness gain.
- The refresh step (`ops/refresh.py`, non-fatal) re-runs the builder,
  which cross-checks the totals against the per-project list on every
  build, so a hand-editing slip fails validation instead of publishing.
- Next expected update: final awards, autumn 2026 (the plan's Watch
  row); the payload's `status` block and the card caption both carry the
  supersession date so the table can never silently age.

## Post-ship decisions (D71–D72, owner requests 2026-08-29)

### D71: collapsible calculator input groups

**The calculator's six input groups are native `<details>` disclosures:
The asset and Costs and finance default open, the other four default
collapsed, and a collapsed group whose fields carry non-default values
says so in its summary with a small "n set" count.**

- The input column had grown to 5–9 seconds of scrolling; six compact
  summaries restore the overview without dropping a single field.
- The two open-by-default groups are exactly the ones holding the
  required five inputs (power, energy, useful life, CAPEX, WACC), so
  the missing-required line under the results never names a field the
  reader cannot see on arrival.
- The "n set" marker is the honesty rule: no active assumption may hide
  behind a closed group. It counts departures from the shipped defaults
  (off family toggles and non-default selects included), is updated
  textContent-only from `updateBessCalcLiveFields` on every render, and
  clears on reset through the same pass. Open groups show no marker —
  their fields speak for themselves (badge/marker only what is active).
- Native details/summary keeps D30's build-once rule intact: the form
  is still built exactly once, open state lives in the DOM (the D47
  caption precedent one level down), no browser storage, no re-render,
  focus and typed values survive every toggle.

### D72: LDES moved to its own tab

**The Window 1 reference card moved from the Batteries tab to a new
LDES tab, immediately after Batteries (owner request 2026-08-29,
superseding D56's placement for this card).**

- LDES is not BESS: the card describes 8–32 h pumped hydro, CAES and
  flow projects under a regulated regime, and sitting below a 1–2 h
  merchant-battery calculator invited exactly the category confusion
  the card's prose warns against.
- Mechanics of the move: the panel markup moved verbatim (ids kept),
  `ldesCapfloor` moved from `PANELS.bess` to a new `PANELS.ldes` group,
  so the lazy `Data.loadLdesCapfloor()` fetch now fires on the LDES
  tab's first activation; the tab joins `GB_ONLY_TABS` (an Ofgem
  regime has no ENTSO-E counterpart); the methodology location prose
  was updated. B2's future mini-CFFM calculator (Phase 3) naturally
  lands on this tab too.

### Follow-up flagged, not fixed here

`state.js:44–65` and `resetBessCalcForm()` (charts.js) hold two
divergent defaults objects: nine optional form keys (aug*, captureRate,
derate, discounting, manualSpread, valuationDate) are absent from the
state literal and rely on `setCalc`'s blind assign, while the reset map
is a second, string-typed object. Pre-existing, and the toll/debt
fields deliberately follow the same optional-key pattern rather than
touching either object — but the divergence is worth a tidy-up pass of
its own.

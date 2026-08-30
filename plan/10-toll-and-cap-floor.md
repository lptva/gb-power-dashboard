# 10 — Battery toll calculator and LDES cap-and-floor module

**Status: D54–D57 signed off by the owner 2026-08-28. D58–D72 recorded below. Phase 1 (Feature A, toll + financing block) implemented across all five mirrored surfaces. Phase 2 (B1, Window 1 reference card) implemented 2026-08-29: data layer (`etl/build_ldes_capfloor.py` → `app/data/ldes_capfloor.json`, manifest + refresh + tests) and UI layer (card, glossary, methodology). Same day, two owner requests: the calculator's input groups are collapsible (D71) and the reference card moved to its own LDES tab (D72, superseding D56's placement). Phase 3 (B2, mini-CFFM calculator) implemented 2026-08-29 after the CFFM Handbook v2.1 read: engine (`Metrics.cffmLevels`/`cffmCorridor`, mirrored in `ops/ldes_cffm_figures.py`, tests in `tests/test_ldes_cffm.py`) and UI layer (card below the reference card on the LDES tab, glossary, methodology); decisions D73–D78 below.**
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

## Phase 3 decisions (D73–D78)

Recorded 2026-08-29, at implementation of B2, after the CFFM Handbook
v2.1 read (work item 3.0).

### D73: scope is the ex-tax CFFM core

**The mini-CFFM implements the handbook's building blocks (v2.1 §3 and
annex A1) reduced to their ex-tax real-terms core: RAV build with IDC
and transaction costs, straight-line depreciation, an NPV-neutral
return on RAV, annuity flattening at the floor and cap rates. Repex,
the ACOD floor and the partial-indexation switch are out.**

- Repex re-spreads depreciation across the remaining regime each time
  replacement expenditure lands — a schedule input the card has no
  honest source for; the ACOD floor is a project-finance option whose
  inputs (actual debt terms) are per-deal; partial indexation was
  dropped by Ofgem. Each would add form fields that invite false
  precision without changing what the card exists to show: where the
  published method puts a corridor for the reader's own numbers.

### D74: tax omitted, stated loudly

**The levels are ex-tax. The real CFFM adds a grossed-up nominal
corporation-tax annuity to both levels; the card, the in-app
methodology, the methodology.md formula entry and judgement call 18
all state that genuine levels sit above the ex-tax ones.**

- The tax loop is nominal (it iterates against capital allowances under
  actual inflation), and this model is flat real with no inflation
  arithmetic anywhere — replicating the loop needs assumptions the
  dashboard has not measured, and a half-replicated one would be worse
  than a loud omission. The card-meta says "ex-tax" on the card itself,
  not only in the methodology.

### D75: return base matches Op_Rav!K38 (corrected 2026-08-30 after verification against CFFM v2.17)

**Each operational year's return is rate × the average of the opening
RAV and the closing RAV discounted one year — the CFFM's own base
(`Op_Rav!K38 = AVERAGE(opening, closing/(1+r))`), each side at its own
rate, combined with plain end-of-year discounting
(`Allowances_Cap!K36 = (1+r)^-year`).**

- The original choice (shipped with Phase 3) was rate × opening RAV.
  Why it was made: the handbook (A1.143) describes the averaged base
  but publishes no worked example, so the annuity identity
  (level = RAV × AF with every side block off) looked like the only
  available parity anchor, and the opening-RAV base is the unique one
  satisfying it under end-of-year discounting; the averaged base was
  believed NPV-neutral only under intra-year receipt timing this
  model lacks.
- What the workbook showed (cell-level verification against the real
  CFFM v2.17): the model combines the averaged base with plain
  end-of-year discounting, so the (2+r)/(2(1+r)) factor is IN Ofgem's
  levels — the model's capital-side annuity satisfies
  level = depreciable RAV × AF × (2+r)/(2(1+r)), NOT
  level = RAV × AF. The old justification's "intra-year receipt
  timing" claim was false: nothing in the model re-times receipts to
  neutralise the averaged base.
- The correction: the engine (JS + Python mirror) now accumulates
  return_n = r × (opening + closing/(1+r))/2 on the depreciable-base
  walk, keeping end-of-year discounting unchanged; the corrected
  factor identity is pinned by `CffmFactorIdentityTest` in
  `tests/test_ldes_cffm.py` (replacing `AnnuityIdentityTest`), so the
  base cannot silently regress in either direction.

### D76: residual is deducted from the opening RAV in year 1 (corrected 2026-08-30 after verification against CFFM v2.17)

**The residual value is deducted from the opening operational RAV in
year 1 only (`Op_Rav!K12 = -Inputs!I29`): both depreciation and the
return run on the depreciable base RAV − residual, declining to zero —
the residual never depreciates and never earns a return.**

- The original choice was "residual left standing, earning the return
  until the end of the regime": the handbook leaves the convention
  unstated, and that reading (the standard regulatory-depreciation
  one) produced the then-pinned closed form
  level = (RAV − residual·(1+r)^−N)·AF + opex + decom.
- The workbook answered the question directly: `Op_Rav!K12` subtracts
  the residual from the opening operational RAV in year 1, so it is
  simply absent from the walk. The old convention overstated the
  level by roughly r × residual per year; the corrected closed form is
  level = (RAV − residual)·AF·(2+r)/(2(1+r)) + opex + decom, and
  `ResidualTimingTest` pins the timing (including that the old
  overstatement is gone). The default is zero residual, Ofgem's own
  default (biddable), so the correction only moves levels when the
  reader types one.

### D77: corridor arithmetic from the decision documents

**Top-up = max(0, floor − GM); clawback = 70% of the excess above the
cap (30% retained, the soft cap); FA = central GM ÷ floor, read
against the published 0.60 demotion threshold; lifetime figures are
annual × operational years, flat and undiscounted.**

- These come from the Financial Framework and minded-to decisions, not
  the handbook (which models levels, not scenarios). Undiscounted
  lifetimes are deliberate: a flat real annuity held against flat real
  scenarios has no natural consumer-flow discount rate, and inventing
  one would be false precision. The 0.60 threshold is a UI concern —
  the engine reports the bare ratio.

### D78: card placement and state ownership

**The card sits below the Window 1 reference card on the LDES tab,
owns its inputs in a module-scope object (never State.calc), ships the
published regime parameters prefilled and badged Reference, and has no
exports in v1.**

- Below the reference card because the reference states what Ofgem
  published and the calculator applies it — reading order is the
  argument order.
- State.calc is the BESS card's namespace: its reset, defaults map and
  group markers all iterate it, and a second form writing into it
  would entangle two cards that share nothing. A small module-scope
  object in charts.js keeps the no-browser-storage rule and D30's
  build-once form; the delegated listener is the card's own, on its
  own container.
- The prefills are published Ofgem parameters, the TNUoS-vendoring
  precedent: Reference-badged (`badge proxy`), never Assumption — but
  everything computed downstream is Assumption, and the card header
  says so. User cost inputs ship blank with no defaults (D23).
- No CSV/XLSX in v1: the card's output is four tiles, a breakdown line
  and a flat corridor — nothing a reader cannot transcribe, and the
  export machinery would outweigh the arithmetic. Revisit if the card
  grows year-by-year schedules.

### Follow-up flagged, not fixed here

`state.js:44–65` and `resetBessCalcForm()` (charts.js) hold two
divergent defaults objects: nine optional form keys (aug*, captureRate,
derate, discounting, manualSpread, valuationDate) are absent from the
state literal and rely on `setCalc`'s blind assign, while the reset map
is a second, string-typed object. Pre-existing, and the toll/debt
fields deliberately follow the same optional-key pattern rather than
touching either object — but the divergence is worth a tidy-up pass of
its own.

## Post-ship decisions (D79–D84, owner feedback 2026-08-29)

Recorded the same day Phase 3 shipped, from the card's first real use.

### D79: decommissioning input clarified as an annual allowance

**The field stays a per-year allowance — faithful to the CFFM's annual
Opex & Decom block — but is relabelled "Decommissioning allowance
(£m/yr, real)", its footnote states the annuitisation conversion for a
one-off end-of-life cost, and a live line under the field states the
lifetime total whenever the field is set, offering the annuitised
equivalent when the total looks allowance-implausible (> 20% of
CAPEX).**

- The trap, from real use: an owner entered a one-off end-of-life cost
  in the field and silently got a 25× overstatement of lifetime
  decommissioning — the field multiplied by the regime length, exactly
  as an annual allowance should, with nothing on the card saying so.
- The fix changes no semantics. The conversion (one-off £X at end of
  regime ≈ X × (1+r)^−N × AF(r, N) per year, at the floor rate) is the
  engine's own annuity arithmetic, exposed as
  `Metrics.cffmAnnuitiseEndOfLife`, mirrored in
  `ops/ldes_cffm_figures.py` and hand-pinned in the tests, so the live
  line and the methodology state the same number the levels would use.
- Threshold judgement: a genuine annual decommissioning baseline never
  approaches 20% of CAPEX over the regime; a mistyped one-off usually
  clears it at once. Gentle wording, never a validation error — the
  reader may genuinely mean a large allowance.

### D80: mini-CFFM CSV export

**A "Download CSV" button on the card (`gb_ldes_minicffm.csv`),
superseding D78's no-exports call after owner feedback from real use —
the BESS calculator's export discipline applied verbatim.**

- D78 reasoned that four tiles and a flat corridor were transcribable
  by hand; real use said otherwise — the reader wants the assumptions
  and the corridor in a file they can hand on.
- Discipline mirrored from the BESS CSV: a `#` key=value header
  carrying every input (`not_set` when blank), the derived summary
  (RAV, IDC, transaction costs, both levels, FA score) and the
  standing "ex-tax, flat real, indicative — not the CFFM" caveat;
  `Metrics.toCsv` for the table; no free text in any data cell.
- Schema stability over minimalism: always all nine year-table columns
  (`year`, floor, cap, three GM scenarios, central top-up/clawback/
  retained), zeros for unset scenarios with the header recording which
  were `not_set` — flat values repeated per year, honestly, because
  the model is flat. The row-building is factored into
  `Metrics.cffmCsvColumns` and mirrored in Python precisely so the
  schema is pinned by `tests/test_ldes_cffm.py` rather than by hand.
- Gate: the results' own gate (a computable set of levels), nothing
  more — a missing corridor exports as declared zeros.
- Shape superseded the same day by D81 below; the button, the gate and
  the mirror discipline all stand.

### D81: mini-CFFM CSV restructured to a parameter table

**`gb_ldes_minicffm.csv` becomes a three-column
`section,parameter,value` table — `input` rows (all 17 card fields,
verbatim, `not_set` when blank), `derived` rows (RAV/IDC/tx, both
levels with their annuitised sub-blocks, FA score, per-scenario
lifetime corridor figures), one closing `note,caveat` row — and BOTH
calculator CSVs (this one and the BESS cash flow) gain a UTF-8 BOM.**

- Owner feedback, same day as D80 shipped, with an Excel mojibake
  screenshot: (1) the `#` comment-line inputs forced manual parsing —
  nothing tabular could read them; (2) the flat year table carried
  nothing — the model is flat real, so 25 identical rows restated one
  number 25 times; (3) the CSVs were UTF-8 without a BOM, so Excel
  guessed a legacy codepage and rendered the header's em dashes as
  mojibake.
- The fix: no `#` header at all — every input and every derived figure
  is a real row a pivot table can consume; the caveat survives as the
  one `note` row, the export's only free-text value, comma-quoted by
  the serialiser (RFC 4180) so the column structure holds. All emitted
  strings are ASCII (em dashes replaced with plain hyphens), and the
  BOM — added to the BESS CSV too, structure untouched — makes the
  encoding explicit for Excel regardless.
- `Metrics.cffmCsvColumns` -> `Metrics.cffmCsvRows` (the whole row
  list, header to note, pure and testable), mirrored as
  `cffm_csv_rows` in `ops/ldes_cffm_figures.py`; the old year-table
  function deleted from both. `tests/test_ldes_cffm.py`'s
  `CsvRowsTest` pins section ordering, the 17 input keys, the derived
  key set, `not_set` handling (an untyped scenario is `not_set` in its
  lifetime rows even though the corridor computes a defaulted one),
  and the ASCII guarantee; the source-grep tests fingerprint the
  schema in both languages and require the `"\uFEFF"` BOM escape twice
  in `charts.js` (once per calculator download, never as a literal BOM
  character an editor could strip).

### D82: mini-CFFM live-formula workbook export

**An "Export model (Excel)" button beside the CSV
(`gb_ldes_minicffm.xlsx`) \u2014 a three-sheet workbook in which every
derived cell is a live Excel formula over the Inputs cells, nothing
precomputed, no cached values \u2014 superseding the remaining half of
D78's no-exports call.**

- Owner feedback on D81's parameter table: the CSV records the
  FIGURES but cannot show the MECHANICS \u2014 the owner wants to "palpate
  the mechanics", tracing IDC, the RAV walk and the annuity
  flattening cell by cell. The workbook is that palpable version; the
  CSV stays beside it as the tabular record. D80 superseded D78's
  no-exports call for the figures; this supersedes it for the model
  itself. The BESS D36-D39 discipline applied verbatim: same
  `Xlsx.build` writer, same vendored style table (`BESS_XF` roles
  only, no new styles), same closed evaluator grammar
  (`ops/xlsx_eval.py` \u2014 `0-x` for negation, never unary minus), same
  session-only Blob download and gate (a computable set of levels).
- **Three sheets.** Cover: title, the standing ex-tax caveat,
  headline mirrors (RAV, floor level, cap level, FA score) as pure
  links to the Levels sheet, a notes block stating the IDC formula,
  the depreciation-to-residual convention, the opening-RAV return
  base, the annuity flattening, the 70/30 corridor and the 0.60 FA
  threshold in prose, and the house cell-style map. Inputs: one
  column-E cell per engine input plus MW and the three gross-margin
  scenarios (`LDES_WROW` row map) \u2014 rates as FRACTIONS behind percent
  formats (how the engine consumes them), unset numerics 0 with
  Source "not set" (the BESS capture-rate precedent), unset low/high
  scenarios resolved to central exactly as the card's corridor call
  resolves them. Levels (`LDES_LROW`): the column-per-year mechanics
  \u2014 the A1.70 IDC walk over the construction years, transaction costs
  and the RAV at transfer as visible cells, the operations grid
  (opening RAV, depreciation, return at each rate, unprofiled and
  discounted allowances, `POWER(1+rate,0-year)` discount factors),
  NPV and annuity-factor cells (rate-0 branch spelled out), the
  level cells as NPV x annuity factor, the central-scenario corridor
  walk (top-up, above-cap, 70% clawback, retained) with lifetime SUM
  cells and the FA cell (`"n/a"` on a non-positive floor, the
  engine's own guard), and two labelled check rows pinning the
  factor identity \u2014 capital annuity = depreciable RAV \u00d7 AF \u00d7
  (2+r)/(2(1+r)) (the D75/D85 correction) \u2014 at each rate, exactly
  true for this engine's return base, so both must read 0.
- The two grids are built for the CURRENT inputs (the BESS DCF's
  built-for-T convention): the builder regenerates per download, so a
  changed year count is a re-download, never a formula guard. The
  floor and cap rates are bound to defined names
  (`FLOOR_RATE`/`CAP_RATE`, the WACC precedent) since they appear in
  eight Levels formulas each.
- **Tests** (`tests/test_ldes_cffm.py::WorkbookExportTest`, fixture
  `tests/fixtures/ldes_wb_case_1/` captured by driving the real card
  on the dev server and intercepting the button's Blob, the D39
  discipline): zip/part-list integrity, no calcChain/macro/external
  link, EVERY formula evaluated through the closed grammar, the
  headline cells (RAV, both levels, FA, the three lifetime corridor
  cells) against `ops/ldes_cffm_figures.py` within
  `max(1e-6 x |x|, 0.01)`, both identity check rows at zero, plus
  three in-memory Inputs-override variants (ungeared/no-tx,
  zero-opex-and-residual level = RAV x AF x (2+r)/(2(1+r)), and the
  rate-0 annuity branch) re-verified against the mirror \u2014 the
  live-formula claim under test: new inputs, same cells,
  engine-parity output.

### D83: rule-based result annotations on both calculators

**A one-line "Reading:" annotation under each calculator's result
tiles — the BESS profitability calculator and the mini-CFFM — built
from deterministic, enumerable rules over the figures the card has
already computed at render time, with no model call of any kind.**

- The owner asked for interpretive annotations ("what do these numbers
  mean") but explicitly not for per-user model costs: an LLM-written
  reading on a static page would put a metered API call behind every
  input change, need a key in a keyless page, and produce text that is
  neither reproducible from the inputs nor auditable. The diagnosis
  space on these cards is small and enumerable — viability against the
  WACC, which debt-service years break and why, toll versus the
  implied merchant rate, corridor position, the FA threshold — so
  rules beat generation on cost, determinism and auditability, and
  give up nothing the cards actually need.
- **Shape**: the year-1 revenue-mix line's idiom. One
  `<p class="calc-reading">` per card, rebuilt each render, hidden
  whenever the card's own result gate fails (missing inputs clear it
  with everything else). Each card's rules live in a pure function
  over the render's own stats — `bessCalcReading(s)` /
  `ldesCffmReading(s)` in `app/js/charts.js` — returning an HTML
  string or null; no DOM, no State, no second derivation path (the
  stats objects are assembled from the very values the tiles just
  rendered). At most the three highest-priority firing sentences
  render, so the line never grows past a short paragraph.
- **BESS rules, in priority order**: (1) viability — NPV sign and IRR
  against the WACC in percentage points; (2) when the debt layer is
  active, a DSCR *diagnosis* that names WHICH years break rather than
  restating the minimum: a part-year commissioning stub charged a full
  annual debt payment (a convention, not a cash shortfall), an
  augmentation year falling inside the debt tenor, or a plain
  below-target/below-1.00x statement — and an all-clear when every
  service year covers; (3) when a toll is in force, the toll price
  against the implied un-stubbed year-1 merchant rate (availability
  plus arbitrage per MW before toll scaling) as a percentage, with the
  upside-for-certainty trade read out; (4) when geared, the leverage
  direction — equity IRR above or below project IRR at the stated cost
  of debt.
- **Mini-CFFM rules, in priority order**: (1) the central scenario's
  corridor position — below the floor (with the lifetime consumer
  top-up and the Financial Assessment framing), inside (no support, no
  clawback), or above the cap (70% returned, what the operator keeps);
  (2) the FA score against the published 0.60 demotion threshold, with
  the Window 1 context on a fail; (3) the spread check — a floor above
  even the typed high scenario means the asset does not pay for itself
  from the market at any scenario; (4) cost intensity — the floor as
  £/kW/yr recovering the RAV's £/kW over the regime, when MW is set.
- Guards throughout: rules fire only when their inputs exist, nothing
  divides by a zero or a null, and the line reads naturally whichever
  subset fires. No new tests (the 412-test suite is untouched and
  green); the functions are pure and DOM-free, so unit tests can be
  added the day a rule is disputed.
- **Docs**: one sentence in each card's in-app methodology section
  (the reading is rule arithmetic in the page, no model involved),
  methodology.md judgement call 19 (rules over generation: cost,
  determinism, auditability), CHANGELOG.

### D84: BESS CSV header restructured to the parameter-table pattern

**`gb_bess_calculator_<percentile>.csv` opens with the mini-CFFM
export's three-column `section,parameter,value` table instead of the
`#` comment-line header, then one blank separator row, then the
annual cash flow table exactly as before.** Owner request, 2026-08-29
("we fixed hashtags in LDES's csv, but not in BESS's"): D81's
argument applies verbatim — comment-line inputs force manual parsing,
a parameter table loads as data.

- **Layout**: header row `section,parameter,value`; one `input` row
  per key the old `#` block carried, identical key names and value
  semantics (`not_set` for blanks, `not_applicable` /
  `not_available` / `defaults_to_degradation` where the old lines
  used them; the conditional `augmentation_year_entered` row survives
  under the same condition), plus a new `opex_escalation_source` row
  stating the provenance the old opexEscLine folded into its value as
  a parenthetical ("typed", or the shipped ONS CPI default with its
  period — comma-free, so only the note row ever needs quoting);
  `family_toggles` joins with ";" rather than "," for the same
  reason. Then a NEW `derived` section, the D81 value-add mirrored:
  `npv_gbp`, `irr_pct`, `mirr_pct`, `dpi`,
  `discounted_payback_years`, `lcos_gbp_per_mwh`, and — while the
  debt layer is active — `equity_irr_pct`, `dscr_min`, `dscr_avg`
  (`not_set` when inactive or null, e.g. the no-IRR and
  above-solver-bracket cases). The values are the result tiles' own
  figures — same Metrics calls, same re-anchoring, same observed-s_lo
  gate on LCOS — rounded to 4 dp; MIRR, which DPI replaced on screen,
  is carried here as the workbook already carries it. The four-line
  free-prose intro becomes the closing `note,caveat` row, RFC
  4180-quoted, the parameter block's only free-text value.
- **Unchanged**: the year table below the separator — its own
  `year,capex_gbp,…` header and rows from `Metrics.toCsv` over the
  existing engine columns plus the six family columns
  (CsvExportShapeTest still pins that schema); the UTF-8 BOM; the
  all-ASCII discipline; the download gate; the Excel export and the
  engine, untouched.
- **Structure**: the rows are built by `bessCalcCsvParamRows` beside
  the download function — pure and DOM-free, but a VIEW-LAYER row
  builder with no Python mirror by design (stated in its comment):
  the mirrored, schema-pinned part of this export remains the year
  table's engine columns in `ops/bess_calculator_figures.py`.
- **Docs**: the card's in-app methodology CSV paragraph rewritten;
  methodology.md's CSV downloads section updated for the new shape,
  with the free-text-exception sentence now covering both
  calculators' note rows; CHANGELOG. No new tests (the 412-test
  suite is untouched and green); verified live on the dev server —
  BOM first bytes, parameter block against the tiles for a full
  toll-plus-debt case and a required-only case, blank separator,
  year-table schema byte-identical, LDES exports untouched.

### D85: engine verified against CFFM v2.17

**The mini-CFFM's capital arithmetic was verified cell by cell against
Ofgem's actual cap-and-floor financial model, CFFM v2.17, on
2026-08-30; the D75 (return base) and D76 (residual timing) decisions
above were corrected in place as a result, and the corrected engine
now matches the model's ex-tax capital arithmetic exactly.**

- Method: a replica of the model's arithmetic, built from the
  workbook's own formulas (`Op_Rav`, `Allowances_Cap` and friends),
  matched its cached values to ~1e-13 — so the cell readings below
  are the model's, not an interpretation of the handbook.
- What the verification established, cell by cell:
  - Return base: `Op_Rav!K38 = AVERAGE(opening, closing/(1+r))`,
    return = base × r at each side's own rate, combined with plain
    end-of-year discounting (`Allowances_Cap!K36 = (1+r)^-year`).
    Consequence: the capital-side annuity satisfies
    level = depreciable RAV × AF × (2+r)/(2(1+r)), not RAV × AF
    (D75 corrected).
  - Residual: `Op_Rav!K12 = -Inputs!I29`, deducted from the opening
    operational RAV in year 1 only — it never depreciates and never
    earns a return (D76 corrected).
- Component diff, measured on Ofgem's own illustrative dataset
  (RAV 613.916473, cap ex-tax 62.396189, notional floor ex-tax
  50.309813 £m; the constants are also recorded beside the tests in
  `OfgemExampleAnchorTest`) — our remaining DOCUMENTED gaps:
  - no corporation-tax loop: true levels exceed ex-tax by ~+13.2%
    (cap), ~+10.6% (notional floor), ~+5.4% (ACOD floor) — the
    headline understatement, loudly stated on the card and in the
    methodology;
  - no Repex: ~0.3–0.7% of the levels (Repex is populated in Ofgem's
    own example);
  - one-shot transaction costs: ~−1% (the real model capitalises IDC
    on early debt transaction costs);
  - construction profile: capex spread evenly here, profiled there.
- Shipped alongside: engine correction in `app/js/metrics.js` +
  `ops/ldes_cffm_figures.py`; workbook builder's return rows,
  opening-RAV row and check rows rewritten to the corrected
  arithmetic (fixture `ldes_wb_case_1` re-captured);
  `CffmFactorIdentityTest` / `ResidualTimingTest` / re-derived parity
  pins; ui.js in-app methodology, methodology.md (judgement call 18
  and the formula block), README caveat bullet and CHANGELOG all
  updated with the measured numbers.

# Milestone 9: BESS profitability calculator (issue #49)

Design-first, per house convention. Extends plan/08 (issue #47) and plan/06
Workstream C (issue #24): this doc reuses their identified fleet, their
matched-denominator rule and their badge taxonomy, and continues the global
decision numbering (D18 → D19+). Investigated live 2026-07-30; every figure
below is from a probe against the named endpoint, not from an estimate.

## Status

Design drafted 2026-07-30. **D29 approved by the owner 2026-07-30, as
proposed; D19–D28 and D30–D34 await decision.** Three resolutions overturn
part of what the issue proposes (D23 drops the duration prefill entirely,
D26 refuses to call the arbitrage figure revenue, D27 keeps Balancing
Mechanism cashflow out of the engine), and the measured evidence for each is
set out in full so the owner can overrule with the numbers in view.

Payload phasing was ambiguous in the first draft and is resolved: D33 now
carries the block-by-phase table, and the payload section marks every block
`[v1]` or `[v2]`.

**Amendment, 2026-07-31: a v1.5 batch is underway.** After owner review of
the shipped v1 card, three things were pulled forward from v2 into a v1.5
batch, and one new decision set was requested. Pulled forward: D26's
arbitrage ceiling with its capture rate, and the family-level percentiles
behind D21's six family toggles. Added: the discounting-convention option
(mid-year default, end-of-period alternative, year-1 stub discounted at its
own midpoint) and the Excel DCF export. **Pick-a-unit mode and the per-unit
`units` payload remain v2**, so nothing in D29's disclosure step-up moves.
D34 carries the amended phase list; D35 to D40 carry the workbook design.

---

## Market question

**What does a GB battery have to believe about itself to pay back, given
what the market observably paid comparable units last year?**

The dashboard already answers "what did the fleet get paid" (plan/08) and
"how hard is the fleet worked" (plan/06 Workstream C). Neither answers the
question a reader actually arrives with, which is whether the numbers on
those charts add up to a business. This card closes that loop: the user
describes a battery, the calculator anchors the revenue side on the
published record for real units, and it reports a simple annual cash flow
with NPV, IRR, simple payback and an indicative LCOS.

The deliberate framing is **illustrative economics, not investment advice**,
and it is stated on the card, in the methodology entry and in the export
header. Everything downstream of a user input is badged Assumption or
Estimated. Nothing the calculator produces is written back into an observed
panel, an observed payload or a stored file.

### Scope note: why this does not reopen #24's exclusion

Issue #24 excluded revenue modelling because it "requires private
trading-strategy data", and plan/08 restated that exclusion for asset-level
P&L. That exclusion was about **fabricated observations**: presenting a
simulated dispatch, a reconstructed trading position or a modelled
per-unit P&L as though it were something anyone measured. It still stands in
full and nothing here weakens it.

This card is a different category. It is the **SRMC-slider category**: the
user supplies every economic assumption, the app does arithmetic on those
assumptions in front of them, and the result carries the user's own inputs
as its provenance. The Spreads tab has done exactly this since the first
release (`app/js/ui.js:769-812`, eight sliders plus a manual coal-price
override at `app/index.html:373`), and the clean dark spread is shipped as
Proxy/Derived on that basis. The only observed material the calculator
reads is already published on the Batteries tab. The only new observed
material is a per-unit cut of a payload the repo already builds.

---

## Premise corrections vs the issue text

The issue is right about the shape and wrong in four specifics that change
the design. Each is evidenced under Spikes below.

1. **The duration prefill cannot be built.** Both candidate sources fail on
   measurement, not on effort: the Capacity Market register joins to only
   26 of our 123 fleet units at a defensible confidence tier (S1), and the
   observed metered duration floor understates known duration by roughly
   half across the fleet (S5). Duration ships as a plain user input.

2. **Per-unit percentiles must be computed over a trailing window, not read
   off the per-day spread already shipped.** `bess_revenue.json` carries
   p10/p50/p90 of the per-day cross-section. Annualised, its p10 is
   **−£6.15/kW/yr** because Dynamic Regulation clears negative on many days.
   The per-unit trailing-365-day distribution gives p10 £1.06, p50 £10.07,
   p90 £26.96 /kW/yr (S6). Only the second can enter a cash flow.

3. **Acceptance rates are cheap, and are not a multiplier.** One grouped
   query per monthly Sell Orders resource returns the whole fleet's
   offered-versus-executed volume in 281 kB and 0.8 s (S6). They ship as
   displayed context. Multiplying availability revenue by them would double
   count, quantified at a **58% understatement** in D21.

4. **Wholesale arbitrage is a ceiling, not a revenue line.** Computed from
   the half-hourly MID prices already stored, over 364 complete days, a
   perfect-foresight 2-hour asset clears **£42.42/kW/yr** at 85% round-trip
   efficiency, with **zero loss-making days in 364**. A quantity that cannot
   lose money is not a forecast of anything. See D26.

---

## Spikes, with probe evidence

All six spikes were run live on 2026-07-30 against keyless endpoints. Probe
scripts live outside the repo; the numbers are reproduced here because they
are the evidence for D19 onwards.

### S1: Capacity Market register, duration-class join

Dataset `capacity-market-register` (NESO CKAN, 8 resources, all
datastore-active, NESO Open Data Licence, metadata modified 2026-07-29). The
two that matter are `Capacity Market Unit (CMU)` (18,066 rows, 79 columns)
and `Components` (29,530 rows).

Storage classification is clean, as plan/06 found. `Storage Facility = 'Yes'`
returns **3,415 CMU rows, 2,958 distinct CMU ids, 1,906 distinct CM unit
names**, of which **1,585 carry an explicit `Storage (Duration Xh)` class**.
The class histogram spans 0.5 h to 12 h; 2 h is the mode at 682 sites.

The join to our 123-unit fleet (`fleet.list` names, parties and MW from
`bess_activity.json`) was measured at three strictnesses. Normalisation:
uppercase, punctuation stripped, corporate and generic tokens removed
(LTD, LIMITED, GMBH, BESS, BATTERY, STORAGE, ENERGY, PROJECT and 40 more),
company-name tokens folded into the name token set.

| rule | matched | ambiguous | unmatched | matched MW |
|---|---|---|---|---|
| any shared token AND (MW within 10% OR company overlap ≥ 0.34) | 51 | 12 | 60 | 2,690 |
| distinctive shared token (site token in ≤ 3 CM records) AND MW within 10% | 26 | 6 conflicting | 91 | 1,230 |
| the strict rule with party tokens folded in | 24 unique | 11 multi (6 with conflicting classes) | 88 | 1,321 |

**The loose rule is measurably wrong, not merely uncertain.** Two of its
matches, visible in the first eighteen rows: `T_TYLNB-1` "Tye Lane BESS"
(58.0 MW) matched "Holly Lane" (57.5 MW) on the single token LANE, and all
four Monk Fryston BMUs (80 MW each) matched one 208 MW site CMU.

**The strict rule tops out at 26 of 123 units (21.1%), 1,230 MW of 6,400 MW
(19.2%).** The binding constraint is not name quality. It is that the CM
register is organised by capacity-market unit and our fleet by BM unit, and
the two do not nest. Measured examples, all live:

- **Kilmarnock South**: our fleet carries six BM units (`T_KILSB-1` to `-6`,
  50.9 to 53.7 MW each). The CM register carries 26 storage CMUs at that
  site across delivery years 2025 to 2029, with duration classes of 1.5 h,
  2 h, 4 h **and** 5 h simultaneously.
- **Blackhillock**: four fleet BM units; CM records of 200 MW at 2 h (2024),
  50 MW at 4 h (2027) and four 20 MW units at 8 h (2029).
- **Pillswood**: two 49.9 MW BM units; CM records showing 2 h in delivery
  years 2022–2024 and 1.5 h in 2025 for the same two names.

**The class is not stable even within one site.** Of the 1,585 CM unit names
carrying an explicit duration class, **159 (10.0%) report a different class
in different delivery years**, and the change is not monotonic: "Wicken"
reports 1.0, 1.5, 1.0, 1.0, 1.5, 1.0 across 2020 to 2026. The duration class
is a de-rating election made per auction, not a physical property of the
asset.

**Conclusion (D23): dropped.** A prefill that is available for a fifth of
the fleet, wrong for a visible fraction of those, and unstable year to year
at the source would silently change every downstream number.

### S2: REPD storage fields

`https://www.gov.uk/api/content/government/publications/renewable-energy-planning-database-quarterly-extract`
resolves the current attachment (the monthly-extract path is now a redirect
to the quarterly one). Current file:
`REPD_publication_Q1_2026.csv`, 4.95 MB, 14,316 rows, **53 columns**,
fetched in 0.4 s.

**There is no MWh field and no duration field.** The only column matching
/MWh|duration|hour/ is `RO Banding (ROC/MWh)`. Capacity is
`Installed Capacity (MWelec)` alone.

Battery rows: 2,605. `Storage Type` splits into Stand-alone Storage 1,833,
Co-located with RE 736 (+2 misspelt), Co-located with fossil fuel plant 33.
Development status Operational: **171 sites, 4,754.6 MW**, which confirms to
the tenth of a MW the 171 / 4,755 figure hard-coded at
`etl/build_bess_revenue.py:103` and in `REPD_CONTEXT`
(`etl/build_bess_activity.py:254`). No refresh is needed.

Useful and unexpected: **171 of 171 operational battery sites carry
X and Y coordinates** (OS grid) and 165 carry a post code. So REPD does hold
location. It does not hold a join. The same tiered fuzzy join scores
**24 of 123 fleet units (20%) confident, 1,026 MW**, with visible false
positives inside that tier: `T_COYLB-1` ("Coylton Greener Grid") and
`T_NLSTB-1` ("Neilston Battery 1") both matched "Liverpool Energy Management
Facility" on operator tokens plus a 50 MW coincidence.

**Conclusion (D25): REPD's role is unchanged.** It stays the cited
denominator and coverage baseline it already is, in prose, unbadged. It
contributes nothing to the calculator.

### S3: TEC register location join

Dataset `transmission-entry-capacity-tec-register`, one resource
(2,214 rows, 16 columns, modified 2026-07-28). Filtering
`Plant Type LIKE '%Storage%'` returns **1,513 rows, 1,387 distinct project
names**, of which only **96 are Built or Under Construction** (1,177 are
Scoping, i.e. the connection queue).

Same strict join rule:

| cohort | confident | multi | unmatched | hit rate |
|---|---|---|---|---|
| 69 `T_` units | 13 | 3 | 53 | **23%** |
| 54 `E_` units | 24 | 2 | 28 | **48%** |

**The register joins better to the distribution-connected half of the fleet
than to the transmission-connected half, which is the exact inverse of what
the calculator needs.** Generation TNUoS applies to transmission-connected
units; those are the ones the join misses.

Two measured reasons:

- **18 of the 69 `T_` units (978.5 MW) carry no descriptive name at all**:
  the Elexon registry name is the BM unit id itself (`T_THURB-1`,
  `T_BLHLB-1` to `-4`, `T_KILSB-1` to `-6`). Zero `E_` units have this
  problem. Folding the party name in (THURROCK STORAGE, ZENOBE
  BLACKHILLOCK) recovered **none** of them, because the MW gate then fails:
  the TEC project is the site (Thurrock Power Station, 300 MW then 750 MW;
  Zenobe Blackhillock, 200 MW then 300 MW) and the BM unit is a slice.
- The 16 `T_` units that do match return a useful `Connection Site`
  (for example "Ocker Hill 275kV Substation", "Coventry 275kV Substation"),
  which is a location string, not a charging zone.

**No substation-to-zone table exists in the open data.** Checked: the
TNUoS dataset's `Onshore Local Circuit Tariffs` resource (4,647 rows) keys
on `Substation_Name` but carries no zone; `Local Substation TNUoS Tariff`
(84 rows) is a voltage and redundancy lookup. The zone geometry does exist
as `gis-boundaries-for-gb-generation-charging-zones`, GeoJSON, 47 kB,
28 features covering GZ1 to GZ27, CRS84, 945 coordinate pairs in total, so a
stdlib point-in-polygon is feasible. What is missing is a defensible
coordinate for each BM unit, and S1/S2/S3 all show the site join cannot
supply one.

One thing that can: the EAC `Results By Unit` table carries a `postCode`
column. Measured over the trailing 365 days, **220 of 238 battery auction
units (92%)** carry a non-null post code, and **86 of the 89 units that
join to our fleet** do, including **42 of the 43 `T_` units**. Values are a
mix of outward codes ("LE14", "SG9") and full codes ("MK43 9AB").

**Conclusion (D24): zone is a user choice from a 27-entry dropdown**, with
the unit's own EAC-registered post code shown beside it as an observed hint
in pick-a-unit mode, and no automatic zone assignment anywhere.

### S4: TNUoS generation tariff table

Dataset `transmission-network-use-of-system-tnuos-tariffs`, resource
**`Onshore Generator Tariffs`** (`ffc0adb8-5426-474e-94a3-a5f3f01a0cdb`),
CSV, datastore-active, keyless, NESO Open Data Licence. 1,161 rows,
11 columns:

    Publication, Year_FY, Published_Date, Zone_No, Zone_Name,
    SystemPeak_£/kW, SharedYearRound_£/kW, NotSharedYearRound_£/kW,
    Residual_£/kW, SmallGenDiscount_£/kW

**Exactly 27 rows per (Publication, Year_FY, Published_Date) triple**, one
per charging zone, with no exceptions in the whole table. Publications are
Final, Draft and Forecast. The current charging year is **FY2027, Final,
published 2026-01-30**; Forecast rows run out to FY2031. Update cadence is
stated by the publisher as quarterly.

FY2027 Final, all 27 zones (£/kW), first and last three shown:

| zone | name | SystemPeak | SharedYR | NotSharedYR | Residual |
|---|---|---|---|---|---|
| 1 | North Scotland | 3.628 | 26.533 | 17.675 | −2.477 |
| 2 | East Aberdeenshire | 5.308 | 14.646 | 17.675 | −2.477 |
| 3 | Western Highlands | 3.678 | 26.123 | 17.386 | −2.477 |
| … | | | | | |
| 25 | Oxfordshire, Surrey and Sussex | −1.335 | −1.530 | −0.136 | −2.477 |
| 26 | Somerset and Wessex | −3.582 | −3.264 | 0.000 | −2.477 |
| 27 | West Devon and Cornwall | −4.327 | −13.296 | 0.000 | −2.477 |

The locational spread is the whole point: the peak element runs from +7.221
(Pembrokeshire) to −4.327 (West Devon and Cornwall), and the shared
year-round element from +26.533 to −13.296. A battery's zone is worth tens
of pounds per kW per year before anything else is decided.

**Measured payload cost: 1,543 bytes for the 27 rows trimmed to the four
elements, plus 633 bytes of zone names.** Under 2.2 kB.

Post-TCR, distribution-connected generation does not pay these tariffs; the
`Embedded Export Tariffs` resource (602 rows, columns `Locational_£/kW`,
`AGIC_£/kW`, `PhasedResidual_£/kW`, `EET(Floored)_£/kW`) is a separate
regime with a floor at zero in the sampled rows. **The calculator shows "not
applicable" for a distribution-connected unit rather than a zero charge**,
and does not attempt embedded export tariffs in v1.

### S5: observed duration floor from B1610

Endpoint: `/datasets/B1610/stream?from=&to=&bmUnit=` on Elexon Insights
(the non-stream `/datasets/B1610` path returns HTTP 404; record this beside
plan/08's WAF traps). Records carry `quantity` in MW per settlement period
and **do go negative for batteries**, so charge and discharge runs are both
visible.

Publication lag, probed at one-day granularity on 2026-07-30: full days
returned through **2026-07-23** (46 rows on the 23rd, 49 on earlier days,
0 from the 24th). That is D−7, matching the ~7-day figure already recorded
at `etl/build_bess_activity.py:134`.

Method probed: over June 2026, sort each unit's periods, and take the
largest continuous same-direction run of metered energy (MWh, at 0.5 h per
period, with a ±0.5 MW dead band). Implied duration floor = run MWh divided
by nameplate MW.

Fifteen units with an S1 ground-truth duration class:

| unit | MW | CM class | max discharge run | implied h | p90 run implied h |
|---|---|---|---|---|---|
| T_OCHLB-1 | 58.0 | 2.0 h | 66.5 MWh | **1.15** | 0.86 |
| T_LKSDB-1 | 105.0 | 1.5 h | 92.8 MWh | **0.88** | 0.67 |
| E_PILLB-1 | 49.9 | 1.5 h | 46.2 MWh | **0.93** | 0.59 |
| E_SKELB-1 | 49.9 | 1.5 h | 43.5 MWh | **0.87** | 0.53 |
| T_WISHB-1 | 51.0 | 2.0 h | 46.5 MWh | **0.91** | 0.40 |
| E_TOLLB-1 | 49.0 | 1.0 h | 20.9 MWh | 0.43 | 0.31 |
| T_CAPNB-1 | 57.0 | 2.0 h | 0 | **0.00** | 0.00 |
| T_WTGTB-1 | 58.0 | 2.0 h | 0 | **0.00** | 0.00 |
| T_SZJNB-1 | 57.0 | 3.0 h | 0 | **0.00** | 0.00 |

Allowing a run to survive one, two or four interrupting half-hours changes
nothing (T_OCHLB-1 stays at 1.15 h at every tolerance; T_WISHB-1 moves from
0.91 to 0.94). The runs are ended by direction reversal, not by gaps.

Fleet-wide, all 123 units, June 2026, 33.7 MB and 16.2 s of fetching:

- **9 units return no B1610 rows at all.**
- **17 units return rows but never exceed 5% of nameplate in any period**
  (914.8 MW). T_CAPNB-1 is literally all zeros across 1,441 periods;
  T_WTGTB-1's largest magnitude in the month is 0.23 MW.
- **97 units (79%) have material metered output.** Across those, the implied
  discharge-hour floor is: min 0.00, p25 0.41, **median 0.81**, p75 0.93,
  max 26.30. **80 of 97 sit below 1.0 h; only 2 reach 2.0 h.**

Against a fleet whose commonest CM duration class is 2 h, a statistic whose
median is 0.81 h is measuring behaviour, not capability. Batteries in
service delivery cycle partially and reverse frequently; the 26.30 h
outlier shows the statistic is not even robust in the other direction.

**Conclusion (D23): dropped, and not deferred.** This is not a "needs more
window" result. The estimator is measuring the wrong thing.

### S6: per-unit revenue aggregates payload

Two grouped `datastore_search_sql` calls against the EAC `Results By Unit`
resources (FY2025 archive plus current), filtered to
`technologyType = 'Batteries'`, grouped by `auctionUnit`, `auctionProduct`
and `postCode` over 2025-07-30 to 2026-07-30: **1,143 rows in 5.1 s and
1,103 rows in 1.8 s**. The `to_char` day bucketing and interval arithmetic
from plan/08 pass unchanged; `EXTRACT` and `date()` remain forbidden.

- **238 distinct battery auction units** earned EAC revenue in the window.
- **89 of them join to our fleet** on plan/08's D13 rule, matching D13's
  cohort count exactly. **34 of the 123 fleet units earned no EAC revenue at
  all** in the trailing year, and the UI must say so rather than showing
  them a zero.
- Split: **43 `T_`, 46 `E_`**.

Per-unit trailing-365-day totals, £/kW/day and annualised:

| statistic | £/kW/day | £/kW/yr |
|---|---|---|
| p10 | 0.0029 | 1.06 |
| p25 | 0.0109 | 3.99 |
| p50 | 0.0276 | 10.07 |
| p75 | 0.0485 | 17.69 |
| p90 | 0.0739 | 26.96 |
| capacity-weighted mean | 0.0293 | 10.70 |

The capacity-weighted mean reproduces plan/08's fleet figure of
+£0.0296/kW/day, which is the cross-check that the two aggregations agree.
**p90 is 25 times p10**: the dispersion is the story, and a single mean
would erase it.

For contrast, the per-day cross-section already shipped in
`eac_unit_spread_gbp_per_kw_day` annualises to p10 **−£6.15**, p50 £8.10,
p90 £35.57 /kW/yr. It is a legitimate daily benchmark and an illegitimate
annual one.

**Payload sizing, measured on the real pull** (minified JSON, 5 dp):

| shape | bytes | per unit |
|---|---|---|
| 365-day £/kW/day by six service families + post code + active days | **9,179** | 103 |
| the same with three trailing windows (30/90/365 d) | 13,255 | 149 |
| the same with 12 monthly values per family per unit | 39,493 | 444 |

Acceptance rates, from the Sell Orders monthly archives: one grouped query
per monthly resource returns **281 kB in 0.8 s** (June 2026,
`85272de8-…`, 2,248,258 source rows collapsed to 2,726). Identified-fleet
offered-versus-executed volume for that month:

| product | rate | product | rate |
|---|---|---|---|
| DCL | 31.3% | PQR | 8.3% |
| DCH | 30.2% | NQR | 7.7% |
| DMH | 21.5% | DRL | 4.6% |
| DML | 17.4% | PBR | 1.1% |
| DRH | 14.5% | PSR | 1.0% |
| | | NBR | 0.4% |
| | | NSR | **0.0%** |

Note the shape of the Sell Orders resources: they archive **monthly**, so a
twelve-month acceptance history is twelve resource ids, resolved at runtime
from `package_show`. Twelve calls, roughly 3.4 MB, roughly 10 s.

---

## Alternatives ruled out, with the evidence

- **A new "Toolkit" tab.** The nav already carries ten buttons
  (`app/index.html:72-81`), five of them GB-only. plan/06's D7 created a tab
  for a workstream with three panels and a header chip; this is one card.
  At phone width an eleventh button pushes the nav to a third row before any
  content renders. Ruled out at D19.
- **Capacity Market duration-class prefill, behind a confidence threshold.**
  Considered seriously, because the threshold is computable. Rejected on the
  numbers in S1: at the only defensible tier it covers 21% of units, and the
  source itself changes its answer for 10% of sites between delivery years.
  A prefill that is present for a fifth of units and silently wrong for some
  of them is worse than an empty field, because the empty field is honest.
- **Observed duration floor from B1610 (S5).** Rejected: median implied
  0.81 h against a 2 h modal market, 26 of 123 units with no usable metered
  signal, and insensitive to every tolerance parameter tried.
- **Point-in-polygon zone assignment from the published GeoJSON.** The
  geometry is small (47 kB, 27 zones, CRS84) and stdlib-tractable. Ruled out
  because no source gives a defensible coordinate per BM unit: REPD has
  coordinates but joins at 20%, TEC has substation names but joins at 23%
  for the units that need it, and EAC post codes would need an external
  postcode-to-coordinate database. Recorded here so it is not
  re-investigated without a new coordinate source.
- **Fleet mean availability revenue multiplied by a win probability.** This
  is the trap the issue's framing invites, and it is quantified in D21. It
  understates by 58%.
- **Balancing Mechanism cashflow as a revenue input.** plan/08's D18
  established that the series is the energy-purchase leg, ranging −0.134 to
  +0.112 £/kW/day with the sign set by whether the fleet charged or
  discharged. Feeding it into an annual cash flow would carry that framing
  error into an NPV. Ruled out at D27.
- **Perfect-foresight arbitrage as the default revenue line.** Measured over
  364 complete days of stored MID prices, the 2-hour perfect-foresight
  margin is positive on **364 days out of 364**. Ruled out as a default at
  D26; kept as an explicitly-labelled ceiling with a user capture rate.
- **Browser storage or URL parameters for the input set.** The app uses
  neither anywhere today (grep for `localStorage`, `sessionStorage`,
  `URLSearchParams`, `location.search`, `location.hash` across `app/js/*.js`
  and `app/index.html` returns nothing). Ruled out at D30.
- **Tax, gearing, and a financing model.** A pre-tax, ungeared, real-terms
  cash flow is defensible with a stated WACC. Anything more invites the
  reader to treat the output as a transaction model. Out of scope.

---

## Resolved decisions

### D19: placement

**Fourth card on the existing GB-only Batteries tab, below the revenue
stack. No new tab.**

- The Batteries tab already holds the activity card and the revenue card
  with its BM sub-section (`app/index.html:556-660`). This card belongs
  beside them: it consumes their data and answers the question they raise.
- Tab weight is the deciding factor. plan/06 D7 created the stress tab for a
  three-panel workstream with a header chip; plan/08 D16 created the
  Batteries tab for two heavy cards. Neither precedent supports a tab for a
  single form.
- Mobile: the card is a two-column grid at desktop width (inputs left,
  results right) collapsing to one column, inputs first, under the existing
  `span-2` card breakpoint. No new responsive machinery.
- Beta label, matching the two cards above it.
- No change to `GB_ONLY_TABS` (`app/js/app.js:186`), which already carries
  `"bess"`.

### D20: badge taxonomy and the one-way rule

The four badge classes are unchanged (`app/css/style.css:14-21`). This card
introduces no fifth class.

| element | badge | note |
|---|---|---|
| the unit's own trailing-window £/kW/yr, per family and percentile | **Observed** | published accepted quantity × published clearing price × published window, aggregated per unit. |
| per-product acceptance rates | **Observed** | executed ÷ offered volume from the EAC Sell Orders resources. |
| unit nameplate, connection type, EAC post code, first-active date | **Observed** | registry and EAC fields, unaltered. |
| TNUoS zone tariff elements | none: cited reference data in prose | plan/06 Workstream C precedent; the charging year and publication date are shown. |
| wholesale arbitrage ceiling from stored MID | **Estimated** | perfect-foresight construct over observed prices. See D26. |
| every user input, and every figure derived from one | **Assumption** | including the whole annual cash flow, NPV, IRR, payback and LCOS. |

**The one-way rule, stated so it can be tested.** The calculator reads from
`Data` and from its own payload; it writes to nothing. No calculator output
is stored, cached, exported into another panel's series, or included in
`meta.json`, `manifest.json`, the overnight summary, or any CSV other than
its own. The Python mirror (D32) recomputes from inputs, never from a stored
result.

### D21: availability revenue basis, and the double-count trap

**The revenue side uses the per-unit trailing-window distribution, with the
user selecting a percentile. It never multiplies a fleet average by a win
probability.**

Measured on the S6 pull:

- capacity-weighted cohort mean: **£0.0293 /kW/day**
- mean participation, the share of the 365 days on which a unit won any EAC
  volume: **42%** (p10 16%, median 45%, p90 65%)
- mean × participation: **£0.0124 /kW/day, which is 42% of the correct
  figure**

**The £/kW/day figure already averages the days a unit won nothing.** It is
total revenue over total capacity over total days, with the zeros in the
denominator. Applying a participation or win-rate multiplier on top removes
those days a second time and understates the result by 58%. This trap is
documented in the methodology entry and in a note under the percentile
control, because it is the single most natural mistake a reader can make
with these two published numbers side by side.

Percentile selection is offered as p10 / p25 / p50 / p75 / p90 over the
**cross-unit** distribution of trailing-window revenue, defaulting to p50,
with the annual £/kW/yr shown next to the control. In pick-a-unit mode the
selected unit's own position in that distribution is shown, and the default
switches to that unit's own observed figure.

Per-product toggles: the six service families (DC, DM, DR, BR, QR, SR) can
each be switched off, which recomputes the £/kW/yr from that unit's or that
percentile's family components. Turning a family off is an assumption about
what the asset will contract for, not a claim about the data.

### D22: acceptance rates ship as context, never as an input

Shown as a small read-only table beside the availability control, with the
window and the caveat that these are **volume-weighted offer outcomes for
the identified fleet, not the modelled unit's own probability of winning**.
They are never multiplied into anything (see D21). Their value to the reader
is calibration: a 0.0% NSR rate and a 31.3% DCL rate explain the shape of
the family mix better than any prose.

Sourced per D33 from the monthly Sell Orders archives, twelve resource ids
resolved at runtime from `package_show?id=eac-auction-results` by matching
`^NESO Response-Reserve Sell Orders \d{6}`.

### D23: duration, and every other physical parameter, is a plain input

**No duration prefill ships, in any mode, in any phase.** S1 and S5 both
fail on measurement. The field is a user input in MWh (with the implied
hours shown live as MWh ÷ MW), badged Assumption, with no default beyond a
neutral 2.0 h shape that the user must confirm before results render.

The same holds for CAPEX (£k/MW), OPEX (£k/MW/yr), WACC, cycles per day,
degradation rate and round-trip efficiency. **The design deliberately
publishes no cost defaults sourced from anywhere.** Placeholder values exist
so the form is usable, they are labelled "your assumption, no source", and
the results panel stays empty until the user has touched the CAPEX field at
least once. A dashboard whose stated principle is no fabricated data cannot
ship a market CAPEX figure it did not measure.

### D24: location and the TNUoS zone

**A 27-entry zone dropdown, populated from the shipped tariff table, with no
automatic assignment.**

- The zone list, names and four tariff elements come from the vendored
  FY2027 Final table (S4), carried in the calculator's own payload at a
  measured 2.2 kB.
- **Connection type is observed and drives applicability**: a `T_` unit gets
  the zone control; an `E_` unit gets "not applicable (distribution
  connected)" with a one-line note that embedded generation sits outside
  generation TNUoS post-TCR, and a TNUoS line of zero in the cash flow.
  In hypothetical mode the user picks transmission or distribution.
- In pick-a-unit mode, the unit's **EAC-registered post code** is displayed
  beside the dropdown as an observed hint (available for 42 of the
  43 transmission-connected cohort units, S3). It is a hint, not a
  selection: the app never infers a zone from it.
- The annual update path is one line in the ETL: re-resolve the resource,
  take the **highest `Year_FY` with `Publication = 'Final'`**, and write its
  27 rows plus `Published_Date` into the payload. Publication cadence is
  quarterly. A tripwire asserts exactly 27 zones and raises otherwise, since
  every historical triple in the table has exactly 27.

### D25: REPD

**Unchanged from plan/06 and plan/08.** Cited denominator and coverage
baseline, in prose, unbadged, vintage stated. S2 confirms the shipped
figure to the tenth of a MW and confirms the absence of any energy-capacity
field. No calculator role.

### D26: wholesale arbitrage as an observed ceiling

**Ships in v2 as an Estimated ceiling with an explicit capture rate, never
as an expected revenue.**

Computed from `series_hh.json` prices already stored (364 complete days,
2025-07-30 to 2026-07-29, days with at least 46 populated periods). For a
duration of d hours, each day contributes the mean of its top 2d half-hourly
prices and the mean of its bottom 2d:

| d | mean top | mean bottom | mean spread | margin at 85% RTE | one cycle/day |
|---|---|---|---|---|---|
| 1 h | £122.76 | £51.43 | £71.33 | £62.25 /MWh | £22.72 /kW/yr |
| 2 h | £120.79 | £53.28 | £67.51 | £58.10 /MWh | £42.42 /kW/yr |
| 4 h | £116.22 | £56.45 | £59.77 | £49.81 /MWh | £72.73 /kW/yr |
| 8 h | £107.94 | £62.61 | £45.33 | £34.28 /MWh | £100.10 /kW/yr |

Daily margin distribution at d = 2 h: p10 £17.3, p25 £26.6, median £41.0,
p75 £83.1, p90 £118.5 per MWh, and **zero negative days in 364**.

Three honesty constraints, all enforced in the UI:

1. It is labelled **"perfect-foresight ceiling"** everywhere, never
   "arbitrage revenue". The zero-loss-day figure is quoted in the caption:
   a construct that never loses money in a year is not a revenue estimate.
2. A **capture rate** input (0 to 100%, default well below 100 and requiring
   the user to set it) multiplies the ceiling. The result is Estimated and
   its provenance line reads "observed price spread × your capture rate".
3. MID is a market-wide index, not a transacted price, and
   `methodology.md` already flags that it diverges in stressed periods
   (plan/08 D15 rests on the same point). That caveat is repeated verbatim
   here rather than softened.

Manual override: a single £/MWh spread input replaces the observed ceiling
entirely, mirroring the coal-price override at `app/index.html:373`, and
flips the provenance chip from Estimated to Assumption.

### D27: Balancing Mechanism cashflow

**Excluded from the engine. Shown as context, never summed.** This mirrors
plan/08 D18 exactly and for the same measured reason. In pick-a-unit mode
the card shows the selected unit's BM cashflow alongside, under its own
heading, with D18's framing sentence. It contributes nothing to the cash
flow, the NPV, the payback or the LCOS.

### D28: saturation and entry year

**One explicit annual cannibalisation input, applied to both the
availability and the arbitrage terms, plus the percentile choice. No
forecast, no curve, no scenario library.**

The honest position is that the dashboard has no forward view and will not
acquire one for this card. What it can do is let the reader express theirs
in one number and see the consequence. The control is a percentage per year
(default 0, so the user opts in to a view rather than inheriting one), and
the caption says plainly that it is a user assumption about future market
saturation and that the calculator has no basis for any particular value.

The percentile control (D21) carries the entry-year question in the
direction the data supports: a unit entering a saturated market is a unit
landing lower in the cross-unit distribution, and that is a choice the
reader makes with the p10-to-p90 range visibly in front of them.

Commissioning date sets **year 1 of the cash flow** and nothing else. There
is no attempt to model a build profile, a ramp, or a partial first year
beyond pro-rating year 1 by the fraction of that year remaining after the
commissioning date.

### D29: surfacing named units' observed revenues

**Approved by the owner 2026-07-30, as proposed. Pick-a-unit mode ships in
v2 with the selected unit's own observed revenue history, and the caption
says what that means.**

The argument, recorded because the approval rests on it:

- **Every input is already public.** The EAC results table publishes
  `auctionUnit`, `executedQuantity` and `clearingPrice` per delivery window
  under an open licence; the Elexon registry publishes the nameplate. The
  multiplication is arithmetic over two open datasets, and any reader can
  reproduce it.
- The 89-unit cohort is exactly the set that plan/08 D13 already describes
  in aggregate, with its coverage figures published.
- Without it, pick-a-unit mode is a nameplate lookup, and the calculator's
  central claim (anchored on what this specific asset actually earned)
  disappears.

**The visibility step-up, stated honestly rather than argued away.** Moving
from a p10-to-p90 band with no unit named to a named, searchable per-unit
revenue figure is a real change in what the dashboard does, and plan/08's
"Alternatives ruled out" explicitly declined it at the time. Three things
are different now: the question being answered is the user's own asset case
rather than a league table; the figure is one trailing-window aggregate
rather than a time series of commercial performance; and the surface is a
form the reader drove, not a chart that ranks operators. The card carries no
ranking, no sort-by-revenue, no top-N list, and no download of the per-unit
table (D31).

**Fallback, not taken, recorded so the decision stays reversible without a
redesign**: percentile-only mode, in which the user picks a percentile and
the unit picker is limited to prefilling nameplate and connection type. The
engine is unchanged and the card still stands. Because the disclosure lives
entirely in v2's `units` block (D33), reverting to this fallback later is
one payload block and one UI mode, not a rebuild.

### D30: input form UX inside the no-storage rule

- **Session-only, in memory, in `State`.** A new `State.calc` object beside
  `State.assumptions`, with a `setCalc(key, value)` mirroring
  `setAssumption` (`app/js/state.js:42-45`). Defaults restore on reload,
  which is the documented behaviour of the whole app
  (`app/js/state.js:1-3`).
- **No browser storage of any kind**, matching the rest of the app.
- **No URL parameter state.** Encoding a dozen assumptions in a shareable
  link would create exactly the artefact the design is trying not to
  create: a link that looks like a published case for a named asset. It is
  also the one mechanism that could carry a user's assumptions off their
  own machine. Not built, and a test asserts the source contains no
  `URLSearchParams` or `location.search` reference.
- **A single "Reset to defaults" button** clears the whole input set back to
  placeholders and clears the results panel. Individual fields carry no
  per-field reset; the source chip (below) already shows what has been
  touched.
- **Provenance chip per field.** Every input renders a small chip reading
  `observed`, `reference` or `assumption`, and an observed prefill that the
  user edits flips to `edited`. The prefill hierarchy is: observed payload
  value, then cited reference table, then placeholder assumption. The chip
  is how the UI answers "where did this number come from" without a legend.
- **Results render only when the required inputs are present** (power,
  energy, life, WACC, CAPEX). Missing inputs produce a named list of what is
  missing, not a zero.

### D31: CSV export

**One export, numeric only: the annual cash-flow table.** Columns:

    year, capex_gbp, availability_gbp, arbitrage_gbp, opex_gbp,
    tnuos_gbp, net_cashflow_gbp, discounted_cashflow_gbp,
    cumulative_discounted_gbp, discharged_mwh, usable_mwh

Plus a header comment block carrying the inputs as `# key=value` lines, the
selected percentile, the tariff charging year, and the
illustrative-economics sentence.

This obeys `Metrics.toCsv`'s standing rule (`app/js/metrics.js:325-341`):
every exported value is a number, an ISO date or a closed token. **No unit
name, party name or site name is ever exported**, which is the same rule the
BMU snapshot table already applies at `app/index.html:659-660` and which
keeps D29's step-up bounded. The per-unit revenue table itself is not
exportable.

### D32: engine location and the Python mirror

**Pure functions in `app/js/metrics.js`, mirrored by
`ops/bess_calculator_figures.py`, with a parity test.**

This follows the `ops/merit_panel_figures.py` convention exactly, including
its reasoning: a Python module that recomputes the card's figures from the
same inputs, with `js_round` reproducing `Number.prototype.toFixed` binary
semantics (`ops/merit_panel_figures.py:39-49`), and a test suite
(`tests/test_merit_panel_figures.py`) that pins the JS output captured in a
real browser as the oracle. The header comment carries the same "MIRRORS
app/js/metrics.js … if those change, change this" instruction.

New exported functions on `Metrics`: `bessCashflow`, `npv`, `irr`,
`simplePayback`, `lcos`, `arbitrageCeiling`, `tnuosCharge`. All pure, all
null-safe, none touching the DOM or `State`.

### D33: payload shape, phase split and retention

**A new file, `app/data/bess_units.json`, lazily fetched, shipping in v1
with the two blocks v1 needs and growing additively in v2.**

Which block exists in which phase, stated once so the payload section, D34
and the ETL cannot drift apart:

| block | v1 | v2 | measured size |
|---|---|---|---|
| `window`, `built_at`, `schema`, `source` | yes | yes | negligible |
| `percentiles` (cross-unit distribution of trailing-window £/kW/day) | **yes** | yes | ~0.2 kB |
| `tnuos` (27 zones, elements, charging year) | **yes** | yes | 2.2 kB |
| `units` (per-unit aggregates, 123 entries) | no | **yes** | 9.2 kB |
| `acceptance` (offered vs executed, per product, per month) | no | **yes** | ~6 kB |

**Rationale for putting v1's percentiles and zone table here rather than in
`bess_revenue.json`.** Both blocks are calculator inputs and nothing else,
and both are needed on the same first render of the same card, so they
belong behind one lazy fetch rather than split across an eager file and a
lazy one. `bess_revenue.json` is eagerly fetched on every page load, is a
day-axis columnar structure built for a chart, and is the observed panel's
payload: adding a zone tariff table to it would put reference data for a
user-assumption card inside the file that feeds an Observed chart, which is
exactly the leakage D20's one-way rule exists to prevent. It would also make
every reader of every tab pay for bytes only the calculator uses. v1 needs a
small ETL change either way, because the shipped per-day spread cannot be
annualised (S6), so the choice is not between change and no change; it is
between one new small lazy file and a schema addition to the busiest payload
in the repo. The v2 additions are new top-level keys, so v2 is an append,
not a migration, and `schema` stays at 1.

Measured content, from the real pull: 9,179 bytes for the 89-unit
trailing-365-day block, roughly 6 kB for the acceptance-rate table and
2.2 kB for the zone tariffs. **Budget: 40 kB hard, applying to both
phases**, against roughly 2.5 kB built at v1 and roughly 18 kB at v2. That
absorbs a doubling of the cohort and the three-window variant (13.3 kB)
without a redesign. The 12-monthly-values variant (39.5 kB) is explicitly
out of budget and out of scope.

Retention: the trailing window is recomputed whole on each run, so there is
no append or merge logic and no cursor. Retention is 365 days by
construction.

### D34: phasing

Three phases, each independently shippable and independently useful.
**Amended 2026-07-31 after owner review: a v1.5 batch now sits between v1
and v2** (see the v1.5 entry below). The phase count is four; the v2 and v3
contents are unchanged apart from the three items v1.5 takes from v2.

**v1: hypothetical mode and the engine.** The card, the input form, the
engine, `etl/build_bess_units.py` writing `bess_units.json` with its
`percentiles` and `tnuos` blocks only (D33), the percentile-based
availability revenue reading that `percentiles` block, the zone tariff
table, the CSV export, the methodology and glossary entries, and the Python
mirror with its parity test. **No `units` block, no `acceptance` block, no
pick-a-unit mode, no arbitrage.** Shippable because a percentile of the
observed cross-unit distribution is a complete revenue anchor on its own.

Note for the implementer: v1's ETL already computes the full per-unit
aggregation internally, because that is what the percentiles are computed
from. v1 simply does not write it out. v2 is therefore two extra writes and
one extra fetch (the monthly Sell Orders resources), not a rebuild.

**v1.5: the arbitrage ceiling, family-level percentiles, the discounting
convention and the Excel export.** Added 2026-07-31 after owner review, and
underway. Four items, none of which needs the `units` block or any per-unit
disclosure:

1. **D26's arbitrage ceiling, pulled forward from v2**, with its capture
   rate, its manual spread override and all three of D26's honesty
   constraints intact. `s_hi` and `s_lo` come from the stored half-hourly
   MID prices, not from the per-unit payload, so nothing about D29 is
   engaged by shipping it early.
2. **Family-level percentiles, pulled forward from v2.** The `percentiles`
   block gains the six-family split, so D21's family toggles work in
   hypothetical mode without the `units` block. The split is published as
   the family components of the rank-representative unit at each
   percentile, not as six independently-ranked family percentiles: only the
   first definition sums back to the published total, and D36's check row
   in the workbook asserts exactly that.
3. **The discounting convention option**, mid-year by default, with the
   end-of-period alternative and the year-1 stub discounted at its own
   midpoint.
4. **The Excel DCF export**, D35 to D40 below.

**Pick-a-unit mode and the per-unit payload stay in v2**, unmoved. The
`units` block, the `acceptance` block, the per-unit BM cashflow panel and
every part of D29's disclosure step-up are untouched by this re-phase.

**v2: the unit picker.** Adds the `units` and `acceptance` blocks to the
same file, pick-a-unit mode with its prefills and provenance chips, and the
per-unit BM cashflow context panel. This is the phase that carries D29's
per-unit disclosure, so it can be held without holding v1 or v1.5. The D26
arbitrage ceiling moved to v1.5 and is no longer part of this phase.

**v3: colocation. Held.** Solar or wind colocation changes the revenue
stack, the TNUoS treatment and the connection economics simultaneously, and
REPD's 736 co-located battery rows (S2) are a site-level planning record
with no BM unit and no split of capacity between the technologies. Not
designed here. Revisit trigger: a source that attributes metered output or
contracted capacity between the co-located technologies at BM unit level.

---

## The engine, written out

All arithmetic is **real terms, pre-tax, ungeared**, with no residual value
and no augmentation capital expenditure. Every simplification is stated on
the card and in the methodology entry rather than buried here.

### Inputs

| symbol | input | unit | source class |
|---|---|---|---|
| `P` | power | MW | observed in pick-a-unit mode |
| `E` | energy | MWh | assumption (D23) |
| `d` | duration, `E / P` | h | derived, displayed live |
| `y0` | commissioning date | date | observed proxy in pick-a-unit mode (first-active date) |
| `N` | useful life | years | assumption |
| `T` | calculation period, `T ≤ N` | years | assumption |
| `C` | capital cost | £k/MW | assumption |
| `O` | fixed operating cost | £k/MW/yr | assumption |
| `r` | discount rate (WACC) | fraction | assumption |
| `c` | cycles per day | count | assumption |
| `δ` | energy degradation | fraction/yr | assumption |
| `η` | round-trip efficiency | fraction | assumption |
| `a` | availability revenue, from percentile or unit | £/kW/yr | observed |
| `s_hi`, `s_lo` | mean top-2d and bottom-2d half-hourly prices | £/MWh | observed |
| `k` | arbitrage capture rate | fraction | assumption |
| `γ` | annual cannibalisation | fraction/yr | assumption |
| `z` | zone tariff elements | £/kW | reference |
| `f` | annual load factor for TNUoS | fraction | derived, editable |

### Year-by-year build-up

For year `n` from 1 to `T`, with `g = (1 − γ)^(n−1)`:

    usable energy      E_n  = E × (1 − δ)^(n−1)
    availability       A_n  = a × 1000 × P × g
    discharged energy  Q_n  = 365 × c × E_n
    arbitrage margin   M_n  = Q_n × (s_hi − s_lo / η) × k × g
    operating cost     X_n  = O × 1000 × P
    network charge     G_n  = z_total(f) × 1000 × P   (0 if distribution)
    net cash flow      CF_n = A_n + M_n − X_n − G_n

Year 1 is pro-rated by the fraction of the calendar year remaining after
`y0`. Capital cost is a single outflow at time zero: `C0 = C × 1000 × P`.

Four things this deliberately does not do, each stated on the card:

- **Availability revenue scales with power, not with energy.** EAC
  availability is paid per MW of contracted capacity, so degradation does
  not reduce it in this model. A real degraded asset eventually fails a
  product's minimum-duration requirement and loses access; that cliff is not
  modelled, and the note says so.
- **The arbitrage margin uses the same two prices every year**, scaled only
  by `γ`. There is no price forecast and none is implied.
- **Operating cost is flat in real terms.** No escalation input, because an
  escalation on top of a real-terms discount rate is the commonest way to
  double count inflation.
- **Cycles per day are constant.** No seasonality, no availability factor
  beyond `k`.

### TNUoS

    z_total(f) = SystemPeak
               + f × (SharedYearRound + NotSharedYearRound)
               + Residual

with `f` defaulting to `c × d / 24` (a 2-hour asset cycling once a day
defaults to 8.3%) and editable. The published elements are shown
individually beside the result, with the charging year and publication date.

**Stated simplification**: NESO's charging methodology applies the
year-round elements with sharing and load-factor rules set out in the CUSC,
and the exact charge for a specific asset comes from the published Statement
of Use of System Charges. This is a zone-level indication using the
published tariff elements, not a tariff calculation, and the card says so
in one sentence with a link to the source dataset. The small-generator
discount column is carried in the payload and not applied.

### Outputs

    NPV      = −C0 + Σ_{n=1..T} CF_n / (1 + r)^n

    IRR      = the r* solving NPV(r*) = 0, by bisection on [−0.99, 1.50],
               100 iterations, tolerance 1e−9; null when NPV does not
               change sign across the bracket (which is the common case for
               a cash flow that never repays, and must render as "no IRR",
               never as 0%)

    payback  = the smallest n with Σ_{m=1..n} CF_m ≥ C0, linearly
               interpolated inside year n; null when never reached
               (undiscounted, and labelled "simple" for that reason)

    LCOS     = ( C0 + Σ_n (X_n + G_n + charging_n) / (1+r)^n )
               ÷ ( Σ_n Q_n / (1+r)^n )

               charging_n = Q_n / η × s_lo

LCOS is labelled **indicative** and its two discretionary choices are stated
next to it: charging energy is valued at the observed bottom-of-day mean
price, and the discharged-energy denominator is discounted at the same rate
as the costs.

---

## Payload: `app/data/bess_units.json`

**The file ships in v1 and grows additively in v2.** Blocks are marked `[v1]`
or `[v2]` below and the phase table under D33 restates the split, so an
implementer never has to infer it. Every v2 block is a new top-level key: no
v1 key changes shape, and `schema` does not bump.

```jsonc
{
  "built_at": "2026-07-30T…",                                       // [v1]
  "schema": 1,                                                      // [v1]
  "source": "NESO Data Portal EAC auction results (Results By Unit and Sell Orders) joined to the Elexon BM Unit registry; NESO TNUoS Onshore Generator Tariffs.",

  "window": { "from": "2025-07-30", "to": "2026-07-30", "days": 365 },  // [v1]

  // [v1] cross-unit distribution of per-unit trailing-window total
  // £/kW/day, computed inside the ETL from the same per-unit aggregation
  // that v2 publishes in full. This is the ONLY revenue block v1 needs:
  // the percentile control reads it directly.
  "percentiles": { "p10": 0.0029, "p25": 0.0109, "p50": 0.0276,
                   "p75": 0.0485, "p90": 0.0739,
                   "mean_cap_weighted": 0.0293 },

  // [v1] D24: vendored, 27 rows, from the highest Final charging year
  "tnuos": {
    "year_fy": 2027,
    "publication": "Final",
    "published": "2026-01-30",
    "zones": [
      { "n": 1, "name": "North Scotland",
        "peak": 3.628, "yr_shared": 26.533, "yr_notshared": 17.675,
        "residual": -2.477, "small_gen_discount": 0.0 }
      // … 26 more
    ]
  },

  // [v2] 89 units of the 123-unit identified fleet earned EAC revenue in
  // the window; the other 34 are present with "f": {} and "t": 0 so the UI
  // can say "no availability revenue in the window" rather than showing a
  // zero that looks like a measurement.
  "units": {
    "T_OCHLB-1": {             // real values from the S6 pull
      "mw": 58.0,              // registry nameplate
      "conn": "T",             // T = transmission, E = distribution
      "pc": "DY4 0PY",         // EAC-registered post code, hint only
      "first": "2025-05-26",   // first active day, commissioning proxy
      "d": 98,                 // days on which any EAC volume was won
      "f": { "DC": 0.00076, "DM": 0.0, "DR": -0.00304,
             "BR": 0.00243, "QR": 0.01065, "SR": 0.00082 },  // £/kW/day
      "t": 0.01163             // total £/kW/day
    }
    // … 122 more
  },

  // [v2] identified-fleet offered vs executed volume, per product, per month
  "acceptance": {
    "window": ["2025-08", "…", "2026-07"],
    "products": { "DCL": [0.313, "…"], "NSR": [0.000, "…"] }
  }
}
```

Notes on the shape:

- **Six family keys, not twelve product keys.** Unlike plan/08's day series,
  where DRH and DRL routinely carry opposite signs on the same day and must
  stay separate, a trailing-year aggregate per unit is only ever consumed as
  a family total in the cash flow. Measured at 9,179 bytes with families;
  twelve products would roughly double the per-unit cost for a resolution
  the engine does not use.
- **All 123 fleet units are present**, including the 34 with no EAC revenue.
  Absence in the payload and zero revenue are different facts and the UI
  must be able to tell them apart.
- `first` is plan/08's first-appearance commissioning proxy, left-censored
  the same way and labelled as a proxy in the UI.
- **Measured totals: roughly 2.5 kB at v1** (2.2 kB zones plus the
  percentile block, keys and metadata) **and roughly 18 kB at v2** (adding
  9.2 kB of units and ~6 kB of acceptance rates), **against a 40 kB budget**
  that is set once and applies to both phases.

**Fetch policy: lazy, from v1.** Requested on the first render of the
calculator card, cached in memory for the session, following the event-slice
precedent (plan/06 D8). The eager page payload is unchanged in both phases,
so plan/08's 0.15 MB revenue budget and plan/06's 0.5 MB stress budget are
untouched.

---

## ETL design: `etl/build_bess_units.py`

New module, shipping in v1, importing `http` / `_atomic_write` / `OUT_DIR`
from `build_dataset` exactly as `build_bess_revenue.py` does. No new helper
changes are needed: the two EAC pulls are grouped server-side and small
(1,143 and 1,103 rows), and nothing here needs the gzip flag.

**Phase split inside this module (D33).** Steps 1, 2, 3, 5 and 6 ship in v1;
step 4 and the two extra writes in step 6 ship in v2. The per-unit
aggregation in step 2 is v1 work regardless, because the percentiles are
computed from it. v1 writes `percentiles` and `tnuos`; v2 additionally
writes `units` and `acceptance`.

1. `fetch_registry()` **[v1]**: reuse the extended registry helper plan/08 introduced,
   for nameplate and `elexonBmUnit` prefix.
2. `fetch_unit_revenue(day_from, day_to)` **[v1]**: one `datastore_search_sql` per
   `Results By Unit` resource covering the window, grouped by
   `auctionUnit`, `auctionProduct`, `postCode`, summing
   `executedQuantity * clearingPrice` and counting distinct
   `to_char("deliveryStart", 'YYYY-MM-DD')`. **Never `EXTRACT(...)` or
   `date(...)`, both HTTP 403** (plan/08's verified WAF trap).
3. `assert_windows()` **[v1]**: reuse plan/08's per-product window-length
   assertion so the family aggregation cannot silently misprice a changed
   product.
4. `fetch_acceptance(months)` **[v2]**: resolve the monthly Sell Orders
   resource ids from `package_show`, one grouped query each over
   `auctionUnit`, `auctionProduct`, `status`, summing `quantity`. Restrict
   to cohort units. Twelve calls, ~3.4 MB, ~10 s measured.
5. `fetch_tnuos()` **[v1]**: one grouped query on the Onshore Generator
   Tariffs resource for the highest `Year_FY` with
   `Publication = 'Final'`. **Assert exactly 27 rows** and raise otherwise.
6. `build_and_write()` **[v1 writes `percentiles` and `tnuos`; v2 adds
   `units` and `acceptance`]**: join, compute per-unit £/kW/day per family,
   compute the cross-unit percentiles, write with `_atomic_write`.

**Tripwires that raise rather than ship a wrong number** (all four apply
from v1, since all four are computable from v1's internal aggregation):

- the cohort must be non-empty and its unit count within 50% to 150% of the
  count in `bess_revenue.json`, since the two are built from the same rule;
- the capacity-weighted mean must agree with `bess_revenue.json`'s
  window mean to within 10% (measured agreement today: 0.0293 against
  0.0296);
- the zone table must carry 27 rows and a `Published_Date`;
- the payload must serialise under 40 kB.

**Refresh wiring**: one new non-fatal step in `ops/refresh.py` after the
BESS revenue step (`ops/refresh.py:219-222`), so a NESO CKAN outage logs a
warning and leaves the previous payload in place. The card renders
stale-but-labelled rather than empty.

**Manifest**: self-update with sha256 and bytes, and a version bump, via the
pattern at `build_bmu_snapshot.py:178-186`.

**`meta.json` and Methodology**: one new source row in v1 (NESO TNUoS
Onshore Generator Tariffs, NESO Open Data Licence, charging year FY2027
Final) and one new coverage row in v1 (cohort units behind the percentiles,
window start and end), with the per-unit disclosure note added in v2.

---

## UI shape

Fourth card on the Batteries tab, `span-2`, beta label, badges per D20.

**Header**: title "Profitability calculator", Assumption and Estimated
badges, and the standing sentence: *"Illustrative economics from the
assumptions you enter, anchored on what comparable units observably earned.
Not investment advice, not a valuation, and not a forecast."*

**Mode control**: two radio buttons, "Hypothetical asset" and "Pick a unit".
Picking a unit prefills nameplate, connection type, post-code hint,
first-active date and the unit's own availability revenue; every other
field stays an assumption.

**Input column**, grouped into four blocks, each field carrying its
provenance chip (D30):

1. *The asset*: power MW, energy MWh (implied duration shown live),
   commissioning date, useful life, calculation period.
2. *Costs and finance*: CAPEX £k/MW, OPEX £k/MW/yr, WACC, connection type
   and TNUoS zone (or "not applicable"), load factor for TNUoS.
3. *Operation*: cycles per day, round-trip efficiency, degradation per year.
4. *Market view*: availability percentile with the six family toggles [v2:
   the family split arrives with the `units` block; v1 offers the
   percentile control only], and
   cannibalisation per year. **v2 adds** the acceptance-rate context table
   and the arbitrage capture rate with its observed ceiling and manual
   spread override.

At v1 the mode control renders with "Pick a unit" disabled and a one-line
note that per-unit anchoring is coming, rather than being absent: the card
should not silently change shape between releases.

**Results column**: four headline figures (NPV, IRR, simple payback,
indicative LCOS), a stacked annual cash-flow chart (availability, OPEX,
TNUoS, plus arbitrage from v2, with the cumulative discounted line on a
secondary axis), and the CSV export button. The `arbitrage_gbp` CSV column
(D31) exists from v1 and is zero until v2, so the export schema does not
change between phases.

**Caption**: the window and cohort (89 units of the identified fleet, plan/08
D13's rule and coverage), the tariff charging year and publication date, the
percentile in use, and the one-line statement that every figure below the
inputs is the user's own assumption arithmetic.

**Empty and error states**: missing required inputs list themselves by name;
a unit with no EAC revenue in the window says so explicitly; a cash flow
that never repays renders "no payback within N years" and "no IRR", never a
zero.

**Mobile**: single column, inputs above results, headline figures in a
two-by-two grid.

---

## Test plan

stdlib `unittest`, house rule, with fixtures under `tests/fixtures/`.

1. **NPV, IRR, payback and LCOS against hand-computed cases.** A three-year
   toy cash flow with values chosen so every figure is exact by hand.
2. **IRR edge cases.** A cash flow that never repays returns null, not 0%;
   a cash flow with a negative IRR inside the bracket returns it; a bracket
   with no sign change returns null.
3. **Degradation and cannibalisation compounding.** Assert year-5 usable
   energy equals `E × (1 − δ)^4` exactly and that `γ` is applied to
   availability and arbitrage but not to OPEX.
4. **Arbitrage margin formula.** Assert `(s_hi − s_lo / η)` and not
   `(s_hi − s_lo) × η`; the two differ by 1.3% on the measured d = 2 h
   figures (£58.11 against £57.38 per MWh) and the gap widens as efficiency
   falls and as the charge-leg price rises.
5. **TNUoS.** A distribution-connected input returns not-applicable, not
   zero, and the two are distinguishable in the output. A zone-1 case
   reproduces the FY2027 Final elements. A payload with 26 zones raises.
6. **Percentile selection.** The p10 of the fixture distribution is the p10,
   including the case where the cohort is small enough that the floor index
   matters, matching `Metrics.quantile`'s existing convention
   (`app/js/metrics.js:295-299`).
7. **The double-count guard.** A regression test asserting that the engine's
   availability term is `a × 1000 × P` and does not reference any
   participation or acceptance field, so the D21 trap cannot be reintroduced
   by a later change. Implemented as a unit test on the computed value with
   a fixture whose participation field is deliberately 0.42.
8. **JS-to-Python parity.** `ops/bess_calculator_figures.py` reproduces
   `Metrics.bessCashflow` and the four headline figures for three fixture
   cases captured in a real browser, mirroring
   `tests/test_merit_panel_figures.py` including its `js_round` semantics.
9. **No-storage, no-URL-state guard.** A source-level assertion that the
   calculator's JS contains none of `localStorage`, `sessionStorage`,
   `URLSearchParams`, `location.search` or `location.hash`. This is the same
   family of test as plan/08's "the generated SQL contains no `EXTRACT(`"
   check: a static assertion that cannot flake.
10. **CSV export is numeric.** Every field in the exported rows parses as a
    number, an ISO date or a member of a closed token set, and no unit,
    party or site name appears anywhere in the output.
11. **ETL tripwires.** Fixtures for the cohort-count band, the mean-agreement
    band, the 27-zone assertion and the 40 kB budget, each raising.
12. **Payload budget.** The built fixture serialises under 40 kB.

---

## Out of scope, restated explicitly

Carried forward from plan/06 and plan/08 and reaffirmed. Do not
re-investigate without new data.

- **Forecasting of any kind.** No price forecast, no revenue forecast, no
  auction-clearing forecast, no capacity-market projection. The
  cannibalisation input is the user's view, not the app's.
- **Consulting-grade backcasting.** No perfect-foresight dispatch history,
  no "what this unit could have earned", no optimisation.
- **State of charge, cycling depth, and augmentation.**
- **Asset-level P&L and trading-strategy reconstruction.** #24's original
  exclusion stands in full.
- **Anything presented as advice, valuation, or a transaction model.** No
  tax, no gearing, no debt schedule, no sensitivity-to-terms analysis.
- **Capacity Market revenue.** The register carries no BM unit field
  (plan/06, verified 2026-07-11) and its storage duration classes are a
  de-rating election that changes between delivery years for 10.0% of sites
  (S1, verified 2026-07-30). Neither a revenue line nor a prefill.
- **REPD as anything but a cited denominator.** No MWh field exists (S2,
  53 columns, verified 2026-07-30).
- **Automatic TNUoS zone assignment.** No coordinate source joins to BM
  units well enough (S1, S2, S3). The GeoJSON zone geometry is recorded as
  available should that ever change.
- **Embedded export tariffs and the distribution charging regime.** Shown as
  "not applicable" for distribution-connected units, not modelled.
- **Colocation.** Held at D34 v3.
- **Balancing Mechanism cashflow inside the engine.** Held at D27, mirroring
  plan/08 D18.
- **Aggregator and VLP portfolio economics.** Structurally outside a per-kW
  metric, as plan/08 D13 established; 53% of EAC battery-labelled revenue
  sits there and stays out of frame.
- **Causation, governance or intent claims** about any market outcome.

---

## Verification before the PR

Run `etl/build_bess_units.py` against live APIs with a fresh cache; check
the payload against the 40 kB budget and the four tripwires; run the
unittest suite including the JS-to-Python parity fixtures and the
no-storage guard; serve on the 8872 QA port and verify the card via
accessibility tree plus `getOption` dumps (house rule: screenshots
unreliable in this project); confirm that a distribution-connected unit
renders "not applicable" rather than a zero TNUoS line; confirm that a cash
flow which never repays renders "no IRR" and "no payback" rather than zeros;
confirm that reloading the page clears every input; confirm the manifest
version bump and cache-bust; confirm the Batteries tab, and therefore this
card, stays hidden on a non-GB zone.

---

# Addendum: the Excel DCF export (D35 to D40)

Written 2026-07-31, ships in the v1.5 batch (D34 as amended). Continues the
global decision numbering from D34. The owner's ask, in their own words, is
to *see the calculations and play around with them in Excel*, which rules
out a formatted table of numbers: the workbook has to recalculate when a
cell changes, or it is a CSV with borders.

Three blank reference models supplied by the owner set the conventions this
addendum mirrors, and each was read as XML rather than described from
memory. What was found in each, and what it decided:

**`SoF. Financial Modelling L3 - DCF_Model (Blank).xlsx`** (10 sheets: Intro,
Assumptions, Revenues, Calcs, Debt, IS, BS, CFS, Ratios, DCF). The DCF sheet
puts labels in column D, units in column E, years across G to N and the
terminal value in O. Rows 3 to 11 are a **General assumptions block on the
DCF sheet itself**, holding the discount date, the end of the first
forecast year, a **`Mid-year convention?` flag at H7 holding 1 or 0**, a
**`Fraction of the year left remaining` cell at H8 computed as
`=+(H6-H5)/365`**, and WACC at H9. Rows 62 to 66 are the pattern this design
adopts wholesale: a **`Discount period` row 62 reading
`=IF($H$7 = 1, J63, J64)`**, selecting between a `Mid-year convention` row
and a `Full-year convention` row, feeding a **`Discount factor` row 66
reading `=1/(1+WACC)^J62`**, with `WACC` a workbook-level defined name
pointing at `DCF!$H$9`. Row 67 carries `Share of FCFF to discount`, the
stub. The valuation block sums the present-value row directly,
`=SUM(J69:N69)`. **The file contains no `NPV(`, no `IRR(`, no `XNPV` and no
`XIRR` anywhere**: a practitioner model builds a discount-factor row and
sums it. Input cells are blue-font; percentages are `0.0%`; currency is
`#,##0.0_);(#,##0.0);0.0_);@_)`, so negatives show in brackets.

**`SoF. Energy - EV Charging Station Model (Blank).xlsx`** (Cover,
Assumptions, Calculations, DCF). Both grid sheets share one header row,
**`Metric | Input | 2024 | 2025 | ...`**, with the label in column C, units
in column D, a single-value `Input` column at E and years from F rightwards;
forecast year headers are formulas (`=G5+1`) and carry the number formats
`#"A"` and `#"F"` so an actual is visually distinct from a forecast. Section
numbers sit in column A as `1`, `=A7+1`, `=A19+1`, bold white on a dark
fill. **Input cells are blue font `FF0432FF` on a pale yellow fill
`FFFFF2CC`**; formula cells are plain; subtotals are bold and headline
outputs bold on a tint fill. Ratio rows are wrapped in `IFERROR`. The Cover
and Assumptions sheets echo the answer by reference (`E3 =DCF!E61`) rather
than repeating the arithmetic.

**`SoF. Energy - Power Generation Modelling (Blank).xlsx`** (Cover,
Disclaimer, Out, Model). Same `Metric | Input | years` grid, section numbers
computed as `=MAX(A$4:A12)+1`. Its sign convention is the one adopted here:
**costs are held as positive magnitudes in their own rows and subtracted in
the subtotal** (`EBITDA` is `=F91+F92-F93+F94`), with a `% of revenue` check
row under each cost line. It also ships a **standalone Disclaimer sheet**,
which is the precedent for putting the illustrative-economics sentence on
its own on the Cover.

### D35: an Excel workbook with live formulas, beside the CSV, not instead

**A second export button on the calculator card writes a real `.xlsx` in
which every derived cell is an Excel formula referencing the assumptions
cells. The CSV of D31 is unchanged and stays.**

The two exports answer different questions and neither replaces the other.
D31's CSV is the numeric record: eleven closed numeric columns, safe to
parse, safe against the name-leakage rule. The workbook is the working
model: change WACC in the Assumptions sheet and NPV, IRR, payback and LCOS
all move, because they are formulas over the same cells, not values printed
from JavaScript. Shipping only the workbook would break every downstream
script; shipping only the CSV leaves the owner's ask unmet.

Scope guards, all inherited rather than invented:

- **No macros.** The part list contains no `vbaProject.bin`, the file is
  `.xlsx` and not `.xlsm`, and the content types declare no macro-enabled
  workbook. A test asserts the written part list is exactly the eight
  expected parts.
- **No external links.** No `externalLink` parts, no `[1]Sheet!` style
  references, no web queries, no data connections. The L3 template does
  carry an `externalLinks` part and this workbook deliberately does not.
- **Session-only, D30 stands.** The workbook is built in memory from
  `State.calc` at the moment the button is pressed and handed to a Blob
  download. Nothing is written to browser storage, nothing is uploaded,
  nothing is retained, and the file is the only artefact.
- **No names, D31's rule extended.** The workbook carries no unit name,
  party name, site name or post code, in any cell, on any sheet, in any
  phase. In v2, pick-a-unit mode fills the same cells with the selected
  unit's numbers and no identifier travels with them.
- **Filename consistent with the CSV.** `gb_bess_calculator_p50.xlsx`
  against the CSV's `gb_bess_calculator_p50.csv`, from the same
  `c.percentile` token.
- **The card's standing sentence travels with the file**, in cell C3 of the
  Cover sheet, verbatim: *"Illustrative economics from the assumptions you
  enter, anchored on what comparable units observably earned. Not
  investment advice, not a valuation, and not a forecast."*

### D36: workbook shape

**Three sheets, `Cover`, `Assumptions`, `DCF`, in that order, following the
EV model's own pattern. One grid convention on both working sheets. Year 0
is a real column, not a special case.**

The layout, with the reasons that are not obvious:

- **Grid.** Column A section number, column C label, column D units, column
  E the `Input` column for single-value assumptions, column F year 0, and
  columns G onwards years 1 to T. This is the EV and Power Generation
  header row exactly. Year headers past year 0 are formulas (`=F10+1`), as
  in both templates, so a reader who extends the model gets the numbering
  for free.
- **Year 0 is the capex column.** Capital expenditure is a single negative
  number in F, every operating row is zero in F, and the net cash flow row
  is a plain sum down the column. Excel's `IRR` can then run over
  `F27:<last>27` directly with no offset argument, and the present-value
  row needs no special case because year 0's discount period is 0 and its
  factor is therefore 1.
- **Input cells are blue on pale yellow**, `FF0432FF` on `FFFFF2CC`, exactly
  the EV model's convention, and every other numeric cell on every sheet is
  a formula. There is no third category: if it is not blue it is calculated,
  which is the rule a DCF reader applies without being told.
- **A `Source` column at F on the Assumptions sheet** carries `observed`,
  `assumption`, `reference` or `derived` per row, mirroring the card's
  provenance chips (D30). Observed values are blue too, because in Excel the
  reader may legitimately overtype them; the Source column, not the fill,
  is what says where the number came from.
- **Costs positive in their own rows, subtracted in the subtotal**, the
  Power Generation convention, with negatives displayed in brackets by the
  number format. Capital expenditure is the one signed cell, negative, for
  the reason above. **This differs from D31's CSV**, which signs `opex_gbp`
  and `tnuos_gbp` negative; the magnitudes agree and the difference is
  stated in a note on the Cover so nobody reconciles the two artefacts and
  concludes one is wrong.
- **Results echo onto the Cover by reference**, `=DCF!$E$45` and siblings,
  which is the EV model's `E3 =DCF!E61` pattern. The Cover computes nothing.
- **Freeze panes below the header row** on the DCF sheet, and column widths
  set for the label column, so a 15-year model is legible without work.

Three blocks exist because of the v1.5 batch and would otherwise not:

- **The arbitrage rows.** `s_hi`, `s_lo` and the capture rate are three
  Assumptions cells; the margin is a derived Assumptions cell reading
  `=$E$20-$E$21/$E$16`, which is D26's `s_hi - s_lo / eta` and not the
  wrong form the test plan's item 4 guards against; the DCF sheet carries
  one `Arbitrage revenue` row inside the revenue block. In a phase or a
  case with no arbitrage the row is present and evaluates to zero, exactly
  as D31 keeps `arbitrage_gbp` in the CSV schema from v1.
- **Six family rows.** Each family (DC, DM, DR, BR, QR, SR) gets a row with
  its £/kW/day component and a 1 or 0 toggle cell, and the availability
  revenue is `=SUMPRODUCT(components, toggles)*365`. Turning a family off
  in Excel does what turning it off on the card does, which is the whole
  point of exporting a model rather than a result.
- **A check row under the family block**, reading `ok` when the six
  components sum to the published percentile total and `check the family
  split` when they do not. Percentiles do not add, so this row is not
  decoration: it is the assertion that the payload publishes the family
  components of the rank-representative unit at each percentile rather than
  six independently-ranked family percentiles. If the ETL ever ships the
  second thing, the workbook says so on its face.

### D37: the four headline figures, as formulas

**Every headline is a formula on the DCF sheet. None is a value written by
JavaScript. The discount-factor row is where the convention lives, and it
is the L3 template's own construction.**

Discounting, four rows in the year grid:

    Discount period, mid-year        =IF(G$10=1, 1-$D$8/2, G$10-0.5)
    Discount period, end of period   =G$10
    Discount period applied          =IF($D$7=1, G30, G31)
    Discount factor                  =1/(1+WACC)^G32

`$D$7` is the convention flag, 1 for mid-year and 0 for end of period,
linked from the Assumptions sheet. `$D$8` is the year-1 stub, the fraction
of the commissioning year remaining, computed as

    =IF($D$5="",1,(DATE(YEAR($D$5)+1,1,1)-$D$5)
                  /(DATE(YEAR($D$5)+1,1,1)-DATE(YEAR($D$5),1,1)))

which is `Metrics.yearFractionRemaining` written in Excel, exact because
Excel dates are serial days. **The year-1 mid-year period is `1 - f/2`, not
`0.5`**: a stub running from `1-f` to the end of year 1 has its midpoint at
`1 - f/2`, and a full year (`f = 1`) collapses to the usual `0.5`.
`WACC` is a workbook-level defined name pointing at the DCF sheet's own
WACC cell, copying the L3 template.

The four results:

- **NPV is `=SUM(F34:<last>34)`**, the sum of the present-value row
  including year 0. Excel's `NPV()` is not used for the headline, for the
  reason the templates demonstrate by never using it: `NPV()` assumes the
  first value falls at the end of period 1, cannot express a mid-year
  factor, and cannot express a stub, so wiring the headline to it would
  make the convention toggle a lie. **`NPV()` appears exactly once, as a
  labelled check row**, `=IF($D$7=1,"n/a (mid-year)",NPV(WACC,G27:<last>27)
  +F27)`, which reconciles to the headline to the last penny under the
  end-of-period convention and proves the discount-factor row is not doing
  anything exotic. Verified in the probe: `29,949,810.489290748` from the
  factor row against `29,949,810.48929075` from `NPV()`.
- **IRR is `=IFERROR(IRR(F27:<last>27),"no IRR")`**, native, over the
  undiscounted net cash flow row including year 0. `IRR()` returns `#NUM!`
  when there is no sign change, which is precisely the case
  `Metrics.irr` returns null for, so the `IFERROR` wrapper reproduces the
  card's "no IRR" rather than a zero (D30, and the test plan's item 2).
  **IRR is end-of-period by construction and does not move with the
  convention toggle**, and its label says so. This is not a shortcut:
  discounting the same flows at `(1+r)^(n-0.5)` gives
  `NPV_mid(r) = -C0 + (1+r)^0.5 (NPV_end(r) + C0)`, whose root differs from
  `NPV_end(r) = 0` whenever `C0` is non-zero, and Excel has no native
  function for it. The two honest options were a labelled end-of-period IRR
  or an iterative-calculation circular solve, and a circular reference in a
  file handed to a reader who did not build it is not a trade this design
  makes. **`Metrics.irr` must stay end-of-period for the same reason**, and
  the parallel discounting-convention work must not make it
  convention-aware without revisiting this decision.
- **Simple payback is a two-row chain and one formula**, kept inspectable
  in preference to clever:

      Cumulative net cash flow (undiscounted)   =F37+G27
      Payback reached this year                 =IF(AND(F37<0,G37>=0),1,0)

      =IF(SUM(G38:<last>38)=0,"no payback",
          SUMPRODUCT(G38:<last>38,G$10:<last>$10)-1
          +(SUMPRODUCT(G38:<last>38,G27:<last>27)
            -SUMPRODUCT(G38:<last>38,G37:<last>37))
          /SUMPRODUCT(G38:<last>38,G27:<last>27))

  The flag row has exactly one 1, so each `SUMPRODUCT` reads one value off
  the crossing year: the year number, its net cash flow and its cumulative.
  `(cf - cum) / cf` is the linear interpolation inside the year, identical
  to the engine's `remainder / cashflows[i]`, and the whole thing is
  visible to anyone who selects the row. Payback is undiscounted and so is
  convention-independent, matching the card. **One documented edge**: with
  a capital cost of exactly zero the workbook says "no payback" where the
  engine returns 0.0 years, because the flag needs a strictly negative
  previous cumulative. Capital cost is a required input on the card, so the
  case cannot arise from the UI.
- **Indicative LCOS is
  `=IFERROR((-F26+SUM(G41:<last>41))/SUM(G42:<last>42),"n/a")`**, over a
  discounted-cost row and a discounted-energy row that both use the same
  applied discount-factor row as everything else. `-F26` is the capital
  cost, undiscounted, entering once, which is the engine's `costNum = c0`.
  The charging leg is its own row, `=G15/eta*s_lo`, so the reader can see
  the discretionary choice D26 and the Outputs section already flag.

All four were evaluated against `ops/bess_calculator_figures.py` in the
probe described under D39. On a repaying fixture the workbook's formulas
returned NPV `29,949,810.4892907`, IRR `0.6997549225084845`, payback
`1.4285714285714286` and LCOS `100.92174706730904` against the engine's
`29,949,810.4892908`, `0.6997549225084845`, `1.4285714285714286` and
`100.92174715885702`: bit-identical on IRR and payback, and within 1e-8
relative on the two sums. The residual is `js_round` in the engine's row
values against unrounded Excel arithmetic, and D39 sets the tolerance from
it rather than pretending it is zero.

### D38: the writer

**A dependency-free XLSX writer in `app/js/xlsx.js`, roughly 220 lines,
store-only ZIP, `inlineStr` text, formulas with no cached values.**

The app has no build step and one vendored dependency (ECharts), and this
export is not the reason to acquire a second. An `.xlsx` is a ZIP of XML,
and every constraint that makes a general-purpose writer large is absent
here: one workbook shape, no charts, no images, no shared formulas, no
pivot tables, a few hundred cells.

- **Store-only ZIP.** Compression method 0, so no DEFLATE implementation is
  needed: local file header, name, bytes, then a central directory and an
  end-of-central-directory record. Sizes are known before writing because
  each part is built as a string first. The only real work is CRC32, which
  is a 256-entry table built in a loop and about 20 lines. A 15-year model
  came out at **37.9 kB** in the probe, uncompressed, which is a rounding
  error against the page's own payload budgets and not worth a deflate
  implementation.
- **`inlineStr` for text**, so there is no shared-string table to build or
  index, at the cost of repeating a few dozen label strings. Both Excel and
  LibreOffice have supported `inlineStr` since the format existed. The
  probe built the same workbook twice, once with `inlineStr` and once with
  a shared-string table, and the two were indistinguishable to the
  independent reader available on the build machine.
- **Formula cells carry `<f>` and no `<v>`**, and the workbook sets
  `<calcPr calcId="0" fullCalcOnLoad="1"/>`. This is the decision with the
  most downstream consequence and it goes this way deliberately: a cached
  value is a second source of truth that can disagree with the formula, and
  the entire purpose of this export is that the formula is the truth.
  `fullCalcOnLoad` makes Excel and LibreOffice recalculate the sheet on
  open, so the reader never sees a stale number. The cost is that a
  non-recalculating consumer sees empty cells, which is a real cost:
  `openpyxl` with `data_only=True` returns `None`, and any parser that
  reads values without evaluating gets nothing. Accepted, because such a
  consumer should be handed the CSV, and stated on the Cover sheet in one
  sentence.
- **No `calcChain.xml`.** It is an optimisation, it is optional, and a
  wrong one is worse than none.
- **Eight parts, and no others**: `[Content_Types].xml`, `_rels/.rels`,
  `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/styles.xml` and the
  three worksheets. No theme part (all colours are explicit RGB), no
  `docProps`, no printer settings, no `customXml`.

Known traps, each verified in the probe rather than recalled:

1. **`fills` must contain at least two entries**, index 0 `none` and index 1
   `gray125`, or Excel treats the styles part as corrupt. The first usable
   fill is index 2.
2. **`styleSheet` child order is fixed**: `numFmts`, `fonts`, `fills`,
   `borders`, `cellStyleXfs`, `cellXfs`, `cellStyles`. So is the worksheet's:
   `dimension`, `sheetViews`, `sheetFormatPr`, `cols`, `sheetData`.
3. **Rows must be emitted in ascending `r`, and cells in ascending column
   within each row.** This is the easiest thing to get wrong when the model
   is a sparse map, and the writer sorts on the way out rather than trusting
   insertion order.
4. **Custom number format ids start at 164.** The formats needed are
   `"£"#,##0;("£"#,##0)`, `"£"#,##0.00;("£"#,##0.00)`, `0.0%`,
   `#,##0.0;(#,##0.0)` and `dd/mm/yyyy`, British throughout, negatives in
   brackets per the templates.
5. **Dates are serial numbers from the 1899-12-30 epoch**, with
   `workbookPr` left at its default so the 1904 date system is off. The
   commissioning date must be a serial number and not text, because the
   stub formula does arithmetic on it.
6. **`&`, `<` and `>` need escaping in both text and formulas.** Formula
   strings here contain `<` in comparisons, so this is not hypothetical.
7. **`dimension` is written correctly rather than omitted**, which costs one
   pass over the model.

Honest size estimate: **about 220 lines for `app/js/xlsx.js`** (CRC32 and
ZIP about 80, XML helpers about 25, the static workbook, rels, content-type
and style strings about 70, the sheet serialiser about 45), **about 300
lines for the model builder** that turns `State.calc` and the payload into
the cell map, and **about 25 lines of glue** for the button, the Blob and
the filename. Roughly **550 lines total**. The Python probe that proved the
shape came to 159 lines of writer machinery and 167 lines of a reduced
layout, and the JS is larger only because the layout is complete and
JavaScript has no `binascii`.

### D39: parity, and what the test does not cover

**One fixture, captured from the browser exactly as the existing
JS-to-Python fixtures are, plus a small stdlib formula evaluator on the
Python side. The test evaluates the real workbook's real formulas and
asserts they equal `ops/bess_calculator_figures.py`.**

The house rule is pure-logic tests with no network and no browser in the
loop, and the existing convention for pinning JavaScript is
`tests/fixtures/bess_case_*/`, captured from the app running in a real
browser and treated as the oracle. The workbook extends that convention
rather than inventing one:

1. The developer captures `gb_bess_calculator_p50.xlsx` from the running
   card for each of the existing calculator fixture cases, base64 into
   `tests/fixtures/bess_case_N/workbook.xlsx`, alongside the inputs already
   stored there.
2. The test opens it with `zipfile`, which **validates every CRC and the
   whole store-only structure for free**, asserts the part list is exactly
   the eight expected names, parses every part with `ElementTree` to prove
   well-formedness, and asserts no part name matches `vbaProject`,
   `externalLink` or `calcChain`.
3. The test extracts every `<f>` from the three worksheets into a cell map
   and evaluates them with a small A1 evaluator, then asserts the four
   headline cells equal `npv`, `irr`, `simple_payback` and `lcos` computed
   from the fixture's own inputs, and that every year column of the cash
   flow row equals the corresponding `bess_cashflow` row.
4. The same evaluation runs twice, once with the convention flag at 1 and
   once at 0, which is a two-line change to one cell in the parsed map, so
   the mid-year and end-of-period branches are both pinned.

The evaluator is about 230 lines of stdlib Python over a **closed grammar**:
numbers, strings, cell and range references, `+ - * / ^`, comparisons, and
exactly `SUM`, `SUMPRODUCT`, `IF`, `IFERROR`, `AND`, `MIN`, `MAX`, `ROUND`,
`DATE`, `YEAR`, `IRR` and `NPV`. Anything outside that grammar raises, which
is the feature: a future formula using a function the evaluator does not
know fails the test loudly instead of being waved through. **`IF` and
`IFERROR` must be lazy**, evaluating only the branch taken, which the probe
discovered the expensive way: an eager `IF` divides by zero inside the
payback formula's false branch on a cash flow that never repays, and Excel
does not.

Tolerance: **1e-6 relative, or one penny, whichever is larger**, and the
reason is named rather than fudged. The engine rounds every row through
`js_round` before it reaches the CSV and the card, and the workbook's
formulas do not round at all, so LCOS diverged by 9e-8 and NPV by 7e-9 in
the probe. A tighter tolerance would be a false claim about what is being
compared.

**What this does not cover, stated so nobody believes otherwise:**

- **Excel's own recalculation.** The test proves the formula strings compute
  the engine's numbers under a Python evaluator with the same semantics it
  was written to have. It does not prove Microsoft Excel agrees. The two
  places they could differ are `IRR`'s convergence, where Excel uses an
  iterative solve with a 0.00001 tolerance and this design's bisection is
  tighter, and floating-point association in long sums.
- **Whether Excel and LibreOffice consider the file valid.** No spreadsheet
  application is installed on the build machine (`soffice` is absent,
  `openpyxl` is not installed), so this is a manual step in the PR checklist,
  not an automated one. The structural checks in step 2 stand in for it, and
  the probe confirmed the hand-rolled ZIP is readable by an independent
  reader: Python's `zipfile` verified every CRC, and macOS QuickLook parsed
  the package far enough to apply a fill colour from our own `styles.xml`.
- **Number formats and presentation.** The test reads formulas and values,
  not how they render.
- **The fixture going stale.** The fixture is a snapshot, exactly as
  `bess_case_*` already are. The guard is that the test recomputes the
  expected numbers from the inputs stored beside the fixture, so a workbook
  captured before an engine change fails rather than passing quietly.

### D40: what ships when

**The workbook ships in the v1.5 batch, after the arbitrage line, the family
percentiles and the discounting convention are in the engine, not before.**

Sequencing it last inside v1.5 is not caution, it is arithmetic: those three
changes each add or change rows on the DCF sheet, and building the layout
first means building it twice. The layout is designed so that **v2 adds no
rows at all**: pick-a-unit mode changes which numbers land in the
availability and nameplate cells and adds one provenance line on the Cover,
and D35's no-names rule means the identifier itself never travels.

Verification additions for the PR checklist, on top of the existing list:
open the exported file in Excel and in LibreOffice, change WACC on the
Assumptions sheet and confirm NPV, IRR, payback and LCOS all move; flip the
convention flag and confirm the discount-factor row and NPV move while IRR
and payback do not; turn one family toggle off and confirm the availability
row and everything downstream of it move; confirm the check row under the
family block reads `ok`; confirm no sheet name, label or note in the file
contains an em dash or a unit name.

### D41: industry formatting for the workbook (2026-07-31)

**The export follows the owner's reference template ("SoF Energy - Power
Generation Modelling") conventions:** Arial 10 throughout; numbered
light-grey section bands on both sheets (navy reserved for the three sheet
titles); a medium rule under every table-header row; factor/ratio rows
(year fraction, cannibalisation factor, effective age, discount periods
and factors) italic grey at 2 dp; Net cash flow and the four headline
results bold on the grey band with thin rules above and below; zeros as
dashes and negatives in parentheses in every money and number format. The
blue-on-yellow input / navy observed / green cross-sheet colour code is
unchanged and stays pinned by the Cover legend tests. The Cover gains a
stated-conventions block: real (uninflated) sterling, pre-tax, ungeared,
no terminal or residual value; TNUoS held flat at the stated charging
year; and the charging-cost convention (the cash flow's arbitrage margin
is net of charging, availability cycling is treated as energy-neutral,
LCOS prices all throughput at s_lo).

### D42: augmentation event and availability derate (IC-review pass)

**One optional augmentation event (year + GBPk/MW, both required) and an
own-asset availability derate (%/yr), sharing one "effective age" clock.**
The IC review of the exported model flagged the one-sided treatment of
ageing: energy degraded but availability revenue never did, and nothing
could model the augmentation capex a 10-15-year hold actually spends. The
event restores usable energy to nameplate at the start of its year,
lands as capex in that year's net cash flow (and in LCOS's numerator),
and resets the effective age that both the degradation and derate
exponents read - the age lives in one visible DCF row rather than being
repeated piecewise inside two formulas. Cannibalisation deliberately does
NOT reset: it is a market view on the calendar clock, not an asset
property. A blank year or a zero cost is a complete no-op, so every
pre-existing fixture and default is unchanged. The payback flag row
gains a first-crossing guard (augmentation can dip the cumulative line
back below zero after repayment; the headline SUMPRODUCT assumes exactly
one flag). Engine, Python mirror, CSV header, workbook and card chart
(an Augmentation bar series) all carry the fields;
tests/fixtures/bess_wb_case_4 exercises the whole path.

### D43: what the IC review deliberately did not change

Recorded so the boundary survives the next review: revenue stays flat
real (the calculator anchors on the observed record and refuses to
forecast; cannibalisation and the derate are the only decay levers); the
capture rate keeps multiplying the net margin, with the conservatism
caveat stated on the card instead of a convention change that would move
every existing figure; tax, gearing and inflation stay out (D-list
"Alternatives ruled out": a pre-tax, ungeared, real cash flow with a
stated WACC is defensible; anything more invites the reader to treat the
output as a transaction model); and no terminal value row ships while
the calculation period defaults to the useful life - the Cover states
the zero-residual assumption instead. If a period shorter than life
becomes a real use case, the right shape is a remaining-life annuity on
the final modelled year's net operating cash flow, never a growing
perpetuity on a degrading, finite-life asset.

### D44: augmentation generalised to a second cell tranche (supersedes D42's shape)

**The augmentation event becomes a vintage model: augYear + augMwh +
augCostPerMwh (+ optional augDelta), replacing D42's restore-to-nameplate.**
The owner's review of D42 caught three things restore-to-nameplate cannot
express, and one thing it got physically wrong. It could not do a partial
top-up, could not expand beyond nameplate, and gave the new cells the old
cells' degradation rate; worse, it silently reset the ORIGINAL cells'
clock, which no real augmentation does. The revision keeps two tranches:
the original cells degrade as E x (1-delta)^(n-1) forever, and augMwh of
new cells join at the start of augYear, degrading at their own rate
(augDelta, defaulting to delta), costed at augCostPerMwh GBPk/MWh into
that year's cash flow and LCOS. Size is uncapped - a partial top-up, a
full restore and an outright expansion are the same mechanism. The
availability derate now compounds on the CAPACITY-WEIGHTED cell age
across the tranches (one visible DCF row), so a fresh tranche
rejuvenates capability in proportion to its size - D42's full reset is
recovered as the full-replacement limit, and the no-augmentation case
is exactly n-1, so every pre-existing figure is unchanged. One event
only: a schedule of augmentations is a mechanical extension (one more
tranche row block per event) deliberately deferred until a real case
needs it, because each event adds four inputs to an already heavy card.

### D45: MIRR beside IRR, never instead of it

**A MIRR row (financing and reinvestment both at WACC, end-of-period
basis) joins the headline results; IRR stays.** The owner's concern was
solver errors from the second sign change an augmentation-year outflow
creates. The workbook cannot actually surface an error - IRR() is
IFERROR-wrapped and the engine's bisection returns null - but the real
defect is worse than an error: a two-sign-change series has multiple
mathematically valid IRRs, and which one Excel's solver or the
bisection lands on is luck. MIRR is single-valued by construction:
negative flows (including year-0 capex) discount to t=0, positive flows
compound to the horizon, both at WACC, and
MIRR = (FV_pos / -PV_neg)^(1/T) - 1. It is built from two visible
helper rows (the two legs) rather than Excel's MIRR() function, which
the closed evaluator grammar does not carry, and so a reader can audit
which years sit on which side. IRR is retained because it is the figure
every counterparty asks for first and needs no reinvestment assumption;
the Cover states both bases. "n/a" - never a number - when the series
has no positive or no negative flows at all. Addendum, same day: on the
owner's review, a native `=MIRR(F..U,WACC,WACC)` CHECK row joins the
Checks section (the NPV() check-row pattern exactly), with MIRR added
to the closed evaluator grammar to execute it - the headline stays on
the two visible legs, and the check row proves the native function
lands on the identical figure; over a year-0..T range Excel's
n = count-1 = T makes the two algebraically the same.

### D46: the owner's named cell styles, vendored (supersedes D41's hand-built table)

**`xl/styles.xml` and `xl/theme/theme1.xml` are the owner's own formatted
workbook's, shipped verbatim; the generator maps roles onto that file's
cellXf indices via `BESS_XF` in `app/js/charts.js`.**

D41 rebuilt the reference template's *appearance* by hand. The owner's
2026-07-31 file showed why that was the wrong level to work at: it
defines thirteen NAMED cell styles (`![M]Input`, `![M]Link`,
`![M]Formula`, `![M]Percent`, `![M]Date`, `![M]ChangeF`,
`![M]HardNumber`, `![M]KPI`, `![M]KeyOutput`, `![M]Special`,
`![M]Check`, `![M]Comment`, `![M]Unused`) that appear in Excel's
cell-style gallery, so a reader restyling a cell picks the same named
style the model already uses. A hand-built table reproduces the look and
loses the gallery, which is the part that matters. Vendoring costs about
26 kB of XML in `app/js/xlsx.js` and buys exact fidelity; the writer
gained a theme part, per-column `style` attributes and a sheet `zoom` to
carry the rest of that file's layout. Row maps shift down one (the sheet
title sits on row 2) and the Assumptions section number moves to column
B, both from that file. The Cover reproduces its "Cell style map"
legend in full - the house vocabulary, not a key to this one export.

Two deliberate departures from the source file, both recorded here
rather than left to be rediscovered:

- **Dashboard-observed figures take `![M]HardNumber`, not `![M]Input`**
  (thirteen cells: the six family components, the published percentile
  total, the two arbitrage prices, the four TNUoS tariff elements).
  `![M]Input` means "type your own number here", which is untrue of
  every one of them - their Source column reads `observed` or
  `reference`. `![M]HardNumber` is that file's own name for a hardcoded
  figure, and it is what its own year-0 literals on the DCF sheet use,
  so this stays inside the owner's vocabulary while preserving the
  provenance distinction D20 and D38 asked for.
- **One appended cellXf (index 56): `![M]Link` with the one-decimal
  percent format**, for the Cover's IRR and MIRR links. The source
  file's Link+percent variant (index 46) carries a format that renders
  a fraction such as 0.13 as `0 %`, which would misreport both figures
  on the Cover; every other Cover link keeps its original style.

Verified by comparing a generated workbook against the owner's file cell
by cell: the DCF sheet matches on all 721 shared refs, and the
Assumptions sheet differs only on the thirteen HardNumber cells above.

### D47: two-column layout with a sticky results column (implements D19's promise)

**The card becomes a `380px minmax(0, 1fr)` grid — the five field groups
stacked in a fixed left column, the results pinned in a sticky right
column — and the ten paragraph captions collapse behind native
`<details>` disclosures.** D19 specified "a two-column grid at desktop
width (inputs left, results right) collapsing to one column, inputs
first"; the shipped card stacked results *below* an auto-fit input grid
instead, on the reasoning that a tall group (Costs and finance) would
otherwise force the results column to match its height. Sticky removes
that objection entirely — the results column does not match the row's
height, it floats within it — so the original decision is now actually
implemented rather than reasoned around. Measured at 1280x720: the
reader scrolled roughly 2,000px of form before the first number
appeared; they now see all five headline figures and the cash-flow
chart before touching anything, and those stay in view for every
keystroke that changes them.

The left track is a fixed 380px, not a fraction, so narrowing the window
takes width off the chart rather than off the form: at the 980px
breakpoint the results column is still ~490px, above the width the
cash-flow chart needs, while a fractional split would have squeezed the
inputs below comfortable control width first. This is the idiom
`.method-layout` and `.gloss-layout` already use, so no intermediate
breakpoint was needed and D19's "no new responsive machinery" holds.

**The sticky column is clamped, and that is a judgement, not a default.**
`max-height: calc(100vh - var(--topbar-h) - 28px)` with
`overflow-y: auto`, the third use of the formula `.method-toc` and
`.gloss-nav` share. The results stack measures 500px against 601px of
room at 1280x720 and never scrolls internally there — but at a 1000px
card the KPI grid reflows to four-then-one, the tiles grow as their
labels wrap, and the stack reaches 634px. Unclamped sticky would cut
the export row off the bottom of the viewport with no way to reach it.
The clamp is a safety valve for the narrow and short cases, invisible at
the width the dashboard is designed for.

**Captions collapse via `<details>`, not the ⓘ popover.** The ⓘ pattern
cannot carry per-field prose: its handler deep-links to a Methodology
section and is bound once at boot, before `wireBessCalc` injects these
inputs. `<details>` needs no new JS, no state and no storage, and its
open/closed state survives every render for free precisely because D30
builds the input container once and never touches it again — the DOM is
the state. Ten notes collapse (augmentation, discounting convention,
valuation date, availability derate, availability percentile, service
families, cannibalisation, observed spread, capture rate, manual spread
override), taking the one-column form from 3,106px to 2,437px. The seven
`.calc-live` read-outs stay always-visible and deliberately outside the
mechanism: they are each field's own answer, not commentary about it.

One deliberate departure worth stating: the total card height barely
moves (~2,750px stacked with results rendered, ~2,620px now). The gain
is not a shorter card, it is that the distance from the top of the card
to the first result went from ~2,000px to zero. Scroll-to-first-answer
was always the defect; card height was the symptom that made it look
like a layout problem.

No markup change was needed — `.calc-grid` already wrapped
`#bess-calc-inputs` and `#bess-calc-results` as siblings, so DOM order
(and therefore keyboard and focus order) is inputs-then-results by
construction, on every width. No JS resize trigger was added either:
`State.subscribe` runs `Charts.renderTab` on every state change and that
already ends in `requestAnimationFrame(resizeAll)`, which covers both the
initial column sizing and the one novel case of a classic scrollbar
appearing inside the results column.

### D48: the calculation period is capped at the useful life

**T = min(calculation period, useful life), resolved in
`bessCalcEngineInputs`, with a live line under the field saying when the
cap bit.** The owner's review caught that the useful life was only ever
the DEFAULT for a blank period, never a bound on a typed one: period 25
against life 15 silently modelled ten years of revenue from a
decommissioned asset. Under the stated no-residual convention those
years should be zeros, and zeros are not even free — MIRR's horizon
exponent stretches with T, so phantom years pull it toward WACC. The cap
is caller-side (the engine's own input is T alone), so every engine
fixture is untouched. The mirror case gets a line too: a period
deliberately SHORTER than the life now says the remaining years earn
nothing and no residual value stands in for them, which is the honest
reading of a truncated view in a model with no terminal value.

### D49: the owner's frame, and the cells the 1-dp house format misled

**The workbook adopts the owner's hand-edited frame — a blank first row,
an empty margin column A, the section-number gutter at column B on both
grid sheets — and four kinds of cell leave the 1-dp house format.** The
frame was measured from the owner's file, not designed here: widths,
freeze panes and the WACC name's new anchor (`DCF!$D$7`) all replicate
it exactly, through the same vendored named-style table (D-series,
2026-07-31) so Excel's style gallery keeps working. The format fixes are
the cells where one-decimal precision actively misled: an augmentation
year rendered "2,035.0" (now integer `0` format); the six family
components, their selected total and the published total are £/kW/day
magnitudes around 0.003-0.03 that all rendered "0.0" (now 4 dp,
dash-for-zero). The TNUoS zone tariffs stay at 1 dp deliberately —
pounds-per-kW magnitudes where one decimal is right.

### D50: results-panel information density

**Three additions to the sticky results column — per-unit context on the
KPI tiles, a year-1 revenue-mix line, and a four-chip NPV sensitivity
strip — costing 74px of a 101px clamp margin.** The model review flagged
that the panel reported five figures and no context for any of them: an
NPV in absolute pounds that cannot be compared with any other project, a
revenue stack visible only by reading the chart legend, and no indication
of how hard the answer leans on the two assumptions it leans on hardest.
The column measures ~500px against ~601px of room at 1280x720, so each
addition was costed in pixels before it was designed, not after.

**Per-unit context is free, and that decided which tiles get it.** The
MIRR and LCOS notes already wrap to two lines at the shipped 126px tile
content width, so the `.calc-stat` row's height is already governed by a
two-line `.cs-note` block: any note that fits in two lines adds nothing.
NPV takes `£X/kW · £Y/kWh` (both denominators are inputs, and £/kWh is
the second standard BESS normalisation), IRR takes its spread over the
WACC — an IRR is only readable against the hurdle in the same input set,
and that input lives in the other column — and simple payback takes
`undiscounted · N yr modelled`, stating a convention the word "simple"
only hints at. MIRR and LCOS keep the notes they had; both explain a
convention and neither can be displaced.

**The revenue-mix line sits 4px under the anchor line because it is the
same kind of statement.** Neither is a figure; both say what the figures
below them mean. It reports year 1's availability and arbitrage in
pounds and, when both are positive, as shares — the guard matters,
because a family component can be negative at p10 (D21) and a share of a
mixed-sign total is arithmetic theatre. The arbitrage half is never
stated bare: the clause "your N% capture rate applied to a
perfect-foresight ceiling, not a forecast" travels with the number, in
the line, not in a tooltip. When arbitrage contributes nothing the line
says which of the three reasons applies — no capture rate (D26 ships no
default), no ceiling in use, or no cycles set so nothing is discharged.
The third is the common one and was previously invisible: a reader with
cycles left blank saw a flat zero band on the chart and no explanation
anywhere on the card. Cost: 26px, less 6px reclaimed from the anchor
line's bottom margin.

**The sensitivity strip reports NPV at WACC ±2pp and capture ±10pp, and
is labelled in words as what it is.** Each case is the headline's own
`inputs` object with exactly one field replaced, put through the
identical chain the headline uses — `bessCashflow` → `npv` (same
discounting convention, same year-1 stub) → `reanchorNpv` — so the
useful-life cap (D48), the augmentation tranche, the TNUoS resolution
and the anchor all travel into the sensitivity without being restated
anywhere. A WACC case re-anchors at the *perturbed* rate: the anchor
factor is `(1+r)^years`, and anchoring at the base rate would put two
rates inside one figure. `bessCashflow` is re-run for the WACC cases
too, where the undiscounted flows are provably invariant to `r`, because
one code path that cannot drift beats two that can.

**A case that cannot be perturbed shows its reason, not a number.** With
no capture rate, no ceiling or no cycles, the arbitrage term is not in
the headline at all — a chip moving it would be a scenario, not a
sensitivity, and the two directions collapse into one `capture ±10pp`
chip carrying the reason. Clamped steps state the step actually applied:
capture floors at 0% and caps at 100%, WACC floors at zero (an
undiscounted NPV is a real bound; a negative WACC is not), and the label
reads `-1.5pp` rather than letting a clamped step masquerade as the
nominal one. A manual spread override needs no special case at all: the
override *is* the ceiling the capture rate multiplies.

**Chips, one row, head on its own line — all three are layout
judgements.** A 2x2 mini-table was dropped: the results column reflows
to ~490px at the 980px breakpoint, where a wrapping chip row survives
and a fixed-column table does not. The head takes its own 18px line —
inline with the chips it measured ~795px against the 808px column, one
substituted font from stranding a chip — and the line buys room to say
"one assumption changed at a time, not a scenario set" in full. The
chips borrow `.calc-stat`'s surface; D20 introduces no fifth badge class
and these are not badges. The four values share one £ scale, chosen once
from the largest magnitude in the strip, and the head restates the base
NPV in that same compact unit — a row read across a silent unit change
is worse than no row.

**Total 74px, leaving ~574px against ~601px.** Nothing scrolls
internally at 1280x720, exactly as before; at the 1000px card where the
stack already measured 634px it becomes ~708px and the clamp does the
job D47 built it for. The sensitivities are deliberately screen-only:
they do not enter the CSV (D31) or the workbook (D37), and adding them
there is a decision about export shape to be taken on its own terms
rather than smuggled in with a rendering change.

### D51: the valuation anchor moves into the discount-factor row; calendar years and a Total column join the grid

**The DCF grid now discounts straight to the valuation date — the
Discount factor row carries the anchor, showing factors above 1 for
pre-valuation years — and gains a Calendar year band under the period
numbers and a Total column between the inputs and the year grid.** The
owner reviewed the re-anchoring presentation against a reference
Rosneft/BP appraisal model and asked the right question twice. First:
why multiply ALL flows by the factor? Because re-anchoring is a change
of the date the money is expressed in, and a sum is only meaningful in
one numeraire — the reference model does the same thing, with the
anchor sitting inside every column's exponent rather than in one cell;
the two are the same arithmetic factored differently. Second: why keep
that factor in its own cell at all, when folding it into the discount
factor row makes the compounding VISIBLE per year? No good answer
existed — the separate cell was protecting a grid convention
(commissioning-anchored rows) whose main observable effect was that the
owner could not see the compounding they knew had to be there. Folded:
the factor row reads, e.g., 1.51 over a year that ended five years
before the valuation date, the PV row is "Present value at the
valuation date", its Total IS the headline (the sheet cross-foots), and
the commissioning figure survives as a check row via the identity
headline / factor. The CSV's discounted columns stay
commissioning-anchored, stated on the Cover rather than discovered.

The Calendar year row renders YEAR(commissioning)+n-1 (year 0 and the
year-1 stub share the commissioning year deliberately; blank when no
commissioning date is set — no invented calendar). The Total column
sums only the rows where summation means something: the sterling flow
rows, discharged energy and the MIRR legs; capacity, factors, ages and
cumulative rows stay blank, following the reference model's own
discipline. The net-cash-flow Total is the project's undiscounted
lifetime cash; the PV Total is the headline NPV — both now visible
without a single formula being audited.

### D52: DPP, PVI and DPI replace simple payback; the Total column goes; three corrections to the owner's draft

**The owner redesigned the results block in Excel — discounted payback
period in place of simple payback, a present value of investment row
and a discounted profitability index, no Total column — and the
generator adopts that design with three corrections found on
independent verification.** First, the draft's DPP interpolated the
crossing year on the UNDISCOUNTED net cash flow against a discounted
cumulative; the fraction must use the crossing year's discounted flow
(the PV row), or the discounted metric borrows an undiscounted
denominator. Second, the draft's PVI summed the capex row as stored
(negative), which flips the DPI: NPV/PVI + 1 with two negatives gives
an index ABOVE one for a loss-making project. PVI is now the positive
magnitude of discounted investment, and DPI = 1 + NPV/PVI reads below
one exactly when NPV is below zero (verified on all four fixtures, and
above one on a repaying clone). Third, the draft's headline multiplied
the valuation-anchored PV sum by the re-anchoring factor a second time
- a double anchor overstating NPV by the factor itself (x1.59 in the
reviewed file). The factor belongs only on the commissioning-based
Excel NPV() check row; the commissioning check row, which the draft
had lost and which exists to catch exactly this class of error, is
retained. DPP and DPI are anchor-invariant (the factor cancels in the
crossing test and the ratio); PVI is valuation-anchored like the NPV
it divides. The engine and its Python mirror gain discountedPayback
and pviAtCommissioning with hand-computed tests, the card's payback
tile becomes discounted payback, and the Cover mirrors six figures:
NPV, IRR, MIRR, DPP, DPI, LCOS.

Recorded with the answers that closed the review's two questions: the
LCOS discount factor differs because LCOS is fixed end-of-period and
commissioning-anchored by design (the anchor cancels in a ratio; the
toggle must not move a levelised cost), and its year-0 capex IS
discounted - by (1+r)^0 = 1; and year 0 and year 1 share a calendar
year whenever a commissioning date is set, because year 0 is the
commissioning instant and year 1 the remainder of that calendar year -
now stated on the Cover.

### D53: the key-result style loses its borders, and two cells that fell out of it

**The results block adopts the owner's borderless treatment of
![M]KeyOutput — the named style's thin rules overridden off, the
owner's own FFE8E6E6 grey applied — and two cells that had escaped the
scheme are put back into it.** The vendored named style carries thin
rules above and below, which the owner removed by hand in every results
cell of the reviewed file; the generator now emits five appended
cellXfs (60-64) that keep the xfId 11 link to the gallery entry while
overriding borderId to 0. The distinction the owner's file draws is
kept: the grey marks the RESULTS block alone, and the net cash flow
year row stays bold but unfilled (index 64), so the fill means "this is
a headline figure", not merely "this row is important".

The two escapees: the calendar band's Input cell was never written at
all, so the medium rule under the header broke between Units and year
0 - it is now emitted empty, purely to carry the band; and the DPI cell
had been left on the plain 2 dp formula style, which is what "fell out
of the style" looked like. DPI now uses the owner's own x-multiple
format (a new numFmt 176, `_(#,##0.0\x_)...`), so the index reads
"1.6x" rather than "1.60".

One deliberate departure from the reviewed file, flagged rather than
copied: its DPP cell carried the one-decimal PERCENT format inherited
from the MIRR row above it, which would render 6.1 years as "610.0%".
DPP is in years and takes the one-decimal NUMBER format instead - it
also previously sat on a whole-number format here, which silently
dropped the interpolated fraction the metric exists to provide.

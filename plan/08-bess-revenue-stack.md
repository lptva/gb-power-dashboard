# Milestone 8 — BESS revenue stack from public auction and BM data (issue #47)

Design-first, per house convention. Extends plan/06 Workstream C (issue #24):
this doc reuses #24's unit identification and matched-denominator rule and
continues its decision numbering (D12 → D13+). Investigated live
2026-07-29; every figure below is from a probe against the named endpoint,
not from an estimate.

## Status

Design drafted 2026-07-29, **awaiting owner decision on D13–D18**. Two of the
resolutions below (D16 placement, D18 layer-2 framing) change what plan/06
approved or what issue #47 proposed, and the evidence for each is set out in
full so the owner can overrule with the numbers in view.

---

## Market question

**What is the GB battery fleet actually paid, per kW of installed capacity
per day, through the markets NESO and Elexon publish?** Stacked by service in
£/kW/day against a nameplate denominator, signed, with the per-unit spread as
the peer-group overlay.

This is deliberately narrower than "battery revenue". It is the share of a
battery's income that is publicly observable — availability payments from the
Enduring Auction Capability (EAC) platform, and settlement cashflow from the
Balancing Mechanism. Wholesale arbitrage, Capacity Market derating payments
and bilateral tolls are outside the frame and the panel says so.

Why the narrower question is the right one: issue #24 excluded revenue
stacking because it "requires private trading-strategy data". That reasoning
holds for asset-level arbitrage P&L and it still holds — see the out-of-scope
restatement. It does **not** hold for availability revenue, which NESO
publishes per unit, per product, per delivery window, with clearing prices,
under an open licence. The probe below establishes that this is not merely
available but complete enough to carry a benchmark chart.

---

## Premise corrections vs the issue text

The issue's proposal is broadly right about what exists, and wrong in six
specifics that change the design materially. Each is evidenced below.

1. **Layer 1 does not need the sell-order book.** The issue proposes reading
   "every sell order with unit, MW, price, accepted/rejected". That resource
   exists (`NESO Response-Reserve Sell Orders`, 2,217,506 rows for FY2026
   alone) but is the wrong one. `NESO Response-Reserve Results By Unit`
   (895,350 rows FY2026) is the accepted-only, per-unit table and is what the
   revenue calculation needs.

2. **Identification is already solved inside the EAC data.** Results By Unit
   carries a `technologyType` column. `Batteries` is one of its twelve values
   — 202 distinct auction units and 355,461 rows in FY2026. This is NESO's
   own classification of the auction unit. #24's structural signature (D9) is
   not needed to identify the layer-1 cohort, and the evidence in D13 shows
   it is materially worse at it.

3. **Slow Reserve exists and the issue omits it.** The FY2026 product set is
   DCH/DCL/DMH/DML/DRH/DRL (Response, 4-hour EFA blocks) plus PBR/NBR
   (Balancing Reserve), PQR/NQR (Quick Reserve) **and PSR/NSR (Slow
   Reserve)**, all 30-minute. PSR is the single largest product by row count
   (349,610 of 895,350 in FY2026) but batteries barely touch it: on
   2026-07-20 batteries earned £308 of the £116,753 Slow Reserve total. The
   layer must carry it anyway — a zero-height band is information.

4. **Layer 2 does not need reconstructing from BOALF × BOD.** Elexon
   publishes the product directly as **EBOCF** — indicative period BM Unit
   cashflows, per unit, per settlement period, per bid-offer pair
   (`/balancing/settlement/indicative/cashflows/all/{bid|offer}/{date}`). The
   hand reconciliation below closes exactly, including the transmission loss
   multiplier that a hand-rolled BOALF × BOD calculation would have missed.

5. **Layer 2 is not a revenue layer, and stacking it would be wrong.**
   Measured over seven sample days spread across the window, the cohort's net
   BM cashflow swings from **−£0.134 to +£0.112 /kW/day**, tracking nothing
   more than whether the fleet happened to charge or discharge through the BM
   that day. It is the energy leg of a trade whose other half settles
   invisibly in the wholesale market. See D18.

6. **The denominator must vary with time.** The identified cohort's active
   capacity grew from 2,516 MW (Jun 2025) to 4,207 MW (Jul 2026) — 67% in
   thirteen months. A constant present-day denominator understates Jun 2025 by
   40% (£0.0458 vs £0.0768 /kW/day). Fleet growth is not optional detail on a
   per-kW metric over a one-year window.

---

## Sources, with probe evidence

### EAC auction results — NESO Data Portal (CKAN, keyless, NESO Open Data Licence)

Dataset `eac-auction-results`, 49 resources. The four that matter are
`NESO Response-Reserve Results By Unit` and its FY archives:

| resource | rows | delivery range |
|---|---|---|
| Results By Unit (current, FY2026) | 895,350 | 2026-03-31T22:00 → 2026-07-30T21:30 |
| Results By Unit FY2025 (Archive) | 1,176,445 | 2025-03-31T22:00 → 2026-03-31T21:30 |
| Results By Unit FY2024 (Archive) | 563,041 | 2024-03-31T22:00 → 2025-03-31T21:30 |
| Results By Unit FY2023 (Archive) | 161,252 | 2023-11-02T23:00 → 2024-03-31T18:00 |

**Schema is identical across all four** — twelve columns, same names, same
types: `registeredAuctionParticipant, auctionUnit, serviceType,
auctionProduct, executedQuantity, clearingPrice, deliveryStart, deliveryEnd,
technologyType, postCode, unitResultID`. No drift to handle inside the EAC
era. History rolls into a new FY resource each April; the current resource is
kept live to the next delivery day (probed 2026-07-29, carrying delivery
windows out to 2026-07-30T21:30 — EAC publishes day-ahead).

There is also a `NESO Response-Reserve Daily Results By Unit` resource
holding exactly one delivery day (7,480 rows, 2026-07-29T22:00 →
2026-07-30T21:30). It is not needed: the FY resource is kept current, and
querying it with a date filter is one call instead of two code paths.

**Revenue arithmetic.** `executedQuantity` is MW, `clearingPrice` is £/MW/h,
and the delivery window length is constant per product — verified per product
per day, `min(deliveryEnd - deliveryStart) == max(...)`: 4:00:00 for all six
Response products, 0:30:00 for all six reserve products. So

    revenue = executedQuantity × clearingPrice × window_hours

with `window_hours` read from the data each run and asserted constant, not
hard-coded. Pay-as-clear: `clearingPrice` is the auction clearing price for
that product and window, identical across accepted units — confirmed by
`count(distinct clearingPrice)` per product per day returning 6 for the
Response products (one per EFA block) against hundreds of accepted rows.

**Prices go negative, and this is the point of the chart.** On 2026-07-20 DRH
cleared between −£11.84 and −£17.44 /MW/h for every EFA block: units holding
Dynamic Regulation High capacity paid for it. Fleet-wide that day, DRH was
−£171,676 against DRL at +£137,462. Over the 400-day window the cohort's DR
band is **net negative, −£1.2 /kW/yr**. A stack that cannot render a negative
band would misrepresent this market.

**Two API traps, both verified.** The CKAN `datastore_search_sql` endpoint
sits behind a WAF that returns **HTTP 403** for `EXTRACT(...)` and for
`date(...)`. `date_trunc(...)`, `to_char(...)`, `left(...)`, arithmetic and
multi-column `GROUP BY` all pass. The ETL uses `to_char("deliveryStart",
'YYYY-MM-DD')` for day bucketing and derives window hours from interval
subtraction (`min("deliveryEnd" - "deliveryStart")`), which is not blocked.
This is the same family of trap as plan/06's "exact `filters={...}`, never
fuzzy `q=`" note and belongs beside it.

Cost of a full pull, measured: FY2025 grouped to day × unit × product for
batteries returned 142,012 rows / 9.4 MB in 7.4 s; FY2026 to date, 56,971
rows / 3.8 MB in 2.1 s. **Two calls, ~13 MB, ~10 s** covers the whole
shipping window.

### Pre-EAC response results — NESO `dynamic-containment-data`

Two resources, two further schemas:

- `DC, DR & DM Results By Unit Master Data 2021-2023`: 397,662 rows,
  2021-09-16 → 2023-11-02. Columns are entirely different (`Unit Name`,
  `Cleared Volume`, `Clearing Price`, `Service`, `EFA Date`, `Technology
  Type`). `Technology Type` has **seven battery spellings** — `Batteries`
  (115 units), `Battery` (81), `NA` (60), `BATTERIES` (3), `BATTERY` (3),
  `BM (SVA/VLP/Battery)` (1), `BESS` (1). Services present: DCL, DCH, DRL,
  DRH, DMH, DML — **no reserve products at all**.
- `Dynamic Containment Masterdata`: 10,388 rows, 2020-10-02 → 2021-09-15.
  A third schema again (`Market Name`, `Response Unit`, `Volume Accepted`,
  `Availability Fee`, `Total Cost`, 24-hour service duration). One market:
  `DC LF`. No clearing price column.

See D14.

### Balancing Mechanism cashflow — Elexon Insights (keyless)

`/balancing/settlement/indicative/cashflows/all/{bid|offer}/{settlementDate}`
(EBOCF). One call per side per day returns every BM Unit × settlement period
× bid-offer pair: 3,786 rows for 2026-07-20, 2.21 MB raw. **The endpoint
honours `Accept-Encoding: gzip` — 2,206,258 B → 262,582 B, 8.4×.** No
existing ETL helper sends that header; `build_dataset._http_raw` would need
it added (see ETL design).

Published same day (`createdDateTime` 2026-07-20T23:44:31Z for 2026-07-20
data) and available back to at least 2022-01-01 — probed at 2025-01-15,
2024-06-01, 2023-11-02 and 2022-01-01, all returning data. History depth is
not a constraint on this layer.

**Hand reconciliation — T_THURB-1, settlement date 2026-07-20, SP20
(09:30–10:00 UTC), bid side.** Volumes from DISPTAV
(`/balancing/settlement/indicative/volumes/all/bid/2026-07-20`, `dataType`
`Original`), prices from BOD (`/balancing/bid-offer?bmUnit=T_THURB-1`):

| pair | DISPTAV MWh | BOD bid £/MWh | vol × price | × TLM 0.9882790 | EBOCF (as published) | diff |
|---|---|---|---|---|---|---|
| negative1 | −9.00 | 99.45 | −895.050 | −884.559119 | −884.55911895 | 0.000000 |
| negative2 | −9.00 | 97.95 | −881.550 | −871.217352 | −871.21735245 | 0.000000 |
| negative3 | −2.00 | 97.95 | −195.900 | −193.603856 | −193.60385610 | 0.000000 |
| **total** | **−20.00** | | **−1,972.500** | **−1,949.380328** | **−1,949.3803275** | **0.000000** |

Implied TLM recovered from each pair independently — `EBOCF ÷ (vol × price)`
— is 0.9882790 on all three.

**`EBOCF = DISPTAV volume × BOD price × transmission loss multiplier`,
exact to machine precision.** The TLM (0.9882790 for this unit) is the
component a BOALF × BOD reconstruction would silently drop, a ~1.2% error.
Using EBOCF avoids re-deriving FPN baselines, pair allocation and TLM by
hand, and makes the figure Elexon's published number rather than ours.

**Sign conventions, written down.** Bid volumes are negative (the unit moves
below its physical notification — for a battery, charges more). Bid prices
are normally positive, so bid cashflow is negative: **the unit pays**. Offer
volumes are positive and offer cashflow is positive: **the unit receives**.
Where a bid price is itself negative the signs invert and the unit is paid to
charge — the arithmetic handles it, no special case. Negative bid-offer pairs
(−1…−6) carry **both** bid and offer acceptances: an "offer" on a negative
pair is the unit coming back up toward its notification, and settles
positive. Verified on T_THURB-1 2026-07-20 SP40, which carries −£1,206.17 on
`negative1` from the bid endpoint and +£521.91 on the same `negative1` from
the offer endpoint. **Net BM cashflow per unit-period is therefore the sum of
the bid-endpoint total and the offer-endpoint total, over all twelve pair
keys — both endpoints must be fetched, and neither alone is meaningful.**

**Why this is not revenue.** Cohort net BM cashflow, seven sample days:

| day | bid £ | offer £ | net £ | £/kW/day | bid MWh | offer MWh |
|---|---|---|---|---|---|---|
| 2025-09-15 | +60,439 | +199,789 | +260,228 | +0.0409 | −3,325 | 3,156 |
| 2025-12-10 | −23,964 | +688,548 | +664,584 | +0.1045 | −522 | 8,224 |
| 2026-01-08 | −311,698 | +35,143 | −276,555 | −0.0435 | −2,475 | 196 |
| 2026-03-18 | −278,266 | +780,574 | +502,307 | +0.0790 | −3,205 | 6,255 |
| 2026-05-06 | −587,491 | +94,257 | −493,234 | −0.0775 | −6,159 | 703 |
| 2026-06-23 | −119,704 | +832,748 | +713,044 | +0.1121 | −982 | 1,993 |
| 2026-07-20 | −915,540 | +64,286 | −851,254 | −0.1338 | −9,319 | 375 |

The sign of the day is the sign of the net MWh. On 2026-07-20 the fleet
bought 9,319 MWh through the BM and sold 375 MWh; the −£851k is an energy
purchase, and the resale settles in a wholesale market this dashboard cannot
see per unit. Mean over the seven days is +£0.0117 /kW/day, but that mean is
an artefact of which route each unit happened to use, not a margin. Stacked
next to a +£0.0296 /kW/day availability layer it would dominate the chart and
mean nothing. See D18.

### Denominators — Elexon BM Unit registry + REPD (reference, cited)

`/reference/bmunits/all`, 3,051 rows, 22 fields. `generationCapacity` is the
registered nameplate. REPD Q1 2026's 171 operational battery sites / 4,755 MW
carries over from plan/06 as the audit baseline. Neither is badged; both are
cited reference data in prose, per plan/06's Workstream C precedent.

---

## Alternatives ruled out, with the evidence

- **EAC Sell Orders as the layer-1 source.** 2,217,506 rows for FY2026
  against 895,350 for Results By Unit, and it requires filtering on `status`
  / `acceptanceRatio` / `reasonRejected` to recover what Results By Unit
  already contains. The order book is the right source for a bid-behaviour
  panel; it is the wrong one for revenue. Not needed, not fetched.
- **ISPSTACK (`/balancing/settlement/stack/...`) for BM cashflow.** It
  carries a `tlmAdjustedCost` field that looks exactly like what is wanted.
  Probed on 2026-07-20 SP36: **null for 8 of 9 offer-stack rows and all 115
  bid-stack rows**. It is the system-price derivation stack (NIV tagging, PAR
  adjustment), populated only for price-setting components. Ruled out —
  and recorded here so it is not re-investigated.
- **BOALF × BOD reconstruction, as the issue proposes.** Works in principle,
  but reproduces EBOCF while dropping the TLM (1.2% on the reconciled unit)
  and requires re-deriving pair allocation against FPN. Also much heavier:
  whole-market BOD for a single hour is 12,131 rows / 3.1 MB, i.e. ~74 MB/day
  ungzipped, against EBOCF's 0.5 MB/day gzipped for both sides.
- **BOAV instead of DISPTAV for the volume companion.** 13,463 rows vs
  15,144 for 2026-07-20, but DISPTAV's `pairVolumes` structure mirrors
  EBOCF's `bidOfferPairCashflows` key-for-key, which is what makes the
  reconciliation above a one-line check. DISPTAV kept; its four `dataType`
  values (`Original`, `Original-Priced`, `Re-priced`, `Tagged`) are filtered
  to `Original`.
- **#24's D9 structural signature as this panel's identification.** See D13 —
  it lands at 133% of the REPD operational total where the EAC label lands at
  89%, and it drags the per-unit median to +£0.0008 /kW/day against +£0.0222
  for the EAC-labelled cohort, because it admits 41 units that NESO does not
  call batteries and that win nothing.
- **Per-unit revenue in the payload.** Would answer "my battery vs peers"
  literally, but ships a named commercial performance table for 89 identified
  assets. The p10/p50/p90 spread gives the benchmark shape without it. The
  issue defers a per-unit selector to "later" in any case.

---

## Resolved decisions

### D13 — join mechanism and cohort

**Join: exact, uppercase, whitespace-stripped `auctionUnit` ==
`nationalGridBmUnit`.** No prefix variants, no fuzzy matching. Measured on
the 202 distinct FY2026 EAC battery units: **158 join (78.2%)**, 44 do not.
Adding `T_`/`E_`/`V_`/`2__` prefix variants against `elexonBmUnit` gained
nothing — every match was already found on `nationalGridBmUnit`.

The 158 matches split by `elexonBmUnit` prefix: **42 `T_`, 43 `E_`, 29 `V_`,
44 `2__`** (over the wider 246-unit FY2025+FY2026 set: 43 `T_`, 46 `E_`, 32
`V_`, 50 `2__`, 75 unmatched). The `2__` and `V_` matches are supplier and
virtual-lead-party constructs — `AG-HAB01B` → `V__BHABI013`, `AG-GSTK09` →
`2__GSTAT009`. They are aggregator portfolios, not assets.

**Cohort: EAC `technologyType == 'Batteries'`, joined, `elexonBmUnit` prefix
`E_` or `T_`, `generationCapacity > 0`.** Result: **89 units, 4,224 MW**.

Three things this rule does, each on evidence:

- **It corrects plan/06's D10.** D10 admits "physical units (E_/T_/V_)".
  Probed: **26 of the 32 matched `V_` units carry `generationCapacity`
  0.000**, and the six that do not are aggregator entries too (`AG-GBL0DN` →
  `V__NGBLO013`, 2.171 MW generation against −14.557 MW demand). `V__` is
  the virtual-lead-party prefix; it does not belong in a physical-unit
  boundary. The `generationCapacity > 0` term removes them without a special
  case, but the D10 wording should be amended when #24 is built.
- **It beats the structural signature on precision.** Cohort variants, same
  join, same 400-day window:

  | cohort | units | MW | % of REPD 4,755 MW | mean £/kW/day |
  |---|---|---|---|---|
  | EAC label only | 89 | 4,224 | **89%** | +0.0296 |
  | D9 signature only | 129 | 6,313 | **133%** | +0.0208 |
  | union | 130 | 6,362 | 134% | +0.0208 |
  | intersection | 88 | 4,175 | 88% | +0.0314 |

  A cohort at 133% of the national operational total is over-inclusive by
  construction. The EAC label at 89% is the shape a real coverage figure
  takes.
- **It agrees with #24 where #24 is right.** **88 of the 89 cohort units
  (99%) are also caught by the D9 signature.** The two methods do not
  disagree about batteries; the signature simply also admits 41 non-batteries.
  This is a useful cross-check to state in the caption, and it means the two
  cards can honestly describe themselves as covering the same fleet.

**Disclosed coverage — two figures, both in the caption.** Mirroring D9's
coverage-caption philosophy, and going one step further because a revenue
metric has a numerator-side gap that an activity metric does not:

1. **Denominator coverage: 4,224 MW ≈ 89% of GB operational BESS** (REPD Q1
   2026, 4,755 MW).
2. **Numerator coverage: the cohort captures 47.1% of all EAC
   battery-labelled gross £** over the window (£247.8 m gross across all
   battery auction units; the cohort's share is the matched-physical part).
   The other 53% is earned through aggregator and VLP auction units that
   carry no registry nameplate and therefore cannot enter a per-kW metric at
   all.

The second figure is the honest one and it must not be buried: this panel
measures the **self-registered, physically-connected** battery fleet, not the
whole GB battery fleet. Aggregator-routed revenue is real, large, and
structurally outside a £/kW metric. Caption wording: *"identified fleet: 89
units, 4,224 MW ≈ 89% of GB operational BESS (REPD Q1 2026). These units earn
47% of all EAC battery-labelled revenue; the remainder is contracted through
aggregator portfolios with no registered nameplate and is out of frame."*

**Time-varying denominator.** Per day, the summed nameplate of cohort units
whose first appearance in the fetched EAC window is on or before that day.
First-appearance is an observable commissioning proxy and is left-censored
harmlessly: the fetch spans FY2025+FY2026 (from 2025-03-31) while the shipped
series is the trailing 400 days (from ~2025-06-26), so units predating the
display window are active throughout it. Measured effect: active capacity
2,516 MW → 4,207 MW across the window; without this correction Jun 2025 reads
£0.0458 /kW/day instead of £0.0768.

### D14 — history depth

**EAC only, from the FY2025 and FY2026 Results By Unit resources. Ship the
trailing 400 days. Do not stitch pre-EAC.**

- The app's range presets top out at 365 days (`app/index.html:88`), and
  plan/06 set 400-day retention for `stress_daily.json` for the same reason.
  400 days is the established number.
- Stitching pre-EAC costs three schemas (EAC, 2021-2023, 2020-2021), a
  seven-way `Technology Type` spelling normalisation with 60 units labelled
  `NA`, and a unit-naming convention change.
- The disqualifying problem is not schema, it is **structural absence of
  services**. Before Nov 2023 the reserve products did not exist, so three of
  the six stack bands would be flat zero — and before Sep 2021 five of six
  would be, with no clearing price column at all. On a stacked revenue chart
  that reads as "revenue collapsed", not "the market had not been created".
  There is no caption that reliably defeats that misreading.
- Two FY resources also happen to be exactly what the 400-day window needs
  (FY2025 opens 2025-03-31, the window opens ~2025-06-26), so this is one
  fetch shape, not a special case.
- **Revisit trigger**: if a range preset longer than 1Y is ever added, and
  only for the three Response services, rendered as a separate
  pre-EAC-labelled chart — never spliced into the same stack.

BM cashflow (layer 2) has no history constraint — EBOCF serves 2022 — so it
is backfilled to the same 400-day boundary and the two layers share one
x-axis with no ragged start.

### D15 — layer 3 (wholesale arbitrage proxy)

**Hold. Do not ship in v1.**

The proxy is PN volumes × MID price. Both halves are wrong in ways that do
not cancel:

- PN is *notified intent*, not metered output. The repo has already written
  this down as a limitation of its own dispatch panel (methodology.md, Known
  Limitations 8: PN "is not what meters recorded"). Building a revenue figure
  on it would contradict a limitation the project already publishes.
- MID is a market-wide volume-weighted index across trading sessions, not the
  price any particular unit transacted at. methodology.md already flags that
  MID "diverges in stressed periods" — precisely the periods a battery
  arbitrage figure is most sensitive to.

The strongest argument *for* shipping it was that it would complete the
energy leg that makes layer 2 interpretable. It does not: PN ≠ metered volume
and MID ≠ transaction price, so the two errors compound rather than close the
loop. Shipping it would put the only Estimated band inside an otherwise
Observed stack, at the exact place where the reader most needs to trust the
total.

**Revisit trigger**: per-unit metered volumes (B1610 — already flagged for
probing in #24's Phase A) combined with a defensible per-unit reference
price. If B1610 coverage of the cohort turns out to be good, a *volume*
layer becomes possible long before a *revenue* layer does; that is a
different panel and a different issue.

### D16 — placement

**New GB-only "Batteries" tab, housing both #24's activity card and this
revenue card. This supersedes plan/06's D12 (Merit-tab card).**

- D12 sized the Merit tab for one card. This card alone is a twelve-band
  signed stack, a p10/p90 spread overlay, a separate BM cashflow sub-panel
  and a two-clause coverage caption. Two cards of that weight on the Merit
  tab, beside the existing dispatch curve and merit-order panels, is a
  scrolling tab with three unrelated stories on it.
- **Migration cost is zero if sequenced now.** `etl/build_bess_activity.py`
  does not exist and #24's Phase B UI is unbuilt (plan/06 records Workstream
  C as approved, not built). Landing #24 directly on the new tab costs
  nothing; landing it on Merit first and moving it later costs a migration.
- Mechanically this is the pattern plan/06's D7 already established for the
  stress tab: nav button + panel + `renderTab` case + one entry in
  `GB_ONLY_TABS` (`app/js/app.js:178`, currently
  `["merit","spreads","flows","stress"]` → add `"bess"`). The gating function
  at `app.js:179-188` needs no change — it hides the button and bounces the
  user to Overview on a non-GB zone automatically.
- Beta label retained from D12.

If the owner prefers to keep D12: the fallback is the revenue card on the
Merit tab with the BM sub-panel dropped and the spread overlay behind a
toggle. Recorded so the decision is reversible without a redesign.

### D17 — badges per layer

The app has four badge classes, `observed` / `estimated` / `assumption` /
`proxy` (`app/css/style.css:14-21`). There is no Reference class and this
design does not introduce one.

| element | badge | note |
|---|---|---|
| EAC availability revenue, all twelve products | **Observed** | NESO-published accepted quantity × published clearing price × published window length. Arithmetic over observed figures, no assumption. |
| BM cashflow (bid and offer) | **Observed** | Elexon-published EBOCF. The word *indicative* (the II settlement run) is disclosed in the caption and methodology entry as prose, not by downgrading the badge — it is a settlement-run vintage, not an estimate. |
| Registry nameplate denominator | none — cited reference data in prose | plan/06 Workstream C precedent. |
| REPD coverage figure | none — cited reference data in prose | as above, with vintage "Q1 2026". |
| net MWh companion | **Observed** | DISPTAV `Original`. |

No Estimated badge appears anywhere in v1, because D15 holds layer 3. If
layer 3 ever ships, it ships as a visually separated Estimated band with its
own subtotal — never inside the Observed stack's total.

### D18 — layer-2 framing (evidence-forced; not among the decisions the issue anticipated)

**BM cashflow ships in v1, but as a separate signed series with its own
heading and its own axis. It is never summed into the stacked total.**

The issue proposes layer 2 as the second band of a three-band revenue stack.
The seven-day probe table above shows why that cannot be done: the series is
the fleet's energy-purchase leg, its sign is set by whether the fleet charged
or discharged, and its magnitude (−0.134 to +0.112 £/kW/day) is roughly four
times the entire availability stack (+0.0296 £/kW/day mean). Stacked, it
would both dominate the chart and imply that batteries lose money in the BM.

What ships instead, in the same card, below a rule:

- heading: **"Balancing Mechanism cashflow (gross — includes the energy
  leg)"**
- two signed series: offer cashflow (received) and bid cashflow (paid),
  £/kW/day
- the net MWh companion on a secondary axis, so the reader can see directly
  that the sign of the money follows the sign of the energy
- caption: *"What the identified fleet was paid and paid out in the Balancing
  Mechanism. This is gross settlement cashflow including energy bought and
  sold, not margin: a day of heavy charging settles negative. The offsetting
  wholesale trade is not publicly attributable per unit and is out of frame."*

The stacked total above the rule is labelled **"Availability revenue"**, not
"total revenue", and the card's own title is **"Observable revenue stack"**.

**Fallback if the owner would rather not carry the framing burden**: hold
layer 2 entirely and ship the EAC stack alone. That is a clean, complete,
defensible v1 and it costs the 800-call backfill and ~210 MB of cache. The
recommendation is to ship it — the data is exact, published, novel, and the
honest framing is three sentences — but the card stands without it.

---

## Payload — `app/data/bess_revenue.json`

Columnar, one shared day axis, mirroring `series_hh.json` convention.

```jsonc
{
  "built_at": "2026-07-29T05:41:00+00:00",
  "schema": 1,
  "source": "NESO Data Portal EAC auction results (Results By Unit, FY2025+FY2026 resources) joined to the Elexon BM Unit registry; Elexon Insights EBOCF and DISPTAV for Balancing Mechanism cashflow and volume.",

  "cohort": {
    "units": 89,
    "mw": 4224.0,
    "method": "NESO EAC auction results technologyType='Batteries', joined on auctionUnit == nationalGridBmUnit (exact, uppercase); physical units only (elexonBmUnit prefix E_ or T_) with registered generationCapacity > 0",
    "repd_operational_mw": 4755,
    "repd_vintage": "Q1 2026",
    "coverage_repd": 0.888,          // denominator-side
    "coverage_eac_gross": 0.471,     // numerator-side — see D13
    "signature_agreement": 0.989     // share also caught by #24's D9 signature
  },

  "days": ["2025-06-26", "…", "2026-07-30"],          // 400 entries, UTC delivery-start date
  "denominator_kw": [2516000, "…", 4207000],          // per day — D13 time-varying rule

  // £/kW/day, signed, per auction product. Twelve keys, always all twelve,
  // zero-filled where a product had no cleared battery volume that day.
  "eac_gbp_per_kw_day": {
    "DCL": [], "DCH": [], "DML": [], "DMH": [], "DRL": [], "DRH": [],
    "PBR": [], "NBR": [], "PQR": [], "NQR": [], "PSR": [], "NSR": []
  },

  // per-unit distribution of total EAC £/kW/day across cohort units — the
  // peer-group overlay. No unit is named.
  "eac_unit_spread_gbp_per_kw_day": { "p10": [], "p50": [], "p90": [] },

  // D18 — separate series, never summed into the stack
  "bm": {
    "bid_gbp_per_kw_day":   [],   // negative on a normal charging day
    "offer_gbp_per_kw_day": [],
    "bid_mwh":  [],               // negative
    "offer_mwh": []
  },

  // display metadata so the UI carries no hard-coded market knowledge
  "products": {
    "DCL": { "service": "Dynamic Containment", "code": "DC", "direction": "low",  "window_h": 4.0 },
    "DCH": { "service": "Dynamic Containment", "code": "DC", "direction": "high", "window_h": 4.0 },
    "DML": { "service": "Dynamic Moderation",  "code": "DM", "direction": "low",  "window_h": 4.0 },
    "DMH": { "service": "Dynamic Moderation",  "code": "DM", "direction": "high", "window_h": 4.0 },
    "DRL": { "service": "Dynamic Regulation",  "code": "DR", "direction": "low",  "window_h": 4.0 },
    "DRH": { "service": "Dynamic Regulation",  "code": "DR", "direction": "high", "window_h": 4.0 },
    "PBR": { "service": "Balancing Reserve",   "code": "BR", "direction": "positive", "window_h": 0.5 },
    "NBR": { "service": "Balancing Reserve",   "code": "BR", "direction": "negative", "window_h": 0.5 },
    "PQR": { "service": "Quick Reserve",       "code": "QR", "direction": "positive", "window_h": 0.5 },
    "NQR": { "service": "Quick Reserve",       "code": "QR", "direction": "negative", "window_h": 0.5 },
    "PSR": { "service": "Slow Reserve",        "code": "SR", "direction": "positive", "window_h": 0.5 },
    "NSR": { "service": "Slow Reserve",        "code": "SR", "direction": "negative", "window_h": 0.5 }
  },

  "state": { "eac_last_day": "2026-07-30", "bm_last_day": "2026-07-27" }
}
```

Notes on the shape:

- **£/kW/day only; absolute £ is not shipped.** A parallel build carrying
  both cost 68.5 kB against 45.6 kB for the per-kW series alone. Absolute £
  is recoverable in the UI as `value × denominator_kw[i]` for a tooltip.
- **Twelve product keys, not six service keys.** DRH and DRL routinely carry
  opposite signs (2026-07-20: −£171,676 and +£137,462 fleet-wide); collapsing
  to a "Dynamic Regulation" band hides a compensating pair and would show a
  small net where two large opposite flows exist. The UI may group to the six
  `code` values for the default view, but the data keeps the resolution.
- `window_h` is written from the run's own assertion, not hard-coded, so a
  future product-length change surfaces in the payload rather than corrupting
  the arithmetic silently.
- `eac_last_day` and `bm_last_day` differ by design — EAC publishes
  day-ahead, EBOCF publishes at T+0/T+1. The UI trims the shared axis to the
  shorter series for the BM sub-panel only.

**Measured size**: 400 days × 12 products × 5-dp values + spread + BM series
+ metadata = **50.2 kB** (built from the real FY2025+FY2026 pull, not
estimated). Adding `denominator_kw` and the four BM arrays takes it to
**≈60 kB**.

---

## Payload budget

**0.15 MB hard budget for `bess_revenue.json`**, against a measured 60 kB —
2.5× headroom, which absorbs a doubling of the cohort or a move to 800-day
retention without a redesign. This sits inside plan/06's cross-cutting
"BESS ≈ 0.1–0.2 MB" line alongside #24's activity payload.

Eagerly fetched, like `stress_daily.json`. No lazy slices — there is nothing
per-day to drill into that is not already in the series.

Fetch cost (measured, not estimated):

| step | calls | bytes on the wire | wall time |
|---|---|---|---|
| EAC backfill (FY2025 + FY2026, grouped server-side) | 2 | 13.2 MB | ~10 s |
| EAC daily append (one day filter on the FY resource) | 1 | ~90 kB | ~1 s |
| Registry | 1 | ~2 MB | ~2 s |
| BM backfill, EBOCF both sides × 400 days | 800 | ~210 MB gzipped | ~22 min |
| BM backfill, DISPTAV both sides × 400 days | 800 | ~384 MB gzipped | ~30 min |
| BM daily append (4 calls) | 4 | ~1.5 MB | ~5 s |

The BM backfill is a one-off evening run of ~50 min and ~600 MB of disk
cache. plan/06's stress backfill was 365 calls / ~150 MB and was accepted on
the same terms; this is four times that. **If the owner wants it smaller**:
dropping the MWh companion halves it to ~210 MB, at the cost of the one
visual that makes D18's framing self-evident. Recommendation is to pay the
full cost once.

---

## ETL design — `etl/build_bess_revenue.py`

New module, importing `http` / `_atomic_write` / `OUT_DIR` / `ELEXON` from
`build_dataset` exactly as `fetch_stress.py` and `build_bmu_snapshot.py` do.

**One helper change in `build_dataset`**: `_http_raw` must accept an
`accept_gzip` flag, send `Accept-Encoding: gzip` and `gzip.decompress` when
the response carries `Content-Encoding: gzip`. Measured 8.4× on EBOCF; the
BM backfill is impractical without it. `gzip` is stdlib. Default off, so no
existing caller changes behaviour.

Structure:

1. `fetch_registry()` — reuse `build_bmu_snapshot.fetch_registry`'s shape but
   keep `demandCapacity` and `elexonBmUnit` (the existing helper discards
   both; extend it rather than fork it, and re-point the snapshot builder at
   the extended version).
2. `fetch_eac(day_from, day_to)` — one `datastore_search_sql` call per FY
   resource, `to_char("deliveryStart",'YYYY-MM-DD')` day bucket, grouped by
   day × `auctionUnit` × `auctionProduct`, `sum("executedQuantity" *
   "clearingPrice")`, filtered `"technologyType" = 'Batteries'`. **Never
   `EXTRACT(...)` or `date(...)` — both return HTTP 403.** FY resource ids
   are resolved at runtime from `package_show?id=eac-auction-results` by
   matching resource `name` against `^NESO Response-Reserve Results By Unit`,
   so the April FY rollover needs no code change; assert at least one
   resource covers the requested range.
3. `assert_windows(day)` — separate grouped call returning
   `min("deliveryEnd" - "deliveryStart")` and `max(...)` per product. Raise
   if min ≠ max for any product; write the parsed hours into
   `products[*].window_h`. This is the guard against a silent product-length
   change.
4. `build_cohort(registry, eac_rows)` — D13 rule. Emit the coverage block.
   Raise if the cohort is empty or its MW falls outside 50–120% of the REPD
   figure (a cheap tripwire on a registry or schema change; the current value
   is 89%).
5. `fetch_bm(day)` — four calls (EBOCF bid, EBOCF offer, DISPTAV bid, DISPTAV
   offer), gzip on. Sum over all twelve `bidOfferPairCashflows` keys on
   **both** endpoints (see the sign-conventions note); filter DISPTAV to
   `dataType == 'Original'`. Restrict to cohort `elexonBmUnit` values.
6. `merge_and_write()` — read back the existing JSON, merge by day (new days
   win), trim to 400 days, `_atomic_write`.

**Incremental state**: no sidecar file. `state.eac_last_day` and
`state.bm_last_day` inside the payload are the cursor, read back on each run
— the same read-back-and-merge pattern `fetch_stress.py` uses. A missing file
triggers a full backfill.

**Backfill bound**: `--backfill-days` defaulting to 400, hard-capped at 800,
with an explicit `--force-backfill` required to refetch days already present.
Without the cap a mis-set argument becomes a many-thousand-call run against
Elexon.

**Publication lag**: EBOCF for day D appears the same evening
(`createdDateTime` 2026-07-20T23:44:31Z for 2026-07-20). The daily append
requests **D−2 through D−1** and tolerates absence, rather than assuming
same-day completeness. EAC is day-ahead, so the EAC append requests through
D+1.

**Non-fatal refresh step**: one new step in `ops/refresh.py` after the BMU
snapshot, wrapped so a NESO CKAN outage or an Elexon 5xx logs a warning and
leaves the previous payload in place — matching the stress step's treatment.
The card renders stale-but-labelled rather than empty.

**Manifest**: self-update `manifest.json` with sha256 + bytes and bump
`version`, via the pattern at `build_bmu_snapshot.py:178-186`.

**`meta.json` / Methodology tab**: two new source rows (NESO EAC auction
results — NESO Open Data Licence; Elexon Insights EBOCF/DISPTAV) and two new
coverage rows (cohort units/MW, window start/end), so the in-app source and
coverage tables render from live ETL metadata as they already do.

**methodology.md**: one new section under the panel entries covering the
revenue formula, the pay-as-clear and negative-price convention, the
time-varying denominator, the two coverage figures, the BM sign conventions
and the *indicative settlement run* caveat. Plus a Known Limitations entry
restating D18 in one paragraph.

---

## UI shape (per D16)

New GB-only **Batteries** tab. Nav button, panel, `renderTab` case, and
`"bess"` added to `GB_ONLY_TABS` at `app/js/app.js:178`. Beta label.

Two cards:

1. **BM activity** — #24's card, moved here from D12's Merit placement,
   unchanged in content.
2. **Observable revenue stack** — this design:
   - Stacked signed bars, £/kW/day, one band per product, grouped by service
     colour with high/low as shade variants. Negative bands render below the
     axis; the axis is symmetric about zero so a negative DR band is not
     cropped.
   - Overlay: p50 unit as a line, p10–p90 as a band — the peer-group
     comparison the issue asks for, with no unit named.
   - Toggle: six service bands (default) or twelve product bands.
   - Below a rule: the D18 BM cashflow sub-panel, two signed series plus net
     MWh on a secondary axis, under its own heading.
   - Caption: the two-clause coverage sentence from D13, the identification
     method, the REPD vintage, and the out-of-frame statement.
   - Badges per D17.

The tab follows the global range presets for the displayed window;
retention stays 400 days regardless, so preset changes are presentation only
(plan/06 D8's principle — no cap logic through the back door).

---

## Test plan

stdlib `unittest`, house rule. Fixtures captured from the probes above and
committed as small JSON files under `tests/fixtures/`.

1. **Revenue arithmetic.** `executedQuantity × clearingPrice × window_h`, on
   the six T_THURB-1-adjacent EAC rows, including a negative clearing price
   (BLHLB-1 DRH 2026-07-20, 35 MW × −13.39 × 4 h = −£1,874.60).
2. **Window assertion.** A fixture with a product whose min ≠ max window must
   raise.
3. **WAF-safe SQL.** Assert the generated SQL string contains neither
   `EXTRACT(` nor `date(` — a unit test on the query builder, not a live
   call, so it cannot flake.
4. **Join and cohort.** Registry fixture with one `T_`, one `E_`, one `V__`
   at 0.000 capacity, one `2__` and one unmatched auction unit; assert the
   cohort is exactly the `T_` and `E_` pair and that both coverage figures
   compute.
5. **Time-varying denominator.** Two units, one first appearing mid-window;
   assert the denominator steps on the right day and that a constant
   denominator would give the documented ~40% error.
6. **BM sign conventions.** Fixture built from the reconciled T_THURB-1
   SP20/SP40 records: assert bid-endpoint negative pairs settle negative,
   offer-endpoint acceptances on a negative pair settle positive, and that
   the per-unit-period net is the sum of both endpoints.
7. **Reconciliation identity.** The hand-reconciliation table above as a
   regression fixture: DISPTAV volume × BOD price × TLM equals EBOCF exactly.
8. **Merge and retention.** Read-back merge keeps existing days, new days
   win, trim holds at 400, `state.*_last_day` advances.
9. **Payload budget.** Built fixture serialises under 150 kB.

---

## Out of scope — restated explicitly

Carried forward from plan/06 Workstream C and reaffirmed by this
investigation. Do not re-investigate without new data.

- **Asset-level P&L and trading-strategy simulation.** #24's original
  exclusion stands in full. Nothing here reconstructs what a unit chose to do
  or what it made overall.
- **Perfect-foresight backcasting**, revenue-maximising dispatch, "what a
  battery could have earned".
- **State of charge, duration, cycling depth, degradation.**
- **Wholesale arbitrage revenue** — held at D15, with the B1610 revisit
  trigger recorded there.
- **Per-unit named revenue.** The p10/p50/p90 spread is the benchmark
  surface; a per-unit selector is a separate issue if ever wanted, and would
  need its own decision about publishing named commercial performance.
- **Aggregator and VLP portfolio revenue** — 53% of EAC battery-labelled
  revenue, structurally excluded because those units carry no registered
  nameplate. Stated in the caption, not silently dropped. A portfolio-level
  panel with a different denominator would be a separate issue (and pairs
  with plan/06 D10's deferred VLP activity layer).
- **Capacity Market revenue.** The CM register has no BMU field (plan/06,
  verified 2026-07-11); unchanged.
- **ISPSTACK `tlmAdjustedCost` as a cashflow source** — null except for
  price-setting components, verified 2026-07-29.
- **Causation, governance or intent claims** about any market outcome.

---

## Verification before the PR

Run `etl/build_bess_revenue.py` against live APIs with a fresh cache; check
the payload against the 150 kB budget; run the unittest suite including the
reconciliation fixture; serve on the 8872 QA port and verify the card via
accessibility tree + `getOption` dumps (house rule: screenshots unreliable in
this project); confirm the negative DR band renders below the axis and is not
cropped; confirm the manifest version bump and cache-bust; confirm the
Batteries tab is hidden on a non-GB zone and that selecting one while the tab
is active bounces to Overview.

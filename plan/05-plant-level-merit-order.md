# Milestone 5 — Plant-level merit order, investigation-first

## Goal

Investigate joining Elexon physical notifications (PN) and bid-offer
acceptances (BOALF) at BM Unit level, to replace or augment the estimated
technology-cluster merit order with observed unit-level behaviour.

## What free data can and cannot support — stated up front

- **PN** is a unit's *intended physical output* (MW levels per settlement
  period). It contains **no prices**. It tells us what units planned to run,
  not what they bid.
- **BOALF** contains *accepted* balancing actions with their prices — only
  the accepted slice of the bid-offer stack, for units NESO actually
  instructed. The full submitted bid stack (BOD) is published, but volumes
  actually available/utilised require careful joining, and acceptance prices
  are not the wholesale clearing price.
- Therefore a true observed *bid stack* — an ERCOT-style supply curve of
  submitted prices — **cannot be faithfully reconstructed** from free data
  alone at cluster-replacement quality. What *is* achievable: an **observed
  dispatch snapshot** — per-unit output for a settlement period, joined to
  fuel type, showing which units in each technology were on and at what
  loading. That complements the SRMC curve (model) with observation; it does
  not replace it.

## Phase A — investigation script (`etl/investigate_bmu.py`)

Pull ONE sample day (keyless Elexon Insights API, same `http()` helper):

1. `/datasets/PN/stream?settlementDate=<day>&settlementPeriod=<p>` for a few
   periods — row counts, distinct BMU ids, payload size per period.
2. `/datasets/BOALF?settlementDate=<day>` — acceptance counts, price ranges,
   distinct units.
3. BMU reference list (`/reference/bmunits/all`) — fuel type / lead party per
   BMU; measure what share of PN MW joins successfully to a fuel type.

Report (written into this file under Findings): volumes, join coverage,
payload sizes, and a go/no-go recommendation for Phase B.

**No-go criteria:** join coverage below ~80% of MW, per-period payload too
large for a static-site data folder (>~5 MB), or endpoints requiring
pagination the stdlib client cannot sustain within polite rate limits.

## Phase B — only if go, and after a check-in

- `etl/build_bmu_snapshot.py` → `app/data/bmu_snapshot.json`: the **latest
  complete settlement period only** (~2,000 rows: bmu id, name, fuel type,
  PN MW, capacity if derivable), a few tens of kB.
- New Merit-tab panel "Observed dispatch by unit (beta)": units grouped by
  technology, sorted by loading — volumes badged **Observed**; any cost
  attribution reused from cluster SRMC ranges badged **Estimated**.
- Caption states plainly: observed dispatch, not the bid stack.
- methodology.md: formula-free entry describing the join, plus a judgement
  call on PN-vs-metered-output (PN is intent, FPN revisions happen).

Phase B is expected to approach the ~500-line ceiling → per the working
rules, a check-in with the approach summary happens before Phase B code.

## Findings (investigation run 2026-07-01, sample day 2026-06-30)

| Check | Result |
|---|---|
| BMU registry (`/reference/bmunits/all`) | 3,025 units; 469 carry a `fuelType` (19 types) — the rest are supplier/secondary units |
| PN per settlement period (`/datasets/PN?settlementDate=&settlementPeriod=`) | ~2,600 records, 2,485 units, ~600 kB raw, 32–42 GW notified |
| **PN MW joinable to a fuel type** | **83.3–89.2%** across night / morning-peak / afternoon periods — above the 80% go threshold |
| BOALF full day (`/datasets/BOALF/stream?from=&to=`) | works keylessly: 14,890 acceptance records, 205 units, 6.3 MB/day |

Endpoint notes: the PN *stream* variant 404s for settlementDate/
settlementPeriod parameters — the plain dataset endpoint (wrapping rows in
`{"data": […]}`) is the correct one. BOALF streams fine with `from`/`to`.

Interpretation:

- **Go** for the scoped deliverable (latest-period observed dispatch
  snapshot). The unjoined 11–17% of MW is dominated by units without a
  registry fuel type (batteries, DSR, small embedded aggregations) — it
  should be shown as an explicit "Unclassified" category, not dropped.
- A full-day BOALF feed (6.3 MB) is too heavy for the static data folder,
  confirming the snapshot-only scope. Acceptance counts/price ranges can be
  summarised per fuel type in the snapshot instead.
- A true bid stack remains out of reach (PN has no prices) — unchanged from
  the up-front framing.

## Status

Done (Phase B built 2026-07-02 after user go-ahead; check-in rule waived).

- `etl/build_bmu_snapshot.py` → `app/data/bmu_snapshot.json` (56 kB): 564
  units, 25.7 GW notified at SP17 2026-07-02, **95.4% of MW classified**
  once interconnector units are excluded on both the fuelType and the
  `I_` id-prefix convention (the investigation's 83–89% figure was dragged
  down by interconnector flows misread as unclassified dispatch).
- Per-unit MW is the time-weighted mean of the PN level profile across the
  half-hour; latest complete settlement period derived from Europe/London
  local time (clock-change days handled). BOALF acceptance counts per fuel
  included; snapshot registered in the manifest for cache-busting; refreshed
  daily by `ops/refresh.sh` (non-fatal on failure).
- Panel "Observed dispatch by unit (beta)" live on the Merit tab: grouped by
  technology in stack order, Unclassified explicit and last, volumes badged
  **Observed**, tooltip SRMC cluster ranges badged **Estimated**,
  charging/pumping units excluded. Methodology entry (`m-bmu`) and judgement
  call 8 added. Verified in the browser on port 8872: real data (Heysham 2
  at 645 MW / 95% loaded, ~20 GW wind fleet), tooltips correct for both
  classified and unclassified units, zero console errors.

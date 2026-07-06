# Methodology

Companion to the in-app Methodology tab (which is generated from ETL metadata
at runtime — if the two ever disagree, trust the app). All timestamps UTC;
half-hourly values are settlement-period interval starts.

## Canonical schema

`series_hh.json` — columnar, one shared time axis:

| Field | Unit | Source | Quality |
|---|---|---|---|
| `t` | epoch seconds (UTC, interval start) | — | — |
| `price` | £/MWh | Elexon MID, volume-weighted over providers | observed |
| `demand` | MW | Elexon INDO | observed |
| `solar` | MW | PV_Live national | observed (model-estimated standard) |
| `CCGT, WIND, NUCLEAR, …` | MW | Elexon FUELHH | observed |
| `INTFR, INTNSL, …` (10 cables) | MW, +ve = import | Elexon FUELHH | observed |
| `netImports` | MW | derived: Σ INT* | derived from observed |
| `renewables` | MW | derived: WIND + solar | derived from observed |

`series_daily.json` — daily means of the above (simple time averages of
non-null half-hours; `price_max` is the daily half-hourly maximum), plus:

| Field              | Unit                | Source                          | Quality                                                  |
| ------------------ | ------------------- | ------------------------------- | -------------------------------------------------------- |
| `gas_sap`          | £/MWh thermal (HHV) | National Gas SAP ×10 from p/kWh | observed                                                 |
| `carbon_uka_month` | £/tCO2              | gov.uk CCM monthly average      | observed monthly                                         |
| `carbon_ffill`     | boolean             | —                               | true where UKA carried forward past last published month |
| `coal_proxy_gbp_mwh` | £/MWh thermal     | World Bank Pink Sheet (Newcastle 6,000 futures, USD/t) ÷ BoE USD/GBP ÷ 6.978 | proxy / derived |
| `coal_ffill`       | boolean             | —                               | true where the coal proxy is carried forward past the last published month |

`manifest.json` — publication metadata, not market data: a monotonically
increasing `version` (the app appends `?v=<version>` to data URLs, so a new
publication busts browser caches deterministically), `built_at`, `mode`
(`full` or `incremental`), per-file `sha256`/`bytes`, and the `zones` list
(currently `["GB"]`). The app fetches it with `cache: "no-store"` and falls
back to un-versioned URLs when it is absent.

`bmu_snapshot.json` (optional; written by `etl/build_bmu_snapshot.py`) —
observed dispatch at BM Unit level for the most recent complete settlement
period: per-unit time-weighted mean physical-notification MW (Observed),
fuel type and registered capacity from the BM Unit registry, per-fuel BOALF
acceptance counts, and a coverage block stating the classified share of MW.
Units notifying zero and interconnector units are omitted; units without a
registry fuel type are kept with `fuel: null`. The app renders the snapshot
as a dispatch curve (cumulative notified GW against the cluster SRMC
midpoint, cheapest first); units with no SRMC benchmark — unclassified plus
pumped storage, oil and "other" — are counted under the caption but not
plotted, since their vertical position would be invented.

## Formulas

**Clean spark spread** (£/MWh, daily, Estimated):

    spark = price − gas_SAP / η − (EF_gas / η) · UKA − VOM

Defaults: η = 0.50 (HHV), EF_gas = 0.184 tCO2/MWh th, VOM = £3/MWh.

**Clean dark spread** (Proxy / Derived by default; Assumption when a manual
coal price overrides the proxy):

    dark = price − coal / η_coal − (EF_coal / η_coal) · UKA − VOM_coal

Defaults: η_coal = 0.36, EF_coal = 0.34 tCO2/MWh th, VOM = £5/MWh.

**Coal benchmark proxy** (Proxy / Derived):

    coal £/MWh th = (USD per tonne) ÷ FX(USD per GBP, monthly mean) ÷ 6.978

USD/t is the World Bank Pink Sheet monthly average of the Australian
6,000 kcal/kg FOB Newcastle futures price; FX is the monthly mean of the
Bank of England daily USD/GBP spot (XUDLUSS); 6.978 MWh th/t follows from
6,000 kcal/kg = 25.12 GJ/t. Newcastle FOB is a different basis from API2
CIF ARA (the commercial European benchmark) — levels track, not equal.

**CCGT SRMC** (used for the merit band and decomposition):

    SRMC(η) = gas_SAP / η + (EF_gas / η) · UKA + VOM

The fleet band uses η ∈ [0.45, 0.57] by default.

**Residual load** (Estimated):

    residual = INDO − WIND(transmission)

Solar is deliberately **not** subtracted. INDO is transmission-level demand
and is therefore already net of all embedded generation — embedded solar and
embedded wind suppress it in real time. Subtracting PV_Live solar on top
would double-count it (an earlier version did, which is why residual load
could go negative on sunny middays). The identity that makes this the
national net load: underlying demand − all wind − all solar
= (INDO + embedded gen) − all wind − all solar = INDO − transmission wind.

**Low-carbon share** (Estimated): (nuclear + biomass + hydro + pumped
storage + wind + solar) ÷ total supply incl. positive net imports. Imports
are in the denominator only, since their origin mix is unobserved.

**SRMC cost model** (Estimated): SRMC ranges per technology cluster at
the latest observed gas/UKA prices with stated efficiency spans. Wind/solar/
nuclear/hydro ranges are VOM-style estimates; biomass uses a broad published
range and is marked as containing assumptions. This model drives the
merit-order curve and the cost attribution in the observed-dispatch panel.
(The standalone "implied merit order" bar panel was removed as redundant:
the merit-order curve presents the same ranges at tranche granularity plus
the demand and clearing lines.)

**Merit-order curve** (Estimated): the same SRMC model laid out against
cumulative available capacity. Each technology's SRMC range is split into
0.5 GW tranches with cost rising linearly across the technology (efficient
units first); all tranches are then sorted globally by SRMC, giving a
contiguous, monotonically non-decreasing stack in which technologies
interleave where cost ranges overlap. Capacity proxies: dispatchables at the
98th percentile of observed half-hourly output over the dataset; wind and
solar at latest observed output (must-run price-takers). The demand line is
latest INDO minus net imports; the implied clearing price is the SRMC of the
tranche that serves that level. Pumped storage, oil and "other" are excluded
(no defensible SRMC benchmark).

**Price vs net load** (Estimated):

    net load = INDO − WIND(transmission)

Observed half-hourly price scattered against derived net load, with an
optional median-per-2-GW-bin overlay (bins with < 12 half-hours dropped).
Same reasoning as residual load: INDO already nets off embedded solar, so
PV_Live solar appears in the tooltip as context but not in the formula.

**Import-aware low-carbon share** (Estimated, GB Overview): per
half-hour, `(GB low-carbon + Σ import_flow × zone_low_carbon_fraction) /
(GB generation + Σ import_flow)`, where each importing cable is attributed
at its counterparty zone's own low-carbon generation fraction from the
ENTSO-E zone datasets. First-order counterparty-mix attribution only (no
flow tracing; the zone's own imports are not re-attributed). Exists only over the
accumulated zone history (append-only from late May 2026, extended by the
daily refresh) — no backfill; missing zone data at a timestamp reverts that
cable to denominator-only. Shown beside, never
spliced into, the unbroken headline metric.

**Counterparty context** (Flows tab): per-cable flow (Observed) with the
counterparty zone's day-ahead price converted at daily BoE EUR/GBP
(`fx_eur_per_gbp`, series XUDLERS — Derived, indicative only: day-ahead
auction vs within-day MID) and the zone's generation mix (context, not
attribution of the cable's electrons). Zone history accumulates append-only
(~6 kB/day/zone; `--retain-days` trims as a fallback if size ever
matters); longer ranges clip to the overlap, which deepens over time. DE_LU is a reference market with no GB
cable and is excluded.

## Judgement calls a reviewer should know about

1. **MID, not day-ahead.** The dashboard's "price" is the Market Index Data
   price. It tracks the day-ahead auction closely in normal conditions but
   diverges in stressed periods. Chosen because it is the only free,
   half-hourly, officially published GB price series.
2. **UKA forward-fill.** CCM monthly averages lag ~1–2 months. Spreads in the
   most recent weeks therefore use a carried-forward carbon price, flagged in
   the KPI and via `carbon_ffill`. The alternative — dropping recent spreads
   entirely — was judged less useful than a flagged estimate.
3. **Gas day vs calendar day.** SAP applies to gas days (05:00–05:00). It is
   mapped to the calendar date of the gas day start; the sub-day mismatch is
   immaterial at daily resolution.
4. **Averaging MID daily.** The daily price is the simple mean of half-hourly
   MID prices (not volume-weighted across the day), consistent with how the
   intraday-shape and histogram panels treat the series.
5. **Embedded wind.** Roughly 6 GW of GB wind capacity is
   distribution-connected and invisible here. Because residual/net load are
   computed as INDO − transmission wind, embedded wind is correctly (if
   silently) absorbed on the demand side; the bias is confined to *gross*
   metrics — wind output, renewables output and low-carbon share all
   understate GB wind. The Methodology tab says so.
6. **Coal proxy basis.** Newcastle FOB futures (public, monthly) stand in for
   API2 CIF ARA (commercial). Freight and quality differences mean the proxy
   tracks but does not equal the European benchmark; the dark spread is
   therefore directional, and is labelled Proxy / Derived rather than
   Observed. A manual coal entry overrides the proxy and is labelled
   Assumption.
7. **Merit-curve capacity proxy.** p98 of observed output understates
   registered capacity for rarely-run technologies (OCGT especially) and says
   nothing about outages on a given day. The implied clearing price is a
   cost-model diagnostic, not a dispatch reconstruction.
8. **PN is intent, not metered output — and not a bid stack.** The observed
   dispatch panel shows final physical notifications: what units told the
   system operator they intended to run at, not what meters recorded, and
   with no prices attached (bid prices are not in free data). It is an
   observation of dispatch behaviour that complements the SRMC model; the
   tooltip's cost range is an Estimated cluster attribution, never a
   unit-level cost. Units without an SRMC benchmark (no registry fuel type —
   largely batteries, DSR and aggregations — plus pumped storage, oil and
   "other") are not plotted on the dispatch curve, because their vertical
   position would be invented; their count and GW are stated under the
   caption instead, so the gap is visible rather than silently dropped.
9. **Incremental refresh re-fetches the last two stored days.** Elexon and
   PV_Live revise recent periods after first publication, so an incremental
   run does not trust the stored tail: it re-fetches the last stored day and
   the day before it (bypassing the on-disk HTTP cache, whose chunk-aligned
   keys would serve the stale first answer), overwrites any revised values,
   and only then appends. A validation guard refuses to publish a merged
   dataset whose time axis is broken or whose coverage falls more than two
   percentage points below the published one — a failed refresh leaves the
   live files untouched. If nothing changed upstream, nothing is written and
   the manifest version does not move, so browsers keep their cached copy.

# Methodology

This file and the in-app Methodology tab split the documentation deliberately. The tab explains each panel's sourcing and maths next to the panels themselves, and its source and coverage tables render from live ETL metadata at runtime, so for what the dashboard is currently doing, trust the tab. This file is the reviewer document: the canonical schema, the formula register, the data windows and the judgement calls live here, and the judgement calls exist nowhere else. Where the two overlap in hand-written prose (utilisation ranking, low-carbon share, the spreads) each copy is maintained separately, so treat the tab as current for behaviour and this file as canonical for rationale. All timestamps are UTC. Half-hourly values are stamped with the start of their settlement interval.

## Canonical schema

`series_hh.json` – columnar, one shared time axis:

| Field | Unit | Source | Quality |
|---|---|---|---|
| `t` | epoch seconds (UTC, interval start) | – | – |
| `price` | £/MWh | Elexon MID, volume-weighted over providers | observed |
| `demand` | MW | Elexon INDO | observed |
| `solar` | MW | PV_Live national | observed (model-estimated standard) |
| `CCGT, WIND, NUCLEAR, …` | MW | Elexon FUELHH | observed |
| `INTFR, INTNSL, …` (10 cables) | MW, +ve = import | Elexon FUELHH | observed |
| `netImports` | MW | derived: Σ INT* | derived from observed |
| `renewables` | MW | derived: WIND + solar | derived from observed |

**Price series scope: MID, not day-ahead.** The dashboard's "price" is the Market Index Data price. It tracks the day-ahead auction closely in normal conditions but diverges in stressed periods. It is used because it is the only free, half-hourly, officially published GB price series. One deliberate exception: the System stress tab uses SSP instead, the settlement price of the balancing actions NESO actually took, where MID measures traded wholesale sessions. The reasoning is spelled out with the stress flag rules below.

`series_daily.json` – daily means of the above (simple time averages of non-null half-hours, and `price_max` is the daily half-hourly maximum), plus:

| Field | Unit | Source | Quality |
|---|---|---|---|
| `gas_sap` | £/MWh thermal (HHV) | National Gas SAP ×10 from p/kWh | observed |
| `carbon_uka_month` | £/tCO2 | gov.uk CCM monthly average | observed monthly |
| `carbon_ffill` | boolean | – | true where UKA carried forward past last published month |
| `coal_proxy_gbp_mwh` | £/MWh thermal | World Bank Pink Sheet (Newcastle 6,000 futures, USD/t) ÷ BoE USD/GBP ÷ 6.978 | proxy / derived |
| `coal_ffill` | boolean | – | true where the coal proxy is carried forward past the last published month |

`manifest.json` holds publication metadata, not market data. It carries a `version` counter that only goes up, `built_at`, `mode` (`full` or `incremental`), a `sha256` and byte size per file, and the list of zones (GB plus any fetched ENTSO-E zones). The app appends `?v=<version>` to every data URL, so each new publication busts browser caches deterministically. The manifest itself is fetched with `cache: "no-store"`. If it is absent, the app falls back to un-versioned URLs.

`bmu_snapshot.json` (optional, written by `etl/build_bmu_snapshot.py`) records observed dispatch at BM Unit level for the most recent complete settlement period. Per unit it stores the time-weighted mean physical-notification MW (Observed), the fuel type and registered capacity from the BM Unit registry, and per-fuel counts of BOALF acceptances. A coverage block states what share of MW was classified to a fuel. Units notifying zero and interconnector units are omitted. Units with no registry fuel type are kept with `fuel: null`. The app draws the snapshot as a dispatch curve, cumulative notified GW against each cluster's SRMC midpoint, cheapest first. Units with no SRMC benchmark (unclassified, pumped storage, oil, "other") are counted under the caption but not plotted, because their vertical position would be invented.

`stress_daily.json` (optional, written by `etl/fetch_stress.py`) holds one row per day over the trailing year. It is append-only, keeps at least 400 days, and its retention is independent of the core window:

| Field | Unit | Source | Quality |
|---|---|---|---|
| `freq_min/max`, `freq_coverage_pct` | Hz, % | Elexon FREQ (15 s samples, UTC days) | observed |
| `secs_below_49p8/49p5`, `secs_above_50p2` | seconds | derived: 15 s per qualifying sample | derived from observed |
| `freq_rejected_samples` | count | samples outside 45–55 Hz treated as gaps (feed artefacts, e.g. literal 0.0 Hz) | – |
| `lolp_max_{1,8,12}h`, `drm_min_{1,8,12}h` | probability, MW | Elexon loss-of-load forecast | observed |
| `ssp_max/min`, `ssp_max_sp` | £/MWh | Elexon settlement system prices (local settlement days) | observed |
| `emn_count` | count | SYSWARN EMN issuances, publish-date attribution (UTC), cancellations excluded | observed |
| `flags[]` | `{type, value, threshold}` | four typed rules, computed at build against point-in-time trailing baselines: up to 365 d strictly before the day, and percentile rules need at least 90 d of history | derived from observed |
| `pctl` | `{ssp_max, lolp_max, drm_min}` each `{p, band}` | display-only midrank percentile against the same point-in-time window, stress-oriented (DRM inverted: p = share of trailing days with more margin), bands at p99/95/90/50, and `p: null, band: "insufficient history"` under 90 d. Flags and thresholds unaffected. LoLP's distribution is zero-inflated (the median day is 0), so any nonzero LoLP ranks high: relative rank, not absolute severity | derived from observed |

A day is flagged when any of four rules fires. `frequency` fires when seconds below 49.8 Hz reach max(trailing p99, 60 s). `price` fires when the daily max SSP reaches the trailing p99. `emn` fires when at least one EMN was issued that day. `adequacy` fires when the max LoLP across horizons reaches max(trailing p99, 0.01). Flags are persisted and never recomputed retroactively. They mark notable days, not security margins. The price series here is SSP rather than MID, deliberately: SSP is the settlement price of the balancing actions the operator actually took, the realised cost of real-time scarcity, where MID measures traded wholesale sessions. Both spiked on 23 Jun 2026, MID to its year-max £561 and SSP to its year-max £800, and the detector prices the balancing side.

`warnings.json` (optional, same pipeline) stores SYSWARN notices filtered to EMNs and emergency instructions, verbatim. `publishTime` is UTC. Times inside `warningText` are UK local and are never parsed. A per-category count of the full feed is kept as a snapshot, labelled with its fetch window.

`events/<date>/freq.json` (optional, same pipeline) stores grid-aligned 15 s frequency for **every flagged day**, any flag type: `start_utc`, `step_seconds`, `hz[5760]` with `null` gaps. The app fetches slices lazily, one per view. Each is ~40 kB on disk and none of it joins the eager page payload.

## Data windows

Every day-count in this project is one of three kinds, and they behave differently by design: a rolling analytical window moves forward daily and data leaving it is intended; accumulating history grows monotonically and never truncates, so anything that shortened it would be a bug; an infrastructure constraint bounds rare rebuild operations and is not an analytical choice at all. The table maps every documented day-count to its kind.

| Day-count | Applies to | Kind | Defined in |
|---|---|---|---|
| 365 d rolling | core GB dataset, every tab's charts | rolling analytical window | `etl/build_dataset.py` |
| trailing 90 d, sustained ≥ 2 h | utilisation ceiling (Flows ranking) | rolling analytical window | `app/js/metrics.js`, rules in this file |
| up to 365 d, point-in-time, strictly before each day | stress flag baselines | rolling analytical window | `etl/fetch_stress.py` |
| at least 90 d of history | stress percentile bands, else `insufficient history` | floor on the stress baselines, not a window itself | `etl/fetch_stress.py` |
| trailing 14 d | overnight AI summary z-score baselines | rolling analytical window | `ops/panel_facts.py` |
| append-only since 31 May 2026 | zone history: low-carbon import attribution, Flows differential, zone switcher | accumulating history; hosted snapshot-loss caveat in the utilisation ranking section | `etl/fetch_entsoe.py` |
| append-only, at least 400 d retained | `stress_daily.json` | accumulating history, independent of the core window | `etl/fetch_stress.py` |
| `--days 365` full rebuild, `--backfill 365` stress seed | first install and disaster recovery | infrastructure constraint | README, `.github/workflows/deploy.yml` |
| `--days 7` zone top-up | daily scheduled refresh | infrastructure constraint | `ops/refresh.py` |
| `ZONE_DAYS=60` | hosted cold start only; covers the accumulated zone history only until 30 Jul 2026 | infrastructure constraint | `.github/workflows/deploy.yml` |
| `--days 30` | manual zone-fetch default | infrastructure constraint | `etl/fetch_entsoe.py` |

## Formulas

**Clean spark spread** (£/MWh, daily, Estimated):

    spark = price − gas_SAP / η − (EF_gas / η) · UKA − VOM

Defaults: η = 0.50 (HHV), EF_gas = 0.184 tCO2/MWh th, VOM = £3/MWh.

**Clean dark spread** (Proxy / Derived by default, Assumption when a manual coal price overrides the proxy):

    dark = price − coal / η_coal − (EF_coal / η_coal) · UKA − VOM_coal

Defaults: η_coal = 0.36, EF_coal = 0.34 tCO2/MWh th, VOM = £5/MWh.

**Coal benchmark proxy** (Proxy / Derived):

    coal £/MWh th = (USD per tonne) ÷ FX(USD per GBP, monthly mean) ÷ 6.978

USD/t is the World Bank Pink Sheet monthly average of the Australian 6,000 kcal/kg FOB Newcastle futures price. FX is the monthly mean of the Bank of England daily USD/GBP spot rate (XUDLUSS). The 6.978 MWh th/t constant follows from 6,000 kcal/kg = 25.12 GJ/t. Newcastle FOB is a different basis from API2 CIF ARA, the commercial European benchmark. Levels track, they do not equal.

**CCGT SRMC** (used for the merit band and decomposition):

    SRMC(η) = gas_SAP / η + (EF_gas / η) · UKA + VOM

The fleet band uses η ∈ [0.45, 0.57] by default.

**Residual load** (Estimated):

    residual = INDO − WIND(transmission)

Solar is deliberately **not** subtracted. INDO is transmission-level demand, so it is already net of all embedded generation: embedded solar and embedded wind suppress it in real time. Subtracting PV_Live solar on top would count it twice. An earlier version did exactly that, which is why residual load could go negative on sunny middays. The identity that makes this the national net load: underlying demand − all wind − all solar = (INDO + embedded gen) − all wind − all solar = INDO − transmission wind.

**Low-carbon share** (Estimated): (nuclear + biomass + hydro + pumped storage + wind + solar) ÷ total supply including positive net imports. Imports sit in the denominator only, because their origin mix is unobserved.

**SRMC cost model** (Estimated): SRMC ranges per technology cluster at the latest observed gas and UKA prices, with stated efficiency spans. The wind, solar, nuclear and hydro ranges are VOM-style estimates. Biomass uses a broad published range and is marked as containing assumptions. This model drives the merit-order curve and the cost attribution in the observed-dispatch panel. (A standalone "implied merit order" bar panel was removed as redundant: the curve presents the same ranges at tranche granularity, plus the demand and clearing lines.)

**Merit-order curve** (Estimated): the same SRMC model laid out against cumulative available capacity. Each technology's SRMC range is split into 0.5 GW tranches, with cost rising linearly across the technology (efficient units first). All tranches are then sorted globally by SRMC. The result is a contiguous stack that never decreases, in which technologies interleave where their cost ranges overlap. Capacity proxies: dispatchables at the 98th percentile of observed half-hourly output over the dataset, wind and solar at latest observed output, since they are must-run price-takers. The demand line is the latest INDO minus net imports. The implied clearing price is the SRMC of the tranche that serves that level. Pumped storage, oil and "other" are excluded because no defensible SRMC benchmark exists for them.

**Price vs net load** (Estimated):

    net load = INDO − WIND(transmission)

Observed half-hourly price scattered against derived net load, with an optional overlay of the median per 2 GW bin (bins with fewer than 12 half-hours are dropped). Same reasoning as residual load: INDO already nets off embedded solar, so PV_Live solar appears in the tooltip as context but not in the formula.

**Import-aware low-carbon share** (Estimated, GB Overview): per half-hour, `(GB low-carbon + Σ import_flow × zone_low_carbon_fraction) / (GB generation + Σ import_flow)`. Each importing cable is attributed at its counterparty zone's own low-carbon generation fraction from the ENTSO-E zone datasets. This is first-order counterparty-mix attribution only: no flow tracing, and the zone's own imports are not re-attributed. It exists only over the accumulated zone history (append-only from 31 May 2026, extended by the daily refresh, no backfill; the 31 May start date is subject to the same hosted snapshot-loss exception as the utilisation ranking's; see that section's note). Where zone data is missing at a timestamp, that cable reverts to denominator-only. The line is shown beside the unbroken headline metric, never spliced into it.

**Counterparty context** (Flows tab): a selected cable's flow (Observed) alongside the counterparty zone's day-ahead price and generation mix. The price converts at the daily BoE EUR/GBP rate (`fx_eur_per_gbp`, series XUDLERS) and is Derived, indicative only: a day-ahead auction price against GB's within-day MID. The mix is zone-wide context, not attribution of the cable's electrons. Zone history accumulates append-only at ~6 kB/day/zone (`--retain-days` can trim it if size ever matters). Longer ranges clip to the overlap, which deepens over time. DE_LU is a reference market with no GB cable and is excluded here. The flow chart overlays the cable's per-direction operational ceilings (dashed) and cited nameplate (dotted). The flow axis is fixed to the design envelope, ±1.05 × max(nameplate, ceilings), so the gap between design and practice stays visible instead of being autoscaled away. Congestion-proxy half-hours are shaded amber, with definitions identical to the Utilisation ranking and Congestion proxy entries below (the code paths are shared): an approximation, not a shadow price. The axis tooltip repeats that label over shaded periods, and the caption counts the shaded half-hours in view.

**Utilisation ranking** (Flows tab, flows Observed, ceilings and differential Proxy / Derived). Per cable and direction, the operational ceiling is the highest flow sustained for at least 2 hours over the trailing 90 days. That means 4 half-hours, not necessarily consecutive, in other words the 4th-largest reading. The window rolls forward with each refresh. A plain max is not robust here: the FUELHH interconnector columns carry occasional single-half-hour spike artefacts well above anything the cable sustains, and an unfiltered max would lift a pegged cable's ceiling above its true plateau and zero its utilisation count. A nameplate-based plausibility cap fails the other way, because cables can genuinely sustain flows somewhat above their published rating. The sustained rule drops isolated artefacts and keeps genuine plateaus without consulting nameplate. Dated examples of both failure modes are in the CHANGELOG entry for this panel. GB interconnectors sit outside any flow-based capacity-calculation region (capacity is allocated per cable), so no technical limit or shadow price is published. The observed ceiling self-adjusts to de-ratings and phased ramp-ups. A direction whose ceiling falls below 5% of nameplate is treated as offline rather than flagging noise as utilisation. Near-capacity means |flow| ≥ 90% of that ceiling, tested per half-hour over the selected range. The table ranks cables by near-capacity share and shows the mean GB MID − counterparty day-ahead differential over exactly those half-hours (daily BoE EUR/GBP conversion, indicative only, since the two prices come from different market segments). The two dates in the panel caption differ in kind, not by typo. The ceiling window is rolling, trailing 90 days, and shifts daily. 31 May 2026 is a fixed start date, the day zone price collection began (append-only, no backfill), and it never moves under normal operation; the one exception is a full loss of the hosted deploy's state snapshot after 30 Jul 2026, whose automatic cold rebuild refetches only a 60-day zone window and would start the series later until a manual backfill restores the older history (see `.github/workflows/deploy.yml`). Three cables share one counterparty price series: Moyle lands in Northern Ireland and East-West/Greenlink in the Republic of Ireland, but all three connect GB to the same all-island SEM bidding zone, so their differentials use the same SEM day-ahead series. The rows stay distinct because each differential is averaged over that cable's own near-capacity half-hours. A view toggle offers the flat ranking (default) or grouping by counterparty market, with groups ordered by each market's best near-capacity share and the within-group order keeping the ranking. The toggle is presentation only, the metrics are identical in both views.

Nameplate reference capacities are shown for context and never used in the near-capacity test. They are operator-published design ratings, cross-checked 2026-07-10 against DESNZ, "Electricity interconnectors' contribution to security of supply" (October 2025, capacity-market derating annex, assets.publishing.service.gov.uk) and Elexon's interconnector register (elexon.co.uk/bsc/about/interconnectors/): IFA 2,000 MW · IFA2 1,000 MW · ElecLink 1,000 MW · BritNed 1,000 MW · Nemo Link 1,000 MW · NSL 1,400 MW · Viking Link 1,400 MW · Moyle 500 MW · East-West 500 MW · Greenlink 500 MW. The constants live in `app/js/data.js` (`INTERCONNECTORS.nameplate_mw`).

**Congestion proxy** (Utilisation ranking column, an approximation, NOT a shadow price). A half-hour is flagged only when BOTH conditions hold: |flow| at or above 90% of the cable's operational ceiling, AND the GB−zone spread wide in the direction the flow earns. "Wide" means importing with Δ = GB − zone at or beyond the market's p75 (and ≥ £5/MWh), or exporting with Δ at or beyond the p25 (and ≤ −£5/MWh). The spread population is every overlap half-hour for that market over the full accumulated zone window. Those thresholds are fixed. They do not move when the view range changes, and cables landing in the same zone share them. Why a proxy rather than an observation: GB left the EU single day-ahead coupling (SDAC) at the end of 2020. Capacity on GB–EU interconnectors is allocated through explicit day-ahead capacity auctions that close before the energy auctions, and the TCA's proposed replacement (multi-region loose volume coupling) remains unimplemented (checked 2026-07-10). So no flow-based shadow price exists to observe. Two exclusions are deliberate. Wide spread with slack flow is not flagged, because that pattern is consistent with an outage or ramp limit rather than scarce capacity. At-ceiling flow against the price signal is not flagged, because that is emergency-action shaped: at-limit, but not congestion rent. Known limitation, recorded so it is never re-investigated: a full RAM decomposition (IVA / FRM / AAC / Fnrao / F0−Fnrao, as shown on flow-based CCR dashboards) cannot be built for GB. It needs TSO-level flow-based allocation data that does not exist for per-cable explicitly allocated interconnectors, and simulating the components would fabricate data.

## CSV downloads

The ⤓ CSV button downloads the data behind the active tab. The filename encodes the tab, the date window and, where the tab has one, the selected resolution. The button is hidden on Glossary and Methodology, since neither view has data behind it.

**`<zone>_market_<from>_<to>_<res>.csv`** (Overview, Prices, Generation).
Observed data, net imports derived.

| Column | Contents |
|---|---|
| `timestamp_utc` | interval start, ISO |
| `price_<currency>_mwh` | zone's settlement currency, lower-cased code |
| `demand` | MW |
| one column per fuel | only fuels that carry a real signal in this zone |
| `net_imports_mw` | present only where interconnector data exists (GB) |

Values are bucket means at the selected resolution.

**`gb_spreads_<from>_<to>.csv`** (Spreads). Observed inputs, Estimated spreads, coal Proxy or Assumption depending on source. Existing daily columns, including `carbon_is_ffill` and `coal_is_ffill`. The coal trio
(`coal_proxy_gbp_mwh_th`, `coal_is_ffill`, `clean_dark_gbp_mwh`) appears only when a coal price exists. A manual coal entry overrides the ETL proxy and leaves `coal_is_ffill` blank for that row.

**`gb_flows_<from>_<to>_<res>.csv`** (Flows). `timestamp`, `net_imports_mw`, and one signed MW column per cable, positive for import. Two honest notes:

- Per-cable cells keep gaps as gaps, but `net_imports_mw` counts a missing cable reading as zero. A row with a gap in one cable, therefore, does not sum exactly across the row. This is existing behaviour, stated here, not fixed.
- Utilisation and congestion columns are deliberately absent. They are window-level derived views, not per-row quantities (see the Utilisation ranking and Congestion proxy entries above): the ceilings come from a  trailing 90-day window, so a per-row percentage would be a metric the tab never computes. To reproduce the ranking table's ceilings and near-capacity shares from an export, take a 30-minute export covering the trailing 90 days (the 3M preset or longer) and apply the documented rules: the 4th-largest reading per direction, the 90% near-capacity threshold, and the 5% nameplate floor for treating a direction as offline. The congestion proxy is NOT reproducible from exports alone. It also needs the counterparty day-ahead price series, which is not in this file.

**`gb_stress_<from>_<to>.csv`** (System stress, daily). The metric columns mirror the `stress_daily.json` fields already tabulated in the System stress section above, so they are not repeated here, plus `emn_count` and `flags`.

`emn_count` is the number of Electricity Margin Notices issued that day, observed from Elexon SYSWARN with publish-date attribution and cancellation notices excluded. 0 means no EMN was issued that day. In the
underlying `stress_daily.json` the key is present only on days with at least one issuance, and the CSV writes the zero explicitly.

`flags` is the day's fired flag types joined with a `+` sign, empty when none are fired. Per-flag values and thresholds and the display-only `pctl` percentile context stay in `stress_daily.json`, which this file points at rather than duplicating.

**`gb_merit_<date>.csv`** (Merit order). One row per plotted tranche of the modelled curve, sorted SRMC ascending. Estimated throughout. It is a snapshot of the latest observed inputs, dated by the window end, not a
range series.

| Column | Meaning |
|---|---|
| `capacity_basis` | `latest_observed` for wind and solar, `p98_observed` for everything else |
| `contains_assumptions` | true where the technology's SRMC range is a broad estimate (see Formulas above) |
| `gas_sap_gbp_mwh_th`, `carbon_uka_gbp_t`, `coal_gbp_mwh_th` (when present) | the constant inputs held fixed across every row, so the file is self-reproducing against the SRMC formulas above |

Two related exports live elsewhere, not in this file: the observed-dispatch panel's raw per-unit data is already a served file at `data/bmu_snapshot.json` (schema documented above), and the SRMC-vs-price time series is reproducible from the spreads CSV + the CCGT SRMC formula above.

No export contains free text. Every value is a number, an ISO date or timestamp, a boolean, or a value from a fixed token set, because the CSV writer does no comma-escaping.

## Zone set (Europe extension)

Two inclusion rules, never mixed silently. *Interconnected* zones are GB's physical counterparty bidding zones, one per cable landing market: FR (IFA, IFA2, ElecLink), NL (BritNed), BE (Nemo), NO_2 (North Sea Link), DK_1 (Viking Link) and IE/SEM (Moyle, EWIC, Greenlink). DE_LU has **no direct GB cable**. It is included as a *reference market* only, the European price anchor, labelled "· ref" in the switcher and flagged on the Methodology tab so it is never read as a flow counterparty. Settlement currency is read from each zone's A44 response (EUR for all current zones, NO_2 included), never assumed. Merit order, Spreads and Flows stay GB-only: there are no per-zone SRMC assumptions, ENTSO-E data has no CCGT/OCGT split, and cross-border flows are not fetched per zone. Those tabs therefore hide off-GB, and the in-app Methodology tab says why. IE quirk: ENTSO-E publishes each document type against a specific area type. Day-ahead prices sit under the SEM bidding-zone EIC, and load sits under the Ireland control-area EIC. Both codes are current, and the fetcher handles the split automatically, confirmed by probing the API directly and against ENTSO-E's published area-code documentation.

## Judgement calls a reviewer should know about

Several of these choices turn on day-counts; the Data windows table above states which kind of window each one is.

1. **MID, not day-ahead.** The dashboard's "price" is the Market Index Data price. It tracks the day-ahead auction closely in normal conditions but diverges in stressed periods. Chosen because it is the only free, half-hourly, officially published GB price series.
2. **UKA forward-fill.** CCM monthly averages lag by one to two months. Spreads in the most recent weeks therefore use a carried-forward carbon price, flagged in the KPI and via `carbon_ffill`. The alternative, dropping recent spreads entirely, was judged less useful than a flagged estimate.
3. **Gas day vs calendar day.** SAP applies to gas days (05:00–05:00). It is mapped to the calendar date the gas day starts on. The sub-day mismatch does not matter at daily resolution.
4. **Averaging MID daily.** The daily price is the simple mean of half-hourly MID prices, not volume-weighted across the day. The intraday-shape and histogram panels treat the series the same way.
5. **Embedded wind.** Roughly 6 GW of GB wind capacity is distribution-connected and invisible to every source used here. Because residual and net load are computed as INDO − transmission wind, embedded wind is correctly (if silently) absorbed on the demand side. The bias is confined to *gross* metrics: wind output, renewables output and low-carbon share all understate GB wind. The Methodology tab says so.
6. **Coal proxy basis.** Newcastle FOB futures (public, monthly) stand in for API2 CIF ARA (commercial). Freight and quality differences mean the proxy tracks the European benchmark but does not equal it. The dark spread is therefore directional, and it is labelled Proxy / Derived rather than Observed. A manual coal entry overrides the proxy and is labelled Assumption.
7. **Merit-curve capacity proxy.** The 98th percentile of observed output understates registered capacity for rarely-run technologies (OCGT especially) and says nothing about outages on a given day. The implied clearing price is a cost-model diagnostic, not a dispatch reconstruction.
8. **PN is intent, not metered output, and not a bid stack.** The observed-dispatch panel shows final physical notifications: what units told the system operator they intended to run at. It is not what meters recorded, and it carries no prices (bid prices are not in free data). It is an observation of dispatch behaviour that complements the SRMC model. The tooltip's cost range is an Estimated cluster attribution, never a unit-level cost. Units without an SRMC benchmark (no registry fuel type, largely batteries, DSR and aggregations, plus pumped storage, oil and "other") are not plotted on the dispatch curve, because their vertical position would be invented. Their count and GW are stated under the caption instead, so the gap is visible rather than silently dropped.
9. **Incremental refresh re-fetches the last two stored days.** Elexon and PV_Live revise recent periods after first publication, so an incremental run does not trust the stored tail. It re-fetches the last stored day and the day before it, bypassing the on-disk HTTP cache (whose chunk-aligned keys would serve the stale first answer), overwrites any revised values, and only then appends. A validation guard refuses to publish a merged dataset whose time axis is broken or whose coverage falls more than two percentage points below the published one. A failed refresh leaves the live files untouched. If nothing changed upstream, nothing is written and the manifest version does not move, so browsers keep their cached copy.
10. **Interconnector ceilings are observed, not published.** The utilisation panel's per-direction ceiling is the highest flow sustained ≥2 h over the trailing 90 days, deliberately preferred to nameplate. Nameplate overstates cables in de-rating or phased ramp-up (Moyle chronically, Viking Link at launch), while an observed ceiling mislabels nothing that actually flowed. The sustained-2h rule (the 4th-largest reading) exists because both simpler candidates fail on real data. A raw max is broken by isolated single-period metering spikes, which would lift a pegged cable's ceiling above its true plateau and zero its utilisation count. A nameplate plausibility cap clips genuine operation, because cables can sustain flows somewhat above their published rating. Dated examples of both failure modes are in the CHANGELOG entry for this panel. Known costs, accepted and stated: a persistent de-rating reads as "capacity", a 90-day window lags a recovery, a rarely-used direction's ceiling reflects use rather than capability (a cable that mostly flows one way has an unrevealing ceiling in the other direction), and 4 or more isolated spikes at the same level within a window would still set a false ceiling. Nameplate is retained as a cited reference column so the gap between design and practice stays visible. The near-capacity threshold (90%), ceiling window (90 days) and sustain length (2 h) are presentation choices, stated in the UI.
11. **The congestion flag is a two-condition proxy, conservative by design.** Requiring BOTH at-ceiling flow AND a direction-consistent wide spread means the flag under-counts congestion when thresholds miss borderline periods. It also deliberately refuses two tempting over-counts: wide spreads with slack flow (outages and ramp limits look like that) and counter-price at-limit flows (emergency actions look like that, and 23 Jun 2026 is the canonical example). The tail (p75/p25), the floor (£5/MWh) and the fixed spread population (the full accumulated zone window) are presentation choices, stated in the UI. None of it is a shadow price. GB's explicitly allocated cables publish nothing of the kind, which is also why the flag is named a proxy everywhere it appears.
12. **Stress flags use two complementary signal families, and the FREQ feed needs a plausibility band.** The Elexon FREQ dataset carries occasional literal-0.0 Hz samples: 18 days of the first 365-day backfill were affected, the worst carrying 404 such samples. A live grid cannot read 0.0 Hz, and unfiltered each sample counts as 15 s of fake excursion below both the 49.8 and 49.5 Hz thresholds. Samples outside 45–55 Hz are therefore gaps, never readings (the modern GB record has never left 48.8–50.5). On the rules themselves: LoLP and de-rated margin are *leading margin* indicators, and they stayed near zero through the year's worst delivery event (23 Jun 2026, max LoLP 0.0017). Frequency, price and EMNs are *outcome* indicators, and they stayed quiet through the year's clearest managed adequacy squeeze (8 Jan 2026: zero excursion seconds, no EMN, LoLP 0.036). Neither family may be dropped in favour of the other. The flag set is their union, and each flag carries the value and the exact point-in-time threshold it fired against.
13. **The overnight AI summary is Claude-only by design, not an oversight.** The panel is generated by invoking the Claude Code CLI as a version-controlled agent (`.claude/agents/dashboard-watcher.md`), authenticated against a Claude subscription rather than a metered API key, and the publish validator, the cost/turn logging and the transient-error retry all parse that CLI's own JSON result envelope. Supporting another provider is therefore not a swapped API key: it needs a second auth model, a second envelope format, and the publish guards re-validated against a different model's failure modes, assessed in [issue #29](https://github.com/lptva/gb-power-dashboard/issues/29) and judged not worth the ongoing maintenance for an optional panel that is off by default. Nothing else on the dashboard depends on it.

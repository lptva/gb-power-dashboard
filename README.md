# GB Power Market Intelligence Dashboard

A real-data market intelligence web app for the Great Britain power market, in the style of a commodity-analytics terminal. Single-page, static, no build step, driven entirely by public data fetched through a re-runnable ETL.

**This is not a stylised model.** Every observed series comes from a public market data source; every estimated or assumption-based metric is labelled as such in the UI, panel by panel.

## Quick start

```bash
# 1. Build the dataset (≈ 160 chunked API calls, ~3–5 min first run)
python3 ~/Documents/energy-modelling/03_projects/gb-power-dashboard-2/etl/build_dataset.py --days 365

# 2. Serve the app (any static server; file:// will not work)
cd ~/Documents/energy-modelling/03_projects/gb-power-dashboard-2
python3 -m http.server 8872 --directory app

# 3. Open http://localhost:8872
```

Requires Python 3.10+ and `certifi` (`pip install certifi`). No other dependencies — the ETL uses only the standard library, and the app is plain HTML/CSS/JS with a vendored copy of ECharts.

## Data sources

| Source | Data | Resolution | Auth | Licence/terms |
|---|---|---|---|---|
| [Elexon Insights API](https://bmrs.elexon.co.uk) | Generation by fuel incl. interconnectors (FUELHH), national demand (INDO), Market Index price (MID) | 30 min | none | free, open |
| [Sheffield Solar PV_Live](https://www.solar.sheffield.ac.uk/pvlive/) | GB solar outturn (embedded; invisible to Elexon) | 30 min | none | free, attribution |
| [National Gas data portal](https://data.nationalgas.com) | Gas System Average Price (SAP), item PUBOB603 | daily | none | free |
| [gov.uk UK ETS CCM table](https://www.gov.uk/government/publications/taking-part-in-the-uk-emissions-trading-scheme-markets) | Official average monthly UKA price | monthly | none | OGL |
| [World Bank Pink Sheet](https://www.worldbank.org/en/research/commodity-markets) | Australian thermal coal, 6,000 kcal/kg FOB Newcastle futures, monthly avg (USD/t) — **proxy** for the commercial API2 benchmark | monthly | none | CC BY 4.0 |
| [Bank of England IADB](https://www.bankofengland.co.uk/boeapps/iadb/) | USD/GBP daily spot (XUDLUSS), monthly-averaged for the coal conversion | daily | none | free |

Coal conversion: `£/MWh th = USD/t ÷ FX(USD per GBP) ÷ 6.978 MWh th/t`(6,000 kcal/kg = 25.12 GJ/t). The result is badged **Proxy / Derived** in the app; a manually entered coal price overrides it (relabelled Assumption).

Full field mapping, units, timestamp handling and transformations are in [methodology.md](methodology.md) and in the app's Methodology tab (which is
generated from the ETL's own metadata, so it cannot drift from the data).

## Architecture

```
etl/build_dataset.py     fetch (cached, chunked, retried) → normalise → write
data_raw/cache/          raw API responses keyed by URL hash (resume support)
app/
  data/series_hh.json    columnar half-hourly: epoch s + ~24 series (~2.4 MB/yr)
  data/series_daily.json daily aggregates + gas SAP + monthly UKA (+ ffill flags)
  data/meta.json         provenance registry: source, unit, quality, coverage
  js/data.js             load, slice, bucket-aggregate (no mutation)
  js/metrics.js          pure formulas: spreads, SRMC, merit ladder, histograms
  js/state.js            in-memory store + pub/sub (no browser storage APIs)
  js/charts.js           17 ECharts panels, per-panel error isolation
  js/ui.js               KPIs, assumption sliders, methodology, CSV export
  js/app.js              bootstrap + event wiring
  vendor/echarts.min.js  vendored — works offline once data is built
```

Design rules enforced throughout:

- **Observed vs estimated vs proxy vs assumption** — every panel and KPI carries a badge; assumption sliders (efficiencies, carbon intensity, VOM, coal override) re-derive estimates on the fly but never touch the stored historical layer.
- **No fabricated data** — the clean dark spread uses a clearly labelled futures-derived coal proxy (or your manual override); UKA and coal values beyond the last published month are forward-filled and explicitly flagged.
- **No browser storage** — state is in-memory only; reload restores defaults.

## Refresh process

Re-run `python etl/build_dataset.py --days 365` whenever you want newer data.
Raw responses are cached in `data_raw/cache/`, so a refresh only fetches new chunks; delete the cache or pass `--no-cache` to force a full re-fetch.
The app reads whatever is in `app/data/` at page load — no server restart needed beyond a browser refresh.

## Known limitations

- **MID is a proxy** for the GB spot price (volume-weighted short-term trades), not the day-ahead auction; auction prices are commercial data.
- **Gas SAP is a within-day average**, which lags the forward curve in fast markets; spreads computed from it are indicators, not tradable margins.
- **UKA is a monthly average** published with a lag; daily carbon settlement prices are ICE commercial data.
- **The coal proxy is FOB Newcastle, not API2 CIF ARA** — levels track the European benchmark but do not equal it (freight and quality basis differ).
- **Embedded wind (~6 GW)** is invisible to every free source used; "wind" here means transmission-metered wind. Residual/net load (INDO − wind)
  absorb it silently on the demand side; gross wind output and share metrics understate it.
- **Merit-curve capacity is a proxy** — p98 of observed output for dispatchables, latest output for wind/solar — not registered capacity.
- Technology-cluster merit order only — plant-level requires joining BM Unit-level data (see roadmap).

## Next steps to productionise

1. **Scheduled refresh** — ✅ done locally: a launchd job re-runs the ETL daily at 07:00 (see `ops/README.md`; install with `bash ops/install_schedule.sh`). For guaranteed daily runs regardless of laptop sleep, move the same script to a GitHub Action cron and publish `app/` to any static host or object storage behind a CDN.
2. **Incremental ETL** — ✅ done: `python etl/build_dataset.py --incremental` re-fetches only the last two stored days plus anything newer (~10 HTTP calls, seconds instead of minutes), merges, keeps the window rolling at 365 days and publishes atomically behind a validation guard. A versioned `app/data/manifest.json` cache-busts the data files; if nothing changed upstream, nothing is written. Falls back to a full rebuild when no readable dataset exists.
3. **API layer** — evaluated and **deferred** (see `plan/03-api-layer.md`): one consumer and a 2.3 MB payload do not justify a server to operate. Revisit triggers are documented there (second consumer, multi-zone payloads >10 MB, windows beyond the shipped year, AuthN/AuthZ needs); static JSON remains the interface either way.
4. **AuthN/AuthZ** — static front-end behind SSO (e.g. oauth2-proxy); nothing in the current data requires licensing, but commercial additions(day-ahead auction prices, daily UKA, API2 coal) would.
5. **Europe extension** — ✅ live (see `plan/04-europe-extension.md`):
   `etl/fetch_entsoe.py` (token from the environment or a project-root
   `.env` — never under `app/`, which is web-served) writes per-zone files
   under `app/data/zones/<zone>/`; the header zone switcher lazy-loads
   them.

   **Zone-set logic, stated explicitly.** Two inclusion rules, never mixed
   silently: *interconnected* zones are GB's physical counterparty bidding
   zones, one per cable landing market — FR (IFA/IFA2/ElecLink),
   NL (BritNed), BE (Nemo), NO_2 (North Sea Link), DK_1 (Viking Link) and
   IE/SEM (Moyle, EWIC, Greenlink). DE_LU has **no direct GB cable** and
   is included as a *reference market* only — the European price anchor —
   labelled "· ref" in the switcher and flagged on the Methodology tab so
   it is never read as a flow counterparty. Settlement currency is read
   from each zone's A44 response (EUR for all current zones, NO_2
   included), not assumed. Merit order, Spreads and Flows remain GB-only
   (no per-zone SRMC assumptions, no CCGT/OCGT split in ENTSO-E data,
   interconnector flows not yet fetched) — the tabs hide off-GB and the
   Methodology tab says why. IE quirk: ENTSO-E publishes each data
   item against a specific area type — prices against the SEM bidding-zone
   EIC, load against the Ireland control-area EIC (both current; verified
   empirically). The fetcher handles the split automatically.
6. **Plant-level merit order** — ✅ done, scoped honestly (see `plan/05-plant-level-merit-order.md`): free keyless data supports an *observed dispatch snapshot*, not a bid stack (PN carries no prices). `python etl/build_bmu_snapshot.py` writes per-unit physical notifications for the latest complete settlement period (~95% of MW classified to a fuel type; unclassified shown explicitly), rendered as the "Observed dispatch by unit (beta)" panel on the Merit tab and refreshed by the daily job alongside the dataset.

# Milestone 4 — Europe extension (ENTSO-E), design-first

## Goal

Design an ENTSO-E Transparency fetcher writing the same columnar schema with a
zone dimension, plus a zone switcher in the dashboard header. Implement as far
as free access allows.

## Hard constraint discovered up front

The ENTSO-E Transparency API token is free **but gated**: registration on
transparency.entsoe.eu plus an email to transparency@entsoe.eu with
"RESTful API access" in the subject, granted within ~3 working days. No token
exists in this environment, so this milestone delivers:

1. this design document,
2. a token-ready fetcher (`etl/fetch_entsoe.py`) that exits cleanly with
   registration instructions when `ENTSOE_TOKEN` is unset,
3. the zone plumbing in the front end (manifest-driven, GB-only today,
   degrades gracefully).

End-to-end verification against live ENTSO-E data is **not possible** until a
token exists. This is stated rather than worked around — no fabricated data.

## Data layout decision: per-zone files, not a zone column

```
app/data/series_hh.json          ← GB, legacy path, untouched
app/data/series_daily.json      ← GB, legacy path, untouched
app/data/meta.json               ← GB, legacy path, untouched
app/data/manifest.json           ← gains "zones": ["GB", "FR", …]
app/data/zones/FR/series_hh.json ← new zones live here
app/data/zones/FR/series_daily.json
app/data/zones/FR/meta.json
```

- A zone column would multiply the single-file payload by the zone count and
  break every existing consumer of the columnar format. Per-zone files load
  ~2.3 MB lazily on switch and leave GB completely untouched.
- The manifest (Milestone 2) is the zone registry; the front end never
  hard-codes a zone list.

## Fetcher design — `etl/fetch_entsoe.py`

- Token from `ENTSOE_TOKEN` environment variable. Absent → print registration
  instructions, exit 0 (not an error: expected state until registration).
- Endpoint: `https://web-api.tp.entsoe.eu/api` (GET, XML responses, stdlib
  `xml.etree.ElementTree` parsing — consistent with the no-dependency ETL).
- Document types used:
  - `A44` day-ahead prices (hourly or quarter-hourly by zone),
  - `A75` actual generation per production type,
  - `A65` (processType A16) actual total load.
- Starter zone set and EIC codes:

  | Zone | EIC |
  |---|---|
  | FR | 10YFR-RTE------C |
  | DE_LU | 10Y1001A1001A82H |
  | NL | 10YNL----------L |
  | BE | 10YBE----------2 |
  | NO_2 | 10YNO-2--------T |

- Output: identical columnar schema (`t` epoch seconds + named columns),
  written per zone under `app/data/zones/<zone>/`, with a per-zone `meta.json`
  whose `series` registry marks everything **Observed** (ENTSO-E is the
  official TSO-published source).

## The honest hard part: fuel-type mapping

ENTSO-E `A75` production types do not map 1:1 onto Elexon fuel codes:

| ENTSO-E type | Nearest Elexon column | Mismatch to document |
|---|---|---|
| Fossil Gas | CCGT + OCGT | ENTSO-E does not split CCGT/OCGT — merit-order assumptions per technology cannot be applied per unit-class |
| Fossil Hard coal | COAL | comparable |
| Nuclear | NUCLEAR | comparable |
| Wind Onshore + Wind Offshore | WIND | Elexon WIND is transmission-only; ENTSO-E includes most onshore — residual-load formulas differ by zone |
| Solar | solar | GB solar is a PV_Live *estimate*; ENTSO-E solar is TSO-published — different quality labels for the same concept |
| Hydro Run-of-river / Reservoir | NPSHYD | comparable in aggregate |
| Hydro Pumped Storage | PS | comparable |
| Biomass | BIOMASS | comparable |

Consequences (must be documented in methodology when realised):
- the merit-order tab stays GB-only until per-zone SRMC assumptions and a
  gas-split policy are defined — the zone switcher only drives the
  observation tabs (Overview/Prices/Generation/Flows) initially;
- residual-load definitions are zone-specific and must be written per zone.

## Front-end design: zone switcher

- `<select id="zone">` in the header, populated from `manifest.zones`.
- With one zone (today), it renders disabled with "GB" selected — visible
  affordance, zero behaviour change.
- `State` gains a `zone` field; `Data.load(zone)` resolves paths
  (`data/` for GB, `data/zones/<zone>/` otherwise); switching triggers the
  existing subscribe → full re-render cascade.
- No browser storage: zone resets to GB on reload (consistent with the
  existing no-persistence principle).

## Verification

- No token: `python etl/fetch_entsoe.py` prints instructions, exits 0.
- Front end on 8872: header shows the GB-only selector, all tabs unchanged,
  no console errors, manifest round-trip intact.
- (Deferred until token) one zone-day fetch writes schema-valid files.

## Status update (2026-07-05) — LIVE with real data

Token registered by the user and integrated (project-root `.env`, stdlib
dotenv loader; the file was found under web-served `app/` and moved out —
`GET /.env` returned 200 before the move, 404 after). Seven zones fetched
and live behind the header switcher.

**Zone set as built** (supersedes the starter set below): the inclusion
logic is physical GB interconnection — FR, NL, BE, NO_2, DK_1 (Viking,
missing from the starter set), IE/SEM — plus DE_LU kept as an explicitly
labelled *reference market* (no GB cable; "· ref" in the switcher, flagged
on the Methodology tab). IE needs both of its current EICs — they are
different AREA TYPES, not old-vs-new (corrected 2026-07-06 after
empirical probing of all three documents under both codes): day-ahead
prices [12.1.D] publish only against the SEM bidding-zone EIC
(10Y1001A1001A59C); actual load [6.1.A] only against the Ireland
control-area EIC (10YIE-1001A00010); generation [16.1.B&C] returns
identical data under either. The fetcher's fallback handles the split.
Official source confirming the area types — ENTSO-E EDI Working Group, "EIC: Area codes analysis" v2.1 (20 Oct 2020), slide "IE: Ireland" (p. 25): 10YIE-1001A00010 = Member State + Control Area + Scheduling Area (Republic of Ireland); 10Y1001A1001A59C = Bidding Zone + Market Balance Area (all-island SEM). https://eepublicdownloads.entsoe.eu/clean-documents/EDI/Library/Market_Areas_v2.1.pdf
This matches the probe exactly: prices [12.1.D] publish against the bidding
zone, load [6.1.A] against the control area. Settlement currency is read from each
A44 response — EUR for all seven, NO_2 included. Parser handles ENTSO-E's
curve semantics fully (2026-07-06): curveType A03 blocks fill to their
declared period end, and all points are bucketed time-weighted onto the
wall-clock half-hour grid — periods may start at :15/:45 (NO_2 PS), and
the earlier "drop off-grid timestamps" behaviour silently discarded that
data. Off-grid output is now a hard build failure. Methodology tab is zone-aware (per-zone source block, the fuel
mapping table below rendered in-app, GB-only tabs explained); GB
methodology unchanged when GB is selected.

## Original design (2026-07-01)

Done to the extent free access allows (2026-07-01):

- `etl/fetch_entsoe.py` written: A44/A75/A65 fetchers, resolution
  normalisation to half-hourly (PT60M repeated, PT15M pair-averaged,
  omitted positions forward-filled per spec — unit-tested synthetically),
  per-zone `series_hh.json` + `series_daily.json` + `meta.json`, manifest
  zone registration. No-token path verified: prints instructions, exits 0.
- `write_manifest()` in the main ETL patched to preserve registered zones
  across GB refreshes.
- Header zone switcher live: populated from `manifest.zones`, disabled while
  GB is the only zone (verified in the browser), lazy-loads the zone dataset
  and reverts safely if a zone fails to load.
- Deliberately NOT implemented: per-zone behaviour of the Merit/Spreads tabs
  (GB-parameterised SRMC assumptions do not transfer — see mapping table);
  to be decided when a second zone actually exists. End-to-end ENTSO-E
  fetch remains untested until a token is registered — stated plainly,
  nothing faked.

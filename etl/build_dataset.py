"""
GB Power Market Dashboard — ETL pipeline
========================================
Fetches real GB market data from public APIs, normalises it into a canonical
columnar dataset, and writes JSON files consumed by the static web app.

Sources (all free, no API key):
  1. Elexon Insights API   — half-hourly generation by fuel type incl.
                             interconnectors (FUELHH), demand outturn (INDO),
                             market index price (MID).
  2. Sheffield Solar       — national solar PV outturn (PV_Live v4),
                             half-hourly. GB solar is embedded and invisible
                             to Elexon's transmission metering.
  3. National Gas          — gas System Average Price (SAP, Actual Day),
                             data item PUBOB603, daily, p/kWh.
  4. gov.uk                — UK ETS Cost Containment Mechanism table:
                             official average monthly UKA price, £/tCO2.
  5. World Bank "Pink Sheet" — monthly average Australian thermal coal price
                             (6,000 kcal/kg FOB Newcastle futures), USD/t.
                             Used as a PROXY for NW-European coal: API2
                             (CIF ARA) itself is commercial data.
  6. Bank of England       — daily USD/GBP spot (XUDLUSS), averaged monthly,
                             to convert the coal proxy into £/MWh thermal.

Usage:
    python build_dataset.py --days 365
    python build_dataset.py --days 365 --no-cache   # force re-fetch
    python build_dataset.py --incremental           # append new periods only

Raw API responses are cached in data_raw/cache/ keyed by URL hash, so an
interrupted run resumes without hammering the APIs. Incremental mode reads
the previously published dataset, re-fetches only the tail (last stored day
minus one, defensively, through yesterday — bypassing the cache, whose
chunk-aligned keys would serve stale tail data), merges, trims the head to
keep a rolling window, and refuses to publish if validation fails. Outputs:
    app/data/series_hh.json     columnar half-hourly series (UTC epoch sec)
    app/data/series_daily.json  daily aggregates + daily/monthly price series
    app/data/meta.json          source registry: provenance, units, quality
    app/data/manifest.json      version counter + file hashes (cache busting)

All output files are written atomically (tmp + rename): a failed run can
never leave a half-written file behind.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import ssl
import time
import urllib.parse
import urllib.request

import certifi

SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
CACHE_DIR = PROJECT_DIR / "data_raw" / "cache"
OUT_DIR = PROJECT_DIR / "app" / "data"

ELEXON = "https://data.elexon.co.uk/bmrs/api/v1"
PVLIVE = "https://api.pvlive.uk/pvlive/api/v4"
NATGAS = "https://data.nationalgas.com/api/find-gas-data-download"
GOVUK_CCM = ("https://www.gov.uk/api/content/government/publications/"
             "taking-part-in-the-uk-emissions-trading-scheme-markets/"
             "cost-containment-mechanism-ccm-trigger-prices-and-average-"
             "monthly-prices-full-table")
WB_CMO_PAGE = "https://www.worldbank.org/en/research/commodity-markets"
BOE_IADB = "https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp"

# Energy content of the coal benchmark: 6,000 kcal/kg NAR
#   = 6,000 × 4.1868 kJ/kcal = 25.121 GJ/t = 6.978 MWh thermal per tonne
COAL_MWH_PER_TONNE = 6000 * 4.1868 / 3600

USE_CACHE = True
HALF_HOUR = 1800
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36")  # WB / BoE reject non-browser agents


# ---------------------------------------------------------------------------
# HTTP helpers with on-disk cache and retry
# ---------------------------------------------------------------------------

def _cache_path(key: str) -> Path:
    return CACHE_DIR / (hashlib.sha256(key.encode()).hexdigest()[:24] + ".cache")


def _http_raw(url: str, *, post_json: dict | None = None, retries: int = 3,
              ua: str = "gb-power-dashboard-etl/1.0") -> bytes:
    last_error = None
    for attempt in range(retries):
        try:
            if post_json is not None:
                req = urllib.request.Request(
                    url, data=json.dumps(post_json).encode(),
                    headers={"Content-Type": "application/json"})
            else:
                req = urllib.request.Request(url)
            req.add_header("User-Agent", ua)
            with urllib.request.urlopen(req, timeout=60,
                                        context=SSL_CONTEXT) as resp:
                data = resp.read()
            time.sleep(0.15)  # polite pacing
            return data
        except Exception as error:  # noqa: BLE001 — log and retry
            last_error = error
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"Failed after {retries} attempts: {url}: {last_error}")


def http(url: str, *, post_json: dict | None = None, retries: int = 3,
         ua: str = "gb-power-dashboard-etl/1.0") -> str:
    """GET (or POST with JSON body) returning response text, cached on disk."""
    key = url + (json.dumps(post_json, sort_keys=True) if post_json else "")
    cache_file = _cache_path(key)
    if USE_CACHE and cache_file.exists():
        return cache_file.read_text()
    text = _http_raw(url, post_json=post_json, retries=retries, ua=ua).decode()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(text)
    return text


def http_bytes(url: str, *, retries: int = 3,
               ua: str = "gb-power-dashboard-etl/1.0") -> bytes:
    """GET returning raw bytes (for binary files such as xlsx), cached."""
    cache_file = _cache_path("bytes:" + url)
    if USE_CACHE and cache_file.exists():
        return cache_file.read_bytes()
    data = _http_raw(url, retries=retries, ua=ua)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_bytes(data)
    return data


def day_chunks(start: date, end: date, size: int):
    """Yield (from, to) date pairs covering [start, end] in `size`-day steps."""
    cursor = start
    while cursor <= end:
        chunk_end = min(cursor + timedelta(days=size - 1), end)
        yield cursor, chunk_end
        cursor = chunk_end + timedelta(days=1)


def to_epoch(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


# ---------------------------------------------------------------------------
# Incremental mode: read-back, merge and publication safety
# ---------------------------------------------------------------------------

def _atomic_write(path: Path, text: str) -> None:
    """Write via tmp + rename so a crash never leaves a half-written file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def load_existing():
    """Previously published dataset, or None if absent/unreadable.

    Returns (hh, daily_text, meta). daily is kept as raw text because it is
    only needed for the changed-or-not comparison before writing.
    """
    try:
        hh = json.loads((OUT_DIR / "series_hh.json").read_text())
        daily_text = (OUT_DIR / "series_daily.json").read_text()
        meta = json.loads((OUT_DIR / "meta.json").read_text())
        if not hh.get("t"):
            return None
        return hh, daily_text, meta
    except (OSError, ValueError) as error:
        print(f"  WARNING: existing dataset unreadable ({error})")
        return None


def read_manifest_version() -> int:
    try:
        return int(json.loads((OUT_DIR / "manifest.json").read_text())["version"])
    except (OSError, ValueError, KeyError, TypeError):
        return 0


def columns_to_maps(hh: dict):
    """Stored columnar arrays back into the ts-keyed maps the fetchers
    produce, so the merge and the assembly reuse the full-build code path."""
    special = {"t", "demand", "price", "solar"}
    fuel_types = [k for k in hh if k not in special]
    fuel, demand, price, solar = {}, {}, {}, {}
    for i, ts in enumerate(hh["t"]):
        fuel[ts] = {ft: hh[ft][i] for ft in fuel_types if hh[ft][i] is not None}
        if hh["demand"][i] is not None:
            demand[ts] = hh["demand"][i]
        if hh["price"][i] is not None:
            price[ts] = hh["price"][i]
        if hh["solar"][i] is not None:
            solar[ts] = hh["solar"][i]
    return fuel, demand, price, solar


def validate_incremental(hh: dict, prev_last_ts: int,
                         prev_coverage: dict, coverage: dict) -> None:
    """Refuse to publish a merged dataset that is worse than what is live.

    Hard failures exit non-zero and leave the published files untouched.
    Axis gaps are warned about but published: a missing upstream period is
    Elexon's reality, not corruption, and must not brick the nightly job.
    """
    t = hh["t"]
    problems = []
    if any(t[i] >= t[i + 1] for i in range(len(t) - 1)):
        problems.append("time axis not strictly increasing")
    if t[-1] < prev_last_ts:
        problems.append("merged dataset ends before the published one")
    for key in ("demand", "price"):
        prev = prev_coverage.get(key)
        if prev is not None and coverage[key] < prev - 0.02:
            problems.append(f"{key} coverage fell {prev:.4f} → "
                            f"{coverage[key]:.4f}")
    gaps = sum(1 for i in range(len(t) - 1) if t[i + 1] - t[i] != HALF_HOUR)
    if gaps:
        print(f"  WARNING: {gaps} gap(s) in the half-hourly axis "
              "(upstream missing periods; published as-is)")
    if problems:
        raise SystemExit("REFUSING TO PUBLISH: " + "; ".join(problems))


def write_manifest(mode: str, built_at: str) -> dict:
    """Version counter + content hashes for the app's cache busting."""
    files = {}
    for name in ("series_hh.json", "series_daily.json", "meta.json",
                 "bmu_snapshot.json"):  # snapshot optional (plan/05 Phase B)
        if not (OUT_DIR / name).exists():
            continue
        blob = (OUT_DIR / name).read_bytes()
        files[name] = {"sha256": hashlib.sha256(blob).hexdigest(),
                       "bytes": len(blob)}
    # Preserve zones registered by other fetchers (see etl/fetch_entsoe.py);
    # a GB refresh must never de-register them.
    zones = ["GB"]
    try:
        for zone in json.loads(
                (OUT_DIR / "manifest.json").read_text()).get("zones", []):
            if zone not in zones:
                zones.append(zone)
    except (OSError, ValueError):
        pass
    manifest = {
        "schema": 1,
        "version": read_manifest_version() + 1,
        "built_at": built_at,
        "mode": mode,
        "files": files,
        "zones": zones,
    }
    _atomic_write(OUT_DIR / "manifest.json", json.dumps(manifest, indent=2))
    return manifest


# ---------------------------------------------------------------------------
# Source 1: Elexon Insights API
# ---------------------------------------------------------------------------

def fetch_fuelhh(start: date, end: date) -> dict[int, dict[str, float]]:
    """Half-hourly generation (MW) by fuel type, incl. interconnectors."""
    out: dict[int, dict[str, float]] = {}
    for chunk_start, chunk_end in day_chunks(start, end, 7):
        url = (f"{ELEXON}/datasets/FUELHH?settlementDateFrom={chunk_start}"
               f"&settlementDateTo={chunk_end}&format=json")
        rows = json.loads(http(url))["data"]
        for row in rows:
            ts = to_epoch(row["startTime"])
            out.setdefault(ts, {})[row["fuelType"]] = row["generation"]
        print(f"  FUELHH {chunk_start} → {chunk_end}: {len(rows)} rows")
    return out


def fetch_demand(start: date, end: date) -> dict[int, float]:
    """Half-hourly Initial National Demand Outturn (MW)."""
    out: dict[int, float] = {}
    for chunk_start, chunk_end in day_chunks(start, end, 7):
        url = (f"{ELEXON}/demand/outturn?settlementDateFrom={chunk_start}"
               f"&settlementDateTo={chunk_end}&format=json")
        rows = json.loads(http(url))["data"]
        for row in rows:
            out[to_epoch(row["startTime"])] = row["initialDemandOutturn"]
        print(f"  INDO   {chunk_start} → {chunk_end}: {len(rows)} rows")
    return out


def fetch_mid_price(start: date, end: date) -> dict[int, float]:
    """Half-hourly Market Index Price (£/MWh), volume-weighted across
    data providers (APX + N2EX) — the GB wholesale spot price proxy."""
    sums: dict[int, float] = {}
    volumes: dict[int, float] = {}
    for chunk_start, chunk_end in day_chunks(start, end, 7):
        url = (f"{ELEXON}/balancing/pricing/market-index"
               f"?from={chunk_start}T00:00Z&to={chunk_end}T23:59Z&format=json")
        rows = json.loads(http(url))["data"]
        for row in rows:
            volume = row.get("volume") or 0
            if volume <= 0:
                continue
            ts = to_epoch(row["startTime"])
            sums[ts] = sums.get(ts, 0.0) + row["price"] * volume
            volumes[ts] = volumes.get(ts, 0.0) + volume
        print(f"  MID    {chunk_start} → {chunk_end}: {len(rows)} rows")
    return {ts: sums[ts] / volumes[ts] for ts in sums}


# ---------------------------------------------------------------------------
# Source 2: Sheffield Solar PV_Live (national embedded solar outturn)
# ---------------------------------------------------------------------------

def fetch_solar(start: date, end: date) -> dict[int, float]:
    out: dict[int, float] = {}
    for chunk_start, chunk_end in day_chunks(start, end, 30):
        url = (f"{PVLIVE}/gsp/0?start={chunk_start}T00:00:00"
               f"&end={chunk_end}T23:59:59&data_format=json")
        payload = json.loads(http(url))
        for gsp_id, dt_gmt, mw in payload["data"]:
            if mw is not None:
                out[to_epoch(dt_gmt)] = mw
        print(f"  PVLIVE {chunk_start} → {chunk_end}: {len(payload['data'])} rows")
    return out


# ---------------------------------------------------------------------------
# Source 3: National Gas — System Average Price (daily)
# ---------------------------------------------------------------------------

def fetch_gas_sap(start: date, end: date) -> dict[str, float]:
    """Daily gas SAP. Returned in p/kWh; converted to £/MWh thermal
    (1 p/kWh = £10/MWh)."""
    text = http(NATGAS, post_json={
        "applicableFor": "Y",
        "dateFrom": start.isoformat(),
        "dateTo": end.isoformat(),
        "dateType": "GASDAY",
        "latestFlag": "Y",
        "ids": "PUBOB603",
        "type": "CSV",
    })
    out: dict[str, float] = {}
    for row in csv.DictReader(io.StringIO(text)):
        day = datetime.strptime(row["Applicable For"], "%d/%m/%Y").date()
        out[day.isoformat()] = round(float(row["Value"]) * 10.0, 3)
    print(f"  GAS SAP: {len(out)} days")
    return out


# ---------------------------------------------------------------------------
# Source 4: gov.uk — UK ETS average monthly UKA price (CCM table)
# ---------------------------------------------------------------------------

class _TableParser(HTMLParser):
    """Extract all tables as lists of row-lists of cell text."""

    def __init__(self):
        super().__init__()
        self.tables, self._row, self._cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables.append([])
        elif tag == "tr" and self.tables:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.tables[-1].append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def fetch_carbon_monthly() -> dict[str, float]:
    """Official average monthly UKA price (£/tCO2) from the gov.uk CCM table.

    Each CCM row lists an auction month, the six months in its assessment
    window, and the average UKA price for each of those months. Reading all
    rows and cross-checking overlapping windows yields one observed price per
    calendar month."""
    doc = json.loads(http(GOVUK_CCM))
    parser = _TableParser()
    parser.feed(doc["details"]["body"])

    prices: dict[str, float] = {}
    conflicts = []
    for table in parser.tables:
        for row in table:
            # Find the cell that lists the six window months, e.g.
            # "Jan, Feb, Mar, Apr, May, Jun"
            window_idx = None
            for idx, cell in enumerate(row):
                names = [c.strip()[:3] for c in cell.split(",")]
                if len(names) == 6 and all(n in MONTHS for n in names):
                    window_idx = idx
                    window = names
                    break
            if window_idx is None:
                continue
            # Auction month cell like "Jul-26" anchors the year
            anchor = re.match(r"([A-Z][a-z]{2})-(\d{2})", row[0])
            if not anchor:
                continue
            anchor_month = MONTHS[anchor.group(1)]
            anchor_year = 2000 + int(anchor.group(2))
            price_cells = row[window_idx + 1: window_idx + 7]
            # Window months precede the auction month; walk backwards
            month_dates = []
            year, month = anchor_year, anchor_month
            for _ in range(6):
                month -= 1
                if month == 0:
                    month, year = 12, year - 1
                month_dates.append((year, month))
            month_dates.reverse()
            for (year, month), cell in zip(month_dates, price_cells):
                match = re.search(r"£?([\d,]+\.?\d*)", cell)
                if not match or "TBD" in cell.upper():
                    continue
                value = float(match.group(1).replace(",", ""))
                key = f"{year:04d}-{month:02d}"
                if key in prices and abs(prices[key] - value) > 0.01:
                    conflicts.append((key, prices[key], value))
                prices[key] = value
    if conflicts:
        print(f"  WARNING: {len(conflicts)} cross-row conflicts in CCM table:"
              f" {conflicts[:3]}")
    print(f"  UKA monthly: {len(prices)} months "
          f"({min(prices)} → {max(prices)})")
    return prices


# ---------------------------------------------------------------------------
# Source 5: World Bank Pink Sheet — monthly Australian thermal coal (USD/t)
# ---------------------------------------------------------------------------

def _read_xlsx_sheet(data: bytes, sheet_name: str) -> dict[int, dict[str, str]]:
    """Minimal stdlib xlsx reader: {row_number: {column_letter: value}}."""
    import zipfile
    import xml.etree.ElementTree as ET

    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    rns = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
    rid_attr = ("{http://schemas.openxmlformats.org/officeDocument/2006/"
                "relationships}id")
    archive = zipfile.ZipFile(io.BytesIO(data))
    shared = ["".join(si.itertext()) for si in ET.fromstring(
        archive.read("xl/sharedStrings.xml")).findall("m:si", ns)]
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {rel.get("Id"): rel.get("Target")
               for rel in rels.findall("r:Relationship", rns)}
    sheet_file = None
    for sheet in workbook.findall("m:sheets/m:sheet", ns):
        if sheet.get("name") == sheet_name:
            sheet_file = "xl/" + targets[sheet.get(rid_attr)].lstrip("/")
    if sheet_file is None:
        raise RuntimeError(f"Sheet {sheet_name!r} not found in workbook")

    rows: dict[int, dict[str, str]] = {}
    tree = ET.fromstring(archive.read(sheet_file))
    for row in tree.findall("m:sheetData/m:row", ns):
        cells = {}
        for cell in row.findall("m:c", ns):
            value = cell.find("m:v", ns)
            if value is None:
                continue
            text = (shared[int(value.text)] if cell.get("t") == "s"
                    else value.text)
            cells[re.match(r"[A-Z]+", cell.get("r")).group(0)] = text
        rows[int(row.get("r"))] = cells
    return rows


def fetch_coal_monthly() -> dict[str, float]:
    """Monthly average Australian thermal coal price, USD/t, from the World
    Bank "Pink Sheet" (CMO-Historical-Data-Monthly.xlsx).

    Per the Pink Sheet's own definition, from Feb 2022 this series is the
    monthly average of the 6,000 kcal/kg FOB Newcastle *futures* price —
    a transparent, public, futures-derived proxy for seaborne thermal coal.
    The xlsx link rotates monthly, so it is re-discovered from the landing
    page on each run (cache key includes the current month)."""
    page = http(f"{WB_CMO_PAGE}?cm={date.today():%Y-%m}", ua=BROWSER_UA)
    match = re.search(
        r"https://[^\"']*CMO-Historical-Data-Monthly\.xlsx", page)
    if not match:
        raise RuntimeError("Pink Sheet link not found on WB landing page")
    rows = _read_xlsx_sheet(http_bytes(match.group(0), ua=BROWSER_UA),
                            "Monthly Prices")

    header_row = min(r for r, cells in rows.items()
                     if any(v == "Coal, Australian" for v in cells.values()))
    coal_col = next(col for col, v in rows[header_row].items()
                    if v == "Coal, Australian")
    out: dict[str, float] = {}
    for cells in rows.values():
        period = cells.get("A", "")
        match_period = re.fullmatch(r"(\d{4})M(\d{2})", period)
        raw = cells.get(coal_col)
        if not match_period or raw in (None, "…", ".."):
            continue
        try:
            out[f"{match_period.group(1)}-{match_period.group(2)}"] = \
                round(float(raw), 2)
        except ValueError:
            continue
    print(f"  WB coal (Australian, USD/t): {len(out)} months "
          f"(latest {max(out)} = ${out[max(out)]})")
    return out


# ---------------------------------------------------------------------------
# Source 6: Bank of England — USD/GBP spot rate, monthly average
# ---------------------------------------------------------------------------

def fetch_fx_monthly(start: date, end: date) -> dict[str, float]:
    """Monthly mean USD per GBP from BoE daily spot series XUDLUSS."""
    url = (f"{BOE_IADB}?csv.x=yes&Datefrom={start:%d/%b/%Y}"
           f"&Dateto={end:%d/%b/%Y}&SeriesCodes=XUDLUSS&CSVF=TN"
           f"&UsingCodes=Y&VPD=Y&VFD=N")
    text = http(url, ua=BROWSER_UA)
    sums: dict[str, float] = {}
    counts: dict[str, int] = {}
    for row in csv.DictReader(io.StringIO(text)):
        day = datetime.strptime(row["DATE"], "%d %b %Y").date()
        month = day.strftime("%Y-%m")
        sums[month] = sums.get(month, 0.0) + float(row["XUDLUSS"])
        counts[month] = counts.get(month, 0) + 1
    out = {m: round(sums[m] / counts[m], 4) for m in sums}
    print(f"  BoE USD/GBP: {len(out)} months "
          f"(latest {max(out)} = {out[max(out)]})")
    return out


# ---------------------------------------------------------------------------
# Normalisation and output
# ---------------------------------------------------------------------------

def build(days: int, incremental: bool = False) -> None:
    global USE_CACHE
    end = date.today() - timedelta(days=1)    # last complete day
    start = end - timedelta(days=days - 1)

    stored = load_existing() if incremental else None
    if incremental and stored is None:
        print("Incremental requested but no readable existing dataset — "
              "running a full build instead.")
    mode = "incremental" if stored else "full"

    if mode == "incremental":
        stored_hh, stored_daily_text, stored_meta = stored
        prev_last_ts = stored_hh["t"][-1]
        last_day = datetime.fromtimestamp(prev_last_ts, tz=timezone.utc).date()
        # Re-fetch the last stored day and the one before it defensively:
        # both may have been partial or revised at the previous run.
        fetch_start = min(last_day - timedelta(days=1), end)
        USE_CACHE = False  # chunk-aligned cache keys would serve a stale tail
        print(f"Incremental update {fetch_start} → {end} "
              f"(stored window ends {last_day})")

        fuel, demand, price, solar = columns_to_maps(stored_hh)
        print("Fetching Elexon FUELHH (tail)…")
        fuel.update(fetch_fuelhh(fetch_start, end))
        print("Fetching Elexon demand (INDO, tail)…")
        demand.update(fetch_demand(fetch_start, end))
        print("Fetching Elexon market index price (MID, tail)…")
        price.update(fetch_mid_price(fetch_start, end))
        print("Fetching PV_Live solar (tail)…")
        solar.update(fetch_solar(fetch_start, end))

        # Trim the head so the published window stays a rolling `days` days.
        cutoff = int(datetime(start.year, start.month, start.day,
                              tzinfo=timezone.utc).timestamp())
        for series in (fuel, demand, price, solar):
            for ts in [t for t in series if t < cutoff]:
                del series[ts]
    else:
        print(f"Building dataset {start} → {end}")
        print("Fetching Elexon FUELHH…")
        fuel = fetch_fuelhh(start, end)
        print("Fetching Elexon demand (INDO)…")
        demand = fetch_demand(start, end)
        print("Fetching Elexon market index price (MID)…")
        price = fetch_mid_price(start, end)
        print("Fetching PV_Live solar…")
        solar = fetch_solar(start, end)

    print("Fetching National Gas SAP…")
    gas = fetch_gas_sap(start, end)
    print("Fetching gov.uk UKA monthly prices…")
    carbon = fetch_carbon_monthly()
    print("Fetching coal proxy (World Bank Pink Sheet + BoE FX)…")
    coal_note = None
    try:
        coal_usd = fetch_coal_monthly()
        fx = fetch_fx_monthly(start - timedelta(days=45), end)
        coal_gbp: dict[str, float] = {}
        for month, usd in coal_usd.items():
            fx_months = [m for m in fx if m <= month]
            if not fx_months:
                continue
            coal_gbp[month] = round(
                usd / fx[max(fx_months)] / COAL_MWH_PER_TONNE, 2)
        print(f"  Coal proxy: latest {max(coal_gbp)} = "
              f"£{coal_gbp[max(coal_gbp)]}/MWh th")
    except Exception as error:  # noqa: BLE001 — proxy is optional
        print(f"  WARNING: coal proxy unavailable ({error}); "
              "app falls back to manual coal input")
        coal_gbp, coal_note = {}, str(error)

    # Canonical half-hourly time axis: union of FUELHH timestamps
    axis = sorted(fuel)
    fuel_types = sorted({ft for row in fuel.values() for ft in row})

    def column(getter):
        return [getter(ts) for ts in axis]

    hh = {
        "t": axis,
        "demand": column(lambda ts: demand.get(ts)),
        "price": column(lambda ts: round(price[ts], 2) if ts in price else None),
        "solar": column(lambda ts: round(solar[ts], 1) if ts in solar else None),
    }
    for ft in fuel_types:
        hh[ft] = column(lambda ts, f=ft: fuel[ts].get(f))

    # Daily aggregates (UTC days; simple time-averages, documented)
    daily: dict[str, dict] = {}
    for i, ts in enumerate(axis):
        day = datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
        bucket = daily.setdefault(day, {k: [] for k in hh if k != "t"})
        for key in bucket:
            value = hh[key][i]
            if value is not None:
                bucket[key].append(value)

    days_sorted = sorted(daily)
    daily_out = {"d": days_sorted}
    for key in [k for k in hh if k != "t"]:
        daily_out[key] = [
            round(sum(daily[d][key]) / len(daily[d][key]), 2)
            if daily[d][key] else None
            for d in days_sorted
        ]
    daily_out["price_max"] = [
        round(max(daily[d]["price"]), 2) if daily[d]["price"] else None
        for d in days_sorted
    ]
    daily_out["gas_sap"] = [gas.get(d) for d in days_sorted]

    # UKA: observed monthly average where published; forward-filled beyond
    # the last published month (publication lags ~1-2 months). The parallel
    # carbon_ffill array marks carried-forward values so the UI can label
    # them as estimates rather than observations.
    carbon_months = sorted(carbon)
    daily_out["carbon_uka_month"] = []
    daily_out["carbon_ffill"] = []
    for d in days_sorted:
        month = d[:7]
        if month in carbon:
            daily_out["carbon_uka_month"].append(carbon[month])
            daily_out["carbon_ffill"].append(False)
        else:
            earlier = [m for m in carbon_months if m < month]
            daily_out["carbon_uka_month"].append(
                carbon[earlier[-1]] if earlier else None)
            daily_out["carbon_ffill"].append(True)

    # Coal proxy: same ffill pattern as UKA — monthly value applied to every
    # day of the month, carried forward beyond the last published month and
    # flagged so the UI labels those days accordingly.
    coal_months = sorted(coal_gbp)
    daily_out["coal_proxy_gbp_mwh"] = []
    daily_out["coal_ffill"] = []
    for d in days_sorted:
        month = d[:7]
        if month in coal_gbp:
            daily_out["coal_proxy_gbp_mwh"].append(coal_gbp[month])
            daily_out["coal_ffill"].append(False)
        else:
            earlier = [m for m in coal_months if m < month]
            daily_out["coal_proxy_gbp_mwh"].append(
                coal_gbp[earlier[-1]] if earlier else None)
            daily_out["coal_ffill"].append(True)

    coverage = {
        "demand": sum(v is not None for v in hh["demand"]) / len(axis),
        "price": sum(v is not None for v in hh["price"]) / len(axis),
        "solar": sum(v is not None for v in hh["solar"]) / len(axis),
        "gas_days": sum(v is not None for v in daily_out["gas_sap"]),
        "carbon_months_observed": len({d[:7] for d in days_sorted
                                       if carbon.get(d[:7])}),
        "carbon_last_observed_month": max(carbon) if carbon else None,
        "coal_months_observed": len({d[:7] for d in days_sorted
                                     if coal_gbp.get(d[:7])}),
        "coal_last_observed_month": max(coal_gbp) if coal_gbp else None,
    }

    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    meta = {
        "built_at": fetched_at,
        "mode": mode,
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "timezone": "All timestamps UTC. Half-hourly values are interval "
                    "starts (Elexon settlement periods mapped to startTime).",
        "coverage": coverage,
        "fuel_types": fuel_types,
        "series": {
            "price": {
                "name": "GB wholesale power price (Market Index, MID)",
                "source": "Elexon Insights API, dataset MID",
                "endpoint": "/balancing/pricing/market-index",
                "unit": "£/MWh", "resolution": "30 min",
                "update_frequency": "near real time (settlement runs)",
                "quality": "observed",
                "transformations": "volume-weighted mean across data "
                                   "providers (APX, N2EX) per period",
                "notes": "MID reflects short-term traded prices used for "
                         "imbalance pricing; it is the standard public proxy "
                         "for the GB spot price. Day-ahead auction prices "
                         "(EPEX/N2EX) are commercial data.",
            },
            "demand": {
                "name": "GB national demand outturn (INDO)",
                "source": "Elexon Insights API, dataset INDO",
                "endpoint": "/demand/outturn",
                "unit": "MW", "resolution": "30 min",
                "update_frequency": "near real time",
                "quality": "observed",
                "transformations": "none",
                "notes": "Transmission-metered demand; excludes most "
                         "behind-the-meter consumption offset by embedded "
                         "generation.",
            },
            "generation_by_fuel": {
                "name": "Generation by fuel type incl. interconnectors",
                "source": "Elexon Insights API, dataset FUELHH",
                "endpoint": "/datasets/FUELHH",
                "unit": "MW", "resolution": "30 min",
                "update_frequency": "near real time",
                "quality": "observed",
                "transformations": "none",
                "notes": "Transmission-connected plant only. Embedded wind "
                         "and all solar are not visible here. Interconnector "
                         "flows appear as INT* fuel types (+ve = import).",
            },
            "solar": {
                "name": "GB solar PV outturn (national)",
                "source": "Sheffield Solar PV_Live v4",
                "endpoint": "api.pvlive.uk /gsp/0",
                "unit": "MW", "resolution": "30 min",
                "update_frequency": "near real time",
                "quality": "observed (model-based estimate from metered "
                           "sample sites — the accepted GB standard)",
                "transformations": "none",
            },
            "gas_sap": {
                "name": "Gas System Average Price (SAP), actual day",
                "source": "National Gas data portal, item PUBOB603",
                "endpoint": "data.nationalgas.com /api/find-gas-data-download",
                "unit": "£/MWh (thermal, HHV)", "resolution": "daily (gas day)",
                "update_frequency": "daily",
                "quality": "observed",
                "transformations": "p/kWh × 10 → £/MWh",
                "notes": "Volume-weighted average of all OTC trades on the "
                         "National Balancing Point each gas day — a "
                         "within-day benchmark, not the day-ahead curve.",
            },
            "coal_proxy_gbp_mwh": {
                "name": "Coal benchmark proxy (Australian 6,000 kcal/kg "
                        "Newcastle futures, monthly avg)",
                "source": "World Bank Commodity Price Data (Pink Sheet) "
                          "+ Bank of England XUDLUSS for FX",
                "endpoint": WB_CMO_PAGE,
                "unit": "£/MWh (thermal)", "resolution": "monthly",
                "update_frequency": "monthly (Pink Sheet, ~2 working days "
                                    "after month end)",
                "quality": "proxy / derived",
                "transformations": "USD/t ÷ monthly-mean USD per GBP (BoE "
                                   "XUDLUSS) ÷ 6.978 MWh th/t "
                                   "(6,000 kcal/kg = 25.12 GJ/t)",
                "notes": "This is FOB Newcastle, not API2 CIF ARA — the "
                         "European benchmark itself is ICE commercial data. "
                         "Levels track but do not equal API2 (freight/quality "
                         "basis). Manual coal input overrides this proxy."
                         + (f" UNAVAILABLE THIS BUILD: {coal_note}"
                            if coal_note else ""),
            },
            "carbon_uka_month": {
                "name": "UKA price (UK ETS), average by calendar month",
                "source": "gov.uk — UK ETS Cost Containment Mechanism table",
                "endpoint": GOVUK_CCM,
                "unit": "£/tCO2", "resolution": "monthly",
                "update_frequency": "monthly (published with ~1 month lag)",
                "quality": "observed (monthly average); treated as ESTIMATED "
                           "when held constant within a month for daily/"
                           "half-hourly calculations",
                "transformations": "parsed from CCM assessment windows; "
                                   "cross-row consistency checked",
                "notes": "Daily UKA settlement prices are ICE commercial "
                         "data. The dashboard forward-fills the monthly "
                         "average and labels dependent metrics accordingly.",
            },
        },
    }

    hh_text = json.dumps(hh)
    daily_text = json.dumps(daily_out)

    if mode == "incremental":
        validate_incremental(hh, prev_last_ts,
                             stored_meta.get("coverage", {}), coverage)
        unchanged = (hh_text == json.dumps(stored_hh)
                     and daily_text == stored_daily_text
                     and (OUT_DIR / "manifest.json").exists())
        if unchanged:
            print("\nNo changes — published dataset already up to date; "
                  "nothing written.")
            return

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    _atomic_write(OUT_DIR / "series_hh.json", hh_text)
    _atomic_write(OUT_DIR / "series_daily.json", daily_text)
    _atomic_write(OUT_DIR / "meta.json", json.dumps(meta, indent=2))
    manifest = write_manifest(mode, fetched_at)
    print(f"\nWrote {OUT_DIR}/series_hh.json "
          f"({(OUT_DIR / 'series_hh.json').stat().st_size // 1024} kB), "
          f"series_daily.json, meta.json, manifest.json "
          f"(version {manifest['version']}, mode {mode})")
    print(f"Coverage: {json.dumps(coverage, indent=2)}")


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("--days", type=int, default=365,
                     help="rolling window length in days")
    cli.add_argument("--no-cache", action="store_true")
    cli.add_argument("--incremental", action="store_true",
                     help="append new settlement periods to the existing "
                          "dataset instead of rebuilding the full window")
    args = cli.parse_args()
    if args.no_cache:
        USE_CACHE = False
    build(args.days, incremental=args.incremental)

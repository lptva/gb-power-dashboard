/* data.js — loads the canonical dataset and provides slicing/aggregation.
   No mutation of loaded arrays ever: every metric works on copies/views. */

const Data = (() => {
  let hh = null;      // half-hourly columnar: t (epoch s) + series arrays
  let daily = null;   // daily columnar: d (ISO dates) + series arrays
  let meta = null;

  /* nameplate_mw is the operator-published design capacity — a cited
     REFERENCE value only (sources: methodology.md, "Interconnector
     utilisation ranking"). Real limits sit lower whenever a cable is
     de-rated or in phased ramp-up, so the utilisation panel derives its
     working ceiling from observed flows and shows nameplate as context. */
  const INTERCONNECTORS = {
    INTFR:   { label: "IFA (FR)",       colour: "#9575cd", nameplate_mw: 2000 },
    INTIFA2: { label: "IFA2 (FR)",      colour: "#7e57c2", nameplate_mw: 1000 },
    INTELEC: { label: "ElecLink (FR)",  colour: "#b39ddb", nameplate_mw: 1000 },
    INTNED:  { label: "BritNed (NL)",   colour: "#5c6bc0", nameplate_mw: 1000 },
    INTNEM:  { label: "Nemo (BE)",      colour: "#7986cb", nameplate_mw: 1000 },
    INTNSL:  { label: "NSL (NO)",       colour: "#4db6ac", nameplate_mw: 1400 },
    INTVKL:  { label: "Viking (DK)",    colour: "#81d4fa", nameplate_mw: 1400 },
    INTIRL:  { label: "Moyle (NI)",     colour: "#aed581", nameplate_mw: 500 },
    INTEW:   { label: "East-West (IE)", colour: "#9ccc65", nameplate_mw: 500 },
    INTGRNL: { label: "Greenlink (IE)", colour: "#c5e1a5", nameplate_mw: 500 },
  };

  /* Fixed palette — one colour per fuel type, used by EVERY chart (never
     restyle per panel). Constraints: solar keeps the conventional yellow,
     so nuclear is violet; CCGT red vs OCGT amber-orange are deliberately
     far apart; oil is darkened away from coal's brown. */
  const FUELS = {
    NUCLEAR: { label: "Nuclear",        colour: "#a78bfa" },
    BIOMASS: { label: "Biomass",        colour: "#7fbf7f" },
    CCGT:    { label: "Gas (CCGT)",     colour: "#e4573d" },
    OCGT:    { label: "Gas (OCGT)",     colour: "#ffa94d" },
    COAL:    { label: "Coal",           colour: "#8d7060" },
    OIL:     { label: "Oil",            colour: "#7a6357" },
    NPSHYD:  { label: "Hydro",          colour: "#4dd0e1" },
    PS:      { label: "Pumped storage", colour: "#26a69a" },
    OTHER:   { label: "Other",          colour: "#90a4ae" },
    WIND:    { label: "Wind",           colour: "#4fc3f7" },
    solar:   { label: "Solar",          colour: "#ffd54f" },
  };

  // Stack order for generation charts (baseload at the bottom)
  const STACK_ORDER = ["NUCLEAR", "BIOMASS", "CCGT", "OCGT", "COAL", "OIL",
                       "NPSHYD", "PS", "OTHER", "WIND", "solar"];

  const LOW_CARBON = ["NUCLEAR", "BIOMASS", "NPSHYD", "PS", "WIND", "solar"];

  /* GB cable → counterparty bidding zone. DE_LU is deliberately absent:
     it is a reference market with no GB cable and must never be treated
     as a flow counterparty. */
  const CABLE_ZONE = {
    INTFR: "FR", INTIFA2: "FR", INTELEC: "FR",
    INTNED: "NL", INTNEM: "BE", INTNSL: "NO_2", INTVKL: "DK_1",
    INTIRL: "IE", INTEW: "IE", INTGRNL: "IE",
  };

  /* Zone presentation config (mirrors etl/fetch_entsoe.py ZONES).
     kind: "interconnected" = physical GB counterparty zone;
     "reference" = price anchor only, no GB cable — labelled in the UI so
     the two inclusion logics are never conflated. */
  const ZONE_INFO = {
    GB:    { label: "Great Britain",      kind: "home" },
    FR:    { label: "France",             kind: "interconnected" },
    NL:    { label: "Netherlands",        kind: "interconnected" },
    BE:    { label: "Belgium",            kind: "interconnected" },
    NO_2:  { label: "Norway (NO2)",       kind: "interconnected" },
    DK_1:  { label: "Denmark (DK1)",      kind: "interconnected" },
    IE:    { label: "Ireland (SEM)",      kind: "interconnected" },
    DE_LU: { label: "Germany–Luxembourg", kind: "reference" },
  };

  /* Settlement-currency symbol for the active zone. GB is £ (MID); other
     zones report the currency read from their A44 response (meta.currency),
     EUR in practice — verified per zone, not assumed. */
  function currency() {
    if (zone === "GB") return "£";
    const code = (meta && meta.currency) || "EUR";
    return { EUR: "€", GBP: "£", NOK: "kr", DKK: "kr" }[code] || code;
  }

  let manifest = null; // versioned file registry written by the ETL
  let zone = "GB";     // GB lives at the legacy data/ paths; other zones
                       // under data/zones/<zone>/ (see plan/04)
  let bmu = null;      // observed dispatch snapshot (optional, GB only)
  let overnight = null; // AI overnight summary (optional, GB only)
  let stress = null;    // daily stress metrics + flags (optional, GB only)
  let warnings = null;  // filtered SYSWARN notices (optional, GB only)
  let refreshStatus = null; // last ops/refresh.py outcome (optional,
                             // machine-level — same value on every zone)

  async function load(requestedZone = "GB") {
    const fetchJson = async (path, opts) => {
      const resp = await fetch(path, opts);
      if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
      return resp.json();
    };
    // The manifest is tiny and fetched uncached; its version then busts the
    // browser cache on the data files. Absent manifest (older data folder)
    // → fall back to un-versioned URLs, exactly the previous behaviour.
    try {
      manifest = await fetchJson("data/manifest.json", { cache: "no-store" });
    } catch {
      manifest = null;
    }
    zone = requestedZone;
    const base = zone === "GB" ? "data/" : `data/zones/${zone}/`;
    const v = manifest ? `?v=${manifest.version}` : "";
    quantileCache.clear(); // capacity proxies are per-zone
    [hh, daily, meta] = await Promise.all([
      fetchJson(`${base}series_hh.json${v}`),
      fetchJson(`${base}series_daily.json${v}`),
      fetchJson(`${base}meta.json${v}`),
    ]);
    // Refresh-attempt status (optional — written by ops/refresh.py at the
    // end of every daily run; absent on fresh clones and pre-feature
    // datasets. Machine-level, not per-zone, so fetched on every load()
    // call regardless of the requested zone.
    try {
      refreshStatus = await fetchJson("data/refresh_status.json",
        { cache: "no-store" });
    } catch { refreshStatus = null; }
    // Observed dispatch snapshot (GB only, optional — written by
    // etl/build_bmu_snapshot.py; absent until that script has run)
    bmu = null;
    overnight = null;
    stress = null;
    warnings = null;
    if (zone === "GB") {
      try { bmu = await fetchJson(`data/bmu_snapshot.json${v}`); }
      catch { bmu = null; }
      // AI overnight summary (optional — written by
      // ops/run_overnight_summary.py; tiny, so always fetched fresh)
      try {
        overnight = await fetchJson("data/overnight_summary.json",
          { cache: "no-store" });
      } catch { overnight = null; }
      // System-stress metrics + system warnings (optional — written by
      // etl/fetch_stress.py; absent until that pipeline has run)
      try { stress = await fetchJson(`data/stress_daily.json${v}`); }
      catch { stress = null; }
      try { warnings = await fetchJson(`data/warnings.json${v}`); }
      catch { warnings = null; }
    }
    // Derived half-hourly columns (computed once)
    const icKeys = Object.keys(INTERCONNECTORS).filter((k) => hh[k]);
    hh.netImports = hh.t.map((_, i) =>
      icKeys.reduce((sum, k) => sum + (hh[k][i] ?? 0), 0));
    hh.renewables = hh.t.map((_, i) =>
      (hh.WIND ? hh.WIND[i] ?? 0 : 0) + (hh.solar[i] ?? 0));
  }

  /* Index range of half-hourly axis covering [fromTs, toTs) (epoch s). */
  function hhRange(fromTs, toTs) {
    const t = hh.t;
    let lo = 0, hi = t.length;
    while (lo < hi && t[lo] < fromTs) lo++;
    while (hi > lo && t[hi - 1] >= toTs) hi--;
    return [lo, hi];
  }

  /* Aggregate any (tArr, col) pair into buckets of `seconds`, averaging
     non-nulls. Returns { t: [bucketStartMs], v: [mean|null] }. Used for the
     active dataset and for zone-context series alike. */
  function aggregateArrays(tArr, col, fromTs, toTs, seconds) {
    const t = [], v = [];
    let bucket = null, sum = 0, n = 0;
    for (let i = 0; i < tArr.length; i++) {
      if (tArr[i] < fromTs || tArr[i] >= toTs) continue;
      const b = Math.floor(tArr[i] / seconds) * seconds;
      if (b !== bucket) {
        if (bucket !== null) { t.push(bucket * 1000); v.push(n ? sum / n : null); }
        bucket = b; sum = 0; n = 0;
      }
      const value = col[i];
      if (value !== null && value !== undefined) { sum += value; n++; }
    }
    if (bucket !== null) { t.push(bucket * 1000); v.push(n ? sum / n : null); }
    return { t, v };
  }

  /* Aggregate one active-dataset HH column into buckets of `seconds`. */
  function aggregate(key, fromTs, toTs, seconds) {
    return aggregateArrays(hh.t, hh[key], fromTs, toTs, seconds);
  }

  /* Daily series filtered to [fromIso, toIso]. Returns {d:[], <key>:[]…}. */
  function dailySlice(fromIso, toIso, keys) {
    const out = { d: [] };
    keys.forEach((k) => { out[k] = []; });
    daily.d.forEach((day, i) => {
      if (day >= fromIso && day <= toIso) {
        out.d.push(day);
        keys.forEach((k) => out[k].push(daily[k] ? daily[k][i] : null));
      }
    });
    return out;
  }

  function latest(key) {
    /* Most recent non-null half-hourly value and its timestamp. */
    const col = hh[key];
    for (let i = col.length - 1; i >= 0; i--) {
      if (col[i] !== null && col[i] !== undefined)
        return { ts: hh.t[i], value: col[i], index: i };
    }
    return null;
  }

  function latestDaily(key) {
    if (!daily[key]) return null;
    for (let i = daily.d.length - 1; i >= 0; i--) {
      if (daily[key][i] !== null && daily[key][i] !== undefined)
        return { d: daily.d[i], value: daily[key][i], index: i };
    }
    return null;
  }

  /* Lazily load another zone's series for CONTEXT (Flows counterparty
     panel, import-aware low-carbon) without replacing the active dataset.
     Cached per session; concurrent callers share one in-flight promise. */
  const zoneContextCache = new Map();
  function loadZoneContext(z) {
    if (zoneContextCache.has(z)) return zoneContextCache.get(z);
    const v = manifest ? `?v=${manifest.version}` : "";
    const get = async (path) => {
      const resp = await fetch(path);
      if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
      return resp.json();
    };
    const promise = Promise.all([
      get(`data/zones/${z}/series_hh.json${v}`),
      get(`data/zones/${z}/meta.json${v}`),
    ]).then(([chh, cmeta]) => {
      const index = new Map();
      chh.t.forEach((ts, i) => index.set(ts, i));
      return { hh: chh, meta: cmeta, index };
    }).catch((error) => {
      zoneContextCache.delete(z); // allow retry after a transient failure
      throw error;
    });
    zoneContextCache.set(z, promise);
    return promise;
  }

  /* Lazily load one event day's 15 s frequency slice (System stress tab)
     without touching the active dataset — same session-cache pattern as
     loadZoneContext. Slices are small (~40 kB) grid-aligned arrays. */
  const eventSliceCache = new Map();
  function loadEventSlice(day) {
    if (eventSliceCache.has(day)) return eventSliceCache.get(day);
    const v = manifest ? `?v=${manifest.version}` : "";
    const promise = fetch(`data/events/${day}/freq.json${v}`)
      .then((resp) => {
        if (!resp.ok) throw new Error(`events/${day}: HTTP ${resp.status}`);
        return resp.json();
      })
      .catch((error) => {
        eventSliceCache.delete(day); // allow retry after a transient failure
        throw error;
      });
    eventSliceCache.set(day, promise);
    return promise;
  }

  /* True when a column carries any real signal (non-null AND non-zero).
     Constant-zero generation columns are TSO placeholders (e.g. IE solar)
     — display paths exclude them; the raw data keeps them. */
  function hasSignal(key) {
    return !!hh[key] && hh[key].some((v) => v != null && v !== 0);
  }

  /* p-quantile (0–1) of a half-hourly column over the whole dataset,
     ignoring nulls. Used as the "available capacity" proxy. Cached. */
  const quantileCache = new Map();
  function hhQuantile(key, p) {
    const cacheKey = `${key}:${p}`;
    if (quantileCache.has(cacheKey)) return quantileCache.get(cacheKey);
    const values = (hh[key] || []).filter((v) => v != null).sort((a, b) => a - b);
    const result = values.length
      ? values[Math.min(values.length - 1, Math.floor(p * values.length))]
      : null;
    quantileCache.set(cacheKey, result);
    return result;
  }

  /* Merit-order capacity proxy (GW) per technology. Single source shared
     by the merit-curve chart AND its CSV export so the two can never
     disagree: p98 of observed output for dispatchables, latest observed
     output for must-run wind/solar. Everything here is Estimated. */
  function meritCapacityGw() {
    const cap = {};
    ["NUCLEAR", "BIOMASS", "NPSHYD", "CCGT", "OCGT", "COAL"].forEach((k) => {
      const q = hhQuantile(k, 0.98);
      cap[k] = q == null ? null : q / 1000;
    });
    const windNow = latest("WIND"), solarNow = latest("solar");
    cap.WIND = windNow ? windNow.value / 1000 : null;
    cap.solar = solarNow ? solarNow.value / 1000 : null;
    return cap;
  }

  return {
    load,
    get hh() { return hh; },
    get daily() { return daily; },
    get meta() { return meta; },
    get manifest() { return manifest; },
    get bmu() { return bmu; },
    get overnight() { return overnight; },
    get stress() { return stress; },
    get warnings() { return warnings; },
    get refreshStatus() { return refreshStatus; },
    loadEventSlice,
    get zone() { return zone; },
    currency, ZONE_INFO,
    FUELS, INTERCONNECTORS, STACK_ORDER, LOW_CARBON,
    hhRange, aggregate, aggregateArrays, dailySlice, latest, latestDaily,
    hhQuantile, hasSignal, meritCapacityGw, loadZoneContext, CABLE_ZONE,
  };
})();

/* data.js — loads the canonical dataset and provides slicing/aggregation.
   No mutation of loaded arrays ever: every metric works on copies/views. */

const Data = (() => {
  let hh = null;      // half-hourly columnar: t (epoch s) + series arrays
  let daily = null;   // daily columnar: d (ISO dates) + series arrays
  let meta = null;

  const INTERCONNECTORS = {
    INTFR:   { label: "IFA (FR)",       colour: "#9575cd" },
    INTIFA2: { label: "IFA2 (FR)",      colour: "#7e57c2" },
    INTELEC: { label: "ElecLink (FR)",  colour: "#b39ddb" },
    INTNED:  { label: "BritNed (NL)",   colour: "#5c6bc0" },
    INTNEM:  { label: "Nemo (BE)",      colour: "#7986cb" },
    INTNSL:  { label: "NSL (NO)",       colour: "#4db6ac" },
    INTVKL:  { label: "Viking (DK)",    colour: "#81d4fa" },
    INTIRL:  { label: "Moyle (NI)",     colour: "#aed581" },
    INTEW:   { label: "East-West (IE)", colour: "#9ccc65" },
    INTGRNL: { label: "Greenlink (IE)", colour: "#c5e1a5" },
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
    // Observed dispatch snapshot (GB only, optional — written by
    // etl/build_bmu_snapshot.py; absent until that script has run)
    bmu = null;
    overnight = null;
    if (zone === "GB") {
      try { bmu = await fetchJson(`data/bmu_snapshot.json${v}`); }
      catch { bmu = null; }
      // AI overnight summary (optional — written by
      // ops/run_overnight_summary.sh; tiny, so always fetched fresh)
      try {
        overnight = await fetchJson("data/overnight_summary.json",
          { cache: "no-store" });
      } catch { overnight = null; }
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

  /* Aggregate one HH column into buckets of `seconds`, averaging non-nulls.
     Returns { t: [bucketStartEpoch], v: [mean|null] }. */
  function aggregate(key, fromTs, toTs, seconds) {
    const [lo, hi] = hhRange(fromTs, toTs);
    const col = hh[key];
    const t = [], v = [];
    let bucket = null, sum = 0, n = 0;
    for (let i = lo; i < hi; i++) {
      const b = Math.floor(hh.t[i] / seconds) * seconds;
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

  return {
    load,
    get hh() { return hh; },
    get daily() { return daily; },
    get meta() { return meta; },
    get manifest() { return manifest; },
    get bmu() { return bmu; },
    get overnight() { return overnight; },
    get zone() { return zone; },
    currency, ZONE_INFO,
    FUELS, INTERCONNECTORS, STACK_ORDER, LOW_CARBON,
    hhRange, aggregate, dailySlice, latest, latestDaily, hhQuantile,
  };
})();

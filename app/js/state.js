/* state.js — single in-memory store with pub/sub. No browser storage APIs
   are used anywhere: state lives for the session only (documented fallback:
   defaults restore on reload). */

const State = (() => {
  const state = {
    tab: "overview",
    zone: "GB",               // bidding zone; non-GB zones load lazily
    rangeDays: 30,
    resolution: "auto",       // auto | hh | hour | day
    theme: "dark",
    overlays: { gas: false, carbon: false, demand: false, renewables: false },
    genImports: true,
    genPercent: false,
    genDemandLine: true,
    nlBinned: true,           // binned-median overlay on price vs net load
    assumptions: {
      eta: 0.50,        // reference CCGT efficiency (HHV) for spreads
      etaCcgtLow: 0.45, // CCGT fleet efficiency span for ranges
      etaCcgtHigh: 0.57,
      etaOcgtLow: 0.32,
      etaOcgtHigh: 0.40,
      efGas: 0.184,     // tCO2 per MWh thermal, natural gas
      vom: 3,           // £/MWh variable O&M for the reference CCGT
      etaCoal: 0.36, etaCoalLow: 0.33, etaCoalHigh: 0.39,
      efCoal: 0.34, vomCoal: 5,
      coalPrice: null,  // £/MWh thermal — user-supplied assumption only
    },
  };

  const listeners = [];
  function subscribe(fn) { listeners.push(fn); }
  function set(patch) {
    Object.assign(state, patch);
    listeners.forEach((fn) => fn(state));
  }
  function setAssumption(key, value) {
    state.assumptions[key] = value;
    listeners.forEach((fn) => fn(state));
  }

  /* Effective resolution given range length. */
  function effectiveResolution() {
    if (state.resolution !== "auto") return state.resolution;
    if (state.rangeDays <= 14) return "hh";
    if (state.rangeDays <= 92) return "hour";
    return "day";
  }

  function bucketSeconds() {
    return { hh: 1800, hour: 3600, day: 86400 }[effectiveResolution()];
  }

  /* Current window [fromTs, toTs) in epoch seconds, and ISO day bounds. */
  function window_() {
    const endTs = Data.hh.t[Data.hh.t.length - 1] + 1800;
    const fromTs = endTs - state.rangeDays * 86400;
    const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
    return { fromTs, toTs: endTs, fromIso: iso(fromTs), toIso: iso(endTs) };
  }

  /* Effective coal price (£/MWh th): a manual entry overrides the ETL's
     futures-derived proxy; null when neither exists. */
  function coalInfo() {
    const manual = state.assumptions.coalPrice;
    if (manual != null) return { value: manual, source: "manual" };
    const proxy = Data.latestDaily("coal_proxy_gbp_mwh");
    if (proxy) {
      const ffilled = Data.daily.coal_ffill
        ? Data.daily.coal_ffill[proxy.index] : false;
      return { value: proxy.value, source: "proxy", date: proxy.d,
               ffilled };
    }
    return null;
  }

  return { get: () => state, set, setAssumption, subscribe,
           effectiveResolution, bucketSeconds, window: window_, coalInfo };
})();

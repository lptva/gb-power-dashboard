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
    // AI-interpretation render toggle: off on every load, in-memory only (no
    // browser storage, per the header note) — enable-then-reload returns it to
    // off. Gates rendering of the overnight summary, never the fetch; the data
    // stays published at data/overnight_summary.json regardless.
    aiInterpretation: false,
    // BESS profitability calculator (plan/09, #49) — session-only input
    // set, D30. No browser storage, no URL parameters: defaults restore on
    // reload, same documented behaviour as the rest of this store. Every
    // numeric field starts null (D23: no cost defaults ship from
    // anywhere; the form's ghost placeholders suggest a shape, they never
    // set a value). Structural choices (connection type, zone, percentile,
    // cannibalisation) DO carry stated defaults straight from the design
    // doc (D21's p50, D28's 0%, a plain "most of the fleet is
    // transmission-connected" starting point for connType/zone) — those
    // are not market or cost figures.
    calc: {
      mode: "hypothetical",       // "unit" ships in v2; disabled for now
      power: null,                // P, MW
      energy: null,               // E, MWh
      commission: null,           // y0, ISO date
      life: null,                 // N, years
      period: null,               // T, years (blank -> defaults to N)
      capex: null,                // C, £k/MW
      opex: null,                 // O, £k/MW/yr (blank -> 0)
      opexEsc: null,              // e, %/yr OPEX escalation (blank -> 0,
                                   // D23: no market default ships)
      wacc: null,                 // r, % (blank; stored as a percentage,
                                   // converted to a fraction at compute time)
      connType: "T",              // "T" transmission | "E" distribution
      zone: 1,                    // TNUoS zone number, 1-27
      loadFactor: null,           // f override, % (blank -> c x d / 24)
      cycles: null,               // c, cycles/day (blank -> 0)
      efficiency: null,           // eta, % round-trip (blank -> 0)
      degradation: null,          // delta, %/yr (blank -> 0)
      percentile: "p50",          // D21 default
      cannibalisation: 0,         // gamma, %/yr — D28 default (0% opt-in)
    },
  };

  const CALC_DEFAULTS = { ...state.calc };

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
  /* BESS calculator (D30): setCalc mirrors setAssumption exactly.
     resetCalc restores every field to CALC_DEFAULTS (captured once, at
     module load, from the object above) — the single "Reset to
     defaults" button's whole job. */
  function setCalc(key, value) {
    state.calc[key] = value;
    listeners.forEach((fn) => fn(state));
  }
  function resetCalc() {
    state.calc = { ...CALC_DEFAULTS };
    listeners.forEach((fn) => fn(state));
  }
  function setAiInterpretation(on) {
    state.aiInterpretation = on;
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

  return { get: () => state, set, setAssumption, setAiInterpretation, subscribe,
           setCalc, resetCalc,
           effectiveResolution, bucketSeconds, window: window_, coalInfo };
})();

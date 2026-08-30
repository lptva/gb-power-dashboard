/* metrics.js — pure analytical functions. Every formula here is documented
   in the Methodology tab; estimated metrics never overwrite observed data. */

const Metrics = (() => {

  /* ---------- date formatting (all UTC, en-GB analyst style) ---------- */

  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* fmtDate(msOrIso, style):
       "day"      → 31 May 2026
       "datetime" → 31 May 2026, 11:00
       "month"    → May 2026
       "axisDay"  → 31 May
       "time"     → 11:00                                   */
  function fmtDate(input, style = "day") {
    const date = new Date(typeof input === "string"
      ? Date.parse(input.length <= 10 ? input + "T00:00Z" : input) : input);
    if (Number.isNaN(date.getTime())) return String(input);
    const d = date.getUTCDate(), m = MONTH_NAMES[date.getUTCMonth()],
          y = date.getUTCFullYear(),
          hm = `${String(date.getUTCHours()).padStart(2, "0")}:${
                 String(date.getUTCMinutes()).padStart(2, "0")}`;
    switch (style) {
      case "datetime": return `${d} ${m} ${y}, ${hm}`;
      case "month":    return `${m} ${y}`;
      case "axisDay":  return `${d} ${m}`;
      case "time":     return hm;
      default:         return `${d} ${m} ${y}`;
    }
  }

  /* Axis tick label for a time axis, adapted to the window length.
     Midnight ticks carry the date; sub-day ticks carry the time. On
     multi-day windows (2 < rangeDays ≤ 14) ECharts often spaces the ticks
     roughly a day apart but OFF midnight, so a bare "HH:mm" repeats
     identically on every tick with no date anywhere — at phone width the
     whole axis read "23:00 · 23:00 · 23:00". Anchor those off-midnight
     ticks with the date (two-line label: date over time) so each is
     unambiguous; keep the short bare time only on genuinely intraday
     windows (≤2 days), where ticks are hours apart and already distinct. */
  function fmtAxisTick(ms, rangeDays) {
    if (rangeDays >= 270) return fmtDate(ms, "month");
    if (rangeDays > 14) return fmtDate(ms, "axisDay");
    if (ms % 86400000 === 0) return fmtDate(ms, "axisDay");
    return rangeDays > 2
      ? `${fmtDate(ms, "axisDay")}\n${fmtDate(ms, "time")}`
      : fmtDate(ms, "time");
  }

  /* Clean spark spread (£/MWh): margin of a reference CCGT.
     price − gas/η − (EF/η)·carbon − VOM  */
  function cleanSparkSpread(price, gas, carbon, { eta, efGas, vom }) {
    return price.map((p, i) => {
      if (p == null || gas[i] == null || carbon[i] == null) return null;
      return +(p - gas[i] / eta - (efGas / eta) * carbon[i] - vom).toFixed(2);
    });
  }

  /* Clean dark spread (£/MWh). `coalPrice` is either a constant (manual
     assumption) or a per-day array (futures-derived proxy series). */
  function cleanDarkSpread(price, carbon, coalPrice, { etaCoal, efCoal, vomCoal }) {
    const coalAt = Array.isArray(coalPrice)
      ? (i) => coalPrice[i] : () => coalPrice;
    return price.map((p, i) => {
      const coal = coalAt(i);
      if (p == null || carbon[i] == null || coal == null) return null;
      return +(p - coal / etaCoal
               - (efCoal / etaCoal) * carbon[i] - vomCoal).toFixed(2);
    });
  }

  /* CCGT short-run marginal cost (£/MWh) at a given efficiency. */
  function ccgtSrmc(gas, carbon, eta, efGas, vom) {
    return gas.map((g, i) => {
      if (g == null || carbon[i] == null) return null;
      return +(g / eta + (efGas / eta) * carbon[i] + vom).toFixed(2);
    });
  }

  /* Implied merit-order ladder at spot fuel/carbon prices.
     Each technology gets an SRMC range from its efficiency span.
     Returns sorted [{key,label,low,high,note,assumed}]. */
  function meritLadder(gasPrice, carbonPrice, a) {
    const thermal = (fuelPrice, etaLow, etaHigh, ef, vom) => ({
      low: fuelPrice / etaHigh + (ef / etaHigh) * carbonPrice + vom,
      high: fuelPrice / etaLow + (ef / etaLow) * carbonPrice + vom,
    });
    const rows = [
      { key: "WIND", label: "Wind", low: 0, high: 6,
        note: "near-zero SRMC; range covers VOM estimates" },
      { key: "solar", label: "Solar", low: 0, high: 5,
        note: "near-zero SRMC; range covers VOM estimates" },
      { key: "NUCLEAR", label: "Nuclear", low: 5, high: 15,
        note: "fuel + VOM estimates; fixed costs excluded" },
      { key: "NPSHYD", label: "Hydro", low: 0, high: 12, assumed: true,
        note: "near-zero direct SRMC; reservoir opportunity cost not modelled" },
      { key: "BIOMASS", label: "Biomass", low: 50, high: 90, assumed: true,
        note: "wood pellet costs are commercial data — broad published range" },
      { key: "CCGT", label: "Gas (CCGT)",
        ...thermal(gasPrice, a.etaCcgtLow, a.etaCcgtHigh, a.efGas, a.vom),
        note: `η ${a.etaCcgtLow}–${a.etaCcgtHigh}, gas £${gasPrice.toFixed(1)}, ` +
              `UKA £${carbonPrice.toFixed(0)}` },
      { key: "OCGT", label: "Gas (OCGT)",
        ...thermal(gasPrice, a.etaOcgtLow, a.etaOcgtHigh, a.efGas, a.vom + 4),
        note: `η ${a.etaOcgtLow}–${a.etaOcgtHigh}` },
    ];
    if (a.coalPrice != null) {
      rows.push({ key: "COAL", label: "Coal",
        ...thermal(a.coalPrice, a.etaCoalLow, a.etaCoalHigh, a.efCoal, a.vom + 2),
        assumed: true,
        note: a.coalSource === "proxy"
          ? `coal £${a.coalPrice.toFixed(1)}/MWh th from the Newcastle ` +
            "futures proxy (World Bank monthly avg), not API2"
          : `coal price £${a.coalPrice}/MWh th is a user assumption` });
    }
    rows.forEach((r) => { r.low = +r.low.toFixed(1); r.high = +r.high.toFixed(1); });
    return rows.sort((x, y) => (x.low + x.high) - (y.low + y.high));
  }

  /* Merit-order step curve. Each technology's SRMC range is split into
     small capacity tranches (efficient units first: SRMC rises linearly
     low→high across the technology's capacity), then EVERY tranche is
     sorted by SRMC. The result is a monotonically non-decreasing stack —
     the conventional merit-order geometry — in which technologies may
     interleave where their cost ranges overlap. */
  function meritCurveSteps(ladderRows, capacityGw, trancheGw = 0.5) {
    const tranches = [];
    ladderRows.forEach((row) => {
      const cap = capacityGw[row.key];
      if (cap == null || cap < 0.05) return;
      const n = Math.max(1, Math.ceil(cap / trancheGw));
      for (let i = 0; i < n; i++) {
        tranches.push({
          key: row.key, label: row.label, note: row.note,
          assumed: row.assumed || false,
          low: row.low, high: row.high,
          techCapacityGw: +cap.toFixed(2),
          srmc: +(row.low + ((i + 0.5) / n) * (row.high - row.low)).toFixed(2),
          widthGw: cap / n,
        });
      }
    });
    tranches.sort((a, b) => a.srmc - b.srmc);
    let cum = 0;
    tranches.forEach((t) => {
      t.x0 = +cum.toFixed(3);
      cum += t.widthGw;
      t.x1 = +cum.toFixed(3);
      t.widthGw = +t.widthGw.toFixed(3);
    });
    return tranches;
  }

  /* Implied clearing price: SRMC of the tranche that serves `targetGw`. */
  function curveClearing(tranches, targetGw) {
    for (const t of tranches) {
      if (targetGw <= t.x1) return { price: t.srmc, tranche: t };
    }
    return null;  // demand exceeds curve capacity
  }

  /* Median of ys per `width`-wide bin of xs; bins with <minN pairs dropped. */
  function binnedMedian(xs, ys, width = 2, minN = 10) {
    const bins = new Map();
    xs.forEach((x, i) => {
      if (x == null || ys[i] == null) return;
      const b = Math.floor(x / width) * width;
      if (!bins.has(b)) bins.set(b, []);
      bins.get(b).push(ys[i]);
    });
    return [...bins.entries()]
      .filter(([, arr]) => arr.length >= minN)
      .sort((a, b) => a[0] - b[0])
      .map(([b, arr]) => {
        arr.sort((p, q) => p - q);
        const mid = Math.floor(arr.length / 2);
        const median = arr.length % 2 ? arr[mid]
          : (arr[mid - 1] + arr[mid]) / 2;
        return { x: +(b + width / 2).toFixed(2),
                 median: +median.toFixed(2), n: arr.length };
      });
  }

  /* Histogram of values into £`bin`-wide buckets. */
  function histogram(values, bin = 10) {
    const counts = new Map();
    let n = 0;
    values.forEach((v) => {
      if (v == null) return;
      const b = Math.floor(v / bin) * bin;
      counts.set(b, (counts.get(b) || 0) + 1);
      n++;
    });
    return [...counts.entries()].sort((a, b) => a[0] - b[0])
      .map(([b, c]) => ({ bin: b, share: +(100 * c / n).toFixed(2) }));
  }

  /* Average + interquartile range by half-hour slot of day (UTC). */
  function intradayShape(ts, values) {
    const slots = Array.from({ length: 48 }, () => []);
    ts.forEach((t, i) => {
      if (values[i] == null) return;
      const date = new Date(t);
      slots[date.getUTCHours() * 2 + (date.getUTCMinutes() >= 30 ? 1 : 0)]
        .push(values[i]);
    });
    return slots.map((arr, s) => {
      if (!arr.length) return { slot: s, mean: null, p25: null, p75: null };
      arr.sort((a, b) => a - b);
      const q = (p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
      return {
        slot: s,
        mean: +(arr.reduce((x, y) => x + y, 0) / arr.length).toFixed(2),
        p25: +q(0.25).toFixed(2),
        p75: +q(0.75).toFixed(2),
      };
    });
  }

  /* Pearson correlation of paired arrays, ignoring null pairs. */
  function pearson(xs, ys) {
    const px = [], py = [];
    xs.forEach((x, i) => {
      if (x != null && ys[i] != null) { px.push(x); py.push(ys[i]); }
    });
    const n = px.length;
    if (n < 3) return null;
    const mx = px.reduce((a, b) => a + b) / n;
    const my = py.reduce((a, b) => a + b) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (px[i] - mx) * (py[i] - my);
      dx += (px[i] - mx) ** 2;
      dy += (py[i] - my) ** 2;
    }
    return num / Math.sqrt(dx * dy);
  }

  /* Interconnector utilisation against an OBSERVED operational ceiling.
     GB publishes no per-cable technical limits (its cables sit outside any
     flow-based capacity-calculation region), so the working ceiling per
     direction is the highest flow SUSTAINED for at least `sustainHh`
     half-hours (not necessarily consecutive) inside [ceilFromTs,
     ceilToTs) — the sustainHh-th largest reading. A plain max is not
     robust: the FUELHH interconnector columns carry isolated
     single-period spike artefacts well above anything the cable
     sustains, yet a nameplate-based plausibility cap misfires the other
     way — cables can genuinely sustain flows somewhat above their
     published rating (both failure modes observed on real data in the
     Jul 2026 window: one cable spiked 38% over its rating for single
     half-hours; another's true plateau sat 7% over nameplate for
     hundreds). The kth-largest rule drops isolated artefacts and keeps
     genuine plateaus without consulting nameplate. A direction whose
     ceiling is below `floorMw` (cable offline) returns a null ceiling
     rather than flagging noise as utilisation. Near-capacity = |flow| ≥
     threshold × ceiling, tested per half-hour over [fromTs, toTs); spike
     periods excluded from the ceiling still count there, where they are
     trivially at-limit. Returns half-hour INDICES so callers can join
     other series (e.g. prices) at exactly those periods. */
  function cableUtilisation(ts, flow,
      { fromTs, toTs, ceilFromTs, ceilToTs, threshold = 0.9, floorMw = 0,
        sustainHh = 4 }) {
    const imps = [], exps = [];
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] < ceilFromTs || ts[i] >= ceilToTs) continue;
      const v = flow[i];
      if (v == null) continue;
      if (v > 0) imps.push(v);
      else if (v < 0) exps.push(-v);
    }
    const kthLargest = (arr) => {
      if (!arr.length) return 0;
      arr.sort((a, b) => b - a);
      return arr[Math.min(sustainHh - 1, arr.length - 1)];
    };
    let impCeil = kthLargest(imps), expCeil = kthLargest(exps);
    if (impCeil < floorMw) impCeil = null;
    if (expCeil < floorMw) expCeil = null;
    const nearImp = [], nearExp = [];
    let n = 0;
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] < fromTs || ts[i] >= toTs) continue;
      const v = flow[i];
      if (v == null) continue;
      n++;
      if (impCeil != null && v >= threshold * impCeil) nearImp.push(i);
      else if (expCeil != null && -v >= threshold * expCeil) nearExp.push(i);
    }
    return { impCeil, expCeil, n, nearImp, nearExp };
  }

  /* p-quantile (0–1) of a plain array, nulls ignored; null when empty. */
  function quantile(values, p) {
    const arr = values.filter((v) => v != null).sort((a, b) => a - b);
    if (!arr.length) return null;
    return arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  }

  /* Congestion PROXY — approximation, NOT a shadow price (GB's cables
     allocate capacity per cable via explicit auctions; no flow-based
     congestion rent is published, so none can be observed). A half-hour
     is flagged only when BOTH hold: the cable is near-capacity (indices
     from cableUtilisation) AND the GB−zone spread is wide in the
     DIRECTION the flow earns — importing at ceiling with GB at a premium
     (Δ ≥ thrHi) or exporting at ceiling with GB at a discount
     (Δ ≤ thrLo). Deliberately NOT flagged: wide spread with slack flow
     (outage / ramp-limit shaped — never reaches this test because inputs
     are near-capacity indices only), and at-ceiling flow AGAINST the
     price signal (emergency-action shaped): at-limit, but not a
     congestion-rent picture. */
  function congestionFlags({ nearImp, nearExp }, deltaAt, thrHi, thrLo) {
    const imp = thrHi == null ? [] : nearImp.filter((i) => {
      const d = deltaAt(i);
      return d != null && d >= thrHi;
    });
    const exp = thrLo == null ? [] : nearExp.filter((i) => {
      const d = deltaAt(i);
      return d != null && d <= thrLo;
    });
    return { imp, exp };
  }

  /* ================= BESS profitability calculator (plan/09, #49) =====
     Pure engine functions, mirrored by ops/bess_calculator_figures.py
     (D32) — a Python module recomputes these same figures from the same
     inputs, with a parity test pinning JS output as the oracle. Every
     function here is null-safe and touches neither the DOM nor State:
     the card (charts.js/ui.js) owns input collection, provenance chips
     and rendering; this module owns arithmetic only. All arithmetic is
     real terms, pre-tax, with no residual value. Project NPV/IRR and
     every metric built on net_cashflow_gbp stay UNGEARED; the optional
     toll and debt layer (plan/10 D54/D55, reversing plan/09's
     out-of-scope line) adds its own columns and equity figures beside
     them without touching them — see the Methodology entry for the
     stated simplifications. ============================================ */

  /* Fraction of a calendar year remaining on/after an ISO date (inclusive
     of that day) — used to pro-rate year 1 of the cash flow by the
     fraction of the calendar year left after the commissioning date. No
     commissioning date supplied → a full year 1 (fraction 1). */
  function yearFractionRemaining(isoDate) {
    if (!isoDate) return 1;
    const d = new Date(isoDate + "T00:00:00Z");
    if (Number.isNaN(d.getTime())) return 1;
    const year = d.getUTCFullYear();
    const start = Date.UTC(year, 0, 1);
    const end = Date.UTC(year + 1, 0, 1);
    const totalDays = (end - start) / 86400000;
    const daysElapsed = (d.getTime() - start) / 86400000;
    return Math.max(0, Math.min(1, (totalDays - daysElapsed) / totalDays));
  }

  /* TNUoS zone-level indication (£/kW): z_total(f) = SystemPeak +
     f x (SharedYearRound + NotSharedYearRound) + Residual. Returns null
     — NOT zero — for a distribution-connected unit or a missing zone
     table: "not applicable" and "a zone that nets to zero" must stay
     distinguishable in the output (test plan item 5). `connType` is the
     observed registry prefix, "T" (transmission) or "E" (distribution);
     `zone` is one entry of the payload's tnuos.zones array. */
  function tnuosCharge(connType, zone, loadFactor) {
    if (connType !== "T") return null;          // not applicable
    if (!zone || loadFactor == null) return null;
    return zone.peak + loadFactor * (zone.yr_shared + zone.yr_notshared)
      + zone.residual;
  }

  /* Perfect-foresight arbitrage ceiling (£/MWh): mean top-2d half-hourly
     price minus the mean bottom-2d price divided by round-trip
     efficiency — NOT (sHi - sLo) x eta (test plan item 4; the two differ
     by 1.3% at the measured d=2h figures and the gap widens as
     efficiency falls). Returns null unless both sHi and sLo are
     supplied and eta is truthy — bessCashflow's arbitrage term is then
     zero, matching D31's "arbitrage_gbp ships at zero" behaviour for a
     card with no capture rate set or no price data loaded. */
  function arbitrageCeiling(sHi, sLo, eta) {
    if (sHi == null || sLo == null || !eta) return null;
    return sHi - sLo / eta;
  }

  /* D26's observed ceiling, computed over the price series already
     loaded (v1.5, pulled forward from v2): for each COMPLETE day
     (>= 46 populated half-hourly periods, D26's measured table) inside
     [ts[0], ts[last]] — the fixed data window the app has already
     fetched, never the UI's rolling range presets — take the mean of
     that day's top `n` half-hourly prices and the mean of its bottom
     `n`, where `n = round(2 x durationHours)` (a d-hour asset's "top/
     bottom 2d half-hours"). Average each of those two per-day means
     across every complete day. Returns null (not zero) when there is
     no price series, no positive duration, or no complete day at all —
     "no observed data" and "a zero spread" must stay distinguishable,
     same discipline as tnuosCharge's null. `ts` is epoch SECONDS
     (Data.hh.t's unit); days are grouped by UTC calendar day
     (Math.floor(ts / 86400)), the same bucketing idiom the rest of the
     app already uses for daily aggregation. */
  function observedArbitrageSpread(ts, price, durationHours) {
    if (!ts || !ts.length || !durationHours || durationHours <= 0) return null;
    const n = Math.max(1, Math.round(2 * durationHours));
    const days = new Map();
    for (let i = 0; i < ts.length; i++) {
      const p = price[i];
      if (p == null) continue;
      const day = Math.floor(ts[i] / 86400);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(p);
    }
    let sumHi = 0, sumLo = 0, complete = 0;
    days.forEach((arr) => {
      if (arr.length < 46) return; // incomplete day (D26's measured table)
      const sorted = [...arr].sort((a, b) => a - b);
      const k = Math.min(n, sorted.length);
      const lo = sorted.slice(0, k);
      const hi = sorted.slice(sorted.length - k);
      sumLo += lo.reduce((a, b) => a + b, 0) / k;
      sumHi += hi.reduce((a, b) => a + b, 0) / k;
      complete += 1;
    });
    if (!complete) return null;
    return { sHi: sumHi / complete, sLo: sumLo / complete, days: complete };
  }

  /* Discounting-convention exponent (owner request, 2026-07): the engine
     supports two stated conventions, chosen by the caller via
     `discounting` and defaulting to "mid" (mid-year):
       mid-year (default): year n discounts at (1+r)^(n-0.5).
       end-of-period:      year n discounts at (1+r)^n — the original,
                            unconditional behaviour, with no stub
                            adjustment at all.
     Year 1's pro-rated commissioning stub (frac1 = the remaining-year
     fraction from yearFractionRemaining) discounts, under mid-year, at
     the stub's OWN midpoint: (1-frac1) + frac1/2. This degenerates to
     the general n-0.5 rule exactly when frac1=1 (no stub, e.g. no
     commissioning date set): (1-1)+1/2 = 0.5 = 1-0.5. Kept deliberately
     this simple: later years are not shifted by the stub's own length,
     only year 1's own exponent changes. Under end-of-period, year 1
     stays at exponent 1 regardless of frac1 — no stub adjustment either,
     matching the pre-existing behaviour exactly. */
  function discountExponent(n, frac1, discounting) {
    if (discounting === "end") return n;
    return n === 1 ? (1 - frac1) + frac1 / 2 : n - 0.5;
  }

  /* Level-annuity debt service (plan/10 D55/D61): the constant annual
     payment that retires `principal` over `years` at `rate` (a real
     fraction) — principal x rate / (1 - (1+rate)^-years). rate = 0
     degenerates to straight-line principal/years, taken as an explicit
     branch rather than a 0/0. Returns 0 (an inert layer, matching the
     no-op discipline of the toll and augmentation triples) on
     missing/nonsense inputs rather than null: callers sum it into
     signed cash-flow columns. */
  function annuityPayment(principal, rate, years) {
    if (!Number.isFinite(principal) || !Number.isFinite(rate)
      || !Number.isFinite(years) || principal <= 0 || years < 1) {
      return 0;
    }
    if (rate === 0) return principal / years;
    return principal * rate / (1 - Math.pow(1 + rate, -years));
  }

  /* DSCR statistics over bessCashflow's rows (plan/10 D60/D65):
     DSCR_n = net_cashflow_gbp_n / debt service_n over the years where
     service is actually due. CFADS is deliberately the project net
     cash flow itself, augmentation capex included in its year — the
     honest in-model reading; lenders typically carve funded capex out,
     which the methodology states rather than silently adopting. Null
     when no year carries debt service. `tollTenor` splits the
     toll-period and post-toll aggregates the card's tile note reports;
     0 (no toll) leaves the toll-side aggregates null and everything in
     the post/merchant bucket. */
  function dscrStats(rows, tollTenor) {
    if (!rows || !rows.length) return null;
    const all = [], tollYrs = [], postYrs = [];
    let min = null, minYear = null;
    rows.forEach((row) => {
      if (row.year < 1) return;
      const service = -((row.debt_interest_gbp || 0)
        + (row.debt_principal_gbp || 0));
      if (service <= 0) return;
      const d = row.net_cashflow_gbp / service;
      all.push(d);
      if (tollTenor >= 1 && row.year <= tollTenor) tollYrs.push(d);
      else postYrs.push(d);
      if (min == null || d < min) { min = d; minYear = row.year; }
    });
    if (!all.length) return null;
    const mean = (arr) => (arr.length
      ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const minOf = (arr) => (arr.length ? Math.min(...arr) : null);
    return { min, avg: mean(all), minYear,
             minToll: minOf(tollYrs), avgToll: mean(tollYrs),
             minPost: minOf(postYrs), avgPost: mean(postYrs) };
  }

  /* Year-by-year cash flow (D32's `bessCashflow`). `inputs`:
       P power MW, E energy MWh, y0 ISO commissioning date (or null),
       T calculation period years, C capex £k/MW, O opex £k/MW/yr,
       r WACC (fraction), c cycles/day, delta degradation (fraction/yr),
       eta round-trip efficiency (fraction),
       a availability revenue £/kW/yr (percentile or unit figure),
       sHi, sLo arbitrage prices £/MWh (v2; null in v1), k capture rate
       (fraction, default 0 — no UI to set it in v1, so the arbitrage
       term is zero by construction, matching D31's CSV column),
       gamma annual cannibalisation (fraction/yr, default 0),
       zTotal TNUoS £/kW, already resolved to 0 for a distribution unit
       by the caller via tnuosCharge (default 0),
       discounting "mid" (default) or "end" — see discountExponent above,
       opexEsc annual OPEX escalation (fraction/yr, default 0 — D23: no
       market default ships, blank means flat). Applied ONLY to the
       operating-cost line: O x 1000 x P x frac x (1+opexEsc)^(n-1), so
       year 1 is always the unescalated base and later years compound
       on it (owner request, 2026-08-01). TNUoS is deliberately NOT
       escalated — it is a published tariff, re-set by NESO each
       charging year, not an assumption this card indexes — and the
       augmentation tranche's one-off cost is a typed £/MWh at the time
       it lands, not a recurring charge, so it has nothing to escalate
       either. LCOS picks the change up automatically: it already reads
       this same opex_gbp column via `rows`, not a separate O figure.
       augYear/augMwh/augCostPerMwh/augDelta one optional augmentation
       event as a second cell TRANCHE (owner request, 2026-07-31; the
       vintage revision of the same date replaces the earlier
       restore-to-nameplate shape, which silently reset the ORIGINAL
       cells' clock — physically wrong): at the start of year augYear
       (1..T), augMwh of new cells join (a partial top-up, a full
       restore, or an outright expansion beyond nameplate — the model
       does not cap it), costed at augCostPerMwh £k/MWh into that
       year's net cash flow. The original tranche degrades on its own
       clock forever, E x (1-delta)^(n-1); the new tranche on its own
       vintage clock and its OWN rate, augMwh x (1-augDelta)^(n-augYear)
       (augDelta defaults to delta when the caller passes null). Year,
       size and cost must all be set or the event is a no-op,
       rho availability derate (fraction/yr, default 0): the asset's OWN
       decline in availability-revenue capability (duration eligibility
       narrowing as energy fades), distinct from gamma, which is a
       market-wide price view and stays on the calendar clock. rho
       compounds on the CAPACITY-WEIGHTED cell age across the two
       tranches, so a fresh tranche partially rejuvenates capability in
       proportion to its size — full replacement approaches age zero,
       a small top-up barely moves it, and with no augmentation the
       weighted age is exactly n-1, the pre-tranche behaviour,
       tollShare/tollPrice/tollTenor one optional tolling agreement
       (plan/10 D58/D59): for years 1..tollTenor a share tollShare (a
       fraction) of the asset earns a fixed toll of tollPrice £k/MW/yr
       (numerically identical to £/kW/yr; the market quotes £k/MW/yr) —
       flat real, pro-rated by year 1's commissioning stub but never
       degraded, cannibalised or derated (availability guarantees sit
       with the operator, not this model); the merchant pair
       availability+arbitrage is scaled by (1-tollShare) instead, and
       after the tenor the asset is fully merchant again. All three
       must be set or the agreement is a no-op — the augmentation
       triple's all-or-nothing discipline,
       gearing/costOfDebt/debtTenor one optional debt layer (plan/10
       D59/D61): D0 = gearing x C0 draws down at year 0 and repays as
       a level annuity at costOfDebt over debtTenor years —
       contractual-annual, never stub-pro-rated; a tenor past T leaves
       principal outstanding at the horizon, with no synthetic balloon.
       All three must be set or the layer is a no-op. The layer sits
       BELOW the project line: net_cashflow_gbp and every metric built
       on it stay ungeared; the new signed columns carry the layer and
       equity_cashflow_gbp is their plain sum with net.
     Returns null if the inputs required to build a single year are
     missing or non-finite (D30: "results render only when the required
     inputs are present"). Otherwise { c0, d0, rows }: rows[0] is the
     time-zero row — the capex outflow plus, when the debt layer is
     active, the drawdown and equity contribution (year 0 is never
     discounted under either convention — time zero IS the reference
     point); rows[1..T] are the
     operating years, each figure already signed the way the CSV export
     ships it (costs negative, revenues positive) so net_cashflow_gbp is
     a plain sum. IRR is deliberately NOT computed from these discounted
     columns: it is convention-independent, defined on the undiscounted
     net_cashflow_gbp series (see npv/irr below). Simple payback is also
     undiscounted, for the same reason, and is unaffected by this choice
     entirely. */
  function bessCashflow(inputs) {
    const {
      P, E, y0 = null, T, C, O, r, c, delta = 0, eta,
      a, sHi = null, sLo = null, k = 0, gamma = 0, zTotal = 0,
      discounting = "mid", augYear = null, augMwh = 0,
      augCostPerMwh = 0, augDelta = null, rho = 0, opexEsc = 0,
      tollShare = 0, tollPrice = 0, tollTenor = 0,
      gearing = 0, costOfDebt = null, debtTenor = 0,
    } = inputs || {};
    const finite = (v) => typeof v === "number" && Number.isFinite(v);
    if (![P, E, T, C, O, r, c, eta, a].every(finite) || T <= 0 || P <= 0) {
      return null;
    }
    const augActive = finite(augYear) && augYear >= 1
      && augMwh > 0 && augCostPerMwh > 0;
    const d2 = augDelta == null ? delta : augDelta;
    const tollActive = tollShare > 0 && tollPrice > 0 && tollTenor >= 1;
    const debtActive = gearing > 0 && finite(costOfDebt) && debtTenor >= 1;
    const round = (v, dp = 2) => +v.toFixed(dp);
    const c0 = C * 1000 * P;
    const d0 = debtActive ? gearing * c0 : 0;
    const pay = debtActive ? annuityPayment(d0, costOfDebt, debtTenor) : 0;
    let bal = d0;
    const frac1 = yearFractionRemaining(y0);
    const rows = [{
      year: 0, capex_gbp: round(-c0), availability_gbp: 0,
      arbitrage_gbp: 0, opex_gbp: 0, tnuos_gbp: 0,
      net_cashflow_gbp: round(-c0), discounted_cashflow_gbp: round(-c0),
      cumulative_discounted_gbp: round(-c0), discharged_mwh: 0, usable_mwh: 0,
      toll_gbp: 0, debt_drawdown_gbp: round(d0), debt_interest_gbp: 0,
      debt_principal_gbp: 0, equity_cashflow_gbp: round(-c0 + d0),
    }];
    let cumDisc = -c0;
    const ceiling = arbitrageCeiling(sHi, sLo, eta);
    for (let n = 1; n <= T; n++) {
      const g = Math.pow(1 - gamma, n - 1);
      const frac = n === 1 ? frac1 : 1;
      const t1 = E * Math.pow(1 - delta, n - 1);
      const t2 = (augActive && n >= augYear)
        ? augMwh * Math.pow(1 - d2, n - augYear) : 0;
      const cap = t1 + t2;
      const age = cap > 0
        ? (t1 * (n - 1) + t2 * (augActive ? n - augYear : 0)) / cap
        : n - 1;
      const usableMwh = cap * frac;
      const dischargedMwh = 365 * c * cap * frac;
      const availability = a * 1000 * P * g * frac * Math.pow(1 - rho, age);
      const arbitrage = (ceiling != null && k)
        ? dischargedMwh * ceiling * k * g : 0;
      // Toll £ deliberately OUTSIDE the g/rho/derate scaling the two
      // lines above carry (D58): flat real over the tenor, pro-rated
      // only by year 1's commissioning stub — availability guarantees
      // sit with the operator, so degradation, cannibalisation and the
      // derate stay on the merchant share alone.
      const tollOn = tollActive && n <= tollTenor;
      const sEff = tollOn ? tollShare : 0;
      const toll = tollOn ? tollPrice * 1000 * P * tollShare * frac : 0;
      const availabilityNet = availability * (1 - sEff);
      const arbitrageNet = arbitrage * (1 - sEff);
      // Escalated on OPEX alone (owner request, 2026-08-01): TNUoS below
      // stays on the flat published-tariff figure, and the augmentation
      // capex line further down is a one-off typed cost, not a
      // recurring charge either escalation would apply to.
      const opex = O * 1000 * P * frac * Math.pow(1 + opexEsc, n - 1);
      const tnuos = (zTotal || 0) * 1000 * P * frac;
      const capexN = (augActive && n === augYear)
        ? -(augCostPerMwh * 1000 * augMwh) : 0;
      const net = toll + availabilityNet + arbitrageNet - opex - tnuos + capexN;
      const discounted = net / Math.pow(1 + r, discountExponent(n, frac1, discounting));
      cumDisc += discounted;
      // Debt walk (D61): contractual-annual, never stub-pro-rated; a
      // tenor past T just stops here with principal outstanding.
      const serviceDue = debtActive && n <= debtTenor;
      const interest = serviceDue ? bal * costOfDebt : 0;
      const principal = serviceDue ? pay - interest : 0;
      if (serviceDue) bal -= principal;
      const equity = net - interest - principal;
      rows.push({
        year: n, capex_gbp: round(capexN),
        availability_gbp: round(availabilityNet),
        arbitrage_gbp: round(arbitrageNet),
        opex_gbp: round(-opex),
        tnuos_gbp: round(-tnuos),
        net_cashflow_gbp: round(net),
        discounted_cashflow_gbp: round(discounted),
        cumulative_discounted_gbp: round(cumDisc),
        discharged_mwh: round(dischargedMwh, 3),
        usable_mwh: round(usableMwh, 3),
        toll_gbp: round(toll),
        debt_drawdown_gbp: 0,
        debt_interest_gbp: round(-interest),
        debt_principal_gbp: round(-principal),
        equity_cashflow_gbp: round(equity),
      });
    }
    return { c0, d0, rows };
  }

  /* NPV at rate `r` of a capex outflow C0 (time zero) plus a plain array
     of undiscounted year-1..year-N net cash flows. Kept separate from
     bessCashflow so IRR's bisection can re-discount without rebuilding
     the whole cash flow at every trial rate. `discounting`/`frac1` are
     optional and default to "end"/1 — i.e. unconditional (1+r)^n — so
     every existing caller (chiefly irr(), below) is completely
     unaffected by the discounting-convention feature: IRR is defined on
     undiscounted flows in the usual (annual-compounding) sense
     regardless of which convention the card is reporting NPV under, and
     must stay that way (a mid-year toggle changing what "IRR" means
     would be a second, uninvited behaviour change). The card's headline
     NPV figure passes its own `discounting`/`frac1` explicitly so it
     matches bessCashflow's own discounted columns exactly. */
  function npv(c0, cashflows, r, discounting = "end", frac1 = 1) {
    return cashflows.reduce((sum, cf, i) =>
      sum + cf / Math.pow(1 + r, discountExponent(i + 1, frac1, discounting)),
      -c0);
  }

  /* IRR by bisection on r in [-0.99, 1.50], 100 iterations, tolerance
     1e-9. Returns null — never 0 — when NPV does not change sign across
     the bracket (a cash flow that never repays; the common case, and
     must not be misreported as a 0% return). */
  function irr(c0, cashflows) {
    const f = (r) => npv(c0, cashflows, r);
    let lo = -0.99, hi = 1.50;
    let fLo = f(lo), fHi = f(hi);
    if (fLo === 0) return lo;
    if (fHi === 0) return hi;
    if ((fLo > 0) === (fHi > 0)) return null; // no sign change: no IRR
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      const fMid = f(mid);
      if (Math.abs(fMid) < 1e-9) return mid;
      if ((fMid > 0) === (fLo > 0)) { lo = mid; fLo = fMid; }
      else { hi = mid; fHi = fMid; }
    }
    return (lo + hi) / 2;
  }

  /* Modified IRR (owner request, 2026-07-31): negative net cash flows
     (including the year-0 capex) discount to t=0 at the finance rate,
     positive ones compound to the horizon T at the reinvestment rate,
     and MIRR = (FV_pos / -PV_neg)^(1/T) - 1. Both rates are the WACC —
     the standard single-rate reading, stated on the card and the
     workbook. Exists BESIDE irr(), not instead of it: an augmentation-
     year outflow gives the cash-flow series a second sign change, and
     plain IRR then has multiple mathematically-valid roots (which one a
     solver returns is luck); MIRR is single-valued by construction.
     End-of-period basis like irr(), unaffected by the mid-year toggle.
     Null — never a number — when there is no positive flow or no
     negative flow at all, since the ratio is then undefined. */
  function mirr(c0, cashflows, r) {
    const T = cashflows.length;
    if (!T) return null;
    let fvPos = 0;
    let pvNeg = -c0;
    cashflows.forEach((cf, i) => {
      const n = i + 1;
      if (cf > 0) fvPos += cf * Math.pow(1 + r, T - n);
      else pvNeg += cf / Math.pow(1 + r, n);
    });
    if (fvPos <= 0 || pvNeg >= 0) return null;
    return Math.pow(fvPos / -pvNeg, 1 / T) - 1;
  }

  /* Simple (undiscounted) payback in years, linearly interpolated inside
     the year repayment falls in. Null when C0 is never recovered within
     the supplied cash flows — labelled "simple" because it is
     deliberately undiscounted, and must render as "no payback", never a
     zero or the final year. */
  function simplePayback(c0, cashflows) {
    let cum = 0;
    for (let i = 0; i < cashflows.length; i++) {
      const prevCum = cum;
      cum += cashflows[i];
      if (cum >= c0) {
        const remainder = c0 - prevCum;
        const frac = cashflows[i] ? remainder / cashflows[i] : 0;
        return i + frac;
      }
    }
    return null;
  }

  /* Discounted payback period (DPP) in years, linearly interpolated on
     DISCOUNTED cash flows — never the undiscounted net_cashflow_gbp
     column (the mistake the workbook's own draft DPP row made before
     this function existed to pin it). `rows` is bessCashflow's row
     array: its cumulative_discounted_gbp column already walks from the
     year-0 row's own discounted value (-c0), so this function finds
     the first year the RUNNING total crosses from negative to >= 0 and
     interpolates inside that year on its own discounted figure:
       DPP = n - 1 + (dcf_n - cum_n) / dcf_n
     where dcf_n is year n's discounted_cashflow_gbp and cum_n is the
     cumulative discounted total INCLUDING year n. Null when the
     cumulative never crosses within the modelled years — "no payback",
     never a final-year value or a zero.

     Anchor-invariant: re-anchoring to a different valuation date scales
     every discounted figure (every dcf_n and every cum_n) by the same
     one factor, which cancels both in the >= 0 crossing test and in
     the (dcf_n - cum_n) / dcf_n fraction — DPP must never be passed
     through Metrics.reanchorNpv, unlike NPV/PVI.

     Convention-aware, the opposite of simplePayback/irr: the
     discounted_cashflow_gbp column already carries whichever
     discounting convention (mid-year/end-of-period) and year-1
     commissioning stub bessCashflow was built with, so DPP moves with
     that choice. */
  function discountedPayback(rows) {
    if (!rows || !rows.length) return null;
    let cum = rows[0].discounted_cashflow_gbp;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const prevCum = cum;
      cum += row.discounted_cashflow_gbp;
      if (prevCum < 0 && cum >= 0) {
        const dcfN = row.discounted_cashflow_gbp;
        return dcfN ? (row.year - 1) + (dcfN - cum) / dcfN : row.year - 1;
      }
    }
    return null;
  }

  /* Present value of investment (PVI) at commissioning: c0 (the
     positive year-0 capex) plus the discounted value of every later
     capital outflow (bessCashflow's capex_gbp rows, negative in an
     augmentation year and zero otherwise), each sign-flipped positive
     so PVI is itself a positive magnitude — "every pound of capital
     committed, discounted to commissioning" — not a signed cash flow.
     Same signature shape as npv(): `discounting`/`frac1` default to
     "end"/1 for the same reason npv()'s do (a caller that does not
     pass them explicitly gets the unconditional (1+r)^n basis); the
     card's own PVI must pass its own discounting/frac1 so it matches
     bessCashflow's own discounted columns exactly. Re-anchoring PVI to
     a valuation date uses the identical Metrics.reanchorNpv factor NPV
     itself uses — DPI is then the ratio of two figures re-anchored by
     the same factor, so the factor cancels and DPI is itself
     anchor-invariant, the same discipline as discountedPayback above,
     by a different route. */
  function pviAtCommissioning(c0, rows, r, discounting = "end", frac1 = 1) {
    return rows.reduce((sum, row) => {
      if (row.year < 1) return sum;
      return sum + (-row.capex_gbp) /
        Math.pow(1 + r, discountExponent(row.year, frac1, discounting));
    }, c0);
  }

  /* Indicative LCOS (£/MWh): (C0 + discounted opex+TNUoS+charging cost)
     divided by discounted discharged energy. `rows` is bessCashflow's
     row array (years 1..T only — the year-0 capex row is excluded here
     because C0 enters once, undiscounted, as its own term); `sLo`/`eta`
     price the charging leg (Q_n / eta x sLo) — v1 ships with no
     wholesale price feed wired into the card, so a null sLo simply drops
     the charging-cost term (LCOS still renders, just without that
     component) rather than the function refusing to compute. Null when
     no energy is ever discharged (LCOS is undefined). */
  function lcos(c0, rows, r, eta, sLo = null) {
    let costNum = c0;
    let energyDenom = 0;
    rows.forEach((row) => {
      const n = row.year;
      if (n < 1) return;
      const X = -row.opex_gbp;
      const G = -row.tnuos_gbp;
      // Augmentation capex (rows carry it signed negative in the year
      // it lands) is a cost of storage and belongs in the numerator,
      // discounted on the same end-of-period basis as every other term.
      const aug = -row.capex_gbp;
      const Q = row.discharged_mwh;
      const charging = (sLo != null && eta) ? (Q / eta) * sLo : 0;
      costNum += (X + G + charging + aug) / Math.pow(1 + r, n);
      energyDenom += Q / Math.pow(1 + r, n);
    });
    return energyDenom > 0 ? costNum / energyDenom : null;
  }

  /* NPV re-anchoring (owner request, 2026-07): the card's headline NPV is
     computed at t=0, the commissioning date — silently, before this
     function existed. An ongoing asset is more often reassessed on some
     later "today", and a pre-decision appraisal wants t=0 pushed back
     before commissioning; both are the SAME identity, one exact
     compounding factor applied either direction:

       reanchorNpv(npvAtCommissioning, r, y0, valuationDate) =
         npvAtCommissioning x (1 + r) ^ (years from y0 to valuationDate)

     Years use a 365.25-day year, matching the rest of this file's date
     arithmetic (arbitrage/discounting use whole days; this is the one
     place a MULTI-YEAR span is measured, so the .25 leap-year correction
     matters over a period this long). A valuation date AFTER
     commissioning gives a positive exponent: NPV compounds FORWARD
     (past cash flows have had time to earn a further return). A
     valuation date BEFORE commissioning gives a negative exponent: NPV
     discounts BACK (the whole project is still in the future). No
     separate branch is needed for the two directions — the same power
     of (1+r) covers both, which is the point of writing it as one
     identity rather than two cases.

     Null-safe: a missing/unparseable y0 or valuationDate returns
     npvAtCommissioning unchanged (factor 1) rather than guessing a
     reference date — there is no calendar date to measure a span
     against when either end is absent. The caller resolves "blank
     valuation date defaults to commissioning" (factor 1, same
     conclusion by a different route: valuationDate === y0 makes the
     exponent exactly 0) before calling this, so a caller that always
     passes c.valuationDate || c.commission never needs a special case
     for the blank-field default either. IRR, simple payback and LCOS do
     not call this at all: IRR and payback are anchor-invariant by
     construction (defined on undiscounted flows), and LCOS scales its
     numerator and denominator by the identical discounting, so the
     ratio is unaffected — none of the three needs re-anchoring, and
     none should be passed through this function. */
  function reanchorNpv(npvAtCommissioning, r, y0, valuationDate) {
    if (npvAtCommissioning == null || !Number.isFinite(r)) {
      return npvAtCommissioning;
    }
    if (!y0 || !valuationDate) return npvAtCommissioning;
    const d0 = new Date(y0 + "T00:00:00Z");
    const d1 = new Date(valuationDate + "T00:00:00Z");
    if (Number.isNaN(d0.getTime()) || Number.isNaN(d1.getTime())) {
      return npvAtCommissioning;
    }
    const years = (d1.getTime() - d0.getTime()) / 86400000 / 365.25;
    return npvAtCommissioning * Math.pow(1 + r, years);
  }

  /* ================= Mini-CFFM engine (plan/10 Phase 3, B2) ===========
     Ofgem's LDES cap-and-floor financial model (CFFM), reduced to its
     ex-tax real-terms core (D73/D74): RAV build with interest during
     construction (IDC), transaction costs, straight-line depreciation,
     the model's averaged-base return on RAV, and annuity flattening —
     computed separately at the floor rate and the cap rate.
     Deliberately OUT of scope: the corporation-tax loop (levels here
     are ex-tax; the real CFFM adds a grossed-up nominal tax annuity —
     measured on Ofgem's own illustrative dataset the omission leaves
     these levels roughly 10-13% below the true ones), Repex, the ACOD
     floor, and the partial-indexation switch (dropped by Ofgem).
     Everything is flat real terms — no inflation arithmetic anywhere.
     Mirrored by ops/ldes_cffm_figures.py; same discipline as the BESS
     block above: pure null-safe functions, no DOM, no State — the card
     owns inputs and rendering, this module owns arithmetic only.
     Formula references (A1.x) are to the CFFM Handbook v2.1, annex A1;
     cell references (Op_Rav!.., Allowances_Cap!..) are to CFFM v2.17,
     against which the capital arithmetic was verified (plan/10 D85,
     2026-08-30). ====================================================== */

  /* Floor and cap levels (£m/yr, flat real, ex-tax). `inputs`, all real
     £m unless stated:
       constructionYears int >= 1; devex £m (spent in construction year
       1); capex £m (spread evenly across construction years); idcRate
       fraction; gearing fraction (pre-operational notional — used only
       for the transaction-cost split); txDebtRate/txEquityRate
       fractions of transferred RAV; opexFixed £m/yr (flat real over
       operations); decom £m/yr (baseline, flat); opYears int (default
       25); residualValue £m at end of regime (default 0); floorRate/
       capRate fractions.
     Returns null on any missing/non-finite required input, or on
     constructionYears/opYears < 1. Otherwise
       { rav, idcTotal, txTotal,
         floor: { level, returnAnnuity, depreciationAnnuity, opexBlock },
         cap:   { ...same shape } }.

     Mechanics:
     - Pre-op RAV walk, one row per construction year: additions =
       devex (year 1 only) + capex/constructionYears;
       IDC_y = idcRate x (openingRAV + additions/(2 + idcRate)) — the
       A1.70 formula verbatim (in-year costs earn a half year of IDC,
       discounted from mid-year at the simple half-year rate); closing =
       opening + additions + IDC_y. Whole construction years only — the
       full model's fractional-year IDC flags are not replicated.
     - Transaction costs at transfer (A1.72-77, simplified to one shot):
       tx = closing pre-op RAV x (gearing x txDebtRate + (1 - gearing)
       x txEquityRate). The real model also capitalises IDC on early
       debt transaction costs; this mini version does not.
     - RAV at start of operations = closing pre-op RAV + tx.
       Residual timing (mirrors Op_Rav!K12's -I29 year-1 deduction,
       verified against CFFM v2.17): the residual is deducted from the
       opening operational RAV in year 1, so the whole walk — both
       depreciation AND the return — runs on the depreciable base
       RAV - residualValue, straight-line to ZERO over opYears (no
       Repex, so no re-spread). The residual never depreciates and
       NEVER earns a return; it is simply absent from the walk.
     - Return, per operational year n at rate r (mirrors Op_Rav!K38/
       K39, verified against CFFM v2.17): closing_n = opening_n -
       depreciation, and return_n = r x (opening_n + closing_n/(1+r))/2
       — the model's average of the opening RAV and the closing RAV
       discounted one year, each side at its own rate. Combined with
       this block's plain end-of-year discounting ((1+r)^-n from the
       start of operations, Allowances_Cap!K36), the capital-side
       annuity satisfies level = depreciable base x AF x
       (2+r)/(2(1+r)) — NOT level = RAV x AF: that factor is IN
       Ofgem's own levels, and the factor identity test pins it.
     - Annuitisation at each rate (A1.151):
       annuityFactor = r / (1 - (1+r)^-opYears) (r = 0 degenerates to
       1/opYears, an explicit branch like annuityPayment's); NPV =
       sum of allowance_n x (1+r)^-n where allowance_n = opexFixed +
       decom + depreciation_n + return_n; level = NPV x annuityFactor.
       The annuitised sub-blocks are exposed for the card's breakdown;
       flattening is idempotent on flat streams, so depreciationAnnuity
       equals the annual depreciation and opexBlock equals
       opexFixed + decom (to float precision) — only the declining
       return block is genuinely reshaped. */
  function cffmLevels(inputs) {
    if (!inputs) return null;
    const opYears = inputs.opYears == null ? 25 : inputs.opYears;
    const residualValue = inputs.residualValue == null ? 0
      : inputs.residualValue;
    const { constructionYears, devex, capex, idcRate, gearing,
            txDebtRate, txEquityRate, opexFixed, decom,
            floorRate, capRate } = inputs;
    const required = [constructionYears, devex, capex, idcRate, gearing,
                      txDebtRate, txEquityRate, opexFixed, decom,
                      opYears, residualValue, floorRate, capRate];
    if (required.some((v) => !Number.isFinite(v))) return null;
    if (constructionYears < 1 || opYears < 1) return null;

    let preOpRav = 0, idcTotal = 0;
    const capexPerYear = capex / constructionYears;
    for (let y = 1; y <= constructionYears; y++) {
      const additions = capexPerYear + (y === 1 ? devex : 0);
      const idc = idcRate * (preOpRav + additions / (2 + idcRate));
      preOpRav += additions + idc;
      idcTotal += idc;
    }
    const txTotal = preOpRav
      * (gearing * txDebtRate + (1 - gearing) * txEquityRate);
    const rav = preOpRav + txTotal;

    const depreciable = rav - residualValue;
    const depreciation = depreciable / opYears;
    const side = (r) => {
      let opening = depreciable, npvReturn = 0, npvDep = 0, npvOpex = 0;
      for (let n = 1; n <= opYears; n++) {
        const disc = Math.pow(1 + r, -n);
        const closing = opening - depreciation;
        npvReturn += r * (opening + closing / (1 + r)) / 2 * disc;
        npvDep += depreciation * disc;
        npvOpex += (opexFixed + decom) * disc;
        opening = closing;
      }
      const annuityFactor = r === 0 ? 1 / opYears
        : r / (1 - Math.pow(1 + r, -opYears));
      const returnAnnuity = npvReturn * annuityFactor;
      const depreciationAnnuity = npvDep * annuityFactor;
      const opexBlock = npvOpex * annuityFactor;
      return { level: returnAnnuity + depreciationAnnuity + opexBlock,
               returnAnnuity, depreciationAnnuity, opexBlock };
    };
    return { rav, idcTotal, txTotal,
             floor: side(floorRate), cap: side(capRate) };
  }

  /* Corridor arithmetic (D77 — from Ofgem's decision documents, not
     the handbook): what a gross-margin scenario means under the
     floor/cap regime. `levels` is { floorLevel, capLevel } (£m/yr,
     flat real); `inputs` is { gmLow, gmCentral, gmHigh } (£m/yr flat
     real gross-margin scenarios) plus opYears (default 25). Per
     scenario, all annual £m/yr:
       topUp    = max(0, floorLevel - gm)   consumer support up to the
                                            floor;
       aboveCap = max(0, gm - capLevel)     excess above the cap;
       clawback = 0.7 x aboveCap            the 70% consumer share of
                                            above-cap margin;
       retained = gm - clawback             what the operator keeps;
     with lifetime figures = annual x opYears — flat and deliberately
     UNDISCOUNTED: the model is a flat real annuity held against flat
     real scenarios, and inventing a consumer-flow discount rate would
     be false precision, so none is applied. faScore = gmCentral /
     floorLevel, Ofgem's financial-adequacy metric (the published 0.60
     demotion threshold is a UI concern, not an engine constant); null
     when the floor level is not positive. Returns null on any
     missing/non-finite input or opYears < 1. */
  function cffmCorridor(levels, inputs) {
    if (!levels || !inputs) return null;
    const { floorLevel, capLevel } = levels;
    const { gmLow, gmCentral, gmHigh } = inputs;
    const opYears = inputs.opYears == null ? 25 : inputs.opYears;
    const required = [floorLevel, capLevel, gmLow, gmCentral, gmHigh,
                      opYears];
    if (required.some((v) => !Number.isFinite(v))) return null;
    if (opYears < 1) return null;
    const scenario = (gm) => {
      const topUp = Math.max(0, floorLevel - gm);
      const aboveCap = Math.max(0, gm - capLevel);
      const clawback = 0.7 * aboveCap;
      const retained = gm - clawback;
      return { gm, topUp, aboveCap, clawback, retained,
               lifetimeTopUp: topUp * opYears,
               lifetimeClawback: clawback * opYears,
               lifetimeRetained: retained * opYears };
    };
    return { low: scenario(gmLow), central: scenario(gmCentral),
             high: scenario(gmHigh),
             faScore: floorLevel > 0 ? gmCentral / floorLevel : null };
  }

  /* One-off end-of-regime cost -> flat annual equivalent (D79): a
     single payment X at the end of year opYears is NPV-equivalent to
     X x (1+r)^-opYears x AF(r, opYears) per year over the regime —
     discount the lump to the start of operations, then flatten with
     the same A1.151 annuity factor the levels use. Exists for the
     decommissioning field's live line: the field is a per-YEAR
     allowance (the CFFM's annual Opex & Decom block), and an owner who
     has a one-off end-of-life estimate needs its annuitised equivalent
     stated, not silently multiplied by the regime length. r = 0
     degenerates to X / opYears (no discounting, plain spreading).
     Null on any missing/non-finite input or opYears < 1. Mirrored in
     ops/ldes_cffm_figures.py. */
  function cffmAnnuitiseEndOfLife(amount, rate, opYears) {
    if (![amount, rate, opYears].every(Number.isFinite)) return null;
    if (opYears < 1) return null;
    if (rate === 0) return amount / opYears;
    const af = rate / (1 - Math.pow(1 + rate, -opYears));
    return amount * Math.pow(1 + rate, -opYears) * af;
  }

  /* The mini-CFFM CSV export's parameter table (D81, superseding D80's
     year table after owner feedback: the model is flat, so 25
     identical year rows carried nothing, and `#` comment-line inputs
     forced manual parsing). Factored out of the card so the schema is
     testable through the Python mirror. Returns the full row list for
     a section,parameter,value CSV: the header row, then one `input`
     row per card field (the raw typed value — percents as typed, this
     export records what the reader entered, not the engine's
     fractions — "not_set" when blank), then the `derived` summary
     (RAV, IDC, transaction costs, both levels with their annuitised
     sub-blocks, FA score, and the lifetime corridor figures per
     scenario — "not_set" for any scenario not typed), and the
     standing caveat as the one `note` row. Every value is a number
     rounded to 4 dp or a closed token, all ASCII; the note text is
     the only free-text value and the only one a serialiser must
     comma-quote. `levels` from cffmLevels, `corridor` from
     cffmCorridor or null (no central scenario typed), `inputs` is the
     card's raw typed state. Null on missing levels or inputs. */
  function cffmCsvRows(levels, corridor, inputs) {
    if (!levels || inputs == null) return null;
    const round4 = (v) => +v.toFixed(4);
    const rows = [["section", "parameter", "value"]];
    [["construction_years", inputs.constructionYears],
     ["capex_gbpm", inputs.capex],
     ["devex_gbpm", inputs.devex],
     ["idc_rate_pct", inputs.idcRate],
     ["gearing_pct", inputs.gearing],
     ["tx_debt_pct", inputs.txDebtRate],
     ["tx_equity_pct", inputs.txEquityRate],
     ["opex_gbpm_yr", inputs.opexFixed],
     ["decom_gbpm_yr", inputs.decom],
     ["op_years", inputs.opYears],
     ["residual_value_gbpm", inputs.residualValue],
     ["floor_return_pct", inputs.floorRate],
     ["cap_return_pct", inputs.capRate],
     ["mw", inputs.mw],
     ["gm_low_gbpm_yr", inputs.gmLow],
     ["gm_central_gbpm_yr", inputs.gmCentral],
     ["gm_high_gbpm_yr", inputs.gmHigh],
    ].forEach(([key, v]) => rows.push(
      ["input", key, Number.isFinite(v) ? v : "not_set"]));
    const derived = (key, v) => rows.push(
      ["derived", key, Number.isFinite(v) ? round4(v) : "not_set"]);
    derived("rav_gbpm", levels.rav);
    derived("idc_total_gbpm", levels.idcTotal);
    derived("tx_total_gbpm", levels.txTotal);
    derived("floor_level_gbpm_yr", levels.floor.level);
    derived("cap_level_gbpm_yr", levels.cap.level);
    derived("floor_return_annuity_gbpm", levels.floor.returnAnnuity);
    derived("floor_depreciation_annuity_gbpm",
            levels.floor.depreciationAnnuity);
    derived("floor_opex_block_gbpm", levels.floor.opexBlock);
    derived("cap_return_annuity_gbpm", levels.cap.returnAnnuity);
    derived("cap_depreciation_annuity_gbpm",
            levels.cap.depreciationAnnuity);
    derived("cap_opex_block_gbpm", levels.cap.opexBlock);
    derived("fa_score",
            corridor && corridor.faScore != null ? corridor.faScore : NaN);
    [["low", inputs.gmLow], ["central", inputs.gmCentral],
     ["high", inputs.gmHigh]].forEach(([name, typed]) => {
      const sc = corridor && Number.isFinite(typed)
        ? corridor[name] : null;
      derived(`lifetime_topup_${name}_gbpm`, sc ? sc.lifetimeTopUp : NaN);
      derived(`lifetime_clawback_${name}_gbpm`,
              sc ? sc.lifetimeClawback : NaN);
      derived(`lifetime_retained_${name}_gbpm`,
              sc ? sc.lifetimeRetained : NaN);
    });
    rows.push(["note", "caveat",
      "ex-tax, flat real, indicative - not the CFFM, not a valuation"]);
    return rows;
  }

  /* Build a CSV string from {header: array} columns. No comma-escaping —
     do not add free-text columns to any export without revisiting this
     function first: a single stray comma shifts every field on that row
     and corrupts all downstream rows. Every exported value must stay a
     number, ISO date/timestamp, boolean, or closed token set. */
  function toCsv(columns) {
    const keys = Object.keys(columns);
    const n = columns[keys[0]].length;
    const lines = [keys.join(",")];
    for (let i = 0; i < n; i++) {
      lines.push(keys.map((k) => {
        const v = columns[k][i];
        return v == null ? "" : v;
      }).join(","));
    }
    return lines.join("\n");
  }

  return { cleanSparkSpread, cleanDarkSpread, ccgtSrmc, meritLadder,
           meritCurveSteps, curveClearing, binnedMedian,
           histogram, intradayShape, pearson, cableUtilisation,
           quantile, congestionFlags, toCsv,
           fmtDate, fmtAxisTick,
           yearFractionRemaining, tnuosCharge, arbitrageCeiling,
           observedArbitrageSpread,
           bessCashflow, annuityPayment, dscrStats,
           npv, irr, mirr, simplePayback, discountedPayback,
           pviAtCommissioning, lcos, reanchorNpv,
           cffmLevels, cffmCorridor, cffmAnnuitiseEndOfLife,
           cffmCsvRows };
})();

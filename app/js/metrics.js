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

  /* Axis tick label for a time axis, adapted to the window length. */
  function fmtAxisTick(ms, rangeDays) {
    if (rangeDays >= 270) return fmtDate(ms, "month");
    if (rangeDays > 14) return fmtDate(ms, "axisDay");
    return ms % 86400000 === 0 ? fmtDate(ms, "axisDay") : fmtDate(ms, "time");
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
           fmtDate, fmtAxisTick };
})();

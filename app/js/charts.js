/* charts.js — every ECharts panel. Chart instances are kept in a registry
   and re-rendered with notMerge so stale series never linger. */

const Charts = (() => {
  const registry = new Map();

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function chart(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    if (!registry.has(id)) {
      registry.set(id, echarts.init(el, null, { renderer: "canvas" }));
    }
    return registry.get(id);
  }

  function resizeAll() { registry.forEach((c) => c.resize()); }

  const GW = (mw) => (mw == null ? null : +(mw / 1000).toFixed(2));

  function fmtVal(v) {
    const n = Array.isArray(v) ? v[1] : v;
    if (n == null || Number.isNaN(+n)) return null;
    return (+n).toLocaleString("en-GB", { maximumFractionDigits: 2 });
  }

  /* Default axis-trigger tooltip: human-readable header (e.g.
     "31 May 2026, 11:00") instead of raw timestamps. Helper band series
     (names ending in a space) are hidden. gran: "auto" | "day". */
  function axisTooltipFormatter(gran) {
    return (params) => {
      const list = Array.isArray(params) ? params : [params];
      if (!list.length) return "";
      let header = list[0].axisValueLabel || "";
      if (list[0].axisType === "xAxis.time") {
        const style = gran === "day"
          || (gran === "auto" && State.bucketSeconds() >= 86400)
          ? "day" : "datetime";
        header = Metrics.fmtDate(list[0].axisValue, style);
      }
      const rows = list
        .map((p) => ({ p, val: fmtVal(p.value) }))
        .filter(({ p, val }) => val != null && !p.seriesName.endsWith(" "))
        .map(({ p, val }) => `${p.marker} ${p.seriesName}` +
          `<span style="float:right;margin-left:16px;font-weight:600">${val}</span>`);
      return `<div style="margin-bottom:3px">${header}</div>${rows.join("<br>")}`;
    };
  }

  // Tabular monospaced figures for every numeric annotation on charts —
  // axis ticks, markLine labels ("Latest price £93"), legend, axis pointers.
  const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  // GB prices are £ (MID); ENTSO-E zones report their settlement currency
  // in the zone meta (read from the A44 response — EUR for all current
  // zones, including NO_2, verified rather than assumed).
  const CUR = () => Data.currency();
  // GB's price series is the MID proxy; ENTSO-E zones carry a true
  // day-ahead auction price — label accordingly.
  const PRICE_NAME = () =>
    (State.get().zone === "GB" ? "Price (MID)" : "Price (day-ahead)");

  function base(extra = {}, gran = "auto") {
    return {
      animation: false,
      textStyle: { color: css("--text-dim"), fontSize: 11,
                   fontFamily: MONO },
      grid: { left: 52, right: 56, top: 48, bottom: 42 },
      tooltip: {
        trigger: "axis",
        backgroundColor: css("--bg-raised"),
        borderColor: css("--border"),
        textStyle: { color: css("--text"), fontSize: 12 },
        axisPointer: { type: "cross", label: {
          backgroundColor: css("--bg-raised"),
          formatter: (p) => (p.axisDimension === "x"
            && typeof p.value === "number" && p.value > 1e12)
            ? Metrics.fmtDate(p.value, "datetime")
            : (typeof p.value === "number"
               ? (+p.value).toFixed(1) : String(p.value)),
        } },
        confine: true,
        formatter: axisTooltipFormatter(gran),
      },
      ...extra,
    };
  }

  const baseDay = (extra) => base(extra, "day");

  function timeAxis() {
    return {
      type: "time",
      axisLine: { lineStyle: { color: css("--border") } },
      axisLabel: { color: css("--text-dim"), hideOverlap: true,
        fontFamily: MONO,
        formatter: (val) => Metrics.fmtAxisTick(val, State.get().rangeDays) },
      splitLine: { show: false },
    };
  }

  function valueAxis(name, opts = {}) {
    return {
      type: "value", name, nameTextStyle: { color: css("--text-dim") },
      axisLine: { show: false },
      axisLabel: { color: css("--text-dim"), fontFamily: MONO },
      splitLine: { lineStyle: { color: css("--chart-grid") } },
      scale: true,
      ...opts,
    };
  }

  // Two independent y-axes autoscale separately, so a dual-axis panel's two
  // zero baselines land on different pixel rows and a reader misjudges the
  // sign of the right-axis series against the left-axis bars. Return matched
  // {min,max,interval} for each axis: nice steps AND an equal number of
  // intervals above and below zero, so zero sits at one shared fraction of
  // the plot height on both. Pass each axis's data values.
  function dualZeroAlign(dataA, dataB, targetTicks = 4) {
    const niceStep = (rough) => {
      if (!(rough > 0)) return 1;
      const p = Math.pow(10, Math.floor(Math.log10(rough)));
      const f = rough / p;
      return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
    };
    const ext = (d) => ({ pos: Math.max(0, ...d), neg: -Math.min(0, ...d) });
    const a = ext(dataA), b = ext(dataB);
    const stepA = niceStep(Math.max(a.pos, a.neg) / targetTicks);
    const stepB = niceStep(Math.max(b.pos, b.neg) / targetTicks);
    const nUp = Math.max(Math.ceil(a.pos / stepA), Math.ceil(b.pos / stepB), 1);
    const nDn = Math.max(Math.ceil(a.neg / stepA), Math.ceil(b.neg / stepB), 1);
    return [
      { min: -nDn * stepA, max: nUp * stepA, interval: stepA },
      { min: -nDn * stepB, max: nUp * stepB, interval: stepB },
    ];
  }

  function line(name, t, v, colour, opts = {}) {
    return {
      name, type: "line", showSymbol: false, sampling: "lttb",
      data: t.map((x, i) => [x, v[i]]),
      lineStyle: { width: 1.4, color: colour },
      itemStyle: { color: colour },
      connectNulls: false,
      ...opts,
    };
  }

  const zoom = (start = 0) => [
    { type: "inside", start, end: 100 },
    { type: "slider", start, end: 100, height: 16, bottom: 6,
      borderColor: css("--border"), fillerColor: "rgba(128,128,160,0.15)",
      handleStyle: { color: css("--text-dim") },
      textStyle: { color: css("--text-dim"), fontSize: 10 } },
  ];

  /* Shared horizontal legend — single row that SCROLLS (paged arrows)
     rather than wrapping. Long series labels ("Wind (transmission)",
     "GB price (MID)", "NSL (NO) flow (+import)") used to wrap to 2-3 rows
     at phone width and spill over the plot and the y-axis name; a scroll
     legend keeps them on one row at every width. This is the default for
     every top-anchored legend; pass extra keys (`data`, `selectedMode`,
     `itemGap`, `padding`) to specialise. The vertical donut legend and the
     merit swatch legends opt out by not calling this. */
  function legendBar(extra = {}) {
    return { type: "scroll", top: 0,
             textStyle: { color: css("--text-dim") }, ...extra };
  }

  /* -------------------- panel renderers -------------------- */

  function overviewMain() {
    const { fromTs, toTs } = State.window();
    const sec = State.bucketSeconds();
    const price = Data.aggregate("price", fromTs, toTs, sec);
    const demand = Data.aggregate("demand", fromTs, toTs, sec);
    const ren = Data.aggregate("renewables", fromTs, toTs, sec);
    chart("ch-overview-main").setOption(base({
      legend: legendBar(),
      grid: { left: 52, right: 56, top: 48, bottom: 56 },
      xAxis: timeAxis(),
      yAxis: [valueAxis(`${CUR()}/MWh`), valueAxis("GW", { position: "right",
        splitLine: { show: false } })],
      dataZoom: zoom(),
      series: [
        line(PRICE_NAME(), price.t, price.v, css("--accent"),
          { yAxisIndex: 0, lineStyle: { width: 1.7, color: css("--accent") } }),
        line("Demand", demand.t, demand.v.map(GW), "#7d8ea3", { yAxisIndex: 1 }),
        line("Wind + solar", ren.t, ren.v.map(GW), Data.FUELS.WIND.colour,
          { yAxisIndex: 1, areaStyle: { opacity: 0.12 } }),
      ],
    }), true);
  }

  function overviewDonut() {
    const { fromTs, toTs } = State.window();
    const [lo, hi] = Data.hhRange(fromTs, toTs);
    const mean = (col) => {
      let s = 0, n = 0;
      for (let i = lo; i < hi; i++) {
        if (col[i] != null) { s += col[i]; n++; }
      }
      return n ? s / n : 0;
    };
    const rows = Data.STACK_ORDER
      .filter((k) => Data.hh[k])
      .map((k) => ({ name: Data.FUELS[k].label, value: +mean(Data.hh[k]).toFixed(0),
                     itemStyle: { color: Data.FUELS[k].colour } }))
      .filter((r) => r.value > 10);
    const imports = mean(Data.hh.netImports);
    if (imports > 10) rows.push({ name: "Net imports", value: +imports.toFixed(0),
      itemStyle: { color: "#64748b" } });
    chart("ch-overview-donut").setOption(base({
      tooltip: { trigger: "item", backgroundColor: css("--bg-raised"),
        borderColor: css("--border"), textStyle: { color: css("--text") },
        valueFormatter: (v) => `${(v / 1000).toFixed(1)} GW avg` },
      legend: { type: "scroll", orient: "vertical", right: 0, top: "middle",
        textStyle: { color: css("--text-dim"), fontSize: 11 } },
      series: [{
        type: "pie", radius: ["48%", "74%"], center: ["38%", "50%"],
        label: { show: false }, data: rows,
        itemStyle: { borderColor: css("--bg-card"), borderWidth: 1.5 },
      }],
    }), true);
  }

  function overviewResidual() {
    // GB-only: residual = INDO − transmission wind is a GB-specific
    // definition (ENTSO-E zones report load and wind on different bases —
    // see plan/04). Hide the card rather than plotting a mislabelled series.
    const card = document.getElementById("ch-overview-residual")
      .closest(".card");
    const away = State.get().zone !== "GB";
    card.classList.toggle("hidden", away);
    if (away) return;
    const { fromTs, toTs } = State.window();
    const sec = State.bucketSeconds();
    const demand = Data.aggregate("demand", fromTs, toTs, sec);
    // residual = INDO − transmission wind. INDO is already net of ALL
    // embedded generation (solar and embedded wind), so subtracting
    // PV_Live solar here would double-count it.
    const wind = Data.aggregate("WIND", fromTs, toTs, sec);
    const residual = demand.v.map((d, i) =>
      d == null || wind.v[i] == null ? null : GW(d - wind.v[i]));
    chart("ch-overview-residual").setOption(base({
      legend: legendBar(),
      xAxis: timeAxis(),
      yAxis: valueAxis("GW"),
      series: [
        line("Demand", demand.t, demand.v.map(GW), "#7d8ea3"),
        line("Residual load", demand.t, residual, "#e8b64f",
          { areaStyle: { opacity: 0.15 } }),
      ],
    }), true);
  }

  function priceMain() {
    const st = State.get();
    const { fromTs, toTs, fromIso, toIso } = State.window();
    const sec = State.bucketSeconds();
    const price = Data.aggregate("price", fromTs, toTs, sec);
    const series = [
      line(PRICE_NAME(), price.t, price.v, css("--accent"),
        { lineStyle: { width: 1.7, color: css("--accent") } }),
    ];
    const yAxes = [valueAxis(`${CUR()}/MWh`),
      valueAxis("GW", { position: "right", splitLine: { show: false } })];
    if (st.overlays.gas || st.overlays.carbon) {
      const d = Data.dailySlice(fromIso, toIso,
        ["gas_sap", "carbon_uka_month", "carbon_ffill"]);
      const ts = d.d.map((day) => Date.parse(day + "T12:00Z"));
      if (st.overlays.gas)
        series.push(line("Gas SAP (£/MWh th)", ts, d.gas_sap, "#ffa94d",
          { step: "middle" }));
      if (st.overlays.carbon)
        series.push(line("Carbon UKA (£/tCO2, monthly)", ts,
          d.carbon_uka_month, "#b0bec5", { step: "middle",
            lineStyle: { width: 1.4, color: "#b0bec5", type: "dashed" } }));
    }
    if (st.overlays.demand) {
      const demand = Data.aggregate("demand", fromTs, toTs, sec);
      series.push(line("Demand (GW)", demand.t, demand.v.map(GW), "#7d8ea3",
        { yAxisIndex: 1 }));
    }
    if (st.overlays.renewables) {
      const ren = Data.aggregate("renewables", fromTs, toTs, sec);
      series.push(line("Wind + solar (GW)", ren.t, ren.v.map(GW), Data.FUELS.WIND.colour,
        { yAxisIndex: 1 }));
    }
    chart("ch-price-main").setOption(base({
      legend: legendBar(),
      grid: { left: 52, right: 56, top: 48, bottom: 56 },
      xAxis: timeAxis(), yAxis: yAxes, dataZoom: zoom(), series,
    }), true);
  }

  function priceHist() {
    const { fromTs, toTs } = State.window();
    const [lo, hi] = Data.hhRange(fromTs, toTs);
    const values = Data.hh.price.slice(lo, hi);
    const bins = Metrics.histogram(values, 10);
    chart("ch-price-hist").setOption(base({
      tooltip: { trigger: "axis", backgroundColor: css("--bg-raised"),
        borderColor: css("--border"), textStyle: { color: css("--text") },
        valueFormatter: (v) => v + "% of half-hours" },
      xAxis: { type: "category",
        data: bins.map((b) => `${CUR()}${b.bin}`),
        axisLabel: { color: css("--text-dim") },
        axisLine: { lineStyle: { color: css("--border") } } },
      yAxis: valueAxis("% of periods"),
      series: [{ type: "bar", data: bins.map((b) => b.share),
        itemStyle: { color: css("--accent"), opacity: 0.75 } }],
    }), true);
  }

  function priceShape() {
    const { fromTs, toTs } = State.window();
    const [lo, hi] = Data.hhRange(fromTs, toTs);
    const shape = Metrics.intradayShape(
      Data.hh.t.slice(lo, hi).map((s) => s * 1000),
      Data.hh.price.slice(lo, hi));
    const labels = shape.map((s) =>
      `${String(Math.floor(s.slot / 2)).padStart(2, "0")}:${s.slot % 2 ? "30" : "00"}`);
    chart("ch-price-shape").setOption(base({
      legend: legendBar({ data: ["Mean", "p25–p75"] }),
      xAxis: { type: "category", data: labels,
        axisLabel: { color: css("--text-dim"), interval: 7 },
        axisLine: { lineStyle: { color: css("--border") } } },
      yAxis: valueAxis(`${CUR()}/MWh`),
      series: [
        // stackStrategy "all": the band is p25 + a stacked (p75 - p25)
        // delta. GB prices go negative (high wind, low demand), so p25 can
        // be < 0; the default "samesign" stacking would then reset the
        // positive delta to a zero base and mis-draw the band. See the same
        // guard on the BESS unit-spread band.
        { name: "p25–p75", type: "line", stack: "iqr", stackStrategy: "all",
          showSymbol: false,
          data: shape.map((s) => s.p25), lineStyle: { opacity: 0 },
          itemStyle: { color: "#888" } },
        { name: "p25–p75 ", type: "line", stack: "iqr", stackStrategy: "all",
          showSymbol: false,
          data: shape.map((s) => s.p75 == null ? null : +(s.p75 - s.p25).toFixed(2)),
          lineStyle: { opacity: 0 },
          areaStyle: { color: css("--accent"), opacity: 0.14 },
          itemStyle: { color: "#888" }, tooltip: { show: false } },
        { name: "Mean", type: "line", showSymbol: false,
          data: shape.map((s) => s.mean),
          lineStyle: { width: 1.8, color: css("--accent") },
          itemStyle: { color: css("--accent") } },
      ],
    }), true);
  }

  /* Price vs net load: observed price against derived system tightness.
     Net load = demand(INDO) − wind(transmission). INDO is already net of
     all embedded generation (incl. PV_Live solar), so solar is NOT
     subtracted again — it is carried only as tooltip context. */
  function priceNetLoad() {
    // GB-only: net load = INDO − transmission wind is a GB-specific
    // definition (see plan/04) — hide rather than plot a mislabelled
    // series for ENTSO-E zones, matching the residual-load card.
    const card = document.getElementById("ch-price-netload").closest(".card");
    const away = State.get().zone !== "GB";
    card.classList.toggle("hidden", away);
    if (away) return;
    const st = State.get();
    const { fromTs, toTs } = State.window();
    const [lo, hi] = Data.hhRange(fromTs, toTs);
    const pts = [];
    const step = Math.max(1, Math.floor((hi - lo) / 4000));
    for (let i = lo; i < hi; i += step) {
      const d = Data.hh.demand[i], p = Data.hh.price[i];
      if (d == null || p == null) continue;
      const w = Data.hh.WIND ? (Data.hh.WIND[i] ?? 0) : 0;
      const s = Data.hh.solar[i] ?? 0;
      pts.push([+((d - w) / 1000).toFixed(2), p, Data.hh.t[i] * 1000,
                +(d / 1000).toFixed(2), +(w / 1000).toFixed(2),
                +(s / 1000).toFixed(2)]);
    }
    const r = Metrics.pearson(pts.map((q) => q[0]), pts.map((q) => q[1]));
    const series = [{
      name: "Half-hours", type: "scatter", symbolSize: 3.5, data: pts,
      itemStyle: { color: css("--accent"), opacity: 0.3 },
    }];
    if (st.nlBinned) {
      const bins = Metrics.binnedMedian(
        pts.map((q) => q[0]), pts.map((q) => q[1]), 2, 12);
      series.push({ name: "Median per 2 GW bin", type: "line",
        data: bins.map((b) => [b.x, b.median]),
        symbol: "circle", symbolSize: 6,
        lineStyle: { width: 2.2, color: "#e8b64f" },
        itemStyle: { color: "#e8b64f" }, z: 5 });
    }
    chart("ch-price-netload").setOption(base({
      title: { text: r == null ? "" : `Pearson r = ${r.toFixed(2)}`,
        right: 10, top: 0,
        textStyle: { color: css("--text-dim"), fontSize: 11, fontWeight: 400 } },
      legend: legendBar({ data: series.map((s) => s.name) }),
      tooltip: { trigger: "item", backgroundColor: css("--bg-raised"),
        borderColor: css("--border"),
        textStyle: { color: css("--text"), fontSize: 12 }, confine: true,
        formatter: (p) => {
          const v = p.value;
          if (p.seriesType === "line")
            return `Net load ${v[0]} GW<br>Median price ${CUR()}${v[1]}/MWh`;
          return `<b>${Metrics.fmtDate(v[2], "datetime")}</b><br>` +
            `Price ${CUR()}${v[1]}/MWh (observed)<br>` +
            `Demand ${v[3]} GW · Wind ${v[4]} GW<br>` +
            `Solar ${v[5]} GW (embedded — already netted off demand)<br>` +
            `Net load ${v[0]} GW = demand − wind (derived)`;
        } },
      xAxis: valueAxis("Net load (GW)",
        { nameLocation: "middle", nameGap: 28 }),
      yAxis: valueAxis(`${CUR()}/MWh`),
      series,
    }), true);
  }

  function genStack() {
    const st = State.get();
    const { fromTs, toTs } = State.window();
    const sec = State.bucketSeconds();
    const cols = {};
    let axisT = null;
    Data.STACK_ORDER.filter((k) => Data.hh[k]).forEach((k) => {
      const agg = Data.aggregate(k, fromTs, toTs, sec);
      cols[k] = agg.v;
      axisT = agg.t;
    });
    if (st.genImports) {
      cols.netImports = Data.aggregate("netImports", fromTs, toTs, sec).v
        .map((v) => (v == null ? null : Math.max(v, 0)));
    }
    if (st.genPercent) {
      const totals = axisT.map((_, i) =>
        Object.values(cols).reduce((s, col) => s + Math.max(col[i] ?? 0, 0), 0));
      Object.keys(cols).forEach((k) => {
        cols[k] = cols[k].map((v, i) =>
          v == null || totals[i] === 0 ? null : +(100 * Math.max(v, 0) / totals[i]).toFixed(2));
      });
    }
    const toVal = st.genPercent ? (v) => v : GW;
    const series = Object.keys(cols).map((k) => {
      const conf = k === "netImports"
        ? { label: "Net imports", colour: "#64748b" } : Data.FUELS[k];
      return {
        name: conf.label, type: "line", stack: "gen", showSymbol: false,
        sampling: "lttb",
        data: axisT.map((x, i) => [x, toVal(cols[k][i])]),
        lineStyle: { width: 0 },
        areaStyle: { color: conf.colour, opacity: 0.85 },
        itemStyle: { color: conf.colour },
        emphasis: { focus: "series" },
      };
    });
    if (st.genDemandLine && !st.genPercent) {
      const demand = Data.aggregate("demand", fromTs, toTs, sec);
      series.push(line(State.get().zone === "GB"
        ? "Demand (INDO)" : "Demand (ENTSO-E load)",
        demand.t, demand.v.map(GW),
        css("--text"), { lineStyle: { width: 1.3, color: css("--text"),
          type: "dashed" } }));
    }
    chart("ch-gen-stack").setOption(base({
      legend: legendBar(),
      grid: { left: 52, right: 24, top: 48, bottom: 56 },
      xAxis: timeAxis(),
      yAxis: valueAxis(st.genPercent ? "%" : "GW",
        st.genPercent ? { max: 100, min: 0 } : {}),
      dataZoom: zoom(), series,
    }), true);
  }

  function genLowCarbon() {
    const { fromTs, toTs } = State.window();
    const sec = Math.max(State.bucketSeconds(), 3600);
    let axisT = null;
    const lowCols = Data.LOW_CARBON.filter((k) => Data.hh[k]).map((k) => {
      const agg = Data.aggregate(k, fromTs, toTs, sec);
      axisT = agg.t;
      return agg.v;
    });
    const allCols = [...Data.STACK_ORDER.filter((k) => Data.hh[k]).map((k) =>
      Data.aggregate(k, fromTs, toTs, sec).v),
      Data.aggregate("netImports", fromTs, toTs, sec).v.map(
        (v) => (v == null ? null : Math.max(v, 0)))];
    const share = axisT.map((_, i) => {
      const low = lowCols.reduce((s, c) => s + Math.max(c[i] ?? 0, 0), 0);
      const total = allCols.reduce((s, c) => s + Math.max(c[i] ?? 0, 0), 0);
      return total > 0 ? +(100 * low / total).toFixed(1) : null;
    });
    const renderLC = (extraSeries) => chart("ch-gen-lowcarbon").setOption(base({
      // Two long legend labels (headline + import-aware variant): the shared
      // scroll legend keeps them on one row at every width, so no extra grid
      // headroom is needed beyond the standard single-row band.
      legend: legendBar({ itemGap: 16, padding: [2, 8] }),
      grid: { left: 52, right: 56, top: 48, bottom: 42 },
      xAxis: timeAxis(),
      yAxis: valueAxis("%", { min: 0, max: 100 }),
      series: [
        line("Low-carbon share (GB gen; imports dilute)", axisT, share,
          "#5ad6a4", { areaStyle: { opacity: 0.15 } }),
        ...extraSeries,
      ],
    }), true);
    renderLC([]);

    // Import-aware variant — GB only, and only where counterparty zone
    // data exists (append-only, accumulating). Cable imports are attributed at the
    // exporting zone's own low-carbon fraction at that half-hour
    // (counterparty-mix, first-order — NOT flow tracing); cables whose
    // zone data is missing at a timestamp fall back to denominator-only,
    // exactly the headline metric's treatment. No backfill: the line is
    // simply absent before the zone window.
    if (State.get().zone !== "GB") return;
    const lcSeq = ++lcRenderSeq;
    const cables = Object.keys(Data.CABLE_ZONE).filter((c) => Data.hh[c]);
    const zones = [...new Set(cables.map((c) => Data.CABLE_ZONE[c]))];
    Promise.all(zones.map((z) =>
      Data.loadZoneContext(z).catch(() => null))).then((loaded) => {
      if (lcSeq !== lcRenderSeq) return; // superseded by a newer render
      const ctx = {};
      zones.forEach((z, i) => { if (loaded[i]) ctx[z] = loaded[i]; });
      if (!Object.keys(ctx).length) return;

      const hh = Data.hh;
      const lowKeys = Data.LOW_CARBON.filter((k) => hh[k]);
      const genKeys = Data.STACK_ORDER.filter((k) => hh[k]);
      const zoneFrac = (z, ts) => {
        const c = ctx[z];
        if (!c) return null;
        const i = c.index.get(ts);
        if (i == null) return null;
        let low = 0, tot = 0;
        Data.STACK_ORDER.forEach((k) => {
          const v = c.hh[k] ? c.hh[k][i] : null;
          if (v != null && v > 0) {
            tot += v;
            if (Data.LOW_CARBON.includes(k)) low += v;
          }
        });
        return tot > 0 ? low / tot : null;
      };

      const num = new Array(hh.t.length).fill(null);
      const den = new Array(hh.t.length).fill(null);
      const ctxStart = Math.min(...Object.values(ctx).map((c) => c.hh.t[0]));
      for (let i = 0; i < hh.t.length; i++) {
        const ts = hh.t[i];
        if (ts < ctxStart) continue; // no backfill beyond zone history
        let gbLow = 0, gbTot = 0;
        genKeys.forEach((k) => {
          const v = hh[k][i];
          if (v != null && v > 0) {
            gbTot += v;
            if (lowKeys.includes(k)) gbLow += v;
          }
        });
        if (gbTot === 0) continue;
        let n = gbLow, d = gbTot;
        cables.forEach((c) => {
          const flow = hh[c][i];
          if (flow == null || flow <= 0) return; // exports excluded
          d += flow;
          const frac = zoneFrac(Data.CABLE_ZONE[c], ts);
          if (frac != null) n += flow * frac; // else denominator-only
        });
        num[i] = n; den[i] = d;
      }
      const { fromTs, toTs } = State.window();
      const sec2 = Math.max(State.bucketSeconds(), 3600);
      const aggN = Data.aggregateArrays(hh.t, num, fromTs, toTs, sec2);
      const aggD = Data.aggregateArrays(hh.t, den, fromTs, toTs, sec2);
      const ia = aggN.v.map((v, k) => (v == null || !aggD.v[k]
        ? null : +((100 * v) / aggD.v[k]).toFixed(1)));
      renderLC([line("Import-aware (counterparty mix)", aggN.t, ia,
        "#8ab4f8", { lineStyle: { width: 1.4, type: "dashed",
                                  color: "#8ab4f8" } })]);
    });
  }
  let lcRenderSeq = 0;

  function genRenewables() {
    const { fromTs, toTs } = State.window();
    const sec = State.bucketSeconds();
    const wind = Data.aggregate("WIND", fromTs, toTs, sec);
    const solar = Data.aggregate("solar", fromTs, toTs, sec);
    // Faint horizontal band spanning the window's raw half-hourly demand
    // range — scale context for how much of demand the renewables cover.
    const [lo, hi] = Data.hhRange(fromTs, toTs);
    let dMin = Infinity, dMax = -Infinity;
    for (let i = lo; i < hi; i++) {
      const v = Data.hh.demand[i];
      if (v != null) {
        if (v < dMin) dMin = v;
        if (v > dMax) dMax = v;
      }
    }
    const hasDemand = dMax > dMin;
    chart("ch-gen-renewables").setOption(base({
      legend: legendBar(),
      xAxis: timeAxis(),
      // markArea does not stretch the axis on its own — lift the max so the
      // top of the demand band stays visible.
      yAxis: valueAxis("GW", hasDemand
        ? { max: (extent) => Math.ceil(Math.max(extent.max, GW(dMax)) + 1) }
        : {}),
      series: [
        { ...line(State.get().zone === "GB"
            ? "Wind (transmission)" : "Wind (ENTSO-E, on+offshore)",
            wind.t, wind.v.map(GW), Data.FUELS.WIND.colour,
            { areaStyle: { opacity: 0.12 } }),
          ...(hasDemand ? { markArea: {
            silent: true,
            itemStyle: { color: css("--text-dim"), opacity: 0.07 },
            data: [[
              { yAxis: GW(dMin),
                label: { show: true, position: "insideTopRight",
                  color: css("--text-dim"), fontSize: 10,
                  formatter: `Demand range ${GW(dMin).toFixed(1)}–`
                    + `${GW(dMax).toFixed(1)} GW` } },
              { yAxis: GW(dMax) },
            ]],
          } } : {}) },
        // hasSignal drops constant-zero TSO placeholders (IE solar) — a
        // flat zero line would read as "no sun", which is not what the
        // data says; the Methodology data-quality note explains.
        ...(Data.hasSignal("solar") ? [line(State.get().zone === "GB"
            ? "Solar (PV_Live)" : "Solar (ENTSO-E)",
            solar.t, solar.v.map(GW), Data.FUELS.solar.colour,
          { areaStyle: { opacity: 0.12 } })] : []),
      ],
    }), true);
  }

  /* Assumptions with the effective coal price (manual entry overrides the
     futures-derived proxy) injected for the merit panels. */
  function assumptionsWithCoal() {
    const a = State.get().assumptions;
    const coal = State.coalInfo();
    return { ...a, coalPrice: coal ? coal.value : null,
             coalSource: coal ? coal.source : null };
  }

  /* Observed dispatch by unit (beta), drawn as a dispatch curve so it can
     be read side by side with the modelled merit-order curve above:
     x = cumulative notified output (GW, Observed PN levels), y = the unit's
     technology-cluster SRMC midpoint (Estimated — no unit-level costs exist
     in free data), units sorted ascending by cluster cost. Units with no
     SRMC benchmark (unclassified, pumped storage, oil, other) are counted
     in the caption but not plotted; charging/pumping and interconnector
     units are excluded upstream. Data: app/data/bmu_snapshot.json, written
     by etl/build_bmu_snapshot.py. */
  function meritBmu() {
    const empty = document.getElementById("bmu-empty");
    const metaLine = document.getElementById("bmu-meta");
    const snap = Data.bmu;
    const bail = (message) => {
      empty.textContent = message;
      empty.classList.remove("hidden");
      if (metaLine) metaLine.textContent = "";
      const existing = registry.get("ch-merit-bmu");
      if (existing) existing.clear();
    };
    if (!snap) {
      bail("No dispatch snapshot available — run python " +
           "etl/build_bmu_snapshot.py to fetch the latest settlement period.");
      return;
    }

    // Cluster SRMC ranges from the shared cost model; without them there is
    // no y-axis, so the panel states that rather than inventing costs.
    let byKey = null;
    try {
      const rows = Metrics.meritLadder(Data.latestDaily("gas_sap").value,
        Data.latestDaily("carbon_uka_month").value, assumptionsWithCoal());
      byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    } catch {
      bail("Cost-model inputs unavailable — the dispatch curve needs the " +
           "cluster SRMC ranges for its price axis.");
      return;
    }
    empty.classList.add("hidden");

    const mid = (r) => +((r.low + r.high) / 2).toFixed(2);
    const running = snap.units.filter((u) => u.mw > 0);
    const costed = running.filter((u) => u.fuel && byKey[u.fuel]);
    const uncosted = running.filter((u) => !(u.fuel && byKey[u.fuel]));

    // Ascending by cluster SRMC midpoint; biggest units first within a
    // cluster (a display convention only — no unit-level cost data).
    costed.sort((a, b) => mid(byKey[a.fuel]) - mid(byKey[b.fuel])
      || b.mw - a.mw);
    let cum = 0;
    const items = costed.map((u) => {
      const r = byKey[u.fuel];
      const x0 = +cum.toFixed(3);
      cum += u.mw / 1000;
      return { u, r, x0, x1: +cum.toFixed(3), y: mid(r) };
    });

    const uncostedGw = uncosted.reduce((s, u) => s + u.mw, 0) / 1000;
    if (metaLine) {
      const share = snap.coverage && snap.coverage.mw_classified_share;
      metaLine.textContent =
        `SP${snap.settlement_period}, ` +
        `${Metrics.fmtDate(snap.settlement_date, "day")} · ` +
        `${items.length} units plotted, ${cum.toFixed(1)} GW · ` +
        `${uncosted.length} units (${uncostedGw.toFixed(1)} GW) without an ` +
        "SRMC benchmark not plotted (unclassified, pumped storage, oil, " +
        `other) · ${Math.round((share ?? 0) * 100)}% of notified MW ` +
        "classified to a fuel type";
    }

    const colour = (fuel) => (Data.FUELS[fuel] || {}).colour || "#8a93a6";
    const legendLabels = [];
    items.forEach(({ u }) => {
      const label = Data.FUELS[u.fuel].label;
      if (!legendLabels.includes(label)) legendLabels.push(label);
    });

    const price = Data.latest("price");
    const demand = Data.latest("demand");
    const net = Data.latest("netImports");
    const targetGw = demand
      ? (demand.value - (net ? net.value : 0)) / 1000 : null;
    const markLines = [];
    if (targetGw != null) {
      markLines.push({ xAxis: +targetGw.toFixed(2),
        lineStyle: { color: css("--text"), width: 1.4, type: "dashed" },
        label: { color: css("--text"), fontSize: 11, distance: 10,
          formatter: `Demand − net imports ${targetGw.toFixed(1)} GW` } });
    }
    if (price) {
      markLines.push({ yAxis: price.value,
        lineStyle: { color: css("--accent"), width: 1.2, type: "dotted" },
        label: { color: css("--accent"), fontSize: 11,
          position: "insideStartTop",
          formatter: `Observed price £${price.value.toFixed(0)}` } });
    }

    chart("ch-merit-bmu").setOption(base({
      legend: legendBar({ data: legendLabels, selectedMode: false,
        itemGap: 14, padding: [2, 8] }),
      grid: { left: 52, right: 30, top: 64, bottom: 48 },
      tooltip: { trigger: "item", backgroundColor: css("--bg-raised"),
        borderColor: css("--border"), confine: true,
        textStyle: { color: css("--text"), fontSize: 12 },
        formatter: (p) => {
          const it = items[p.dataIndex];
          if (!it) return "";
          const { u, r } = it;
          const acc = (snap.acceptances_by_fuel || {})[u.fuel];
          let html = `<b>${u.name || u.id}</b>` +
            (u.name && u.name !== u.id
              ? `<br><span style="opacity:.6">${u.id}</span>` : "") +
            `<br>${Data.FUELS[u.fuel].label} — notified ` +
            `${u.mw.toLocaleString("en-GB")} MW <i>(Observed PN)</i>`;
          if (u.capacity_mw > 0)
            html += `<br>Registered capacity ` +
              `${Math.round(u.capacity_mw)} MW ` +
              `(${Math.round((u.mw / u.capacity_mw) * 100)}% loaded)`;
          html += `<br>Cluster SRMC £${r.low}–£${r.high}/MWh, ` +
            `plotted at midpoint £${it.y} <i>(Estimated)</i>`;
          if (acc)
            html += `<br>${acc} BOALF acceptance${acc === 1 ? "" : "s"} ` +
              `this period across the ${Data.FUELS[u.fuel].label} fleet`;
          return html;
        } },
      xAxis: valueAxis("Cumulative notified output (GW)",
        { min: 0, scale: false, nameLocation: "middle", nameGap: 28 }),
      yAxis: valueAxis("£/MWh", { min: 0, scale: false }),
      series: [
        // empty per-technology series so the legend shows colour swatches
        ...legendLabels.map((label) => {
          const it = items.find((q) => Data.FUELS[q.u.fuel].label === label);
          return { name: label, type: "line", data: [],
            itemStyle: { color: colour(it.u.fuel) },
            lineStyle: { color: colour(it.u.fuel) } };
        }),
        {
          type: "custom",
          renderItem: (params, api) => {
            const it = items[params.dataIndex];
            const topLeft = api.coord([it.x0, it.y]);
            const bottomRight = api.coord([it.x1, 0]);
            return { type: "rect",
              shape: { x: topLeft[0], y: topLeft[1],
                width: Math.max(bottomRight[0] - topLeft[0], 0.8) + 0.4,
                height: bottomRight[1] - topLeft[1] },
              style: { fill: colour(it.u.fuel), opacity: 0.9 } };
          },
          data: items.map((it) => ({ value: [it.x0, it.x1, it.y] })),
          encode: { x: [0, 1], y: [2] },
          markLine: { symbol: "none", silent: true, data: markLines },
          z: 3,
        },
      ],
    }), true);
  }

  /* Merit-order curve: cumulative available capacity vs estimated SRMC.
     Cost model shared with the dispatch tooltips (Metrics.meritLadder);
     capacity is a
     transparent proxy — p98 of observed output for dispatchables, latest
     observed output for must-run wind/solar. Everything here is Estimated. */
  function meritCurve() {
    const a = assumptionsWithCoal();
    const gas = Data.latestDaily("gas_sap");
    const carbonRow = Data.latestDaily("carbon_uka_month");
    const price = Data.latest("price");
    const rows = Metrics.meritLadder(gas.value, carbonRow.value, a);

    // Capacity proxy shared with the CSV export (Data.meritCapacityGw)
    // so the downloaded tranches cannot disagree with the plotted curve.
    const cap = Data.meritCapacityGw();

    const steps = Metrics.meritCurveSteps(rows, cap);
    const demand = Data.latest("demand");
    const net = Data.latest("netImports");
    const targetGw = (demand.value - (net ? net.value : 0)) / 1000;
    const clearing = Metrics.curveClearing(steps, targetGw);

    const colour = (t) => (Data.FUELS[t.key] || {}).colour || "#888";
    const capBasis = (t) => t.key === "WIND" || t.key === "solar"
      ? "latest observed output (must-run)"
      : "p98 of observed output over the dataset";
    // legend in dispatch order (first appearance along the curve)
    const legendLabels = [];
    steps.forEach((t) => {
      if (!legendLabels.includes(t.label)) legendLabels.push(t.label);
    });

    const markLines = [
      { xAxis: +targetGw.toFixed(2),
        lineStyle: { color: css("--text"), width: 1.4, type: "dashed" },
        label: { color: css("--text"), fontSize: 11, distance: 10,
          formatter: `Demand − net imports ${targetGw.toFixed(1)} GW` } },
      { yAxis: price.value,
        lineStyle: { color: css("--accent"), width: 1.2, type: "dotted" },
        label: { color: css("--accent"), fontSize: 11,
          position: "insideStartTop",
          formatter: `Observed price £${price.value.toFixed(0)}` } },
    ];
    if (clearing) {
      markLines.push({ yAxis: clearing.price,
        lineStyle: { color: "#e8b64f", width: 1.2 },
        label: { color: "#e8b64f", fontSize: 11,
          position: "insideStartBottom",
          formatter: `Implied clearing ≈ £${clearing.price} (${clearing.tranche.label})` } });
    }

    chart("ch-merit-curve").setOption(base({
      legend: legendBar({ data: legendLabels, selectedMode: false }),
      grid: { left: 52, right: 30, top: 64, bottom: 48 },
      tooltip: { trigger: "item", backgroundColor: css("--bg-raised"),
        borderColor: css("--border"),
        textStyle: { color: css("--text"), fontSize: 12 }, confine: true,
        formatter: (p) => {
          const t = p.data && p.data.t;
          if (!t) return "";
          const thermal = ["CCGT", "OCGT", "COAL"].includes(t.key);
          return `<b>${t.label}</b> — tranche ${t.x0}–${t.x1} GW<br>` +
            `Estimated SRMC £${t.srmc}/MWh ` +
            `<span style="opacity:.7">(technology range £${t.low}–£${t.high})</span><br>` +
            `Technology capacity ${t.techCapacityGw} GW — ${capBasis(t)}<br>` +
            (thermal
              ? `Fuel input: ${t.key === "COAL"
                  ? `coal £${(a.coalPrice ?? 0).toFixed(1)}/MWh th (${a.coalSource})`
                  : `gas SAP £${gas.value.toFixed(1)}/MWh th (observed)`}<br>` +
                `Carbon input: UKA £${carbonRow.value.toFixed(1)}/tCO2<br>`
              : "") +
            `<span style="opacity:.7">${t.note}</span>`;
        } },
      xAxis: valueAxis("Cumulative available capacity (GW)",
        { min: 0, scale: false, nameLocation: "middle", nameGap: 28 }),
      yAxis: valueAxis("£/MWh", { min: 0, scale: false }),
      series: [
        // empty per-technology series so the legend shows colour swatches
        ...legendLabels.map((label) => {
          const t = steps.find((q) => q.label === label);
          return { name: label, type: "line", data: [],
            itemStyle: { color: colour(t) },
            lineStyle: { color: colour(t) } };
        }),
        {
          type: "custom",
          renderItem: (params, api) => {
            const t = steps[params.dataIndex];
            const topLeft = api.coord([t.x0, t.srmc]);
            const bottomRight = api.coord([t.x1, 0]);
            return { type: "rect",
              shape: { x: topLeft[0], y: topLeft[1],
                width: Math.max(bottomRight[0] - topLeft[0], 1) + 0.5,
                height: bottomRight[1] - topLeft[1] },
              style: { fill: colour(t), opacity: t.assumed ? 0.6 : 0.9 } };
          },
          data: steps.map((t) => ({ value: [t.x0, t.x1, t.srmc], t })),
          encode: { x: [0, 1], y: [2] },
          markLine: { symbol: "none", silent: true, data: markLines },
          z: 3,
        },
      ],
    }), true);
  }

  function meritTime() {
    const a = State.get().assumptions;
    const { fromIso, toIso } = State.window();
    const d = Data.dailySlice(fromIso, toIso,
      ["price", "gas_sap", "carbon_uka_month"]);
    const ts = d.d.map((day) => Date.parse(day + "T12:00Z"));
    const low = Metrics.ccgtSrmc(d.gas_sap, d.carbon_uka_month,
      a.etaCcgtHigh, a.efGas, a.vom);
    const high = Metrics.ccgtSrmc(d.gas_sap, d.carbon_uka_month,
      a.etaCcgtLow, a.efGas, a.vom);
    chart("ch-merit-time").setOption(baseDay({
      legend: legendBar({ data: ["CCGT SRMC range", "Daily avg price"] }),
      xAxis: timeAxis(), yAxis: valueAxis("£/MWh"), dataZoom: zoom(),
      grid: { left: 52, right: 24, top: 48, bottom: 56 },
      series: [
        { name: "CCGT SRMC range", type: "line", stack: "band",
          showSymbol: false, data: ts.map((x, i) => [x, low[i]]),
          lineStyle: { opacity: 0 }, itemStyle: { color: "#e4573d" } },
        { name: "CCGT SRMC range ", type: "line", stack: "band",
          showSymbol: false,
          data: ts.map((x, i) => [x,
            low[i] == null || high[i] == null ? null
              : +(high[i] - low[i]).toFixed(2)]),
          lineStyle: { opacity: 0 },
          areaStyle: { color: "#e4573d", opacity: 0.25 },
          itemStyle: { color: "#e4573d" }, tooltip: { show: false } },
        line("Daily avg price", ts, d.price, css("--accent"),
          { lineStyle: { width: 1.7, color: css("--accent") } }),
      ],
    }), true);
  }

  function spreadSpark() {
    const a = State.get().assumptions;
    const { fromIso, toIso } = State.window();
    const d = Data.dailySlice(fromIso, toIso,
      ["price", "gas_sap", "carbon_uka_month", "carbon_ffill"]);
    const ts = d.d.map((day) => Date.parse(day + "T12:00Z"));
    const spark = Metrics.cleanSparkSpread(d.price, d.gas_sap,
      d.carbon_uka_month, { eta: a.eta, efGas: a.efGas, vom: a.vom });
    chart("ch-spread-spark").setOption(baseDay({
      legend: legendBar(),
      grid: { left: 52, right: 24, top: 48, bottom: 56 },
      xAxis: timeAxis(), yAxis: valueAxis("£/MWh"), dataZoom: zoom(),
      series: [
        { ...line(`Clean spark (η=${a.eta})`, ts, spark, "#3fb68b",
          { areaStyle: { opacity: 0.12 },
            lineStyle: { width: 2, color: "#3fb68b" } }),
          markLine: { symbol: "none", silent: true,
            lineStyle: { color: css("--text-dim"), type: "dashed", width: 1 },
            label: { show: false }, data: [{ yAxis: 0 }] } },
      ],
    }), true);
  }

  function spreadDecomp() {
    const a = State.get().assumptions;
    const { fromIso, toIso } = State.window();
    const d = Data.dailySlice(fromIso, toIso,
      ["price", "gas_sap", "carbon_uka_month"]);
    const ts = d.d.map((day) => Date.parse(day + "T12:00Z"));
    // The decomposition exists only on days where BOTH components are
    // published: SAP lags a day behind price, and stacking carbon alone on
    // a fuel-less day draws a misleading near-baseline tail at the right
    // edge (the stack's layers must share exactly the same day set). Days
    // missing either input are gaps, never zeros — SAP is deliberately not
    // forward-filled (unlike carbon, which carries its own ffill flag).
    const both = (i) =>
      d.gas_sap[i] != null && d.carbon_uka_month[i] != null;
    const fuel = d.gas_sap.map((g, i) =>
      (both(i) ? +(g / a.eta).toFixed(2) : null));
    const carbon = d.carbon_uka_month.map((c, i) =>
      (both(i) ? +((a.efGas / a.eta) * c).toFixed(2) : null));
    const area = (name, data, colour) => ({
      name, type: "line", stack: "cost", showSymbol: false,
      data: ts.map((x, i) => [x, data[i]]),
      lineStyle: { width: 0 }, areaStyle: { color: colour, opacity: 0.7 },
      itemStyle: { color: colour },
    });
    chart("ch-spread-decomp").setOption(baseDay({
      legend: legendBar(),
      xAxis: timeAxis(), yAxis: valueAxis("£/MWh"),
      series: [
        area("Implied fuel cost", fuel, "#ffa94d"),
        area("Implied carbon cost", carbon, "#b0bec5"),
        line("Daily avg price", ts, d.price, css("--accent"),
          { lineStyle: { width: 1.6, color: css("--accent") } }),
      ],
    }), true);
  }

  function spreadDark() {
    const a = State.get().assumptions;
    const coal = State.coalInfo();
    const empty = document.getElementById("dark-empty");
    const badge = document.getElementById("dark-badge");
    if (!coal) {
      empty.classList.remove("hidden");
      const existing = registry.get("ch-spread-dark");
      if (existing) existing.clear();
      return;
    }
    empty.classList.add("hidden");
    if (badge) {
      const isProxy = coal.source === "proxy";
      badge.className = "badge " + (isProxy ? "proxy" : "assumption");
      badge.textContent = isProxy ? "Proxy / Derived" : "Assumption";
    }
    const { fromIso, toIso } = State.window();
    const d = Data.dailySlice(fromIso, toIso,
      ["price", "carbon_uka_month", "coal_proxy_gbp_mwh"]);
    const ts = d.d.map((day) => Date.parse(day + "T12:00Z"));
    const coalInput = coal.source === "manual"
      ? coal.value : d.coal_proxy_gbp_mwh;
    const dark = Metrics.cleanDarkSpread(d.price, d.carbon_uka_month,
      coalInput, { etaCoal: a.etaCoal, efCoal: a.efCoal, vomCoal: a.vomCoal });
    const name = coal.source === "manual"
      ? `Clean dark (manual coal £${coal.value}/MWh th, η=${a.etaCoal})`
      : `Clean dark (Newcastle futures proxy, η=${a.etaCoal})`;
    chart("ch-spread-dark").setOption(baseDay({
      legend: legendBar(),
      xAxis: timeAxis(), yAxis: valueAxis("£/MWh"),
      series: [{ ...line(name, ts, dark, "#8d7060",
        { areaStyle: { opacity: 0.12 } }),
        markLine: { symbol: "none", silent: true,
          lineStyle: { color: css("--text-dim"), type: "dashed", width: 1 },
          label: { show: false }, data: [{ yAxis: 0 }] } }],
    }), true);
  }

  function flowsStack() {
    const { fromTs, toTs } = State.window();
    const sec = Math.max(State.bucketSeconds(), 3600);
    const keys = Object.keys(Data.INTERCONNECTORS).filter((k) => Data.hh[k]);
    let axisT = null;
    const series = keys.map((k) => {
      const agg = Data.aggregate(k, fromTs, toTs, sec);
      axisT = agg.t;
      return {
        name: Data.INTERCONNECTORS[k].label, type: "bar", stack: "ic",
        large: true, barCategoryGap: "0%",
        data: agg.t.map((x, i) => [x, GW(agg.v[i])]),
        itemStyle: { color: Data.INTERCONNECTORS[k].colour },
        emphasis: { focus: "series" },
      };
    });
    const net = Data.aggregate("netImports", fromTs, toTs, sec);
    series.push(line("Net", net.t, net.v.map(GW), css("--text"),
      { lineStyle: { width: 1.4, color: css("--text") } }));
    chart("ch-flows-stack").setOption(base({
      legend: legendBar(),
      grid: { left: 52, right: 24, top: 48, bottom: 56 },
      xAxis: timeAxis(), yAxis: valueAxis("GW"), dataZoom: zoom(), series,
    }), true);
  }

  function flowsScatter() {
    const { fromTs, toTs } = State.window();
    const [lo, hi] = Data.hhRange(fromTs, toTs);
    const points = [];
    const step = Math.max(1, Math.floor((hi - lo) / 3000));
    for (let i = lo; i < hi; i += step) {
      const x = Data.hh.netImports[i], y = Data.hh.price[i];
      if (x != null && y != null) points.push([+(x / 1000).toFixed(2), y]);
    }
    const r = Metrics.pearson(points.map((p) => p[0]), points.map((p) => p[1]));
    chart("ch-flows-scatter").setOption(base({
      title: { text: r == null ? "" : `Pearson r = ${r.toFixed(2)}`,
        right: 10, top: 0,
        textStyle: { color: css("--text-dim"), fontSize: 11, fontWeight: 400 } },
      tooltip: { trigger: "item", backgroundColor: css("--bg-raised"),
        borderColor: css("--border"), textStyle: { color: css("--text") },
        formatter: (p) => `${p.value[0]} GW net imports<br>£${p.value[1]}/MWh` },
      // Centre the axis name under the plot (nameGap into the bottom
      // margin) so it renders in full — the default "end" anchor pushed
      // "Net imports (GW)" past the grid's right edge and clipped it at
      // both phone and desktop widths.
      xAxis: valueAxis("Net imports (GW)",
        { nameLocation: "middle", nameGap: 28 }),
      yAxis: valueAxis(`${CUR()}/MWh`),
      series: [{ type: "scatter", symbolSize: 3, data: points,
        itemStyle: { color: css("--accent"), opacity: 0.35 } }],
    }), true);
  }

  function flowsShare() {
    const { fromTs, toTs } = State.window();
    const net = Data.aggregate("netImports", fromTs, toTs, 86400);
    const demand = Data.aggregate("demand", fromTs, toTs, 86400);
    const share = net.v.map((v, i) =>
      v == null || !demand.v[i] ? null : +(100 * v / demand.v[i]).toFixed(1));
    chart("ch-flows-share").setOption(baseDay({
      xAxis: timeAxis(), yAxis: valueAxis("% of demand"),
      series: [line("Net imports / demand", net.t, share, "#64748b",
        { areaStyle: { opacity: 0.15 } })],
    }), true);
  }

  /* Utilisation ranking: cables ordered by how often flow ran near a
     practical limit. Flows are Observed; the ceiling and the differential
     are Proxy/Derived — GB publishes no per-cable limits and produces no
     flow-based shadow prices (see methodology, m-utilisation). Ceiling:
     per direction, the highest flow sustained ≥2 h in the trailing 90
     days (nameplate is a cited reference column, never used in the
     test). Near-capacity: |flow| ≥ 90% of the operational ceiling. Δ
     joins GB MID to the counterparty day-ahead £ at exactly the
     near-capacity half-hours. The three Irish Sea cables (Moyle to
     Northern Ireland, East-West and Greenlink to the Republic) share the
     all-island SEM day-ahead series; their rows stay distinct because
     each Δ is averaged over that cable's OWN near-capacity periods.
     Congestion proxy: the near-capacity subset whose spread is also wide
     in the direction the flow earns (market p75/p25 tails, ±£5 floor) —
     an approximation, NOT a shadow price: GB's explicitly allocated
     cables publish no congestion rent (see methodology). */
  const UTIL_THRESHOLD = 0.9;  // near-capacity: ≥90% of operational ceiling
  const UTIL_CEIL_DAYS = 90;   // trailing observed-ceiling window
  const UTIL_FLOOR = 0.05;     // ceiling < 5% of nameplate → direction offline
  const UTIL_SUSTAIN_HH = 4;   // ceiling = level held ≥4 half-hours (2 h) in
                               // the window — isolated spikes don't set it
  const CONG_TAIL = 0.75;      // congestion proxy: spread beyond the
                               // market's p75 (imports) / p25 (exports)…
  const CONG_FLOOR = 5;        // …and at least £5/MWh. Approximation — NOT
                               // a shadow price (see methodology).
  let utilRenderSeq = 0;
  // View only — metrics identical in both modes. In-memory per the
  // no-browser-storage rule: resets to the flat ranking on reload.
  let utilSortMode = "rank";   // "rank" | "market"
  let utilSortWired = false;

  /* Daily EUR/GBP lookup (observed, weekend-ffilled in the ETL). */
  function fxDayMap() {
    const fx = new Map();
    if (Data.daily.fx_eur_per_gbp) {
      Data.daily.d.forEach((day, i) => {
        if (Data.daily.fx_eur_per_gbp[i] != null)
          fx.set(day, Data.daily.fx_eur_per_gbp[i]);
      });
    }
    return fx;
  }

  /* Zone day-ahead price in £ at epoch-s ts (EUR ÷ daily BoE EUR/GBP).
     Shared by the utilisation table and the counterparty chart overlays
     so the two can never disagree. */
  function zonePriceGbpAt(ctx, fx, ts) {
    const j = ctx.index.get(ts);
    const eur = j == null ? null : ctx.hh.price[j];
    if (eur == null || !fx.size) return null;
    const rate = fx.get(new Date(ts * 1000).toISOString().slice(0, 10));
    return rate ? eur / rate : null;
  }

  /* Congestion-proxy spread thresholds for a market: the wide tail of
     Δ = GB − zone over the FULL accumulated zone overlap, floored at
     ±£CONG_FLOOR — a fixed population, so the flag definition doesn't
     move when the selected range changes. */
  function zoneSpreadThr(ctx, fx) {
    const deltas = [];
    const zFirst = ctx.hh.t[0];
    for (let i = 0; i < Data.hh.t.length; i++) {
      const ts = Data.hh.t[i];
      if (ts < zFirst) continue;
      const gb = Data.hh.price[i];
      const zp = zonePriceGbpAt(ctx, fx, ts);
      if (gb != null && zp != null) deltas.push(gb - zp);
    }
    const hi = Metrics.quantile(deltas, CONG_TAIL);
    return hi == null ? null
      : { hi: Math.max(hi, CONG_FLOOR),
          lo: Math.min(Metrics.quantile(deltas, 1 - CONG_TAIL),
                       -CONG_FLOOR) };
  }

  function flowsUtilisation() {
    const body = document.getElementById("util-table");
    const metaLine = document.getElementById("util-meta");
    if (!body) return;
    if (!utilSortWired) {
      const seg = document.getElementById("util-sort");
      seg.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        utilSortMode = button.dataset.sort;
        seg.querySelectorAll("button").forEach((b) =>
          b.classList.toggle("active", b === button));
        flowsUtilisation();
      });
      utilSortWired = true;
    }
    const { fromTs, toTs } = State.window();
    const endTs = Data.hh.t[Data.hh.t.length - 1] + 1800;
    const ceilFromTs = endTs - UTIL_CEIL_DAYS * 86400;
    const cables = Object.keys(Data.INTERCONNECTORS)
      .filter((k) => Data.hh[k]);
    if (!cables.length) return;

    const stats = new Map(cables.map((k) => [k, Metrics.cableUtilisation(
      Data.hh.t, Data.hh[k], {
        fromTs, toTs, ceilFromTs, ceilToTs: endTs,
        threshold: UTIL_THRESHOLD,
        floorMw: UTIL_FLOOR * Data.INTERCONNECTORS[k].nameplate_mw,
        sustainHh: UTIL_SUSTAIN_HH,
      })]));

    const zones = [...new Set(cables.map((k) => Data.CABLE_ZONE[k]))];
    const seq = ++utilRenderSeq;
    Promise.all(zones.map((z) => Data.loadZoneContext(z)
      .catch(() => null)))
      .then((ctxs) => {
        if (seq !== utilRenderSeq) return; // superseded render
        const zoneCtx = new Map(zones.map((z, i) => [z, ctxs[i]]));
        renderUtilisation(cables, stats, zoneCtx, body, metaLine,
          { ceilFromTs, endTs });
      });
  }

  function renderUtilisation(cables, stats, zoneCtx, body, metaLine, win) {
    const fx = fxDayMap();
    const priceAt = (ctx, ts) => zonePriceGbpAt(ctx, fx, ts);
    // Mean (GB MID − zone day-ahead £) over the given half-hour indices —
    // only where both prices exist (zone history bounds the join).
    const avgDiff = (ctx, indices) => {
      if (!ctx) return { avg: null, m: 0 };
      let sum = 0, m = 0;
      indices.forEach((i) => {
        const gb = Data.hh.price[i];
        const z = priceAt(ctx, Data.hh.t[i]);
        if (gb != null && z != null) { sum += gb - z; m++; }
      });
      return { avg: m ? sum / m : null, m };
    };

    // Congestion-proxy spread thresholds, one pair per MARKET — cables
    // landing in the same zone share them (helper shared with the
    // counterparty chart overlays).
    const zoneThr = new Map();
    zoneCtx.forEach((ctx, z) =>
      zoneThr.set(z, ctx ? zoneSpreadThr(ctx, fx) : null));

    const rows = cables.map((k) => {
      const ic = Data.INTERCONNECTORS[k];
      const s = stats.get(k);
      const ctx = zoneCtx.get(Data.CABLE_ZONE[k]);
      const imp = avgDiff(ctx, s.nearImp);
      const exp = avgDiff(ctx, s.nearExp);
      const thr = ctx ? zoneThr.get(Data.CABLE_ZONE[k]) : null;
      const flags = thr ? Metrics.congestionFlags(
        { nearImp: s.nearImp, nearExp: s.nearExp },
        (i) => {
          const gb = Data.hh.price[i];
          const zp = priceAt(ctx, Data.hh.t[i]);
          return gb != null && zp != null ? gb - zp : null;
        }, thr.hi, thr.lo) : null;
      return { k, ic, s, imp, exp, flags,
        pctImp: s.n && s.impCeil != null
          ? 100 * s.nearImp.length / s.n : null,
        pctExp: s.n && s.expCeil != null
          ? 100 * s.nearExp.length / s.n : null,
        congImp: s.n && flags && s.impCeil != null
          ? 100 * flags.imp.length / s.n : null,
        congExp: s.n && flags && s.expCeil != null
          ? 100 * flags.exp.length / s.n : null,
        rank: (s.nearImp.length + s.nearExp.length) / (s.n || 1) };
    }).sort((a, b) => b.rank - a.rank);

    const num = (v) => v == null ? "—"
      : (+v).toLocaleString("en-GB", { maximumFractionDigits: 0 });
    const pct = (v) => v == null ? "—" : v.toFixed(1);
    const sgn = (v) => v == null ? "—"
      : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;

    const rowHtml = (r) => {
      const dTitle = `over ${r.imp.m} import / ${r.exp.m} export`
        + " near-capacity half-hours with a zone price";
      const cTitle = `${r.flags ? r.flags.imp.length : 0} of `
        + `${r.s.nearImp.length} import / `
        + `${r.flags ? r.flags.exp.length : 0} of ${r.s.nearExp.length}`
        + " export near-capacity half-hours also had a wide"
        + " direction-consistent spread. Approximation — not a shadow"
        + " price.";
      return `<tr>
          <td><span class="util-dot" style="background:${r.ic.colour}">`
        + `</span>${r.ic.label}</td>
          <td class="num">${num(r.ic.nameplate_mw)}</td>
          <td class="num">${num(r.s.impCeil)} / ${num(r.s.expCeil)}</td>
          <td class="num">${pct(r.pctImp)} / ${pct(r.pctExp)}</td>
          <td class="num" title="${dTitle}">${sgn(r.imp.avg)} / `
        + `${sgn(r.exp.avg)}</td>
          <td class="num" title="${cTitle}">${pct(r.congImp)} / `
        + `${pct(r.congExp)}</td>
        </tr>`;
    };

    // "By market" clusters cables by counterparty zone. rows[] is already
    // ranked, so each group's first cable carries its best share — groups
    // sort by that, and within-group order keeps the ranking.
    let bodyHtml;
    if (utilSortMode === "market") {
      const groups = new Map();
      rows.forEach((r) => {
        const z = Data.CABLE_ZONE[r.k];
        if (!groups.has(z)) groups.set(z, []);
        groups.get(z).push(r);
      });
      bodyHtml = [...groups.entries()]
        .sort((a, b) => b[1][0].rank - a[1][0].rank)
        .map(([z, list]) => {
          const info = Data.ZONE_INFO[z] || { label: z };
          return `<tr class="util-group"><td colspan="6">${info.label}`
            + ` · ${list.length} cable${list.length > 1 ? "s" : ""}`
            + `</td></tr>` + list.map(rowHtml).join("");
        }).join("");
    } else {
      bodyHtml = rows.map(rowHtml).join("");
    }

    body.innerHTML = `<table class="util-table">
      <thead><tr>
        <th>Cable</th>
        <th class="num" title="Operator-published design capacity — cited`
      + ` reference only, never used in the near-capacity test (sources:`
      + ` methodology.md)">Nameplate MW</th>
        <th class="num" title="Trailing ${UTIL_CEIL_DAYS}-day sustained`
      + ` ceiling per direction (4th-largest half-hour, not a plain max)`
      + ` — the operational ceiling the near-capacity`
      + ` test uses (Proxy)">Op. ceiling MW imp / exp</th>
        <th class="num" title="Share of half-hours in the selected range`
      + ` with flow at or beyond ${UTIL_THRESHOLD * 100}% of the`
      + ` operational ceiling">Near-capacity % imp / exp</th>
        <th class="num" title="Mean of GB MID minus counterparty day-ahead`
      + ` £ (Derived) over near-capacity half-hours; positive = GB premium.`
      + ` Indicative only — different market segments.">Avg Δ £/MWh`
      + ` imp / exp</th>
        <th class="num" title="Share of half-hours in the selected range`
      + ` where the cable sat at ≥${UTIL_THRESHOLD * 100}% of its`
      + ` operational ceiling AND the GB−zone spread was wide in the`
      + ` direction the flow earns (beyond the market's p75/p25 over the`
      + ` accumulated zone window, minimum £${CONG_FLOOR}/MWh).`
      + ` Approximation — not a shadow price.">Congestion proxy %`
      + ` imp / exp</th>
      </tr></thead>
      <tbody>${bodyHtml}</tbody></table>`;

    const zStarts = [...zoneCtx.values()].filter(Boolean)
      .map((c) => c.hh.t[0]);
    const zFrom = zStarts.length ? Math.min(...zStarts) : null;
    const missing = [...zoneCtx.entries()].filter(([, c]) => !c)
      .map(([z]) => z);
    // Two caption dates differ in KIND, not by typo: the ceiling window
    // rolls forward daily; the zone-price date is a fixed collection
    // start (append-only history, no backfill) that never moves.
    metaLine.textContent =
      (utilSortMode === "market"
        ? "grouped by counterparty market, best near-capacity share first"
        : "ranked by near-capacity share")
      + " · ceilings from a rolling 90-day"
      + ` window (now ${Metrics.fmtDate(win.ceilFromTs * 1000, "day")} → `
      + `${Metrics.fmtDate((win.endTs - 1800) * 1000, "day")})`
      + " · near-capacity % over the selected range · Δ uses zone"
      + " day-ahead prices collected since "
      + (zFrom ? Metrics.fmtDate(zFrom * 1000, "day") : "16 May 2026")
      + " (fixed accumulation start, no backfill)"
      + " · congestion proxy = at-ceiling + wide direction-consistent"
      + ` spread (market p75/p25 over the zone window, ≥£${CONG_FLOOR})`
      + " — approximation, not a shadow price"
      + (missing.length
        ? ` · zone data unavailable: ${missing.join(", ")}` : "");
  }

  /* Counterparty context: the zone on the other end of a GB cable.
     Flow is Observed (GB side); the remote price is the zone's day-ahead
     auction converted to GBP at the daily BoE EUR/GBP rate — Derived and
     indicative only (different market segment from MID). The mix panel is
     zone-wide CONTEXT, not attribution of the cable's electrons. Zone
     history is append-only from a fixed accumulation start (FR 16 May
     2026, other zones 30 May; no backfill) and deepens daily — NOT a rolling window: longer GB
     ranges are clipped to the overlap, stated in the caption meta line.
     Gaps stay gaps. */
  let selectedCable = null;
  let cableSelectWired = false;
  let ctxRenderSeq = 0;

  function flowsContext() {
    const empty = document.getElementById("context-empty");
    const metaLine = document.getElementById("cable-meta");
    const select = document.getElementById("cable-select");
    const cables = Object.keys(Data.CABLE_ZONE).filter((c) => Data.hh[c]);
    if (!cables.length) return;

    if (!cableSelectWired) {
      select.innerHTML = cables.map((c) =>
        `<option value="${c}">${Data.INTERCONNECTORS[c].label}</option>`)
        .join("");
      select.addEventListener("change", () => {
        selectedCable = select.value;
        flowsContext();
      });
      cableSelectWired = true;
    }
    if (!selectedCable || !Data.hh[selectedCable]) {
      // default: cable with the largest current absolute flow
      selectedCable = cables.reduce((best, c) => {
        const v = Math.abs(Data.latest(c)?.value ?? 0);
        const bv = Math.abs(Data.latest(best)?.value ?? 0);
        return v > bv ? c : best;
      }, cables[0]);
    }
    select.value = selectedCable;

    const zone = Data.CABLE_ZONE[selectedCable];
    const seq = ++ctxRenderSeq;
    Data.loadZoneContext(zone).then((ctx) => {
      if (seq !== ctxRenderSeq) return; // superseded
      empty.classList.add("hidden");
      renderContext(selectedCable, zone, ctx, metaLine);
    }).catch((error) => {
      if (seq !== ctxRenderSeq) return;
      metaLine.textContent = "";
      empty.textContent = `Zone context for ${zone} could not be loaded `
        + `(${error.message}) — run etl/fetch_entsoe.py --zone ${zone}.`;
      empty.classList.remove("hidden");
      ["ch-flows-context", "ch-flows-context-mix"].forEach((id) => {
        const existing = registry.get(id);
        if (existing) existing.clear();
      });
    });
  }

  function renderContext(cable, zone, ctx, metaLine) {
    const { fromTs, toTs } = State.window();
    const zFirst = ctx.hh.t[0];
    const zLast = ctx.hh.t[ctx.hh.t.length - 1] + 1800;
    const from = Math.max(fromTs, zFirst);
    const to = Math.min(toTs, zLast);
    const sec = Math.max(State.bucketSeconds(), 3600);
    const info = Data.ZONE_INFO[zone] || { label: zone };

    const fx = fxDayMap();

    const flow = Data.aggregate(cable, from, to, sec);
    const gbPrice = Data.aggregate("price", from, to, sec);
    const zPriceEur = Data.aggregateArrays(ctx.hh.t, ctx.hh.price,
      from, to, sec);
    const zPriceGbp = zPriceEur.v.map((v, k) => {
      if (v == null || !fx.size) return null;
      const rate = fx.get(new Date(zPriceEur.t[k]).toISOString()
        .slice(0, 10));
      return rate ? +(v / rate).toFixed(2) : null;
    });

    // #19 overlays — same definitions as the utilisation panel (see
    // methodology, m-utilisation): per-direction sustained ceilings,
    // cited nameplate, and congestion-proxy half-hours (at ceiling AND
    // wide direction-consistent spread; approximation, NOT a shadow
    // price). Computed at half-hourly resolution regardless of the
    // chart's display buckets.
    const ic = Data.INTERCONNECTORS[cable];
    const endTs = Data.hh.t[Data.hh.t.length - 1] + 1800;
    const stats = Metrics.cableUtilisation(Data.hh.t, Data.hh[cable], {
      fromTs: from, toTs: to,
      ceilFromTs: endTs - UTIL_CEIL_DAYS * 86400, ceilToTs: endTs,
      threshold: UTIL_THRESHOLD, floorMw: UTIL_FLOOR * ic.nameplate_mw,
      sustainHh: UTIL_SUSTAIN_HH,
    });
    const thr = zoneSpreadThr(ctx, fx);
    const flags = thr ? Metrics.congestionFlags(
      { nearImp: stats.nearImp, nearExp: stats.nearExp },
      (i) => {
        const gb = Data.hh.price[i];
        const zp = zonePriceGbpAt(ctx, fx, Data.hh.t[i]);
        return gb != null && zp != null ? gb - zp : null;
      }, thr.hi, thr.lo) : { imp: [], exp: [] };
    // contiguous flagged half-hours → [startMs, endMs) shading runs
    const flagged = [...flags.imp, ...flags.exp].sort((a, b) => a - b);
    const runs = [];
    flagged.forEach((i) => {
      const s = Data.hh.t[i] * 1000, e = (Data.hh.t[i] + 1800) * 1000;
      const last = runs[runs.length - 1];
      if (last && s <= last[1]) last[1] = e; else runs.push([s, e]);
    });
    // Flow axis spans the design envelope so the design-vs-practice gap
    // stays visible instead of being autoscaled away.
    const envGw = +(1.05 * Math.max(ic.nameplate_mw, stats.impCeil ?? 0,
      stats.expCeil ?? 0) / 1000).toFixed(2);
    const dimC = css("--text-dim");
    // All four reference lines are labelled per direction — an
    // unlabelled mirror line under the area fill reads as absent, and
    // the ceilings are genuinely asymmetric (separate imp/exp values
    // from cableUtilisation, same as the table's imp / exp column).
    const mlData = [
      { yAxis: GW(ic.nameplate_mw),
        lineStyle: { color: dimC, type: "dotted", width: 1 },
        label: { show: true, formatter: "nameplate", fontSize: 9,
                 color: dimC, position: "insideEndBottom" } },
      { yAxis: -GW(ic.nameplate_mw),
        lineStyle: { color: dimC, type: "dotted", width: 1 },
        label: { show: true, formatter: "nameplate", fontSize: 9,
                 color: dimC, position: "insideEndTop" } },
    ];
    // Ceiling labels anchor LEFT, nameplate labels RIGHT — horizontal
    // separation, so nearly-coincident lines (ceiling ≈ nameplate) can
    // never overlay each other's labels at any zoom level.
    if (stats.impCeil != null) mlData.push({ yAxis: GW(stats.impCeil),
      lineStyle: { color: ic.colour, type: "dashed", width: 1 },
      label: { show: true, formatter: "op. ceiling (import)",
               fontSize: 9, color: dimC, position: "insideStartTop" } });
    if (stats.expCeil != null) mlData.push({ yAxis: -GW(stats.expCeil),
      lineStyle: { color: ic.colour, type: "dashed", width: 1 },
      label: { show: true, formatter: "op. ceiling (export)",
               fontSize: 9, color: dimC,
               position: "insideStartBottom" } });

    // Zone generation mix shares on the same buckets
    const mixKeys = Data.STACK_ORDER.filter((k) => ctx.hh[k]
      && ctx.hh[k].some((v) => v != null && v !== 0));
    const mixAgg = mixKeys.map((k) =>
      Data.aggregateArrays(ctx.hh.t, ctx.hh[k], from, to, sec));
    const mixT = mixAgg.length ? mixAgg[0].t : [];
    const totals = mixT.map((_, k) =>
      mixAgg.reduce((sum, a) => sum + Math.max(a.v[k] ?? 0, 0), 0));
    const shares = mixAgg.map((a) => a.v.map((v, k) =>
      totals[k] > 0 && v != null
        ? +((100 * Math.max(v, 0)) / totals[k]).toFixed(1) : null));
    const bucketIdx = new Map(mixT.map((ms, k) => [ms, k]));

    const clipped = from > fromTs;
    const captionBase =
      `${info.label} (${zone}) · showing ` +
      `${Metrics.fmtDate(from * 1000, "day")} → ` +
      `${Metrics.fmtDate((to - 1800) * 1000, "day")}` +
      (clipped ? " — clipped to the accumulated zone history "
                 + "(append-only; deepens daily)" : "") +
      (fx.size ? " · remote price converted at daily BoE EUR/GBP (Derived)"
               : " · EUR/GBP unavailable — remote price hidden");
    // The congestion count follows the ZOOMED window (datazoom handler
    // below), so "in view" stays literally true.
    const setCaption = (visFromS, visToS) => {
      const nVis = flagged.filter((i) =>
        Data.hh.t[i] >= visFromS && Data.hh.t[i] < visToS).length;
      metaLine.textContent = captionBase +
        (thr ? ` · ${nVis} congestion-proxy half-hours in view`
               + " (approximation — not a shadow price)"
             : " · congestion proxy unavailable (no zone price overlap)");
    };
    setCaption(from, to);

    const top = chart("ch-flows-context");
    top.setOption(base({
      legend: legendBar(),
      grid: { left: 52, right: 56, top: 48, bottom: 56 },
      dataZoom: zoom(),
      tooltip: { trigger: "axis", backgroundColor: css("--bg-raised"),
        borderColor: css("--border"), confine: true,
        textStyle: { color: css("--text"), fontSize: 12 },
        formatter: (params) => {
          const list = Array.isArray(params) ? params : [params];
          if (!list.length) return "";
          const ms = list[0].value[0];
          const rows = list
            .filter((q) => q.value[1] != null)
            .map((q) => `${q.marker} ${q.seriesName}<span style="float:right;`
              + `margin-left:16px;font-weight:600">${(+q.value[1])
                .toLocaleString("en-GB", { maximumFractionDigits: 2 })
              }</span>`);
          const k = bucketIdx.get(ms);
          let fuels = "";
          if (k != null && totals[k] > 0) {
            const ranked = mixKeys.map((key, j) =>
              [Data.FUELS[key].label, shares[j][k] ?? 0])
              .sort((a, b) => b[1] - a[1]).slice(0, 3)
              .map(([l, v]) => `${l} ${v.toFixed(0)}%`).join(" · ");
            fuels = `<div style="margin-top:3px;opacity:.75">${info.label} `
              + `mix: ${ranked}</div>`;
          }
          const congested = runs.some(([s, e]) =>
            s < ms + sec * 1000 && e > ms);
          const note = congested
            ? `<div style="margin-top:3px;color:#bd9a55">⚠ congestion`
              + ` proxy — approximation, not a shadow price (see`
              + ` methodology)</div>`
            : "";
          return `<div style="margin-bottom:3px">`
            + `${Metrics.fmtDate(ms, "datetime")}</div>`
            + rows.join("<br>") + fuels + note;
        } },
      xAxis: timeAxis(),
      yAxis: [valueAxis("GW", { min: -envGw, max: envGw }),
        valueAxis(`${CUR()}/MWh`, { position: "right",
          splitLine: { show: false } })],
      series: [
        { name: `${Data.INTERCONNECTORS[cable].label} flow (+import)`,
          type: "line", showSymbol: false, sampling: "lttb",
          data: flow.t.map((x, k) => [x, GW(flow.v[k])]),
          lineStyle: { width: 1.2,
            color: Data.INTERCONNECTORS[cable].colour },
          itemStyle: { color: Data.INTERCONNECTORS[cable].colour },
          areaStyle: { opacity: 0.25 }, yAxisIndex: 0,
          connectNulls: false,
          markLine: { symbol: "none", silent: true, data: mlData },
          markArea: { silent: true,
            itemStyle: { color: "rgba(189, 154, 85, 0.14)" },
            data: runs.map(([s, e]) => [{ xAxis: s }, { xAxis: e }]) } },
        line("GB price (MID)", gbPrice.t, gbPrice.v, css("--accent"),
          { yAxisIndex: 1 }),
        ...(fx.size ? [line(`${zone} day-ahead £ (Derived)`,
          zPriceEur.t, zPriceGbp, "#8ab4f8",
          { yAxisIndex: 1, lineStyle: { width: 1.4, type: "dashed",
                                        color: "#8ab4f8" } })] : []),
      ],
    }), true);

    const bottom = chart("ch-flows-context-mix");
    bottom.setOption(base({
      legend: legendBar(),
      grid: { left: 52, right: 56, top: 48, bottom: 42 },
      // Inside zoom only (no second slider in the card); the group
      // connection keeps it in step with the flow chart's zoom.
      dataZoom: [{ type: "inside", start: 0, end: 100 }],
      xAxis: timeAxis(),
      // align: "left" anchors the name's left edge at the axis instead of
      // centring on it — centred, this long name's leading "%" clipped off
      // the canvas's left edge at phone width (real-device find, 2026-07-16).
      yAxis: valueAxis("% of zone generation",
        { min: 0, max: 100,
          nameTextStyle: { color: css("--text-dim"), align: "left" } }),
      series: mixKeys.map((k, j) => ({
        name: Data.FUELS[k].label, type: "line", stack: "mix",
        showSymbol: false, sampling: "lttb",
        data: mixT.map((x, i) => [x, shares[j][i]]),
        lineStyle: { width: 0 },
        itemStyle: { color: Data.FUELS[k].colour },
        areaStyle: { opacity: 0.85 }, connectNulls: false,
      })),
    }), true);

    top.group = "flows-context";
    bottom.group = "flows-context";
    echarts.connect("flows-context");

    // Keep the congestion count honest under zoom. Chart instances are
    // cached in the registry, so drop any previous render's handler
    // before attaching this one (its closure holds this render's
    // flagged set).
    const dataMinMs = from * 1000, dataMaxMs = to * 1000;
    top.off("datazoom");
    top.on("datazoom", (e) => {
      const p = (e.batch ? e.batch[0] : e) || {};
      const dz = top.getOption().dataZoom[0] || {};
      const pctS = p.start ?? dz.start ?? 0;
      const pctE = p.end ?? dz.end ?? 100;
      const sMs = dz.startValue
        ?? dataMinMs + (pctS / 100) * (dataMaxMs - dataMinMs);
      const eMs = dz.endValue
        ?? dataMinMs + (pctE / 100) * (dataMaxMs - dataMinMs);
      setCaption(sMs / 1000, eMs / 1000);
    });
  }

  /* -------------------- System stress (plan/06 workstream B) ----------
     Data.stress is written by etl/fetch_stress.py: observed daily metrics
     plus flags[] computed at build time against point-in-time trailing
     baselines. The renderers only display what the ETL shipped — no
     statistics are computed in the browser. Amber = the flag convention
     shared with the header staleness element. */

  const FLAG_AMBER = "#bd9a55";

  function stressDaily() {
    const el = document.getElementById("ch-stress-daily");
    if (!el) return;
    const empty = document.getElementById("stress-empty");
    const metaEl = document.getElementById("stress-meta");
    const s = Data.stress;
    const ok = State.get().zone === "GB" && s && s.days
      && Object.keys(s.days).length;
    const latestEl = document.getElementById("stress-latest");
    empty.classList.toggle("hidden", !!ok);
    el.classList.toggle("hidden", !ok);
    if (!ok) {
      metaEl.textContent = "";
      if (latestEl) latestEl.textContent = "";
      return;
    }

    // Short percentile-context suffix, e.g. " (p98.6, very high)" —
    // shared by the latest-day digest below; the tooltip grid renders
    // its own dim-styled variant.
    const pctlSuffix = (entry, key) => {
      const c = entry.pctl && entry.pctl[key];
      if (!c || c.p == null) return "";
      return ` (p${c.p % 1 ? c.p.toFixed(1) : c.p.toFixed(0)}, ${c.band})`;
    };

    const allKeys = Object.keys(s.days).sort();

    // Latest-day digest — deterministic state-of-play line for the most
    // recent stored day. Deliberately range-independent, like the header
    // chip (the daily chart and event viewer follow the presets; this
    // line always answers "what does the newest data say?"). Wording is
    // operational, never a verdict: "no flags fired" = no threshold
    // crossed, and a thin baseline is said out loud rather than letting
    // silence imply confidence.
    if (latestEl) {
      const lk = allKeys[allKeys.length - 1];
      const le = s.days[lk];
      const lolpL = Math.max(...[1, 8, 12].map((h) =>
        le[`lolp_max_${h}h`] ?? 0));
      const drmL = Math.min(...[1, 8, 12].map((h) =>
        le[`drm_min_${h}h`] ?? Infinity));
      const flagsL = (le.flags || []).map((f) => f.type).join(" + ");
      const thin = le.pctl
        && Object.values(le.pctl).some((c) => c.p == null);
      const bits = [
        flagsL ? `<span style="color:${FLAG_AMBER};font-weight:600">` +
          `⚑ flagged: ${flagsL}</span>` : "no flags fired",
        thin ? "baseline building (&lt;90 d history — percentile flags " +
          "inactive; only EMN and the adequacy floor can fire)" : null,
        le.secs_below_49p8 != null
          ? `${fmtVal(le.secs_below_49p8)} s below 49.8 Hz` : null,
        le.ssp_max != null
          ? `max SSP ${CUR()}${fmtVal(le.ssp_max)}${pctlSuffix(le, "ssp_max")}`
          : null,
        `max LoLP ${(lolpL * 100).toFixed(2)}%${pctlSuffix(le, "lolp_max")}`,
        Number.isFinite(drmL)
          ? `min DRM ${fmtVal(drmL)} MW${pctlSuffix(le, "drm_min")}` : null,
      ].filter(Boolean);
      latestEl.innerHTML = `Latest day ${lk}: ${bits.join(" · ")}`;
      latestEl.title = "Always the most recent stored day — deliberately " +
        "independent of the 7D–1Y range presets, like the header chip " +
        "(the chart below does follow them). Flags are fixed threshold " +
        "rules on observed metrics, not a security assessment.";
    }

    // Honour the global range presets like every other time-series panel;
    // the in-chart zoom then works within the selected range.
    const { fromIso, toIso } = State.window();
    const keys = allKeys.filter((k) => k >= fromIso && k <= toIso);
    if (!keys.length) {
      chart("ch-stress-daily").clear();
      metaEl.textContent =
        "no stress data in the selected range — pick a longer preset";
      return;
    }
    const dayMs = keys.map((k) => Date.parse(k + "T00:00:00Z"));
    const mins = keys.map((k) => {
      const v = s.days[k].secs_below_49p8;
      return v == null ? null : +(v / 60).toFixed(1);
    });
    const ssp = keys.map((k) => s.days[k].ssp_max ?? null);
    const flaggedPts = [];
    const counts = {};
    keys.forEach((k, i) => {
      const flags = s.days[k].flags || [];
      if (flags.length) flaggedPts.push([dayMs[i], 1]);
      flags.forEach((f) => { counts[f.type] = (counts[f.type] || 0) + 1; });
    });

    const opt = baseDay({
      legend: legendBar(),
      grid: { left: 52, right: 56, top: 48, bottom: 56 },
      xAxis: timeAxis(),
      yAxis: [
        // The name is longer than the 52px left gutter, and ECharts
        // centres axis names on the axis line — half of it would clip
        // off the pane ("...in below 49.8 Hz"). Anchor it left, starting
        // 8px from the pane edge, so the full label reads over the
        // chart's top band instead.
        valueAxis("min below 49.8 Hz", { min: 0,
          nameTextStyle: { color: css("--text-dim"), align: "left",
            padding: [0, 0, 0, -44] } }),
        valueAxis(`${CUR()}/MWh SSP`, { position: "right",
          splitLine: { show: false } }),
        { type: "value", min: 0, max: 1.08, show: false },
      ],
      dataZoom: zoom(),
      series: [
        { name: "Excursion below 49.8 Hz", type: "bar",
          data: dayMs.map((x, i) => [x, mins[i]]),
          itemStyle: { color: "#7d8ea3" }, barMaxWidth: 6, yAxisIndex: 0 },
        line("Max SSP", dayMs, ssp, css("--accent"), { yAxisIndex: 1 }),
        { name: "Flagged day", type: "scatter", yAxisIndex: 2,
          data: flaggedPts, symbol: "diamond", symbolSize: 9,
          itemStyle: { color: FLAG_AMBER } },
      ],
    });
    // Tooltip: the day's full stored metrics + each flag's value vs the
    // exact threshold that fired (thresholds ship in the JSON).
    // Tooltip: fixed three-column grid (metric | value | percentile
    // context), monospace throughout, so the box keeps one width while
    // hovering across days instead of reflowing per row content. The
    // context column is the ETL-computed rank against the same
    // point-in-time trailing window the flags use ("insufficient
    // history" under 90 days — never a made-up rank; DRM inverted so a
    // big p always means a more stressed day).
    const monoCss = MONO.replace(/"/g, "'");
    const RIGHT = 'style="text-align:right"';
    const dimRight = `style="text-align:right;color:${css("--text-dim")}"`;
    const ctxCell = (e, key) => {
      const c = e.pctl && e.pctl[key];
      if (!c) return "";
      return c.p == null ? `— ${c.band}`
        : `— p${c.p % 1 ? c.p.toFixed(1) : c.p.toFixed(0)}, ${c.band}`;
    };
    const grid = (cells) => `<div style="display:grid;` +
      `grid-template-columns:auto 104px 164px;column-gap:10px;` +
      `row-gap:1px">${cells.join("")}</div>`;
    opt.tooltip.formatter = (params) => {
      const list = Array.isArray(params) ? params : [params];
      if (!list.length) return "";
      const key = new Date(list[0].axisValue).toISOString().slice(0, 10);
      const e = s.days[key];
      if (!e) return Metrics.fmtDate(list[0].axisValue, "day");
      const lolp = Math.max(...[1, 8, 12].map((h) =>
        e[`lolp_max_${h}h`] ?? 0));
      const drm = Math.min(...[1, 8, 12].map((h) =>
        e[`drm_min_${h}h`] ?? Infinity));
      const cells = [];
      const row = (label, value, ctxKey) => cells.push(
        `<span>${label}</span>`,
        `<span ${RIGHT}>${value}</span>`,
        `<span ${dimRight}>${ctxKey ? ctxCell(e, ctxKey) : ""}</span>`);
      if (e.secs_below_49p8 != null) {
        row("below 49.8 Hz", `<b>${fmtVal(e.secs_below_49p8)} s</b>`);
      }
      if (e.freq_min != null) {
        row("min frequency", `${e.freq_min.toFixed(3)} Hz`);
      }
      if (e.ssp_max != null) {
        row("max SSP", `${CUR()}${fmtVal(e.ssp_max)} (SP${e.ssp_max_sp})`,
          "ssp_max");
      }
      row("max LoLP", `${(lolp * 100).toFixed(2)}%`, "lolp_max");
      if (Number.isFinite(drm)) {
        row("min DRM", `${fmtVal(drm)} MW`, "drm_min");
      }
      if (e.emn_count) row("EMN issued", String(e.emn_count));
      const flagCells = (e.flags || []).flatMap((f) => {
        const money = f.type === "price";
        const unit = f.type === "frequency" ? " s" : "";
        return [
          `<span style="color:${FLAG_AMBER};font-weight:600">` +
            `⚑ ${f.type}</span>`,
          `<span ${RIGHT}>${money ? CUR() + fmtVal(f.value)
            : fmtVal(f.value) + unit}</span>`,
          `<span ${dimRight}>≥ ${money ? CUR() + fmtVal(f.threshold)
            : fmtVal(f.threshold) + unit}</span>`,
        ];
      });
      return `<div style="font-family:${monoCss}">` +
        `<div style="margin-bottom:3px">` +
        `${Metrics.fmtDate(list[0].axisValue, "day")}</div>` +
        grid(cells) +
        (flagCells.length ? `<hr style="border:none;border-top:1px solid ` +
          `${css("--border")};margin:4px 0">` + grid(flagCells) : "") +
        `</div>`;
    };
    chart("ch-stress-daily").setOption(opt, true);

    const flaggedTotal = flaggedPts.length;
    const windowFlagged = allKeys
      .filter((k) => (s.days[k].flags || []).length).length;
    const byType = Object.entries(counts)
      .map(([t, n]) => `${n} ${t}`).join(" · ");
    metaEl.textContent =
      `${keys.length} days in view (${keys[0]} → ${keys[keys.length - 1]})` +
      ` · ${flaggedTotal} flagged in view` +
      (byType ? ` (${byType})` : "") +
      ` — ${windowFlagged} in the full ${allKeys.length}-day window` +
      ` · flags computed at build against point-in-time trailing baselines`;
  }

  let stressEventWired = false;
  let stressEventDay = null; // in-memory selection (no browser storage)

  function stressEvent() {
    const el = document.getElementById("ch-stress-event");
    if (!el) return;
    const select = document.getElementById("stress-event");
    const empty = document.getElementById("stress-event-empty");
    const metaEl = document.getElementById("stress-event-meta");
    if (!stressEventWired) {
      select.addEventListener("change", () => {
        stressEventDay = select.value;
        stressEvent();
      });
      stressEventWired = true;
    }
    const s = Data.stress;
    const all = (State.get().zone === "GB" && s && s.meta
      && s.meta.event_days) ? s.meta.event_days : [];
    if (!all.length) {
      select.innerHTML = "";
      el.classList.add("hidden");
      empty.textContent = "No event slices available — every flagged day " +
        "gets one once etl/fetch_stress.py has run.";
      empty.classList.remove("hidden");
      metaEl.textContent = "";
      return;
    }
    // The day list follows the global range presets (slice generation in
    // the ETL does not — every flagged day has a slice on disk; this is
    // presentation only). Selection survives range changes while it stays
    // in view; otherwise fall back to the newest flagged day in range.
    const { fromIso, toIso } = State.window();
    const days = all.filter((d) => d >= fromIso && d <= toIso);
    if (!days.length) {
      select.innerHTML = "";
      el.classList.add("hidden");
      empty.textContent = `No flagged days in the selected range — ` +
        `${all.length} in the full window; pick a longer preset.`;
      empty.classList.remove("hidden");
      metaEl.textContent = "";
      return;
    }
    const options = [...days].reverse(); // newest first
    if (!options.includes(stressEventDay)) stressEventDay = options[0];
    const html = options.map((d) =>
      `<option value="${d}"${d === stressEventDay ? " selected" : ""}>` +
      `${d}</option>`).join("");
    if (select.innerHTML !== html) select.innerHTML = html;

    const requested = stressEventDay;
    Data.loadEventSlice(requested).then((slice) => {
      if (requested !== stressEventDay) return; // selection moved on
      el.classList.remove("hidden");
      empty.classList.add("hidden");
      const t0 = Date.parse(slice.start_utc);
      const step = (slice.step_seconds || 15) * 1000;
      const data = slice.hz.map((v, i) => [t0 + i * step, v]);
      const entry = (s.days || {})[requested] || {};
      const opt = base({
        grid: { left: 52, right: 24, top: 48, bottom: 56 },
        xAxis: { ...timeAxis(), axisLabel: { color: css("--text-dim"),
          fontFamily: MONO, hideOverlap: true,
          formatter: (val) => new Date(val).toISOString().slice(11, 16) } },
        yAxis: [valueAxis("Hz", { axisLabel: { color: css("--text-dim"),
          fontFamily: MONO, formatter: (v) => v.toFixed(1) } })],
        dataZoom: zoom(),
        series: [{
          name: "Frequency", type: "line", showSymbol: false,
          sampling: "lttb", data,
          lineStyle: { width: 1.1, color: css("--accent") },
          itemStyle: { color: css("--accent") },
          connectNulls: false,
          markLine: { silent: true, symbol: "none",
            label: { fontFamily: MONO, color: css("--text-dim"),
              position: "insideEndTop",
              formatter: (p) => p.data.name },
            data: [
              { yAxis: 49.8, name: "49.8 operational",
                lineStyle: { color: FLAG_AMBER, type: "dashed" } },
              { yAxis: 50.2, name: "50.2 operational",
                lineStyle: { color: FLAG_AMBER, type: "dashed" } },
              { yAxis: 49.5, name: "49.5 statutory",
                lineStyle: { color: "#e4573d", type: "dashed" } },
            ] },
        }],
      });
      opt.tooltip.formatter = (params) => {
        const list = Array.isArray(params) ? params : [params];
        const p = list.find((x) => x.value && x.value[1] != null);
        if (!p) return "";
        return `${new Date(p.value[0]).toISOString()
          .slice(0, 16).replace("T", " ")}Z<br>` +
          `<b>${(+p.value[1]).toFixed(3)} Hz</b>`;
      };
      chart("ch-stress-event").setOption(opt, true);

      const flags = (entry.flags || []).map((f) => f.type).join(" + ");
      // Same ETL-computed percentile context as the daily tooltip —
      // day-level framing while reading the intraday trace.
      const cx = entry.pctl || {};
      const context = [["ssp_max", "SSP"], ["lolp_max", "LoLP"],
                       ["drm_min", "DRM"]]
        .filter(([k]) => cx[k] && cx[k].p != null)
        .map(([k, label]) => `${label} p${cx[k].p % 1
          ? cx[k].p.toFixed(1) : cx[k].p.toFixed(0)} ${cx[k].band}`)
        .join(", ");
      metaEl.textContent = `${requested}` +
        (entry.freq_min != null ? ` · min ${entry.freq_min.toFixed(3)} Hz`
          : "") +
        (entry.secs_below_49p8 != null
          ? ` · ${fmtVal(entry.secs_below_49p8)} s below 49.8 Hz` : "") +
        (flags ? ` · flags: ${flags}` : "") +
        (context ? ` · ${context}` : "") +
        ` · 15 s samples, gaps are feed gaps`;
    }).catch((error) => {
      if (requested !== stressEventDay) return;
      el.classList.add("hidden");
      empty.textContent =
        `Event slice for ${requested} unavailable (${error.message}).`;
      empty.classList.remove("hidden");
      metaEl.textContent = "";
    });
  }

  /* Batteries (BESS) tab — observed accepted BM volumes for the identified
     GB battery fleet (issue #24 / plan/08 D16). Data: optional secondary
     payload app/data/bess_activity.json, written by
     etl/build_bess_activity.py — same optional/degrade-gracefully
     treatment as stressDaily above (empty-state div, never a broken tab).
     View-only toggle ("per MW of fleet active to date"), module-local per
     the utilSortMode/utilSortWired precedent above: no browser storage,
     no State.js field, resets to absolute MWh on reload. */
  let bessNormalised = false;
  let bessNormaliseWired = false;

  function bessActivity() {
    const el = document.getElementById("ch-bess-activity");
    if (!el) return;
    const empty = document.getElementById("bess-empty");
    const captionEl = document.getElementById("bess-caption");
    const toggle = document.getElementById("bess-normalise");
    if (toggle && !bessNormaliseWired) {
      toggle.checked = bessNormalised;
      toggle.addEventListener("change", () => {
        bessNormalised = toggle.checked;
        bessActivity();
      });
      bessNormaliseWired = true;
    }

    const payload = Data.bess;
    const ok = !!(payload && payload.fleet && payload.days
      && Object.keys(payload.days).length);
    empty.classList.toggle("hidden", ok);
    el.classList.toggle("hidden", !ok);
    if (!ok) {
      if (captionEl) captionEl.textContent = "";
      const existing = registry.get("ch-bess-activity");
      if (existing) existing.clear();
      return;
    }

    const fleet = payload.fleet;
    // wa is read only as a fallback (a day missing denominator_mw, or the
    // empty-payload path) — it is no longer the divisor (addendum §A):
    // the divisor is now per-day, payload.days[k].denominator_mw.
    const wa = fleet.window_active || {};
    const repd = (payload.meta && payload.meta.repd_context) || {};
    const win = (payload.meta && payload.meta.window) || {};

    // One bar per STORED day, filtered to the selected range window —
    // same precedent as stressDaily (another day-keyed optional payload):
    // the hh/hour/day resolution toggle is NOT followed, only the date
    // range is. Reconstructing exact UK local settlement-period
    // boundaries from the variable 46/48/50-length SP arrays (clock-change
    // days shift the BST/GMT transition instant) would need a timezone
    // database client-side for a sub-day view stress_daily's own JS layer
    // also avoids; summing SPs into one daily figure is what §4c's own
    // instruction ("at day resolution sum SPs per day") requires anyway.
    const allKeys = Object.keys(payload.days).sort();

    // Caption stats: every number comes from the payload, rebuilt on
    // every render. Compact card-meta idiom (mid-dot separators, like
    // bmu-meta above); the full reasoning lives in the Methodology tab.
    // The two divisor figures are the FIRST and LAST stored day's
    // denominator_mw (addendum §A6) — they describe the stored window,
    // not the on-screen range, same convention the caption already used
    // for window_active.
    const firstDenom = allKeys.length
      ? (payload.days[allKeys[0]].denominator_mw ?? wa.mw) : wa.mw;
    const lastDenom = allKeys.length
      ? (payload.days[allKeys[allKeys.length - 1]].denominator_mw ?? wa.mw)
      : wa.mw;
    if (captionEl) {
      const fmtMw = (v) => v == null ? "?"
        : Math.round(v).toLocaleString("en-GB");
      captionEl.textContent =
        `Identified fleet: ${fleet.units} units, ${fmtMw(fleet.mw)} MW ` +
        "(derived; see Methodology) · per-MW figures divide each day by " +
        "the capacity first dispatched in the Balancing Mechanism on or " +
        `before that day, ${fmtMw(firstDenom)} MW at the start of this ` +
        `window rising to ${fmtMw(lastDenom)} MW now · stored window ` +
        `${win.from ?? "?"} → ${win.to ?? "?"} · REPD ` +
        `${repd.vintage ?? "?"} context: ${repd.sites ?? "?"} sites, ` +
        `${fmtMw(repd.mw)} MW (site-level, not BMU-mappable)`;
    }

    const { fromIso, toIso } = State.window();
    const keys = allKeys.filter((k) => k >= fromIso && k <= toIso);
    if (!keys.length) {
      chart("ch-bess-activity").clear();
      return;
    }
    const dayMs = keys.map((k) => Date.parse(k + "T00:00:00Z"));

    // Per-day denominator (addendum §A): the capacity first dispatched on
    // or before that day. A single build-level divisor understated the
    // earliest 30 days of a 400-day window by 43% and reversed the sign
    // of the utilisation trend. Both legs read offer_mwh_total /
    // bid_mwh_total directly — every day carries the daily totals,
    // regardless of tier, so there is no tier branch here.
    const denom = (k) => {
      const d = payload.days[k].denominator_mw;
      return d > 0 ? d : null;
    };
    const scale = (v, k) => {
      if (!bessNormalised) return +v.toFixed(1);
      const d = denom(k);
      return d ? +(v / d).toFixed(4) : null;
    };
    const offer = keys.map((k) => scale(payload.days[k].offer_mwh_total, k));
    const bid = keys.map((k) => scale(payload.days[k].bid_mwh_total, k));
    const net = offer.map((o, i) => (o == null || bid[i] == null) ? null
      : +(o + bid[i]).toFixed(bessNormalised ? 4 : 1));

    const unitLabel = bessNormalised ? "MWh/MW (fleet active to date)" : "MWh";
    chart("ch-bess-activity").setOption(baseDay({
      legend: legendBar({ data: ["Offer (accepted)", "Bid (accepted)",
        "Net accepted"] }),
      grid: { left: 60, right: 56, top: 48, bottom: 56 },
      xAxis: timeAxis(),
      // scale: true (from valueAxis) autoscales across zero rather than
      // forcing a symmetric ±max — the signed-stack pitfall this panel
      // exists to avoid is DROPPING negatives (app/js/charts.js:656's
      // `filter((u) => u.mw > 0)`), not the exact axis symmetry.
      // Name anchored left (same fix as the stress chart's over-long
      // "min below 49.8 Hz" axis name): ECharts centres axis names on the
      // axis line by default, and the normalised label is longer than the
      // left gutter — centred, half of it clips off the pane.
      yAxis: valueAxis(unitLabel, { nameTextStyle: {
        color: css("--text-dim"), align: "left", padding: [0, 0, 0, -56] } }),
      dataZoom: zoom(),
      series: [
        { name: "Offer (accepted)", type: "bar", stack: "bess",
          data: dayMs.map((t, i) => [t, offer[i]]),
          itemStyle: { color: Data.FUELS.BESS.colour, opacity: 0.9 },
          barMaxWidth: 14 },
        { name: "Bid (accepted)", type: "bar", stack: "bess",
          data: dayMs.map((t, i) => [t, bid[i]]),
          itemStyle: { color: Data.FUELS.BESS.colour, opacity: 0.45 },
          barMaxWidth: 14 },
        line("Net accepted", dayMs, net, css("--accent"),
          { lineStyle: { width: 1.6, color: css("--accent") } }),
      ],
    }), true);
  }

  /* Observable revenue stack + BM cashflow sub-panel (issue #47 / plan/08).
     Data: optional secondary payload app/data/bess_revenue.json, written
     by etl/build_bess_revenue.py — same optional/degrade-gracefully
     treatment as bessActivity above. Columnar payload: `days` is a plain
     array (not a dict keyed by day, unlike bess_activity.json), so every
     series here is index-aligned to that array rather than looked up by
     date string.

     D13 (identification): twelve EAC availability products are kept
     separate, never netted into six service bands — DRH/DRL (and the
     other high/low pairs) routinely clear opposite signs on the same
     day, and collapsing them would hide two large, real, offsetting
     flows behind a small net figure. Coloured by service family (DC/DM/
     DR/BR/QR/SR), with the low/negative leg of each pair rendered
     lighter and the high/positive leg darker — the same same-hue,
     opacity-shaded idiom bessActivity already uses for its offer/bid
     bars above, applied per family instead of to one BESS colour.

     D18 (BM cashflow): rendered as a separate signed sub-panel within
     the SAME card, below a rule, never summed into the stack — it is
     the fleet's energy-purchase leg and runs to several times the
     availability stack's magnitude; stacking it would both dominate the
     chart and misread as batteries losing money in the BM. */
  const BESS_FAMILY_COLOUR = {
    DC: "#4c86e8", DM: "#20a4a0", DR: "#e8823c",
    BR: "#9b6bd1", QR: "#d4b23c", SR: "#8a93a6",
  };
  const BESS_LIGHT_DIRECTIONS = new Set(["low", "negative"]);
  const BESS_LEG_LABEL = { structural: "Structural", name: "Name",
    "structural+name": "Structural + name" };

  function bessRevenueShade(meta) {
    const base = (meta && BESS_FAMILY_COLOUR[meta.code])
      || css("--text-dim");
    return { color: base,
      opacity: meta && BESS_LIGHT_DIRECTIONS.has(meta.direction)
        ? 0.55 : 0.95 };
  }

  function bessRevenue() {
    const el = document.getElementById("ch-bess-revenue");
    if (!el) return;
    const empty = document.getElementById("bess-revenue-empty");
    const captionEl = document.getElementById("bess-revenue-caption");
    const bmSection = document.getElementById("bess-bm-section");
    const bmCaptionEl = document.getElementById("bess-bm-caption");

    const payload = Data.bessRevenue;
    const ok = !!(payload && Array.isArray(payload.days)
      && payload.days.length && payload.eac_gbp_per_kw_day && payload.bm);
    empty.classList.toggle("hidden", ok);
    el.classList.toggle("hidden", !ok);
    if (bmSection) bmSection.classList.toggle("hidden", !ok);
    if (!ok) {
      if (captionEl) captionEl.textContent = "";
      if (bmCaptionEl) bmCaptionEl.textContent = "";
      ["ch-bess-revenue", "ch-bess-bm"].forEach((id) => {
        const existing = registry.get(id);
        if (existing) existing.clear();
      });
      return;
    }

    // Caption: every number from the payload, mid-dot card-meta idiom —
    // the two D13 coverage figures, both disclosed (denominator MW share
    // AND numerator £ share — the second is the honest one and must not
    // be buried), plus the payload's own source string.
    const cohort = payload.cohort || {};
    const pct1 = (v) => (v == null ? "?" : (100 * v).toFixed(1));
    const fmtMw = (v) => (v == null ? "?"
      : Math.round(v).toLocaleString("en-GB"));
    if (captionEl) {
      // The denominator clause (addendum §A6) mirrors the activity card's
      // own caption so the pair reads as one method: both divide by the
      // capacity first observed active on or before that day, just on
      // two different sources (EAC auction results here, accepted BM
      // volumes there).
      const denomKw = payload.denominator_kw || [];
      const firstDenomMw = denomKw.length ? denomKw[0] / 1000 : null;
      const lastDenomMw = denomKw.length ? denomKw[denomKw.length - 1] / 1000
        : null;
      captionEl.textContent =
        `Identified fleet: ${cohort.units ?? "?"} units, ` +
        `${fmtMw(cohort.mw)} MW (${pct1(cohort.coverage_repd)}% of GB ` +
        `operational BESS, REPD ${cohort.repd_vintage ?? "?"}) · ` +
        `captures ${pct1(cohort.coverage_eac_gross)}% of all EAC ` +
        "battery-labelled £, the remainder earned through aggregator/VLP " +
        `portfolios with no registered nameplate, out of frame · ` +
        "per-kW figures divide each day by the capacity first seen in " +
        `the auction results on or before that day, ${fmtMw(firstDenomMw)} ` +
        `MW rising to ${fmtMw(lastDenomMw)} MW · ${payload.source || ""}`;
    }

    const { fromIso, toIso } = State.window();
    const idx = [];
    payload.days.forEach((d, i) => {
      if (d >= fromIso && d <= toIso) idx.push(i);
    });
    if (!idx.length) {
      chart("ch-bess-revenue").clear();
      chart("ch-bess-bm").clear();
      if (bmCaptionEl) bmCaptionEl.textContent = "";
      return;
    }
    const dayMs = idx.map((i) => Date.parse(payload.days[i] + "T00:00:00Z"));
    const round = (v) => (v == null ? null : +v.toFixed(4));

    const productKeys = Object.keys(payload.eac_gbp_per_kw_day);
    const stackSeries = productKeys.map((k) => {
      const meta = payload.products && payload.products[k];
      const shade = bessRevenueShade(meta);
      const arr = payload.eac_gbp_per_kw_day[k] || [];
      return {
        name: k, type: "bar", stack: "revenue",
        data: idx.map((i, j) => [dayMs[j], round(arr[i])]),
        itemStyle: { color: shade.color, opacity: shade.opacity },
        barMaxWidth: 14,
      };
    });

    // Peer-group overlay: p10-p90 band + p50 line across cohort units, no
    // unit named — same stacked-invisible-line band technique as
    // meritTime's "CCGT SRMC range" above (base series carries the
    // itemStyle colour for its legend swatch; the delta series is
    // tooltip/legend-hidden via its trailing-space name).
    //
    // stackStrategy MUST be "all" here. The band is the base line (p10)
    // plus a stacked delta of (p90 - p10) so the top lands at p90. ECharts'
    // DEFAULT stack strategy is "samesign", which refuses to add a positive
    // delta onto a negative running total and resets it to zero instead —
    // so on any day p10 < 0 (common: DRH clears negative, dragging weak
    // units below zero) the band would render from 0 up to (p90 - p10)
    // rather than from p10 up to p90. "all" always stacks, giving the true
    // p10..p90 span. (meritTime's SRMC band needs no such guard: cost is
    // always >= 0, so its base never goes negative.)
    const spread = payload.eac_unit_spread_gbp_per_kw_day || {};
    const at = (col) => idx.map((i) => (col ? col[i] : null));
    const p10 = at(spread.p10), p90 = at(spread.p90), p50 = at(spread.p50);
    const bandSeries = [
      { name: "Unit spread (p10-p90)", type: "line", stack: "spread",
        stackStrategy: "all",
        showSymbol: false, data: dayMs.map((t, j) => [t, round(p10[j])]),
        lineStyle: { opacity: 0 }, itemStyle: { color: css("--text-dim") } },
      { name: "Unit spread (p10-p90) ", type: "line", stack: "spread",
        stackStrategy: "all",
        showSymbol: false,
        data: dayMs.map((t, j) => [t, (p10[j] == null || p90[j] == null)
          ? null : round(p90[j] - p10[j])]),
        lineStyle: { opacity: 0 },
        areaStyle: { color: css("--text-dim"), opacity: 0.18 },
        itemStyle: { color: css("--text-dim") }, tooltip: { show: false } },
      line("Unit spread (p50)", dayMs, p50.map(round), css("--accent"),
        { lineStyle: { width: 1.4, color: css("--accent"), type: "dashed" } }),
    ];

    chart("ch-bess-revenue").setOption(baseDay({
      legend: legendBar({ data: [...productKeys, "Unit spread (p10-p90)",
        "Unit spread (p50)"] }),
      grid: { left: 60, right: 56, top: 48, bottom: 56 },
      xAxis: timeAxis(),
      // scale: true (from valueAxis) autoscales across zero rather than
      // forcing a symmetric ±max, same rationale as bessActivity's y-axis
      // above: the pitfall this panel exists to avoid is DROPPING or
      // clipping negative bands (DRH clears negative most days), not
      // exact axis symmetry.
      yAxis: valueAxis("£/kW/day"),
      dataZoom: zoom(),
      series: [...stackSeries, ...bandSeries],
    }), true);

    // D18 sub-panel: gross BM cashflow, own heading, own axis pair, never
    // summed into the stack above. Offer/bid bars reuse the BESS family
    // colour and the same opacity-shade idiom bessActivity's own offer/
    // bid bars use (0.9 received, 0.45 paid) — this is the same
    // underlying accepted-volume action, priced instead of in MWh. Net
    // MWh rides a secondary axis so the reader can see the sign of the
    // money follow the sign of the energy directly.
    const bmOffer = idx.map((i) => round(payload.bm.offer_gbp_per_kw_day[i]));
    const bmBid = idx.map((i) => round(payload.bm.bid_gbp_per_kw_day[i]));
    const offerMwh = idx.map((i) => payload.bm.offer_mwh[i] || 0);
    const bidMwh = idx.map((i) => payload.bm.bid_mwh[i] || 0);
    const netMwh = offerMwh.map((o, j) => +(o + bidMwh[j]).toFixed(1));

    if (bmCaptionEl) {
      const sum = (arr) => arr.reduce((s, v) => s + (v || 0), 0);
      const n = bmOffer.length || 1;
      const meanNet = (sum(bmOffer) + sum(bmBid)) / n;
      const state = payload.state || {};
      bmCaptionEl.textContent =
        `Window mean net ${meanNet >= 0 ? "+" : "−"}` +
        `${Math.abs(meanNet).toFixed(4)} £/kW/day · ` +
        `${Math.round(sum(offerMwh)).toLocaleString("en-GB")} MWh offer, ` +
        `${Math.round(sum(bidMwh)).toLocaleString("en-GB")} MWh bid over ` +
        `the range · EBOCF indicative settlement run, current to ` +
        `${state.bm_last_day ?? "?"}`;
    }

    // Left (£/kW/day, the offer/bid bars) and right (MWh, the net line)
    // share one zero baseline — otherwise the two axes autoscale apart and
    // the net-MWh line's zero crossing drifts off the bars' zero, which is
    // exactly the sign relationship this sub-panel exists to show.
    const [bmLeft, bmRight] =
      dualZeroAlign(bmOffer.concat(bmBid), netMwh);
    chart("ch-bess-bm").setOption(baseDay({
      legend: legendBar({ data: ["Offer cashflow (received)",
        "Bid cashflow (paid)", "Net MWh"] }),
      grid: { left: 60, right: 60, top: 48, bottom: 56 },
      xAxis: timeAxis(),
      yAxis: [valueAxis("£/kW/day",
          { min: bmLeft.min, max: bmLeft.max, interval: bmLeft.interval }),
        valueAxis("MWh", { position: "right", splitLine: { show: false },
          min: bmRight.min, max: bmRight.max, interval: bmRight.interval })],
      dataZoom: zoom(),
      series: [
        { name: "Offer cashflow (received)", type: "bar", stack: "bmcf",
          data: dayMs.map((t, j) => [t, bmOffer[j]]),
          itemStyle: { color: Data.FUELS.BESS.colour, opacity: 0.9 },
          barMaxWidth: 14 },
        { name: "Bid cashflow (paid)", type: "bar", stack: "bmcf",
          data: dayMs.map((t, j) => [t, bmBid[j]]),
          itemStyle: { color: Data.FUELS.BESS.colour, opacity: 0.45 },
          barMaxWidth: 14 },
        line("Net MWh", dayMs, netMwh, css("--text-dim"),
          { yAxisIndex: 1, lineStyle: { width: 1.4, color: css("--text-dim"),
            type: "dashed" } }),
      ],
    }), true);
  }

  /* Identified fleet table (user-requested, Batteries tab). Renders from
     the ACTIVITY payload's fleet.list (not bess_revenue.json), so it
     degrades with bessActivity when bess_activity.json is absent — same
     dependency, same failure mode, deliberately no separate fetch.
     Top 10 rows by default with a show-all toggle (the stress tab's
     EMN-notices pattern, in-memory only), plus a substring search over
     unit id, name and owner. An active search overrides the row limit
     and shows every match; the search box lives outside the re-rendered
     table div, so its value survives renders and the visibility pass is
     re-applied after each one. */
  let bessFleetExpanded = false;
  const BESS_FLEET_COLLAPSED_COUNT = 10;
  let bessFleetWired = false;

  function bessFleetApply() {
    const container = document.getElementById("bess-fleet-table");
    const input = document.getElementById("bess-fleet-search");
    const captionEl = document.getElementById("bess-fleet-caption");
    const toggleBtn = document.getElementById("bess-fleet-toggle");
    if (!container || !input) return;
    const q = input.value.trim().toLowerCase();
    const rows = [...container.querySelectorAll("tbody tr")];
    let shown = 0;
    rows.forEach((tr, i) => {
      const hit = !q || tr.textContent.toLowerCase().includes(q);
      const limited = !q && !bessFleetExpanded
        && i >= BESS_FLEET_COLLAPSED_COUNT;
      const visible = hit && !limited;
      tr.classList.toggle("hidden", !visible);
      if (visible) shown++;
    });
    if (toggleBtn) {
      const hiddenCount = rows.length - BESS_FLEET_COLLAPSED_COUNT;
      toggleBtn.classList.toggle("hidden", !!q || hiddenCount <= 0);
      toggleBtn.textContent = bessFleetExpanded
        ? `▴ Show top ${BESS_FLEET_COLLAPSED_COUNT} only`
        : `▾ Show all ${rows.length} units (${hiddenCount} more)`;
    }
    const fleet = Data.bess && Data.bess.fleet;
    if (captionEl && fleet) {
      const mw = fleet.mw == null ? "?"
        : (+fleet.mw).toLocaleString("en-GB");
      captionEl.textContent = `${fleet.units} units, ${mw} MW total ` +
        "identified capacity · sorted by MW descending" +
        (q ? ` · showing ${shown} of ${rows.length}` : "");
    }
  }

  function wireBessFleet() {
    if (bessFleetWired) return;
    const input = document.getElementById("bess-fleet-search");
    const clear = document.getElementById("bess-fleet-search-clear");
    const toggleBtn = document.getElementById("bess-fleet-toggle");
    if (!input || !clear || !toggleBtn) return;
    // Same semantics as ui.js's wireTabSearch (input / Escape / clear),
    // local because the visibility pass targets rows this module
    // re-renders.
    const run = () => {
      clear.classList.toggle("hidden", !input.value);
      bessFleetApply();
    };
    input.addEventListener("input", run);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { input.value = ""; run(); }
    });
    clear.addEventListener("click", () => {
      input.value = ""; run(); input.focus();
    });
    toggleBtn.addEventListener("click", () => {
      bessFleetExpanded = !bessFleetExpanded;
      bessFleetApply();
    });
    bessFleetWired = true;
  }

  function bessFleetTable() {
    const container = document.getElementById("bess-fleet-table");
    if (!container) return;
    const empty = document.getElementById("bess-fleet-empty");
    const captionEl = document.getElementById("bess-fleet-caption");
    const toggleBtn = document.getElementById("bess-fleet-toggle");
    wireBessFleet();

    const payload = Data.bess;
    const fleet = payload && payload.fleet;
    const list = fleet && Array.isArray(fleet.list) ? fleet.list : null;
    const ok = !!(list && list.length);
    empty.classList.toggle("hidden", ok);
    container.classList.toggle("hidden", !ok);
    if (!ok) {
      container.innerHTML = "";
      if (captionEl) captionEl.textContent = "";
      if (toggleBtn) toggleBtn.classList.add("hidden");
      return;
    }

    const num = (v) => (v == null ? "—"
      : (+v).toLocaleString("en-GB", { maximumFractionDigits: 1 }));
    const dateOrDash = (v) => v ?? "—";
    const rows = list.map((u) => `<tr>
        <td>${u.id ?? "—"}</td>
        <td>${u.name ?? "—"}</td>
        <td>${u.party ?? "—"}</td>
        <td class="num">${num(u.cap_mw)}</td>
        <td>${BESS_LEG_LABEL[u.leg] || u.leg || "—"}</td>
        <td>${dateOrDash(u.first_active)}</td>
        <td>${dateOrDash(u.last_active)}</td>
      </tr>`).join("");
    container.innerHTML = `<table class="util-table">
      <thead><tr>
        <th>Unit</th><th>Name</th><th>Owner</th>
        <th class="num">MW</th>
        <th title="How the unit joined the identified fleet: a symmetric
          generation/demand registration (Structural), a battery name
          pattern (Name), or both">Identified by</th>
        <th title="Earliest stored day the unit was observed with a
          non-zero accepted BM volume — the day it enters the per-MW
          normalisation denominator. An em dash means never observed
          dispatched in the stored window.">First dispatched</th>
        <th title="Most recent stored day the unit was observed with a
          non-zero accepted BM volume.">Last dispatched</th>
      </tr></thead>
      <tbody>${rows}</tbody></table>`;
    bessFleetApply();
  }

  /* ===================== BESS profitability calculator =====================
     plan/09, issue #49. v1: hypothetical mode, the engine, the percentile-
     based availability revenue, the TNUoS zone table and CSV export.
     "Pick a unit" ships in v2 (D34) — its radio renders now, disabled,
     with a note, so the card does not silently change shape between
     releases; the acceptance-rate context table and the `units` block
     are v2 too.

     v1.5 (D34 amendment): D26's arbitrage ceiling, pulled forward from
     v2, with its capture rate and manual-spread override
     (bessCalcArbitrage below); D21's six family toggles, reading the
     payload's percentiles.families block (bessCalcFamilyToggles/
     bessCalcAvailabilityGbpPerKwYr); the discounting convention
     (already wired, above this block).

     Data: optional secondary payload app/data/bess_units.json, LAZILY
     fetched on this card's first render (D33) via Data.loadBessUnits(),
     not on page load — the one payload in this app fetched on demand
     rather than eagerly with Data.load(), following the event-slice
     precedent (plan/06 D8). Graceful degradation: a missing/failed
     payload shows this card's own empty state; every other card on the
     tab is unaffected. The arbitrage ceiling's own inputs (s_hi/s_lo)
     come from Data.hh (the eagerly-loaded price series), not from this
     lazy payload, so a missing bess_units.json still blocks the whole
     card exactly as it did before v1.5 — nothing about the arbitrage
     line's data dependency is new. */

  const BESS_FAMILY_CODES = ["DC", "DM", "DR", "BR", "QR", "SR"];
  const BESS_FAMILY_LABELS = {
    DC: "Dynamic Containment (DC)",
    DM: "Dynamic Moderation (DM)",
    DR: "Dynamic Regulation (DR)",
    BR: "Balancing Reserve (BR)",
    QR: "Quick Reserve (QR)",
    SR: "Slow Reserve (SR)",
  };

  let bessCalcWired = false;
  let bessUnitsState = "idle"; // idle | loading | ready | error
  let bessUnitsPayload = null;
  // View toggles (owner decision, 2026-08-01): which alternative RENDERING
  // of already-computed figures is on screen, not an assumption — kept out
  // of State.calc so "Reset to defaults" (which resets assumptions) never
  // touches what the reader is currently looking at.
  let bessCalcSensView = "strip"; // strip | matrix
  let bessCalcChartView = "cashflow"; // cashflow | capacity

  function ensureBessUnitsLoaded() {
    if (bessUnitsState !== "idle") return;
    bessUnitsState = "loading";
    Data.loadBessUnits().then((payload) => {
      bessUnitsPayload = payload;
      bessUnitsState = "ready";
      bessCalculator();
    }).catch((error) => {
      console.error("bess_units.json failed to load:", error);
      bessUnitsState = "error";
      bessCalculator();
    });
  }

  function bessCalcMissingLabels(c) {
    const missing = [];
    if (c.power == null) missing.push("power (MW)");
    if (c.energy == null) missing.push("energy (MWh)");
    if (c.life == null) missing.push("useful life (years)");
    if (c.wacc == null) missing.push("WACC (%)");
    if (c.capex == null) missing.push("CAPEX (£k/MW)");
    return missing;
  }

  function bessCalcZoneTariff(payload, zoneNo) {
    const zones = payload && payload.tnuos && payload.tnuos.zones;
    if (!zones) return null;
    return zones.find((z) => z.n === zoneNo) || null;
  }

  /* D21: this unit's/percentile's family toggle state, keyed by the six
     service-family codes. A family reads "on" (included) unless the
     input has EXPLICITLY been unchecked — undefined (never touched,
     including right after Reset, which drops the key entirely) reads
     as on, so the feature ships with no state.js change: every family
     defaults on without a stored default value anywhere. */
  function bessCalcFamilyToggles(c) {
    const toggles = {};
    BESS_FAMILY_CODES.forEach((f) => { toggles[f] = c[`family${f}`] !== false; });
    return toggles;
  }

  /* D21's family toggles: subtract the OFF families' £/kW/day
     components (percentiles.families[percentileKey], the rank-
     representative additive split — see etl/build_bess_units.py's
     family_percentile_components docstring) from the percentile total
     before annualising. With every family on (the default) this is
     exactly the v1 figure, unchanged. */
  function bessCalcAvailabilityGbpPerKwYr(payload, percentileKey, toggles) {
    const p = payload && payload.percentiles;
    if (!p || p[percentileKey] == null) return null;
    let perDay = p[percentileKey];
    const families = p.families && p.families[percentileKey];
    if (families && toggles) {
      BESS_FAMILY_CODES.forEach((f) => {
        if (toggles[f] === false) perDay -= (families[f] || 0);
      });
    }
    return perDay * 365;
  }

  /* D26's arbitrage ceiling, v1.5 (pulled forward from v2): resolves
     Metrics.bessCashflow's sHi/sLo/k from the card's own inputs.

     Two mutually exclusive sources for the ceiling itself:
       - manual override (c.manualSpread, £/MWh): mirrors the coal-
         price override (app/index.html) exactly — a single flat
         number REPLACES the observed ceiling entirely, fed to the
         engine as sHi=manualSpread/sLo=0 so
         arbitrageCeiling(sHi,sLo,eta) = manualSpread regardless of
         eta. Provenance flips to Assumption (D26).
       - observed (default, no manual override entered): sHi/sLo come
         from Metrics.observedArbitrageSpread over the whole loaded
         price series (Data.hh), at the asset's own duration. Provenance
         is Estimated, and ONLY once a capture rate has been entered —
         D26's honesty constraint 2: no default capture rate ships, so
         an empty field leaves the arbitrage line at zero rather than
         silently assuming a rate.
     `observedFeedActive` (manual override empty AND observed data
     available) is what LCOS's charging-cost term and the "Estimated"
     badge condition on — see bessCalculator() below. */
  function bessCalcArbitrage(c) {
    const duration = c.power && c.energy != null && c.power > 0
      ? c.energy / c.power : null;
    const observed = (Data.hh && Data.hh.t && Data.hh.price && duration)
      ? Metrics.observedArbitrageSpread(Data.hh.t, Data.hh.price, duration)
      : null;
    const manual = c.manualSpread;
    const observedFeedActive = manual == null && observed != null;
    let sHi = null, sLo = null, k = 0;
    if (manual != null) {
      sHi = manual;
      sLo = 0;
      k = c.captureRate != null ? c.captureRate / 100 : 0;
    } else if (observed != null) {
      sHi = observed.sHi;
      sLo = observed.sLo;
      k = c.captureRate != null ? c.captureRate / 100 : 0;
    }
    const contributing = k > 0 && sHi != null;
    return { sHi, sLo, k, duration, observed, manual, observedFeedActive,
            contributing,
            // Estimated only when the observed (not manual) ceiling is
            // the one actually adding a number to the results — the
            // house rule "badge only what is active" (never badge a
            // feature whose capture rate is still blank and whose
            // contribution is a literal zero).
            estimatedActive: observedFeedActive && contributing };
  }

  function bessCalcLoadFactorDefault(c) {
    const duration = c.power && c.energy != null && c.power > 0
      ? c.energy / c.power : 0;
    const cycles = c.cycles != null ? c.cycles : 0;
    return Math.min(1, (cycles * duration) / 24);
  }

  function bessCalcLoadFactor(c) {
    return c.loadFactor != null ? c.loadFactor / 100 : bessCalcLoadFactorDefault(c);
  }

  /* OPEX escalation's shipped DEFAULT (owner request, 2026-08-01): the
     last-published ONS CPI 12-month rate, from the lazily-fetched
     payload's `inflation` block (etl/build_bess_units.py's
     fetch_inflation()) — the same category as the TNUoS zone tariffs
     just above, an OBSERVED statistic, not a forecast, so D23's "no
     INVENTED market default ships" is untouched by this: CPI is not
     assumed, it is what the ONS most recently, verifiably, published.
     Null when the payload has no inflation block (ONS unreachable at
     build time, or the payload predates this feature) — the same
     "no default, not an error" shape a blank load-factor duration
     falls back to. PPI is deliberately never used here even when
     present: the field indexes OPEX, and CPI is the general-goods
     rate the owner asked for as the primary default. */
  function bessCalcOpexEscDefault(payload) {
    return (payload && payload.inflation
           && payload.inflation.cpi_annual_pct != null)
      ? payload.inflation.cpi_annual_pct : null;
  }

  // ONS's own "2026 JUN" period label, reformatted to the house date
  // idiom ("Jun 2026") for the live line and CSV annotation below.
  const ONS_MONTH_ABBR = { JAN: "Jan", FEB: "Feb", MAR: "Mar", APR: "Apr",
    MAY: "May", JUN: "Jun", JUL: "Jul", AUG: "Aug", SEP: "Sep", OCT: "Oct",
    NOV: "Nov", DEC: "Dec" };
  function bessCalcOnsPeriodLabel(period) {
    if (!period) return "";
    const [year, mon] = period.split(" ");
    return `${ONS_MONTH_ABBR[mon] || mon} ${year}`;
  }

  /* Discounting convention (owner request, 2026-07): "mid" (mid-year,
     Metrics.bessCashflow's default) unless the control is explicitly set
     to "end" (end-of-period). Unset/null reads as the default, same
     pattern as every other optional calc field (opex, cycles, etc). */
  function bessCalcDiscounting(c) {
    return c.discounting === "end" ? "end" : "mid";
  }

  /* Owner request, 2026-07: the effective valuation date, resolving
     D30's stated default ("blank defaults to the commissioning date")
     to an actual value the engine can reanchor against. Null when
     neither is set — Metrics.reanchorNpv is null-safe for that case
     and returns the commissioning-anchored NPV unchanged, which is the
     only honest answer when there is no date to anchor against at
     all. */
  function bessCalcEffectiveValuationDate(c) {
    return c.valuationDate || c.commission || null;
  }

  /* The always-visible anchor line (D30-style, mid-dot idiom): states
     what t=0 means for every figure in the results panel below it, so
     the headline NPV is never silently "as of commissioning" the way
     it was before this control existed. Three clauses, each true in
     every state the card can be in:
       - "Discounting anchor": the valuation date in use, or the literal
         word "commissioning" when no valuation date is set (D30's
         default) and there is nothing more specific to name.
       - "t=0 at commissioning <date>": always names the actual
         commissioning date the cash flow itself is built from, or
         "not set" when the card has no commissioning date at all
         (year 1 is then a full calendar year, not a stub).
       - "year 1 = ...": a stub to 31 December of the commissioning
         year when one exists (frac1 < 1), otherwise a full calendar
         year — stated either way rather than assuming the reader
         already knows which applies. */
  function bessCalcAnchorLine(c) {
    const valuationDate = c.valuationDate;
    const commission = c.commission;
    const anchorText = valuationDate ? Metrics.fmtDate(valuationDate) : "commissioning";
    const t0Text = commission ? Metrics.fmtDate(commission) : "not set";
    let year1Text;
    if (commission) {
      const frac1 = Metrics.yearFractionRemaining(commission);
      const year = new Date(commission + "T00:00:00Z").getUTCFullYear();
      year1Text = frac1 < 1
        ? `stub to 31 Dec ${year}` : `full calendar year ${year}`;
    } else {
      year1Text = "full calendar year (no commissioning date set)";
    }
    return `Discounting anchor: ${anchorText} · t=0 at commissioning ` +
      `${t0Text} · year 1 = ${year1Text}`;
  }

  /* The ONE place the entered augmentation year is interpreted (owner
     request, 2026-08-01) — bessCalcEngineInputs, the CSV export and the
     workbook all call this rather than each re-deriving the same
     reading. User-reported: a typed "2030" (a calendar year, the
     natural thing to type) was read as model year 2030, landing nowhere
     inside a 15-year model, and the tranche zeroed with no explanation.
     Two defects, both fixed here: calendar years are now accepted and
     resolved against commissioning, and an unreachable tranche says so
     rather than silently contributing zero.

     Returns { year: <model year int>|null, note: <string|null>,
     warn: <bool> }:
       - blank entry: no event typed, nothing to say.
       - entry < 1000: read as today, a model year (1..T) — unchanged
         behaviour for every value this field has ever actually taken
         before this feature.
       - entry >= 1000: a calendar year, resolved against the
         commissioning date (model year = calendar year - commissioning
         year + 1) and the read-out states the conversion so the
         reader can check it. Without a commissioning date there is
         nothing to anchor a calendar year against, so this warns
         instead of guessing one.
       - any resolved year outside [1, T] (T derived exactly as
         bessCalcEngineInputs derives it, capped at the useful life)
         warns that the tranche never lands — this is also what catches
         a typed MODEL year beyond T, which used to zero silently. */
  function bessCalcAugYearResolved(c) {
    if (c.augYear == null) return { year: null, note: null, warn: false };
    const raw = Math.floor(c.augYear);
    // Same T derivation as bessCalcEngineInputs (life capped period);
    // T is unknown before a useful life is entered, so only the lower
    // bound (year < 1) is enforceable then — the upper bound joins once
    // T exists. Computed up front so both warnings below can name the
    // actual number rather than the letter "T" (owner correction,
    // 2026-08-01 — the reader must see the number, not the variable).
    const T = c.life != null
      ? Math.min(c.period != null ? c.period : c.life, c.life) : null;
    let year, note;
    if (raw < 1000) {
      year = raw;
      note = null;
    } else if (!c.commission) {
      return { year: null, warn: true,
        note: "a calendar year needs a commissioning date to anchor it " +
          `— enter the model year (1..${T != null ? T : "calculation period"}) ` +
          "or set a commissioning date" };
    } else {
      const commissionYear =
        new Date(c.commission + "T00:00:00Z").getUTCFullYear();
      year = raw - commissionYear + 1;
      note = `calendar ${raw} → year ${year} of the model`;
    }
    if (year < 1 || (T != null && year > T)) {
      return { year: null, warn: true,
        note: T != null
          ? `outside the ${T}-year calculation period — the tranche ` +
            "never lands"
          : "before year 1 of the model — the tranche never lands" };
    }
    return { year, note, warn: false };
  }

  /* Assembles Metrics.bessCashflow's input object from State.calc + the
     lazily-fetched payload. Every field NOT in the required-five list
     (D30) falls back to a neutral "nothing assumed" default (0, or the
     calculation period defaulting to the useful life) rather than a
     fabricated market figure — see D23. */
  function bessCalcEngineInputs(c, payload) {
    const P = c.power, E = c.energy, N = c.life, r = c.wacc, C = c.capex;
    if (P == null || E == null || N == null || r == null || C == null) {
      return null;
    }
    // Capped at the useful life (owner review, 2026-08-01): before this,
    // an explicit period longer than the life silently modelled revenue
    // from a decommissioned asset — the life was only ever the DEFAULT
    // for a blank period, never a bound on a typed one. With the stated
    // no-residual, no-decommissioning-cost convention, years past the
    // life are zeros pretending to be analysis, and zeros are not free:
    // MIRR's horizon exponent stretches with T, so phantom years pull it
    // toward WACC. The live line under the field says when the cap bit.
    const T = Math.min(c.period != null ? c.period : N, N);
    const O = c.opex != null ? c.opex : 0;
    const cycles = c.cycles != null ? c.cycles : 0;
    const eta = c.efficiency != null ? c.efficiency / 100 : 0;
    const delta = c.degradation != null ? c.degradation / 100 : 0;
    const gamma = c.cannibalisation != null ? c.cannibalisation / 100 : 0;
    const toggles = bessCalcFamilyToggles(c);
    const a = bessCalcAvailabilityGbpPerKwYr(payload, c.percentile, toggles);
    const f = bessCalcLoadFactor(c);
    let zTotal = 0;
    if (c.connType === "T") {
      const zone = bessCalcZoneTariff(payload, c.zone);
      const z = Metrics.tnuosCharge("T", zone, f);
      zTotal = z != null ? z : 0;
    }
    const arb = bessCalcArbitrage(c);
    // IC-review pass (owner request, 2026-07-31): one optional
    // augmentation event and an own-asset availability derate, both
    // neutral (no-op) when blank — see Metrics.bessCashflow's docstring
    // for the effective-age clock they share. The typed year goes
    // through bessCalcAugYearResolved (owner request, 2026-08-01) —
    // the one place a calendar year is told apart from a model year and
    // an unreachable tranche is caught — rather than the bare
    // Math.floor this line used before that helper existed.
    const augYear = bessCalcAugYearResolved(c).year;
    const augMwh = c.augMwh != null ? c.augMwh : 0;
    const augCostPerMwh = c.augCostMwh != null ? c.augCostMwh : 0;
    const augDelta = c.augDelta != null ? c.augDelta / 100 : null;
    const rho = c.derate != null ? c.derate / 100 : 0;
    // OPEX escalation (owner request, 2026-08-01): blank types through
    // to the shipped ONS CPI default (bessCalcOpexEscDefault) when the
    // payload has one; blank with no default, or an explicitly typed
    // 0, reproduces today's flat OPEX exactly.
    const opexEscDefault = bessCalcOpexEscDefault(payload);
    const opexEsc = c.opexEsc != null ? c.opexEsc / 100
      : (opexEscDefault != null ? opexEscDefault / 100 : 0);
    return { P, E, y0: c.commission || null, T, C, O, r: r / 100, c: cycles,
             delta, eta, a: a != null ? a : 0, gamma, zTotal,
             sHi: arb.sHi, sLo: arb.sLo, k: arb.k,
             discounting: bessCalcDiscounting(c),
             augYear, augMwh, augCostPerMwh, augDelta, rho, opexEsc };
  }

  /* One NPV under one perturbed assumption, through the IDENTICAL chain
     the headline uses: bessCashflow -> npv (same discounting convention,
     same year-1 stub fraction) -> reanchorNpv. `overrides` is shallow-
     merged onto the `inputs` object the headline was built from and is
     never re-derived from State — a second derivation path is a second
     set of conventions waiting to drift, and this one would drift
     silently (the useful-life cap, the augmentation tranche and the
     TNUoS resolution all live in bessCalcEngineInputs). bessCashflow is
     re-run even for a WACC-only perturbation, where the undiscounted
     flows are provably unchanged: one code path is worth four extra
     passes over tens of rows. Null when the perturbed inputs do not
     build a cash flow at all. */
  function bessCalcNpvAt(inputs, overrides, valuationDate) {
    const perturbed = { ...inputs, ...overrides };
    const cf = Metrics.bessCashflow(perturbed);
    if (!cf) return null;
    const cashflows = cf.rows.filter((r) => r.year >= 1)
      .map((r) => r.net_cashflow_gbp);
    const frac1 = Metrics.yearFractionRemaining(perturbed.y0);
    const atCommissioning = Metrics.npv(cf.c0, cashflows, perturbed.r,
      perturbed.discounting, frac1);
    // Re-anchored at the PERTURBED rate: the anchor factor is
    // (1+r)^years, so a WACC case re-anchored at the base rate would be
    // reporting two different rates inside one figure.
    return Metrics.reanchorNpv(atCommissioning, perturbed.r, perturbed.y0,
      valuationDate);
  }

  /* Owner review, 2026-08-01: the four one-assumption sensitivities the
     results panel reports beside the headline NPV — WACC ±2pp, capture
     rate ±10pp. Each is the headline's own inputs object with exactly
     one field replaced, so a sensitivity cannot disagree with the figure
     it is a sensitivity OF.

     A case that cannot be perturbed returns `na` with its reason instead
     of a number, and the reason renders. The arbitrage cases are the
     ones this bites: with no capture rate (D26 ships no default), no
     ceiling, or no cycles, the arbitrage term is not in the headline at
     all, so a chip moving it is a scenario, not a sensitivity — both
     directions then collapse to one "±10pp" chip carrying the reason.
     Clamped steps state the step ACTUALLY applied in their label, so
     "-1.5pp" never masquerades as "-2pp": WACC floors at zero (an
     undiscounted NPV is a real bound, a negative WACC is not) and
     capture caps at 100%. A manual spread override needs no special
     case — the override IS the ceiling the capture rate multiplies. */
  function bessCalcSensitivities(inputs, valuationDate) {
    const npvAt = (o) => bessCalcNpvAt(inputs, o, valuationDate);
    const pp = (v) => String(+v.toFixed(1));
    const out = [];

    const rStep = inputs.r > 0 ? Math.min(0.02, inputs.r) : 0;
    out.push(rStep > 0
      ? { label: `WACC -${pp(rStep * 100)}pp`,
          value: npvAt({ r: inputs.r - rStep }) }
      : { label: "WACC -2pp", na: "WACC is not above zero" });
    out.push({ label: "WACC +2pp", value: npvAt({ r: inputs.r + 0.02 }) });

    const ceiling = Metrics.arbitrageCeiling(inputs.sHi, inputs.sLo, inputs.eta);
    if (!(inputs.k > 0)) {
      out.push({ label: "capture ±10pp", na: "no capture rate set" });
    } else if (ceiling == null) {
      out.push({ label: "capture ±10pp", na: "no arbitrage ceiling in use" });
    } else if (!(inputs.c > 0)) {
      out.push({ label: "capture ±10pp",
                 na: "no cycles per day set, so nothing is discharged" });
    } else {
      const kDown = Math.min(0.10, inputs.k);
      out.push({ label: `capture -${pp(kDown * 100)}pp`,
                 value: npvAt({ k: inputs.k - kDown }) });
      const kUp = inputs.k >= 1 ? 0 : Math.min(0.10, 1 - inputs.k);
      out.push(kUp > 0
        ? { label: `capture +${pp(kUp * 100)}pp`,
            value: npvAt({ k: inputs.k + kUp }) }
        : { label: "capture +10pp", na: "capture rate is already 100%" });
    }
    return out;
  }

  /* One shared £ scale for a set of figures: the unit is chosen once,
     from the largest magnitude in the set, and applied to all of them —
     four chips read against one another must never switch scale
     mid-row. Compact rather than full pounds because the strip's job is
     the SHAPE of the response; the tile above it carries the exact
     number, and the strip's own head restates the base in this same
     unit so the comparison is direct. */
  function bessCalcCompactGbp(values) {
    const max = values.reduce((m, v) =>
      (v == null ? m : Math.max(m, Math.abs(v))), 0);
    const unit = max >= 1e6 ? { d: 1e6, s: "m", dp: 2 }
      : max >= 1e3 ? { d: 1e3, s: "k", dp: 0 }
      : { d: 1, s: "", dp: 0 };
    return (v) => (v == null ? "n/a"
      : (v < 0 ? "-£" : "£")
        + (Math.abs(v) / unit.d).toLocaleString("en-GB",
            { minimumFractionDigits: unit.dp, maximumFractionDigits: unit.dp })
        + unit.s);
  }

  /* The matrix's own cells, built by the IDENTICAL guard conditions and
     reason strings bessCalcSensitivities uses for its capture-rate chip
     (owner decision, 2026-08-01) — the strip and the matrix are two
     renderings of the same "can the capture rate be perturbed at all"
     question, and a reader flipping between them must never see the
     strip say "no cycles per day set" while the matrix says something
     else about the identical inputs. `na` short-circuits before either
     axis is built: a table with nothing on its capture axis is a
     scenario, not a sensitivity, exactly as it is for the chip.

     Axes: WACC floors at zero (an undiscounted NPV is a real bound, a
     negative WACC is not — the same reason the strip's WACC chip
     floors); capture clamps to [0,1]. Both axes de-duplicate their five
     candidate values AFTER clamping, ascending — near a clamp, several
     offsets collapse onto the same boundary value, and repeating that
     value under two labels would dress up one case as two. The result
     is an honestly smaller table (4x5, 3x5) rather than a padded 5x5. */
  function bessCalcSensMatrix(inputs, valuationDate) {
    const ceiling = Metrics.arbitrageCeiling(inputs.sHi, inputs.sLo, inputs.eta);
    const naSentence = (reason) => `The capture-rate axis has nothing to ` +
      `act on — ${reason}. The strip view's WACC chips still apply.`;
    if (!(inputs.k > 0)) return { na: naSentence("no capture rate set") };
    if (ceiling == null) {
      return { na: naSentence("no arbitrage ceiling in use") };
    }
    if (!(inputs.c > 0)) {
      return { na: naSentence(
        "no cycles per day set, so nothing is discharged") };
    }
    // IC-review pass (2026-08-01): nothing upstream constrains a typed
    // WACC or capture rate to the input fields' own min/max — parseFloat
    // takes whatever the reader types, unlike the HTML attributes, which
    // only affect the spinner and validity styling. A base outside
    // [0, inf) WACC or [0, 1] capture cannot be clamped onto its axis
    // and still equal the headline NPV at any cell (findIndex would miss
    // it entirely), so the matrix guards its own domain rather than
    // trust the fields to have done it first.
    if (inputs.r < 0) {
      return { na: "The WACC axis floors at zero — your typed WACC sits " +
        "below that, so the base assumption cannot sit on this table. " +
        "The strip view's WACC chips still apply." };
    }
    if (inputs.k > 1) {
      return { na: "The capture axis caps at 100% — your typed capture " +
        "rate sits above that, so the base assumption cannot sit on " +
        "this table. The strip view's WACC chips still apply." };
    }

    const rVals = [...new Set(
      [-0.02, -0.01, 0, 0.01, 0.02].map((o) => Math.max(0, inputs.r + o)))]
      .sort((a, b) => a - b);
    const kVals = [...new Set(
      [-0.10, -0.05, 0, 0.05, 0.10].map((o) =>
        Math.min(1, Math.max(0, inputs.k + o))))]
      .sort((a, b) => a - b);

    // Same chain as every other figure on this card: bessCalcNpvAt re-runs
    // bessCashflow per cell, so a cell can never disagree with the chain
    // the headline NPV is itself built from. The base cell (rv===r,
    // kv===k) equals the headline NPV by construction, not by a special
    // case — it is simply the (0, 0) offset like any other cell.
    const cells = rVals.map((rv) => kVals.map((kv) =>
      bessCalcNpvAt(inputs, { r: rv, k: kv }, valuationDate)));
    const fmt = bessCalcCompactGbp(cells.flat());
    return { rVals, kVals, cells, fmt,
             baseRIdx: rVals.findIndex((v) => v === inputs.r),
             baseKIdx: kVals.findIndex((v) => v === inputs.k) };
  }

  // Percentage cell/header labels: integer unless a .5pp shows up, in
  // which case one decimal — except the WACC row headers, which always
  // carry one decimal (D20's own "-1.5pp never masquerades as -2pp"
  // discipline: an 8.0% row header must not read as a rounder number
  // than the clamp actually left it).
  function bessCalcPctLabel(v, forceOneDp) {
    const rounded = Math.round(v * 1000) / 10;
    const oneDp = forceOneDp || !Number.isInteger(rounded);
    return `${rounded.toFixed(oneDp ? 1 : 0)}%`;
  }

  function bessCalcSensMatrixHtml(m) {
    const head = m.kVals.map((kv, j) =>
      `<th class="${j === m.baseKIdx ? "csm-base" : ""}">${
        bessCalcPctLabel(kv, false)}</th>`).join("");
    const rows = m.rVals.map((rv, i) => {
      const cells = m.kVals.map((kv, j) => {
        const v = m.cells[i][j];
        const isBase = i === m.baseRIdx && j === m.baseKIdx;
        const neg = v != null && v < 0;
        return `<td class="${isBase ? "csm-basecell" : ""}${
          neg ? " csm-neg" : ""}">${m.fmt(v)}</td>`;
      }).join("");
      return `<tr><th class="${i === m.baseRIdx ? "csm-base" : ""}">${
        bessCalcPctLabel(rv, true)}</th>${cells}</tr>`;
    }).join("");
    return `<div class="calc-sens-matrixwrap"><table class="calc-sens-matrix">` +
      `<thead><tr><th>WACC \\ capture</th>${head}</tr></thead>` +
      `<tbody>${rows}</tbody></table></div>`;
  }

  // Shared segmented control markup for BOTH toggles on this card (D20's
  // .calc-seg) — only the data attribute, the active state and the
  // group's own accessible name differ. `label` names the role="group"
  // for assistive tech, which has no visible legend of its own.
  function bessCalcSegHtml(dataAttr, view, options, label) {
    return `<span class="calc-seg" role="group" aria-label="${label}">${
      options.map((o) => {
      const active = view === o.value;
      return `<button type="button" data-${dataAttr}="${o.value}"${
        active ? ' class="active"' : ""
      } aria-pressed="${active}">${o.label}</button>`;
    }).join("")}</span>`;
  }

  /* Built once and never re-rendered (D30). The <details> captions (D47)
     therefore keep their open state across every subsequent render for
     free — nothing stores it, the DOM is it. */
  function bessCalcInputsHtml() {
    return `
      <div class="calc-field-group">
        <h4>The asset</h4>
        <div class="calc-field">
          <div class="calc-field-label"><span>Power (MW)</span></div>
          <input type="number" data-calc="power" min="0" step="0.1"
            placeholder="e.g. 50">
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Energy (MWh)</span></div>
          <input type="number" data-calc="energy" min="0" step="0.1"
            placeholder="e.g. 100">
          <div class="calc-live" id="calc-duration-live"></div>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Commissioning date</span></div>
          <input type="date" data-calc="commission">
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Useful life (years)</span></div>
          <input type="number" data-calc="life" min="1" step="1"
            placeholder="e.g. 15">
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Calculation period (years)</span></div>
          <input type="number" data-calc="period" min="1" step="1"
            placeholder="defaults to useful life">
          <div class="calc-live" id="calc-period-live"></div>
        </div>
      </div>

      <div class="calc-field-group">
        <h4>Costs and finance</h4>
        <div class="calc-field">
          <div class="calc-field-label"><span>CAPEX (£k/MW)</span></div>
          <input type="number" data-calc="capex" min="0" step="1"
            placeholder="e.g. 450 to 600">
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>OPEX (£k/MW/yr)</span></div>
          <input type="number" data-calc="opex" min="0" step="0.5"
            placeholder="e.g. 10">
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>OPEX escalation
            (%/yr)</span></div>
          <input type="number" data-calc="opexEsc" min="0" step="0.1"
            placeholder="defaults to the ONS CPI rate">
          <div class="calc-live" id="calc-opexesc-live"></div>
          <details class="calc-note-d">
            <summary>What this indexes</summary>
            <div class="calc-note">OPEX only — never TNUoS (a published
              tariff, re-set by NESO each charging year, not an
              assumption this card indexes) and never the augmentation
              tranche's cost (a one-off typed figure at the time it
              lands, not a recurring charge). Blank defaults to the
              last-published ONS CPI 12-month rate (an OBSERVED
              statistic, the same category as the TNUoS zone tariffs
              elsewhere on this card, not a forecast — this ships no
              inflation FORECAST, D23 still holds). Typing any value,
              including 0, overrides that default outright.</div>
          </details>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Augmentation year</span></div>
          <input type="number" data-calc="augYear" min="1" step="1"
            placeholder="e.g. 5">
          <div class="calc-live" id="calc-augyear-live"></div>
          <details class="calc-note-d">
            <summary>Model year or calendar year?</summary>
            <div class="calc-note">Counted from commissioning: year 1 is
              the first modelled year, so "5" lands the tranche at the
              start of the fifth. A calendar year (say 2030) also works
              once a commissioning date is set — the line under the
              field states the conversion in use, and warns when the
              tranche cannot land at all.</div>
          </details>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Augmentation size
            (MWh)</span></div>
          <input type="number" data-calc="augMwh" min="0" step="0.1"
            placeholder="none">
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Augmentation cost
            (£k/MWh)</span></div>
          <input type="number" data-calc="augCostMwh" min="0" step="1"
            placeholder="e.g. 100 to 200">
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>New-cell degradation
            (%/yr)</span></div>
          <input type="number" data-calc="augDelta" min="0" max="20"
            step="0.1" placeholder="defaults to the main rate">
          <details class="calc-note-d">
            <summary>How the augmentation tranche is modelled</summary>
            <div class="calc-note">Optional one-off augmentation, modelled
              as a second cell tranche: the stated MWh of new cells join at
              the start of that year (a partial top-up, a full restore, or
              an expansion beyond nameplate), costed at £k/MWh into that
              year's cash flow and into LCOS. The original cells keep
              degrading on their own clock; the new tranche degrades at its
              own rate, defaulting to the main degradation rate. Year, size
              and cost must all be set to take effect.</div>
          </details>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>WACC (%)</span></div>
          <input type="number" data-calc="wacc" min="0" max="50" step="0.1"
            placeholder="e.g. 8">
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Discounting convention</span></div>
          <select data-calc="discounting">
            <option value="mid" selected>Mid-year (default)</option>
            <option value="end">End-of-period</option>
          </select>
          <details class="calc-note-d">
            <summary>What the two conventions do</summary>
            <div class="calc-note">Mid-year treats each year's cash flow as
              landing at the year's midpoint; end-of-period, on its last
              day. IRR is unaffected; the discounted payback period is not,
              since it interpolates on the discounted cash-flow row. Full
              detail in Methodology.</div>
          </details>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Valuation date</span></div>
          <input type="date" data-calc="valuationDate">
          <div class="calc-live" id="calc-valuationdate-live">Blank defaults
            to the commissioning date.</div>
          <details class="calc-note-d">
            <summary>What re-anchoring moves, and what it does not</summary>
            <div class="calc-note">Re-anchors the NPV to today, or any
              reassessment date, instead of leaving it silently expressed as
              of commissioning: useful for reassessing an asset already in
              the portfolio. A date before commissioning is also allowed (a
              pre-decision appraisal) and works via the same identity. IRR,
              the discounted payback period and LCOS do not move: IRR is
              defined on undiscounted cash flow, payback's crossing test
              and interpolation fraction cancel the same re-anchoring
              factor, and LCOS's numerator and denominator scale together.
              Full detail in Methodology.</div>
          </details>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Connection type</span></div>
          <select data-calc="connType">
            <option value="T">Transmission</option>
            <option value="E">Distribution</option>
          </select>
        </div>
        <div class="calc-field" id="calc-zone-field">
          <div class="calc-field-label"><span>TNUoS zone</span>
            <span class="badge proxy">Reference</span></div>
          <select data-calc="zone" id="calc-zone">
            <option value="1">loading…</option>
          </select>
          <div class="calc-zone-ref" id="calc-zone-ref"></div>
        </div>
        <div class="calc-field calc-field-na" id="calc-notapplicable-field">
          <div class="calc-field-label"><span>TNUoS</span></div>
          <div class="calc-live">Not applicable: distribution-connected
            generation sits outside generation TNUoS post-TCR. The cash
            flow carries a zero TNUoS line.</div>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>TNUoS load factor (%)</span></div>
          <input type="number" data-calc="loadFactor" min="0" max="100"
            step="0.1" placeholder="defaults to cycles x duration / 24">
          <div class="calc-live" id="calc-loadfactor-live"></div>
        </div>
      </div>

      <div class="calc-field-group">
        <h4>Operation</h4>
        <div class="calc-field">
          <div class="calc-field-label"><span>Cycles per day</span></div>
          <input type="number" data-calc="cycles" min="0" max="10" step="0.1"
            placeholder="e.g. 1">
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Round-trip efficiency (%)</span></div>
          <input type="number" data-calc="efficiency" min="0" max="100" step="1"
            placeholder="e.g. 85">
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Degradation (%/yr)</span></div>
          <input type="number" data-calc="degradation" min="0" max="20"
            step="0.1" placeholder="e.g. 2">
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Availability derate
            (%/yr)</span></div>
          <input type="number" data-calc="derate" min="0" max="20"
            step="0.1" placeholder="e.g. 0 to 2">
          <details class="calc-note-d">
            <summary>What this derate covers</summary>
            <div class="calc-note">Your asset's own decline in
              availability-revenue capability as it ages (duration
              eligibility narrowing as energy fades), distinct from the
              market-wide cannibalisation below. Default 0%. Compounds on
              the capacity-weighted cell age, so an augmentation tranche
              rejuvenates it in proportion to its size.</div>
          </details>
        </div>
      </div>

      <div class="calc-field-group">
        <h4>Market view</h4>
        <div class="calc-field">
          <div class="calc-field-label"><span>Availability percentile</span></div>
          <select data-calc="percentile">
            <option value="p10">p10 (bottom decile of units)</option>
            <option value="p25">p25</option>
            <option value="p50" selected>p50 (median unit, default)</option>
            <option value="p75">p75</option>
            <option value="p90">p90 (top decile of units)</option>
          </select>
          <div class="calc-live" id="calc-percentile-live"></div>
          <details class="calc-note-d">
            <summary>How to read these percentiles</summary>
            <div class="calc-note">This is the cross-unit distribution of
              trailing 365-day EAC availability revenue, already averaged over
              the days a unit won nothing. Do not also multiply by an
              acceptance or win rate: that removes the zero days a second time
              and understates the result (measured 58%). These are rank
              percentiles of that cross-unit distribution, not the exceedance
              convention some readers know from energy-yield work, where P90
              means the conservative case: here p90 is the top-decile unit,
              not the one nine years in ten beat.</div>
          </details>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Service families included</span></div>
          <div class="calc-toggle-row">${BESS_FAMILY_CODES.map((f) =>
            `<label title="${BESS_FAMILY_LABELS[f]}">` +
            `<input type="checkbox" data-calc="family${f}" checked> ${f} ` +
            `<span class="fam-value" id="calc-fam-value-${f}"></span>` +
            `</label>`).join("")}</div>
          <details class="calc-note-d">
            <summary>What switching a family off means</summary>
            <div class="calc-note">Each family can be switched off, which
              recomputes the £/kW/yr from that percentile's family
              components. Turning a family off is an assumption about what
              the asset will contract for, not a claim about the data.</div>
          </details>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Cannibalisation (%/yr)</span></div>
          <input type="number" data-calc="cannibalisation" min="0" max="50"
            step="0.5" value="0">
          <details class="calc-note-d">
            <summary>Where this rate is applied</summary>
            <div class="calc-note">Your own view of future market saturation,
              applied to the availability and arbitrage revenue lines every
              year. Default 0%, because the
              calculator has no forecast and no basis for any particular
              value.</div>
          </details>
        </div>
      </div>

      <div class="calc-field-group">
        <h4>Wholesale arbitrage (perfect-foresight ceiling)</h4>
        <div class="calc-field">
          <div class="calc-field-label"><span>Observed spread</span></div>
          <div class="calc-live" id="calc-arb-observed-live"></div>
          <details class="calc-note-d">
            <summary>How the ceiling is measured</summary>
            <div class="calc-note">Mean top-2d and bottom-2d half-hourly
              price per complete day (at least 46 populated half-hours),
              averaged over every complete day already loaded on this
              dashboard, at this asset's own duration. Labelled a
              perfect-foresight ceiling, never arbitrage revenue: a
              construct that never loses money in a year is not a forecast
              of anything. MID is a market-wide index, not a transacted
              price, and diverges from what any single asset actually
              achieves, especially in stressed periods.</div>
          </details>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Capture rate (%)</span></div>
          <input type="number" data-calc="captureRate" min="0" max="100"
            step="1" placeholder="required for arbitrage to contribute">
          <details class="calc-note-d">
            <summary>Why there is no default</summary>
            <div class="calc-note">Multiplies the ceiling above. Left blank,
              the arbitrage line stays at zero rather than assuming a rate
              for you: there is no default capture rate on this card. The
              rate applies to the net margin (after charging cost), which
              is generous at low rates: pick a lower figure to be
              conservative.</div>
          </details>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Manual spread override
            (£/MWh)</span></div>
          <input type="number" data-calc="manualSpread" min="0" step="1"
            placeholder="replaces the observed ceiling entirely">
          <details class="calc-note-d">
            <summary>What the override replaces</summary>
            <div class="calc-note">Mirrors the coal-price override on the
              Spreads tab: a single flat spread you enter replaces the
              observed ceiling entirely, and the capture rate above still
              applies to it. The provenance flips from Estimated to
              Assumption while a value is entered here.</div>
          </details>
        </div>
        <div class="calc-field">
          <div class="calc-field-label"><span>Margin in use</span>
            <span class="badge hidden" id="calc-arb-margin-badge"></span></div>
          <div class="calc-live" id="calc-arb-margin-live"></div>
        </div>
      </div>`;
  }

  function resetBessCalcForm() {
    const inputsEl = document.getElementById("bess-calc-inputs");
    if (!inputsEl) return;
    const defaults = { connType: "T", zone: "1", percentile: "p50",
                      cannibalisation: "0", discounting: "mid" };
    inputsEl.querySelectorAll("[data-calc]").forEach((el) => {
      const key = el.dataset.calc;
      if (el.type === "checkbox") {
        el.checked = true; // every family toggle defaults on (D21)
        return;
      }
      el.value = key in defaults ? defaults[key] : "";
    });
  }

  function wireBessCalc() {
    if (bessCalcWired) return;
    const inputsEl = document.getElementById("bess-calc-inputs");
    if (!inputsEl) return;
    inputsEl.innerHTML = bessCalcInputsHtml();

    inputsEl.addEventListener("input", (event) => {
      const el = event.target;
      const key = el.dataset.calc;
      if (!key) return;
      let value;
      if (el.type === "checkbox") {
        value = el.checked;
      } else if (el.tagName === "SELECT") {
        value = key === "zone" ? parseInt(el.value, 10) : el.value;
      } else if (el.type === "date") {
        value = el.value || null;
      } else {
        value = el.value === "" ? null : parseFloat(el.value);
        if (value != null && Number.isNaN(value)) value = null;
      }
      State.setCalc(key, value);
    });

    const resetBtn = document.getElementById("bess-calc-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        State.resetCalc();
        resetBessCalcForm();
      });
    }
    const csvBtn = document.getElementById("bess-calc-csv");
    if (csvBtn) csvBtn.addEventListener("click", downloadBessCalcCsv);
    const xlsxBtn = document.getElementById("bess-calc-xlsx");
    if (xlsxBtn) xlsxBtn.addEventListener("click", downloadBessCalcXlsx);

    // Both toggle rows are rebuilt/synced on every render, never rebuilt
    // here — delegation on the STATIC parent is what survives that
    // rebuild (D30's own reason for wiring the input container once).
    const sensToggleEl = document.getElementById("bess-calc-sens");
    if (sensToggleEl) {
      sensToggleEl.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-sens-view]");
        if (!btn) return;
        bessCalcSensView = btn.dataset.sensView;
        bessCalculator();
        // bessCalculator() just rebuilt sensToggleEl's innerHTML, which
        // destroyed the button `btn` pointed at and dropped focus to
        // <body> — re-focus its freshly rendered replacement.
        const active = sensToggleEl.querySelector(
          `[data-sens-view="${bessCalcSensView}"]`);
        if (active) active.focus();
      });
    }
    const chartToggleEl = document.getElementById("bess-calc-chart-toggle");
    if (chartToggleEl) {
      chartToggleEl.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-chart-view]");
        if (!btn) return;
        bessCalcChartView = btn.dataset.chartView;
        bessCalculator();
      });
    }

    bessCalcWired = true;
  }

  /* Small read-outs beside the inputs that change on every render without
     touching the input elements themselves (D30's focus-preserving
     requirement — the input container is built ONCE, in wireBessCalc). */
  function updateBessCalcLiveFields(c) {
    const durationEl = document.getElementById("calc-duration-live");
    if (durationEl) {
      const duration = c.power && c.energy != null && c.power > 0
        ? c.energy / c.power : null;
      durationEl.textContent = duration != null
        ? `implied duration: ${duration.toFixed(2)} h` : "";
    }

    // Owner review, 2026-08-01: say when the useful-life cap bit, and —
    // the mirror case — that a deliberately shorter period leaves the
    // remaining life uncredited (no residual value exists to stand in
    // for it). Silence when the period is blank or exactly the life.
    const periodEl = document.getElementById("calc-period-live");
    if (periodEl) {
      let text = "";
      if (c.period != null && c.life != null) {
        if (c.period > c.life) {
          text = `capped at the useful life: ${c.life} years modelled ` +
            "(no revenue survives decommissioning)";
        } else if (c.period < c.life) {
          text = `truncated view: the remaining ${c.life - c.period} ` +
            "years of life earn nothing here and no residual value " +
            "stands in for them";
        }
      }
      periodEl.textContent = text;
    }

    // Owner request, 2026-08-01: the calendar-year conversion (or the
    // warning when the tranche cannot land) states itself here rather
    // than only inside the £0 the chart would otherwise show with no
    // explanation — see bessCalcAugYearResolved, the one place this
    // reading happens. No dedicated warn class exists among the other
    // calc-live lines, so a warning is plain calc-live dim text with an
    // explicit "Warning:" prefix rather than a silent-looking note.
    const augYearLiveEl = document.getElementById("calc-augyear-live");
    if (augYearLiveEl) {
      const resolved = bessCalcAugYearResolved(c);
      augYearLiveEl.textContent = !resolved.note ? ""
        : resolved.warn ? `Warning: ${resolved.note}` : resolved.note;
    }

    const zoneField = document.getElementById("calc-zone-field");
    const naField = document.getElementById("calc-notapplicable-field");
    const isTransmission = c.connType !== "E";
    if (zoneField) zoneField.style.display = isTransmission ? "" : "none";
    if (naField) naField.style.display = isTransmission ? "none" : "";

    const zoneSelect = document.getElementById("calc-zone");
    if (zoneSelect && bessUnitsState === "ready" && !zoneSelect.dataset.populated) {
      const zones = bessUnitsPayload.tnuos.zones;
      zoneSelect.innerHTML = zones.map((z) =>
        `<option value="${z.n}">${z.n}. ${z.name}</option>`).join("");
      zoneSelect.value = String(c.zone);
      zoneSelect.dataset.populated = "1";
    }

    const zoneRefEl = document.getElementById("calc-zone-ref");
    if (zoneRefEl) {
      if (bessUnitsState === "ready" && isTransmission) {
        const zone = bessCalcZoneTariff(bessUnitsPayload, c.zone);
        const f = bessCalcLoadFactor(c);
        zoneRefEl.textContent = zone
          ? `SystemPeak £${zone.peak}/kW · SharedYR £${zone.yr_shared}/kW · ` +
            `NotSharedYR £${zone.yr_notshared}/kW · Residual £${zone.residual}/kW ` +
            `· load factor in use: ${(f * 100).toFixed(1)}%` +
            (c.loadFactor == null ? " (default)" : "")
          : "";
      } else {
        zoneRefEl.textContent = "";
      }
    }

    const loadFactorLiveEl = document.getElementById("calc-loadfactor-live");
    if (loadFactorLiveEl) {
      loadFactorLiveEl.textContent = c.loadFactor == null
        ? `Default: ${(bessCalcLoadFactorDefault(c) * 100).toFixed(1)}% ` +
          "(cycles x duration / 24)" : "";
    }

    /* OPEX escalation's shipped default (owner request, 2026-08-01),
       same blank-field pattern as the load-factor line just above:
       silent once typed (any value, including 0, speaks for itself),
       otherwise either the ONS default with its provenance or the
       plain statement that none was available this build. */
    const opexEscLiveEl = document.getElementById("calc-opexesc-live");
    if (opexEscLiveEl) {
      if (c.opexEsc != null) {
        opexEscLiveEl.textContent = "";
      } else {
        const payload = bessUnitsState === "ready" ? bessUnitsPayload : null;
        const cpiDefault = bessCalcOpexEscDefault(payload);
        if (cpiDefault != null) {
          const inflation = payload.inflation;
          const period = bessCalcOnsPeriodLabel(inflation.cpi_period);
          const ppiPart = inflation.ppi_annual_pct != null
            ? ` · PPI output ${inflation.ppi_annual_pct}%` : "";
          opexEscLiveEl.textContent =
            `Default: ${cpiDefault.toFixed(1)}%/yr — CPI 12-month rate ` +
            `(ONS, ${period})${ppiPart} · type to override`;
        } else {
          opexEscLiveEl.textContent =
            "No ONS rate available — blank means flat.";
        }
      }
    }

    const percentileLiveEl = document.getElementById("calc-percentile-live");
    if (percentileLiveEl) {
      const toggles = bessCalcFamilyToggles(c);
      const perYr = bessUnitsState === "ready"
        ? bessCalcAvailabilityGbpPerKwYr(bessUnitsPayload, c.percentile, toggles)
        : null;
      percentileLiveEl.innerHTML = perYr != null
        ? `<span class="badge observed">Observed</span> ` +
          `${perYr.toFixed(2)} £/kW/yr`
        : "";
    }

    /* Owner request, 2026-07: each family toggle's own label carries its
       current-percentile component, £/kW/yr (component £/kW/day x 365,
       2dp), so a family that is genuinely zero at every shipped
       percentile (BR, SR) reads as inert DATA rather than a suspicious
       blank, and the negative DR at p10 is visible on the toggle itself
       rather than only inside the aggregate. Reads
       percentiles.families[percentile] directly (D33/D36's rank-
       representative additive split, the same source
       bessCalcFamilyAvailabilityColumns and the workbook's family rows
       already use), so this always agrees with what turning the toggle
       off actually subtracts. */
    const families = bessUnitsState === "ready"
      ? bessUnitsPayload.percentiles.families
        && bessUnitsPayload.percentiles.families[c.percentile]
      : null;
    BESS_FAMILY_CODES.forEach((f) => {
      const el = document.getElementById(`calc-fam-value-${f}`);
      if (!el) return;
      if (!families) { el.textContent = ""; return; }
      const perYr = (families[f] || 0) * 365;
      const isZero = Math.abs(perYr) < 0.005; // rounds to 0.00
      el.textContent = `${perYr >= 0 ? "" : "-"}£${Math.abs(perYr).toFixed(2)}/kW/yr`;
      el.classList.toggle("fam-zero", isZero);
    });

    const valuationDateLiveEl = document.getElementById("calc-valuationdate-live");
    if (valuationDateLiveEl) {
      valuationDateLiveEl.textContent = c.valuationDate
        ? `Anchor in use: ${Metrics.fmtDate(c.valuationDate)}`
        : "Blank defaults to the commissioning date" +
          (c.commission ? ` (${Metrics.fmtDate(c.commission)}).` : ".");
    }

    const arb = bessCalcArbitrage(c);
    const arbObservedEl = document.getElementById("calc-arb-observed-live");
    if (arbObservedEl) {
      arbObservedEl.textContent = arb.observed
        ? `s_hi £${arb.observed.sHi.toFixed(2)}/MWh · ` +
          `s_lo £${arb.observed.sLo.toFixed(2)}/MWh · ` +
          `${arb.observed.days} complete days in the loaded window` +
          (arb.duration ? ` at ${arb.duration.toFixed(2)} h duration` : "")
        : (arb.duration
            ? "No complete day found in the loaded price series."
            : "Enter power and energy to compute a duration first.");
    }
    // Owner direction, 2026-07 (superseding the earlier in-text badge):
    // the provenance badge for this line lives in the .calc-field-label
    // row itself, exactly like the TNUoS zone "Reference" badge above —
    // a flex row with the label on one side and the badge on the other,
    // never inside the wrapping live-text paragraph. The live text
    // carries prose only, so it wraps freely with no badge to strand.
    const arbMarginEl = document.getElementById("calc-arb-margin-live");
    const arbMarginBadge = document.getElementById("calc-arb-margin-badge");
    if (arbMarginEl) {
      const eta = c.efficiency != null ? c.efficiency / 100 : 0;
      const ceiling = Metrics.arbitrageCeiling(arb.sHi, arb.sLo, eta);
      if (ceiling == null) {
        arbMarginEl.textContent = (arb.sHi != null && !eta)
          ? "Enter round-trip efficiency to compute the margin."
          : "No ceiling to show yet: enter a manual override above, or " +
            "wait for the observed spread to compute.";
        if (arbMarginBadge) arbMarginBadge.classList.add("hidden");
      } else if (!arb.contributing) {
        arbMarginEl.textContent =
          `£${ceiling.toFixed(2)}/MWh ceiling · not contributing: enter a ` +
          "capture rate above for this line to add anything to the cash flow.";
        if (arbMarginBadge) arbMarginBadge.classList.add("hidden");
      } else {
        const chip = arb.manual != null ? "assumption" : "estimated";
        arbMarginEl.textContent =
          `£${ceiling.toFixed(2)}/MWh margin × ` +
          `${((arb.k || 0) * 100).toFixed(0)}% capture rate` +
          (arb.manual != null
            ? " (manual override spread × your capture rate)"
            : " (observed price spread × your capture rate)");
        if (arbMarginBadge) {
          arbMarginBadge.className = `badge ${chip}`;
          arbMarginBadge.textContent = chip === "assumption" ? "Assumption" : "Estimated";
        }
      }
    }
    // Card-level badge (unchanged behaviour) and the label-row badge
    // above are both driven by the SAME `arb` computed once at the top
    // of this function, so they cannot disagree with one another.
    const estBadge = document.getElementById("bess-calc-badge-estimated");
    if (estBadge) estBadge.classList.toggle("hidden", !arb.estimatedActive);
  }

  /* D21/Part C: per-family availability £, year by year, aligned with
     cf.rows — the same scaling (degradation-free, cannibalisation g and
     the year-1 stub frac) the total availability_gbp column already
     applies, so summing the six family columns on any row reproduces
     that row's availability_gbp exactly. A toggled-off family reads
     zero here too (it is genuinely excluded, not merely hidden), and a
     payload with no percentiles.families block (should not happen once
     the ETL is rerun, but degrades safely) reads zero for every family
     rather than throwing. */
  function bessCalcFamilyAvailabilityColumns(payload, toggles, inputs, rows) {
    const families = payload.percentiles.families
      && payload.percentiles.families[State.get().calc.percentile];
    const gamma = inputs.gamma || 0;
    const frac1 = Metrics.yearFractionRemaining(inputs.y0);
    const out = {};
    BESS_FAMILY_CODES.forEach((f) => { out[f] = []; });
    rows.forEach((row) => {
      const n = row.year;
      if (n === 0 || !families) {
        BESS_FAMILY_CODES.forEach((f) => out[f].push(0));
        return;
      }
      const g = Math.pow(1 - gamma, n - 1);
      const frac = n === 1 ? frac1 : 1;
      BESS_FAMILY_CODES.forEach((f) => {
        const perYr = toggles[f] ? (families[f] || 0) * 365 : 0;
        out[f].push(+(perYr * 1000 * inputs.P * g * frac).toFixed(2));
      });
    });
    return out;
  }

  function downloadBessCalcCsv() {
    const c = State.get().calc;
    if (bessCalcMissingLabels(c).length || bessUnitsState !== "ready") return;
    const inputs = bessCalcEngineInputs(c, bessUnitsPayload);
    const cf = Metrics.bessCashflow(inputs);
    if (!cf) return;

    const columns = { year: [], capex_gbp: [], availability_gbp: [],
      arbitrage_gbp: [], opex_gbp: [], tnuos_gbp: [], net_cashflow_gbp: [],
      discounted_cashflow_gbp: [], cumulative_discounted_gbp: [],
      discharged_mwh: [], usable_mwh: [] };
    cf.rows.forEach((row) => {
      Object.keys(columns).forEach((key) => columns[key].push(row[key]));
    });
    const toggles = bessCalcFamilyToggles(c);
    const familyCols = bessCalcFamilyAvailabilityColumns(
      bessUnitsPayload, toggles, inputs, cf.rows);
    BESS_FAMILY_CODES.forEach((f) => {
      columns[`availability_${f}_gbp`] = familyCols[f];
    });

    const arb = bessCalcArbitrage(c);
    // Owner request, 2026-08-01: the EFFECTIVE OPEX escalation rate —
    // the typed value verbatim, or the shipped ONS CPI default with its
    // provenance stated inline (this line is the only place the export
    // says which one is in force; the workbook's own Source cell does
    // the equivalent job — see field(A.opexEsc, ...) below).
    const opexEscDefaultForCsv = bessCalcOpexEscDefault(bessUnitsPayload);
    const opexEscLine = c.opexEsc != null
      ? `# opex_escalation_pct_per_yr=${c.opexEsc}`
      : opexEscDefaultForCsv != null
        ? `# opex_escalation_pct_per_yr=${opexEscDefaultForCsv.toFixed(1)} ` +
          `(default: CPI 12-month rate, ONS, ${bessUnitsPayload.inflation.cpi_period})`
        : "# opex_escalation_pct_per_yr=not_set";
    // Owner request, 2026-08-01: the RESOLVED model year, through the
    // one helper the engine inputs and the workbook also call — never
    // the raw typed value, which may be a calendar year. When a
    // calendar-year entry actually resolved, the comment line directly
    // after states what was typed, so the export is checkable against
    // the field; an unresolvable entry (no commissioning date to anchor
    // it, or outside the T-year period) exports "not_set" with no such
    // line, same as a blank field.
    const augResolved = bessCalcAugYearResolved(c);
    const augYearIsCalendar = c.augYear != null && Math.floor(c.augYear) >= 1000;
    const augYearLines = [
      `# augmentation_year=${augResolved.year != null ? augResolved.year : "not_set"}`,
    ];
    if (augResolved.year != null && augYearIsCalendar) {
      augYearLines.push(`# augmentation_year_entered=${Math.floor(c.augYear)}`);
    }
    const header = [
      "# BESS profitability calculator export. Illustrative economics from",
      "# the assumptions below, anchored on what comparable units",
      "# observably earned. Not investment advice, not a valuation, and",
      "# not a forecast.",
      `# power_mw=${c.power}`,
      `# energy_mwh=${c.energy}`,
      `# commissioning_date=${c.commission || "not_set"}`,
      `# valuation_date=${c.valuationDate || "commissioning"}`,
      `# useful_life_years=${c.life}`,
      `# calculation_period_years=${inputs.T}`,
      `# capex_gbpk_per_mw=${c.capex}`,
      `# opex_gbpk_per_mw_yr=${c.opex != null ? c.opex : 0}`,
      opexEscLine,
      ...augYearLines,
      `# augmentation_mwh=${c.augMwh != null ? c.augMwh : "not_set"}`,
      `# augmentation_cost_gbpk_per_mwh=${c.augCostMwh != null ? c.augCostMwh : "not_set"}`,
      `# augmentation_degradation_pct_per_yr=${c.augDelta != null
        ? c.augDelta : "defaults_to_degradation"}`,
      `# wacc_pct=${c.wacc}`,
      `# discounting=${bessCalcDiscounting(c)}`,
      `# connection_type=${c.connType}`,
      `# tnuos_zone=${c.connType === "T" ? c.zone : "not_applicable"}`,
      `# tnuos_load_factor_pct=${(bessCalcLoadFactor(c) * 100).toFixed(1)}`,
      `# cycles_per_day=${c.cycles != null ? c.cycles : 0}`,
      `# round_trip_efficiency_pct=${c.efficiency != null ? c.efficiency : 0}`,
      `# degradation_pct_per_yr=${c.degradation != null ? c.degradation : 0}`,
      `# availability_derate_pct_per_yr=${c.derate != null ? c.derate : 0}`,
      `# availability_percentile=${c.percentile}`,
      `# family_toggles=${BESS_FAMILY_CODES.map((f) =>
        `${f}:${toggles[f] ? "on" : "off"}`).join(",")}`,
      `# cannibalisation_pct_per_yr=${c.cannibalisation != null ? c.cannibalisation : 0}`,
      `# s_hi_gbp_per_mwh=${arb.sHi != null ? arb.sHi.toFixed(2) : "not_available"}`,
      `# s_lo_gbp_per_mwh=${arb.sLo != null ? arb.sLo.toFixed(2) : "not_available"}`,
      `# capture_rate_pct=${c.captureRate != null ? c.captureRate : "not_set"}`,
      `# manual_spread_gbp_per_mwh=${c.manualSpread != null ? c.manualSpread : "not_set"}`,
      `# tnuos_charging_year=FY${bessUnitsPayload.tnuos.year_fy}`,
      `# tnuos_publication=${bessUnitsPayload.tnuos.publication}`,
    ].join("\n");

    const csv = header + "\n" + Metrics.toCsv(columns);
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gb_bess_calculator_${c.percentile}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ================= Excel DCF export (plan/09, D35-D40, v1.5) =========
     A second export, beside the CSV above and never instead of it: a
     real .xlsx in which every derived cell is an Excel formula over the
     Assumptions cells, built in memory from the same State.calc/payload
     the CSV reads and handed straight to a Blob download (D30/D35:
     session-only, nothing written to browser storage, nothing retained
     beyond the click). app/js/xlsx.js is the generic writer; everything
     below is the model: which cells exist, what they say, and how they
     reference each other, built fresh on every click so a WACC edit
     between clicks is reflected without any extra wiring.

     Row maps, kept in one object each (per D38's own instruction),
     because every cross-sheet formula below references these numbers
     as strings: get one wrong and the formula silently reads the
     wrong row instead of failing to parse. */

  /* Assumptions-sheet row map. Section header rows carry the section
     number in column A and the bold grey-banded title in column C; field
     rows below carry Metric/Units/Input/Source in C/D/E/F. The six
     family toggles live in column G, not F: F is "Source" for every
     row on this sheet, and the two would otherwise collide on exactly
     the family rows (flagged as an open choice in the M3 build spec;
     this is the "keep Source at F everywhere" branch of it, chosen so
     a reader never has to remember a sheet-local exception). Capture
     rate and manual spread override are BOTH always present, mirroring
     the CSV export's header convention (both `capture_rate_pct=` and
     `manual_spread_gbp_per_mwh=` always emit, the unused one reading
     `not_set`): here the unused one's Source cell reads "not set"
     rather than its Input cell, because an Input cell feeding a live
     formula has to stay numeric for Excel to compute anything, and 0
     is the correct "not contributing" value for either field either
     way (a zero capture rate and a zero override both already mean
     "this line contributes nothing" in the engine itself). */
  /* Rows 17-18 (Valuation date, Re-anchoring factor) are new (owner
     request, 2026-07); every row from the old "Operation" section
     (18) onward shifts down by 2 to make room, inside the Costs and
     finance section they belong to. Nothing on the DCF sheet's own row
     map needs to move for this: DCF references these cells only
     symbolically, via `Assumptions!$E$${A.xxx}`, never a hardcoded
     Assumptions row number, so updating the values below is the whole
     change. */
  /* IC-review pass (owner request, 2026-07-31): Augmentation year/cost
     join "Costs and finance" (rows 15-16) and Availability derate joins
     "Operation" (row 26); every row from WACC onward shifts down by 2
     and everything from the old Market view onward by 3. As before,
     the DCF sheet references these cells only symbolically. */
  /* Named-styles pass (owner's formatted file, 2026-07-31): every row
     moves down by one (the sheet title sits on row 2, not row 1) and
     the section number moves from column A to column B on this sheet,
     both taken from that file. */
  /* Owner's frame revision (2026-08-01), applied on top of the pass
     above and to every sheet BESS_AROW and BESS_DROW cover: blank row
     1 above everything, the section-number gutter at column B (now
     including the DCF sheet, which had kept it at A until this
     revision), and column A left a clean, entirely empty margin. */
  /* OPEX escalation row (owner request, 2026-08-01): joins "Costs and
     finance" directly under OPEX (row 16), so every row from
     Augmentation year onward shifts down by 1. As before, the DCF sheet
     references these cells only symbolically via `Assumptions!$E$${A.xxx}`,
     so this map is the whole change. */
  const BESS_AROW = {
    power: 7, energy: 8, duration: 9, commission: 10, period: 11,
    capex: 14, opex: 15, opexEsc: 16, augYear: 17, augMwh: 18, augCostMwh: 19,
    augDelta: 20, wacc: 21, midflag: 22,
    valuationDate: 23, reanchorFactor: 24,
    cycles: 27, efficiency: 28, degradation: 29, derate: 30,
    fam0: 33, fam5: 38,           // DC, DM, DR, BR, QR, SR occupy 33..38
    famTotal: 40, availRevYr: 41, famPublished: 42, famCheck: 43,
    cannibalisation: 44,
    sHi: 47, sLo: 48, captureRate: 49, manualSpread: 50, margin: 51,
    connType: 54, zone: 55, loadFactor: 56,
    zPeak: 57, zSharedYr: 58, zNotSharedYr: 59, zResidual: 60, zTotal: 61,
  };

  /* DCF-sheet row map, taken from the M3 build spec's own object (its
     section 3) so every formula below is traceable back to it. `gen*`
     covers the six general-assumptions rows (spec's rows 3-8, which
     the spec itself puts in column D rather than E, the single block
     on this sheet that is not part of the year grid).

     Formatting pass, 2026-07-31 (owner request): every section on this
     sheet now gets a full-width numbered section band (bannerXxx
     below), with a blank spacer row above each one, matching the
     reference template's convention (grey since the industry-formatting
     pass later the same day; navy before it). Four of those banners are NEW rows (revenue,
     costs, discounting, checks); the other two (general assumptions,
     headline results) reuse rows that already carried a plain bold
     label (old rows 3 and 44) and did not need to move. Net effect:
     every row from the revenue block onwards shifts down, so npv/irr/
     payback/lcos move from 45-48 to 47-50 and npvAtCommission moves
     from 50 to 54. This BREAKS the previous "DCF!E45..E49 never move"
     guarantee the valuation-date feature relied on (see the old
     comment this replaces) - that guarantee was about not disturbing
     rows for THAT feature specifically, not a permanent promise; every
     reference to these rows in this file is symbolic (D.xxx), and
     tests/test_bess_calculator.py's hardcoded row assertions were
     updated alongside this row map. */
  /* IC-review pass (owner request, 2026-07-31): one NEW row, the
     effective age (years since the later of commissioning and
     augmentation), inserted after the cannibalisation factor — the
     degradation and derate exponents both read it, so the piecewise
     age logic lives in exactly one visible row. Everything from the
     old usable-energy row onward shifts down by 1: npv/irr/payback/
     lcos move from 47-50 to 48-51 and npvAtCommission from 54 to 55.
     tests/test_bess_calculator.py's hardcoded row assertions were
     updated alongside, as with the formatting pass before it. */
  /* Vintage revision + MIRR (owner request, 2026-07-31, second pass):
     the single effective-age row becomes three (original tranche,
     augmentation tranche, capacity-weighted age), and two MIRR helper
     rows plus a MIRR headline join — results now sit at 52-56 and the
     commissioning check at 60. Hardcoded test rows updated alongside,
     as with each previous layout change. */
  /* Named-styles pass: +1 throughout, as on the Assumptions sheet. */
  /* Owner's frame revision (2026-08-01): blank row 1, gutter at column
     B, margin column A - see BESS_AROW's own comment just above; this
     sheet's dcfBanner() is the one place that still wrote its section
     number to column A, and this revision moves it to B alongside. */
  /* Valuation-date-anchored grid pass (owner decision, 2026-08-01): two
     new rows push everything from the header row down by 2 (each is
     documented at its own insertion point below): `genYearsToVal`, a
     general-assumptions row directly beneath "Fraction of year 1
     remaining" that the Discount factor row now subtracts so the year
     grid discounts straight to the valuation date rather than to
     commissioning (the old re-anchoring-factor multiplication on the
     headline is retired in favour of this); and `calYear`, a Calendar
     year row directly beneath the year-number header, styled the same
     way. Net effect: hdr moves from 11 to 12, and every row from
     revBanner onward (old 13-62) moves +2 (new 15-64). See also the
     Total-column insertion in the builder below, which shifts every
     YEAR COLUMN (not row) by one. */
  /* DPP/PVI/DPI pass (owner decision, 2026-08-01): the undiscounted
     `cumcf` row is deleted (the payback flag and headline now test/
     interpolate on `cumpv`/`pv` instead — a discounted payback needs
     no undiscounted cumulative line at all), which frees exactly the
     row a new `pviRow` (the year-by-year present value of investment,
     inserted directly after the MIRR helper rows) needs, so
     resultsBanner and every row through mirrChk keep their PREVIOUS
     absolute row numbers unchanged. Two new headline rows, `pvi` and
     `dpi`, are inserted into the results block after `payback`
     (Discounted payback replaces Simple payback in place), pushing
     `lcos` and everything below it down by 2. */
  const BESS_DROW = {
    genBanner: 4,
    genPeriod: 5, genCommission: 6, genWacc: 7, genMidflag: 8, genFrac1: 9,
    genYearsToVal: 10,
    hdr: 12,
    calYear: 13,
    revBanner: 15, frac: 16, gamma: 17, tr1: 18, tr2: 19, wage: 20,
    usable: 21, discharged: 22,
    avail: 24, arb: 25, rev: 26,
    costsBanner: 28, opex: 29, tnuos: 30, cost: 31,
    netop: 33, capex: 34, netcf: 35,
    discBanner: 37, permid: 38, perend: 39,
    perapp: 40, factor: 41, pv: 42, cumpv: 43,
    flag: 45, factorEnd: 46, charge: 47, lcosCost: 48, lcosEnergy: 49,
    mirrPos: 50, mirrNeg: 51,
    pviRow: 52,
    resultsBanner: 54, npv: 55, irr: 56, mirr: 57, payback: 58,
    pvi: 59, dpi: 60, lcos: 61,
    checksBanner: 63, npvChk: 64,
    npvAtCommission: 65,
    mirrChk: 66,
  };

  function bessColLetter(n) {
    let s = "";
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  /* Role -> style index INTO THE VENDORED TABLE in app/js/xlsx.js,
     which is the owner's own formatted workbook (2026-07-31) verbatim.
     Names below are the owner's named cell styles; the index is the
     cellXf that applies that named style with the number format the
     role needs, read straight off the cells of that file. Change a
     style HERE, never by editing the vendored table. */
  const BESS_XF = {
    title: 1,          // sheet title, bold white on navy
    titlePad: 14,      // navy band continuing past the title cell
    comment: 30,       // ![M]Comment - the standing sentence and notes
    label: 2,          // plain row label (column C)
    labelBold: 3,      // bold row label (key rows, headline results)
    unitsDcf: 7,       // units cell (column D) on the DCF sheet
    unitsAssump: 17,   // units cell (column D) on Assumptions
    unitsBold: 13,     // units cell beside a bold label
    source: 49,        // Assumptions "Source" column, italic grey
    band: 5,           // grey section band
    bandUnitsDcf: 11,  // band, D column on DCF
    bandUnitsAssump: 28,
    bandSource: 11,    // band, F column on Assumptions
    hdr: 6,            // table header, medium rule under
    hdrUnitsDcf: 12,
    hdrUnitsAssump: 27,
    hdrSource: 12,
    inputNum: 36,      // ![M]Input, 1 dp
    inputPct: 37,      // ![M]Input, percent
    inputDate: 51,     // ![M]Input, date
    inputText: 35,     // ![M]Input, text (connection-type code)
    inputYear: 57,     // ![M]Input, integer (appended cellXf) - a year
                       // number, not a magnitude, so no thousands comma
                       // and no decimal place: Augmentation year only.
    hardNum: 39,       // ![M]HardNumber - a hardcoded figure, not typed
    hardNum4dp: 58,    // ![M]HardNumber, 4 dp (appended cellXf) - the
                       // family day-rate cells and the published total,
                       // GBP/kW/day figures too small for 1 dp to show.
    formulaNum: 50,    // ![M]Formula, 1 dp
    formulaNum4dp: 59, // ![M]Formula, 4 dp (appended cellXf) - families
                       // selected, total: same magnitude as hardNum4dp.
    formula2dp: 52,    // ![M]Formula, 2 dp (factors and periods)
    // ![M]KeyOutput with the border overridden OFF and the owner's own
    // key-result grey (appended cellXfs 60-64, owner review 2026-08-01):
    // the vendored named style carries thin rules top and bottom, which
    // the owner removed by hand in every results cell. The named-style
    // link (xfId 11) is kept, so Excel's gallery entry still applies.
    keyNum: 60,        // ![M]KeyOutput, whole numbers - NPV, PVI, LCOS
    keyPct: 61,        // ![M]KeyOutput, percent 1 dp - IRR, MIRR
    keyYears: 62,      // ![M]KeyOutput, 1 dp - DPP, which is in YEARS:
                       // the owner's draft left it on the percent format
                       // inherited from the MIRR row above it, which
                       // would render 6.1 years as "610.0%".
    keyMult: 63,       // ![M]KeyOutput, x multiple - DPI reads "1.6x"
    keyRow: 64,        // ![M]KeyOutput, no fill - the net cash flow year
                       // row, which the owner keeps bold but unfilled:
                       // the grey marks the results block alone.
    linkNum: 47,       // ![M]Link, whole numbers
    linkDate: 53,      // ![M]Link, date
    link1dp: 55,       // ![M]Link, 1 dp
    linkPct: 56,       // ![M]Link, percent 1 dp (appended cellXf)
    percentNamed: 54,  // built-in "Per cent" style (the WACC mirror)
    check: 26,         // ![M]Check
    checkAssump: 29,
    checkMoney: 33,
    checkPct: 34,
    // Cover "Cell style map" swatches, in the owner's own order
    mapHead: 16, mapSub: 19, mapText: 22, mapTextAlt: 23, mapTextKey: 24,
    mapPad: 4, mapBlue: 8, mapGreen: 9, mapFill: 10, mapFillAlt: 25,
    formulaMoney: 40, percentFormula: 41, dateFormula: 42,
    changedFormula: 43, unused: 44, kpi: 45, special: 48, link: 38,
  };

  const BESS_STANDING_SENTENCE =
    "Illustrative economics from the assumptions you enter, anchored on " +
    "what comparable units observably earned. Not investment advice, not " +
    "a valuation, and not a forecast.";

  /* Builds the plain-object workbook model that Xlsx.build() turns into
     bytes (D36/D37/D38). `c` is State.get().calc, `inputs` is
     bessCalcEngineInputs(c, payload), the exact object already handed
     to Metrics.bessCashflow for the chart/headline above, and `payload`
     is bessUnitsPayload. Nothing here calls Metrics.bessCashflow itself:
     every derived cell is an Excel formula, never a value computed in
     JS and printed in (D38's "a cached value is a second source of
     truth" reasoning). */
  function bessCalcWorkbookModel(c, inputs, payload) {
    const S = (v, s = 0) => ({ t: "s", v, s });
    const N = (v, s = 0) => ({ t: "n", v, s });
    const F = (v, s = 0) => ({ t: "f", v, s });

    const A = BESS_AROW, D = BESS_DROW;
    const T = Math.max(1, Math.floor(inputs.T));
    const lastCol = bessColLetter(6 + T);
    const g1 = bessColLetter(7); // first year column, "G" (F is year 0)
    const toggles = bessCalcFamilyToggles(c);
    const arb = bessCalcArbitrage(c);
    const families = payload.percentiles.families
      && payload.percentiles.families[c.percentile];
    const publishedTotal = payload.percentiles[c.percentile];
    const loadFactor = bessCalcLoadFactor(c);
    const zone = c.connType === "T" ? bessCalcZoneTariff(payload, c.zone) : null;

    /* ---------------------------------------------------------- Cover */
    /* Layout and styling are the owner's formatted file (2026-07-31)
       cell for cell: title on row 2, standing sentence on row 4 in
       ![M]Comment, the six headline figures as ![M]Link mirrors of
       the DCF sheet, the stated conventions, then that file's own
       "Cell style map" — the legend that names every style a reader
       will meet, reproduced verbatim so the vocabulary travels with
       the workbook. */
    const cover = {};
    const X = BESS_XF;
    cover.C2 = S("GB battery profitability calculator", X.title);
    // Band extended across the sheet's own used width (owner request,
    // 2026-08-01): D2 already padded the band past the title cell, but
    // stopped there, leaving the navy bar looking cut off against
    // Cover's own cols config (C..G, column B deliberately excluded —
    // see the cols array below). E2/F2/G2 are the same padding style as
    // D2, just carried the rest of the way to the sheet's true right
    // edge, column G.
    cover.D2 = S("", X.titlePad);
    cover.E2 = S("", X.titlePad);
    cover.F2 = S("", X.titlePad);
    cover.G2 = S("", X.titlePad);
    cover.C4 = S(BESS_STANDING_SENTENCE, X.comment);

    cover.C6 = S("NPV at valuation date", X.labelBold);
    cover.E6 = F(`DCF!$E$${D.npv}`, X.linkNum);
    cover.C7 = S("Internal rate of return", X.labelBold);
    cover.E7 = F(`DCF!$E$${D.irr}`, X.linkPct);
    cover.C8 = S("MIRR (reinvestment at WACC)", X.labelBold);
    cover.E8 = F(`DCF!$E$${D.mirr}`, X.linkPct);
    cover.C9 = S("Discounted payback (years)", X.labelBold);
    cover.E9 = F(`DCF!$E$${D.payback}`, X.link1dp);
    cover.C10 = S("Profitability index (DPI)", X.labelBold);
    cover.E10 = F(`DCF!$E$${D.dpi}`, X.link1dp);
    cover.C11 = S("Indicative LCOS (£/MWh)", X.labelBold);
    cover.E11 = F(`DCF!$E$${D.lcos}`, X.linkNum);

    const notes = [
      "Blue cells on a yellow fill are inputs. Every other number is a formula.",
      "Costs are shown as positive numbers and subtracted below. The CSV " +
        "export signs them negative; the magnitudes are the same.",
      "Formulas carry no cached values, so this file recalculates when it " +
        "opens. A reader that does not recalculate should use the CSV export " +
        "instead.",
      "IRR and MIRR are on an end-of-period basis and do not change with the " +
        "discounting convention. MIRR finances and reinvests at WACC, and " +
        "stays single-valued when an augmentation-year outflow gives the cash " +
        "flow a second sign change (plain IRR then has multiple " +
        "mathematically valid roots).",
      "NPV above is expressed at the valuation date (blank defaults to " +
        "commissioning). The year grid discounts straight to the valuation " +
        "date: a discount factor above 1 means that year's cash flow is " +
        "compounded forward to it. The commissioning-anchored figure is kept " +
        "as a check row on the DCF sheet; the CSV export's discounted " +
        "columns remain commissioning-anchored.",
      "Convention: real (uninflated) sterling, pre-tax, ungeared. Enter a " +
        "real pre-tax WACC. No terminal or residual value is included: the " +
        "calculation period is the whole life modelled.",
      "Year 0 and year 1 can share a calendar year: year 0 is the " +
        "commissioning instant, year 1 the remainder of that calendar year.",
      "TNUoS is held flat at the stated charging year's tariffs for the whole " +
        "calculation period; real tariffs reset every charging year.",
      "The cash flow carries no charging-cost line: the arbitrage margin is " +
        "net of charging (s_hi less s_lo / eta), and cycling attributed to " +
        "availability services is treated as energy-neutral. LCOS, by " +
        "contrast, prices every discharged MWh's charge at s_lo.",
      `Data window: ${payload.window.from} to ${payload.window.to}`,
      `Calculator support data built: ${payload.built_at}`,
      `TNUoS charging year: FY${payload.tnuos.year_fy} ` +
        `${payload.tnuos.publication}, published ${payload.tnuos.published}`,
      `Availability percentile in use: ${c.percentile}`,
      `Valuation date in use: ${c.valuationDate || "commissioning"}`,
    ];
    // Owner's frame revision (2026-08-01, PVI/DPI pass): the headline
    // block grew a sixth row (C6-C11, was C6-C10), so notes and
    // everything below it shift down by 1 to keep the blank spacer row
    // between the headline block and the notes.
    notes.forEach((text, i) => { cover["C" + (13 + i)] = S(text, X.comment); });

    /* The owner's "Cell style map", verbatim: a swatch cell in column C
       carrying the style, its plain-English name in column D. Kept
       complete rather than trimmed to the styles this export happens to
       use, because it is the house vocabulary, not a key to this one
       file. `mapRow` writes both cells; the swatch is a real value or
       formula so the number format shows too. */
    const mapTop = 13 + notes.length + 1;
    const mapRow = (row, swatch, text, textStyle) => {
      if (swatch) cover["C" + row] = swatch;
      cover["D" + row] = S(text, textStyle == null ? X.mapText : textStyle);
    };
    cover["C" + mapTop] = S("Cell style map", X.labelBold);
    let r = mapTop + 2;
    cover["C" + r] = S("Inputs and references to them", X.mapHead);
    cover["D" + r] = S("", X.mapSub); cover["E" + r] = S("", X.mapSub);
    mapRow(r + 1, N(100, X.inputNum), "Input data (as value)");
    mapRow(r + 2, N(0.1, X.inputPct), "Input data (as percent)");
    mapRow(r + 3, N(0.05, X.inputPct), "Links to external files");
    mapRow(r + 4, F("C" + (r + 1), X.link), "Assumption by reference");
    mapRow(r + 5, N(50, X.hardNum), "Hard number");
    r += 7;
    cover["C" + r] = S("Calculations", X.mapHead);
    cover["D" + r] = S("", X.mapTextAlt);
    mapRow(r + 1, F(`C${mapTop + 3}*(1+C${mapTop + 5})`, X.formulaMoney),
      "Formula: number");
    mapRow(r + 2, F("C" + (mapTop + 5), X.percentFormula), "Formula: percentage");
    mapRow(r + 3, N(Xlsx.dateSerial("2023-01-01"), X.dateFormula), "Formula: date");
    mapRow(r + 4, F(`C${mapTop + 3}*(1+C${mapTop + 5})^(1/2)`, X.changedFormula),
      "Formula changed in row");
    mapRow(r + 5, S("", X.unused), "Unused cell");
    mapRow(r + 6, F(`C${r + 4}/C${r + 1}-1`, X.kpi),
      "Reference metric (growth, profitability)");
    r += 8;
    cover["C" + r] = S("Other", X.mapHead);
    cover["D" + r] = S("", X.mapTextAlt);
    mapRow(r + 1, F("C" + (r - 7), X.keyNum), "Key result", X.mapTextKey);
    mapRow(r + 2, F("C" + (r - 7), X.special), "Special cell");
    mapRow(r + 3, S("ok", X.check), "Check");
    r += 5;
    cover["C" + r] = S("blue color", X.mapPad);
    cover["D" + r] = S("#0432FF", X.mapBlue);
    cover["C" + (r + 1)] = S("green color", X.mapPad);
    cover["D" + (r + 1)] = S("#00B050", X.mapGreen);
    cover["C" + (r + 2)] = S("filling color", X.mapPad);
    cover["D" + (r + 2)] = S("#FFF2CC", X.mapFill);
    cover["C" + (r + 3)] = S("filling color", X.mapPad);
    cover["D" + (r + 3)] = S("#90D5FF", X.mapFillAlt);

    /* ----------------------------------------------------- Assumptions */
    const a = {};
    a.C2 = S("Assumptions", X.title);
    // Band extended to match the sheet's own section() bands (owner
    // request, 2026-08-01): the title used to be C2 alone, stopping
    // visibly short of the Source column while every numbered section
    // band below it (section(), just below) already spans B..G — the
    // title now shares that same right edge, and the same left edge
    // (B), so every band on this sheet lines up. X.titlePad is the
    // navy-band-with-no-text style Cover's own D2 already uses for
    // exactly this purpose.
    a.B2 = S("", X.titlePad);
    a.D2 = S("", X.titlePad);
    a.E2 = S("", X.titlePad);
    a.F2 = S("", X.titlePad);
    a.G2 = S("", X.titlePad);
    a.C4 = S("Metric", X.hdr); a.D4 = S("Units", X.hdrUnitsAssump);
    a.E4 = S("Input", X.hdr); a.F4 = S("Source", X.hdrSource);

    // Grey section band, with the section number in column B (the
    // owner's formatted file puts it there on this sheet, and in
    // column A on the DCF sheet).
    const section = (row, num, title) => {
      a["B" + row] = N(num, X.band);
      a["C" + row] = S(title, X.band);
      a["D" + row] = S("", X.bandUnitsAssump);
      a["E" + row] = S("", X.band);
      a["F" + row] = S("", X.bandSource);
      a["G" + row] = S("", X.band);
    };
    const field = (row, label, unit, value, source) => {
      a["C" + row] = S(label, X.label);
      a["D" + row] = S(unit, X.unitsAssump);
      a["E" + row] = value;
      a["F" + row] = S(source, X.source);
    };

    section(6, 1, "The asset");
    field(A.power, "Power", "MW", N(c.power != null ? c.power : 0, X.inputNum), "assumption");
    field(A.energy, "Energy", "MWh", N(c.energy != null ? c.energy : 0, X.inputNum), "assumption");
    field(A.duration, "Duration", "h", F(`$E$${A.energy}/$E$${A.power}`, X.formulaNum), "derived");
    field(A.commission, "Commissioning date", "date",
      c.commission ? N(Xlsx.dateSerial(c.commission), X.inputDate) : S("", X.inputDate),
      c.commission ? "assumption" : "not set");
    field(A.period, "Calculation period", "years", N(T, X.inputNum), "assumption");

    section(13, 2, "Costs and finance");
    field(A.capex, "Capital cost", "GBPk/MW", N(c.capex != null ? c.capex : 0, X.inputNum), "assumption");
    field(A.opex, "Operating cost", "GBPk/MW/yr", N(c.opex != null ? c.opex : 0, X.inputNum), "assumption");
    // OPEX escalation (owner request, 2026-08-01): the EFFECTIVE rate —
    // typed, or the shipped ONS CPI default (bessCalcOpexEscDefault) —
    // so the DCF opex formula's POWER() term always has a real number
    // to raise, never a blank standing in for zero. Source cell says
    // "default" (an OBSERVED ONS statistic, not a market assumption)
    // exactly as the load-factor row's "derived" states its own
    // fallback provenance; blank/0 either way keeps POWER()'s exponent
    // base at 1, i.e. today's flat behaviour.
    const opexEscDefaultForWb = bessCalcOpexEscDefault(payload);
    const opexEscEffective = c.opexEsc != null ? c.opexEsc / 100
      : (opexEscDefaultForWb != null ? opexEscDefaultForWb / 100 : 0);
    field(A.opexEsc, "OPEX escalation", "%/yr",
      N(opexEscEffective, X.inputPct),
      c.opexEsc != null ? "assumption"
        : (opexEscDefaultForWb != null ? "default" : "not set"));
    // IC-review pass (owner request, 2026-07-31): one optional
    // augmentation event. A blank year cell (like the blank dates
    // above) keeps every age formula on the no-augmentation branch.
    // Owner's frame revision (2026-08-01): the typed value is a year
    // NUMBER (e.g. 5), not a magnitude, so it gets the integer input
    // variant (no thousands comma, no decimal place) rather than the
    // 1 dp style every other typed input on this sheet uses; the blank
    // case is unaffected and keeps the ordinary blank input style.
    // Calendar-year resolution (owner request, 2026-08-01): the SAME
    // bessCalcAugYearResolved the CSV export and bessCalcEngineInputs
    // use — the workbook's Input cell is the resolved MODEL year, never
    // the raw typed value, so a typed "2030" and a typed "5" that
    // resolve to the same model year drive the same formula. An
    // unresolvable entry (no commissioning date to anchor a calendar
    // year, or outside the T-year period) reads as "not set", same
    // blank-cell behaviour as before this feature.
    const augResolvedWb = bessCalcAugYearResolved(c);
    field(A.augYear, "Augmentation year", "year no.",
      augResolvedWb.year != null ? N(augResolvedWb.year, X.inputYear) : S("", X.inputNum),
      augResolvedWb.year != null ? "assumption" : "not set");
    field(A.augMwh, "Augmentation size", "MWh",
      N(c.augMwh != null ? c.augMwh : 0, X.inputNum),
      c.augMwh != null ? "assumption" : "not set");
    field(A.augCostMwh, "Augmentation cost", "GBPk/MWh",
      N(c.augCostMwh != null ? c.augCostMwh : 0, X.inputNum),
      c.augCostMwh != null ? "assumption" : "not set");
    // Holds the EFFECTIVE rate (the main degradation rate when the
    // field is blank), so every tranche formula reads one cell — same
    // always-numeric discipline as the capture-rate cell.
    field(A.augDelta, "Augmentation tranche degradation", "%/yr",
      N(c.augDelta != null ? c.augDelta / 100 : inputs.delta, X.inputPct),
      c.augDelta != null ? "assumption" : "defaults to energy degradation");
    field(A.wacc, "Discount rate (WACC)", "%", N(inputs.r, X.inputPct), "assumption");
    field(A.midflag, "Mid-year discounting (1 = yes, 0 = end of period)", "flag",
      N(bessCalcDiscounting(c) === "mid" ? 1 : 0, X.inputNum), "assumption");
    // Owner request, 2026-07: valuation date and its re-anchoring
    // factor, mirroring Metrics.reanchorNpv exactly. Blank valuation
    // date -> factor 1 (defaults to commissioning, D30); blank
    // commissioning date -> factor 1 too (there is no reference date to
    // measure a span against, matching reanchorNpv's own null-safety).
    // Nested IF rather than OR: the workbook's closed evaluator grammar
    // (ops/xlsx_eval.py) supports both, but nested IF keeps this
    // formula identical in shape to every other blank-guard in this
    // sheet (e.g. A.zTotal's IF just below).
    field(A.valuationDate, "Valuation date", "date",
      c.valuationDate ? N(Xlsx.dateSerial(c.valuationDate), X.inputDate) : S("", X.inputDate),
      c.valuationDate ? "assumption" : "not set (defaults to commissioning)");
    field(A.reanchorFactor, "Re-anchoring factor, commissioning to valuation date", "x",
      F(`IF($E$${A.valuationDate}="",1,IF($E$${A.commission}="",1,` +
        `(1+WACC)^(($E$${A.valuationDate}-$E$${A.commission})/365.25)))`, X.formulaNum),
      "derived");

    section(26, 3, "Operation");
    field(A.cycles, "Cycles per day", "count",
      N(c.cycles != null ? c.cycles : 0, X.inputNum), "assumption");
    field(A.efficiency, "Round-trip efficiency", "%", N(inputs.eta, X.inputPct),
      "assumption");
    field(A.degradation, "Energy degradation", "%/yr", N(inputs.delta, X.inputPct),
      "assumption");
    field(A.derate, "Availability derate", "%/yr", N(inputs.rho, X.inputPct),
      c.derate != null ? "assumption" : "not set");

    section(32, 4, "Market view");
    // Owner request, 2026-07: these six family values and the published
    // total below are figures the dashboard measured (ETL-built from the
    // BMRS EAC auction data), never typed in and never a formula on this
    // sheet, so they get the legend's "value from the dashboard's
    // observed data" style (navy text, style 12) rather than the blue-
    // on-yellow input style: that style means "type your own number
    // here", which is not true of any cell in this block.
    // Owner's frame revision (2026-08-01): these seven cells (the six
    // families and the published total just below) are GBP/kW/day
    // figures small enough that 1 dp renders as "0.0" - they get the 4
    // dp observed variant instead. The TNUoS zone tariff cells further
    // down keep the ordinary 1 dp observed style unchanged: those are
    // GBP/kW, a different, larger magnitude.
    BESS_FAMILY_CODES.forEach((fam, i) => {
      const row = A.fam0 + i;
      field(row, BESS_FAMILY_LABELS[fam], "GBP/kW/day",
        N(families ? (families[fam] || 0) : 0, X.hardNum4dp), "observed");
      a["G" + row] = N(toggles[fam] ? 1 : 0, X.inputNum);
    });
    field(A.famTotal, "Families selected, total", "GBP/kW/day",
      F(`SUMPRODUCT($E$${A.fam0}:$E$${A.fam5},$G$${A.fam0}:$G$${A.fam5})`, X.formulaNum4dp), "derived");
    field(A.availRevYr, "Availability revenue", "GBP/kW/yr",
      F(`$E$${A.famTotal}*365`, X.formulaNum), "derived");
    field(A.famPublished, "Published total, all families", "GBP/kW/day",
      N(publishedTotal != null ? publishedTotal : 0, X.hardNum4dp), "observed");
    field(A.famCheck, "Check: families reconcile to the published total", "",
      F(`IF(ROUND(SUM($E$${A.fam0}:$E$${A.fam5})-$E$${A.famPublished},6)=0,` +
        '"ok","check the family split")', X.checkAssump), "derived");
    field(A.cannibalisation, "Cannibalisation", "%/yr", N(inputs.gamma, X.inputPct),
      "assumption");

    section(46, 5, "Arbitrage");
    const arbSource = arb.manual != null ? "assumption"
      : (arb.observed != null ? "observed" : "not set");
    field(A.sHi, "Top-of-day price (s_hi)", "GBP/MWh",
      N(arb.sHi != null ? arb.sHi : 0, X.hardNum), arbSource);
    field(A.sLo, "Bottom-of-day price (s_lo)", "GBP/MWh",
      N(arb.sLo != null ? arb.sLo : 0, X.hardNum), arbSource);
    field(A.captureRate, "Arbitrage capture rate", "%",
      N(c.captureRate != null ? c.captureRate / 100 : 0, X.inputPct),
      c.captureRate != null ? "assumption" : "not set");
    field(A.manualSpread, "Manual spread override", "GBP/MWh",
      N(c.manualSpread != null ? c.manualSpread : 0, X.inputNum),
      c.manualSpread != null ? "assumption" : "not set");
    field(A.margin, "Arbitrage margin, s_hi less s_lo / eta", "GBP/MWh",
      F(`IFERROR($E$${A.sHi}-$E$${A.sLo}/$E$${A.efficiency},0)`, X.formulaNum), "derived");

    section(53, 6, "Network");
    field(A.connType, "Connection type (T = transmission, E = distribution)",
      "code", S(c.connType, X.inputText), "observed");
    field(A.zone, "TNUoS zone", "no.", N(c.zone != null ? c.zone : 1, X.inputNum),
      "reference");
    field(A.loadFactor, "TNUoS load factor", "%", N(loadFactor, X.inputPct),
      c.loadFactor != null ? "assumption" : "derived");
    // TNUoS tariffs looked up from the zone table: also "value from the
    // dashboard's observed data" (style 12), not a typed input.
    field(A.zPeak, "SystemPeak", "GBP/kW", N(zone ? zone.peak : 0, X.hardNum), "reference");
    field(A.zSharedYr, "SharedYearRound", "GBP/kW", N(zone ? zone.yr_shared : 0, X.hardNum), "reference");
    field(A.zNotSharedYr, "NotSharedYearRound", "GBP/kW",
      N(zone ? zone.yr_notshared : 0, X.hardNum), "reference");
    field(A.zResidual, "Residual", "GBP/kW", N(zone ? zone.residual : 0, X.hardNum), "reference");
    field(A.zTotal, "Zone total", "GBP/kW",
      F(`IF($E$${A.connType}="E","not applicable",` +
        `$E$${A.zPeak}+$E$${A.loadFactor}*($E$${A.zSharedYr}+$E$${A.zNotSharedYr})` +
        `+$E$${A.zResidual})`, X.formulaNum), "derived");

    /* ------------------------------------------------------------ DCF */
    const d = {};
    d.C2 = S("DCF", X.title);
    // Band extended to the sheet's true last column, lastCol = 6+T
    // (owner request, 2026-08-01): a lone D2 padding cell left the navy
    // title bar stopping four columns short of the year grid it sits
    // above. Looped, not hand-listed like Cover's/Assumptions' own
    // title padding, because T (the calculation period) sets this
    // sheet's width — unlike Cover/Assumptions, which are fixed.
    for (let col = 4; col <= 6 + T; col++) {
      d[bessColLetter(col) + "2"] = S("", X.titlePad);
    }

    /* Full-width section band (industry-formatting pass, 2026-07-31:
       the reference template's numbered, bold-on-light-grey section
       header) so a reader scrolling the grid always has a visible break
       between sections. The navy style 2 is now reserved for the sheet
       title alone, as in the template. Owner's frame revision
       (2026-08-01): the running section number moves from column A to
       column B, matching the Assumptions sheet's section() helper —
       column A carries nothing anywhere on this sheet now, and the band
       spans B..lastCol rather than A..lastCol.

       Comment correction (owner request, 2026-08-01): this used to say
       a "Total column insertion" had moved lastCol one column right of
       6+T, implying the loop below was a column short. That Total
       column does not exist — see the Headline NPV pass comment by
       D.pv, which removed it as a hand-edit bug (a second SUM cell
       duplicating the row's own SUM(F:lastCol) formula) — so lastCol
       IS 6+T, exactly what the loop already uses, and always has been
       since that fix. Verified empirically (2026-08-01) against a built
       workbook: the year-header row's own last populated column and
       this loop's last column are identical for every T tried. Nothing
       here needed a functional change; only this comment was stale. */
    const dcfBanner = (row, num, title) => {
      for (let col = 2; col <= 6 + T; col++) {
        const ref = bessColLetter(col) + row;
        if (col === 2) d[ref] = N(num, X.band);
        else if (col === 3) d[ref] = S(title, X.band);
        else if (col === 4) d[ref] = S("", X.bandUnitsDcf);
        else d[ref] = S("", X.band);
      }
    };

    dcfBanner(D.genBanner, 1, "General assumptions");
    // Owner request, 2026-07: these four are PURE `=Assumptions!$E$...`
    // links (nothing computed here), so they take the green "reference
    // to another sheet" style, not the black formula style a same-sheet
    // calculation would use. genFrac1 just below stays black: its
    // formula uses DATE/YEAR over $D$genCommission, a cell on THIS
    // sheet, so it is a same-sheet formula, not a cross-sheet reference.
    d["C" + D.genPeriod] = S("Calculation period", X.label);
    d["D" + D.genPeriod] = F(`Assumptions!$E$${A.period}`, X.linkNum);
    d["C" + D.genCommission] = S("Commissioning date", X.label);
    d["D" + D.genCommission] = F(`Assumptions!$E$${A.commission}`, X.linkDate);
    d["C" + D.genWacc] = S("Discount rate (WACC)", X.label);
    d["D" + D.genWacc] = F(`Assumptions!$E$${A.wacc}`, X.percentNamed);
    d["C" + D.genMidflag] = S("Mid-year discounting flag", X.label);
    d["D" + D.genMidflag] = F(`Assumptions!$E$${A.midflag}`, X.link1dp);
    d["C" + D.genFrac1] = S("Fraction of year 1 remaining", X.label);
    d["D" + D.genFrac1] = F(
      `IF($D$${D.genCommission}="",1,` +
      `(DATE(YEAR($D$${D.genCommission})+1,1,1)-$D$${D.genCommission})/` +
      `(DATE(YEAR($D$${D.genCommission})+1,1,1)-DATE(YEAR($D$${D.genCommission}),1,1)))`,
      X.formulaNum);
    // Valuation-date-anchored grid pass (owner decision, 2026-08-01):
    // the span, in years, from commissioning to the valuation date -
    // zero when either date is blank, the same null-safety the
    // re-anchoring factor cell on Assumptions uses. The Discount
    // factor row below subtracts this from every year's discount
    // period, so the grid itself anchors at the valuation date rather
    // than at commissioning (the headline no longer needs to multiply
    // by a separate re-anchoring factor after the fact).
    d["C" + D.genYearsToVal] = S("Years, commissioning to valuation date", X.label);
    d["D" + D.genYearsToVal] = F(
      `IF(Assumptions!$E$${A.valuationDate}="",0,IF($D$${D.genCommission}="",0,` +
      `(Assumptions!$E$${A.valuationDate}-$D$${D.genCommission})/365.25))`,
      X.formulaNum);

    d["C" + D.hdr] = S("Metric", X.hdr); d["D" + D.hdr] = S("Units", X.hdrUnitsDcf);
    d["E" + D.hdr] = S("Input", X.hdr); d["F" + D.hdr] = N(0, X.hdr);
    for (let n = 1; n <= T; n++) {
      const col = bessColLetter(6 + n), prev = bessColLetter(5 + n);
      d[col + D.hdr] = F(`${prev}${D.hdr}+1`, X.hdr);
    }

    // Calendar year row (owner decision, 2026-08-01): directly beneath
    // the year-number header, same header-band style, so a reader can
    // map a year column to a calendar year without counting across the
    // grid. Year 0 and the year-1 stub deliberately share the
    // commissioning calendar year (year 0 is not "the year before
    // commissioning"); every later column adds the header's own year
    // number less one.
    d["C" + D.calYear] = S("Calendar year", X.hdr);
    d["D" + D.calYear] = S("", X.hdrUnitsDcf);
    // The Input column carries no calendar year, but it must still carry
    // the band's rule: an unwritten cell breaks the medium underline
    // between Units and year 0 (owner review, 2026-08-01).
    d["E" + D.calYear] = S("", X.hdr);
    d["F" + D.calYear] = F(
      `IF($D$${D.genCommission}="","",YEAR($D$${D.genCommission}))`, X.hdr);
    for (let n = 1; n <= T; n++) {
      const col = bessColLetter(6 + n);
      d[col + D.calYear] = F(
        `IF($D$${D.genCommission}="","",YEAR($D$${D.genCommission})+${col}$${D.hdr}-1)`,
        X.hdr);
    }

    /* Year rows sharing one shape: label/unit in C/D, a literal at F
       (year 0) and one formula template applied across G..last (years
       1..T). `f0` may be a plain number (every current caller: year 0
       has no operating activity on these rows) or a formula-typed cell
       object for a row whose year-0 value is itself a formula over
       that same column's other rows — every row that actually needs
       that (discount factor, PV, cumulative PV, capex, net cash flow,
       the MIRR legs) is hand-coded below instead, precisely so its
       year-0 formula sits visibly beside its own C/D label rather than
       hidden in a function argument; this branch exists for symmetry
       with those, not because a caller currently uses it. */
    const yearRow = (row, label, unit, template, style, f0) => {
      d["C" + row] = S(label, X.label);
      d["D" + row] = S(unit, X.unitsDcf);
      // Year 0 is a hardcoded literal on the operating rows (![M]HardNumber),
      // not a formula, and the owner's file styles it as one.
      d["F" + row] = (f0 && f0.t) ? f0 : N(f0 || 0, X.hardNum);
      for (let n = 1; n <= T; n++) {
        const col = bessColLetter(6 + n);
        d[col + row] = F(template(col), style);
      }
    };

    dcfBanner(D.revBanner, 2, "Revenue build-up");
    yearRow(D.frac, "Year fraction", "x",
      (col) => `IF(${col}$${D.hdr}=1,$D$${D.genFrac1},1)`, X.formula2dp, 0);
    yearRow(D.gamma, "Cannibalisation factor", "x",
      (col) => `(1-Assumptions!$E$${A.cannibalisation})^(${col}$${D.hdr}-1)`, X.formula2dp, 0);
    // Effective age (IC-review pass, 2026-07-31): years since the later
    // of commissioning and the augmentation event. The energy
    // degradation and availability derate exponents both read this row,
    // so the piecewise reset logic exists exactly once and is visible
    // to the reader. Cannibalisation above deliberately does NOT read
    // it: gamma is a market view on the calendar clock.
    // Two cell tranches (vintage revision, 2026-07-31): the original
    // cells degrade on their own clock forever; the augmentation
    // tranche joins at the start of its year and degrades at its own
    // rate. The nested-IF blank-year guard is the re-anchoring factor's
    // idiom, and load-bearing: a blank year cell must never reach the
    // >= comparison (Excel would coerce "text > every number"; the
    // closed evaluator grammar refuses the mixed comparison outright).
    yearRow(D.tr1, "Usable energy, original tranche", "MWh",
      (col) => `Assumptions!$E$${A.energy}*(1-Assumptions!$E$${A.degradation})^` +
        `(${col}$${D.hdr}-1)`, X.formulaNum, 0);
    yearRow(D.tr2, "Usable energy, augmentation tranche", "MWh",
      (col) => `IF(Assumptions!$E$${A.augYear}="",0,` +
        `IF(AND(Assumptions!$E$${A.augMwh}>0,Assumptions!$E$${A.augCostMwh}>0,` +
        `${col}$${D.hdr}>=Assumptions!$E$${A.augYear}),` +
        `Assumptions!$E$${A.augMwh}*(1-Assumptions!$E$${A.augDelta})^` +
        `(${col}$${D.hdr}-Assumptions!$E$${A.augYear}),0))`, X.formulaNum, 0);
    // Capacity-weighted cell age: what the availability derate
    // compounds on. The IF inside the numerator zeroes the (negative
    // pre-augmentation) tranche-2 age term the same way the tranche-2
    // capacity itself is zero there; IFERROR covers the degenerate
    // zero-capacity denominator with the no-augmentation age n-1.
    yearRow(D.wage, "Capacity-weighted cell age", "years",
      (col) => `IFERROR((${col}${D.tr1}*(${col}$${D.hdr}-1)` +
        `+${col}${D.tr2}*IF(Assumptions!$E$${A.augYear}="",0,` +
        `${col}$${D.hdr}-Assumptions!$E$${A.augYear}))` +
        `/(${col}${D.tr1}+${col}${D.tr2}),${col}$${D.hdr}-1)`, X.formula2dp, 0);
    yearRow(D.usable, "Usable energy", "MWh",
      (col) => `(${col}${D.tr1}+${col}${D.tr2})*${col}${D.frac}`, X.formulaNum, 0);
    yearRow(D.discharged, "Discharged energy", "MWh",
      (col) => `365*Assumptions!$E$${A.cycles}*${col}${D.usable}`, X.formulaNum, 0);
    yearRow(D.avail, "Availability revenue", "GBP",
      (col) => `Assumptions!$E$${A.availRevYr}*1000*Assumptions!$E$${A.power}*` +
        `${col}${D.gamma}*${col}${D.frac}*` +
        `(1-Assumptions!$E$${A.derate})^${col}${D.wage}`, X.formulaNum, 0);
    yearRow(D.arb, "Arbitrage revenue", "GBP",
      (col) => `${col}${D.discharged}*Assumptions!$E$${A.margin}*` +
        `Assumptions!$E$${A.captureRate}*${col}${D.gamma}`, X.formulaNum, 0);
    yearRow(D.rev, "Total revenue", "GBP",
      (col) => `SUM(${col}${D.avail}:${col}${D.arb})`, X.formulaNum, 0);
    dcfBanner(D.costsBanner, 3, "Costs");
    // OPEX escalation (owner request, 2026-08-01): POWER(1+esc, year-1)
    // so year 1 is always the unescalated base, matching
    // Metrics.bessCashflow's own (1+opexEsc)^(n-1) exactly. TNUoS below
    // is deliberately NOT escalated (published tariff), and the
    // augmentation capex row further down is a one-off typed cost with
    // nothing to escalate either.
    yearRow(D.opex, "Operating cost", "GBP",
      (col) => `Assumptions!$E$${A.opex}*1000*Assumptions!$E$${A.power}*${col}${D.frac}` +
        `*POWER(1+Assumptions!$E$${A.opexEsc},${col}$${D.hdr}-1)`, X.formulaNum, 0);
    yearRow(D.tnuos, "Network charge (TNUoS)", "GBP",
      (col) => `IF(Assumptions!$E$${A.connType}="E",0,` +
        `Assumptions!$E$${A.zTotal}*1000*Assumptions!$E$${A.power}*${col}${D.frac})`, X.formulaNum, 0);
    yearRow(D.cost, "Total operating costs", "GBP",
      (col) => `SUM(${col}${D.opex}:${col}${D.tnuos})`, X.formulaNum, 0);
    yearRow(D.netop, "Net operating cash flow", "GBP",
      (col) => `${col}${D.rev}-${col}${D.cost}`, X.formulaNum, 0);

    d["C" + D.capex] = S("Capital expenditure", X.label);
    d["D" + D.capex] = S("GBP", X.unitsDcf);
    d["F" + D.capex] = F(`-Assumptions!$E$${A.capex}*1000*Assumptions!$E$${A.power}`,
      X.formulaNum);
    // Year columns carry the augmentation outflow in its year (a blank
    // augmentation-year cell never equals a year number, so the whole
    // row is zero when the event is not set — and a zero cost writes a
    // zero either way).
    for (let n = 1; n <= T; n++) {
      const col = bessColLetter(6 + n);
      d[col + D.capex] = F(`IF(Assumptions!$E$${A.augYear}=${col}$${D.hdr},` +
        `-Assumptions!$E$${A.augCostMwh}*1000*Assumptions!$E$${A.augMwh},0)`, X.formulaNum);
    }

    d["C" + D.netcf] = S("Net cash flow", X.labelBold);
    d["D" + D.netcf] = S("GBP", X.unitsBold);
    d["F" + D.netcf] = F(`F${D.netop}+F${D.capex}`, X.keyRow);
    for (let n = 1; n <= T; n++) {
      const col = bessColLetter(6 + n);
      d[col + D.netcf] = F(`${col}${D.netop}+${col}${D.capex}`, X.keyRow);
    }

    dcfBanner(D.discBanner, 4, "Discounting");
    yearRow(D.permid, "Discount period, mid-year", "x",
      (col) => `IF(${col}$${D.hdr}=1,1-$D$${D.genFrac1}/2,${col}$${D.hdr}-0.5)`, X.formula2dp, 0);
    yearRow(D.perend, "Discount period, end of period", "x",
      (col) => `${col}$${D.hdr}`, X.formula2dp, 0);
    yearRow(D.perapp, "Discount period applied", "x",
      (col) => `IF($D$${D.genMidflag}=1,${col}${D.permid},${col}${D.perend})`, X.formula2dp, 0);

    // Valuation-date-anchored grid pass (owner decision, 2026-08-01):
    // every column's discount period now has the commissioning-to-
    // valuation-date span subtracted before it is raised to the WACC
    // power, so the row discounts (or, for a pre-valuation year,
    // compounds forward) straight to the valuation date. Year 0 shares
    // the same formula as every other column: its perapp is 0, so its
    // factor exceeds 1 whenever a valuation date is set, which is
    // correct - t=0 money expressed at a later valuation date is worth
    // more, not less.
    d["C" + D.factor] = S("Discount factor (to the valuation date)", X.label);
    d["D" + D.factor] = S("x", X.unitsDcf);
    d["F" + D.factor] = F(
      `1/(1+WACC)^(F${D.perapp}-$D$${D.genYearsToVal})`, X.formula2dp);
    for (let n = 1; n <= T; n++) {
      const col = bessColLetter(6 + n);
      d[col + D.factor] = F(
        `1/(1+WACC)^(${col}${D.perapp}-$D$${D.genYearsToVal})`, X.formula2dp);
    }

    // Headline NPV pass (owner decision, 2026-08-01, fixing a hand-edit
    // bug): NO Total column here any more, so the headline below reads
    // SUM(F:last) directly across this row — the row itself carries no
    // separate SUM cell (a second one would be a second source of
    // truth for the exact same total). Every cell, F included, is that
    // column's own PV; the row is already valuation-anchored via the
    // Discount factor row above, so nothing here multiplies by a
    // re-anchoring factor a second time.
    d["C" + D.pv] = S("Present value at the valuation date", X.label);
    d["D" + D.pv] = S("GBP", X.unitsDcf);
    d["F" + D.pv] = F(`F${D.netcf}*F${D.factor}`, X.formulaNum);
    for (let n = 1; n <= T; n++) {
      const col = bessColLetter(6 + n);
      d[col + D.pv] = F(`${col}${D.netcf}*${col}${D.factor}`, X.formulaNum);
    }

    d["C" + D.cumpv] = S("Cumulative present value", X.label);
    d["D" + D.cumpv] = S("GBP", X.unitsDcf);
    d["F" + D.cumpv] = F(`F${D.pv}`, X.formulaNum);
    for (let n = 1; n <= T; n++) {
      const col = bessColLetter(6 + n), prev = bessColLetter(5 + n);
      d[col + D.cumpv] = F(`${prev}${D.cumpv}+${col}${D.pv}`, X.formulaNum);
    }

    // DPP pass (owner decision, 2026-08-01): the undiscounted
    // "Cumulative net cash flow" row is gone — a discounted payback
    // period tests and interpolates on the row above (Cumulative
    // present value) instead, never on undiscounted flows.
    d["C" + D.flag] = S("Payback reached this year", X.label);
    d["D" + D.flag] = S("flag", X.unitsDcf);
    d["F" + D.flag] = N(0, X.hardNum);
    // First crossing only (IC-review pass): augmentation capex can push
    // the cumulative line back below zero after a crossing, and the
    // headline payback formula SUMPRODUCTs over these flags assuming
    // exactly one is set — so every column after the first also
    // requires that no earlier flag fired, matching the engine's own
    // first-crossing return.
    for (let n = 1; n <= T; n++) {
      const col = bessColLetter(6 + n), prev = bessColLetter(5 + n);
      d[col + D.flag] = (n === 1)
        ? F(`IF(AND(${prev}${D.cumpv}<0,${col}${D.cumpv}>=0),1,0)`, X.formulaNum)
        : F(`IF(AND(${prev}${D.cumpv}<0,${col}${D.cumpv}>=0,` +
            `SUM(${g1}${D.flag}:${prev}${D.flag})=0),1,0)`, X.formulaNum);
    }

    /* LCOS's own discount factor, deliberately separate from D.factor:
       Metrics.lcos/ops' lcos() discount every LCOS term at a plain
       (1+r)^n, the same "end-of-period, unconditionally" shape as IRR
       and simple payback (metrics.js/lcos: `Math.pow(1 + r, n)`, no
       discountExponent call at all), so LCOS does NOT move with the
       mid-year/end-of-period toggle, unlike NPV's own PV row. Built off
       D.perend (already `=c$10` unconditionally, regardless of the
       flag) rather than D.perapp, so this row stays correct even when
       the convention flag is 1. */
    d["C" + D.factorEnd] = S("Discount factor, end-of-period (for LCOS)", X.label);
    d["D" + D.factorEnd] = S("x", X.unitsDcf);
    d["F" + D.factorEnd] = F(`1/(1+WACC)^F${D.perend}`, X.formula2dp);
    for (let n = 1; n <= T; n++) {
      const col = bessColLetter(6 + n);
      d[col + D.factorEnd] = F(`1/(1+WACC)^${col}${D.perend}`, X.formula2dp);
    }

    yearRow(D.charge, "Charging cost", "GBP",
      (col) => `${col}${D.discharged}/Assumptions!$E$${A.efficiency}*Assumptions!$E$${A.sLo}`,
      X.formulaNum, 0);
    yearRow(D.lcosCost, "Discounted costs for LCOS", "GBP",
      (col) => `(${col}${D.opex}+${col}${D.tnuos}+${col}${D.charge}` +
        `-${col}${D.capex})*${col}${D.factorEnd}`, X.formulaNum, 0);
    yearRow(D.lcosEnergy, "Discounted discharged energy", "MWh",
      (col) => `${col}${D.discharged}*${col}${D.factorEnd}`, X.formulaNum, 0);

    // MIRR's two legs (owner request, 2026-07-31): positive net cash
    // flows compound forward to the horizon and negative ones discount
    // back to t=0, both at WACC, on the same end-of-period basis as
    // IRR. Kept as visible rows rather than a single opaque formula so
    // a reader can audit which years sit on which side.
    yearRow(D.mirrPos, "Positive net cash flow, compounded to horizon", "GBP",
      (col) => `MAX(${col}${D.netcf},0)*` +
        `(1+WACC)^($D$${D.genPeriod}-${col}$${D.hdr})`, X.formulaNum, 0);
    d["C" + D.mirrNeg] = S("Negative net cash flow, discounted to t=0", X.label);
    d["D" + D.mirrNeg] = S("GBP", X.unitsDcf);
    d["F" + D.mirrNeg] = F(`MIN(F${D.netcf},0)`, X.formulaNum);
    for (let n = 1; n <= T; n++) {
      const col = bessColLetter(6 + n);
      d[col + D.mirrNeg] = F(
        `MIN(${col}${D.netcf},0)/(1+WACC)^${col}$${D.hdr}`, X.formulaNum);
    }

    // PVI pass (owner decision, 2026-08-01): the year-by-year present
    // value of investment, directly beside the MIRR helper rows since
    // it is another discounted-at-WACC helper feeding a headline
    // result rather than a headline row itself. Positive magnitudes
    // (capex_gbp is negative in an augmentation year, so the sign
    // flips here) — the owner's first draft left this row negative,
    // which flips the DPI's meaning; corrected.
    d["C" + D.pviRow] = S("Present value of investment", X.label);
    d["D" + D.pviRow] = S("GBP", X.unitsDcf);
    d["F" + D.pviRow] = F(`-F${D.capex}*F${D.factor}`, X.formulaNum);
    for (let n = 1; n <= T; n++) {
      const col = bessColLetter(6 + n);
      d[col + D.pviRow] = F(`-(${col}${D.capex})*${col}${D.factor}`, X.formulaNum);
    }

    dcfBanner(D.resultsBanner, 5, "Headline results");
    // Valuation-date-anchored grid pass (owner decision, 2026-08-01),
    // fixing a hand-edit bug: the row above is already valuation-
    // anchored via the Discount factor row, so the headline is a plain
    // SUM across it, with NO separate re-anchoring multiplication (a
    // second x factor here would double-count the one the Discount
    // factor row already applies). See the check row below for the
    // commissioning-anchored figure.
    d["C" + D.npv] = S("NPV at valuation date", X.labelBold);
    d["D" + D.npv] = S("GBP", X.unitsBold);
    d["E" + D.npv] = F(`SUM(F${D.pv}:${lastCol}${D.pv})`, X.keyNum);
    d["C" + D.irr] = S("Internal rate of return (end-of-period basis)", X.labelBold);
    d["D" + D.irr] = S("%", X.unitsBold);
    d["E" + D.irr] = F(`IFERROR(IRR(F${D.netcf}:${lastCol}${D.netcf}),"no IRR")`,
      X.keyPct);
    // MIRR sits BESIDE IRR, not instead of it (owner request,
    // 2026-07-31): an augmentation-year outflow gives the series a
    // second sign change, and plain IRR then has multiple valid roots;
    // MIRR (financing and reinvestment both at WACC) is single-valued.
    d["C" + D.mirr] = S("MIRR (finance and reinvestment at WACC)", X.labelBold);
    d["D" + D.mirr] = S("%", X.unitsBold);
    d["E" + D.mirr] = F(
      `IFERROR(IF(SUM(${g1}${D.mirrPos}:${lastCol}${D.mirrPos})=0,"n/a",` +
      `(SUM(${g1}${D.mirrPos}:${lastCol}${D.mirrPos})` +
      `/(0-SUM(F${D.mirrNeg}:${lastCol}${D.mirrNeg})))` +
      `^(1/$D$${D.genPeriod})-1),"n/a")`, X.keyPct);
    // DPP pass (owner decision, 2026-08-01): Simple payback is retired
    // from the workbook (Metrics.simplePayback stays in the engine for
    // any external caller, but nothing here builds it any more) in
    // favour of the discounted payback period — interpolation on the
    // PV row, NOT the net-cash-flow row, so the crossing test and the
    // fraction both use figures that already carry the mid-year/end
    // toggle and the year-1 stub (the owner's first draft mixed
    // undiscounted flows into a discounted interpolation; corrected).
    d["C" + D.payback] = S("Discounted payback period (DPP)", X.labelBold);
    d["D" + D.payback] = S("years", X.unitsBold);
    d["E" + D.payback] = F(
      `IF(SUM(${g1}${D.flag}:${lastCol}${D.flag})=0,"no payback",` +
      `SUMPRODUCT(${g1}${D.flag}:${lastCol}${D.flag},${g1}$${D.hdr}:${lastCol}$${D.hdr})-1` +
      `+(SUMPRODUCT(${g1}${D.flag}:${lastCol}${D.flag},${g1}${D.pv}:${lastCol}${D.pv})` +
      `-SUMPRODUCT(${g1}${D.flag}:${lastCol}${D.flag},${g1}${D.cumpv}:${lastCol}${D.cumpv}))` +
      `/SUMPRODUCT(${g1}${D.flag}:${lastCol}${D.flag},${g1}${D.pv}:${lastCol}${D.pv}))`,
      X.keyYears);
    d["C" + D.pvi] = S("Present value of investment (PVI)", X.labelBold);
    d["D" + D.pvi] = S("GBP", X.unitsBold);
    d["E" + D.pvi] = F(`SUM(F${D.pviRow}:${lastCol}${D.pviRow})`, X.keyNum);
    d["C" + D.dpi] = S("Discounted profitability index (DPI)", X.labelBold);
    d["D" + D.dpi] = S("x", X.unitsBold);
    d["E" + D.dpi] = F(`IFERROR(1+E${D.npv}/E${D.pvi},"n/a")`, X.keyMult);
    d["C" + D.lcos] = S("Indicative LCOS", X.labelBold);
    d["D" + D.lcos] = S("GBP/MWh", X.unitsBold);
    d["E" + D.lcos] = F(
      `IFERROR((-F${D.capex}+SUM(${g1}${D.lcosCost}:${lastCol}${D.lcosCost}))/` +
      `SUM(${g1}${D.lcosEnergy}:${lastCol}${D.lcosEnergy}),"n/a")`, X.keyNum);
    dcfBanner(D.checksBanner, 6, "Checks");
    d["C" + D.npvChk] = S("Check: Excel NPV() on the end-of-period convention",
      X.check);
    d["D" + D.npvChk] = S("GBP", X.check);
    // Valuation-date-anchored grid pass: multiplied by the Assumptions
    // re-anchoring factor so this end-of-period cross-check reconciles
    // with the headline above in every case (the factor is 1 when no
    // valuation date is set, so the two coincide then as before). This
    // check row's own NPV() is commissioning-based, unlike the
    // headline, so it keeps the x factor the headline no longer needs.
    d["E" + D.npvChk] = F(
      `IF($D$${D.genMidflag}=1,"n/a (mid-year)",` +
      `(NPV(WACC,${g1}${D.netcf}:${lastCol}${D.netcf})+F${D.netcf})` +
      `*Assumptions!$E$${A.reanchorFactor})`, X.checkMoney);
    // Owner request, 2026-07: the commissioning-anchored NPV, retained as
    // a labelled check row rather than dropped, so a reader can see the
    // pre-re-anchoring figure. Valuation-date-anchored grid pass
    // (2026-08-01): still derived from the headline by DIVIDING OUT the
    // re-anchoring factor, since the headline itself no longer carries
    // that factor as a multiplication (the year grid anchors at the
    // valuation date directly) - the factor is 1 when no valuation date
    // is set, so headline and check row coincide then, as before.
    d["C" + D.npvAtCommission] = S("Check: net present value at commissioning",
      X.check);
    d["D" + D.npvAtCommission] = S("GBP", X.check);
    d["E" + D.npvAtCommission] = F(
      `E${D.npv}/Assumptions!$E$${A.reanchorFactor}`, X.checkMoney);
    // Owner request, 2026-07-31: the native-function cross-check, the
    // exact pattern the NPV() check row above established — the
    // headline MIRR stays built from its two visible legs (auditable,
    // and independently verified primitive-by-primitive), and this row
    // lets an Excel-fluent reader confirm the native function lands on
    // the same figure. Both rates at WACC; range spans years 0..T, so
    // Excel's n = count-1 = T matches the legs' horizon exactly.
    d["C" + D.mirrChk] = S("Check: Excel MIRR() against the built-up rows", X.check);
    d["D" + D.mirrChk] = S("%", X.check);
    d["E" + D.mirrChk] = F(
      `IFERROR(MIRR(F${D.netcf}:${lastCol}${D.netcf},WACC,WACC),"n/a")`,
      X.checkPct);

    return {
      definedNames: [{ name: "WACC", ref: `DCF!$D$${D.genWacc}` }],
      // Column widths come from the owner's formatted file (picture-
      // frame revision, 2026-08-01), measured cell for cell rather than
      // carried forward from the earlier industry-formatting pass: no
      // per-column default style entry any more (a reader typing beside
      // the model gets whatever font the "Normal" style/theme resolve
      // to, not a forced override), and column A on DCF deliberately
      // has NO width entry - it holds nothing, unlike Cover's and
      // Assumptions' own column A, which stays empty of content but
      // still gets the owner's measured width.
      sheets: [
        { name: "Cover",
          cols: [[1, 1, 10.8], [3, 3, 11.3], [4, 4, 13.8], [5, 5, 20],
                 [6, 6, 10.8], [7, 7, 10.8]],
          freeze: 0, cells: cover },
        { name: "Assumptions",
          cols: [[1, 1, 10.8], [2, 2, 4], [3, 3, 43], [4, 4, 14],
                 [5, 5, 14], [6, 6, 12], [7, 7, 10]],
          freeze: 4, cells: a },
        { name: "DCF",
          // Year columns G onward (owner request, 2026-08-01): the
          // measured widths above stop at F (year 0) and left every
          // later year column at Excel's ~8.4 default, which renders a
          // seven-digit discounted figure as #####, not a number. The
          // year grid takes the F column's own measured width, 12.7 —
          // one rule for the whole run, deterministic (no bestFit),
          // exactly like every other width on this sheet.
          cols: [[2, 2, 4], [3, 3, 42.5], [4, 4, 12], [5, 5, 16],
                 [6, 6, 12.7], [7, 6 + T, 12.7]],
          freeze: D.calYear, zoom: 75, cells: d },
      ],
    };
  }

  /* D35's glue: same enablement guard as the CSV export above (missing
     required inputs, payload not ready, or an input set the engine
     itself refuses all block the download identically), same filename
     convention (D35: gb_bess_calculator_<percentile>.xlsx against the
     CSV's .csv), session-only Blob download. */
  function downloadBessCalcXlsx() {
    const c = State.get().calc;
    if (bessCalcMissingLabels(c).length || bessUnitsState !== "ready") return;
    const inputs = bessCalcEngineInputs(c, bessUnitsPayload);
    if (!Metrics.bessCashflow(inputs)) return;
    const bytes = Xlsx.build(bessCalcWorkbookModel(c, inputs, bessUnitsPayload));
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-" +
      "officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gb_bess_calculator_${c.percentile}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function bessCalculator() {
    wireBessCalc();
    ensureBessUnitsLoaded();

    const c = State.get().calc;
    updateBessCalcLiveFields(c);

    // Owner request, 2026-07: always visible, regardless of which branch
    // below this point returns early — the reader must be able to see
    // what t=0 means even before a valid cash flow exists.
    const anchorEl = document.getElementById("bess-calc-anchor");
    if (anchorEl) anchorEl.textContent = bessCalcAnchorLine(c);

    const headlineEl = document.getElementById("bess-calc-headline");
    const emptyEl = document.getElementById("bess-calc-empty");
    const chartEl = document.getElementById("ch-bess-calc");
    const csvBtn = document.getElementById("bess-calc-csv");
    const xlsxBtn = document.getElementById("bess-calc-xlsx");
    const captionEl = document.getElementById("bess-calc-caption");
    // Deliberately outside the guard above, null-checked at each use like
    // captionEl: a stale results panel missing these two must still
    // render the five headline figures, not refuse the whole card.
    const mixEl = document.getElementById("bess-calc-mix");
    const sensEl = document.getElementById("bess-calc-sens");
    // The chart-view toggle row (D20, Feature 2): hidden together with
    // chartEl in every branch below, never shown while the chart itself
    // has nothing to show — a visible toggle above an empty chart reads
    // as broken, not as a choice.
    const chartToggleEl = document.getElementById("bess-calc-chart-toggle");
    const clearExtras = () => {
      if (mixEl) { mixEl.textContent = ""; mixEl.classList.add("hidden"); }
      if (sensEl) { sensEl.innerHTML = ""; sensEl.classList.add("hidden"); }
      if (chartToggleEl) chartToggleEl.classList.add("hidden");
    };
    if (!headlineEl || !emptyEl || !chartEl || !csvBtn || !xlsxBtn) return;

    const missing = bessCalcMissingLabels(c);
    if (missing.length) {
      headlineEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
      emptyEl.innerHTML = `<div class="calc-missing">Enter the required
        inputs to see a cash flow:<ul>${
          missing.map((m) => `<li>${m}</li>`).join("")}</ul></div>`;
      chartEl.classList.add("hidden");
      chart("ch-bess-calc").clear();
      csvBtn.classList.add("hidden");
      xlsxBtn.classList.add("hidden");
      if (captionEl) captionEl.textContent = "";
      clearExtras();
      return;
    }

    if (bessUnitsState !== "ready") {
      headlineEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
      emptyEl.innerHTML = bessUnitsState === "error"
        ? `No calculator support data available, run
           <code>python etl/build_bess_units.py</code> to build it.`
        : "Loading calculator reference data…";
      chartEl.classList.add("hidden");
      chart("ch-bess-calc").clear();
      csvBtn.classList.add("hidden");
      xlsxBtn.classList.add("hidden");
      if (captionEl) captionEl.textContent = "";
      clearExtras();
      return;
    }

    const inputs = bessCalcEngineInputs(c, bessUnitsPayload);
    const cf = Metrics.bessCashflow(inputs);
    if (!cf) {
      headlineEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
      emptyEl.textContent = "Enter valid numeric assumptions to see a cash flow.";
      chartEl.classList.add("hidden");
      chart("ch-bess-calc").clear();
      csvBtn.classList.add("hidden");
      xlsxBtn.classList.add("hidden");
      clearExtras();
      return;
    }

    emptyEl.classList.add("hidden");
    chartEl.classList.remove("hidden");
    csvBtn.classList.remove("hidden");
    xlsxBtn.classList.remove("hidden");
    if (chartToggleEl) {
      chartToggleEl.classList.remove("hidden");
      chartToggleEl.querySelectorAll("[data-chart-view]").forEach((btn) => {
        const active = btn.dataset.chartView === bessCalcChartView;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
      });
    }

    const years = cf.rows.filter((r) => r.year >= 1);
    const cashflows = years.map((r) => r.net_cashflow_gbp);
    // Headline NPV is passed the same discounting convention and stub
    // fraction as bessCashflow used to build cf.rows, so it matches the
    // chart's cumulative-discounted line exactly. IRR stays convention-
    // independent (undiscounted flows), per Metrics.npv/irr's own docs.
    const frac1 = Metrics.yearFractionRemaining(inputs.y0);
    const npvAtCommissioning = Metrics.npv(cf.c0, cashflows, inputs.r, inputs.discounting, frac1);
    // Owner request, 2026-07: re-anchor the commissioning-basis NPV above
    // to the valuation date in effect (D30 default: blank -> commissioning,
    // factor 1, so this is a no-op until the field is used). The chart's
    // cumulative-discounted line is re-anchored by the identical function
    // just below, so the line and this headline always agree.
    const valuationDateInUse = bessCalcEffectiveValuationDate(c);
    const npvValue = Metrics.reanchorNpv(
      npvAtCommissioning, inputs.r, inputs.y0, valuationDateInUse);
    const irrValue = Metrics.irr(cf.c0, cashflows);
    // DPI tile (owner decision, 2026-08-01), replacing MIRR on screen —
    // the workbook keeps its MIRR row, so nothing is lost from the
    // export. 1 + NPV/PVI, the workbook's own DPI formula. Both terms
    // on the commissioning basis: re-anchoring to a valuation date
    // scales NPV and PVI by the identical factor, so the ratio is
    // anchor-invariant and needs no reanchorNpv pass (see
    // pviAtCommissioning's docstring).
    const pviValue = Metrics.pviAtCommissioning(
      cf.c0, cf.rows, inputs.r, inputs.discounting, frac1);
    const dpiValue = pviValue > 0 ? 1 + npvAtCommissioning / pviValue : null;
    // Discounted payback (owner decision, 2026-08-01), replacing simple
    // payback on this tile: interpolates on cf.rows' own discounted
    // figures, so it is convention-aware (moves with the mid-year/end
    // toggle) and anchor-invariant (unaffected by the valuation date —
    // see Metrics.discountedPayback's own docstring for why neither
    // needs a re-anchoring pass here).
    const paybackValue = Metrics.discountedPayback(cf.rows);
    // LCOS's charging-energy term prices at the observed bottom-of-day
    // mean (s_lo), and only when the observed feed is what is actually
    // in use (no manual override, and a real spread was computed) —
    // a manual override is an assumed FULL margin, not an observed
    // bottom-of-day price, so it has nothing valid to feed this term.
    const arbForLcos = bessCalcArbitrage(c);
    const lcosSlo = arbForLcos.observedFeedActive ? arbForLcos.sLo : null;
    const lcosValue = Metrics.lcos(cf.c0, cf.rows, inputs.r, inputs.eta, lcosSlo);

    const fmtGbp = (v) => (v == null ? "—"
      : (v < 0 ? "-£" : "£") + Math.abs(v).toLocaleString("en-GB",
          { maximumFractionDigits: 0 }));
    const fmtPct = (v) => (v == null ? "no IRR" : `${(v * 100).toFixed(1)}%`);
    const fmtYears = (v) => (v == null
      ? `no payback within ${inputs.T} years` : `${v.toFixed(1)} yr`);
    const fmtLcos = (v) => (v == null ? "—" : `£${v.toFixed(0)}/MWh`);

    /* Owner review, 2026-08-01: per-unit and hurdle context on the tiles
       that had none. These cost nothing in height — the MIRR and LCOS
       notes already wrap to two lines at the shipped 126px tile content
       width, so the row is already sized by a two-line .cs-note block
       and every note below stays inside that. P is MW and E is MWh, so
       both denominators are x1000; guarded because a division printing
       "Infinity" beside a headline figure is not worth the saved
       branch. */
    const perUnit = (v, denom) => ((v == null || !denom || denom <= 0)
      ? null : v / (denom * 1000));
    const fmtPerUnit = (v, suffix) => (v == null ? ""
      : (v < 0 ? "-£" : "£") + Math.abs(v).toLocaleString("en-GB",
          { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1 }) + suffix);
    const npvNote = [fmtPerUnit(perUnit(npvValue, inputs.P), "/kW"),
                     fmtPerUnit(perUnit(npvValue, inputs.E), "/kWh")]
      .filter(Boolean).join(" · ");
    // An IRR is only ever readable against the hurdle in the SAME set of
    // inputs, and that input sits in the other column. Silent when there
    // is no IRR: the tile already says "no IRR", and a lone WACC under it
    // would read as one.
    const irrNote = irrValue == null ? ""
      : `${irrValue >= inputs.r ? "+" : "-"}` +
        `${Math.abs((irrValue - inputs.r) * 100).toFixed(1)}pp vs WACC ` +
        `${(inputs.r * 100).toFixed(1)}%`;
    // "Discounted" is stated rather than left implicit. The horizon
    // goes beside it only when a payback exists — the null branch of
    // fmtYears already names T.
    const paybackNote = paybackValue == null
      ? "discounted at WACC" : `discounted at WACC · ${inputs.T} yr modelled`;

    headlineEl.innerHTML = `
      <div class="calc-stat"><span class="cs-label">NPV</span>
        <span class="cs-value">${fmtGbp(npvValue)}</span>
        <span class="cs-note">${npvNote}</span></div>
      <div class="calc-stat"><span class="cs-label">IRR</span>
        <span class="cs-value${irrValue == null ? " neutral" : ""}">${
          fmtPct(irrValue)}</span>
        <span class="cs-note">${irrNote}</span></div>
      <div class="calc-stat"><span class="cs-label">DPI</span>
        <span class="cs-value${dpiValue == null ? " neutral" : ""}">${
          dpiValue == null ? "n/a" : `${dpiValue.toFixed(2)}x`}</span>
        <span class="cs-note">discounted £ per £1 of capital committed ·
          1.00x breaks even at WACC</span></div>
      <div class="calc-stat"><span class="cs-label">Discounted payback</span>
        <span class="cs-value${paybackValue == null ? " neutral" : ""}">${
          fmtYears(paybackValue)}</span>
        <span class="cs-note">${paybackNote}</span></div>
      <div class="calc-stat"><span class="cs-label">Indicative LCOS</span>
        <span class="cs-value">${fmtLcos(lcosValue)}</span>
        <span class="cs-note">${lcosValue == null ? "" : (lcosSlo != null
          ? "includes charging-energy cost (observed s_lo)"
          : "excludes charging-energy cost (no observed s_lo in use)")}</span></div>`;

    /* Owner review, 2026-08-01: the year-1 revenue split. Year 1 is the
       commissioning stub whenever a commissioning date is set — the
       anchor line immediately above says which, so this line does not
       restate it. The arbitrage half is never stated bare: it is the
       reader's own capture rate applied to a perfect-foresight ceiling,
       and the clause saying so travels with the number rather than
       living in a tooltip. Percentages only when both halves are
       positive — a family component can be negative (DR at p10, D21),
       and a "share" of a mixed-sign total is arithmetic theatre. */
    if (mixEl) {
      const y1 = cf.rows[1];
      const av = y1 ? y1.availability_gbp : 0;
      const ar = y1 ? y1.arbitrage_gbp : 0;
      const fig = (v) => `<span class="cm-fig">${fmtGbp(v)}</span>`;
      const ceilingNow = Metrics.arbitrageCeiling(
        inputs.sHi, inputs.sLo, inputs.eta);
      const caveat = `the arbitrage figure is your ` +
        `${((inputs.k || 0) * 100).toFixed(0)}% capture rate applied to a ` +
        "perfect-foresight ceiling, not a forecast";
      let mixHtml;
      if (av === 0 && ar === 0) {
        mixHtml = "Year 1 revenue: none — neither availability nor " +
          "arbitrage contributes at these assumptions.";
      } else if (ar === 0) {
        const why = !(inputs.k > 0) ? "no capture rate set"
          : ceilingNow == null ? "no arbitrage ceiling in use"
          : !(inputs.c > 0) ? "no cycles per day set, so nothing is discharged"
          : "nothing at these assumptions";
        mixHtml = `Year 1 revenue: availability ${fig(av)} · ` +
          `arbitrage nil (${why}).`;
      } else if (av > 0 && ar > 0) {
        const pctA = Math.round((av / (av + ar)) * 100);
        mixHtml = `Year 1 revenue: availability ${fig(av)} (${pctA}%) · ` +
          `arbitrage ${fig(ar)} (${100 - pctA}%) — ${caveat}.`;
      } else {
        mixHtml = `Year 1 revenue: availability ${fig(av)} · arbitrage ` +
          `${fig(ar)} (no split shown: a component is negative) — ${caveat}.`;
      }
      mixEl.innerHTML = mixHtml;
      mixEl.classList.remove("hidden");
    }

    /* Four one-assumption sensitivities under the tiles (owner review,
       2026-08-01), each through bessCalcNpvAt's copy of the headline's
       own chain, PLUS an alternative 2-D rendering of the same question
       behind a small toggle (owner decision, 2026-08-01). Toggle rather
       than stacking both views: the sticky results column has ~27px of
       clamp margin left at 808px width, not enough for a second block
       under the strip without pushing the chart off the visible area.

       WACC x capture, not WACC x growth: this card carries no terminal
       value by design (D43) — a growth axis would have nothing to act
       on, the same reason a growth chip was never added to the strip.
       WACC and capture are the two assumptions the NPV leans on hardest,
       and the strip already probes exactly these two, one at a time; the
       matrix is the same two axes crossed, not a third assumption
       introduced for the occasion.

       Both axes de-duplicate their five candidate values after clamping
       (WACC floors at zero, capture clamps to [0,1]) — near a clamp,
       several offsets collapse onto one boundary value, and the honest
       response is a smaller table (4x5, 3x5), never a repeated row
       masquerading as a distinct case. See bessCalcSensMatrix.

       Both views are stateless, rebuilt from `inputs` on every render;
       only the view CHOICE persists, in the module-scope bessCalcSensView
       (not State.calc — it is not an assumption, so Reset must not touch
       it). Four to twenty-five extra bessCashflow passes per render
       (four for the strip, up to twenty-five for a full 5x5 matrix) is
       arithmetic noise next to a keystroke-driven re-render with T
       capped at the useful life. */
    if (sensEl) {
      const toggleHtml = bessCalcSegHtml("sens-view", bessCalcSensView, [
        { value: "strip", label: "Strip" },
        { value: "matrix", label: "Matrix" },
      ], "Sensitivity view");
      let headText, bodyHtml;
      if (bessCalcSensView === "matrix") {
        const m = bessCalcSensMatrix(inputs, valuationDateInUse);
        if (m.na) {
          const fmtOne = bessCalcCompactGbp([npvValue]);
          headText = `NPV by WACC × capture rate — each cell re-runs the ` +
            `headline's own chain with two assumptions replaced; a grid ` +
            `of sensitivities, not a scenario set. Base ${
              fmtOne(npvValue)}.`;
          bodyHtml = `<p class="calc-sens-na">${m.na}</p>`;
        } else {
          headText = `NPV by WACC × capture rate — each cell re-runs the ` +
            `headline's own chain with two assumptions replaced; a grid ` +
            `of sensitivities, not a scenario set. Base ${
              m.fmt(npvValue)} boxed.`;
          bodyHtml = bessCalcSensMatrixHtml(m);
        }
      } else {
        const sens = bessCalcSensitivities(inputs, valuationDateInUse);
        const fmtSens = bessCalcCompactGbp(
          sens.map((s) => (s.na ? null : s.value)).concat([npvValue]));
        headText = `NPV sensitivity — one assumption changed at a time, ` +
          `not a scenario set. Base ${fmtSens(npvValue)}.`;
        bodyHtml = `<div class="calc-sens-row">${sens.map((s) =>
          `<span class="calc-sens-chip"><span class="cs-sl">${s.label}</span>` +
          `<span class="cs-sv${s.na ? " cs-sv-na" : ""}">${
            s.na ? s.na : fmtSens(s.value)}</span></span>`).join("")}</div>`;
      }
      sensEl.innerHTML = `<div class="calc-sens-headrow">` +
        `<span class="calc-sens-head">${headText}</span>${toggleHtml}` +
        `</div>${bodyHtml}`;
      sensEl.classList.remove("hidden");
    }

    // Owner decision, 2026-08-01: Year 0's capex now appears on the
    // cash-flow chart. `years` above (year >= 1) is what NPV/IRR/MIRR/
    // discounted payback and LCOS are built from and must stay exactly
    // that — chartRows is a SEPARATE array, used ONLY by the cash-flow
    // chart option below. The Capacity view deliberately keeps `years`:
    // a year-0 capacity bar would be zero by construction (nothing has
    // been commissioned yet), a pre-commissioning artefact rather than
    // data, so the two views differ by one column on purpose.
    const chartRows = cf.rows;

    const labels = years.map((r) => `Year ${r.year}`);
    const chartLabels = chartRows.map((r) => `Year ${r.year}`);
    // Axis labels in £m (raw pounds clipped against the grid margins and
    // read poorly at seven digits); tooltips keep full £ precision. The
    // £m formatter keeps one decimal above £100k and two below so small
    // assets do not render as "0.0".
    const fmtMn = (v) => (Math.abs(v) >= 1e5
      ? (v / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 1 })
      : (v / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 2 }));
    const mnLabel = { color: css("--text-dim"), fontFamily: MONO,
      formatter: fmtMn };
    const xAxisYears = { type: "category", data: labels, boundaryGap: true,
      axisLine: { lineStyle: { color: css("--border") } },
      axisLabel: { color: css("--text-dim"), fontFamily: MONO } };

    if (bessCalcChartView === "capacity") {
      /* Capacity view (owner decision, 2026-08-01): usable_mwh's own
         sawtooth — degradation eating capacity year over year, the
         augmentation tranche putting a step back in (when one is set),
         then the two-vintage blend decaying again — is a shape worth
         its own axis, not squeezed under the cash-flow bars. An
         operating-margin % line was considered for this second view and
         left out: it is a different unit (%) from the MWh bar it would
         share an axis with, and a single-unit axis is the whole reason
         this view exists rather than a third series on the cash-flow
         chart. Same base()/legendBar() scaffolding as the cash-flow
         view — same grid, same xAxis — so the toggle costs zero height:
         only the legend text, the axis and the one series change. */
      const fmtMwh = (v) => (Math.abs(v) >= 1e5
        ? (v / 1e3).toLocaleString("en-GB", { maximumFractionDigits: 0 }) + "k"
        : v.toLocaleString("en-GB", { maximumFractionDigits: 0 }));
      const mwhLabel = { color: css("--text-dim"), fontFamily: MONO,
        formatter: fmtMwh };
      chart("ch-bess-calc").setOption(base({
        legend: legendBar({ data: ["Usable energy"] }),
        grid: { left: 56, right: 70, top: 48, bottom: 42 },
        tooltip: {
          trigger: "axis",
          backgroundColor: css("--bg-raised"),
          borderColor: css("--border"),
          textStyle: { color: css("--text"), fontSize: 12 },
          confine: true,
          formatter: (params) => params[0].axisValue + params.map((p) =>
            `<br>${p.marker}${p.seriesName}: ${(+p.value).toLocaleString(
              "en-GB", { maximumFractionDigits: 1 })} MWh`).join(""),
        },
        xAxis: xAxisYears,
        // Zero-based axis (owner fix, 2026-08-02): ECharts' auto-min
        // crops the bars to the data's own range, which inflates the
        // sawtooth — a 10 MWh augmentation tranche on a 40 MWh asset
        // read as a near-doubling. Capacity bars are magnitudes, and a
        // magnitude bar starts at zero.
        yAxis: valueAxis("MWh usable", { axisLabel: mwhLabel, min: 0 }),
        series: [
          { name: "Usable energy", type: "bar",
            // Un-scaled here, unlike the CSV export's usable_mwh column:
            // bessCashflow multiplies year 1's usable_mwh by the
            // commissioning-stub fraction (frac1) because that row is a
            // partial YEAR of energy exposure, but this bar plots
            // capacity IN PLACE, not exposure — a mid-year commissioning
            // date must not paint a fake capacity jump into year 2 on a
            // chart whose whole point is the degradation/augmentation
            // shape. Stated here rather than left to be discovered, the
            // same "state the divergence" discipline the cumulative-
            // discounted line's own comment uses below.
            data: years.map((r) => (r.year === 1 && frac1 > 0
              ? r.usable_mwh / frac1 : r.usable_mwh)),
            itemStyle: { color: css("--accent") } },
        ],
      }), true);
    } else {
      /* Year 0's capex on the cash-flow chart (owner decision,
         2026-08-01, option 2 of the design discussion): capex_gbp
         already carries BOTH the year-0 outflow (-c0) and any
         augmentation-year tranche in one column, so the series below
         is renamed "Capex" (superseding the 2026-07-31 "Augmentation"
         label) and covers both — one series, not a seventh legend
         entry (legendBar's width on this card was measured for six).
         The year-8-style cumulative dip an augmentation tranche causes
         is still explained by a visible bar, just under the name the
         flow actually is. */

      // maxAnnual: the largest magnitude a year >= 1 bar reaches, by
      // either measure — a single series' own value, or the stacked
      // total it sits inside (ECharts accumulates same-signed series
      // sharing one `stack` name in each direction, so several modest
      // bars stacking the same way can still reach further than any
      // one of them alone). Both are one pass over <= ~15 rows, cheap
      // enough to just take whichever is larger rather than argue
      // in advance about which one a given cash flow needs.
      const barKeys = ["availability_gbp", "arbitrage_gbp", "opex_gbp",
        "tnuos_gbp", "capex_gbp"];
      const annualRows = chartRows.filter((r) => r.year >= 1);
      const maxAnnual = annualRows.reduce((m, r) => {
        const perSeries = barKeys.reduce(
          (mm, k) => Math.max(mm, Math.abs(r[k] || 0)), m);
        const posStack = barKeys.reduce(
          (s, k) => s + Math.max(0, r[k] || 0), 0);
        const negStack = barKeys.reduce(
          (s, k) => s + Math.min(0, r[k] || 0), 0);
        return Math.max(perSeries, posStack, Math.abs(negStack));
      }, 0);
      const capexYear0 = chartRows[0] ? chartRows[0].capex_gbp : 0;
      // Threshold (owner decision, 2026-08-01): a year-0 bar within 30%
      // of the annual scale fits without help; beyond that it would
      // crush the annual structure this chart exists to show, so the
      // axis clamps instead — no annotation at all when it fits.
      const clamped = Math.abs(capexYear0) > 1.3 * maxAnnual;
      // Floor at 1.15x maxAnnual — a hairline of headroom above the
      // tallest annual bar, so the clamp reads as a deliberate ceiling
      // rather than a coincidence that happens to touch the data.
      // Passed as the exact number, not pre-rounded to a "nice" figure:
      // valueAxis()'s own scale:true still lets ECharts generate nice
      // tick steps off whatever min is given, so rounding it ourselves
      // first would only fight that second pass.
      const axisMin = clamped ? -(1.15 * maxAnnual) : null;
      // Same shared compact-£ formatter the sensitivity matrix uses
      // (bessCalcCompactGbp) — the axis label speaks the same "one
      // figure, one unit" language as the rest of this card.
      const fmtCapexClamp = bessCalcCompactGbp([capexYear0]);

      chart("ch-bess-calc").setOption(base({
        legend: legendBar({ data: ["Availability", "Arbitrage", "OPEX", "TNUoS",
          "Capex", "Cumulative discounted"] }),
        grid: { left: 56, right: 70, top: 48, bottom: 42 },
        tooltip: {
          trigger: "axis",
          backgroundColor: css("--bg-raised"),
          borderColor: css("--border"),
          textStyle: { color: css("--text"), fontSize: 12 },
          confine: true,
          formatter: (params) => params[0].axisValue + params.map((p) =>
            `<br>${p.marker}${p.seriesName}: ${fmtGbp(p.value)}`).join(""),
        },
        xAxis: { type: "category", data: chartLabels, boundaryGap: true,
          axisLine: { lineStyle: { color: css("--border") } },
          axisLabel: { color: css("--text-dim"), fontFamily: MONO,
            lineHeight: 14,
            // Stated truncation (owner decision, 2026-08-01, "state the
            // divergence" discipline): only Year 0's label changes, and
            // only when the axis is actually clamping it — the bar is
            // clipped at the floor below, so the true figure travels on
            // the label instead, precisely because the bar no longer
            // can carry it.
            formatter: (value, index) => (clamped && index === 0)
              ? `Year 0\n${fmtCapexClamp(capexYear0)}` : value } },
        yAxis: [valueAxis("£m", { axisLabel: mnLabel, min: axisMin }),
          valueAxis("£m cumulative", { position: "right",
            axisLabel: mnLabel, splitLine: { show: false } })],
        series: [
          { name: "Availability", type: "bar", stack: "cf",
            data: chartRows.map((r) => r.availability_gbp),
            itemStyle: { color: css("--pos") } },
          { name: "Arbitrage", type: "bar", stack: "cf",
            data: chartRows.map((r) => r.arbitrage_gbp),
            itemStyle: { color: css("--accent-top") } },
          { name: "OPEX", type: "bar", stack: "cf",
            data: chartRows.map((r) => r.opex_gbp),
            itemStyle: { color: css("--neg") } },
          { name: "TNUoS", type: "bar", stack: "cf",
            data: chartRows.map((r) => r.tnuos_gbp),
            itemStyle: { color: css("--text-dim") } },
          // Capex (owner decision, 2026-08-01; supersedes the
          // 2026-07-31 "Augmentation" label above) — capex_gbp is BOTH
          // the year-0 outflow (-c0) and any augmentation-year tranche
          // in one column, so one correctly-named series covers both.
          { name: "Capex", type: "bar", stack: "cf",
            data: chartRows.map((r) => r.capex_gbp),
            itemStyle: { color: css("--accent") } },
          { name: "Cumulative discounted", type: "line", yAxisIndex: 1,
            // Re-anchored by the same factor as the headline NPV above
            // (owner request, 2026-07), so the line's final point always
            // agrees with the headline figure. Now starts at Year 0
            // (owner decision, 2026-08-01): row 0's own
            // cumulative_discounted_gbp is -c0, re-anchored the
            // identical way as every later point, so the line's deep
            // start finally has a visible x position and a stated
            // cause (the Capex bar beside it) instead of appearing to
            // begin already underwater for no visible reason. The CSV
            // export's own cumulative_discounted_gbp column stays
            // commissioning-anchored, unlike this chart series — stated
            // here rather than left to be discovered, the same "state
            // the divergence" discipline D36 uses for the workbook's
            // opposite sign convention.
            data: chartRows.map((r) => Metrics.reanchorNpv(
              r.cumulative_discounted_gbp, inputs.r, inputs.y0, valuationDateInUse)),
            showSymbol: false,
            lineStyle: { width: 1.6, color: css("--text") },
            itemStyle: { color: css("--text") } },
        ],
      }), true);
    }

    if (captionEl) {
      const cohort = Data.bessRevenue && Data.bessRevenue.cohort;
      const cohortNote = cohort
        ? `cohort behind the percentile: ${cohort.units} units of the ` +
          "identified fleet"
        : "cohort behind the percentile: the identified fleet";
      captionEl.textContent =
        `Window ${bessUnitsPayload.window.from} to ` +
        `${bessUnitsPayload.window.to} · ${cohortNote} · TNUoS ` +
        `FY${bessUnitsPayload.tnuos.year_fy} ` +
        `${bessUnitsPayload.tnuos.publication}, published ` +
        `${bessUnitsPayload.tnuos.published} · percentile in use: ` +
        `${c.percentile} · every figure below the inputs is your own ` +
        "assumption arithmetic.";
    }
  }

  const PANELS = {
    overview: [overviewMain, overviewDonut, overviewResidual],
    prices: [priceMain, priceHist, priceShape, priceNetLoad],
    generation: [genStack, genLowCarbon, genRenewables],
    merit: [meritCurve, meritBmu, meritTime],
    spreads: [spreadSpark, spreadDecomp, spreadDark],
    flows: [flowsStack, flowsScatter, flowsShare, flowsUtilisation,
            flowsContext],
    stress: [stressDaily, stressEvent],
    bess: [bessActivity, bessRevenue, bessFleetTable, bessCalculator],
    methodology: [],
  };

  function renderTab(tab) {
    (PANELS[tab] || []).forEach((fn) => {
      try {
        fn();
      } catch (error) {
        console.error(`Panel render failed (${fn.name}):`, error);
      }
    });
    // charts initialised while hidden need an explicit resize
    requestAnimationFrame(resizeAll);
  }

  return { renderTab, resizeAll };
})();

window.addEventListener("resize", () => Charts.resizeAll());

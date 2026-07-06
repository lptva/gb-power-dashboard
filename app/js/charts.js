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
      grid: { left: 52, right: 56, top: 30, bottom: 42 },
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

  /* -------------------- panel renderers -------------------- */

  function overviewMain() {
    const { fromTs, toTs } = State.window();
    const sec = State.bucketSeconds();
    const price = Data.aggregate("price", fromTs, toTs, sec);
    const demand = Data.aggregate("demand", fromTs, toTs, sec);
    const ren = Data.aggregate("renewables", fromTs, toTs, sec);
    chart("ch-overview-main").setOption(base({
      legend: { textStyle: { color: css("--text-dim") }, top: 0 },
      grid: { left: 52, right: 56, top: 30, bottom: 56 },
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
      legend: { textStyle: { color: css("--text-dim") }, top: 0 },
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
      legend: { textStyle: { color: css("--text-dim") }, top: 0 },
      grid: { left: 52, right: 56, top: 30, bottom: 56 },
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
      legend: { data: ["Mean", "p25–p75"],
        textStyle: { color: css("--text-dim") }, top: 0 },
      xAxis: { type: "category", data: labels,
        axisLabel: { color: css("--text-dim"), interval: 7 },
        axisLine: { lineStyle: { color: css("--border") } } },
      yAxis: valueAxis(`${CUR()}/MWh`),
      series: [
        { name: "p25–p75", type: "line", stack: "iqr", showSymbol: false,
          data: shape.map((s) => s.p25), lineStyle: { opacity: 0 },
          itemStyle: { color: "#888" } },
        { name: "p25–p75 ", type: "line", stack: "iqr", showSymbol: false,
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
      legend: { data: series.map((s) => s.name),
        textStyle: { color: css("--text-dim") }, top: 0 },
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
      legend: { type: "scroll", textStyle: { color: css("--text-dim") }, top: 0 },
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
    chart("ch-gen-lowcarbon").setOption(base({
      xAxis: timeAxis(),
      yAxis: valueAxis("%", { min: 0, max: 100 }),
      series: [line("Low-carbon share", axisT, share, "#5ad6a4",
        { areaStyle: { opacity: 0.15 } })],
    }), true);
  }

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
      legend: { textStyle: { color: css("--text-dim") }, top: 0 },
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
      legend: { data: legendLabels, selectedMode: false,
        textStyle: { color: css("--text-dim") }, top: 0,
        itemGap: 14, padding: [2, 8] },
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

    const cap = {};
    ["NUCLEAR", "BIOMASS", "NPSHYD", "CCGT", "OCGT", "COAL"].forEach((k) => {
      const q = Data.hhQuantile(k, 0.98);
      cap[k] = q == null ? null : q / 1000;
    });
    const windNow = Data.latest("WIND"), solarNow = Data.latest("solar");
    cap.WIND = windNow ? windNow.value / 1000 : null;
    cap.solar = solarNow ? solarNow.value / 1000 : null;

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
      legend: { data: legendLabels, selectedMode: false,
        textStyle: { color: css("--text-dim") }, top: 0 },
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
      legend: { data: ["CCGT SRMC range", "Daily avg price"],
        textStyle: { color: css("--text-dim") }, top: 0 },
      xAxis: timeAxis(), yAxis: valueAxis("£/MWh"), dataZoom: zoom(),
      grid: { left: 52, right: 24, top: 30, bottom: 56 },
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
      legend: { textStyle: { color: css("--text-dim") }, top: 0 },
      grid: { left: 52, right: 24, top: 30, bottom: 56 },
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
    const fuel = d.gas_sap.map((g) => (g == null ? null : +(g / a.eta).toFixed(2)));
    const carbon = d.carbon_uka_month.map((c) =>
      c == null ? null : +((a.efGas / a.eta) * c).toFixed(2));
    const area = (name, data, colour) => ({
      name, type: "line", stack: "cost", showSymbol: false,
      data: ts.map((x, i) => [x, data[i]]),
      lineStyle: { width: 0 }, areaStyle: { color: colour, opacity: 0.7 },
      itemStyle: { color: colour },
    });
    chart("ch-spread-decomp").setOption(baseDay({
      legend: { textStyle: { color: css("--text-dim") }, top: 0 },
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
      legend: { textStyle: { color: css("--text-dim") }, top: 0 },
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
      legend: { type: "scroll", textStyle: { color: css("--text-dim") }, top: 0 },
      grid: { left: 52, right: 24, top: 30, bottom: 56 },
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
      xAxis: valueAxis("Net imports (GW)"),
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

  const PANELS = {
    overview: [overviewMain, overviewDonut, overviewResidual],
    prices: [priceMain, priceHist, priceShape, priceNetLoad],
    generation: [genStack, genLowCarbon, genRenewables],
    merit: [meritCurve, meritBmu, meritTime],
    spreads: [spreadSpark, spreadDecomp, spreadDark],
    flows: [flowsStack, flowsScatter, flowsShare],
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

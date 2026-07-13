/* app.js — bootstrap and event wiring. */

(async function main() {
  try {
    await Data.load();
  } catch (error) {
    document.getElementById("loading").classList.add("hidden");
    document.getElementById("load-error-detail").textContent = String(error);
    document.getElementById("load-error").classList.remove("hidden");
    return;
  }

  document.getElementById("loading").classList.add("hidden");
  document.getElementById("main").classList.remove("hidden");

  // The sticky topbar is the only element pinned above the content, and
  // its height varies: the nav wraps to 2–3 rows at narrower widths. The
  // sticky rails' top offset and the scroll-jump landing offset are both
  // derived from this measured height (published as --topbar-h) rather
  // than a hardcoded guess, so nothing clips under the topbar when it
  // wraps. A ResizeObserver tracks the topbar's own box, so the value
  // stays correct through wraps and font-load reflow even when no window
  // resize event fires (a plain resize listener went stale that way).
  const topbar = document.querySelector(".topbar");
  function syncTopbarHeight() {
    document.documentElement.style.setProperty(
      "--topbar-h", topbar.offsetHeight + "px");
  }
  syncTopbarHeight();                       // immediate value
  // The topbar grows on font-load reflow (fallback font wraps to fewer
  // rows than Inter) with no resize event, so also re-measure when fonts
  // settle and whenever the box itself changes size.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncTopbarHeight);
  }
  if (window.ResizeObserver) {
    new ResizeObserver(syncTopbarHeight).observe(topbar);
  }
  window.addEventListener("resize", syncTopbarHeight, { passive: true });

  document.getElementById("data-window").textContent =
    `${Metrics.fmtDate(Data.meta.window.start, "day")} → ` +
    `${Metrics.fmtDate(Data.meta.window.end, "day")} · UTC`;
  document.getElementById("foot-built").textContent =
    `Dataset built ${Metrics.fmtDate(Data.meta.built_at, "datetime")} UTC`;
  UI.renderDataAge();
  UI.renderRefreshStatus(); // zone-neutral; same call site as the age badge
  // Keep the header age honest while a tab stays open (in-memory timer
  // only — no browser storage).
  setInterval(() => { UI.renderDataAge(); UI.renderRefreshStatus(); },
    60 * 1000);
  // Stress chip: amber when the latest stress day is flagged; clicking it
  // jumps to the System stress tab.
  document.getElementById("stress-chip").addEventListener("click", () =>
    document.querySelector('#tabs button[data-tab="stress"]')?.click());

  /* ---- tabs ---- */
  // Glossary and Methodology are static reference tabs, not live-data
  // views: hide the market KPI strip there so it never implies those
  // pages are time-sensitive. Shown on every other tab.
  const REFERENCE_TABS = ["glossary", "methodology"];
  function applyReferenceTabChrome(tab) {
    const hide = REFERENCE_TABS.includes(tab);
    document.getElementById("glance").classList.toggle("hidden", hide);
    document.getElementById("kpi-strip").classList.toggle("hidden", hide);
  }
  document.getElementById("tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    document.querySelectorAll("#tabs button").forEach((b) =>
      b.classList.toggle("active", b === button));
    const tab = button.dataset.tab;
    document.querySelectorAll(".tab-panel").forEach((panel) =>
      panel.classList.toggle("hidden", panel.dataset.panel !== tab));
    applyReferenceTabChrome(tab);
    State.set({ tab });
  });

  /* ---- range presets ---- */
  document.getElementById("range-presets").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    document.querySelectorAll("#range-presets button").forEach((b) =>
      b.classList.toggle("active", b === button));
    State.set({ rangeDays: parseInt(button.dataset.range, 10) });
  });

  /* ---- zone switcher (manifest-driven; GB-only until an ENTSO-E dataset
          is fetched — see plan/04-europe-extension.md) ---- */
  const zoneSelect = document.getElementById("zone");
  const zones = Data.manifest?.zones ?? ["GB"];
  zoneSelect.innerHTML = zones.map((z) => {
    const info = Data.ZONE_INFO[z] || { label: z, kind: "" };
    // Reference markets (no GB cable) are visibly distinguished from GB's
    // physical counterparty zones.
    const suffix = info.kind === "reference" ? " · ref" : "";
    return `<option value="${z}" title="${info.label}${
      info.kind === "reference"
        ? " — reference market, not interconnected with GB" : ""}">` +
      `${z}${suffix}</option>`;
  }).join("");
  zoneSelect.disabled = zones.length < 2;

  // Merit and Spreads are GB-parameterised (SRMC assumptions, gas SAP,
  // UKA carbon — see plan/04): hide them on other zones rather than
  // rendering broken or misleading GB-costed panels.
  // Flows joins the list because interconnector data is not fetched for
  // ENTSO-E zones (cross-border flows are a separate document type).
  // System stress joins it because every input is a GB-only Elexon feed.
  const GB_ONLY_TABS = ["merit", "spreads", "flows", "stress"];
  function applyZoneTabGating(zone) {
    const away = zone !== "GB";
    GB_ONLY_TABS.forEach((t) => {
      document.querySelector(`#tabs button[data-tab="${t}"]`)
        .classList.toggle("hidden", away);
    });
    if (away && GB_ONLY_TABS.includes(State.get().tab)) {
      document.querySelector('#tabs button[data-tab="overview"]').click();
    }
  }

  zoneSelect.addEventListener("change", async (event) => {
    const nextZone = event.target.value;
    try {
      await Data.load(nextZone);
    } catch (error) {
      console.error(`Zone ${nextZone} failed to load:`, error);
      await Data.load(State.get().zone); // restore the working zone
      event.target.value = State.get().zone;
      return;
    }
    applyZoneTabGating(nextZone);
    // Brand mark reflects the active zone, not a hardcoded GB.
    const info = Data.ZONE_INFO[nextZone] || { label: nextZone };
    const mark = document.querySelector(".brand-mark");
    mark.textContent = nextZone;
    mark.title = info.label + (info.kind === "reference"
      ? " — reference market, not interconnected with GB" : "");
    document.getElementById("data-window").textContent =
      `${Metrics.fmtDate(Data.meta.window.start, "day")} → ` +
      `${Metrics.fmtDate(Data.meta.window.end, "day")} · UTC`;
    // Footer follows the zone: GB keeps its exact original source list;
    // ENTSO-E zones replace it (not append) and restate the build time.
    document.getElementById("foot-sources").textContent = nextZone === "GB"
      ? "Data: Elexon (BMRS), Sheffield Solar PV_Live, National Gas, gov.uk"
      : "Data: ENTSO-E Transparency Platform";
    document.getElementById("foot-built").textContent =
      `Dataset built ${Metrics.fmtDate(Data.meta.built_at, "datetime")} UTC`;
    UI.renderDataAge(); // zone meta carries its own built_at
    State.set({ zone: nextZone }); // triggers KPI + chart re-render
    UI.renderMethodology();        // methodology is zone-aware
  });

  /* ---- resolution ---- */
  document.getElementById("resolution").addEventListener("change", (event) => {
    State.set({ resolution: event.target.value });
  });

  /* ---- price overlays ---- */
  document.querySelectorAll("#price-overlays input").forEach((input) => {
    input.addEventListener("change", () => {
      const overlays = { ...State.get().overlays };
      overlays[input.dataset.overlay] = input.checked;
      State.set({ overlays });
    });
  });

  /* ---- generation options ---- */
  document.getElementById("gen-imports").addEventListener("change", (e) =>
    State.set({ genImports: e.target.checked }));
  document.getElementById("gen-percent").addEventListener("change", (e) =>
    State.set({ genPercent: e.target.checked }));
  document.getElementById("gen-demand-line").addEventListener("change", (e) =>
    State.set({ genDemandLine: e.target.checked }));
  document.getElementById("nl-binned").addEventListener("change", (e) =>
    State.set({ nlBinned: e.target.checked }));

  /* ---- coal price (dark spread gate) ---- */
  document.getElementById("coal-price").addEventListener("change", (event) => {
    const value = parseFloat(event.target.value);
    State.setAssumption("coalPrice", Number.isFinite(value) && value > 0
      ? value : null);
  });

  /* ---- export, theme ---- */
  document.getElementById("export-btn").addEventListener("click",
    () => UI.exportCsv());
  document.getElementById("theme-btn").addEventListener("click", () => {
    const next = State.get().theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    State.set({ theme: next });
  });

  /* ---- methodology deep links ---- */
  document.querySelectorAll(".info").forEach((el) => {
    el.addEventListener("click", () => {
      document.querySelector('#tabs button[data-tab="methodology"]').click();
      UI.jumpToMethodology("m-" + el.dataset.method, "smooth");
    });
  });

  /* ---- back to top (one global button, all long tabs) ---- */
  const backToTop = document.getElementById("back-to-top");
  if (backToTop) {
    const SHOW_AFTER = 500; // ~one screen; hidden at the top of the page
    const syncBackToTop = () =>
      backToTop.classList.toggle("hidden", window.scrollY < SHOW_AFTER);
    window.addEventListener("scroll", syncBackToTop, { passive: true });
    backToTop.addEventListener("click", () =>
      window.scrollTo({ top: 0, behavior: "auto" })); // instant, like the rails
    syncBackToTop();
  }

  /* ---- render on any state change ---- */
  State.subscribe((state) => {
    UI.renderGlance();
    UI.renderOvernight(); // re-render on zone switch (GB-only content)
    UI.renderKpis();
    UI.renderStressChip(); // GB-only; follows zone switches
    UI.renderWarnings();
    Charts.renderTab(state.tab);
  });

  UI.renderGlance();
  UI.renderOvernight();
  UI.renderKpis();
  UI.renderStressChip();
  UI.renderWarnings();
  UI.renderGlossary(); // static, zone-neutral — rendered once
  UI.renderAssumptions();
  UI.renderMethodology();
  applyReferenceTabChrome(State.get().tab);
  Charts.renderTab("overview");
  syncTopbarHeight(); // re-measure after the full header has rendered
})();

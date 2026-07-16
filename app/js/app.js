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
  //
  // Two offsets are published:
  //   --topbar-h     = the EFFECTIVE STUCK height content must clear (the
  //                    scroll-margin-top on jump targets and the rails' top
  //                    offset consume this).
  //   --topbar-above = the header chrome ABOVE the tab strip (brand +
  //                    controls); at ≤980px style.css uses it as the
  //                    topbar's negative `top` so that once the page scrolls
  //                    only the tab strip stays pinned. 0 on desktop.
  // Desktop (>980px): the whole single-row topbar stays stuck, so
  // --topbar-h is its full offsetHeight (identical to before this change)
  // and --topbar-above is 0. Compact (≤980px): the header stacks and only
  // the tab strip pins, so --topbar-h is just the strip's stuck height
  // (tab row + the topbar's own bottom padding/border) and --topbar-above
  // is everything above it. Both come from live geometry — rect deltas are
  // scroll- and stick-invariant — so they stay correct through control
  // wraps and the single-line brand row at any width.
  const topbar = document.querySelector(".topbar");
  const tabsRow = topbar.querySelector(".tabs");
  const rootStyle = document.documentElement.style;
  const mobileHeader = window.matchMedia("(max-width: 980px)");  // MUST match
  // the compact-header @media width in style.css — the negative-top shift
  // and this measurement branch describe the same layout and break apart
  // if the two widths ever diverge (980 covers landscape phones; see CSS).
  function syncTopbarHeight() {
    if (mobileHeader.matches && tabsRow) {
      const tb = topbar.getBoundingClientRect();
      const nav = tabsRow.getBoundingClientRect();
      const above = Math.max(0, Math.round(nav.top - tb.top));
      const stuck = Math.max(0, Math.round(tb.bottom - nav.top));
      rootStyle.setProperty("--topbar-h", stuck + "px");
      rootStyle.setProperty("--topbar-above", above + "px");
    } else {
      rootStyle.setProperty("--topbar-h", topbar.offsetHeight + "px");
      rootStyle.setProperty("--topbar-above", "0px");
    }
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

  // Data-window chip: full form on desktop ("16 Jul 2025 → 15 Jul 2026 ·
  // UTC"); a genuinely shortened two-digit-year form at ≤980px ("16 Jul 25
  // → 15 Jul 26"). CSS toggles which span shows by the same media width, so
  // the compact header always renders a real date instead of ellipsing the
  // full form to nothing (which left a blank gap + a stray "·" before
  // "updated Nh ago"). Both forms are rewritten on zone switch.
  function setDataWindow() {
    const { start, end } = Data.meta.window;
    const shortYear = (s) => s.replace(/\b\d{2}(\d{2})\b/, "$1");
    document.querySelector("#data-window .dw-full").textContent =
      `${Metrics.fmtDate(start, "day")} → ` +
      `${Metrics.fmtDate(end, "day")} · UTC`;
    document.querySelector("#data-window .dw-compact").textContent =
      `${shortYear(Metrics.fmtDate(start, "day"))} → ` +
      `${shortYear(Metrics.fmtDate(end, "day"))}`;
  }
  setDataWindow();
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
    // No live view behind these tabs, so the CSV button is a false
    // affordance there (it would download the market file); hide it.
    document.getElementById("export-btn").classList.toggle("hidden", hide);
    // Same reasoning for the 7D/1M/3M/… range presets: they act on the
    // time-series views, and the reference pages have none, so the control
    // is a false affordance there too.
    document.getElementById("range-presets").classList.toggle("hidden", hide);
  }
  // Per-tab scroll memory: the window is the app's ONLY scroll container,
  // so without this every tab switch inherits whatever offset the previous
  // tab left. Saved on tab-away, restored on arrival, first visit lands at
  // the top. In-memory only — resets on reload, same convention as the
  // assumption sliders. The restore is deliberately SYNCHRONOUS and runs
  // before this handler returns: the deep-link jumps
  // (jumpToMethodology/jumpToGlossary) call scrollIntoView AFTER their
  // tab-button .click() returns, so a jump always lands last and wins over
  // the restored position. A deferred restore (rAF/setTimeout) would race
  // them — do not "optimise" this into one.
  const tabScroll = new Map();
  document.getElementById("tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    tabScroll.set(State.get().tab, window.scrollY);
    document.querySelectorAll("#tabs button").forEach((b) =>
      b.classList.toggle("active", b === button));
    const tab = button.dataset.tab;
    document.querySelectorAll(".tab-panel").forEach((panel) =>
      panel.classList.toggle("hidden", panel.dataset.panel !== tab));
    applyReferenceTabChrome(tab);
    State.set({ tab });
    // After State.set: the arriving tab is rendered, so its real height is
    // in place and an oversized offset clamps against the right document.
    window.scrollTo(0, tabScroll.get(tab) ?? 0);
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
    setDataWindow();
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

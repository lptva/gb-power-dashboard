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
  document.getElementById("data-window").textContent =
    `${Metrics.fmtDate(Data.meta.window.start, "day")} → ` +
    `${Metrics.fmtDate(Data.meta.window.end, "day")} · UTC`;
  document.getElementById("foot-built").textContent =
    `Dataset built ${Metrics.fmtDate(Data.meta.built_at, "datetime")} UTC`;

  /* ---- tabs ---- */
  document.getElementById("tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    document.querySelectorAll("#tabs button").forEach((b) =>
      b.classList.toggle("active", b === button));
    const tab = button.dataset.tab;
    document.querySelectorAll(".tab-panel").forEach((panel) =>
      panel.classList.toggle("hidden", panel.dataset.panel !== tab));
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
  const GB_ONLY_TABS = ["merit", "spreads", "flows"];
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
      const anchor = document.getElementById("m-" + el.dataset.method);
      if (anchor) anchor.scrollIntoView({ behavior: "smooth" });
    });
  });

  /* ---- render on any state change ---- */
  State.subscribe((state) => {
    UI.renderGlance();
    UI.renderOvernight(); // re-render on zone switch (GB-only content)
    UI.renderKpis();
    Charts.renderTab(state.tab);
  });

  UI.renderGlance();
  UI.renderOvernight();
  UI.renderKpis();
  UI.renderAssumptions();
  UI.renderMethodology();
  Charts.renderTab("overview");
})();

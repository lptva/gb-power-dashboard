/* ui.js — KPI strip, assumptions panel, methodology, CSV export. */

const UI = (() => {

  /* ---------------- dataset freshness ----------------
     Age, not provenance: deliberately separate from the four quality
     badges (those say how a series is derived; this says how old the
     whole dataset is). Same 26 h rule and amber treatment as the
     overnight card — past one missed daily 07:00 refresh, fresh-looking
     numbers are the lie this element exists to prevent. Re-run on a
     timer so a tab left open overnight cannot keep claiming "2h ago". */

  function renderDataAge() {
    const el = document.getElementById("data-age");
    const builtAt = Data.meta?.built_at;
    if (!el) return;
    if (!builtAt) { el.textContent = ""; el.removeAttribute("title"); return; }
    const ageMs = Math.max(0, Date.now() - new Date(builtAt).getTime());
    const hours = ageMs / 3600000;
    const label = hours < 1 ? `${Math.floor(ageMs / 60000)}m`
      : hours < 48 ? `${Math.floor(hours)}h`
      : `${Math.floor(hours / 24)}d`;
    const stale = hours > 26;
    el.classList.toggle("stale", stale);
    el.textContent = stale
      ? `· ⚠ stale — updated ${label} ago`
      : `· updated ${label} ago`;
    el.title = `Dataset built ${Metrics.fmtDate(builtAt, "datetime")} UTC. ` +
      (stale
        ? "More than 26 h old — the scheduled daily refresh has not run " +
          "since; run: python3 ops/refresh.py"
        : "Refreshed daily at 07:00 local by the scheduled ETL run.");
  }

  /* ---------------- refresh-attempt failure chip ----------------
     Distinct from #data-age: the age badge can only say how old the
     dataset is, not whether the daily refresh attempt itself failed. A
     dataset that still looks fresh can sit next to a pipeline that has
     been failing for days. Reads app/data/refresh_status.json, written
     by ops/refresh.py at the end of every run. Quiet on outcome "ok"
     (the age badge already covers normal freshness), quiet when the
     file is absent (fresh clones, pre-feature datasets). Zone-neutral:
     the refresh pipeline is a machine-level run, not a per-zone one, so
     this renders identically regardless of the active zone. */

  function renderRefreshStatus() {
    const el = document.getElementById("refresh-status");
    if (!el) return;
    const s = Data.refreshStatus;
    if (!s || s.outcome !== "failed") {
      el.textContent = "";
      el.removeAttribute("title");
      return;
    }
    const ageMs = Math.max(0, Date.now() - new Date(s.ts).getTime());
    const hours = ageMs / 3600000;
    const label = hours < 1 ? `${Math.floor(ageMs / 60000)}m`
      : hours < 48 ? `${Math.floor(hours)}h`
      : `${Math.floor(hours / 24)}d`;
    const step = s.failed_step || "unknown step";
    el.textContent = `· ⚠ last refresh attempt failed ${label} ago (${step})`;
    el.title = `${s.error || "No error detail recorded"}. ` +
      `Attempt ended ${Metrics.fmtDate(s.ts, "datetime")} UTC. ` +
      "Recover with python3 ops/refresh.py";
  }

  /* ---------------- system-stress header chip ----------------
     Amber chip next to the freshness element when the MOST RECENT day in
     stress_daily.json is flagged (plan/06 D7), naming the flag type(s).
     Same amber convention as staleness; hidden off-GB, hidden when the
     latest day is quiet, hidden when the stress dataset is absent. */

  function renderStressChip() {
    const el = document.getElementById("stress-chip");
    if (!el) return;
    const s = Data.stress;
    const days = State.get().zone === "GB" && s && s.days
      ? Object.keys(s.days) : [];
    const latestDay = days.length ? days.reduce((a, b) => (a > b ? a : b))
      : null;
    const flags = latestDay ? (s.days[latestDay].flags || []) : [];
    el.classList.toggle("hidden", !flags.length);
    if (!flags.length) { el.textContent = ""; el.removeAttribute("title");
      return; }
    const types = flags.map((f) => f.type).join(" + ");
    el.textContent = `· ⚑ system stress: ${types}`;
    el.title = `${latestDay} is flagged (${types}) — deterministic ` +
      "threshold rules on observed metrics, not a security assessment. " +
      "Click for the System stress tab.";
  }

  /* ---------------- system warnings list ----------------
     Verbatim NESO notices (EMNs + emergency instructions) from
     data/warnings.json, newest first, collapsed to one line each. Bodies
     are escaped and rendered as preformatted text — their timestamps are
     UK local and are deliberately never parsed or converted. */

  // In-memory only (no browser storage): collapsed to the newest 5 on
  // every load; expansion persists across tab switches for the session.
  let warningsExpanded = false;
  const WARNINGS_COLLAPSED_COUNT = 5;

  function renderWarnings() {
    const list = document.getElementById("warnings-list");
    if (!list) return;
    const w = State.get().zone === "GB" ? Data.warnings : null;
    if (!w || !Array.isArray(w.notices)) {
      list.innerHTML = `<p class="warnings-empty">No warnings dataset —
        run <code>python etl/fetch_stress.py --backfill 365</code>.</p>`;
      return;
    }
    const items = [...w.notices].reverse().map((n) => {
      const emn = n.warningType === "ELECTRICITY MARGIN NOTICE";
      const cls = emn && n.kind === "issue" ? "warning-type emn"
        : "warning-type";
      const label = emn
        ? `EMN ${n.kind === "cancellation" ? "cancellation" : "issue"}`
        : "emergency / other";
      const stamp = n.publishTime
        ? Metrics.fmtDate(n.publishTime, "datetime") + " UTC" : "";
      // NESO's template ships literal "\n" two-character sequences inside
      // bodies; turning them into line breaks is layout normalisation
      // only — the text (and its UK-local timestamps) stays verbatim.
      const body = (n.warningText || "").replace(/\r/g, "")
        .replace(/\\n/g, "\n");
      return `<details class="warning">
        <summary><span class="warning-time">${esc(stamp)}</span>
          <span class="${cls}">${esc(label)}</span></summary>
        <pre class="warning-text">${esc(body)}</pre>
      </details>`;
    });
    if (!items.length) {
      list.innerHTML = `<p class="warnings-empty">
        No EMNs or emergency instructions in the stored window.</p>`;
      return;
    }
    const hidden = Math.max(0, items.length - WARNINGS_COLLAPSED_COUNT);
    const shown = warningsExpanded ? items
      : items.slice(0, WARNINGS_COLLAPSED_COUNT);
    list.innerHTML = shown.join("") + (hidden ? `
      <button type="button" class="warnings-toggle" id="warnings-toggle">
        ${warningsExpanded ? "▴ Show newest 5 only"
          : `▾ Show all ${items.length} notices (${hidden} more)`}
      </button>` : "");
    const toggle = document.getElementById("warnings-toggle");
    if (toggle) {
      toggle.addEventListener("click", () => {
        warningsExpanded = !warningsExpanded;
        renderWarnings();
      });
    }
  }

  /* ---------------- glossary ----------------
     Renders the Terms map (js/terms.js — the single source of truth
     shared with metric tooltips) as a flat alphabetical lookup. Static
     content: rendered once at boot, zone-neutral by design — the terms
     document the app, and GB-specific ones carry a visible tag. */

  function renderGlossary() {
    const body = document.getElementById("glossary-body");
    if (!body || typeof Terms === "undefined") return;
    const entries = Object.entries(Terms)
      .sort((a, b) => a[1].label.localeCompare(b[1].label));
    let letter = "";
    const letters = [];
    body.innerHTML = entries.map(([key, t]) => {
      const first = t.label[0].toUpperCase();
      let divider = "";
      if (first !== letter) {
        divider = `<div class="gloss-letter" id="gl-${first}"` +
          ` data-letter="${first}">${first}</div>`;
        letters.push(first);
      }
      letter = first;
      // Lowercased title + definition + extra, for substring search.
      const hay = esc((t.label + " " + t.short + " " + (t.extra || ""))
        .toLowerCase());
      const pills = [
        t.elexon ? `<a class="gloss-pill" href="${t.elexon}"
          target="_blank" rel="noopener">Elexon BSC definition ↗</a>` : null,
        t.method ? `<a class="gloss-pill gloss-mlink"
          data-method="${t.method}" href="#m-${t.method}">Methodology
          →</a>` : null,
      ].filter(Boolean).join("");
      return `${divider}
      <div class="gloss-entry" id="g-${key}" data-letter="${first}"
        data-search="${hay}">
        <div class="gloss-term"><span
          class="gloss-term-name">${esc(t.label)}</span>${t.gb
          ? '<span class="gloss-gb">GB market term</span>' : ""}</div>
        <p class="gloss-def">${esc(t.short)}${t.extra
          ? " " + esc(t.extra) : ""}</p>
        ${pills ? `<div class="gloss-links">${pills}</div>` : ""}
      </div>`;
    }).join("");
    // A–Z rail, mirroring the methodology contents rail: only letters
    // with entries, instant jumps (smooth reads as broken over long
    // pages — same call as the methodology rail).
    const nav = document.getElementById("gloss-nav");
    if (nav) {
      nav.innerHTML = letters.map((L) =>
        `<a href="#gl-${L}" data-letter="${L}">${L}</a>`).join("");
      if (!nav.dataset.wired) {
        nav.addEventListener("click", (event) => {
          const link = event.target.closest("a[data-letter]");
          if (!link) return;
          event.preventDefault();
          jumpToGlossary("gl-" + link.dataset.letter);
        });
        nav.dataset.wired = "true";
      }
    }
    // Same deep-link behaviour as the panels' ⓘ marks, delegated so it
    // survives this innerHTML render.
    body.addEventListener("click", (event) => {
      const link = event.target.closest(".gloss-mlink");
      if (!link) return;
      event.preventDefault();
      document.querySelector('#tabs button[data-tab="methodology"]').click();
      jumpToMethodology("m-" + link.dataset.method, "smooth");
    });
    wireTabSearch("gloss-search", "gloss-search-clear", filterGlossary);
    filterGlossary(""); // start unfiltered (clears any prior state)
  }

  /* ---------------- tab search (Glossary + Methodology) ----------------
     Shared substring filter: case-insensitive, partial match, instant
     (34 terms / ~18 sections — no debounce, matching is nanoseconds).
     Content lives in fixed DOM; the filter only toggles `.hidden`. */

  function wireTabSearch(inputId, clearId, apply) {
    const input = document.getElementById(inputId);
    const clear = document.getElementById(clearId);
    if (!input || input.dataset.wired) return;
    const run = () => {
      clear.classList.toggle("hidden", !input.value);
      apply(input.value.trim().toLowerCase());
    };
    input.addEventListener("input", run);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { input.value = ""; run(); }
    });
    clear.addEventListener("click", () => {
      input.value = ""; run(); input.focus();
    });
    input.dataset.wired = "true";
  }

  /* Reset a tab's search filter to empty. A previously-typed query may
     have hidden the very section a jump is about to land on, so every
     jump path clears the box first: value, its clear button and the
     filter fn (run with ""), leaving the target guaranteed visible. */
  function clearTabSearch(inputId, clearId, apply) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = "";
    document.getElementById(clearId)?.classList.add("hidden");
    apply("");
  }

  /* Hiding entries shrinks the page. The browser clamps scrollTop so you
     never scroll into empty space, but a deep-scrolled search could still
     strand the viewport past the new (shorter) content. Measure AFTER the
     hide-reflow (rAF), and if the search box has been left above the
     viewport, bring it back into view. No-op in the normal case of
     searching from the top of the tab, so it never yanks mid-typing. */
  function guardScroll(anchorEl) {
    if (!anchorEl) return;
    // Flush the pending hide-reflow synchronously (the browser also clamps
    // scrollTop here), so the measurement is current without relying on
    // requestAnimationFrame — rAF is tied to the paint loop and is not
    // dependable in headless/degraded renderers.
    void document.body.offsetHeight;
    if (anchorEl.getBoundingClientRect().bottom < 8) {
      anchorEl.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }

  /* Wrap every case-insensitive occurrence of `q` inside `root` in
     <mark class="search-hl">, keeping the text's original case. Walks
     text nodes so existing markup (tables, formulas, links) is never
     corrupted; the chrome pills are skipped. clearHighlights() reverses
     it and re-merges the split text nodes so a re-filter starts clean. */
  function clearHighlights(root) {
    root.querySelectorAll("mark.search-hl").forEach((m) => {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
  }

  function highlightMatches(root, q) {
    clearHighlights(root);
    if (!q) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(q)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentNode && node.parentNode.closest(
          ".gloss-links, .gloss-gb, script, style")) {
          return NodeFilter.FILTER_REJECT; // don't mark link/label chrome
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach((node) => {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let i = 0, idx;
      while ((idx = lower.indexOf(q, i)) !== -1) {
        if (idx > i) frag.appendChild(
          document.createTextNode(text.slice(i, idx)));
        const mark = document.createElement("mark");
        mark.className = "search-hl";
        mark.textContent = text.slice(idx, idx + q.length); // original case
        frag.appendChild(mark);
        i = idx + q.length;
      }
      if (i < text.length) frag.appendChild(
        document.createTextNode(text.slice(i)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  function filterGlossary(q) {
    const body = document.getElementById("glossary-body");
    const nav = document.getElementById("gloss-nav");
    const empty = document.getElementById("gloss-empty");
    if (!body) return;
    const shown = new Set();
    body.querySelectorAll(".gloss-entry").forEach((el) => {
      const match = !q || (el.dataset.search || "").includes(q);
      el.classList.toggle("hidden", !match);
      if (match) { shown.add(el.dataset.letter); highlightMatches(el, q); }
      else clearHighlights(el);
    });
    // Drop a letter divider when nothing under it survives the filter.
    body.querySelectorAll(".gloss-letter").forEach((div) => {
      div.classList.toggle("hidden", !shown.has(div.dataset.letter));
    });
    // Rail: grey (and disable) letters with no matches while filtering.
    if (nav) nav.querySelectorAll("a").forEach((a) => {
      a.classList.toggle("disabled", !!q && !shown.has(a.dataset.letter));
    });
    if (empty) {
      const none = !!q && shown.size === 0;
      empty.classList.toggle("hidden", !none);
      if (none) empty.textContent = `Nothing found for "${q}"`;
    }
    guardScroll(document.getElementById("gloss-search"));
  }

  function filterMethodology(q) {
    const body = document.getElementById("methodology-body");
    const toc = document.getElementById("method-toc");
    const empty = document.getElementById("method-empty");
    if (!body) return;
    // Match the whole section (heading + body), so "carbon" surfaces the
    // spark-spread section even though no heading carries the word.
    const visible = new Set();
    body.querySelectorAll(".method-section").forEach((s) => {
      const h = s.querySelector("h3");
      const match = !q || s.textContent.toLowerCase().includes(q);
      s.classList.toggle("hidden", !match);
      if (match) { if (h) visible.add(h.id); highlightMatches(s, q); }
      else clearHighlights(s);
    });
    if (toc) toc.querySelectorAll("a[data-anchor]").forEach((a) => {
      a.classList.toggle("disabled", !!q && !visible.has(a.dataset.anchor));
    });
    if (empty) {
      const none = !!q && visible.size === 0;
      empty.classList.toggle("hidden", !none);
      if (none) empty.textContent = `Nothing found for "${q}"`;
    }
    guardScroll(document.getElementById("method-search"));
  }

  /* ---------------- AI overnight summary ----------------
     Renders the ACTIVE TAB's section of data/overnight_summary.json
     (written by ops/run_overnight_summary.py via the dashboard-watcher
     agent, one analysis section per tab). Collapsed by default: badge,
     generated timestamp and the one-line takeaway; clicking the head
     expands the full analysis. This is model-generated interpretation, not
     a data series — all strings are escaped before injection and the panel
     is badged AI-generated. */

  function esc(value) {
    return String(value).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Which summary section each tab shows. Overview, Prices and Generation
  // share the general market narrative; Methodology (absent here) hides the
  // card — it documents the dashboard rather than showing the market.
  const OVERNIGHT_SECTION = { overview: "overview", prices: "overview",
    generation: "overview", merit: "merit_order", spreads: "spreads",
    flows: "flows" };

  // In-memory only (no browser storage anywhere in the app): collapsed on
  // every load, expansion persists across tab switches for the session.
  let overnightOpen = false;

  function renderOvernight() {
    const card = document.getElementById("overnight");
    const head = document.getElementById("overnight-head");
    const body = document.getElementById("overnight-body");
    const metaLine = document.getElementById("overnight-meta");
    const takeawayEl = document.getElementById("overnight-takeaway");
    const chev = document.getElementById("overnight-chev");
    const toggle = document.getElementById("ai-interpretation-toggle");
    if (!body) return;
    // GB-only analysis: hide the card entirely on other zones (and on tabs
    // with no summary section) rather than showing a misleading message.
    const sectionKey = OVERNIGHT_SECTION[State.get().tab];
    const hidden = State.get().zone !== "GB" || !sectionKey;
    card.classList.toggle("hidden", hidden);
    if (hidden) return;

    // Render switch (state.js flag, default off, in-memory): a second, OUTER
    // layer above the existing collapse. The card keeps its identity row in
    // both states; off → chevron/meta/body go away, the head goes inert and
    // the takeaway line becomes the "switch on" affordance; on → today's
    // behaviour resumes, overnightOpen untouched. A DISPLAY switch only —
    // data.js still fetches the summary and it stays published (the switch
    // tooltip carries D7).
    const on = State.get().aiInterpretation;
    toggle.checked = on;
    card.classList.toggle("overnight-off", !on);
    if (!on) {
      // display:none, not a reserved slot: with the switch off there is no
      // disclosure marker, so the title sits flush with the card edge and
      // the indent appears only when the toggle is on (owner preference).
      chev.classList.add("hidden");
      head.setAttribute("aria-expanded", "false");
      metaLine.textContent = "";
      // innerHTML, not textContent: the affordance carries the one-click
      // link to judgement call 13 (the tooltip names it but a title
      // attribute cannot hold a hyperlink). Static copy, no data in it.
      // Inline .doc-link, not a .gloss-pill: inside the violet-tinted AI
      // card a bordered pill added a second accent colour (owner, 2026-07-16);
      // the quiet inline treatment matches the Methodology tab's links.
      takeawayEl.innerHTML = 'Off by default — switch on to show the '
        + 'AI-written daily briefing for this tab. '
        + '<a class="doc-link" href="https://github.com/lptva/gb-power-dashboard/blob/main/'
        + 'methodology.md#judgement-calls-a-reviewer-should-know-about" '
        + 'target="_blank" rel="noopener">Why it is Claude-only</a>.';
      body.classList.add("hidden");
      body.innerHTML = "";
      return;
    }

    const s = Data.overnight;
    const section = s && s.tabs ? s.tabs[sectionKey] : null;
    if (!section || !section.takeaway) {
      // No summary published on this machine (fresh installs never ship
      // one — it is machine-generated and git-ignored). The panel stays
      // as a one-line honest placeholder: this is the project's only
      // non-free feature, so the pointer to the README carries the
      // subscription disclosure rather than implying something is broken.
      metaLine.textContent = "";
      takeawayEl.textContent = "";
      chev.classList.add("hidden");
      body.classList.remove("hidden");
      body.innerHTML = `<p class="overnight-empty">Optional AI feature —
        not enabled on this machine. A Claude agent can write a daily
        per-tab briefing from your local data during the scheduled
        refresh; it needs the claude CLI with a Claude subscription,
        uses your own usage allowance, and only runs after an explicit
        opt-in (ENABLE_AI_SUMMARY=true in the project's .env). See the
        README's "AI summary" section to enable it (or to ignore it —
        everything else works without it).</p>`;
      return;
    }

    chev.classList.remove("hidden");
    chev.textContent = overnightOpen ? "▾" : "▸";
    head.setAttribute("aria-expanded", String(overnightOpen));
    takeawayEl.textContent = section.takeaway;

    // Staleness: a summary older than ~26 h is yesterday's (or worse) —
    // the daily regeneration has been missed and the analysis no longer
    // describes the data on screen. Old content must never look current.
    const ageMs = s.generated_at
      ? Date.now() - new Date(s.generated_at).getTime() : 0;
    const stale = ageMs > 26 * 3600 * 1000;

    const win = s.window || {};
    // Collapsed: timestamp only (badge + takeaway carry the rest).
    // Expanded: full provenance line. Stale flag shows in BOTH.
    metaLine.innerHTML = (overnightOpen ? [
      stale ? `<span class="overnight-stale">⚠ stale — written for older
        data (${esc(Math.floor(ageMs / 3600000))} h ago); the daily
        regeneration has not run since</span>` : null,
      win.from && win.to
        ? `${Metrics.fmtDate(win.from, "datetime")} → ` +
          `${Metrics.fmtDate(win.to, "datetime")} UTC`
        : null,
      s.baseline_days ? `baseline ${s.baseline_days} d` : null,
      s.generated_at
        ? `generated ${Metrics.fmtDate(s.generated_at, "datetime")} UTC`
        : null,
    ] : [
      stale ? `<span class="overnight-stale">⚠ stale</span>` : null,
      s.generated_at
        ? `generated ${Metrics.fmtDate(s.generated_at, "datetime")} UTC`
        : null,
    ]).filter(Boolean).join(" · ");

    body.classList.toggle("hidden", !overnightOpen);
    if (!overnightOpen) return;

    const findings = Array.isArray(section.findings) ? section.findings : [];
    const dq = Array.isArray(s.data_quality) ? s.data_quality : [];
    const fig = sectionKey === "merit_order" && section.figures
      ? section.figures : null;
    body.innerHTML = `
      ${fig && fig.observed_price_gbp_mwh != null
          && fig.implied_clearing_gbp_mwh != null
        ? `<p class="overnight-figures mono-dim">Observed
             £${esc(fig.observed_price_gbp_mwh)} vs implied clearing
             £${esc(fig.implied_clearing_gbp_mwh)}${fig.marginal_technology
               ? ` (${esc(fig.marginal_technology)} marginal)` : ""}${
               fig.gap_pct != null ? ` — gap ${esc(fig.gap_pct)}%` : ""}</p>`
        : ""}
      <p class="overnight-analysis">${esc(section.analysis)}</p>
      ${findings.length
        ? `<div class="overnight-block">
            <span class="overnight-h">Findings</span>
            <ul class="overnight-list">${findings.map((f) =>
              `<li><b>${esc(f.title)}</b>` +
              (f.detail ? ` — ${esc(f.detail)}` : "") + "</li>").join("")}
            </ul></div>`
        : ""}
      <div class="overnight-block">
        <span class="overnight-h">Data quality</span>
        ${dq.length
          ? `<ul class="overnight-list">${dq.map((f) =>
              `<li>${esc(f)}</li>`).join("")}</ul>`
          : `<span class="overnight-none">No flags.</span>`}
      </div>
      <p class="overnight-foot">Generated by an LLM (dashboard-watcher agent)
         from the published dataset — an interpretation, not an observed or
         estimated data series.</p>`;
  }

  /* Expand/collapse wiring — the ⓘ methodology deep link keeps its own
     click behaviour and must not toggle the card. */
  (function wireOvernightToggle() {
    const head = document.getElementById("overnight-head");
    if (!head) return;
    const toggle = () => {
      // Inert while the AI-interpretation render switch is off: there is
      // nothing to expand, and flipping overnightOpen invisibly would make
      // the panel spring open later when the switch is turned on.
      if (!State.get().aiInterpretation) return;
      overnightOpen = !overnightOpen;
      renderOvernight();
    };
    head.addEventListener("click", (event) => {
      if (event.target.closest(".info")) return;
      toggle();
    });
    head.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target.closest(".info")) return;
      event.preventDefault();
      toggle();
    });
  })();

  /* AI-interpretation render toggle (state.js flag; default off). A display
     switch only — flipping it re-renders the card via the State subscription;
     it never touches the summary fetch or the overnightOpen collapse. */
  (function wireAiInterpretation() {
    const control = document.getElementById("ai-interpretation-toggle");
    if (!control) return;
    control.addEventListener("change", () =>
      State.setAiInterpretation(control.checked));
  })();

  /* ---------------- "At a glance" summary bar ----------------
     Four headline figures pulled from values/formulas that already exist
     elsewhere on the dashboard — nothing is computed differently here. */

  function renderGlance() {
    const el = document.getElementById("glance");
    if (!el) return;
    const items = [];

    const cur = Data.currency(); // per-zone, read from meta
    const price = Data.latest("price");
    if (price) items.push({ label: "Price",
      value: `${cur}${price.value.toFixed(1)}`,
      unit: "/MWh", badge: "observed" });

    // Clean spark spread: same formula as the Spreads tab, latest day with
    // all three inputs present. GB only — other zones carry no gas/carbon.
    const d = Data.daily;
    const a = State.get().assumptions;
    for (let i = (d.gas_sap && d.carbon_uka_month) ? d.d.length - 1 : -1;
         i >= 0; i--) {
      if (d.price[i] != null && d.gas_sap[i] != null
          && d.carbon_uka_month[i] != null) {
        const spark = Metrics.cleanSparkSpread([d.price[i]], [d.gas_sap[i]],
          [d.carbon_uka_month[i]], a)[0];
        if (spark != null) items.push({ label: "Clean spark",
          value: `£${spark.toFixed(1)}`, unit: "/MWh", badge: "estimated" });
        break;
      }
    }

    // Low-carbon share at the latest half-hour — the low-carbon chart's
    // formula applied to the most recent index.
    const hh = Data.hh;
    const idx = Data.latest("demand")?.index;
    if (idx != null) {
      const sum = (keys) => keys.filter((k) => hh[k])
        .reduce((s, k) => s + Math.max(hh[k][idx] ?? 0, 0), 0);
      const low = sum(Data.LOW_CARBON);
      const total = sum(Data.STACK_ORDER)
        + Math.max(hh.netImports[idx] ?? 0, 0);
      if (total > 0) items.push({ label: "Low-carbon",
        value: `${Math.round((100 * low) / total)}`, unit: "%",
        badge: "estimated" });
    }

    const hasFlows = Object.keys(Data.INTERCONNECTORS)
      .some((k) => Data.hh[k]);
    const net = hasFlows ? Data.latest("netImports") : null;
    if (net) {
      const gw = net.value / 1000;
      items.push({ label: gw >= 0 ? "Net imports" : "Net exports",
        value: Math.abs(gw).toFixed(1), unit: "GW", badge: "observed" });
    }

    el.innerHTML = items.map((it) => `<div class="glance-item">
      <span class="g-label">${it.label}
        <span class="g-dot ${it.badge}" title="${it.badge}"></span></span>
      <span class="g-value">${it.value}<small>${it.unit}</small></span>
    </div>`).join("");
  }

  /* ---------------- KPI strip ---------------- */

  function kpiCard({ label, badge, value, unit, delta, deltaLabel, note }) {
    const dirClass = delta == null ? "neutral" : delta > 0 ? "up" : "down";
    const arrow = delta == null ? "" : delta > 0 ? "▲" : "▼";
    return `<div class="kpi">
      <div class="k-label"><span>${label}</span>
        <span class="badge ${badge}">${badge}</span></div>
      <div class="k-value">${value}<small> ${unit}</small></div>
      ${delta != null ? `<div class="k-delta ${dirClass}">${arrow} ${
        Math.abs(delta).toFixed(1)} ${deltaLabel}</div>` : ""}
      ${note ? `<div class="k-note">${note}</div>` : ""}
    </div>`;
  }

  function renderKpis() {
    const hh = Data.hh;
    const price = Data.latest("price");
    const i = price.index;
    const back48 = Math.max(0, i - 48);
    const cards = [];

    const dayAgo = hh.price[back48];
    const cur = Data.currency(); // per-zone, read from meta
    cards.push(kpiCard({
      label: "Power price", badge: "observed",
      value: `${cur}${price.value.toFixed(1)}`, unit: "/MWh",
      delta: dayAgo == null ? null : price.value - dayAgo,
      deltaLabel: "vs 24h ago",
    }));

    const demand = Data.latest("demand");
    cards.push(kpiCard({
      label: "Demand", badge: "observed",
      value: (demand.value / 1000).toFixed(1), unit: "GW",
    }));

    // Wind/solar cards only where the zone actually reports the series
    // (e.g. NO_2 and IE publish no solar type — all-null column).
    const wind = Data.hasSignal("WIND") ? Data.latest("WIND") : null;
    if (wind) {
      const windShare = wind.value / demand.value * 100;
      cards.push(kpiCard({
        label: "Wind", badge: "observed",
        value: (wind.value / 1000).toFixed(1), unit: "GW",
        note: `${windShare.toFixed(0)}% of demand ${State.get().zone === "GB"
          ? "(transmission only)" : "(on+offshore — ENTSO-E)"}`,
      }));
    }

    // hasSignal also drops constant-zero TSO placeholders (e.g. IE solar
    // — reported as 0 for fleet the TSO does not meter; see data_quality)
    const solar = Data.hasSignal("solar") ? Data.latest("solar") : null;
    if (solar) {
      cards.push(kpiCard({
        label: "Solar", badge: "observed",
        value: (solar.value / 1000).toFixed(1), unit: "GW",
        note: State.get().zone === "GB"
          ? "PV_Live national estimate" : "ENTSO-E TSO-published",
      }));
    }

    // Only meaningful when interconnector columns exist (GB): for ENTSO-E
    // zones netImports is all zeros because flows are not fetched.
    if (Object.keys(Data.INTERCONNECTORS).some((k) => Data.hh[k])) {
      const net = Data.latest("netImports");
      cards.push(kpiCard({
        label: "Net imports", badge: "observed",
        value: (net.value / 1000).toFixed(1), unit: "GW",
        note: net.value >= 0 ? "importing" : "exporting",
      }));
    }

    const gas = Data.latestDaily("gas_sap");
    if (gas) {
    const gasIdx = gas.index;
    const gasPrev = gasIdx > 0 ? Data.daily.gas_sap[gasIdx - 1] : null;
    cards.push(kpiCard({
      label: "Gas SAP", badge: "observed",
      value: `£${gas.value.toFixed(1)}`, unit: "/MWh th",
      delta: gasPrev == null ? null : gas.value - gasPrev,
      deltaLabel: "vs prior gas day",
      note: Metrics.fmtDate(gas.d, "day"),
    }));
    }

    const carbon = Data.latestDaily("carbon_uka_month");
    if (carbon) {
    const ffilled = (Data.daily.carbon_ffill || [])[carbon.index];
    cards.push(kpiCard({
      label: "Carbon (UKA)", badge: ffilled ? "estimated" : "observed",
      value: `£${carbon.value.toFixed(2)}`, unit: "/tCO2",
      note: ffilled
        ? `carried fwd from ${Metrics.fmtDate(
            Data.meta.coverage.carbon_last_observed_month + "-01", "month")}`
        : "official monthly average",
    }));
    }

    // Coal proxy card removed from the strip (owner, 2026-07-16): the value
    // now lives on the Clean Dark Spread panel itself, beside the override
    // input — the only place it is acted on. One fewer card keeps the strip
    // to two rows at common widths.

    if (State.get().zone === "GB") {
    // Residual-load definitions are zone-specific (see plan/04) — GB only.
    const residual = (demand.value - wind.value) / 1000;
    cards.push(kpiCard({
      label: "Residual load", badge: "estimated",
      value: residual.toFixed(1), unit: "GW",
      note: "demand − wind (INDO already nets off embedded gen)",
    }));
    }

    document.getElementById("kpi-strip").innerHTML = cards.join("");
  }

  /* ---------------- assumptions panel ---------------- */

  const SLIDERS = [
    { key: "eta", label: "Reference CCGT efficiency (spreads)",
      min: 0.35, max: 0.62, step: 0.01, fmt: (v) => (v * 100).toFixed(0) + "%",
      note: "HHV basis. 49–52% is typical for the modern GB fleet." },
    { key: "etaCcgtLow", label: "CCGT fleet efficiency — low end",
      min: 0.35, max: 0.55, step: 0.01, fmt: (v) => (v * 100).toFixed(0) + "%" },
    { key: "etaCcgtHigh", label: "CCGT fleet efficiency — high end",
      min: 0.45, max: 0.62, step: 0.01, fmt: (v) => (v * 100).toFixed(0) + "%" },
    { key: "efGas", label: "Gas carbon intensity",
      min: 0.18, max: 0.21, step: 0.001, fmt: (v) => v.toFixed(3) + " t/MWh th",
      note: "UK inventory factor ≈ 0.184 tCO2/MWh (HHV)." },
    { key: "vom", label: "CCGT variable O&M",
      min: 0, max: 10, step: 0.5, fmt: (v) => "£" + v.toFixed(1) + "/MWh" },
    { key: "etaOcgtLow", label: "OCGT efficiency — low end",
      min: 0.25, max: 0.38, step: 0.01, fmt: (v) => (v * 100).toFixed(0) + "%" },
    { key: "etaOcgtHigh", label: "OCGT efficiency — high end",
      min: 0.32, max: 0.45, step: 0.01, fmt: (v) => (v * 100).toFixed(0) + "%" },
    { key: "etaCoal", label: "Coal efficiency (dark spread)",
      min: 0.30, max: 0.42, step: 0.01, fmt: (v) => (v * 100).toFixed(0) + "%" },
  ];

  function renderAssumptions() {
    const a = State.get().assumptions;
    document.getElementById("assumption-controls").innerHTML =
      SLIDERS.map((s) => `
        <div class="asm">
          <div class="asm-label"><span>${s.label}</span>
            <b id="asm-val-${s.key}">${s.fmt(a[s.key])}</b></div>
          <input type="range" data-asm="${s.key}" min="${s.min}" max="${s.max}"
                 step="${s.step}" value="${a[s.key]}">
          ${s.note ? `<div class="asm-note">${s.note}</div>` : ""}
        </div>`).join("");
    document.querySelectorAll("#assumption-controls input[type=range]")
      .forEach((input) => {
        input.addEventListener("input", (event) => {
          const key = event.target.dataset.asm;
          const value = parseFloat(event.target.value);
          const slider = SLIDERS.find((s) => s.key === key);
          document.getElementById(`asm-val-${key}`).textContent =
            slider.fmt(value);
          State.setAssumption(key, value);
        });
      });
  }

  /* ---------------- spreads: coal-in-use stat ----------------
     Small panel-local echo of the header KPI coal card, placed next to the
     override input so the £ figure actually driving the dark spread is
     visible without scrolling up to the strip. Value/unit formatting
     mirrors renderKpis' coal card byte-for-byte (`£${value.toFixed(1)}`
     + "/MWh th"); the proxy/assumption vocabulary and the "carried fwd
     from <month>" note mirror the same card and the dark-badge chip in
     this panel's own header. Kept out of app.js's central render list
     (deliberately scoped to this one panel) and instead wired to its own
     State subscription below, alongside a guarded initial call for the
     (unlikely) case Data is already loaded when this file evaluates. */
  function renderCoalStat() {
    const el = document.getElementById("coal-stat");
    if (!el || !Data.daily) return; // Data.load() has not resolved yet
    const coal = State.coalInfo();
    if (!coal) { el.innerHTML = ""; return; }
    const value = `£${coal.value.toFixed(1)}`;
    if (coal.source === "manual") {
      el.innerHTML = `<span class="badge assumption">assumption</span> ` +
        `In use: <span class="mono-dim">${value} /MWh th</span> ` +
        `&middot; your override`;
      return;
    }
    const note = coal.ffilled
      ? `carried fwd from ${Metrics.fmtDate(
          Data.meta.coverage.coal_last_observed_month + "-01", "month")}`
      : "Newcastle futures proxy";
    el.innerHTML = `<span class="badge proxy">proxy</span> ` +
      `In use: <span class="mono-dim">${value} /MWh th</span> ` +
      `&middot; ${note}`;
  }
  State.subscribe(renderCoalStat);
  renderCoalStat(); // no-op until Data.load() resolves; see guard above

  /* ---------------- methodology ---------------- */

  /* ENTSO-E production types → dashboard columns, with the honest
     mismatches (mirrors plan/04-europe-extension.md). Shown on the
     Methodology tab for non-GB zones only. */
  const ENTSOE_FUEL_MAP = [
    ["Fossil Gas (B04)", "Gas (CCGT)", "ENTSO-E does not split CCGT/OCGT — "
      + "the OCGT column stays empty and per-technology merit assumptions "
      + "do not transfer"],
    ["Fossil Hard coal + Brown coal (B05, B02)", "Coal", "comparable"],
    ["Nuclear (B14)", "Nuclear", "comparable"],
    ["Wind Onshore + Offshore (B19, B18)", "Wind", "includes onshore — "
      + "GB's WIND is transmission-metered only, so wind shares are not "
      + "directly comparable across zones"],
    ["Solar (B16)", "Solar", "TSO-published outturn — GB solar is a "
      + "PV_Live model estimate; same concept, different provenance"],
    ["Hydro Run-of-river + Reservoir (B11, B12)", "Hydro",
     "comparable in aggregate"],
    ["Hydro Pumped Storage (B10)", "Pumped storage", "comparable"],
    ["Biomass (B01)", "Biomass", "comparable"],
    ["Fossil Oil (B06)", "Oil", "comparable"],
    ["everything else", "Other", "explicit catch-all"],
  ];

  function renderZoneMethodology() {
    const meta = Data.meta;
    const zone = State.get().zone;
    const info = Data.ZONE_INFO[zone] || { label: zone, kind: "" };
    const sourceRows = Object.values(meta.series).map((s) => `
      <tr><td><b>${s.name}</b></td><td>${s.source}</td>
      <td>${s.unit}</td><td>${s.resolution}</td>
      <td>${s.quality}</td>
      <td>${s.notes || ""}</td></tr>`).join("");
    const mapRows = ENTSOE_FUEL_MAP.map(([from, to, note]) => `
      <tr><td>${from}</td><td><b>${to}</b></td><td>${note}</td></tr>`)
      .join("");

    document.getElementById("methodology-body").innerHTML = `
      <p><i>Looking for what a term or abbreviation means? The
         <b>Glossary</b> tab is the plain-language lookup; this page
         explains how this zone's data is sourced and mapped.</i></p>

      <p>The repository's <a class="doc-link" href="https://github.com/lptva/gb-power-dashboard/blob/main/methodology.md"
         target="_blank" rel="noopener">methodology.md</a> is the
         companion reviewer document: the canonical schema, the formula
         register, the data-windows table and the judgement calls, the
         deliberate modelling choices a reviewer should know about,
         including why the AI summary is Claude-only (judgement
         call 13).</p>

      <h3 id="m-window">Zone: ${info.label} (${zone})</h3>
      <p>${info.kind === "reference"
        ? "<b>Reference market. Not physically interconnected with "
          + "GB.</b> Included as the European price anchor for context. "
          + "Do not read GB flow implications into it."
        : "One of GB's physical counterparty "
          + "<a class=\"term-link\" data-term=\"bidding_zone\" "
          + "href=\"#g-bidding_zone\">bidding zones</a> (direct "
          + "interconnection)."}
         Window: <code>${meta.window.start}</code> →
         <code>${meta.window.end}</code>, built
         <code>${meta.built_at}</code>. ${meta.timezone}
         Settlement currency as reported by ENTSO-E:
         <code>${meta.currency}</code>.</p>

      <h3 id="m-sources">Data sources (this zone)</h3>
      <p>Everything below comes from the <b><a class="term-link"
         data-term="entsoe" href="#g-entsoe">ENTSO-E</a> Transparency
         Platform</b> (free, token-gated API). GB instead uses Elexon,
         PV_Live, National Gas and gov.uk. All series here are
         <b>Observed</b>: TSO-published outturns and the
         <a class="term-link" data-term="day_ahead" href="#g-day_ahead">
         day-ahead auction</a> price, a true auction price, unlike GB's
         <a class="term-link" data-term="mid" href="#g-mid">MID</a>
         proxy.</p>
      <table><tr><th>Series</th><th>Source / document</th><th>Unit</th>
        <th>Resolution</th><th>Quality</th><th>Notes</th></tr>
        ${sourceRows}</table>
      ${zone === "IE" ? `<p><b>IE quirk:</b> ENTSO-E publishes each
         document type against a specific area type. Day-ahead prices sit
         under the SEM bidding-zone EIC, and load sits under the Ireland
         control-area EIC. Both codes are current, and the fetcher
         handles the split automatically, confirmed by probing the API
         directly and against ENTSO-E's published area-code
         documentation.</p>` : ""}

      <h3 id="m-fuelmap">Fuel-type mapping (ENTSO-E → dashboard columns)</h3>
      <p>ENTSO-E production types do not map 1:1 onto Elexon fuel codes.
         The mapping and its known mismatches:</p>
      <table><tr><th>ENTSO-E production type</th><th>Dashboard column</th>
        <th>Mismatch / caveat</th></tr>${mapRows}</table>

      <h3 id="m-dq">Data quality (this zone)</h3>
      ${(meta.data_quality || []).length
        ? `<p>Gaps and absences below are the TSO's submission as
             published, verified against the raw ENTSO-E XML
             (variable-block periods are expanded per the spec before
             counting). Nothing is interpolated or hidden:</p>
           <ul>${meta.data_quality.map((n) => `<li>${n}</li>`).join("")}</ul>`
        : `<p>No reporting gaps detected in this window: every series the
             TSO publishes is complete.</p>`}

      <h3 id="m-csv">CSV downloads</h3>
      <p>Off GB, only the market CSV exists:
         <code>&lt;zone&gt;_market_&lt;from&gt;_&lt;to&gt;_&lt;res&gt;.csv</code>,
         priced in this zone's own reported settlement currency
         (<code>${meta.currency}</code>). The Spreads, Merit order, Flows
         and System stress files do not apply here, because the GB-only
         tabs behind them are hidden for this zone.</p>

      <h3 id="m-gbonly">What stays GB-only for this zone, and why</h3>
      <ul>
        <li><b>Merit order</b> and <b>Spreads</b>. The SRMC cost model is
            GB-parameterised: gas SAP, UKA carbon and the efficiency
            assumptions are GB inputs, and ENTSO-E's unsplit "Fossil Gas"
            means no defensible CCGT/OCGT split exists. No per-zone SRMC
            assumptions have been defined yet, so these tabs are hidden
            rather than showing GB-costed panels for a non-GB market.</li>
        <li><b>Flows</b>. Interconnector flows are a separate ENTSO-E
            document type not yet fetched. The zone schema has no
            interconnector columns, so the tab is hidden rather than
            rendering empty charts.</li>
        <li>The <b>overnight AI summary</b> and <b>observed dispatch</b>
            panels analyse the GB dataset only.</li>
      </ul>
      <p>Select GB in the zone switcher to see the full GB methodology.</p>`;
  }

  /* Jump to a methodology section by its heading id. Scrolls the section
     CARD, not the bare <h3>: the h3 sits 15px inside the card (its
     padding + border), so landing the h3 at the topbar offset would put
     the card's own border behind the topbar. Scrolling the card makes
     its top border land at the same gap the Glossary letter dividers do
     (both use scroll-margin-top: var(--topbar-h) + 12px). */
  function jumpToMethodology(id, behavior) {
    // Own the filter reset: a stale Methodology search could have hidden
    // the target section, so clear it before scrolling. Every jump into
    // Methodology (ⓘ deep links, glossary pills, the contents rail) routes
    // through here and inherits this by construction.
    clearTabSearch("method-search", "method-search-clear", filterMethodology);
    const el = document.getElementById(id);
    if (!el) {
      // Loud, not silent: a missing target means a data-method attribute
      // (hand-written in index.html) points at a section id that does not
      // exist in the methodology template — a dangling deep link. The
      // silent return here hid exactly that for the Interconnector flows
      // ⓘ ("flows" vs the merged "generation" section) until a user
      // noticed the jump going nowhere (2026-07-17). Warn so the next one
      // shows up in dev-console testing instead of shipping quiet.
      console.warn('jumpToMethodology: no element "#' + id
        + '" — dangling deep link');
      return;
    }
    (el.closest(".method-section") || el)
      .scrollIntoView({ block: "start", behavior: behavior || "auto" });
  }

  /* Jump to a Glossary target by element id — a term entry (#g-<key>) or a
     letter divider (#gl-<L>). Clears the Glossary search first (a stale
     filter may have hidden the target), then scrolls it into view. Instant,
     not smooth: long-page smooth scroll reads as broken (same reasoning as
     the methodology jumps). The single entry point for every Glossary jump,
     cross-tab (prose term-links) or same-tab (the A–Z rail). */
  function jumpToGlossary(id) {
    clearTabSearch("gloss-search", "gloss-search-clear", filterGlossary);
    document.getElementById(id)?.scrollIntoView({ behavior: "auto" });
  }

  /* Post-render layout pass for the Methodology tab — layout only, the
     text templates below are untouched. Wraps each <h3>-headed run of
     nodes into a card-styled <section> (so topics separate visually
     instead of reading as one wall of text) and rebuilds the sticky
     mini-contents rail from the section headings. Runs after every
     render, so the GB and zone variants get the same structure. */
  function finalizeMethodologyLayout() {
    const body = document.getElementById("methodology-body");
    const toc = document.getElementById("method-toc");
    if (!body) return;
    // Inline glossary links (.term-link) inside the prose jump to the
    // Glossary tab and land on that term's entry. Delegated on the body
    // so it survives every re-render; wired once via the dataset guard.
    if (!body.dataset.termWired) {
      body.addEventListener("click", (event) => {
        const link = event.target.closest(".term-link");
        if (!link) return;
        event.preventDefault();
        document.querySelector('#tabs button[data-tab="glossary"]').click();
        jumpToGlossary("g-" + link.dataset.term);
      });
      body.dataset.termWired = "true";
    }
    const nodes = [...body.childNodes];
    const sections = [];
    let current = null;
    nodes.forEach((node) => {
      if (node.nodeType === 1 && node.tagName === "H3") {
        current = document.createElement("section");
        current.className = "method-section";
        sections.push(current);
      }
      if (current) current.appendChild(node);
      else if (node.nodeType === 1) node.classList.add("method-intro");
    });
    sections.forEach((s) => body.appendChild(s));
    if (!toc) return;
    toc.innerHTML = '<div class="method-toc-head">On this page</div>' +
      sections.map((s) => {
        const h = s.querySelector("h3");
        const label = h.textContent.replace(/\(.*?\)/g, "")
          .replace(/\s+/g, " ").trim();
        return `<a href="#${h.id}" data-anchor="${h.id}">${esc(label)}</a>`;
      }).join("");
    if (!toc.dataset.wired) {
      toc.addEventListener("click", (event) => {
        const link = event.target.closest("a[data-anchor]");
        if (!link) return;
        event.preventDefault();
        // Instant, not smooth: contents jumps can span thousands of
        // pixels, and Chrome's smooth scroll takes seconds over that
        // distance — it reads as broken. Lands the section card below
        // the sticky topbar.
        jumpToMethodology(link.dataset.anchor, "auto");
      });
      toc.dataset.wired = "true";
    }
    // The body was just rebuilt (boot or zone switch): start unfiltered,
    // and reset the search box so switching zones never lands on a stale
    // "no sections match" from the previous zone's content.
    const search = document.getElementById("method-search");
    if (search) {
      search.value = "";
      document.getElementById("method-search-clear")?.classList.add("hidden");
    }
    wireTabSearch("method-search", "method-search-clear", filterMethodology);
    filterMethodology("");
  }

  function renderMethodology() {
    if (State.get().zone !== "GB") {
      renderZoneMethodology();
      finalizeMethodologyLayout();
      return;
    }
    const meta = Data.meta;
    const cov = meta.coverage;
    // Shared <tr> shape for the "Sources, field mapping, transformations"
    // table: the core dataset's Data.meta.series (build_dataset.py) plus,
    // appended after it, the battery payloads' own meta.series entries —
    // one row from bess_activity.json (a single series) and two from
    // bess_revenue.json (a dict of two, "eac" and "bm", since that
    // payload spans two distinct sources — see etl/build_bess_revenue.py's
    // SOURCE_META). Both battery payloads carry meta.series in the exact
    // same field vocabulary (name/source/unit/resolution/
    // update_frequency/quality/transformations/notes) by design, so one
    // row template covers all of them; this is GB-only (renderMethodology,
    // not renderZoneMethodology, so the zone view never gets these rows).
    // Degrades silently: an absent payload, or one built before it carried
    // meta.series, simply contributes no extra rows.
    const sourceRow = (s) => `
      <tr><td><b>${s.name}</b></td><td>${s.source}</td>
      <td>${s.unit}</td><td>${s.resolution}</td>
      <td>${s.update_frequency}</td><td>${s.quality}</td>
      <td>${s.transformations}${s.notes ? "<br><i>" + s.notes + "</i>" : ""}</td>
      </tr>`;
    const bessActivitySeries = Data.bess && Data.bess.meta
      && Data.bess.meta.series;
    const bessRevenueSeries = Data.bessRevenue && Data.bessRevenue.meta
      && Data.bessRevenue.meta.series;
    // The profitability calculator's own source row (plan/09's ETL design
    // section): a STATIC description, not read from app/data/bess_units.json
    // itself, because that payload is lazily fetched on the calculator
    // card's first render (D33/D34) — unlike bess_activity/bess_revenue
    // above, it may never have loaded by the time this page-load render
    // runs, so it cannot feed a dynamic row the way theirs do. The vendored
    // table's own shape is fixed at build time regardless.
    const BESS_CALC_SOURCE_ROW = {
      name: "GB battery profitability calculator: TNUoS zone tariffs",
      source: "NESO Data Portal (CKAN), dataset " +
        "transmission-network-use-of-system-tnuos-tariffs, " +
        "Onshore Generator Tariffs resource",
      unit: "£/kW: SystemPeak, SharedYearRound, NotSharedYearRound, " +
        "Residual per zone",
      resolution: "27 charging zones, one set of elements each",
      update_frequency: "vendored at ETL build time from the highest " +
        "Year_FY carrying Publication = 'Final'; the source itself " +
        "publishes quarterly",
      quality: "reference",
      transformations: "copied verbatim from the resource, rounded to " +
        "3 dp",
      notes: "A zone-level indication using the published tariff " +
        "elements, not the full CUSC tariff calculation for a specific " +
        "asset. The cross-unit percentile block behind the calculator's " +
        "availability revenue is Observed (etl/build_bess_units.py); " +
        "everything the calculator itself outputs is Assumption, per " +
        "the card's own badges.",
    };
    const batterySourceRows = [
      bessActivitySeries,
      bessRevenueSeries && bessRevenueSeries.eac,
      bessRevenueSeries && bessRevenueSeries.bm,
      BESS_CALC_SOURCE_ROW,
    ].filter(Boolean).map(sourceRow).join("");
    const sourceRows = Object.values(meta.series).map(sourceRow).join("")
      + batterySourceRows;

    // Feed-composition context lives here rather than on the warnings
    // panel (not user-verifiable there, and noise for a panel reader);
    // rendered from the warnings meta so it cannot drift from the data.
    const counts = Data.warnings && Data.warnings.meta
      && Data.warnings.meta.syswarn_counts;
    const stressFeedNote = counts ? `
      <p>Warnings-feed composition — the full SYSWARN feed over
         <code>${counts.window.from}</code> →
         <code>${counts.window.to}</code> carried
         ${Object.entries(counts.by_type)
        .map(([t, n]) => `${n} ${t.toLowerCase()}`).join(", ")};
         the panel stores and shows only the EMN +
         emergency-instruction subset.</p>` : "";

    document.getElementById("methodology-body").innerHTML = `
      <p><i>Looking for what a term or abbreviation means? The
         <b>Glossary</b> tab is the plain-language lookup; this page
         explains how things are computed and why.</i></p>

      <p>This tab explains each panel's sourcing and maths. The
         repository's <a class="doc-link" href="https://github.com/lptva/gb-power-dashboard/blob/main/methodology.md"
         target="_blank" rel="noopener">methodology.md</a> is the
         companion reviewer document: the canonical schema, the formula
         register, the data-windows table and the judgement calls, the
         deliberate modelling choices a reviewer should know about,
         including why the AI summary is Claude-only (judgement
         call 13).</p>

      <h3 id="m-window">Data window and coverage</h3>
      <p>Window: <code>${meta.window.start}</code> →
         <code>${meta.window.end}</code>, built
         <code>${meta.built_at}</code>. ${meta.timezone}</p>
      <p>Half-hourly coverage: demand ${(cov.demand * 100).toFixed(1)}%,
         price ${(cov.price * 100).toFixed(1)}%,
         solar ${(cov.solar * 100).toFixed(1)}%.
         Gas: ${cov.gas_days} days. UKA observed for
         ${cov.carbon_months_observed} months of the window. Last published
         month <code>${cov.carbon_last_observed_month}</code>. Later dates
         carry that value forward and are flagged as estimates.</p>

      <h3 id="m-sources">Sources, field mapping, transformations</h3>
      <table><tr><th>Series</th><th>Source / dataset</th><th>Unit</th>
        <th>Resolution</th><th>Updates</th><th>Quality</th>
        <th>Transformations &amp; notes</th></tr>${sourceRows}</table>

      <h3 id="m-price">Wholesale price (MID)</h3>
      <p>The dashboard's "price" is the
         <a class="term-link" data-term="mid" href="#g-mid">Market Index
         Data</a> price: the volume-weighted average of short-term trades
         reported by the appointed market index data providers (APX, N2EX).
         It is the public proxy for the GB spot price and feeds the
         imbalance price calculation. It tracks the
         <a class="term-link" data-term="day_ahead" href="#g-day_ahead">
         day-ahead auction</a> closely in normal conditions but diverges in
         stressed periods. It is used because it is the only free,
         half-hourly, officially published GB price series. Day-ahead
         auction prices are commercial and not redistributed here.</p>
      <p>One deliberate exception: the System stress tab uses SSP instead,
         the settlement price of the balancing actions NESO actually took,
         where MID measures traded wholesale sessions. The reasoning is
         spelled out with the stress flag rules below.</p>

      <h3 id="m-residual">Residual load (estimated)</h3>
      <div class="formula">residual = INDO − WIND(transmission)</div>
      <p>Solar is deliberately not subtracted.
         <a class="term-link" data-term="indo" href="#g-indo">INDO</a> is
         transmission-level demand, so it is already net of all embedded
         generation. Embedded solar and embedded wind suppress it in real
         time. Subtracting PV_Live solar on top would count it twice. An
         earlier version of this dashboard did exactly that, which is why
         residual load could go negative on sunny middays.</p>
      <p>The identity that makes this the national net load: underlying
         demand − all wind − all solar = (INDO + embedded gen) − all wind
         − all solar = INDO − transmission wind.</p>
      <p>Remaining limitation: roughly 6 GW of GB wind capacity is
         distribution-connected and invisible to every source used here.
         Because <a class="term-link" data-term="residual_load"
         href="#g-residual_load">residual load</a> is computed as INDO
         minus transmission wind, embedded wind is correctly, if silently,
         absorbed on the demand side. The bias is confined to gross
         metrics: wind output, renewables output and low-carbon share all
         understate GB wind. Hence Estimated.</p>

      <h3 id="m-spark">Clean spark spread (estimated)</h3>
      <p>The <a class="term-link" data-term="spark_spread"
         href="#g-spark_spread">clean spark spread</a> estimates a gas
         (CCGT) plant's margin per MWh: power price minus gas fuel cost
         minus the carbon cost of burning it.</p>
      <div class="formula">spark = price − gas_SAP / η − (EF_gas / η) · UKA − VOM</div>
      <p>Defaults: η = 0.50 (HHV), EF_gas = 0.184 tCO2/MWh th,
         VOM = £3/MWh.</p>
      <p><a class="term-link" data-term="gas_sap" href="#g-gas_sap">Gas
         SAP</a> is a within-day average, not the day-ahead curve a trader
         would hedge against. <a class="term-link" data-term="uka"
         href="#g-uka">UKA</a> is a monthly average, forward-filled within
         the month. The result is a credible indicator of CCGT economics,
         not a tradable margin. All parameters are adjustable on the Merit
         order tab. Adjustments never modify stored historical data.</p>

      <h3 id="m-dark">Clean dark spread (proxy / derived)</h3>
      <p>The <a class="term-link" data-term="dark_spread"
         href="#g-dark_spread">clean dark spread</a> estimates a coal
         plant's margin per MWh. The GB-relevant coal benchmark, ICE API2
         CIF ARA, is commercial data, so the dashboard instead derives a
         transparent futures-based proxy, labelled Proxy / Derived:</p>
      <div class="formula">dark = price − coal / η_coal − (EF_coal / η_coal) · UKA − VOM_coal</div>
      <p>Defaults: η_coal = 0.36, EF_coal = 0.34 tCO2/MWh th,
         VOM = £5/MWh.</p>
      <div class="formula">coal £/MWh th = (USD per tonne) ÷ FX(USD per GBP, monthly mean) ÷ 6.978</div>
      <ul>
        <li><b>Coal price</b>: World Bank "Pink Sheet" monthly average of the
            Australian 6,000 kcal/kg FOB Newcastle <i>futures</i> price
            (USD/t). Public, monthly, about 2 working days after month
            end.</li>
        <li><b>FX</b>: Bank of England daily USD/GBP spot rate (XUDLUSS),
            averaged over each calendar month.</li>
        <li><b>Energy content</b>: 6,000 kcal/kg = 25.12 GJ/t = 6.978 MWh
            thermal per tonne.</li>
      </ul>
      <p>Newcastle FOB is a different basis from API2 CIF ARA, the
         commercial European benchmark. Levels track, they do not equal.
         The monthly value is forward-filled within and beyond the month,
         flagged <code>coal_ffill</code>. A manually entered coal price
         overrides the proxy and relabels the panel Assumption.</p>

      <h3 id="m-merit">SRMC cost model (estimated)</h3>
      <p><a class="term-link" data-term="srmc" href="#g-srmc">SRMC</a>
         ranges per technology cluster are computed at the latest observed
         gas SAP and UKA prices, with stated efficiency spans. They are
         cost estimates, not observed bids. The wind, solar, nuclear and
         hydro ranges are VOM-style estimates. Biomass fuel costs are
         commercial: a broad published range is shown and marked as
         containing assumptions.</p>
      <p>The CCGT cluster, used for the merit band and its decomposition,
         follows the same shape as the clean spark spread:</p>
      <div class="formula">SRMC(η) = gas_SAP / η + (EF_gas / η) · UKA + VOM</div>
      <p>The fleet band uses η ∈ [0.45, 0.57] by default.</p>
      <p>This model drives the merit-order curve and the cost attribution
         in the observed-dispatch tooltips. An earlier per-technology bar
         view of these ranges was removed as redundant. The curve presents
         the same ranges at tranche granularity, plus the demand and
         clearing lines.</p>

      <h3 id="m-meritcurve">Merit order curve (estimated)</h3>
      <p>The curve uses the SRMC model above, laid out against cumulative
         available capacity. Each technology's SRMC range is split into
         0.5 GW tranches, with cost rising linearly across the technology,
         efficient units first. All tranches are then sorted globally by
         SRMC. The result is a contiguous stack that never decreases, in
         which technologies interleave where their cost ranges overlap.
         Capacity is a stated proxy, not registered capacity:</p>
      <ul>
        <li><b>Dispatchables</b> (nuclear, biomass, hydro, CCGT, OCGT, coal):
            the 98th percentile of observed half-hourly output over the
            dataset window, what the fleet has actually delivered.</li>
        <li><b>Wind and solar</b>: latest observed output, since they are
            must-run price-takers whose available capacity at any moment is
            their output.</li>
      </ul>
      <p>The demand line is the latest INDO minus net imports, what GB
         plant must serve now. The implied clearing price is the SRMC of
         the tranche that serves that level. Comparing it with the
         observed price tests the cost model against the market. Pumped
         storage, oil and "other" are excluded because no defensible SRMC
         benchmark exists for them. Interconnectors are netted off the
         demand line rather than stacked.</p>

      <h3 id="m-bmu">Observed dispatch by unit (observed volumes, estimated
         costs, beta)</h3>
      <p>A dispatch curve built from physical notifications
         (<a class="term-link" data-term="pn" href="#g-pn">PN</a>) per
         <a class="term-link" data-term="bmu" href="#g-bmu">BM Unit</a>
         for the most recent complete settlement period, from the Elexon
         Insights PN dataset joined to the BM Unit registry, refreshed by
         <code>etl/build_bmu_snapshot.py</code>. Per unit it stores the
         time-weighted mean physical-notification MW (Observed), the fuel
         type and registered capacity from the BM Unit registry, and
         per-fuel counts of <a class="term-link" data-term="boalf"
         href="#g-boalf">BOALF</a> acceptances. A coverage block states
         what share of MW was classified to a fuel. Units notifying zero
         and interconnector units are omitted. Units with no registry fuel
         type are kept with <code>fuel: null</code>.</p>
      <p>The chart draws the snapshot as a dispatch curve: cumulative
         notified GW against each cluster's SRMC midpoint, cheapest first,
         on the same axes as the modelled merit-order curve, so modelled
         and observed dispatch can be compared directly. Each block is one
         unit. Width is its notified MW, the time-weighted mean of the
         level profile across the half-hour, Observed. Height is its
         technology cluster's SRMC midpoint from the cost model above,
         Estimated. Read the caveats before leaning on it:</p>
      <ul>
        <li><b>PN is notified intent, not metered output, and not a bid
            stack.</b> Units can and do deviate from their final physical
            notifications. It is not what meters recorded, and it carries
            no prices, since bid prices are not in free data. It is an
            observation of dispatch behaviour that complements the SRMC
            model.</li>
        <li><b>The price axis is a cluster attribution, not unit data.</b>
            Every unit of a technology sits at the same midpoint. Within a
            cluster, larger units are drawn first as a display convention
            only. No unit-level costs exist in free data.</li>
        <li><b>Units without an SRMC benchmark are not plotted.</b>
            Unclassified units (no registry fuel type: mostly batteries,
            DSR and small aggregations) plus pumped storage, oil and
            "other" have no defensible cost benchmark, so their vertical
            position would be invented. Their count and GW are stated
            under the caption instead, alongside the classified share of
            notified MW.</li>
        <li><b>Also excluded</b>: interconnector units (flows, not
            dispatch, see the Flows tab) and charging/pumping units
            (negative levels).</li>
      </ul>

      <h3 id="m-netload">Price vs net load (estimated)</h3>
      <div class="formula">net load = INDO − WIND(transmission)</div>
      <p>Each scatter point is one observed half-hourly price against
         derived net load, the demand left for dispatchable plant, the
         standard system-tightness variable. Solar is <b>not</b>
         subtracted. INDO is already net of embedded solar, see residual
         load above, so PV_Live solar is shown in the tooltip for context
         only, not in the formula. The optional overlay shows the median
         price per 2 GW bin. Bins with fewer than 12 half-hours are
         dropped.</p>

      <h3 id="m-generation">Generation and flows</h3>
      <p>Elexon <a class="term-link" data-term="fuelhh" href="#g-fuelhh">
         FUELHH</a> covers transmission-connected plant. Embedded solar
         comes from PV_Live, model-estimated from a metered sample, the
         GB standard. Embedded wind is not included anywhere. Published
         GB "wind" here means transmission-metered wind. Interconnector
         flows are metered, positive means import. Greenlink and Viking
         Link appear from their respective commissioning dates.</p>

      <h3 id="m-lowcarbon">Low-carbon share (estimated)</h3>
      <div class="formula">low_carbon = (nuclear + biomass + hydro + pumped storage + wind + solar) / total supply</div>
      <p>Total supply includes positive net imports. Biomass is included
         per GB grid-intensity convention. Imports sit in the denominator
         only, because their origin mix is not observed at the cable. Both
         choices are debatable, hence Estimated. This headline series
         keeps one unbroken definition across the full 365-day history.</p>
      <div class="formula">import_aware = (GB low-carbon + Σ import_flow × zone_low_carbon_fraction) / (GB generation + Σ import_flow)</div>
      <p>The dashed <b>import-aware</b> line attributes each importing
         cable at its counterparty zone's own low-carbon generation
         fraction at that half-hour, from the ENTSO-E zone datasets.
         Honesty limits, stated plainly: this is first-order
         counterparty-mix attribution only, not flow tracing. The zone's
         own imports are not re-attributed. It exists only over the
         accumulated zone history, append-only from late May 2026 (FR
         from 16 May, the other zones from 30 May), extended by the daily
         refresh, no backfill, so the line simply starts
         where zone history does. Where zone data is missing at a
         timestamp, that cable's import falls back to the headline
         treatment, denominator only. Exports are excluded from both
         metrics. It is a second metric beside the headline, never
         spliced into it.</p>

      <h3 id="m-counterparty">Counterparty context (Flows tab)</h3>
      <p>For a selected GB cable, the panel shows the cable's observed flow
         alongside the counterparty
         <a class="term-link" data-term="bidding_zone" href="#g-bidding_zone">
         zone</a>'s day-ahead price and generation mix, loaded lazily from
         the per-zone ENTSO-E datasets. DE_LU is a reference market with no
         GB cable and is never offered here. Read the caveats:</p>
      <ul>
        <li><b>The remote price is Derived and indicative only.</b> It is a
            day-ahead auction price in EUR, converted at the daily Bank of
            England EUR/GBP rate (<code>fx_eur_per_gbp</code>, series
            XUDLERS). Weekends carry the last business day. It is compared
            against GB's within-day MID index. These are different market
            segments, so the gap is context, not a tradable spread.</li>
        <li><b>The mix is zone-wide context, not attribution.</b> It shows
            what the exporting zone was running, not which plants supplied
            the cable's electrons.</li>
        <li><b>Zone history is shorter than GB's 365 days.</b> It
            accumulates append-only at ~6 kB/day/zone from late May 2026
            (FR from 16 May, the other zones from 30 May)
            (<code>--retain-days</code> can trim it if size ever matters),
            and deepens with the daily refresh, so longer ranges clip to
            the overlap (stated in the panel's meta line). TSO reporting
            gaps appear as gaps.</li>
        <li><b>The overlays share the Utilisation ranking's definitions.</b>
            Dashed lines mark the cable's per-direction operational
            ceilings, the highest flow sustained for at least 2 hours over
            the trailing 90 days. Dotted lines mark the cited nameplate.
            The flow axis is fixed to the design envelope,
            ±1.05 × max(nameplate, ceilings), so the gap between design
            and practice stays visible instead of being autoscaled away.
            Amber shading marks congestion-proxy half-hours: at ceiling,
            and a wide direction-consistent spread. It is an
            approximation, not a shadow price. The axis tooltip repeats
            that label over shaded periods, and the caption counts the
            shaded half-hours in view. Definitions, thresholds and
            caveats are in the Utilisation ranking section above.</li>
      </ul>

      <h3 id="m-utilisation">Utilisation ranking (Flows tab)</h3>
      <p>Ranks the ten cables by how often flow ran near a practical limit
         over the selected range, and what the GB–counterparty price gap
         averaged in exactly those half-hours. GB
         <a class="term-link" data-term="interconnector" href="#g-interconnector">
         interconnectors</a> sit outside any flow-based capacity-calculation
         region, since capacity is allocated per cable, so neither a
         published network limit nor a shadow price exists. Both are
         approximated and badged Proxy / Derived. A view toggle switches
         between the flat ranking (default) and grouping by counterparty
         market, ordered by each market's best near-capacity share. This
         is presentation only: the metrics are identical in both views.</p>
      <ul>
        <li><b>Operational ceiling (Proxy):</b> per direction, the highest
            flow sustained for at least 2 hours (4 half-hours, not
            necessarily consecutive, in other words the 4th-largest
            reading) over the trailing 90 days: a rolling window that
            moves forward daily. A plain max is not robust here: the
            FUELHH columns carry occasional single-half-hour spike
            artefacts well above anything the cable sustains, and an
            unfiltered max would lift a pegged cable's
            <a class="term-link" data-term="ceiling" href="#g-ceiling">
            ceiling</a> above its true plateau and zero its utilisation
            count. A nameplate-based cap fails the other way, because
            cables can genuinely sustain flows somewhat above their
            published rating. The sustained rule drops isolated artefacts
            and keeps genuine plateaus without consulting nameplate.
            Chosen over nameplate because it self-adjusts to de-ratings
            and phased ramp-ups: a direction whose ceiling falls below 5%
            of nameplate is treated as offline rather than flagging noise
            as utilisation. Symmetrically, a rarely-used direction's
            ceiling reflects use, not capability: read it against the
            nameplate column.</li>
        <li><b><a class="term-link" data-term="nameplate" href="#g-nameplate">
            Nameplate</a> (Reference):</b> operator-published design
            capacity, shown for context and never used in the
            near-capacity test, cross-checked 2026-07-10 against DESNZ,
            "Electricity interconnectors' contribution to security of
            supply" (October 2025, capacity-market derating annex,
            assets.publishing.service.gov.uk) and Elexon's interconnector
            register (elexon.co.uk/bsc/about/interconnectors/). Values:
            ${Object.values(Data.INTERCONNECTORS).map((ic) =>
              `${ic.label} ${ic.nameplate_mw.toLocaleString("en-GB")}`)
              .join(" · ")} (MW).</li>
        <li><b>Near-capacity:</b> |flow| ≥ 90% of the operational ceiling,
            tested per half-hour over the selected range.</li>
        <li><b>Δ (Derived, indicative only):</b> mean of GB MID minus the
            counterparty day-ahead price (converted at the daily BoE
            EUR/GBP rate) over near-capacity half-hours: positive means a
            GB premium. Day-ahead auction vs within-day MID are different
            market segments, so the gap is context, not a tradable spread.
            Zone prices exist only over the accumulated zone history:
            collection began 16 May 2026 for France and 30 May 2026 for
            the other zones, append-only with no
            backfill, so those dates are a fixed accumulation start. Unlike
            the rolling ceiling window, it never moves, and it bounds the
            join. The row tooltip counts the half-hours actually used.</li>
        <li><b><a class="term-link" data-term="congestion_proxy" href="#g-congestion_proxy">
            Congestion proxy</a> (approximation, not a shadow price):</b>
            a half-hour is flagged only when BOTH conditions hold: the
            cable at ≥90% of its operational ceiling and the GB−zone
            spread wide in the direction the flow earns. "Wide" means
            importing with Δ = GB − zone at or beyond the market's p75
            (and ≥ £5/MWh), or exporting with Δ at or beyond the p25
            (and ≤ −£5/MWh). The spread population is every overlap
            half-hour for that market over the full accumulated zone
            window. Those thresholds are fixed. They do not move when the
            view range changes, and cables landing in the same zone share
            them. Why a proxy rather than an observation: GB left the EU
            single day-ahead coupling (SDAC) at the end of 2020. Capacity
            on GB–EU interconnectors is allocated through explicit
            day-ahead capacity auctions that close before the energy
            auctions, and the TCA's proposed replacement (multi-region
            loose volume coupling) remains unimplemented, checked
            2026-07-10. So no flow-based shadow price exists to observe.
            Two exclusions are deliberate. Wide spread with slack flow is
            not flagged, because that pattern is consistent with an
            outage or ramp limit rather than scarce capacity. At-ceiling
            flow against the price signal is not flagged, because that is
            emergency-action shaped: at-limit, but not congestion rent.
            Known limitation, recorded so it is never re-investigated: a
            full RAM decomposition (IVA / FRM / AAC / Fnrao / F0−Fnrao,
            as shown on flow-based CCR dashboards) cannot be built for
            GB. It needs TSO-level flow-based allocation data that does
            not exist for per-cable, explicitly allocated
            interconnectors, and simulating the components would
            fabricate data.</li>
        <li><b>Three cables share the SEM counterparty price.</b> Moyle
            lands in Northern Ireland and East-West/Greenlink in the
            Republic of Ireland, but all three connect GB to the same
            all-island SEM bidding zone, so their Δs use the same
            day-ahead series. The rows remain distinct: each Δ is
            averaged over that cable's own near-capacity half-hours, so
            the three can, and do, differ.</li>
      </ul>

      <h3 id="m-stress">System stress (observed metrics, derived flags)</h3>
      <p>The System stress tab shows daily operational-stress metrics over
         the trailing year with deterministic anomaly flags, refreshed by
         <code>etl/fetch_stress.py</code>. It is append-only, keeps at
         least 400 days, and its retention is independent of the core
         dataset's window. Every stored figure is <b>Observed</b>. The
         flags are <b>derived from observed</b>: threshold arithmetic
         computed at build time and shipped in the JSON, never recomputed
         in the browser, and never changed retroactively. Sources, all
         Elexon Insights (keyless): 15 s system
         <a class="term-link" data-term="frequency" href="#g-frequency">
         frequency</a> (FREQ),
         <a class="term-link" data-term="lolp" href="#g-lolp">loss-of-load
         probability</a> and
         <a class="term-link" data-term="drm" href="#g-drm">de-rated
         margin</a> (1/8/12 h horizons), settlement system prices, and
         system warnings
         (<a class="term-link" data-term="syswarn" href="#g-syswarn">
         SYSWARN</a>).</p>
      <p>The price series here is
         <a class="term-link" data-term="ssp" href="#g-ssp">SSP</a>
         rather than MID, deliberately. SSP is the settlement price of the
         balancing actions the operator actually took, the realised cost
         of keeping the system whole in real time, so it is the series
         that directly prices operational scarcity. MID aggregates traded
         wholesale sessions. It often rises on the same days: 23 Jun 2026,
         MID's year-max £561 against SSP's year-max £800 in the same
         evening. But it measures what the market traded, not what
         balancing cost, and a stress detector must price the latter.</p>
      <p>A day is flagged when ANY of four typed rules fires. Each flag
         records the value and the exact threshold used:</p>
      <ul>
        <li><b>frequency</b>: seconds below 49.8 Hz reach
            max(trailing-365d p99, 60 s floor). Sub-49.8 blips are
            routine in small doses (about 1 day in 6 has ≥15 s), so the
            percentile does the work and the floor only guards the
            all-zero-history case.</li>
        <li><b>price</b>: daily max settlement system price reaches the
            trailing-365d p99 of daily maxima.</li>
        <li><b>emn</b>: at least one Electricity Margin Notice is
            <em>issued</em> that day, publish-date attribution (UTC).
            Cancellation notices share the warning type but withdraw a
            warning, so they never count.</li>
        <li><b>adequacy</b>: daily max LoLP across the 1/8/12 h horizons
            reaches max(trailing-365d p99, 0.01 floor). The floor targets
            true near-misses: the 8 Jan 2025 event reached 0.294.
            De-rated margin is stored for context but is not a
            trigger.</li>
      </ul>
      <p>Baselines are <b>point-in-time</b>: each day is judged only
         against the up-to-365 days before it, its own value never
         raises its own threshold, and percentile rules need at least 90
         days of history. With less, only the EMN flag and the adequacy
         floor can fire. Days early in the backfilled window therefore
         face thinner baselines than days from launch onward. Every
         flag's tooltip shows the threshold it actually fired against.</p>
      <p>The frequency and adequacy families are deliberately
         complementary. LoLP and de-rated margin are
         <em>leading margin</em> indicators that can stay quiet through a
         delivery event: 23 Jun 2026, max LoLP 0.0017. Frequency, price
         and EMNs are <em>outcome</em> indicators that can stay quiet
         through a managed adequacy squeeze: 8 Jan 2026, zero excursion
         seconds, no EMN, LoLP 0.036. Neither family may be dropped in
         favour of the other. The flag set is their union.</p>
      <ul>
        <li><b>Percentile context (tooltips):</b> the day's max SSP, max
            LoLP and min DRM each carry a display-only
            <a class="term-link" data-term="percentile" href="#g-percentile">
            rank</a> against the same point-in-time trailing window the
            flags use. This is midrank: the day's own value never joins
            its own baseline. Under 90 days of history the annotation
            says "insufficient history" rather than fabricating a rank.
            Ranks are stress-oriented: DRM is inverted, so p97 tight
            means only 3% of trailing days had less margin. Bands at
            p99/p95/p90/p50: extreme, very high/very tight, high/tight,
            regular, low/loose. One caveat: LoLP's trailing distribution
            is zero-inflated (the median day is 0), so <em>any</em>
            nonzero LoLP ranks high. The annotation reads "relative to
            the past year", while the adequacy flag's absolute 1% floor
            keeps deciding what counts as a flag.</li>
        <li><b>Feed artefacts:</b> the FREQ feed occasionally carries
            implausible samples (literal 0.0 Hz). Readings outside
            45–55 Hz are treated as gaps, not excursions: 18 affected
            days in the first backfill, worst 404 samples in one day.</li>
        <li><b>Event slices:</b> every flagged day gets a full-day 15 s
            frequency slice for the viewer, any flag type. The trace is
            frequency regardless, so price/adequacy days can show a calm
            grid. Slices are fetched lazily per view, so they add nothing
            to the page load. On disk they run ~40 kB per flagged day.
            The viewer's day list follows the global range presets. This
            is presentation only: slices exist for every flagged day.
            When the selected day falls out of a newly chosen range, the
            viewer falls back to the newest flagged day in range, or an
            empty state if the range contains none.</li>
        <li><b>Day granularity:</b> frequency metrics are UTC days. SSP
            and LoLP rows carry local settlement dates. At daily
            resolution the mismatch is at most the 23:00–24:00 BST
            hour.</li>
        <li><b>Header chip and latest-day digest:</b> when the most recent
            day is flagged, an amber chip appears next to the freshness
            element naming the flag type(s), same visual convention, and
            like the flags themselves it marks a <em>notable</em> day,
            not a security assessment. The tab's first card additionally
            leads with a one-line digest of the most recent stored day, a
            deterministic restatement of stress_daily.json, unrelated to
            the AI overnight summary card. Its quiet-day wording is
            "no flags fired", meaning no threshold was crossed, never
            "all clear": flags mark notable days, and no N-1, constraint
            or reserve model exists anywhere in this app. When the latest
            day's baseline is under 90 days the digest says so
            ("baseline building") instead of implying confidence the
            rules cannot have. <b>Both the chip and the digest are
            deliberately range-independent:</b> they always reflect the
            latest day in stress_daily.json whatever the 7D–1Y presets
            say, while the daily chart and the event viewer's day list
            <em>do</em> follow the presets. That asymmetry is by design,
            not a range-selector bug: the presets scope the history you
            are inspecting, and the chip and digest report the newest
            state regardless.</li>
      </ul>
      ${stressFeedNote}

      <h3 id="m-bess">Battery BM activity (observed volumes, derived
         fleet, beta)</h3>
      <p>The Batteries tab tracks how actively NESO dispatches the
         identified GB <a class="term-link" data-term="bess"
         href="#g-bess">battery</a>
         (<a class="term-link" data-term="bmu" href="#g-bmu">BM Unit</a>)
         fleet in the Balancing Mechanism, refreshed by
         <code>etl/build_bess_activity.py</code>. Every stored MWh figure
         is <b>Observed</b>: Elexon's settlement
         <a class="term-link" data-term="accepted_volume"
         href="#g-accepted_volume">accepted volume</a>, signed per side
         (offer positive, bid negative). It is not a re-derivation from
         <a class="term-link" data-term="boalf" href="#g-boalf">BOALF</a>
         levels, which would answer a different question (delivered
         position, not accepted deviation). Fleet identification is
         <b>derived from observed</b> registry attributes by a
         deterministic rule, not an asserted list.</p>

      <p>A BM Unit joins the identified fleet if its id starts
         <code>E_</code> or <code>T_</code>, its registered generation
         capacity is at least 5 MW, it is not a site-demand BMU (id
         matching <code>D-\d+$</code> or a name containing "Demand"), and
         it matches either a structural signature (generation &gt; 0,
         demand &lt; 0, symmetric within 0.5–1.5×, no fuel type or
         interconnector flag) or a battery name pattern
         (<code>batter | bess | energy stor | storage | ess |
         bat\d?</code> against the unit's own id and name fields, and
         deliberately not the owning party's name, since parties named
         "&hellip; Energy Storage Ltd" also own non-battery plant).
         Virtual Lead Party <code>V_</code> portfolios are excluded: that
         prefix is the aggregator namespace and its portfolios mix
         batteries with demand-side response. The rule is recomputed from
         the registry on every refresh, never hand-maintained.</p>
      <p>Measured against a manual sample week, the structural leg alone
         recovered 97% of name-labelled battery BMUs inside the boundary
         (recall), and 75% of identified MW showed genuine two-sided
         operation or non-zero accepted BM volume (precision); the
         residual is dormant or pre-commercial capacity, not
         misidentification. REPD (the government's planning-consented
         battery register) is cited as <b>scale context only</b> in the
         panel's caption: it is site-level, does not enumerate BM Unit
         ids, and covers a different, overlapping population, so it is
         never shown as a coverage percentage or used as a divisor.</p>

      <p>Each stored day's accepted offer MWh stacks upward, accepted bid
         MWh stacks downward, and the line is their net: one bar per
         stored day, filtered to the selected range (the hh/hour/day
         resolution toggle is not applied here, only the date range is;
         see the code comment in <code>charts.js</code>'s
         <code>bessActivity</code> for why). The series is instructed
         <em>deviation</em> from each unit's own notified position, not
         delivered energy: an offer means "go above it" (discharge more or
         charge less), a bid means "go below it" (charge more or discharge
         less). Accepted volume can therefore exceed metered throughput.
         The "per MW of fleet active to date" toggle divides <b>each
         day</b> by that day's own denominator: the registered capacity
         of identified units whose first observed non-zero accepted BM
         volume falls on or before that day
         (<code>fleet.list[].first_active</code>), not one value for the
         whole build. The identified cohort's active capacity grew 2,316
         to 4,276 MW over the stored window, so a constant, build-level
         divisor was measured to understate the earliest 30 days by 43%
         and to reverse the sign of the headline utilisation trend, a
         genuine 15% fall over the window reading instead as a 50% rise.
         Registered-but-dormant capacity (<code>fleet.mw</code>) is
         deliberately <b>not</b> used either: it would understate
         utilisation for units that simply have not traded yet. Nor is
         each day's own active capacity, despite being the obvious
         matched choice: it is <b>endogenous</b> to the dispatch being
         measured, a quiet day shrinks it exactly when the numerator
         shrinks (correlation +0.355 against the cumulative series'
         -0.086), which would inflate per-MW intensity precisely when
         dispatch is low. A unit leaves the denominator only by leaving
         the BMU registry or the identification rule, never by going
         quiet, because a quiet-day exit would be exactly that same
         endogeneity. The revenue card below uses the same construction,
         on first EAC appearance rather than first BM acceptance, so the
         two cards are directly comparable.</p>
      <p>Arbitrage P&amp;L, state of charge and per-unit delivered
         frequency-response volumes are out of scope for this panel: none
         of them is published anywhere observable. Metered delivered
         output (B1610) is not used because it publishes about seven days
         in arrears, which would leave this tab perpetually behind the
         near-real-time surfaces elsewhere in the dashboard.
         VLP/aggregator activity is a possible future, separate
         tracker.</p>
      ${bessActivitySeries
        ? `<p>Series detail, source dataset, unit, resolution, update
             cadence and transformations, is listed alongside every other
             series in the "Sources, field mapping, transformations"
             table above.</p>`
        : `<p>No BESS activity dataset built on this machine yet — run
             <code>python etl/build_bess_activity.py --backfill 400</code>.</p>`}

      <h3 id="m-bess-revenue">Battery revenue stack (observed, beta)</h3>
      <p>The <b>Observable revenue stack</b> card is the publicly
         observable share of what the identified battery fleet earns:
         availability payments from NESO's
         <a class="term-link" data-term="eac" href="#g-eac">Enduring
         Auction Capability (EAC)</a> platform, stacked by product, plus a
         Balancing Mechanism cashflow panel below the rule. Wholesale
         arbitrage, Capacity Market payments and bilateral tolls are not
         observable per unit anywhere this dashboard can see, and stay out
         of frame.</p>
      <p>The chart itself displays £/MW/day, not the £/kW/day the payload
         and CSV carry: every plotted value (the twelve product bars, the
         unit-spread band and the p50 line, and the BM cashflow bars below)
         is multiplied by 1000 for the axis, a display-only change so the
         bars read at a sane scale — the raw £/kW/day figures are tiny
         decimals. The card's caption also states an annualised
         availability-only run-rate: the mean of the daily 12-product total
         (£/kW/day, unconverted) over the selected window, scaled to a
         year and labelled £/kW/yr, the same unit the profitability
         calculator uses. It is labelled "availability-only" because it
         excludes wholesale arbitrage and the BM cashflow sub-panel, and
         must never be read as total battery revenue. A toggle above the
         chart switches between the per-product view (twelve bars, the
         default) and a service-group view (four bars: Response and
         Reserve, each split into a positive-legs and a negative-legs
         series). The grouping never nets a leg against its opposite —
         see the per-product paragraph below and judgement call 16.</p>
      <p>Cohort: EAC auction units whose NESO <code>technologyType</code>
         is <code>Batteries</code>, joined on an exact, uppercase
         <code>auctionUnit</code> to <code>nationalGridBmUnit</code>
         match, restricted to physical units (<code>elexonBmUnit</code>
         prefix <code>E_</code> or <code>T_</code>) with a registered
         generation capacity above zero. Virtual Lead Party
         (<code>V_</code>) and supplier (<code>2__</code>) portfolios are
         excluded because they carry no registered nameplate, so a per-kW
         figure cannot be built for them. Two coverage figures are
         disclosed, because a revenue metric has a numerator-side gap an
         activity metric does not: <b>denominator coverage</b> is the
         cohort's MW against REPD's operational battery total, and
         <b>numerator coverage</b> is the share of all EAC
         battery-labelled gross £ the cohort actually earns. That gap is
         real: aggregator and VLP auction units earn the remainder and sit
         structurally outside a £/kW metric, which is why both figures sit
         in the card's caption rather than just the first.</p>
      <p>The stack keeps all twelve auction products,
         <a class="term-link" data-term="dc_dm_dr" href="#g-dc_dm_dr">
         Dynamic Containment, Moderation and Regulation</a> plus Balancing,
         Quick and Slow Reserve, each split into its low/negative and
         high/positive leg, rather than collapsing to six service bands.
         The two legs of a service routinely clear opposite signs on the
         same day, so netting them would hide two large, real, offsetting
         flows behind a small number. Revenue is <code>executedQuantity
         &times; clearingPrice &times; window_h</code>, all three
         published by NESO per row; clearing prices go negative on some
         products (Dynamic Regulation High most often), and the stack
         renders that as a band below zero rather than clipping it. The
         shaded band and its centre line are the p10 to p90 spread and
         median of that same total £/kW/day figure split across cohort
         units, the peer-group comparison, with no unit named.</p>
      <p>The denominator is <b>time-varying</b>: each day divides by the
         summed nameplate of cohort units already present in the fetched
         window on or before that day, not today's fleet size. The
         identified cohort's active capacity grew substantially across the
         shipped window, so a constant present-day denominator would
         understate the earliest days by a wide margin, not a rounding
         difference. The identified-fleet activity card above uses the
         same construction, on first observed Balancing Mechanism
         acceptance rather than first EAC appearance, so the two cards
         normalise the same way and are directly comparable.</p>
      <p>Balancing Mechanism cashflow is <b>never added to the stack
         above</b>. It settles from Elexon's indicative Bid-Offer Cashflow
         (EBOCF, the II settlement run), pricing the same accepted-volume
         actions the BM activity chart above already counts in MWh. Its
         sign follows whichever way the fleet happened to charge or
         discharge that day, not a trading outcome, and its magnitude runs
         to several times the whole availability stack (a heavy charging
         day settles deep negative purely because energy was bought, not
         lost). Stacked into the total it would both dominate the chart
         and read as batteries losing money in the Balancing Mechanism, so
         it renders as its own signed panel with its own heading, and the
         net MWh companion series on the right-hand axis so the sign of
         the money can be read directly against the sign of the energy.</p>
      <p>Wholesale arbitrage revenue is not estimated anywhere on this
         card, deliberately. The candidate proxy, notified position volume
         priced at the market index, compounds two separate errors rather
         than cancelling them: notified position is instructed intent, not
         metered output, and the market index is a volume-weighted average
         across the whole market, not the price any one unit transacted
         at. Both diverge hardest in exactly the stressed periods a
         battery arbitrage figure would be most sensitive to. Shipping it
         would put the one Estimated figure inside an otherwise Observed
         stack, at the point where the total most needs to be trusted, so
         it stays held rather than shipped. State of charge, cycling depth
         and per-unit named revenue are out of scope for the same reason
         as the activity panel above: none of them is published anywhere
         observable, and a per-unit revenue table would publish named
         commercial performance the p10/p50/p90 spread already benchmarks
         without naming anyone.</p>
      ${bessRevenueSeries
        ? `<p>Series detail for both legs, the EAC availability revenue
             and the Balancing Mechanism cashflow, is listed alongside
             every other series in the "Sources, field mapping,
             transformations" table above.</p>`
        : `<p>No BESS revenue dataset built on this machine yet, run
             <code>python etl/build_bess_revenue.py</code>.</p>`}

      <h3 id="m-bess-calc">Profitability calculator (beta)</h3>
      <p>The fourth Batteries card answers a different question from the
         two above it: not what the fleet was paid, but what a battery has
         to believe about itself to pay back, given what the market
         observably paid comparable units last year. You describe an
         asset, the calculator anchors the revenue side on the published
         record, and does the arithmetic on your own assumptions in front
         of you. The framing is deliberate and stated on the card: this is
         illustrative economics, not investment advice, not a valuation
         and not a forecast.</p>
      <p>The one-way rule: the calculator reads from this dashboard's data
         and from its own small support payload, and writes to nothing.
         No output it produces is stored, cached, exported into another
         panel's series, or included in any file other than its own CSV
         or Excel export.</p>
      <p><b>Observed vs Assumption:</b> the availability
         revenue figure behind the percentile control is the cross-unit
         distribution of trailing 365-day EAC revenue for the identified
         battery fleet (<code>etl/build_bess_units.py</code>): published
         accepted quantity times published clearing price times published
         delivery window, aggregated per unit and summarised across units
         at five percentiles. That figure is Observed. The TNUoS zone
         tariff elements are vendored, cited reference data, shown in
         prose rather than badged. Everything else on the card, every
         input you enter and every figure computed from one, including the
         whole annual cash flow, NPV, IRR, simple payback and the
         indicative LCOS, is Assumption.</p>
      <p><b>Percentile and the double-count trap:</b> you pick
         a percentile (p10 to p90) of the cross-unit distribution rather
         than the calculator multiplying a fleet average by a win
         probability. That average already divides total revenue by total
         days, including the days a unit won nothing: applying a
         participation or acceptance rate on top of it removes those zero
         days a second time. Measured on the underlying data, doing that
         understates the correct figure by 58%. The percentile is
         therefore the whole answer to "how likely is this outcome", not
         an input to be discounted further. These are rank percentiles of
         the cross-unit distribution, not the exceedance convention some
         readers bring from energy-yield work, where P90 names the
         conservative case: on this card p90 is the top-decile unit, the
         opposite of a conservative reading.</p>
      <p><b>Family toggles, and how the split stays additive:</b> the six
         service families (DC, DM, DR, BR, QR, SR) can each be switched
         off, which recomputes the £/kW/yr from that percentile's own
         family components rather than from a fleet-wide average.
         <code>etl/build_bess_units.py</code> publishes those components
         as the family split of the same rank-interpolated unit pair the
         percentile total itself is built from (the unit at the
         percentile's rank and the next one up, blended by the same
         fractional weight), not as six independently-ranked family
         percentiles: only the first definition sums back to the
         published total exactly, which the ETL asserts on every build.
         Turning a family off is an assumption about what the asset will
         contract for, not a claim about the data.</p>
      <p><b>Wholesale arbitrage, an observed ceiling with a capture
         rate:</b> a perfect-foresight calculation over the half-hourly
         prices already loaded clears positive on every complete day
         measured: mean top-2d and bottom-2d half-hourly price per day
         (d the asset's own duration), averaged across every complete
         day (at least 46 populated half-hours) in the loaded window. A
         quantity that can never lose money is not a revenue forecast of
         anything, so it is labelled a perfect-foresight ceiling
         throughout, never arbitrage revenue, and it only enters the
         cash flow once a capture rate is entered: there is no default
         capture rate, and an empty field leaves the line at zero. MID
         is a market-wide index, not a transacted price, and diverges
         from what any single asset actually achieves, particularly in
         stressed periods. A manual spread override, mirroring the
         coal-price override on the Spreads tab, replaces the observed
         ceiling entirely with a single flat £/MWh figure the user
         enters, and flips that line's provenance chip from Estimated to
         Assumption; the capture rate still applies to whichever ceiling
         is in effect. The card's Estimated badge appears only while the
         observed ceiling is the one actually contributing a non-zero
         figure, per the house rule of badging only what is active.</p>
      <p><b>Balancing Mechanism, deliberately not a projection line:</b>
         treating BM cashflow as a standalone forecast line alongside
         wholesale arbitrage would double count the same underlying
         energy volumes, because a battery's BM position is dominated by
         buying and selling the very energy the arbitrage line already
         prices. To keep the arithmetic and the physics honest, BM data
         appears exclusively as observed context in the dedicated panel
         above, never as a projection inside this calculator.</p>
      <p><b>Duration, and every cost input:</b> a plain input, with no
         shipped default. Two candidate sources
         for a duration prefill were investigated and both failed on
         measurement, not effort: the Capacity Market register's storage
         duration class joins to only a fifth of the identified fleet at a
         defensible confidence tier, and changes for one site in ten
         between delivery years, so it is a de-rating election, not a
         physical property, and cannot be trusted as a prefill. The same
         holds for CAPEX, OPEX, WACC, cycles per day, degradation and
         round-trip efficiency: this dashboard's standing principle is
         that it never ships a figure it did not measure, and it has not
         measured a market CAPEX. The placeholders on these fields are
         illustrative examples of plausible magnitudes, not sourced
         figures and not defaults; nothing is computed until you type
         your own number, and the results panel stays empty until the
         required inputs, power, energy, useful life, WACC and CAPEX,
         are all present.</p>
      <p><b>TNUoS:</b> a transmission-connected asset gets a 27-entry zone
         dropdown, populated from the vendored
         <a class="term-link" data-term="tnuos" href="#g-tnuos">TNUoS</a>
         Onshore Generator Tariffs table (charging year and publication
         date shown alongside), with
         <code>z_total(f) = SystemPeak + f x (SharedYearRound +
         NotSharedYearRound) + Residual</code> and <code>f</code>
         defaulting to cycles per day times duration divided by 24, hours,
         editable. This is a zone-level indication using the published
         tariff elements, not the full CUSC tariff calculation for a
         specific asset, and the card says so. A distribution-connected
         asset shows "not applicable" rather than a zero TNUoS line: post-
         reform, embedded generation sits outside generation TNUoS
         entirely, and the two states must stay visually distinguishable.</p>
      <p><b>The engine, in one place:</b> real terms, pre-tax, ungeared,
         no residual value. One optional augmentation event (a year, a
         size in MWh and a cost in £k/MWh, all required) adds a second
         cell tranche at the start of that year — a partial top-up, a
         full restore, or an expansion beyond nameplate, uncapped — and
         lands as capital expenditure in that year's cash flow and in
         LCOS. The original cells keep degrading on their own clock;
         the new tranche degrades at its own rate, defaulting to the
         main degradation rate. Availability revenue
         scales with power, not energy, because EAC availability is paid
         per MW of contracted capacity; a real degraded asset eventually
         loses access to a product's minimum-duration requirement, and
         that cliff is not modelled as a step — the optional
         availability derate (%/yr, default 0) is the smooth stand-in
         for it, compounding on the capacity-weighted cell age so an
         augmentation tranche rejuvenates capability in proportion to
         its size, distinct from cannibalisation, which is a market
         view on the calendar clock and never resets. Alongside IRR, a
         MIRR row finances and reinvests at WACC; it exists because an
         augmentation-year outflow gives the cash flow a second sign
         change, where plain IRR has multiple mathematically valid
         roots. Operating cost is flat in real terms,
         because escalating it on top of a real-terms discount rate is the
         commonest way to double count inflation. Cycles per day are
         constant, with no seasonality. The calculation period is capped
         at the useful life: with no residual value and no revenue after
         decommissioning, years past the life would be zero rows
         pretending to be analysis, and the card says when the cap has
         been applied. Year 1 is pro-rated by the
         fraction of the calendar year remaining after the commissioning
         date. Discounting follows a stated convention, mid-year by
         default: year n's cash flow discounts at (1+r)^(n-0.5), as if it
         landed at the year's midpoint, and the pro-rated first year
         discounts at the midpoint of its own remaining stub rather than
         the calendar year's. An end-of-period option sits alongside it,
         discounting at (1+r)^n, unchanged from how this card behaved
         before the control existed. The headline NPV is, separately,
         expressed at a chosen valuation date rather than silently at
         commissioning: t=0 for the cash-flow build-up is always the
         commissioning date, but the valuation date input re-anchors the
         headline (and the chart's cumulative-discounted line) to any
         other date, defaulting to commissioning when left blank, by one
         exact factor, (1+r) raised to the number of 365.25-day years
         between the two. A valuation date after commissioning compounds
         the figure forward; one before commissioning, a pre-decision
         appraisal, discounts it back, through the same identity. Neither
         choice moves IRR, which is
         defined on the undiscounted cash flow and stays a standard
         annual-compounding calculation either way. The discounted payback
         period, by contrast, does move with the discounting convention —
         it interpolates on discounted cash flows, so a mid-year versus
         end-of-period choice changes it — but stays unaffected by the
         valuation date: re-anchoring scales every discounted figure by the
         same one factor, which cancels in both the crossing test and the
         interpolation fraction. IRR is found by bisection over -99% to
         +150% and renders
         "no IRR", never 0%, when the cash flow never turns net-positive
         anywhere in that range. The discounted payback period interpolates
         linearly on discounted cash flows and
         renders "no payback within N years" rather than a zero when
         capital is never recovered. Indicative LCOS carries two states
         rather than one fixed shape: with no price feed in use, or with
         a manual arbitrage spread overriding it, LCOS excludes the
         battery's charging-energy cost and is a floor covering capital
         and operating cost per discharged MWh, not the full lifetime
         cost; once the observed price feed is active (no manual
         override, and a complete day of prices was found), LCOS
         includes the charging-energy cost at the observed bottom-of-day
         mean price, and the results panel says which of the two applies.
         The discharged-energy denominator is discounted at the same
         rate as the costs, a stated choice rather than the only valid
         one.</p>
      <p><b>Held for a later release</b> (plan/09 D34): pick-a-unit mode
         and its per-unit disclosure, plus the acceptance-rate context
         table. The "Pick a unit" mode control is visible now, disabled,
         with a note, precisely so the card does not silently change
         shape later.</p>
      <p>The export is numeric only: year, capex, availability (plus one
         column per service family), arbitrage, opex, TNUoS, net and
         discounted cash flow, cumulative discounted cash flow,
         discharged energy and usable energy, plus a header comment block
         carrying your inputs, including the family toggle state and the
         arbitrage ceiling's own parameters (<code>s_hi</code>,
         <code>s_lo</code>, the capture rate or the manual spread). No
         unit, party or site name is ever exported, the same rule the BMU
         snapshot table and the activity/revenue export already apply.</p>
      <p><b>Excel export, a working model rather than a numeric
         record:</b> a second export, "Export model (Excel)", writes a
         real <code>.xlsx</code> whose Cover, Assumptions and DCF sheets
         hold live formulas over the same assumptions cells, not values
         printed from JavaScript, so changing WACC or the discounting
         flag inside the spreadsheet itself recalculates NPV, IRR, MIRR,
         discounted payback, a profitability index and LCOS. Costs sit as
         positive numbers subtracted in
         the totals there, the opposite sign convention to the CSV's
         negative opex and TNUoS columns; the magnitudes agree and the
         Cover sheet says so in one line. A colour key on the Cover sheet
         sets out the convention: blue text on a pale yellow fill is an
         input, black text is a formula, navy text is a value the
         dashboard measured or looked up (the family revenue components,
         the published percentile total, TNUoS tariffs), never typed in
         and never calculated on the sheet, and green text is a plain
         link to another sheet with no calculation of its own (the DCF
         sheet's general-assumptions block, and the Cover headline's own
         links back to the DCF sheet). The DCF sheet groups its
         rows under numbered grey section bands, with gridlines switched
         off throughout the workbook. The family and zone blocks carry
         the same toggles and check row the card itself uses. The
         valuation date sits on the Assumptions sheet and the DCF year
         grid discounts straight to it - a discount factor above 1
         compounds a pre-valuation year forward; the commissioning-
         anchored figure is kept alongside as a labelled check row,
         never dropped. The workbook stores no cached values, so a reader
         that does not recalculate formulas should use the CSV instead.
         It carries the same no-names rule and the same illustrative-
         economics sentence as the card and the CSV.</p>

      <h3 id="m-overnight">Overnight summary (AI-generated)</h3>
      <p>The collapsible panel below the KPI strip is written by an LLM,
         the <code>dashboard-watcher</code> agent, invoked headlessly by
         <code>ops/run_overnight_summary.py</code> during the daily
         refresh. It produces <b>one section per tab</b>, and each tab
         shows only its own. Overview, Prices and Generation share the
         general overnight narrative. Merit order analyses the gap
         between the panel's implied clearing price and the observed
         price. Spreads places spark/dark against their own history.
         Flows covers cable direction changes and import dependency.</p>
      <p>Every statistic the agent uses, baselines, z-scores, spread
         percentiles, cable facts and the merit figures, is precomputed
         deterministically with the dashboard's exact formulas
         (<code>ops/panel_facts.py</code>,
         <code>ops/merit_panel_figures.py</code>) and injected into the
         prompt. The publisher rejects a summary whose figures or window
         deviate, so the LLM writes the narrative but never computes a
         number. The agent is instructed to synthesise: at most two
         causally-explained findings per tab, with correlated hours
         collapsed into one finding, rather than enumerate threshold
         crossings. It compares the last 24 hours against a trailing 14-day
         baseline and reports data-quality flags separately.</p>
      <p>It is an <b>interpretation of the published dataset, not a data
         series</b>, hence the distinct dashed styling and AI-generated
         badge. Hypotheses are phrased as "consistent with". The agent is
         instructed never to assert market events it cannot support from
         the data. A failed generation leaves the previous summary in
         place. If none exists, the panel says so rather than guessing.
         The panel is collapsed by default (takeaway line only) and
         expands on click.</p>
      <p>Why the panel is Claude-only by design is judgement call 13 in
         the repository's <a class="doc-link" href="https://github.com/lptva/gb-power-dashboard/blob/main/methodology.md#judgement-calls-a-reviewer-should-know-about"
         target="_blank" rel="noopener">methodology.md</a>.</p>

      <h3 id="m-refresh">Refresh process</h3>
      <p><code>python etl/build_dataset.py --incremental</code> re-fetches
         the last two stored days plus anything newer. Upstream revisions
         are overwritten. It merges onto the published dataset, keeps the
         window rolling at 365 days, and publishes atomically behind a
         validation guard. The guard refuses to publish a merged dataset
         whose time axis is broken, or whose coverage falls more than two
         percentage points (2 pp) below the published one. A failed run
         leaves the live files untouched.</p>
      <p>A versioned <code>manifest.json</code> cache-busts the data
         files. A launchd job (installed via
         <code>ops/install_schedule.sh</code>) runs this daily at 07:00
         local time. Missed runs fire on wake, see
         <code>ops/README.md</code>.</p>
      <p>The header's "updated … ago" element and the footer's "Dataset
         built" timestamp are the staleness signals. The header turns
         amber past 26 h, one missed daily refresh. This is a freshness
         signal, not a data-quality badge. A full rebuild is
         <code>--days 365</code>.</p>
      <p>The same scheduled run also appends the day's stress metrics
         (<code>etl/fetch_stress.py</code>, non-fatal). First-time build:
         <code>--backfill 365</code>.</p>

      <h3 id="m-csv">CSV downloads</h3>
      <p>The ⤓ CSV button downloads the data behind the active tab. The
         filename encodes the tab, the date window and, where the tab has
         one, the selected resolution. It is hidden on Glossary and
         Methodology, since neither view has data behind it.</p>
      <p><code>&lt;zone&gt;_market_&lt;from&gt;_&lt;to&gt;_&lt;res&gt;.csv</code>
         (Overview, Prices, Generation): a timestamp column, price in the
         zone's own settlement currency, demand, one column per fuel that
         carries a real signal in that zone, and <code>net_imports_mw</code>
         where interconnector data exists (GB). Values are bucket means at
         the selected resolution. Observed data, net imports derived.</p>
      <p><code>gb_spreads_&lt;from&gt;_&lt;to&gt;.csv</code> (Spreads): the
         existing daily columns, including <code>carbon_is_ffill</code> and
         <code>coal_is_ffill</code>. The coal trio (proxy price, ffill flag,
         clean dark spread) appears only when a coal price exists, and a
         manual coal entry leaves the ffill flag blank for that row.
         Observed inputs, Estimated spreads, coal Proxy or Assumption
         depending on source.</p>
      <p><code>gb_flows_&lt;from&gt;_&lt;to&gt;_&lt;res&gt;.csv</code>
         (Flows): a timestamp, <code>net_imports_mw</code>, and one signed
         MW column per cable, positive for import. Two things worth
         knowing. First, per-cable cells keep gaps as gaps, but
         <code>net_imports_mw</code> counts a missing cable reading as
         zero, so a row with a gap will not sum exactly across it. That is
         existing behaviour, stated here, not fixed. Second, utilisation
         and congestion columns are deliberately absent: they are
         window-level views built from a trailing 90-day ceiling window
         (see Utilisation ranking and Congestion proxy above), not
         quantities this tab computes per row. To reproduce the ranking
         table from an export, take a 30-minute export covering the
         trailing 90 days (the 3M preset or longer) and apply the
         documented rules: the 4th-largest reading per direction, the 90%
         near-capacity threshold and the 5% nameplate floor for treating a
         direction as offline. The congestion proxy cannot be reproduced
         from exports at all, because it also needs the counterparty
         day-ahead price series, which this file does not carry.</p>
      <p><code>gb_stress_&lt;from&gt;_&lt;to&gt;.csv</code> (System stress,
         daily): the metric columns mirror the <code>stress_daily.json</code>
         fields tabled above, plus <code>emn_count</code> and
         <code>flags</code>. <code>emn_count</code> is the number of
         Electricity Margin Notices issued that day, observed from Elexon
         SYSWARN with publish-date attribution and cancellation notices
         excluded. 0 means no EMN was issued that day. In
         <code>stress_daily.json</code> itself the key is present only on
         days with at least one issuance, and the CSV writes the zero
         explicitly. <code>flags</code> is the day's fired flag types
         joined with a "+", empty when none fired. Per-flag values and
         thresholds, and the display-only percentile context, stay in
         <code>stress_daily.json</code>, which this file points at rather
         than repeating.</p>
      <p><code>gb_merit_&lt;date&gt;.csv</code> (Merit order): one row per
         plotted tranche of the modelled curve, SRMC ascending, Estimated
         throughout. It is a snapshot at the latest observed inputs, dated
         by the window end, not a range series. <code>capacity_basis</code>
         reads <code>latest_observed</code> for wind and solar and
         <code>p98_observed</code> for everything else,
         <code>contains_assumptions</code> flags technologies whose SRMC
         range is a broad estimate, and the constant input columns (gas
         SAP, UKA, coal when present) repeat on every row so the file is
         self-reproducing against the SRMC formulas above. The
         observed-dispatch panel's raw per-unit data is a separate served
         file, <code>data/bmu_snapshot.json</code>, and the SRMC-vs-price
         time series is reproducible from the spreads CSV plus the CCGT
         SRMC formula.</p>
      <p><code>gb_bess_activity_&lt;from&gt;_&lt;to&gt;.csv</code>
         (Batteries): one row per day either optional payload has in the
         selected range, Observed. <code>offer_mwh</code> (≥0),
         <code>bid_mwh</code> (≤0) and their <code>net_mwh</code> read each
         day's always-present daily totals directly (every stored day
         carries them, regardless of tier). <code>fleet_units</code>/
         <code>fleet_mw</code> repeat on every row, constant for the whole
         file (the registered fleet does not vary by day);
         <code>denominator_mw</code>/<code>denominator_units</code> are the
         activity side's own per-day divisor, the capacity first
         dispatched in the Balancing Mechanism on or before that day, so
         the "per MW of fleet active to date" chart toggle is reproducible
         from the export row by row without a free-text column. Twelve
         <code>eac_&lt;product&gt;_gbp_per_kw_day</code> columns carry the
         EAC availability stack, signed, zero-filled where a product
         cleared nothing that day; <code>bm_offer_gbp_per_kw_day</code>,
         <code>bm_bid_gbp_per_kw_day</code>, <code>bm_offer_mwh</code> and
         <code>bm_bid_mwh</code> carry the BM cashflow sub-panel (never
         summed with the EAC columns); and <code>denominator_kw</code> is
         the revenue side's own per-day divisor (in kW, so the unit
         disambiguates it from the activity side's
         <code>denominator_mw</code>). The activity and revenue payloads
         can differ in exactly which days they have fetched, so a row can
         carry one side and leave the other blank, an honest gap rather
         than a zero. The fleet's name and owner never appear here: see
         the Identified fleet table on the tab itself, which has no
         export. No dataset built yet, or no stored days in range, →
         header-only file. The revenue chart displays £/MW/day (see
         above); that is display-only and does not touch this export —
         every EAC and BM column here stays £/kW/day, the payload unit.</p>
      <p>No export contains free text in any data cell: every value is a
         number, an ISO date or timestamp, a boolean, or a value from a
         fixed token set, because the CSV writer does no comma-escaping.
         The one scoped exception is the BESS profitability calculator's
         CSV and Excel exports, which carry a free-text <code>#</code>
         header comment block (your inputs, the illustrative-economics
         disclaimer, and an ONS CPI provenance note) above the data, and
         free text never enters a data cell.</p>

      <h3 id="m-limits">Known limitations</h3>
      <ul>
        <li>MID is a proxy, not the day-ahead auction price.</li>
        <li>UKA prices are monthly averages with a publication lag.</li>
        <li>Gas SAP is within-day, lagging the forward curve in fast markets.</li>
        <li>No unit commitment, network constraints or balancing actions are
            modelled anywhere in this app.</li>
        <li>Stress flags are threshold rules on observed daily metrics.
            They mark notable days for inspection. They do not model
            security margins, N-1 conditions or reserve adequacy.</li>
        <li>Embedded wind is invisible to all sources used.</li>
        <li>A flow-based RAM decomposition (IVA / FRM / AAC / Fnrao /
            F0−Fnrao, as shown on Nordic/Core CCR dashboards) cannot be
            built for GB. It requires TSO-level flow-based allocation
            data that does not exist for per-cable, explicitly allocated
            interconnectors. Simulating the components would fabricate
            data, permanently out of scope. The congestion proxy above
            is the honest substitute.</li>
      </ul>`;
    finalizeMethodologyLayout();
  }

  /* ---------------- CSV export ---------------- */

  /* Per-tab CSV builders. Each takes (st, win) — win is State.window() —
     and returns { columns, name }: columns is the {header: array} object
     Metrics.toCsv expects, name is the download filename. The tab keys
     match index.html data-tab exactly (note "generation", not "gen").
     HARD RULE: no free-text columns in any export — Metrics.toCsv does no
     comma-escaping, so every value stays a number, ISO date/timestamp,
     boolean, or closed token set (that is why merit's `note` is dropped
     and stress flags collapse to a "+"-joined type set). */

  /* Zone-aware market export (Overview/Prices/Generation): whatever fuel
     columns the active zone actually carries (Data.* is already swapped
     per zone by Data.load), plus net imports only where interconnector
     data exists (GB). Price header carries the zone's settlement
     currency, not hardcoded GBP. */
  function buildMarketCsv(st, win) {
    const { fromTs, toTs, fromIso, toIso } = win;
    const sec = State.bucketSeconds();
    const zone = st.zone.toLowerCase();
    const curCode = (st.zone === "GB" ? "GBP"
      : (Data.meta.currency || "EUR")).toLowerCase();
    // hasSignal excludes absent AND constant-zero placeholder columns
    // (e.g. IE solar) — their zeros are TSO artefacts, not output.
    const keys = ["price", "demand",
      ...Data.STACK_ORDER.filter((k) => Data.hasSignal(k)),
      ...(Object.keys(Data.INTERCONNECTORS).some((k) => Data.hh[k])
        ? ["netImports"] : [])];
    const columns = {};
    keys.forEach((k) => {
      const agg = Data.aggregate(k, fromTs, toTs, sec);
      if (!columns.timestamp_utc) {
        columns.timestamp_utc = agg.t.map((t) =>
          new Date(t).toISOString());
      }
      const header = k === "price" ? `price_${curCode}_mwh`
        : k === "netImports" ? "net_imports_mw" : k.toLowerCase();
      columns[header] = agg.v.map((v) =>
        v == null ? null : +v.toFixed(2));
    });
    const name = `${zone}_market_${fromIso}_${toIso}_` +
      `${State.effectiveResolution()}.csv`;
    return { columns, name };
  }

  /* Daily clean-spread export. Coal trio (proxy, ffill flag, clean dark)
     only when a coal price exists — manual entry overrides the ETL
     proxy; ffill flag is blank under a manual override. */
  function buildSpreadsCsv(st, win) {
    const { fromIso, toIso } = win;
    const a = st.assumptions;
    const d = Data.dailySlice(fromIso, toIso,
      ["price", "gas_sap", "carbon_uka_month", "carbon_ffill",
       "coal_proxy_gbp_mwh", "coal_ffill"]);
    const columns = {
      date: d.d, price_gbp_mwh: d.price, gas_sap_gbp_mwh_th: d.gas_sap,
      carbon_uka_gbp_t: d.carbon_uka_month, carbon_is_ffill: d.carbon_ffill,
      clean_spark_gbp_mwh: Metrics.cleanSparkSpread(d.price, d.gas_sap,
        d.carbon_uka_month, { eta: a.eta, efGas: a.efGas, vom: a.vom }),
    };
    const coal = State.coalInfo();
    if (coal) {
      const coalInput = coal.source === "manual"
        ? coal.value : d.coal_proxy_gbp_mwh;
      columns.coal_proxy_gbp_mwh_th = coal.source === "manual"
        ? d.d.map(() => coal.value) : d.coal_proxy_gbp_mwh;
      columns.coal_is_ffill = coal.source === "manual"
        ? d.d.map(() => "") : d.coal_ffill;
      columns.clean_dark_gbp_mwh = Metrics.cleanDarkSpread(
        d.price, d.carbon_uka_month, coalInput,
        { etaCoal: a.etaCoal, efCoal: a.efCoal, vomCoal: a.vomCoal });
    }
    const name = `gb_spreads_${fromIso}_${toIso}.csv`;
    return { columns, name };
  }

  /* Merit-order snapshot: one row per plotted tranche, SRMC-ascending —
     the exact tranche list the chart plots (Metrics.meritLadder →
     meritCurveSteps at the latest observed gas SAP + UKA over the shared
     Data.meritCapacityGw proxy). Fuel/carbon (and coal) inputs repeat on
     every row so the snapshot is self-describing. `note` is excluded
     (free text). Missing gas SAP or UKA → header-only file. */
  function buildMeritCsv(st, win) {
    const { toIso } = win;
    const coal = State.coalInfo();
    const header = ["technology", "srmc_gbp_mwh",
      "cum_capacity_from_gw", "cum_capacity_to_gw", "tranche_gw",
      "tech_srmc_low_gbp_mwh", "tech_srmc_high_gbp_mwh",
      "tech_capacity_gw", "capacity_basis", "contains_assumptions",
      "gas_sap_gbp_mwh_th", "carbon_uka_gbp_t",
      ...(coal ? ["coal_gbp_mwh_th", "coal_source"] : [])];
    const columns = {};
    header.forEach((h) => { columns[h] = []; });

    const gasRow = Data.latestDaily("gas_sap");
    const carbonRow = Data.latestDaily("carbon_uka_month");
    if (gasRow && carbonRow) {
      // Re-derive the coal-augmented assumptions inline (3 lines over
      // State.coalInfo()) rather than widening the Charts API; mirrors
      // charts.js assumptionsWithCoal so CSV and chart share inputs.
      const a = { ...st.assumptions,
        coalPrice: coal ? coal.value : null,
        coalSource: coal ? coal.source : null };
      const rows = Metrics.meritLadder(gasRow.value, carbonRow.value, a);
      const steps = Metrics.meritCurveSteps(rows, Data.meritCapacityGw());
      steps.forEach((t) => {
        columns.technology.push(t.key);
        columns.srmc_gbp_mwh.push(t.srmc);
        columns.cum_capacity_from_gw.push(t.x0);
        columns.cum_capacity_to_gw.push(t.x1);
        columns.tranche_gw.push(t.widthGw);
        columns.tech_srmc_low_gbp_mwh.push(t.low);
        columns.tech_srmc_high_gbp_mwh.push(t.high);
        columns.tech_capacity_gw.push(t.techCapacityGw);
        // capBasis distinction mirrored from the chart tooltip.
        columns.capacity_basis.push(
          t.key === "WIND" || t.key === "solar"
            ? "latest_observed" : "p98_observed");
        columns.contains_assumptions.push(t.assumed);
        columns.gas_sap_gbp_mwh_th.push(gasRow.value);
        columns.carbon_uka_gbp_t.push(carbonRow.value);
        if (coal) {
          columns.coal_gbp_mwh_th.push(coal.value);
          columns.coal_source.push(coal.source);
        }
      });
    }
    const name = `gb_merit_${toIso}.csv`;
    return { columns, name };
  }

  /* Interconnector flows: same aggregation/resolution machinery as the
     market builder, one signed-MW column per cable that carries data
     (Data.INTERCONNECTORS order; +ve = import). Utilisation/congestion
     are deliberately omitted — they are window-level metrics on a
     separate 90-day ceiling window, not per-row quantities this tab ever
     computes (covered in the methodology); a per-row column would
     fabricate a number. */
  function buildFlowsCsv(st, win) {
    const { fromTs, toTs, fromIso, toIso } = win;
    const sec = State.bucketSeconds();
    const columns = {};
    const net = Data.aggregate("netImports", fromTs, toTs, sec);
    columns.timestamp_utc = net.t.map((t) => new Date(t).toISOString());
    columns.net_imports_mw = net.v.map((v) =>
      v == null ? null : +v.toFixed(2));
    Object.keys(Data.INTERCONNECTORS).forEach((k) => {
      if (!Data.hh[k]) return;
      const agg = Data.aggregate(k, fromTs, toTs, sec);
      columns[`${k.toLowerCase()}_mw`] = agg.v.map((v) =>
        v == null ? null : +v.toFixed(2));
    });
    const name = `gb_flows_${fromIso}_${toIso}_` +
      `${State.effectiveResolution()}.csv`;
    return { columns, name };
  }

  /* Daily system-stress export. Rows = stored days in [fromIso, toIso]
     (same filter as the stress chart). Only closed-token/number columns:
     flags collapse to a "+"-joined set of their `type` fields (the
     free-text flag detail is dropped); emn_count defaults to 0 (the true
     observed count — the key exists only on days with ≥1 issuance). No
     stress data or no days in window → header-only (still valid). */
  function buildStressCsv(st, win) {
    const { fromIso, toIso } = win;
    const metrics = ["freq_min", "freq_max", "freq_coverage_pct",
      "secs_below_49p8", "secs_above_50p2", "secs_below_49p5",
      "lolp_max_1h", "lolp_max_8h", "lolp_max_12h",
      "drm_min_1h", "drm_min_8h", "drm_min_12h",
      "ssp_max", "ssp_min", "ssp_max_sp"];
    const columns = {};
    ["date", ...metrics, "emn_count", "flags"].forEach((h) => {
      columns[h] = [];
    });
    const s = Data.stress;
    const keys = s && s.days
      ? Object.keys(s.days).sort().filter((k) => k >= fromIso && k <= toIso)
      : [];
    keys.forEach((k) => {
      const day = s.days[k];
      columns.date.push(k);
      metrics.forEach((m) => columns[m].push(day[m] ?? null));
      columns.emn_count.push(day.emn_count ?? 0);
      columns.flags.push((day.flags || []).map((f) => f.type).join("+"));
    });
    const name = `gb_stress_${fromIso}_${toIso}.csv`;
    return { columns, name };
  }

  /* Batteries (BESS) daily export. Rows = the UNION of stored days in
     [fromIso, toIso] across BOTH optional secondary payloads: activity
     (bess_activity.json, dict keyed by day) and revenue
     (bess_revenue.json, columnar with a plain `days` array — plan/08 D16).
     The two payloads can cover different windows (both retain 400 days,
     but each is only as deep as its own backfill has run), so a row
     can carry one side and leave the other blank — that is a real gap in
     what has been fetched, not a bug, and is left as an empty cell rather
     than a zero.

     offer_mwh/bid_mwh/net_mwh read each day's always-present daily totals
     (offer_mwh_total/bid_mwh_total, addendum §B1) directly — no HH-array
     summing. denominator_mw/denominator_units are the activity side's
     PER-DAY normalisation divisor (addendum §A: the capacity first
     dispatched on or before that day), replacing the old constant
     window_active_units/window_active_mw columns net-zero — the
     normalised chart is now reproducible from the file row by row, which
     the constant columns could only do while the divisor was constant.
     fleet_units/fleet_mw stay as repeated constants (the Merit CSV
     precedent: registered fleet size does not vary per day). The twelve
     EAC product columns, the four BM cashflow/volume columns and
     denominator_kw (the REVENUE side's own per-day divisor, in kW so the
     unit disambiguates it from the activity side's denominator_mw) are
     plan/08 D16's addition; per the HARD RULE no export carries free
     text, so the fleet identified by name/party (see the Identified
     fleet table) never appears here.  No dataset, or no days in the
     window, → header-only (still a valid CSV). */
  function buildBessCsv(st, win) {
    const { fromIso, toIso } = win;
    const PRODUCTS = ["DCL", "DCH", "DML", "DMH", "DRL", "DRH",
      "PBR", "NBR", "PQR", "NQR", "PSR", "NSR"];
    const columns = { date: [], offer_mwh: [], bid_mwh: [], net_mwh: [],
      acceptances: [], active_units: [], active_mw: [],
      fleet_units: [], fleet_mw: [],
      denominator_mw: [], denominator_units: [] };
    PRODUCTS.forEach((p) => {
      columns[`eac_${p.toLowerCase()}_gbp_per_kw_day`] = [];
    });
    columns.bm_offer_gbp_per_kw_day = [];
    columns.bm_bid_gbp_per_kw_day = [];
    columns.bm_offer_mwh = [];
    columns.bm_bid_mwh = [];
    columns.denominator_kw = [];

    const a = Data.bess;
    const r = Data.bessRevenue;
    const aKeys = a && a.days
      ? Object.keys(a.days).filter((k) => k >= fromIso && k <= toIso) : [];
    const rIndex = new Map();
    if (r && Array.isArray(r.days)) {
      r.days.forEach((d, i) => {
        if (d >= fromIso && d <= toIso) rIndex.set(d, i);
      });
    }
    const keys = [...new Set([...aKeys, ...rIndex.keys()])].sort();
    const fleet = a && a.fleet;

    keys.forEach((k) => {
      columns.date.push(k);
      const day = a && a.days && a.days[k];
      if (day) {
        // Every stored day carries the daily totals regardless of tier
        // (addendum §B1), so this reads them directly — no HH-array
        // summing, and no tier branch.
        const offer = day.offer_mwh_total ?? 0;
        const bid = day.bid_mwh_total ?? 0;
        columns.offer_mwh.push(+offer.toFixed(1));
        columns.bid_mwh.push(+bid.toFixed(1));
        columns.net_mwh.push(+(offer + bid).toFixed(1));
        columns.acceptances.push(day.acceptances ?? 0);
        columns.active_units.push(day.active_units ?? 0);
        columns.active_mw.push(day.active_mw ?? 0);
        columns.denominator_mw.push(day.denominator_mw ?? null);
        columns.denominator_units.push(day.denominator_units ?? null);
      } else {
        columns.offer_mwh.push(null);
        columns.bid_mwh.push(null);
        columns.net_mwh.push(null);
        columns.acceptances.push(null);
        columns.active_units.push(null);
        columns.active_mw.push(null);
        columns.denominator_mw.push(null);
        columns.denominator_units.push(null);
      }
      columns.fleet_units.push(fleet ? fleet.units : null);
      columns.fleet_mw.push(fleet ? fleet.mw : null);

      const ri = rIndex.has(k) ? rIndex.get(k) : null;
      PRODUCTS.forEach((p) => {
        const col = `eac_${p.toLowerCase()}_gbp_per_kw_day`;
        const series = r && r.eac_gbp_per_kw_day && r.eac_gbp_per_kw_day[p];
        columns[col].push(ri != null && series ? series[ri] ?? null : null);
      });
      if (ri != null && r && r.bm) {
        columns.bm_offer_gbp_per_kw_day.push(
          r.bm.offer_gbp_per_kw_day[ri] ?? null);
        columns.bm_bid_gbp_per_kw_day.push(
          r.bm.bid_gbp_per_kw_day[ri] ?? null);
        columns.bm_offer_mwh.push(r.bm.offer_mwh[ri] ?? null);
        columns.bm_bid_mwh.push(r.bm.bid_mwh[ri] ?? null);
        columns.denominator_kw.push(
          r.denominator_kw ? r.denominator_kw[ri] ?? null : null);
      } else {
        columns.bm_offer_gbp_per_kw_day.push(null);
        columns.bm_bid_gbp_per_kw_day.push(null);
        columns.bm_offer_mwh.push(null);
        columns.bm_bid_mwh.push(null);
        columns.denominator_kw.push(null);
      }
    });
    const name = `gb_bess_activity_${fromIso}_${toIso}.csv`;
    return { columns, name };
  }

  // Registry keyed by tab (index.html data-tab). Overview/Prices/
  // Generation share the market builder; unknown tabs fall back to it.
  const CSV_BUILDERS = {
    overview: buildMarketCsv,
    prices: buildMarketCsv,
    generation: buildMarketCsv,
    spreads: buildSpreadsCsv,
    merit: buildMeritCsv,
    flows: buildFlowsCsv,
    stress: buildStressCsv,
    bess: buildBessCsv,
  };

  function exportCsv() {
    const st = State.get();
    const win = State.window();
    const { columns, name } = (CSV_BUILDERS[st.tab] || buildMarketCsv)(st, win);
    const blob = new Blob([Metrics.toCsv(columns)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return { renderDataAge, renderRefreshStatus, renderStressChip,
           renderWarnings, renderGlossary,
           renderGlance, renderOvernight, renderKpis, renderAssumptions,
           renderMethodology, jumpToMethodology, exportCsv };
})();

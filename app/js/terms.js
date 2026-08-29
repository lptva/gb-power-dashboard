/* terms.js — single source of truth for plain-language term definitions.
   Rendered by the Glossary tab and (next pass) by metric hover tooltips:
   one string per term, never maintained twice.

   Fields per entry:
     label   display name (glossary sorts alphabetically on this)
     short   plain-language definition — must stand alone as a tooltip
     extra   optional continuation, Glossary tab only
     gb      true = GB-market-specific term (tagged in the UI; the
             glossary shows on every zone because it documents the app)
     elexon  Elexon BSC glossary page carrying the formal "BSC defined
             definition" — linked, never copied: that wording is written
             in code/legal language, ours deliberately is not. Only pages
             verified to exist are linked (checked 2026-07-12).
     method  in-app methodology anchor (m-<id>) for the full derivation */

const Terms = {
  accepted_volume: {
    label: "Accepted volume (bid/offer)",
    gb: true,
    short: "The MWh NESO instructed a unit to deviate from its own " +
      "notified position in the Balancing Mechanism: an offer acceptance " +
      "means go above it, a bid means go below it.",
    extra: "For a battery this is instructed deviation, not delivered " +
      "energy or state of charge — accepted volume can exceed metered " +
      "throughput. The Batteries tab sums it signed: offer positive, bid " +
      "negative.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/bid-offer-acceptance/",
    method: "bess",
  },
  assumption_badge: {
    label: "Assumption (badge)",
    short: "An input you choose rather than a value anyone measured, " +
      "like a manually entered coal price.",
    extra: "Assumptions stay adjustable in the UI and are never baked " +
      "into stored data.",
  },
  balancing_mechanism: {
    label: "Balancing Mechanism (BM)",
    gb: true,
    short: "NESO's tool for keeping the grid balanced in real time: " +
      "units offer to raise or lower output close to delivery, and NESO " +
      "accepts the offers it needs.",
    extra: "Everything the System stress tab prices (SSP) or counts " +
      "(acceptances) happens here.",
  },
  bess: {
    label: "BESS (Battery Energy Storage System)",
    gb: true,
    short: "A grid-connected battery installation that can charge and " +
      "discharge on NESO's instruction. The Batteries tab tracks the " +
      "identified GB fleet's accepted Balancing Mechanism volumes, not " +
      "revenue or state of charge.",
    extra: "The identified fleet is derived from public BM Unit registry " +
      "attributes (a symmetric generation/demand registration or a " +
      "battery name), not an asserted list — see Methodology.",
    method: "bess",
  },
  bmu: {
    label: "BM Unit (BMU)",
    gb: true,
    short: "The smallest block of plant or demand NESO can instruct on " +
      "its own: usually one generating unit or a group of meters, " +
      "registered in the Balancing Mechanism.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/bm-unit/",
    method: "bmu",
  },
  boalf: {
    label: "Bid-Offer Acceptance (BOA / BOALF)",
    gb: true,
    short: "An instruction from NESO telling a BM Unit to change its " +
      "output: the accepted slice of the Balancing Mechanism.",
    extra: "BOALF is the BMRS dataset of these acceptances (\"Level " +
      "Flagged\"). The observed-dispatch panel counts them per fuel.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/bid-offer-acceptance/",
    method: "bmu",
  },
  bidding_zone: {
    label: "Bidding zone",
    short: "An area with one wholesale electricity price: GB is a " +
      "single zone, and Ireland with Northern Ireland shares the " +
      "all-island SEM zone.",
    extra: "Trading between zones needs interconnector capacity.",
    method: "counterparty",
  },
  dark_spread: {
    label: "Clean dark spread",
    gb: true,
    short: "A coal plant's estimated margin per MWh: power price minus " +
      "coal fuel cost minus the carbon cost of burning it.",
    method: "dark",
  },
  spark_spread: {
    label: "Clean spark spread",
    gb: true,
    short: "A gas (CCGT) plant's estimated margin per MWh: power price " +
      "minus gas fuel cost minus the carbon cost of burning it.",
    method: "spark",
  },
  congestion_proxy: {
    label: "Congestion proxy",
    gb: true,
    short: "This dashboard's stand-in for interconnector congestion: " +
      "flow at the cable's working ceiling while the price gap is wide " +
      "in the direction the flow earns. Not a shadow price.",
    method: "utilisation",
  },
  day_ahead: {
    label: "Day-ahead auction",
    short: "The main European wholesale auction, held the day before " +
      "delivery, clearing one price per bidding zone per period.",
    extra: "GB's own auction prices are commercial data, so this " +
      "dashboard shows MID for GB and true day-ahead prices for the " +
      "ENTSO-E zones.",
    method: "price",
  },
  dc_dm_dr: {
    label: "Dynamic Containment / Moderation / Regulation",
    gb: true,
    short: "NESO's three frequency-response services, each split into a " +
      "low-frequency leg and a high-frequency leg: Containment reacts " +
      "fastest (within one second), Moderation and Regulation " +
      "progressively slower and deeper into a frequency deviation.",
    extra: "For a battery, a low leg means standing ready to inject " +
      "power when frequency falls (discharge) and a high leg means " +
      "standing ready to absorb it when frequency rises (charge). " +
      "Each leg clears its own EAC auction price and can go " +
      "negative in the revenue stack. The two legs of a service " +
      "routinely clear opposite signs on the same day, which is why the " +
      "stack keeps all six bands rather than netting them together.",
    method: "bess-revenue",
  },
  eac: {
    label: "Enduring Auction Capability (EAC)",
    gb: true,
    short: "NESO's platform for auctioning frequency-response and " +
      "reserve capacity (Dynamic Containment/Moderation/Regulation plus " +
      "Balancing, Quick and Slow Reserve), publishing accepted volume " +
      "and clearing price per unit, per product, per delivery window.",
    extra: "The revenue stack is built entirely from this published, " +
      "pay-as-clear data: accepted quantity times clearing price times " +
      "the delivery window length. The twelve stack bands are the six " +
      "services times their two directions. A single unit rarely holds " +
      "all of them: the same megawatt cannot carry overlapping " +
      "obligations in the same delivery window, so a typical battery " +
      "wins a small portfolio of products per window and the fleet-wide " +
      "stack averages winners and non-winners together.",
    method: "bess-revenue",
  },
  reserve_products: {
    label: "Balancing / Quick / Slow Reserve",
    gb: true,
    short: "NESO's three reserve services, each bought in a positive " +
      "direction (extra output held ready) and a negative direction " +
      "(extra absorption held ready): Quick Reserve activates in " +
      "minutes for short imbalances, Balancing Reserve backs the " +
      "Balancing Mechanism through the day, and Slow Reserve covers " +
      "longer, slower-building shortfalls.",
    extra: "All three are procured day-ahead through the EAC auctions " +
      "alongside the frequency-response products, as availability " +
      "payments per megawatt per delivery window. Batteries bid in all " +
      "of them but earn most of their reserve revenue where fast " +
      "activation matters; the revenue stack shows each direction as " +
      "its own band because the two directions clear separately.",
    method: "bess-revenue",
  },
  drm: {
    label: "De-rated margin (DRM)",
    gb: true,
    short: "NESO's forecast of spare generation headroom for a " +
      "half-hour, after discounting each plant for the chance it fails; " +
      "low DRM means a tight margin.",
    extra: "Published at fixed lead times: 12:00 the day ahead, then 8, " +
      "4, 2 and 1 hours before delivery. The System stress tab stores it " +
      "for context and deliberately keeps it out of the flag rules.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/de-rated-margin-forecast/",
    method: "stress",
  },
  derived_flags: {
    label: "Derived flags (System stress)",
    gb: true,
    short: "Amber markers set by fixed threshold rules over observed " +
      "metrics, computed when the dataset is built; they mark notable " +
      "days, not a safety verdict.",
    method: "stress",
  },
  emn: {
    label: "Electricity Margin Notice (EMN)",
    gb: true,
    short: "A NESO system warning that forecast margin looks too thin " +
      "without extra market response: a formal call for more capacity, " +
      "not a blackout warning.",
    extra: "A cancellation notice withdraws one and does not count as " +
      "an issuance here.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/system-warning/",
    method: "stress",
  },
  entsoe: {
    label: "ENTSO-E",
    short: "The European network of transmission system operators. Its " +
      "Transparency Platform publishes each zone's prices, load and " +
      "generation, and every non-GB zone here is sourced from it.",
    method: "sources",
  },
  estimated_badge: {
    label: "Estimated (badge)",
    short: "A value computed with stated assumptions or a published " +
      "model rather than measured directly; the method is always on the " +
      "Methodology tab.",
  },
  fuelhh: {
    label: "FUELHH",
    gb: true,
    short: "The BMRS half-hourly generation-by-fuel dataset (gas, wind, " +
      "nuclear, interconnector flows…) behind the generation and flows " +
      "panels.",
    extra: "It covers transmission-connected plant only: rooftop solar " +
      "and small embedded generators are invisible to it.",
    method: "generation",
  },
  gas_sap: {
    label: "Gas SAP",
    gb: true,
    short: "National Gas's System Average Price: the volume-weighted " +
      "average of the day's GB gas trades, in £ per MWh of heat. It is " +
      "the dashboard's gas-cost input.",
    method: "spark",
  },
  indo: {
    label: "INDO",
    gb: true,
    short: "Initial National Demand Outturn: the first estimate of GB " +
      "transmission-level demand, already net of rooftop solar and " +
      "embedded wind.",
    extra: "That netting is why residual load subtracts only " +
      "transmission wind: subtracting solar again would count it twice.",
    method: "residual",
  },
  interconnector: {
    label: "Interconnector",
    short: "A high-voltage cable linking two electricity markets. GB " +
      "has ten; on this dashboard positive flow means importing to GB.",
    method: "utilisation",
  },
  lolp: {
    label: "Loss of Load Probability (LoLP)",
    gb: true,
    short: "NESO's estimate, per half-hour, of the probability that " +
      "available capacity fails to cover demand; almost always near " +
      "zero, and the stress tab's adequacy flag fires at 1%.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/loss-of-load-probability/",
    method: "stress",
  },
  mid: {
    label: "Market Index Data (MID)",
    gb: true,
    short: "The GB spot-price proxy: a volume-weighted index of " +
      "short-term wholesale trades reported by appointed providers. It " +
      "deliberately excludes the day-ahead auction.",
    extra: "\"Price\" on the GB tabs means MID. It measures the " +
      "within-day traded market; the cost of balancing is SSP.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/market-index-data/",
    method: "price",
  },
  nameplate: {
    label: "Nameplate capacity",
    short: "The operator-published design rating of a cable or plant, " +
      "kept as a cited reference number; real day-to-day limits sit " +
      "lower during de-ratings and ramp-ups.",
    method: "utilisation",
  },
  niv: {
    label: "Net Imbalance Volume (NIV)",
    gb: true,
    short: "The net of all NESO balancing actions in a half-hour: how " +
      "far the whole system was out of balance, and in which direction.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/net-imbalance-volume/",
  },
  observed_badge: {
    label: "Observed (badge)",
    short: "A value taken from an authoritative published measurement " +
      "or outturn series and shown as published: the strongest quality " +
      "class here.",
  },
  ceiling: {
    label: "Operational ceiling",
    gb: true,
    short: "This dashboard's working limit for a cable, per direction: " +
      "the highest flow sustained for at least 2 hours over the " +
      "trailing 90 days. It self-adjusts to de-ratings and ignores " +
      "single-sample data spikes.",
    method: "utilisation",
  },
  percentile: {
    label: "Percentile (p99, p95…)",
    short: "The value below which that share of a sample falls: p99 " +
      "means only 1% of days were higher.",
    extra: "Stress flags and tooltip context use the trailing-year " +
      "distribution, point-in-time: a day is judged only against days " +
      "before it, never against itself.",
    method: "stress",
  },
  pn: {
    label: "Physical Notification (PN)",
    gb: true,
    short: "A BM Unit's declared expected output for a half-hour: " +
      "intent, not metered delivery, and it carries no prices.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/physical-notification/",
    method: "bmu",
  },
  proxy_badge: {
    label: "Proxy / Derived (badge)",
    short: "A stand-in built from public data where the true series is " +
      "commercial or unpublished; it tracks the real thing without " +
      "equalling it.",
  },
  residual_load: {
    label: "Residual load",
    gb: true,
    short: "Demand minus wind: the load left for dispatchable plant and " +
      "interconnectors to serve once must-run renewables are netted off.",
    method: "residual",
  },
  settlement_period: {
    label: "Settlement period (SP)",
    gb: true,
    short: "The half-hour block GB electricity settlement runs on, " +
      "numbered from local midnight: SP1 to SP48, with 46 or 50 on " +
      "clock-change days.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/settlement-period/",
  },
  srmc: {
    label: "SRMC",
    short: "Short-run marginal cost: what one more MWh costs a plant " +
      "that already exists (fuel, carbon, variable running cost). This " +
      "is the cost model behind the merit-order curve.",
    method: "merit",
  },
  ssp: {
    label: "System Sell Price (SSP)",
    gb: true,
    short: "The half-hourly \"cash-out\" price settling the gap between " +
      "what parties contracted and what they delivered; it prices the " +
      "balancing actions NESO took.",
    extra: "Since November 2015 GB has a single imbalance price, so SSP " +
      "and its buy-side twin SBP are the same number. The System stress " +
      "tab uses SSP because it is the realised cost of real-time " +
      "scarcity; MID measures the traded market instead.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/system-sell-price/",
    method: "stress",
  },
  syswarn: {
    label: "SYSWARN",
    gb: true,
    short: "The BMRS feed of NESO system warnings: EMNs, emergency " +
      "instructions, IT outage notices and similar, verbatim.",
    extra: "Publish stamps are UTC. Times quoted inside notice bodies " +
      "are UK local, and this dashboard never converts them.",
    elexon: "https://www.elexon.co.uk/bsc/glossary/system-warning/",
    method: "stress",
  },
  frequency: {
    label: "System frequency",
    gb: true,
    short: "The grid's heartbeat, nominally 50 Hz; it falls when " +
      "generation lags demand. NESO operates within 49.8–50.2 Hz, and " +
      "49.5 Hz is the statutory floor.",
    method: "stress",
  },
  uka: {
    label: "UKA (UK Allowance)",
    gb: true,
    short: "The permit to emit one tonne of CO2 under the UK Emissions " +
      "Trading Scheme; its price is the carbon-cost input to the " +
      "spreads and the SRMC model.",
    method: "spark",
  },
  npv: {
    label: "Net present value (NPV)",
    short: "The sum of a project's future cash flows, each discounted " +
      "back to today at a chosen rate, minus the upfront cost. Positive " +
      "means the assumptions describe a project worth more than it costs.",
    extra: "The profitability calculator's NPV is entirely a function of " +
      "the inputs you enter: badged Assumption throughout, never a " +
      "valuation.",
    method: "bess-calc",
  },
  irr: {
    label: "Internal rate of return (IRR)",
    short: "The discount rate at which a project's NPV is exactly zero: " +
      "the break-even return the cash flow itself implies.",
    extra: "Found here by bisection over -99% to +150%. A cash flow that " +
      "never turns net-positive has no such rate, and the calculator " +
      "says \"no IRR\" rather than showing 0%.",
    method: "bess-calc",
  },
  discounted_payback: {
    label: "Discounted payback",
    short: "How many years of discounted net cash flow it takes to " +
      "recover the upfront capital cost, linearly interpolated on the " +
      "cumulative discounted column to a fraction of the year it falls in.",
    extra: "Discounted, unlike simple payback, which ignores the time " +
      "value of money — this figure moves with the mid-year/end-of-year " +
      "discounting convention, because the column it interpolates on " +
      "does. A cash flow whose discounted cumulative never crosses zero " +
      "within the calculation period shows \"no payback\", never a zero.",
    method: "bess-calc",
  },
  lcos: {
    label: "Levelised cost of storage (LCOS)",
    short: "A project's lifetime costs (capital, operating, network " +
      "charges and the energy bought to charge the battery), each " +
      "discounted, divided by its lifetime discounted energy " +
      "throughput: a £/MWh cost figure comparable across assumptions.",
    extra: "Labelled indicative here, and it carries two states rather " +
      "than one fixed shape. With no observed price feed in use, or with " +
      "a manual arbitrage spread overriding it, the charging-energy cost " +
      "is excluded, and the figure is a floor on LCOS: capital and " +
      "operating cost per discharged MWh, not the full lifetime cost. " +
      "Once the observed price feed is active, the charging-energy cost " +
      "is included, priced at the observed bottom-of-day mean price, and " +
      "the results panel says which of the two applies. Discounted " +
      "energy is the denominator either way, a stated choice rather than " +
      "the only valid one.",
    method: "bess-calc",
  },
  wacc: {
    label: "Weighted average cost of capital (WACC)",
    short: "The discount rate applied to a project's future cash flows: " +
      "roughly, the blended return its financing needs to clear.",
    extra: "A single user-entered rate here, real-terms and pre-tax. " +
      "The optional financing block models an explicit debt layer " +
      "beside it, but every project-level metric stays discounted at " +
      "this one rate; only the equity cash flow and its IRR see the " +
      "debt/equity split.",
    method: "bess-calc",
  },
  tolling: {
    label: "Tolling agreement",
    short: "A fixed fee, priced in £k/MW/yr on this card, that a trader " +
      "pays a battery owner for the rights to operate the asset over " +
      "an agreed tenor: contracted revenue for the owner, merchant " +
      "risk and upside for the trader.",
    extra: "The calculator's optional route-to-market group blends a " +
      "toll on the tolled share of capacity with the observed merchant " +
      "anchor scaled by the untolled remainder. The toll figure is " +
      "flat in real terms and never degraded, derated or cannibalised " +
      "— availability guarantees sit with the operator — and every " +
      "field in the group is an Assumption. £k/MW/yr is the unit toll " +
      "quotes are made in, and it is numerically identical to £/kW/yr: " +
      "£50k/MW/yr is £50/kW/yr.",
    method: "bess-calc",
  },
  gearing: {
    label: "Gearing",
    short: "The share of a project's capital cost funded by debt " +
      "rather than equity. Higher gearing levers equity returns in " +
      "both directions.",
    extra: "Here, a fraction of CAPEX drawn as debt at year 0 and " +
      "repaid as a level annuity at the cost-of-debt input, with no " +
      "balloon and no refinancing. Project NPV and IRR stay ungeared; " +
      "only the equity cash flow and its IRR feel the leverage.",
    method: "bess-calc",
  },
  dscr: {
    label: "Debt service cover ratio (DSCR)",
    short: "A year's cash flow available for debt service divided by " +
      "that year's debt service, interest plus principal. Below 1, the " +
      "project cannot pay its lenders out of that year's operations.",
    extra: "Reported as a minimum and an average, split between the " +
      "toll period and the merchant years after it. The numerator here " +
      "is the project's whole net cash flow, augmentation capex " +
      "included — lenders typically carve funded capex out, a " +
      "convention stated rather than adopted.",
    method: "bess-calc",
  },
  cfads: {
    label: "Cash flow available for debt service (CFADS)",
    short: "The cash a project generates in a year before any debt " +
      "drawdown or repayment: the numerator of DSCR.",
    extra: "Taken on this card as the project's net cash flow in each " +
      "operating year, augmentation capital included — the honest " +
      "in-model reading, since the engine has no tax or working-" +
      "capital lines to adjust for. Lenders typically carve funded " +
      "capex out of CFADS; that convention is stated, not adopted.",
    method: "bess-calc",
  },
  equityIrr: {
    label: "Equity IRR",
    short: "The internal rate of return on the equity cash flow alone: " +
      "project cash flow less debt service, measured against the " +
      "equity share of the upfront cost (CAPEX less the debt drawdown).",
    extra: "Found by the same bisection over -99% to +150% as project " +
      "IRR. The Excel export's native IRR() is not confined to that " +
      "bracket, so a heavily geared case the card names as above the " +
      "solver bracket can still show a figure in the workbook. With " +
      "gearing at zero, equity IRR equals project IRR.",
    method: "bess-calc",
  },
  tnuos: {
    label: "TNUoS (Transmission Network Use of System)",
    gb: true,
    short: "The charge a generator pays NESO for using the transmission " +
      "network, set per zone and varying from a genuine subsidy in the " +
      "far north to a real cost near London.",
    extra: "The calculator vendors the published zone tariff elements " +
      "(a fixed table, cited as reference, not a badge) and shows a " +
      "zone-level indication, not the full CUSC tariff calculation. " +
      "Distribution-connected assets sit outside generation TNUoS " +
      "post-TCR and show \"not applicable\" rather than a zero charge.",
    method: "bess-calc",
  },
  capfloor: {
    label: "Cap and floor",
    gb: true,
    short: "Ofgem's revenue-corridor regime for long-duration storage " +
      "(and, earlier, interconnectors): a guaranteed revenue floor set " +
      "near a debt-like return, in exchange for a cap set near a " +
      "regulated equity return, both applied to 100% of the project's " +
      "regulatory asset value.",
    extra: "Window 1's indicative rates are 4.47% (floor) and 7.48% " +
      "(cap), CPIH-real, refixed at each project's FID. The default " +
      "regime runs 25 years, levels are CPIH-indexed, floor top-ups " +
      "are funded through BSUoS and conditional on a Minimum " +
      "Availability Target, and the cap is soft: the project keeps " +
      "30% of revenue above it.",
    method: "ldes-capfloor",
  },
  rav: {
    label: "Regulatory asset value (RAV)",
    gb: true,
    short: "The capital base a regulated return is earned on: for the " +
      "LDES regime, development, construction, replacement and " +
      "decommissioning expenditure plus interest during construction " +
      "and transaction costs.",
    extra: "Both the floor and the cap return apply to 100% of RAV. " +
      "Cost overruns can enter the RAV only up to the project's " +
      "submitted P90 cost ceiling.",
    method: "ldes-capfloor",
  },
  softcap: {
    label: "Soft cap",
    gb: true,
    short: "A revenue cap that shares rather than confiscates: above " +
      "the cap level, the LDES project keeps 30% of additional " +
      "revenue and returns 70% to consumers.",
    extra: "The retention exists to preserve the incentive to keep " +
      "dispatching efficiently once the cap is reached — a hard cap " +
      "would make every extra MWh worthless to the operator.",
    method: "ldes-capfloor",
  },
  mat: {
    label: "Minimum Availability Target (MAT)",
    gb: true,
    short: "The availability condition on the revenue floor: floor " +
      "payments are only due while the asset meets its minimum " +
      "availability, with clawback if the target is missed.",
    extra: "It keeps the floor from paying an asset that is not " +
      "actually available to the system — the regulated analogue of " +
      "the availability guarantee a toll places on the operator.",
    method: "ldes-capfloor",
  },
  fascore: {
    label: "Financial Assessment score",
    gb: true,
    short: "Ofgem's screening ratio for Window 1 projects: assessed " +
      "lifetime revenue divided by the project's floor. Below the " +
      "disclosed 0.60 threshold a project is demoted in the " +
      "assessment.",
    extra: "The per-project floor levels behind the score are withheld " +
      "as commercially sensitive; only the threshold and each " +
      "project's band were published. Frontier Legacy was included on " +
      "technology-diversity grounds despite a below-threshold score.",
    method: "ldes-capfloor",
  },
  bcr: {
    label: "Benefit-cost ratio (BCR)",
    short: "The present value of a project's modelled system benefits " +
      "divided by the present value of its costs, taken at the " +
      "central (P50) case.",
    extra: "The largest single weight (40%) in the economic assessment " +
      "behind the Window 1 ranking, computed from NESO's welfare " +
      "cost-benefit analysis against a marginal-addition " +
      "counterfactual.",
    method: "ldes-capfloor",
  },
  bsuos: {
    label: "BSUoS",
    gb: true,
    short: "Balancing Services Use of System: the charge through which " +
      "NESO recovers the cost of balancing the GB system, levied on " +
      "final demand.",
    extra: "The LDES cap-and-floor regime is funded through BSUoS, " +
      "with NESO acting as the intermediary between projects and the " +
      "charge: floor top-ups are paid from it, and revenue returned " +
      "above the cap flows back through it.",
    method: "ldes-capfloor",
  },
};

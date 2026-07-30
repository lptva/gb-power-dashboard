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
};

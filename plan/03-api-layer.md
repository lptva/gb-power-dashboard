# Milestone 3 — API layer evaluation

## Question

Is a thin FastAPI read layer (backed by parquet or DuckDB) justified at this
stage, in place of — or alongside — the static JSON files?

## Verdict: defer. No API layer is built in this pass.

### Rationale

1. **One consumer.** The only client is this dashboard. An API layer earns its
   keep when several consumers need different slices of the canonical series;
   none exist yet.
2. **The payload is small.** `series_hh.json` is ~2.3 MB for a full year at
   half-hourly resolution. It loads in well under a second locally and would
   be a single CDN object in production. Window-querying on the server saves
   nothing at this size.
3. **Operational cost is real.** FastAPI + DuckDB means a Python server
   process to run, monitor, restart and secure — versus zero moving parts for
   static files. The project's deployment story today is "any static host".
4. **The constraint set forbids replacing static JSON anyway.** Static output
   must remain the fallback, so an API layer now would be a second parallel
   interface to maintain with no user to justify it.

### What would change the verdict (revisit triggers)

Revisit this decision when **any** of the following becomes true:

- A second consumer appears (another app, a notebook workflow that outgrows
  reading the JSON directly, a colleague's tool).
- Multi-zone data (Milestone 4 realised) pushes the *initial* payload past
  ~10 MB — at that point server-side windowing starts paying for itself.
- Users need windows beyond the shipped rolling year (historical backfill),
  which static files cannot serve without unbounded growth.
- Commercial/licensed series are added (day-ahead auction prices, daily UKA,
  API2 coal) — licence enforcement needs AuthN/AuthZ, which needs a server.

### If/when built, the shape is

- ETL additionally writes a parquet file per zone (same columnar schema).
- FastAPI app with two endpoints: `/series/{zone}/hh?from=&to=&cols=` and
  `/meta/{zone}`, reading via DuckDB over parquet.
- Static JSON continues to be written and served; the front end prefers the
  API when configured, falls back to static otherwise.

## Status

Evaluated — deferred with documented triggers. No code written (deliberate).

# Milestone 7 — Hosted deployment via GitHub Pages (issue #28)

Design-first, per house convention (plan/05, plan/06 precedent). Covers the
near-term path from the issue #28 options memo: publish `app/` to a
link-accessible GitHub Pages site on a schedule, so viewing the dashboard
needs no clone, no Python, no token, and no ETL run.

## Status

**Awaiting final sign-off. Nothing implemented.** No git actions taken; the
owner commits everything.

Decision state (owner, 2026-07-15):
- **D1 — resolved.** `actions/cache` rejected; rolling **GitHub Release
  snapshot** adopted, plus state-loss detection. See §0.
- **D2, D4, D5, D6 — approved as written.** Not revisited.
- **D3 — resolved: YES**, with a default-off client-side render toggle. See §5.
- **AI auth — resolved:** `CLAUDE_CODE_OAUTH_TOKEN` (subscription-based), not
  `ANTHROPIC_API_KEY`. See §3.
- **D7 — resolved:** disclosure line added, in the toggle tooltip. See §5.
- **D8 — resolved:** snapshot restore validates (checksum + `tar tzf`) before
  extracting; any failure takes the cold-start path. See §0.
- **D9 — resolved:** the **restore step** owns the cold start; `refresh.py` is
  skipped on cold runs and left unmodified. See §0.
- **D10 — resolved:** the Cloudflare snippet ships in **Milestone C**, not A.
  See §6.
- **D11 — resolved:** `ENABLE_AI_SUMMARY=false` locally once the cron is live;
  CI becomes the sole generator. See Open questions.
- **D12 — resolved:** default `github.io` URL; no custom domain.

**All decisions are closed.** What remains is verification during Milestone A
(listed in Open questions), not owner input.

Scope boundary: this milestone publishes the **existing static app**. It does
not build an API, a backend, accounts, or per-user state. That remains
deferred under `plan/03-api-layer.md`, whose four revisit triggers are all
still unfired (payload ~5.3 MB against its ~10 MB trigger; commercial-data
AuthN tracked separately as issue #10). Static hosting trips none of them —
`plan/03-api-layer.md` already names "any static host" as the assumed
deployment story, and `ops/README.md` already nominates "GitHub Actions cron
publishing `app/` to static hosting" as the fix for its own sleep caveat.

---

## 0. The state problem — read this first

**This is the biggest risk in the milestone and it is not obvious.** CI is
stateless: every run starts from a fresh checkout, and `app/data/` is
gitignored (`.gitignore:27`), so the runner begins with **no data at all**.
The pipeline, however, is incremental and append-only by design. Verified
behaviour on a cold start:

| Step | Cold-start behaviour | Consequence |
|---|---|---|
| `build_dataset.py --incremental` | Falls back to a full rebuild when no readable dataset exists (`ops/refresh.py:9-10`) | **Self-healing.** ~177 calls, 3–5 min. Correct, just not cheap. |
| `fetch_stress.py` (no `--backfill`) | No stored days → `start = yesterday` (`etl/fetch_stress.py:513-515`) | **Broken.** System stress tab gets **one day** of history. Percentile flags need ≥90 d and the trailing baselines need a year. |
| `fetch_entsoe.py --zone X --days 7` | Fetches 7 days only | **Broken.** The append-only zone history (accumulated from 31 May 2026) is lost every run. |

So a naive "run `ops/refresh.py` in CI" publishes a **crippled** dashboard:
one day of stress data, a week of zone data. State must persist between runs.

The zone history is genuinely rebuildable from ENTSO-E (the API serves
history), so no option below has a permanent-data-loss failure mode. The risk
is not lost data — it is **a temporarily degraded public site**, which is
precisely the launch-week failure mode to design out.

### D1 — RESOLVED (owner, 2026-07-15): rolling GitHub Release snapshot

`actions/cache` is **rejected**: it is explicitly best-effort (7-day unused
eviction, earlier under storage pressure), so it would leave site quality
hostage to opportunistic eviction.

| Mechanism | Durability | Permissions | Complexity | Consistent with "no data in git"? | Verdict |
|---|---|---|---|---|---|
| `actions/cache` | ✗ **Best-effort.** 7-day unused eviction, earlier under pressure | none extra | low | ✓ | **Rejected** — opportunistic |
| **Release asset, rolling** | ✓ **No eviction policy.** `--clobber` overwrites in place, so nothing accumulates | `contents: write` | low–moderate | ✓ **Assets are blob storage, not git objects** — `main`'s history is untouched, no churn | **Recommended** |
| Orphan branch, force-pushed | ✓ Durable | `contents: write` | moderate | ✗ **It is data in git.** Force-pushing orphans the prior commit, but the unreachable 2.3 MB blob lingers server-side until GitHub GCs (timing not guaranteed). Clones stay small, but it contradicts `eeafab4`'s rationale and D2's own logic | Rejected |
| Rehydrate from the published Pages site | ✓ As durable as the site itself | **none extra** — `contents: read` only | moderate | ✓✓ Nothing in git anywhere; no second store | **Runner-up** — see below |

**Why not the runner-up, despite its permission advantage.** Restoring state
by fetching the previous deploy from the live site is genuinely attractive: it
needs **no extra permissions at all** and invents no new store. It fails on a
concrete detail: `manifest.json`'s `files[]` has **23 entries — the 6 core
files plus 17 event slices — and does not list `zones/` at all** (21 files,
2.0 MB). Zone paths would have to be *derived* from the separate `zones`
array, an implicit contract that could silently drop a zone if the layout ever
changes. Since the entire purpose of D1 is to avoid a *silently* degraded
site, an opaque all-or-nothing tarball is the safer instrument. Recorded here
so it is not re-litigated.

**Mechanics.** One **draft** release (tag `data-snapshot`) holding the state
tarball plus its checksum.

**Draft, not pre-release — resolved (owner, 2026-07-15).** A draft is hidden
from the repo's public Releases page, which matters on a repo that doubles as
a portfolio piece; the repo currently has no releases and no tags, so a
pre-release would otherwise make an internal ETL blob the first thing under
"Releases". Reachable by the workflow token either way.

- **Publish:** `tar czf app-data.tar.gz app/data` → `sha256sum` → upload **the
  tarball first, then the checksum**, both `--clobber`.
- **Restore:** download both → **validate** → only then extract.

**Validation before extraction — three gates, in order (owner review, closes
the §0 gap):**

1. **Both assets present.** A missing checksum is treated as *corrupt*, not as
   "skip the check". Fail closed.
2. **`sha256sum -c` passes.** Catches truncation and silent corruption, and
   also catches a complete-but-wrong file that a structural check alone would
   wave through.
3. **`tar tzf` passes.** Structural/gzip-CRC check on the archive before
   anything touches `app/data/`.

**Any gate failing takes exactly the cold-start path** — identical to a missing
asset: full rebuild, the same `::warning::` annotation, the same step-summary
line. **Not a crashed job, and never a silent restore of bad data.** Every `gh`
call and every check must be written to be *caught* and branched on, not to
abort the job — no bare `set -e` killing the run on a failed download.

**Correction to an earlier claim in this doc.** A previous revision asserted the
snapshot was "all-or-nothing by construction: one asset, so a partial restore is
not representable". **That was wrong**, and the owner's review caught it: an
upload interrupted mid-transfer leaves a *present but truncated* asset, and
because `--clobber` overwrites in place, the last-known-good copy is already
gone by the time that is discovered. One asset makes a partial restore *less
likely*, not impossible. Hence the explicit validation above — this is the one
failure mode that would defeat the point of the whole D1 redesign if it slipped
through.

**Residual risk — CORRECTED on review.** An earlier revision of this doc called
the `--backfill 365` measurement "load-bearing for D1's safety". **That was
overstated.** ≈836 calls at `time.sleep(0.15)` pacing is ~2 minutes of
sleeping; even at a pessimistic ~1.5 s/call the cold path lands around
~20 minutes, against Actions' **360-minute default timeout**. Timeout is a
*remote* risk, not a gating one.

The measurement is still worth taking, but for the honest reasons: **rate-limit
headroom** against the free TSO APIs, and the no-partial-persistence property
above (a cold start that dies has to start over). It does **not** gate
Milestone A.

Escape hatch, *noted and deliberately not specced now*, if a cold start ever
proves too costly to serve as the recovery path: retain the prior tarball as a
second asset (`app-data.prev.tar.gz`), so a corrupt current snapshot falls back
to yesterday's state rather than a full rebuild.

**Verification needed before this is relied on (draft releases).** `gh release
download <tag>` resolves a release *by tag* — but **a draft release has no git
tag until it is published**, so by-tag lookup may not resolve it. `gh` may fall
back to listing releases (which includes drafts for a token with push access);
**I have not verified this, and it is load-bearing for the whole mechanism.**
Milestone A must prove draft download works before anything depends on it. If
it does not, in order of preference: address the release by **ID** via `gh api`
(`/repos/{owner}/{repo}/releases/{id}/assets`), or fall back to a
**pre-release** — at which point the cosmetic cost you just rejected returns to
the table as the lesser evil.

> **Implemented note (2026-07-16):** the landed code uses by-**ID** `gh api`
> addressing as the *primary* path for both download and upload, deleting the
> by-tag unknown instead of gambling on it — see `ops/ci/restore_snapshot.sh`
> and `.github/workflows/deploy.yml`.

### D9 — RESOLVED (owner, 2026-07-15): the restore step owns the cold start

**A real gap, found in review.** `ops/refresh.py` **takes no CLI arguments at
all** — verified: no `argparse`, no `sys.argv`. It invokes `fetch_stress.py`
with **no `--backfill`** (`:204-205`) and pins zones to a hardcoded
`--days 7` (`:209-211`). The orchestrator is therefore *structurally incapable*
of performing a cold start, and the earlier sketch — "restore, else cold start,
then run `refresh.py`" — would have re-run the entire pipeline a second time.

Resolved shape:

- **Warm run** (snapshot restored and all three gates passed):
  `python3 ops/refresh.py`, exactly as it runs today.
- **Cold run** (no snapshot, or any gate failed): the step invokes the builders
  **directly and does not call `refresh.py` at all** —
  `build_dataset.py --days 365`, `fetch_stress.py --backfill 365`,
  `fetch_entsoe.py --zone <Z> --days <wide>` per zone, then the AI summary.
- **`refresh.py` is not modified.** This is why §5's "the toggle is the
  milestone's only application change" remains true — the alternative
  (teaching `refresh.py` `--cold-start`/`--zone-days` flags) would have made
  that claim false and needed its own tests.

**Known fragility of the cold path (found in review, not mitigated).**
`fetch_stress.py` writes `stress_daily.json` **once, at `:646`** — after the
per-day fetch loop (`:571-585`, two calls per day: `fetch_freq_day` at `:574`,
`fetch_prices_day` at `:581`) and the flag pass (`:596`) have both completed.
So a backfill that dies partway persists **zero** progress.
Its `USE_CACHE = True` "resumable via disk cache" (`:506`) points at
`data_raw/cache/`, which is gitignored, ~914 MB locally, and **not in the
snapshot** (the tarball covers `app/data` only). So resumability does **not**
survive across CI runs: a cold start is all-or-nothing per run and must be
re-run from scratch if it fails. Not a blocker, but do not expect the cache
comment to save you in CI.

**On scoping `contents: write` (owner's question).** GITHUB_TOKEN permissions
are **job-level, not step-level**, so the job that touches the snapshot must
carry `contents: write` wholesale. Recommended split: the **build** job takes
`contents: write` (it restores and overwrites the snapshot); the **deploy**
job takes only `pages: write` + `id-token: write` and **no `contents` at
all** — so the Pages credentials and the repo-write credentials never coexist
in one job. A **separate PAT is not recommended**: a long-lived personal token
must be rotated, cannot be scoped per-job, and is strictly worse than the
ephemeral per-job `GITHUB_TOKEN`. Isolating the upload into a third job would
require a 5.3 MB artifact round-trip for marginal benefit — considered, not
recommended.

### State-loss detection (closing the review gap)

Nothing today distinguishes "first run, cold start by design" from "state
vanished, silently rebuilt". Add:

- `workflow_dispatch` gains a **`cold_start` boolean input** (default `false`)
  to mark an intentional rebuild.
- The restore step records which path it took, always, to
  `$GITHUB_STEP_SUMMARY`:
  - restored → `state restored from snapshot (manifest v<N>, built <ts>)`
  - cold start → the same line **plus a `::warning::` annotation**, which
    surfaces on the run in the Actions list rather than only in the log body.
- The warning fires whenever a cold start happens **without** being asked for:
  any `schedule` trigger, or a `workflow_dispatch` without `cold_start: true`.
- It **warns, it does not fail.** Publishing correct-but-rebuilt data beats
  not publishing. The goal is that a silent state loss is visible in the
  Actions history instead of quietly degrading the live site until someone
  notices.

---

## 1. `README.md` — the false claim (point 1)

`README.md:74` currently reads:

> The dashboard ships with seven European markets behind the header zone
> switcher, **viewing them needs nothing**; the zone data is part of the
> published dataset.

**False since `eeafab4` (10 Jul 2026)**, when `app/data/` was gitignored and
the 26 tracked data files were removed. `git ls-files app/data` → 0 files, so
a clone has no zone data and the switcher collapses to GB-only
(`build_dataset.py:250` seeds `zones = ["GB"]`; `app.js:105` disables the
select below 2 zones). `docs/SETUP.md:272-274` carries the same claim and
must be fixed with it.

Once hosting exists the section should lead with the link and demote the
clone workflow. Draft for wording review (**D6**):

```markdown
## European zones (ENTSO-E)

The dashboard covers seven European markets behind the header zone switcher.
On the [hosted dashboard](<LIVE-URL>) they are already there — nothing to
install, nothing to configure.

Running your own copy is different: the zone data is generated by the ETL and
is not shipped in the repo, so you need a free ENTSO-E Transparency Platform
token to fetch it.

1. Register at <https://transparency.entsoe.eu>, then email
   `transparency@entsoe.eu` with the subject "RESTful API access" (they reply
   in a few working days).
2. `cp .env.example .env` and put the token in it. The `.env` lives at the
   **project root — never under `app/`**, which is web-served: a token placed
   there would be downloadable by anyone who can reach the dashboard.
3. Fetch a zone with `python3 etl/fetch_entsoe.py --zone FR --days 30`, or let
   the scheduled refresh keep all seven topped up (zone history accumulates
   append-only from 31 May 2026).

Without a token the app still runs — the switcher simply stays GB-only.
```

**Sequencing note:** this rewrite must land in Milestone C, *after* the URL
is live, since it hard-references the link.

---

## 2. Deploy workflow (point 2)

### Recommended: `actions/upload-pages-artifact` + `actions/deploy-pages`

**The decisive argument is `app/data/` being gitignored.** The artifact
actions upload straight from the runner's filesystem, so **gitignore is
irrelevant** — the generated data publishes without ever being committed.

| Method | Verdict | Reasoning |
|---|---|---|
| **`deploy-pages` action** | **Recommended** | No commits, ever. Gitignored `app/data/` publishes fine. No branch churn. Native, first-party. **CI never writes to the repo — which also honours the "I commit everything myself" rule.** |
| `gh-pages` branch | Reject | Requires committing generated data → needs `git add -f` to defeat `.gitignore`, and reintroduces exactly the daily 2.3 MB `series_hh.json` churn that `eeafab4` removed on 10 Jul. |
| `/docs` folder on `main` | Reject | Same churn, but on `main`'s history. Strictly worse. |

### Sketch (structure only, not final code)

```yaml
name: deploy

on:
  schedule:
    - cron: "30 6 * * *"        # 06:30 UTC = 07:30 BST — D5 (approved)
  workflow_dispatch:             # REQUIRED for the Milestone A manual proof
    inputs:
      cold_start:                # marks an INTENTIONAL rebuild, suppressing
        type: boolean            # the state-loss warning (§0)
        default: false

concurrency:
  group: pages
  cancel-in-progress: false      # never interrupt a half-published deploy

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write            # snapshot restore + --clobber upload only
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      # The ETL needs certifi (the test suite does not — tests.yml stays
      # stdlib-only; these two workflows deliberately differ here).
      - run: pip install certifi
      - run: <install claude CLI>          # D3 = yes (§5)
      # Restore + validate (3 gates, §0). Sets WARM=true|false. Writes the
      # path taken to $GITHUB_STEP_SUMMARY; ::warning:: on an UNREQUESTED
      # cold start. Must catch failures and branch, never abort the job.
      - id: restore
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # gh CLI auth, this step only
        run: <download tarball+checksum → sha256sum -c → tar tzf → extract>

      # WARM: the orchestrator, untouched. D9.
      - if: steps.restore.outputs.warm == 'true'
        run: python3 ops/refresh.py
        env: *pipeline_env                        # see below

      # COLD: the builders directly — refresh.py CANNOT do this (no CLI
      # args), and calling it after would re-run everything twice. D9.
      - if: steps.restore.outputs.warm != 'true'
        run: |
          python3 etl/build_dataset.py --days 365
          python3 etl/fetch_stress.py --backfill 365
          for Z in FR NL BE NO_2 DK_1 IE DE_LU; do
            python3 etl/fetch_entsoe.py --zone "$Z" --days <wide>
          done
          python3 ops/run_overnight_summary.py
        env: *pipeline_env

      # pipeline_env (both branches). NOTE: no GITHUB_TOKEN here — nothing
      # in ops/ or etl/ reads it or calls gh (verified), and this is the
      # step that spawns the LLM with Bash. Keep repo-write creds out of it.
      #   ENTSOE_TOKEN:            ${{ secrets.ENTSOE_TOKEN }}
      #   ENABLE_AI_SUMMARY:       "true"                        # D3 = yes
      #   CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}

      # CI would otherwise run blind: refresh.py sends every step's output
      # to ops/logs/refresh_<date>.log, which is gitignored and outside
      # app/, so it is neither published nor snapshotted.
      - if: always()
        run: cat ops/logs/refresh_*.log || true

      - run: <stamp build version into app/index.html>          # §4
      - run: <tar app/data + sha256 → gh release upload data-snapshot
              --clobber (tarball first, then checksum)>          # §0
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - uses: actions/upload-pages-artifact@v3
        with:
          path: app
  deploy:
    needs: build
    environment: github-pages
    runs-on: ubuntu-latest
    permissions:                 # deliberately NO contents: — the Pages and
      pages: write               # repo-write credentials never coexist in one
      id-token: write            # job (§0, permission scoping)
    steps:
      - uses: actions/deploy-pages@v4
```

> **Implemented note (2026-07-16):** the landed workflow differs from this
> sketch in two ways. `<wide>` became `ZONE_DAYS=60` — a single unchunked
> 365-day A75 request times out (probed live), and 60 covers the accumulated
> history only until **30 Jul 2026**. And the cold path carries explicit
> per-step `|| ::warning::` guards — `run_overnight_summary.py` exits non-zero
> even on a benign skip, and unlike the warm path nothing here inherits
> `run_non_fatal` from `refresh.py`. See `.github/workflows/deploy.yml`.

**Ordering — RESOLVED (owner, 2026-07-15): snapshot upload stays *before* the
Pages publish.** If a deploy fails after the snapshot upload, state races
slightly ahead of what is actually live — but the next successful deploy
catches the site back up on its own. **No data is lost and nothing is silent.**
Deferring the upload until after a confirmed-successful deploy would need a
third job, or a conditional tied to the deploy job's result, for a benefit that
is mostly cosmetic. Not worth the extra moving part. Sub-question closed.

**Once-per-day gate interaction.** `ops/refresh.py`'s `summary_ran_today`
check reads the restored `overnight_summary.json`. On a daily cron the
restored file carries *yesterday's* `generated_at`, so the summary correctly
runs. On a same-day manual re-run it correctly **skips**, saving a paid call.
Both behaviours are what we want; no change needed.

Conventions reused from `.github/workflows/tests.yml`: `actions/checkout@v4`,
`actions/setup-python@v5` pinned to `"3.12"`.

**A separate workflow, not an extension of `tests.yml`.** They differ on every
axis: trigger (schedule vs push/PR), network egress (the ETL hits Elexon /
PV_Live / National Gas / ENTSO-E; the suite hits nothing), dependencies
(certifi vs stdlib-only), permissions (Pages write vs read), and runtime
(minutes vs 0.06 s). The ETL must never run on PRs.

**The AI summary step runs in this job — confirmed yes, D3 (§5).** It must stay
**non-fatal**, so a summary failure can never block the data deploy (the #35
transient-API class of failure would otherwise take the public site's data down
with it). That property already holds by construction — `ops/refresh.py` runs
the step via `run_non_fatal`, and `main()` exits non-zero only on the core
step — so this is a "do not regress it" note, not new work.

> **Implemented note (2026-07-16):** true for the *warm* path only. On the
> *cold* path (which never calls `refresh.py`) this had to become new work:
> deploy.yml guards each non-core step explicitly, because
> `run_overnight_summary.py` exits non-zero even on a benign skip and Actions
> runs bash with `-e`.

**Free-tier caveats to record:** scheduled workflows can be delayed under
load, and are auto-disabled after 60 days of repo inactivity. Public repos get
free Pages and free Actions minutes → **£0**.

---

## 3. Secrets (point 3)

**`ENTSOE_TOKEN` — confirmed sufficient, no code change.**
`etl/fetch_entsoe.py:100` does `os.environ.get("ENTSOE_TOKEN", "").strip()`
and returns early when set; `_load_dotenv()` (`:96-113`) is only the fallback
for local runs. So `env: ENTSOE_TOKEN: ${{ secrets.ENTSOE_TOKEN }}` on the
pipeline step is all that is needed, with a repo secret of the same name.

Two caveats worth stating:

- **The core GB pipeline needs no secrets at all.** Elexon, PV_Live, National
  Gas, gov.uk ETS, World Bank and BoE are all keyless. So a token-less deploy
  still publishes a working GB dashboard.
- **Without the secret, zones fail silently.** `fetch_entsoe.py:473-476` exits
  **0** and prints registration instructions — by design, non-fatal. On a
  hosted site that would mean the switcher quietly collapses to GB-only and
  README:74's claim breaks all over again, this time on the public link. The
  secret is therefore **required** for the zone switcher to exist hosted, and
  Milestone A must verify all 8 zones appear.

### AI summary auth — RESOLVED (owner, 2026-07-15)

**`CLAUDE_CODE_OAUTH_TOKEN`, not `ANTHROPIC_API_KEY`.** The summary runs on
the owner's existing **Claude subscription** rather than API billing, and
`CLAUDE_CODE_OAUTH_TOKEN` is the documented mechanism for carrying that same
subscription auth into a CI pipeline. Generated by the owner with `claude
setup-token` (requires Pro / Max / Team / Enterprise; issues a **one-year**
token) and added as a repo secret of that name. **The owner generates and
installs this token; it is never generated or handled here.**

**Consequence, stated precisely (this doc previously contradicted itself here
— corrected).** The summary consumes the owner's **Claude usage allowance**,
not a separate bill: there is no per-token invoice on a subscription. The
figures quoted elsewhere in this doc and in `README.md:47` — **$0.36/run,
~£8–9/month, ~$11-equivalent/month** — are **API-*equivalent* notionals**,
logged from the CLI result envelope (`run_overnight_summary.py`) for
transparency. They are what the same work *would* cost at API pricing; they are
**not money leaving your account**. Spend does not scale with visitors either
way. Anything in this doc implying a per-run charge is stale from the
pre-resolution `ANTHROPIC_API_KEY` design.

So with D3 = yes, the pipeline step needs, in addition to `ENTSOE_TOKEN`:
- the `claude` CLI installed in the runner,
- `ENABLE_AI_SUMMARY: "true"`,
- `CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`.

`ops/env_flags.py` still checks the flag *before* the CLI is looked for, so
this remains a clean opt-out if the decision is ever reversed.

**Maintenance item — the token expires after one year.** When it lapses the
summary step will fail **non-fatally**: the site keeps publishing data while
the AI panel silently stops updating. The §0 state-loss warning would *not*
catch this — it is a different failure. Worth a calendar reminder; recorded in
Open questions.

---

## 4. Cache-busting on a hosted origin (point 4)

**The bug.** `app/index.html:21-22`:

```js
var DEV_CACHE_V = (location.hostname === "localhost"
  || location.hostname === "127.0.0.1") ? "?v=" + Date.now() : "";
```

On any hosted origin `DEV_CACHE_V` is `""`, so the app's own JS/CSS carry no
version at all. Data **is** versioned (`data.js:110`, `?v=<manifest.version>`),
so a deploy can serve **cached old JS against fresh data** until browser
caches expire. That is a genuine correctness bug for hosting, not cosmetic.

**Proposed fix** — a build stamp baked in at deploy time, keeping the dev arm
intact:

```js
var BUILD_STAMP = "__BUILD_STAMP__";              /* replaced at deploy */
var HOSTED_V = /^__/.test(BUILD_STAMP) ? "" : "?v=" + BUILD_STAMP;
var DEV_CACHE_V = (location.hostname === "localhost"
  || location.hostname === "127.0.0.1") ? "?v=" + Date.now() : HOSTED_V;
```

CI step (operates on the **ephemeral checkout only** — never committed, so the
repo and your working tree keep the literal placeholder):

```bash
sed -i "s/__BUILD_STAMP__/${GITHUB_SHA::7}/" app/index.html
```

Properties this preserves:

- **Unreplaced placeholder → today's exact behaviour.** Anyone self-hosting a
  clone without CI gets `HOSTED_V = ""`, byte-identical to now. No regression.
- **Dev arm untouched** — `Date.now()` still busts on localhost.
- **`vendor/echarts.min.js` stays static** (`index.html:580`), as designed: it
  never changes and staying cached is wanted.
- **Both sites already exist** — the head block (`:9-26`) and the body loader
  (`:581-592`); only the `DEV_CACHE_V` definition changes.

Two things to record:

- **`index.html` itself is still cached by Pages** (~10 min HTML TTL), so a
  deploy can take up to ~10 min to be picked up. Once it loads, every asset
  URL it emits is correct. Acceptable; document rather than fight.
- **The block is no longer dev-only**, so the name and its comment should be
  updated (`DEV-CACHE-BUSTER` → `CACHE-BUSTER`, dev arm + hosted arm). This
  supersedes `CHANGELOG.md:794`'s standing instruction "Review/strip before
  any hosted build — grep DEV-CACHE-BUSTER": the block is now **load-bearing
  in production** and must not be stripped. That CHANGELOG line needs an
  explicit correction when this lands.

---

## 5. RESOLVED (D3) — AI summary published, behind a default-off render toggle

**Resolved by the owner, 2026-07-15: YES, with a condition.** The summary
generates and publishes on every scheduled run, exactly as it does locally.
A new client-side toggle controls only whether it is **rendered**.

Consequences of publishing, recorded: the commentary is visible to anyone who
enables the toggle (or fetches the file); usage stays one run/day and does
**not** scale with visitors (~$0.36/run *API-equivalent notional*, not a bill —
see §3); the deploy gains a failure surface (the
#35 transient-API class), which is why the step must stay **non-fatal** so it
can never block the data deploy. The `.gitignore` rationale for
`overnight_summary.json` — "fresh installs would show another machine's stale
analysis" (`.gitignore:22-26`) — dissolves here: there is exactly one hosted
install, so there is no "other machine".

### Toggle spec

- **Label:** "AI interpretation". A simple on/off control, on or beside the
  existing overnight-summary panel.
- **Zone scope: GB only, inherited free.** The panel already only populates
  for `zone === "GB"` (`data.js`), so the toggle needs no gating of its own
  and need not exist off-GB.
- **Default: off, on every load, for every visitor.** In-memory only, held in
  `state.js` beside the assumption defaults — **no `localStorage`, no
  persistence, no exceptions**. A visitor who enables it and reloads a minute
  later gets it back **off**. Identical convention to the assumption sliders
  (`state.js:1-3`, `:37-40`), which the project already documents as
  session-only in four places.
- **When off: a minimal "enable AI interpretation" affordance, not removal.**
  *Recommended over hiding entirely* (owner left this to me) for two reasons:
  a panel that simply vanishes is undiscoverable, and an honest visible
  control matches "off by default" far better than an absence, which reads as
  "concealed".
- **Interaction with the existing collapse.** The card **already** defaults to
  collapsed (`ui.js:397`, `overnightOpen = false`). The toggle is therefore a
  second, outer layer: **off** → affordance only; **on** → today's behaviour
  unchanged (collapsed head, expandable body). Worth knowing so the two
  mechanisms are not confused during review.
- **It is a display switch, not a data switch.** The panel is not stripped
  from the build.

### Honesty constraint — the data is off by default, not concealed

`app/data/overnight_summary.json` **remains published and directly fetchable
by anyone**, toggle or not. Nothing in the implementation or its copy may
imply otherwise. Two specifics make this sharper than it first appears:

- `data.js` fetches `overnight_summary.json` **unconditionally on every GB
  load** (`:136-139`). So with the toggle **off**, the AI text is *already in
  the visitor's browser* and plainly visible in the network tab. The toggle
  suppresses rendering and nothing else.
- I am **not** proposing to skip the fetch when off. That would trade an
  honest, simple render switch for async fetch-on-toggle complexity, and it
  still would not make the file private — it is a static URL on a public site.

**D7 — RESOLVED (owner, 2026-07-15): add the disclosure.** Wording, verbatim:

> Off by default. The summary is still published at
> `data/overnight_summary.json` and can be fetched directly.

**Placement — my call, as delegated: the toggle's own tooltip** (`title` on the
control), not the methodology tab. Reasoning: the misleading inference ("off"
= "not sent to my browser") forms *at the toggle, at the moment of the
decision*. The methodology tab is the project's established home for durable
disclosures, but it is remote from that decision — someone flipping the switch
may never open it. Put the correction where the misreading happens.

**One limitation, stated rather than hidden:** a `title` tooltip is hover-only
— invisible on touch, and easy to miss. That is a weak vehicle for an honesty
statement. If it reads awkwardly in implementation, or the touch gap bothers
you, the natural fallback is the **affordance's own visible copy** (the
"enable AI interpretation" affordance already exists per the toggle spec
above, so the line simply sits beside it, always visible and touch-safe). That
is a one-line change, not a redesign. Raise it and I will switch.

### Scope note

This is the milestone's **only application change** — everything else is
deployment. It touches `state.js` (flag + setter), `ui.js` (`renderOvernight`),
`index.html` (control markup) and `style.css`. Small, but it is app code, not
CI, and should be reviewed as such.

---

## 6. Traffic visibility — Cloudflare Web Analytics (point 6)

GitHub's repo Traffic tab does not cover Pages site visits, so the hosted link
would otherwise be unmeasured. Cloudflare Web Analytics' manual snippet is
free, cookieless, and needs no DNS change.

Proposed placement, immediately before `</body>` in `app/index.html`:

```html
<!-- Cloudflare Web Analytics — cookieless, no DNS change required.
     PLACEHOLDER: owner to create the Cloudflare account and paste the site
     tag here. Do not commit a real token until it is supplied. -->
<script defer src="https://static.cloudflareinsights.com/beacon.min.js"
  data-cf-beacon='{"token": "__CF_BEACON_TOKEN__"}'></script>
```

**I will not sign up for anything on your behalf — the token stays a marked
placeholder until you supply it.**

**D10 — RESOLVED (owner, 2026-07-15): the snippet ships in Milestone C, not
A or B.** Review found that no milestone actually landed §6, *and* that —
unlike §4's build stamp, which is guarded by `/^__/` — the beacon snippet has
**no unreplaced-placeholder guard**. Shipped as drafted it would have had every
visitor's browser call `static.cloudflareinsights.com` with an invalid token,
directly contradicting Milestone A's "console clean" check. Deferring to C
removes the problem entirely: A and B ship with **no beacon at all**, nothing
is blocked on your Cloudflare signup, and the snippet lands with the README
rewrite once you have the tag. No placeholder guard is then needed, because the
placeholder never reaches production.

Two properties worth a conscious decision (**D4**):

- **It is cookieless**, so it does not violate the project's no-browser-storage
  rule (`state.js:1-3`, `README.md:96,107`).
- **It is the first third-party runtime request the app has ever made.**
  Everything today is vendored and self-contained (ECharts is a local copy).
  Adding a beacon means a visitor's browser contacts a domain other than the
  host. That is a real change to the app's privacy posture and worth stating
  in the README rather than slipping in.
- Suggest gating it off localhost (same `hostname` check) so dev loads do not
  pollute the stats — otherwise every one of your own refreshes is a "visit".

---

## 7. Sequencing — manual proof before automation (point 7)

**Milestone A — manual deploy proven (no cron).** The gate.
1. Owner enables Pages: Settings → Pages → Source: **GitHub Actions**.
2. Owner adds the repo secrets: `ENTSOE_TOKEN`, and
   `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, owner-generated).
3. Land the workflow with **`workflow_dispatch` only** — the `schedule:`
   stanza is deliberately absent at this stage.
4. Owner triggers it manually, once, with **`cold_start: true`** (run 1 has no
   snapshot by definition; this suppresses the spurious state-loss warning).
5. Verify (all of):
   - the URL loads (`https://lptva.github.io/gb-power-dashboard/`);
   - every tab renders; the zone switcher offers all **8** zones;
   - **System stress carries real history, not one day** — this is where the
     §0 state problem surfaces first, since run 1 is always a cold start;
   - JS/CSS URLs carry `?v=<sha>` (the §4 stamp actually applied);
   - **the `data-snapshot` draft release now exists and holds both the tarball
     and its checksum** — the precondition for run 2 proving D1;
   - **draft download actually resolves** (§0's flagged unknown) — prove it
     before anything depends on it;
   - **the integrity gates work**: corrupt the asset deliberately (truncate it,
     or upload a mismatched checksum) and confirm the run takes the cold-start
     path with a `::warning::` rather than crashing or restoring bad data. This
     is D8's whole point and must be tested, not assumed;
   - the step summary records the path taken (`cold start`, as requested);
   - **AI toggle: absent on non-GB zones; on GB it defaults to OFF on first
     load; enabling it renders the summary; a reload returns it to OFF**;
   - `data/overnight_summary.json` **is fetchable directly** while the toggle
     is off — confirming the honesty framing in §5 is accurate, not aspirational;
   - console clean;
   - **no `.env`, no `data_raw/`, no token** anywhere in the published
     artifact.

   **Gate: owner confirms the URL works before anything is automated.**

**Milestone B — automation.** Add the `schedule:` cron. Confirm two
consecutive green scheduled runs, and confirm run 2 **restored from the
snapshot** (step summary reads `state restored from snapshot (manifest v<N>…)`,
no `::warning::`, and the run is incremental rather than a second full rebuild
+ backfill) — that is the proof D1 works.

**Milestone C — docs and announcement.** Land the README/SETUP rewrite (§1)
pointing at the now-live link. **Only then** publish the features post.

This ordering is the owner's explicit requirement: manual deploy proven before
automation; link live and confirmed before any post points at it.

---

## Design-principle flags

- **No fabricated data** ✓ — CI runs the same ETL against the same public
  sources; nothing is mocked for the hosted build.
- **Keyless by default** ✓ — only ENTSO-E needs a token, and it is free; the
  GB core publishes without any secret.
- **No browser storage** ✓ — the Cloudflare beacon is cookieless (D4), and the
  new AI toggle (§5) is in-memory only in `state.js`, resetting to off on every
  load. The rule holds with no exceptions.
- **`.env` never under `app/`** ✓ by construction (it lives at the project
  root, and only `app/` is uploaded) — but Milestone A step 5 verifies the
  artifact explicitly rather than trusting it.
- **Zero-dependency rule** — deliberately diverges: the deploy job needs
  `certifi` (the ETL always did); `tests.yml` stays stdlib-only.
- **Assumption sliders unaffected** — they are in-memory only and never
  persisted, so hosting changes nothing about the modelling workflow.

---

## Decisions

- **D1 — cold-start/state strategy. RESOLVED (2026-07-15):** rolling GitHub
  Release snapshot + state-loss detection (§0). `actions/cache` rejected as
  best-effort; orphan branch rejected as data-in-git; rehydrate-from-site
  recorded as runner-up, rejected on the `zones/` manifest gap.
- **D2 — deploy method. APPROVED as written:** `upload-pages-artifact` +
  `deploy-pages`.
- **D3 — AI summary in the public build. RESOLVED (2026-07-15): YES**, with a
  default-off, in-memory, GB-only render toggle (§5).
- **D4 — Cloudflare beacon. APPROVED as written.**
- **D5 — cron time. APPROVED as written:** 06:30 UTC / 07:30 BST.
- **D6 — README/SETUP rewrite wording. APPROVED as written** (§1 draft), to
  land in Milestone C.
- **D7 — RESOLVED (2026-07-15):** the disclosure line is added, placed in the
  **toggle tooltip** (§5), with the affordance's visible copy noted as the
  fallback if the hover-only limitation proves awkward.
- **D8 — RESOLVED (2026-07-15):** snapshot restore validates before extracting
  (checksum + `tar tzf`); any failure takes the cold-start path with the same
  warning, never a crash and never a silent bad restore (§0).
- **D9 — RESOLVED (2026-07-15):** the **restore step** owns the cold start;
  `refresh.py` (which takes no CLI arguments) is skipped entirely on cold runs
  and left unmodified, preserving §5's "only application change" claim (§0).
- **D10 — RESOLVED (2026-07-15):** the Cloudflare snippet ships in **Milestone
  C**, not A — no beacon on the site until a real token exists, so no invalid
  requests and no placeholder guard needed (§6).
- **D11 — RESOLVED (2026-07-15):** `ENABLE_AI_SUMMARY=false` locally once the
  cron is live; CI becomes the sole generator (Open questions).
- **D12 — RESOLVED (2026-07-15):** default `github.io` URL, no custom domain.
- **Sub-question (D1) — RESOLVED:** **draft** release, not pre-release — keeps
  the internal state blob off the public Releases page. Conditional on the
  draft-download verification in §0.
- **Sub-question (§2) — RESOLVED:** snapshot upload stays **before** the Pages
  publish.

**Every decision is closed.** Nothing below needs owner input — the remaining
items are engineering verifications for Milestone A.

## Open questions / unverified

- **`--backfill 365` wall-clock is unmeasured** anywhere in the repo. ≈836
  calls derived from `fetch_stress.py:570-585` + `:317-319` + `:338-339`, with
  `time.sleep(0.15)` pacing. If it exceeds the job timeout on a cold start,
  D1's cold-start path needs a chunked or resumable strategy. **Measure
  before Milestone B** — it now gates Milestone A's very first run.
- **`CLAUDE_CODE_OAUTH_TOKEN` expires after one year** (§3). On expiry the
  summary step fails non-fatally: data keeps publishing, the AI panel silently
  stops updating. The §0 state-loss warning does **not** cover this — it is a
  different failure. Needs a calendar reminder, or a follow-up issue to detect
  a stale `generated_at` and warn in the run summary.
- **Pages subpath + trailing slash.** All asset and fetch paths are
  directory-relative, so `lptva.github.io/gb-power-dashboard/` should resolve;
  Pages redirects directory URLs to add the slash. Expected to work,
  **untested** — verify in Milestone A.
- **Custom domain** not considered; the default `github.io` subpath is
  assumed. Raise separately if wanted.
- **Draft-release download by tag is unverified** (§0) and load-bearing. Prove
  in Milestone A; fallbacks specced there.
- **The local launchd job — D11, RESOLVED:** set `ENABLE_AI_SUMMARY=false` in
  the local `.env` once the cron is live (Milestone B); CI becomes the sole
  generator of the published summary. The local dev copy then shows the
  existing "not enabled" note, which is already handled gracefully.
  **Correction to an earlier revision of this doc:** it claimed the duplication
  meant "two paid summaries per day (~£16–18/month instead of ~£8–9)". **That
  was wrong** — the summary runs on a *subscription*, so a second daily run
  doubles **usage-allowance consumption**, not money (see §3). The reason to
  turn it off is allowance headroom and avoiding pointless duplicate work, not
  a doubled bill. Whether the local ETL itself keeps running (for your own
  working copy) is unaffected and remains your habit to keep or drop.
- **Custom domain — D12, RESOLVED:** none. Publish at the default
  `lptva.github.io/gb-power-dashboard/`. This keeps §4's subpath/trailing-slash
  verification on the Milestone A list (a root domain would have removed it).
- **Does the hosted site supersede `ops/README.md`'s sleep caveat?** That doc
  currently points at "GitHub Actions cron publishing app/" as a hypothetical;
  once real, the caveat text should be revised. Cosmetic, but it will drift.

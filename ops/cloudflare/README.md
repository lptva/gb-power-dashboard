# Cloudflare Worker — reliable daily deploy trigger

`deploy-trigger-worker.js` fires the hosted dashboard's rebuild
(`.github/workflows/deploy.yml`) on Cloudflare's cron, because GitHub's
own `schedule:` trigger proved unreliable for this repository: it first
silently desynced (never fired at all, 17–19 Jul 2026), and once resynced
it fired daily but hours late, untethered from the cron time (06:43 cron →
11:00 and 13:29 UTC actual deliveries). Cloudflare cron triggers fire
within a minute of their slot, so this Worker is the **timing authority**;
the workflow's own cron stays on as a backup (trade-off below).

Runs started this way show up as `event=workflow_dispatch` in
`gh run list` (actor: the token's owner) — not `event=schedule`. That is
expected; freshness checks should look at the run *time*, not the event
type.

## One-time setup (dashboard only, no CLI)

Total ~10 minutes. You need: the Cloudflare account (already exists — Web
Analytics uses it) and your GitHub account.

### 1. Create the fine-grained GitHub token

GitHub → Settings → Developer settings → Fine-grained personal access
tokens → **Generate new token**:

- **Name**: `cloudflare-deploy-trigger` (so its purpose is obvious later)
- **Expiration**: 90 days is a sensible default — put the renewal date in
  your calendar; when it expires the Worker's runs fail visibly in the
  Cloudflare dashboard (and the site goes stale), nothing breaks silently.
- **Repository access**: *Only select repositories* →
  `lptva/gb-power-dashboard`
- **Permissions → Repository permissions → Actions: Read and write.**
  Nothing else. (This token can start workflows on this one repo, and
  that's all it can do.)

Copy the token once, paste it in step 2, and never store it anywhere
else — not in a file, not in this repo, not in a chat.

### 2. Create the Worker

Cloudflare dashboard → **Workers & Pages** → **Create** → Worker (the
"Hello World" starter is fine) → name it `gb-deploy-trigger` → deploy the
starter, then **Edit code**: replace the starter's contents with
`deploy-trigger-worker.js` from this directory, and deploy.

### 3. Add the token as a secret

The Worker's page → **Settings** → **Variables and secrets** → add:

- Type: **Secret** (encrypted — not plain text)
- Name: `GITHUB_PAT` (exactly — the code reads `env.GITHUB_PAT`)
- Value: the token from step 1

### 4. Add the cron trigger

The Worker's page → **Settings** → **Triggers** → **Cron Triggers** →
add both:

- `30 5 * * *` (05:30 UTC = 06:30 BST — upstream sources have all
  published yesterday's data well before then, per ops/README's 07:00
  rationale, and the build lands ~10 minutes later, comfortably before a
  morning check)
- `30 12 * * *` (12:30 UTC = 13:30 BST — the midday top-up; see the
  decision record below)

### 5. Verify

Quickest end-to-end test: temporarily add a second cron trigger a few
minutes in the future (e.g. `50 14 * * *` for 14:50 UTC), wait for it,
then delete it. Confirm with:

```bash
gh run list --workflow=deploy.yml --limit 3
```

— a fresh `workflow_dispatch` run at the trigger time is the pass. From
then on, the real proof is the next morning: the dashboard footer's
"Dataset built …" stamp should read ~05:4x UTC.

## Decision record: the GitHub cron was removed (2026-07-28)

deploy.yml originally kept its own cron as a backup while the Worker
proved itself. After a 7-day clean streak (22–28 Jul, every fire within
a minute of the 05:30 slot) against the GitHub cron's 7–12-hour scatter
over the same week, the owner removed the workflow's `schedule:` block
entirely. The Worker is now the only scheduler, with **two** cron
triggers on the one Worker (the free plan allows 3):

- `30 5 * * *` — the morning build (05:30 UTC = 06:30 BST)
- `30 12 * * *` — midday top-up (12:30 UTC = 13:30 BST): pulls the
  morning-peak settlement periods into the dataset intraday, and doubles
  as same-day cover if the 05:30 invocation is ever dropped (free-tier
  cron has no retry)

Two rebuilds a day is the same total as the redundant-cron era, so the
AI-summary spend is unchanged. Both triggers share this Worker's code
and the one `GITHUB_PAT` secret — nothing new to create beyond the
trigger itself (the Worker's page → Settings → Triggers → Cron
Triggers).

Remaining failure modes are shared-fate: an expired PAT or a Cloudflare
outage stops BOTH triggers (a stale site until noticed — the dashboard
footer's "Dataset built" stamp is the staleness clock). The PAT expiry
date lives in the owner's calendar; that entry is the mitigation.

## Failure modes

- **Token expired / revoked**: the dispatch returns 401, the Worker
  throws, the invocation shows as an error under the Worker's Logs, and
  the site goes stale until the token is renewed (step 1 + step 3 again).
- **Cloudflare cron missed**: not observed in practice; the other daily
  trigger covers it same-day (a dropped 05:30 fire means the site is a
  day stale until the 12:30 top-up lands).
- **Workflow itself fails**: unchanged from before — the run is red in
  GitHub Actions and the dashboard header surfaces the stale state.

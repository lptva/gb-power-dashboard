// Cloudflare Worker: trigger the hosted dashboard's daily rebuild.
//
// WHY THIS EXISTS (2026-07-21): GitHub's own `schedule:` trigger proved
// unreliable for this repo — first it silently desynced and never fired
// (17-19 Jul, fixed by a direct-to-main commit touching deploy.yml), then
// it fired daily but hours late and untethered from the cron time
// (06:43 cron → 11:00 and 13:29 UTC actual). Cloudflare's cron triggers
// honour their clock, so the RELIABLE path is: this Worker fires on
// Cloudflare's schedule and calls GitHub's workflow_dispatch API, which
// starts deploy.yml within seconds. deploy.yml's own cron stays on as a
// backup (see ops/cloudflare/README.md for the trade-off).
//
// Deployment is manual via the Cloudflare dashboard (paste this file in) —
// no wrangler, no build step, no npm. Setup steps: ops/cloudflare/README.md.
//
// Secrets: GITHUB_PAT — a fine-grained personal access token scoped to the
// lptva/gb-power-dashboard repository only, with Actions read+write and
// nothing else. Set it in the Worker's dashboard as a SECRET (encrypted),
// never as a plain-text variable, and never commit it anywhere.

const REPO = "lptva/gb-power-dashboard";
const WORKFLOW = "deploy.yml";

export default {
  async scheduled(event, env, ctx) {
    const resp = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          // GitHub returns 403 to requests without a User-Agent.
          "User-Agent": "gb-power-dashboard-deploy-trigger",
          "Authorization": `Bearer ${env.GITHUB_PAT}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        // cold_start is deliberately omitted: it defaults to false, so a
        // Worker-triggered run behaves exactly like a normal warm daily
        // refresh (state-loss warning stays armed).
        body: JSON.stringify({ ref: "main" }),
      },
    );

    // Success is 204 No Content. Anything else: throw, so the invocation
    // shows as an error in the Worker's dashboard (Workers & Pages → this
    // worker → Logs / past cron events) instead of failing silently.
    if (resp.status !== 204) {
      const body = await resp.text();
      throw new Error(
        `workflow dispatch failed: HTTP ${resp.status} — ${body.slice(0, 500)}`,
      );
    }
  },
};

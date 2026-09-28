# Cloudflare Self-Hosting: Operations

Day-to-day tasks after [initial setup](./SELF_HOSTING_CLOUDFLARE.md): connect the MCP server and manage telemetry. Updating and teammate access are covered in the [deploy guide](./SELF_HOSTING_CLOUDFLARE.md) (or the [legacy page](./SELF_HOSTING_CLOUDFLARE_LEGACY.md) for pre-alchemy deployments).

## Connect the MCP server through Cloudflare Access

Use the same Cloudflare Access application that protects your OpenSEO Worker.
Managed OAuth is required for MCP clients and is not enabled by default.

1. Open Cloudflare Zero Trust.
2. Go to `Access controls` -> `Applications`.
3. Find your OpenSEO application, then select `Edit`.
4. Go to `Additional settings` -> `OAuth`.
5. Turn on `Managed OAuth`.
6. In `Managed OAuth settings`, allow the redirect URIs your MCP clients use:
   - Allow `localhost` / loopback clients for CLI and desktop agents (Codex
     CLI, Claude Code) that register `http://localhost:PORT/callback`.
   - Add HTTPS redirect URIs for web connectors (a path may end in `/*`).
   - Without this, clients can't finish [Dynamic Client Registration](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
     and log in but expose no tools.
7. Save.

MCP clients should connect to:

```text
https://YOUR_WORKER_HOSTNAME/mcp
```

### Read-only access for a service (Access service token)

A server-side integration can read the shared workspace over `/mcp` without a
person's login by using a Cloudflare Access service token:

1. Create a service token in Zero Trust and add a policy to the OpenSEO Access
   application with action `Service Auth` that includes only that token.
2. Put the token's client id (`<id>.access`, the JWT `common_name`) in
   `ACCESS_READONLY_SERVICE_TOKENS` in `.env.selfhost` (comma-separated for
   several) and redeploy.
3. The service sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` on each
   `POST /mcp` request.

That identity sees only the tools that read OpenSEO's own database and cost no
credits: `list_projects`, `get_project_context`, `get_project_overview`,
`list_saved_keywords`, `get_rank_tracker`, `get_audit_issues`,
`get_audit_pages`, `list_reports` and `get_report`. It cannot write or call
DataForSEO, and the web app and API routes still reject it.

### Capped actions for a service (action service token)

A separate service token listed in `ACCESS_ACTION_SERVICE_TOKENS` gets the read
tools above plus a small action allowlist (`ACTION_TOOL_NAMES` in
`src/server/mcp/server.ts`):

- keyword research: `research_keywords`, `get_keyword_metrics`
- competitor and domain lookups: `get_domain_overview`,
  `get_domain_keyword_suggestions`, `get_ranked_keywords`,
  `find_serp_competitors`
- the full backlink list, one bounded page at a time: `get_backlinks_profile`
- rank tracking: `create_rank_tracker`, `add_rank_tracking_keywords`,
  `remove_rank_tracking_keywords`, `estimate_rank_tracker_cost`,
  `run_rank_tracker`
- site audits (Lighthouse optional): `run_site_audit`, `get_audit_status`

Everything else stays refused, including project, context, keyword and report
writes, SERP and local-SEO lookups, Search Console and GA4. Setup is the same as
for the read-only token: its own Zero Trust service token, its own `Service
Auth` policy on the Access application, and its client id in
`ACCESS_ACTION_SERVICE_TOKENS`. A client id on both lists stays read-only.

The action identity is meant for a caller that caps DataForSEO spend itself
(Autograf Command), so:

- **It cannot start spend that runs outside its caller.** `create_rank_tracker`
  is refused unless the schedule is `manual`, and `add_rank_tracking_keywords`
  is refused with `maxEstimatedScheduledCheckCredits`, so it can never set up or
  approve checks that OpenSEO's scheduler would bill later. The caller runs
  checks explicitly with `run_rank_tracker`.
- **Every result reports what it cost.** Each action tool result carries
  `_meta.dataforseoSpend = { costUsd, calls }`: the sum of DataForSEO's own
  per-task `cost` for every call the tool made in that request, including
  charged failures (cache hits are free). Self-hosted OpenSEO bills DataForSEO
  directly and meters no credits, so this is the only per-call spend record.
  Work that continues in the background (the rank-check and site-audit
  workflows) is not in the request and reports `0`; the caller accounts for it
  from `estimate_rank_tracker_cost` and the audit's Lighthouse sample (at most
  10 pages x 2 strategies).

## Telemetry

OpenSEO collects anonymized telemetry for core usage events: heartbeats with aggregate counts (installs, users, projects, feature usage) tied to a random install ID, sent every 5 minutes during the first two hours after install, then at most once daily. No URLs, keywords, prompts, emails, or IP-derived location are collected, and idle installs send nothing.

To disable it, set `OPENSEO_TELEMETRY_DISABLED=1` in `.env.selfhost` and redeploy. Docker and [legacy deployments](./SELF_HOSTING_CLOUDFLARE_LEGACY.md): set it (or `DO_NOT_TRACK=1`) as an environment variable / Worker variable instead.

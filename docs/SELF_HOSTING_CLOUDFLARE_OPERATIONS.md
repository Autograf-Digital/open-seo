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

## Telemetry

OpenSEO collects anonymized telemetry for core usage events: heartbeats with aggregate counts (installs, users, projects, feature usage) tied to a random install ID, sent every 5 minutes during the first two hours after install, then at most once daily. No URLs, keywords, prompts, emails, or IP-derived location are collected, and idle installs send nothing.

To disable it, set `OPENSEO_TELEMETRY_DISABLED=1` in `.env.selfhost` and redeploy. Docker and [legacy deployments](./SELF_HOSTING_CLOUDFLARE_LEGACY.md): set it (or `DO_NOT_TRACK=1`) as an environment variable / Worker variable instead.

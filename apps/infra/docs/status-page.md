# Public status page (incident.io)

`https://status.boxlite.ai` is an incident.io-hosted status page. Nothing in
the stack serves it; the API *feeds* it. What depends on it in this repo:

- `apps/api/src/status-sync/` — the sync that keeps it honest (below)
- `apps/api/src/common/middleware/maintenance.middleware.ts` — the 503
  maintenance message points at it
- `README.md` — Getting Help links it

## How the sync works

`StatusSyncService` (`apps/api/src/status-sync/services/status-sync.service.ts`)
runs every 30s on one replica (Redis lock). Each tick it observes:

| Observation                | Signal                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| `api`                      | in-process Postgres ping + Redis ping                                   |
| `boxes-<region>`           | runner fleet per **shared** region: any UNRESPONSIVE among schedulable, non-draining runners |
| `box-ingress-<region>`     | `GET <region.proxyUrl>/health` over the public path                     |

Transitions are damped (3 consecutive bad ticks to fire ≈ 90s sustained, 2 good
ticks to resolve) and pushed as alert events —
`POST /v2/alert_events/http/<source-id>` with stable deduplication keys
`<prefix>-<observation>` (prefix defaults to `boxlite-<stage>`), body
`{title, status: firing|resolved, deduplication_key, description, metadata}`
where `metadata = {component, region?, prefix, source: 'boxlite-status-sync'}`.
After every completed tick it pings `POST /v2/heartbeat/<id>/ping`: if the API
dies, crons stop, or Redis is unreachable, the pings stop and incident.io
raises the alarm on its own.

Dedicated/custom regions never reach the page — they are org-scoped. Known v1
blind spots are documented on the service class.

## One-time incident.io setup

Do these in order; the stage stays dark until the final step.

1. **Create the page** (Status pages → Create, public). Split it **by region
   via sub-pages** (catalog `Region` type → one sub-page per shared region, a
   region selector in the header). Components: `Dashboard`, `API`, `Docs`
   shown on every page; `Boxes` and `Box Ingress` scoped to each region's
   sub-page. Adding a region later = one catalog entry + two components +
   extending the workflow mapping in step 6.
2. **Enable the uptime display** (per-component uptime % + the `/uptime`
   history view). It is computed from incidents' component impacts — i.e. fed
   by this sync; nothing else to wire.
3. **Custom domain**: Settings → Custom domain → `status.boxlite.ai`; add the
   CNAME it shows you in the **Cloudflare dashboard** for the `boxlite.ai`
   zone (the zone is administered outside this repo, like `go.boxlite.ai` and
   `sh.boxlite.ai` — this is deliberately *not* an SST resource: the status
   page must not depend on a stack deploy). DNS-only unless incident.io's
   instructions say proxying is supported. Wait for their certificate check.
4. **Create the HTTP alert source** (Alerts → Sources → HTTP). Note the
   `alert_source_config_id` from its URL. Send one test event with the exact
   body shape above and bind the default attributes; map `metadata.component`
   and `metadata.region` to catalog attributes.
5. **Create the heartbeat** (On-call → Heartbeats): **interval 2 minutes** —
   four ticks, so one slow/skipped tick or a rolling deploy does not false-fire,
   while a dead reporter still alarms in ~2–3 minutes. Note its id, then
   curl-verify the ping path before arming:
   `curl -X POST https://api.incident.io/v2/heartbeat/<id>/ping -H "Authorization: Bearer <key>"`
   (a wrong path announces itself as an immediate heartbeat alarm).
6. **Alert route + workflow**: route the source's alerts to auto-create an
   incident per deduplication key (grouping window ≥ 5 min; auto-resolve the
   incident when its alerts resolve), and an auto-publishing workflow that maps
   `metadata.component` + `metadata.region` to the matching page component's
   impact, publishing on create and resolving with the incident.
7. **API key**: create one scoped to *create alert events* and *send heartbeat
   pings* only — no incident, catalog, or status-page write scopes.
8. **Arm the stage**: put `INCIDENT_IO_ALERT_SOURCE_CONFIG_ID` (and optionally
   `INCIDENT_IO_HEARTBEAT_ID`) in the stage configuration, set the
   `INCIDENT_IO_TOKEN` secret (`npm run sst -- secret set`, non-echoing stdin
   procedure in README.md), deploy. Setting the secret is what turns the sync
   on (`STATUS_SYNC_ENABLED` is derived from it in `stack/api.ts`).

## Go-live checklist

- `status.boxlite.ai` resolves with a valid certificate and renders the page
- Region sub-pages navigate; `Dashboard`/`API`/`Docs` appear on each
- Open a test incident by stopping one region's proxy (or post a synthetic
  `firing` event): the page marks that region's `Box Ingress` affected within
  ~2 minutes of sustained failure, and clears within ~1 minute of recovery
- The heartbeat shows healthy in incident.io while the API runs, and alarms
  within its interval when the API is stopped
- The README link works

## Operational notes

- **Planned maintenance**: `MAINTENANCE_MODE`/`DISABLE_CRON_JOBS` stop every
  cron (`app.service.ts`), including this one — the heartbeat then alarms, by
  design. Schedule an incident.io **maintenance window** first so the page
  says "maintenance", not "outage".
- **First enablement** emits one `resolved` seed per component — harmless
  no-ops that establish the dedup keys.
- **Dev stages stay dark**: never set `INCIDENT_IO_TOKEN` there. The public
  page describes production only.
- **Removing a region** while its alert is firing leaves that alert firing
  (the sync's Redis state just expires after 24h): resolve the incident
  manually and remove the page components.
- **Token rotation**: set the new secret and redeploy; until then failed sends
  retry twice a minute per component and are visible in the API logs.
- If external uptime probing is ever added, `GET /api/health` is the only
  publicly pollable endpoint, and it sits behind the anonymous rate limit
  (`RATE_LIMIT_ANONYMOUS_*`), whose budget is shared per source IP across all
  anonymous routes — size probe intervals against the production limits.

# BoxLite application API catalog

This catalog lists the interfaces registered by the applications in this
directory. It covers HTTP, WebSocket, CONNECT, OTLP, health, static-asset, and
outbound event interfaces; each entry names the owning service and what the
interface does. Route tables are collapsed by default — expand a summary line
to see its routes.

The inventory is implementation-grounded:

- Control-plane product routes come from the controllers under
  [`api/src`](./api/src/), match the generated
  [`openapi.yaml`](./libs/api-client-go/api/openapi.yaml), and use the `/api`
  prefix applied in [`main.ts`](./api/src/main.ts).
- Hosted BoxLite-compatible routes come from the controllers in
  [`boxlite-rest`](./api/src/boxlite-rest/). They are excluded from the product
  OpenAPI document because their portable contract lives in
  [`openapi/box.openapi.yaml`](../openapi/box.openapi.yaml).
- Runner, proxy, and collector routes come from their runtime registration in
  [`server.go`](./runner/pkg/api/server.go),
  [`proxy.go`](./proxy/pkg/proxy/proxy.go), and
  [`config.yaml`](./otel-collector/config.yaml).
- Static asset trees come from the `ServeStaticModule` registrations in
  [`app.module.ts`](./api/src/app.module.ts).
- Outbound and asynchronous interfaces come from
  [`notification.gateway.ts`](./api/src/notification/gateways/notification.gateway.ts),
  [`webhook-events.constants.ts`](./api/src/webhook/constants/webhook-events.constants.ts),
  and [`kafka-exception.filter.ts`](./api/src/filters/kafka-exception.filter.ts).
- Local-stack listeners come from the service specs in
  [`services.py`](./infra-local/compose/services.py) and
  [`native.py`](./infra-local/compose/native.py); the container-based
  environment's come from
  [`local-dex-env.mjs`](./scripts/local-dex-env.mjs).

`openapi/box.openapi.yaml` also describes portable capabilities that the hosted
service does not currently register, including snapshots, clone, export,
import, images, and runtime-wide metrics. They are intentionally absent below;
`GET /api/v1/config` reports snapshots, clone, export, and import as disabled.

## Services at a glance

| API                                                                       | Service                      | Base path or host                                                                    | Deployed port            |
| ------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| [Control-plane API](#control-plane-api)                                   | `apps/api`                   | `/api`                                                                               | `3000`                   |
| [Hosted BoxLite-compatible API](#hosted-boxlite-compatible-api)           | `apps/api`                   | `/api/v1`                                                                            | `3000`                   |
| [Runner API](#runner-api)                                                 | `apps/runner`                | `/`                                                                                  | `3003`                   |
| [Preview proxy API](#preview-proxy-api)                                   | `apps/proxy`                 | `proxy.<domain>`, `<port>-<box>.proxy.<domain>`                                      | `4000`                   |
| [Telemetry collector API](#telemetry-collector-api)                       | `apps/otel-collector`        | OTLP/HTTP and health listeners                                                       | `4318`, `13133`, `13132` |
| [Local development stack](#local-development-stack)                       | `apps/infra-local`           | `http://localhost:28080`                                                             | local host ports only    |
| [Container-based local environment](#container-based-local-environment)   | `apps/scripts`               | containers on `5556`, `5432`, `6379`, `5001`; apps on `3000`, `3001`, `4000`, `8080` | local host ports only    |
| [Externally served APIs](#externally-served-apis)                         | `apps/dashboard`, `apps/api` | discovered via `GET /api/config`                                                     | —                        |
| [Services without a first-party API](#services-without-a-first-party-api) | remaining apps               | —                                                                                    | —                        |

Ports are the values used in deployments. Service ports and the collector's
OTLP and HTTP health ports come from
[`settings.ts`](./infra/stack/settings.ts); the collector's gRPC health port
comes from its own [`config.yaml`](./otel-collector/config.yaml). Where an
in-code default differs, the section notes it.

## Control-plane API

**Service:** `apps/api` · **Base path:** `/api` · **Port:** `3000` in
deployments (`PORT` environment variable; no in-code default)

This is the hosted product API used by the dashboard, SDKs, CLI, runners, and
internal services. Authentication and authorization vary by route; the health
and configuration discovery routes are public, while resource routes enforce
user, organization, runner, or admin credentials. The static trees this process
serves and the events it emits are catalogued below alongside its routes.

<details>
<summary><b>Discovery and API keys</b> · 7 routes</summary>

| Method   | Path                            | What it does                                                   |
| -------- | ------------------------------- | -------------------------------------------------------------- |
| `GET`    | `/api/config`                   | Returns browser/client configuration, including OIDC settings. |
| `GET`    | `/api/api-keys`                 | Lists API keys visible to the caller.                          |
| `POST`   | `/api/api-keys`                 | Creates an API key.                                            |
| `GET`    | `/api/api-keys/current`         | Returns details for the API key authenticating the request.    |
| `GET`    | `/api/api-keys/{name}`          | Gets an API key by name.                                       |
| `DELETE` | `/api/api-keys/{name}`          | Deletes the caller's API key by name.                          |
| `DELETE` | `/api/api-keys/{userId}/{name}` | Deletes a named API key belonging to a specified user.         |

</details>

<details>
<summary><b>Users and authentication</b> · 10 routes</summary>

| Method   | Path                                                     | What it does                                   |
| -------- | -------------------------------------------------------- | ---------------------------------------------- |
| `GET`    | `/api/users/me`                                          | Returns the authenticated user.                |
| `GET`    | `/api/users`                                             | Lists users.                                   |
| `POST`   | `/api/users`                                             | Creates a user.                                |
| `GET`    | `/api/users/{id}`                                        | Gets a user by ID.                             |
| `POST`   | `/api/users/{id}/regenerate-key-pair`                    | Regenerates a user's key pair.                 |
| `GET`    | `/api/users/account-providers`                           | Lists account providers available for linking. |
| `POST`   | `/api/users/linked-accounts`                             | Links an external account to the user.         |
| `DELETE` | `/api/users/linked-accounts/{provider}/{providerUserId}` | Unlinks an external account.                   |
| `POST`   | `/api/users/mfa/sms/enroll`                              | Enrolls the user in SMS MFA.                   |
| `GET`    | `/api/auth/end-session`                                  | Starts OIDC RP-initiated logout.               |

</details>

<details>
<summary><b>Organizations, membership, and invitations</b> · 23 routes</summary>

| Method   | Path                                                                     | What it does                                             |
| -------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `GET`    | `/api/organizations`                                                     | Lists organizations available to the caller.             |
| `POST`   | `/api/organizations`                                                     | Creates an organization.                                 |
| `GET`    | `/api/organizations/{organizationId}`                                    | Gets an organization by ID.                              |
| `GET`    | `/api/organizations/{organizationId}/concurrency`                        | Gets a bounded concurrency timeline from usage periods.  |
| `DELETE` | `/api/organizations/{organizationId}`                                    | Deletes an organization.                                 |
| `PATCH`  | `/api/organizations/{organizationId}/name`                               | Changes an organization's name.                          |
| `PATCH`  | `/api/organizations/{organizationId}/default-region`                     | Sets the organization's default region.                  |
| `POST`   | `/api/organizations/{organizationId}/leave`                              | Removes the caller from the organization.                |
| `POST`   | `/api/organizations/{organizationId}/suspend`                            | Suspends the organization.                               |
| `POST`   | `/api/organizations/{organizationId}/unsuspend`                          | Restores a suspended organization.                       |
| `GET`    | `/api/organizations/by-box-id/{boxId}`                                   | Resolves the organization that owns a box.               |
| `POST`   | `/api/organizations/{organizationId}/box-default-limited-network-egress` | Changes the default limited-egress policy for new boxes. |
| `PUT`    | `/api/organizations/{organizationId}/experimental-config`                | Replaces the organization's experimental configuration.  |
| `GET`    | `/api/organizations/{organizationId}/users`                              | Lists organization members.                              |
| `POST`   | `/api/organizations/{organizationId}/users/{userId}/access`              | Changes a member's organization access.                  |
| `DELETE` | `/api/organizations/{organizationId}/users/{userId}`                     | Removes a member from the organization.                  |
| `GET`    | `/api/organizations/invitations`                                         | Lists invitations addressed to the caller.               |
| `GET`    | `/api/organizations/invitations/count`                                   | Counts invitations addressed to the caller.              |
| `POST`   | `/api/organizations/invitations/{invitationId}/accept`                   | Accepts an organization invitation.                      |
| `POST`   | `/api/organizations/invitations/{invitationId}/decline`                  | Declines an organization invitation.                     |
| `GET`    | `/api/organizations/{organizationId}/invitations`                        | Lists the organization's pending invitations.            |
| `POST`   | `/api/organizations/{organizationId}/invitations`                        | Creates an organization invitation.                      |
| `PUT`    | `/api/organizations/{organizationId}/invitations/{invitationId}`         | Changes a pending invitation.                            |
| `POST`   | `/api/organizations/{organizationId}/invitations/{invitationId}/cancel`  | Cancels a pending invitation.                            |

</details>

<details>
<summary><b>Roles and regions</b> · 11 routes</summary>

| Method   | Path                                                 | What it does                                 |
| -------- | ---------------------------------------------------- | -------------------------------------------- |
| `GET`    | `/api/organizations/{organizationId}/roles`          | Lists organization roles.                    |
| `POST`   | `/api/organizations/{organizationId}/roles`          | Creates an organization role.                |
| `PUT`    | `/api/organizations/{organizationId}/roles/{roleId}` | Updates an organization role.                |
| `DELETE` | `/api/organizations/{organizationId}/roles/{roleId}` | Deletes an organization role.                |
| `GET`    | `/api/regions`                                       | Lists regions available to the organization. |
| `POST`   | `/api/regions`                                       | Creates a region.                            |
| `GET`    | `/api/regions/{id}`                                  | Gets a region by ID.                         |
| `PATCH`  | `/api/regions/{id}`                                  | Updates a region's configuration.            |
| `DELETE` | `/api/regions/{id}`                                  | Deletes a region.                            |
| `POST`   | `/api/regions/{id}/regenerate-proxy-api-key`         | Regenerates the region proxy's API key.      |
| `GET`    | `/api/shared-regions`                                | Lists shared regions.                        |

</details>

<details>
<summary><b>Boxes and preview access</b> · 19 routes</summary>

| Method | Path                                                                    | What it does                                          |
| ------ | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET`  | `/api/box`                                                              | Lists all boxes visible to the caller.                |
| `GET`  | `/api/box/paginated`                                                    | Lists boxes with pagination.                          |
| `GET`  | `/api/box/for-runner`                                                   | Lists boxes assigned to the authenticated runner.     |
| `GET`  | `/api/box/{boxIdOrName}`                                                | Gets a box by ID or name.                             |
| `POST` | `/api/box/{boxIdOrName}/recover`                                        | Requests recovery of a box in an error state.         |
| `PUT`  | `/api/box/{boxIdOrName}/labels`                                         | Replaces a box's labels.                              |
| `PUT`  | `/api/box/{boxId}/state`                                                | Updates the control plane's recorded box state.       |
| `POST` | `/api/box/{boxIdOrName}/public/{isPublic}`                              | Makes a box public or private.                        |
| `POST` | `/api/box/{boxId}/last-activity`                                        | Records the box's latest activity time.               |
| `POST` | `/api/box/{boxIdOrName}/autostop/{interval}`                            | Sets the box auto-stop interval.                      |
| `POST` | `/api/box/{boxIdOrName}/autodelete/{interval}`                          | Sets the box auto-delete interval.                    |
| `GET`  | `/api/box/{boxIdOrName}/ports/{port}/preview-url`                       | Returns the preview URL for a box port.               |
| `GET`  | `/api/box/{boxIdOrName}/ports/{port}/signed-preview-url`                | Creates a signed preview URL for a box port.          |
| `POST` | `/api/box/{boxIdOrName}/ports/{port}/signed-preview-url/{token}/expire` | Expires a signed preview URL token.                   |
| `GET`  | `/api/box/{boxId}/toolbox-proxy-url`                                    | Returns the box toolbox proxy URL.                    |
| `GET`  | `/api/preview/{boxId}/public`                                           | Reports whether a box is publicly reachable.          |
| `GET`  | `/api/preview/{boxId}/validate/{authToken}`                             | Validates a box preview authentication token.         |
| `GET`  | `/api/preview/{boxId}/access`                                           | Checks whether the caller may preview a box.          |
| `GET`  | `/api/preview/{signedPreviewToken}/{port}/box-id`                       | Resolves a signed preview token and port to a box ID. |

</details>

<details>
<summary><b>Volumes and object storage</b> · 6 routes</summary>

| Method   | Path                              | What it does                                       |
| -------- | --------------------------------- | -------------------------------------------------- |
| `GET`    | `/api/volumes`                    | Lists volumes visible to the caller.               |
| `POST`   | `/api/volumes`                    | Creates a volume.                                  |
| `GET`    | `/api/volumes/{volumeId}`         | Gets a volume by ID.                               |
| `DELETE` | `/api/volumes/{volumeId}`         | Deletes a volume.                                  |
| `GET`    | `/api/volumes/by-name/{name}`     | Gets a volume by name.                             |
| `GET`    | `/api/object-storage/push-access` | Returns temporary credentials for pushing objects. |

</details>

<details>
<summary><b>Runners and jobs</b> · 14 routes</summary>

| Method   | Path                           | What it does                                                   |
| -------- | ------------------------------ | -------------------------------------------------------------- |
| `GET`    | `/api/runners`                 | Lists runners.                                                 |
| `POST`   | `/api/runners`                 | Registers a runner.                                            |
| `GET`    | `/api/runners/me`              | Returns the authenticated runner's identity and configuration. |
| `GET`    | `/api/runners/by-box/{boxId}`  | Resolves the runner assigned to a box.                         |
| `GET`    | `/api/runners/{id}`            | Gets a runner by ID.                                           |
| `GET`    | `/api/runners/{id}/full`       | Gets a runner with its full related data.                      |
| `DELETE` | `/api/runners/{id}`            | Deletes a runner.                                              |
| `PATCH`  | `/api/runners/{id}/scheduling` | Enables or disables scheduling onto a runner.                  |
| `PATCH`  | `/api/runners/{id}/draining`   | Enables or disables runner draining.                           |
| `POST`   | `/api/runners/healthcheck`     | Records or checks runner health.                               |
| `GET`    | `/api/jobs`                    | Lists jobs assigned to the authenticated runner.               |
| `GET`    | `/api/jobs/poll`               | Long-polls for work assigned to the runner.                    |
| `GET`    | `/api/jobs/{jobId}`            | Gets a job by ID.                                              |
| `POST`   | `/api/jobs/{jobId}/status`     | Reports job progress, success, or failure.                     |

</details>

<details>
<summary><b>Administration</b> · 6 routes</summary>

| Method   | Path                                 | What it does                                   |
| -------- | ------------------------------------ | ---------------------------------------------- |
| `GET`    | `/api/admin/runners`                 | Lists runners using admin authorization.       |
| `POST`   | `/api/admin/runners`                 | Registers a runner as an administrator.        |
| `GET`    | `/api/admin/runners/{id}`            | Gets a runner by ID as an administrator.       |
| `DELETE` | `/api/admin/runners/{id}`            | Deletes a runner as an administrator.          |
| `PATCH`  | `/api/admin/runners/{id}/scheduling` | Changes runner scheduling as an administrator. |
| `POST`   | `/api/admin/box/{boxId}/recover`     | Requests box recovery as an administrator.     |

</details>

<details>
<summary><b>Webhooks and audit</b> · 8 routes</summary>

| Method | Path                                                                         | What it does                                               |
| ------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `POST` | `/api/webhooks/organizations/{organizationId}/app-portal-access`             | Creates access to the organization's Svix consumer portal. |
| `POST` | `/api/webhooks/organizations/{organizationId}/send`                          | Sends a webhook event to the organization.                 |
| `GET`  | `/api/webhooks/organizations/{organizationId}/messages/{messageId}/attempts` | Lists delivery attempts for a webhook message.             |
| `GET`  | `/api/webhooks/status`                                                       | Reports webhook service status.                            |
| `GET`  | `/api/webhooks/organizations/{organizationId}/initialization-status`         | Reports whether organization webhooks are initialized.     |
| `POST` | `/api/webhooks/organizations/{organizationId}/initialize`                    | Initializes webhooks for an organization.                  |
| `GET`  | `/api/audit`                                                                 | Lists audit records available to the caller.               |
| `GET`  | `/api/audit/organizations/{organizationId}`                                  | Lists one organization's audit records.                    |

</details>

<details>
<summary><b>Box telemetry</b> · 5 routes</summary>

| Method | Path                                                           | What it does                                                             |
| ------ | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET`  | `/api/box/{boxId}/telemetry/logs`                              | Queries logs for a box.                                                  |
| `GET`  | `/api/box/{boxId}/telemetry/traces`                            | Queries traces for a box.                                                |
| `GET`  | `/api/box/{boxId}/telemetry/traces/{traceId}`                  | Gets spans for one trace.                                                |
| `GET`  | `/api/box/{boxId}/telemetry/metrics`                           | Queries metrics for a box.                                               |
| `GET`  | `/api/organizations/otel-config/by-box-auth-token/{authToken}` | Resolves a box token to its organization telemetry export configuration. |

</details>

<details>
<summary><b>Health and API documentation</b> · 5 routes</summary>

| Method | Path                | What it does                                                  |
| ------ | ------------------- | ------------------------------------------------------------- |
| `GET`  | `/api/health`       | Reports process liveness.                                     |
| `GET`  | `/api/health/ready` | Checks authenticated readiness, including Postgres and Redis. |
| `GET`  | `/api`              | Serves the interactive Swagger UI.                            |
| `GET`  | `/api-json`         | Returns the generated product OpenAPI document as JSON.       |
| `GET`  | `/api-yaml`         | Returns the generated product OpenAPI document as YAML.       |

</details>

<details>
<summary><b>Static asset trees</b> · 2 trees</summary>

| Method | Path            | What it does                                                             |
| ------ | --------------- | ------------------------------------------------------------------------ |
| `GET`  | `/runner-amd64` | Serves `runner-amd64` from the deployment root, when that file is there. |
| `GET`  | `/`             | Serves the dashboard single-page app and its hashed `/assets/*` bundles. |

Both trees are registered by `ServeStaticModule` in
[`app.module.ts`](./api/src/app.module.ts) and exclude `/api/{*path}`, so they
never shadow the routes above. The dashboard tree applies a content-addressed
cache policy from [`serve-static-cache.ts`](./api/src/serve-static-cache.ts):
hashed `/assets/*` files are `immutable` for a year, HTML is `no-cache`, and
everything else must revalidate.

The file that route resolves to is the runner binary
[`project.json`](./runner/project.json) builds at `dist/apps/runner-amd64`, so
the path serves something only in a full local build: the deployed image stages
just `dist/apps/api` and `dist/apps/dashboard`
([`Dockerfile`](./api/Dockerfile)). No in-repo client fetches it either — runners
take their binary from the artifact source resolved in
[`source.ts`](./infra/artifacts/source.ts), which defaults to a published
release fetched over HTTPS.

</details>

<details>
<summary><b>Realtime and asynchronous interfaces</b> · Socket.IO, 9 events, 4 webhook events, 2 Kafka topics</summary>

| Protocol                 | Path, topic, or event          | What it does                                                                                                                           |
| ------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Socket.IO over WebSocket | `/api/socket.io/`              | Authenticates a JWT or API key, joins user and organization rooms, and streams resource notifications.                                 |
| Socket.IO event          | `box.created`                  | Notifies an organization that a box was created.                                                                                       |
| Socket.IO event          | `box.state.updated`            | Notifies an organization that a box's observed state changed.                                                                          |
| Socket.IO event          | `box.desired-state.updated`    | Notifies an organization that a box's desired state changed.                                                                           |
| Socket.IO event          | `volume.created`               | Notifies an organization that a volume was created.                                                                                    |
| Socket.IO event          | `volume.state.updated`         | Notifies an organization that a volume's state changed.                                                                                |
| Socket.IO event          | `volume.lastUsedAt.updated`    | Notifies an organization that a volume's last-used time changed.                                                                       |
| Socket.IO event          | `runner.created`               | Notifies an organization that a runner was registered.                                                                                 |
| Socket.IO event          | `runner.state.updated`         | Notifies an organization that a runner's state changed.                                                                                |
| Socket.IO event          | `runner.unschedulable.updated` | Notifies an organization that runner scheduling availability changed.                                                                  |
| Webhook event (Svix)     | `box.created`                  | Delivers a signed box-created event to the organization's subscribed endpoints.                                                        |
| Webhook event (Svix)     | `box.state.updated`            | Delivers a box observed-state change to the organization's subscribed endpoints.                                                       |
| Webhook event (Svix)     | `volume.created`               | Delivers a volume-created event to the organization's subscribed endpoints.                                                            |
| Webhook event (Svix)     | `volume.state.updated`         | Delivers a volume state change to the organization's subscribed endpoints.                                                             |
| Kafka event              | `audit-logs` topic             | When the API worker and Kafka are enabled, consumes audit-log events and persists them, with bounded retries and dead-letter handling. |
| Kafka event              | `audit-logs.dlq` topic         | Receives audit-log events that exhausted their retries, with the failure reason and retry count attached.                              |

Socket.IO and webhook events share four names but not their delivery: Socket.IO
broadcasts to the organization's room over the authenticated WebSocket, while
webhook events are delivered as signed HTTP requests through Svix to endpoints
the organization manages in its consumer portal. Payload schemas are published
in a `webhooks` block that
[`openapi-webhooks.ts`](./api/src/openapi-webhooks.ts) adds to the generated
`openapi.3.1.0.json` only — not to the checked-in `openapi.yaml` named above.
The `template.*` values remain in the `WebhookEvent` enum but nothing emits
them.

</details>

## Hosted BoxLite-compatible API

**Service:** `apps/api` · **Base path:** `/api/v1` · **Port:** `3000` in
deployments (shared with the control-plane API)

Most resource paths accept both an unprefixed form and an organization-prefixed
form. The tables write that as `[/{prefix}]`; clients can discover their prefix
through `GET /api/v1/me`. Except for configuration discovery, these routes use
combined bearer authentication. The box and volume resource routes also apply
organization authorization; identity discovery at `GET /api/v1/me` can return
`path_prefix: null` for an authenticated user with no organization membership.

<details>
<summary><b>Discovery</b> · 2 routes</summary>

| Method | Path             | What it does                                                               |
| ------ | ---------------- | -------------------------------------------------------------------------- |
| `GET`  | `/api/v1/config` | Reports which optional portable API capabilities are enabled.              |
| `GET`  | `/api/v1/me`     | Returns the calling principal, path prefix, scopes, and credential expiry. |

</details>

<details>
<summary><b>Box lifecycle</b> · 7 routes</summary>

| Method   | Path                                     | What it does                                |
| -------- | ---------------------------------------- | ------------------------------------------- |
| `POST`   | `/api/v1[/{prefix}]/boxes`               | Creates a box and waits for it to start.    |
| `GET`    | `/api/v1[/{prefix}]/boxes`               | Lists boxes in the organization.            |
| `GET`    | `/api/v1[/{prefix}]/boxes/{boxId}`       | Gets a box by ID or name.                   |
| `HEAD`   | `/api/v1[/{prefix}]/boxes/{boxId}`       | Checks whether a box exists.                |
| `DELETE` | `/api/v1[/{prefix}]/boxes/{boxId}`       | Destroys a box.                             |
| `POST`   | `/api/v1[/{prefix}]/boxes/{boxId}/start` | Starts a box and waits until it is running. |
| `POST`   | `/api/v1[/{prefix}]/boxes/{boxId}/stop`  | Stops a box.                                |

</details>

<details>
<summary><b>Execution, files, metrics, and networking</b> · 10 routes</summary>

| Method   | Path                                                          | What it does                                            |
| -------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| `POST`   | `/api/v1[/{prefix}]/boxes/{boxId}/exec`                       | Starts a command execution through the assigned runner. |
| `GET`    | `/api/v1[/{prefix}]/boxes/{boxId}/executions/{execId}`        | Gets execution status and exit information.             |
| `DELETE` | `/api/v1[/{prefix}]/boxes/{boxId}/executions/{execId}`        | Kills an execution.                                     |
| `WS`     | `/api/v1[/{prefix}]/boxes/{boxId}/executions/{execId}/attach` | Attaches a bidirectional WebSocket to an execution.     |
| `POST`   | `/api/v1[/{prefix}]/boxes/{boxId}/executions/{execId}/signal` | Sends a signal to an execution.                         |
| `POST`   | `/api/v1[/{prefix}]/boxes/{boxId}/executions/{execId}/resize` | Resizes an execution's terminal.                        |
| `PUT`    | `/api/v1[/{prefix}]/boxes/{boxId}/files?path={path}`          | Uploads a tar stream into a box path.                   |
| `GET`    | `/api/v1[/{prefix}]/boxes/{boxId}/files?path={path}`          | Downloads a box path as a tar stream.                   |
| `GET`    | `/api/v1[/{prefix}]/boxes/{boxId}/metrics`                    | Returns metrics for one box without marking it active.  |
| `POST`   | `/api/v1[/{prefix}]/boxes/{boxId}/network/tunnel?port={port}` | Returns the runner tunnel URI for a guest TCP port.     |

The exec, signal, resize, files, and metrics handlers are registered as
catch-all reverse proxies to the box's assigned runner; the methods shown are
the portable contract, which the runner's own route registration enforces.

</details>

<details>
<summary><b>Volumes</b> · 4 routes</summary>

| Method   | Path                                                    | What it does                                  |
| -------- | ------------------------------------------------------- | --------------------------------------------- |
| `POST`   | `/api/v1[/{prefix}]/volumes`                            | Creates a volume and waits until it is ready. |
| `GET`    | `/api/v1[/{prefix}]/volumes`                            | Lists volumes in the organization.            |
| `GET`    | `/api/v1[/{prefix}]/volumes/{volumeId}`                 | Gets a volume by ID.                          |
| `DELETE` | `/api/v1[/{prefix}]/volumes/{volumeId}?force={boolean}` | Deletes a volume, optionally forcing removal. |

</details>

## Runner API

**Service:** `apps/runner` · **Base path:** `/` · **Port:** `3003` in
deployments (`API_PORT` environment variable; in-code default `8080`)

There is one runner daemon per EC2 instance. `GET /` and the development-only
Swagger UI are public; every other route requires the runner bearer token.
BoxLite is embedded in the runner, so these calls operate on the local BoxLite
runtime and its microVMs.

<details>
<summary><b>Health and introspection</b> · 4 routes</summary>

| Method | Path       | What it does                                          |
| ------ | ---------- | ----------------------------------------------------- |
| `GET`  | `/`        | Reports runner process health.                        |
| `GET`  | `/api/*`   | Serves the runner Swagger UI in development only.     |
| `GET`  | `/metrics` | Exposes Prometheus runner metrics.                    |
| `GET`  | `/info`    | Reports runner health, resource metrics, and version. |

</details>

<details>
<summary><b>Box lifecycle and toolbox</b> · 9 routes</summary>

| Method | Path                               | What it does                                                                                    |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST` | `/boxes`                           | Creates a box in the embedded BoxLite runtime.                                                  |
| `GET`  | `/boxes/{boxId}`                   | Gets local box information.                                                                     |
| `POST` | `/boxes/{boxId}/destroy`           | Destroys a local box.                                                                           |
| `POST` | `/boxes/{boxId}/start`             | Starts a local box.                                                                             |
| `POST` | `/boxes/{boxId}/stop`              | Stops a local box.                                                                              |
| `POST` | `/boxes/{boxId}/recover`           | Recovers a local box.                                                                           |
| `POST` | `/boxes/{boxId}/is-recoverable`    | Checks whether a local box can be recovered.                                                    |
| `POST` | `/boxes/{boxId}/network-settings`  | Changes a local box's network settings.                                                         |
| `ANY`  | `/boxes/{boxId}/toolbox/{path...}` | Serves the box web terminal (xterm.js page and WebSocket shell); other paths return `410 Gone`. |

</details>

<details>
<summary><b>Embedded BoxLite operations</b> · 10 routes</summary>

| Method    | Path                                           | What it does                                          |
| --------- | ---------------------------------------------- | ----------------------------------------------------- |
| `POST`    | `/v1/boxes/{boxId}/exec`                       | Starts a command inside the local box.                |
| `GET`     | `/v1/boxes/{boxId}/executions/{execId}`        | Gets local execution status.                          |
| `DELETE`  | `/v1/boxes/{boxId}/executions/{execId}`        | Kills a local execution.                              |
| `WS`      | `/v1/boxes/{boxId}/executions/{execId}/attach` | Attaches a WebSocket to local execution I/O.          |
| `POST`    | `/v1/boxes/{boxId}/executions/{execId}/signal` | Sends a signal to a local execution.                  |
| `POST`    | `/v1/boxes/{boxId}/executions/{execId}/resize` | Resizes a local execution's terminal.                 |
| `PUT`     | `/v1/boxes/{boxId}/files?path={path}`          | Uploads a tar stream into the local box.              |
| `GET`     | `/v1/boxes/{boxId}/files?path={path}`          | Downloads a local box path as a tar stream.           |
| `GET`     | `/v1/boxes/{boxId}/metrics`                    | Returns local box metrics.                            |
| `CONNECT` | `/v1/boxes/{boxId}/network/tunnel?port={port}` | Opens a raw bidirectional TCP tunnel to a guest port. |

</details>

The runner Swagger files contain historical routes that are no longer
registered by `server.go`; this catalog follows runtime registration.

## Preview proxy API

**Service:** `apps/proxy` · **Base host:** `proxy.<domain>` and
`<port>-<box>.proxy.<domain>` · **Port:** `4000` in deployments (`PROXY_PORT`
environment variable, required)

The proxy is host-routed: a host whose first label parses as `<port>-<box>`
selects the preview forwarding paths, and any other host serves the base-host
utility routes. The preview-warning acceptance route is handled before host
routing, so it works on every host.

<details>
<summary><b>Proxy routes</b> · 5 routes</summary>

| Method    | Host and path                                              | What it does                                                                                     |
| --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET`     | `proxy.<domain>/health`                                    | Reports proxy health and version.                                                                |
| `GET`     | `proxy.<domain>/callback`                                  | Completes the OIDC preview authentication flow.                                                  |
| `POST`    | `<any host>/accept-boxlite-preview-warning?redirect={url}` | Records preview-warning acceptance and redirects the browser.                                    |
| `ANY`     | `<port>-<box>.proxy.<domain>/{path...}`                    | Reverse-proxies HTTP and WebSocket traffic to the selected box port after preview access checks. |
| `CONNECT` | `<port>-<box>.proxy.<domain>`                              | Opens a bidirectional TCP tunnel through the runner; allowed for public boxes only.              |

</details>

## Telemetry collector API

**Service:** `apps/otel-collector` · **OTLP/HTTP port:** `4318` ·
**Health ports:** `13133` and `13132`

These VPC-internal interfaces receive box and host telemetry, resolve each box
token to its organization export configuration, and expose collector health.
Only the OTLP/HTTP receiver is enabled; OTLP gRPC is not configured.

<details>
<summary><b>Collector interfaces</b> · 6 interfaces</summary>

| Protocol         | Path or service         | What it does                                                 |
| ---------------- | ----------------------- | ------------------------------------------------------------ |
| `POST` OTLP/HTTP | `:4318/v1/traces`       | Ingests OTLP trace batches.                                  |
| `POST` OTLP/HTTP | `:4318/v1/metrics`      | Ingests OTLP metric batches.                                 |
| `POST` OTLP/HTTP | `:4318/v1/logs`         | Ingests OTLP log batches.                                    |
| `GET` HTTP       | `:13133/health/status`  | Reports aggregate and component health.                      |
| `GET` HTTP       | `:13133/health/config`  | Returns the health extension's component configuration view. |
| gRPC             | `:13132` health service | Serves gRPC health checks.                                   |

</details>

## Local development stack

**Service:** `apps/infra-local` · **Unified entry:** `http://localhost:28080` ·
**Ports:** fixed host ports, local only

`make up` in [`infra-local`](./infra-local/) starts the dependency services as
BoxLite boxes and the application processes on the host. Every listener below is
bound on the developer's machine; the host ports are fixed literals in
[`services.py`](./infra-local/compose/services.py) and
[`native.py`](./infra-local/compose/native.py), not deployment values. From
inside a box the same listeners are reachable as `host.boxlite.internal:<port>`.

<details>
<summary><b>Unified entry point</b> · 9 routes</summary>

| Method | Host and path                                | What it does                                                       |
| ------ | -------------------------------------------- | ------------------------------------------------------------------ |
| `ANY`  | `<digits>-<token>.localhost:28080/{path...}` | Forwards signed port-preview hosts to the preview proxy on `4000`. |
| `ANY`  | `localhost:28080/pgadmin/*`                  | Reverse-proxies the pgAdmin UI.                                    |
| `ANY`  | `localhost:28080/jaeger/*`                   | Reverse-proxies the Jaeger UI.                                     |
| `ANY`  | `localhost:28080/dex/*`                      | Reverse-proxies the Dex OIDC provider.                             |
| `ANY`  | `localhost:28080/minio/*`                    | Reverse-proxies the MinIO S3 API.                                  |
| `ANY`  | `localhost:28080/minio-console/*`            | Reverse-proxies the MinIO console UI.                              |
| `ANY`  | `localhost:28080/registry/*`                 | Reverse-proxies the Docker registry v2 API.                        |
| `ANY`  | `localhost:28080/registry-ui/*`              | Reverse-proxies the registry browser UI.                           |
| `ANY`  | `localhost:28080/`                           | Responds with a plain-text index of the routes above.              |

Caddy serves these over plain HTTP with `auto_https off`; host `28443` is
reserved for a future `tls internal` block. Its admin API is on host `12019`
(container `2019`), and `GET :12019/config/` is Caddy's own readiness probe —
each of the other services below carries one of its own.

</details>

<details>
<summary><b>Dependency services</b> · 10 services</summary>

| Service       | Host port to container port                           | Interface                                                                         |
| ------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `postgres`    | `25432` → `5432`                                      | PostgreSQL wire protocol; `postgresql://boxlite:boxlite@127.0.0.1:25432/boxlite`. |
| `redis`       | `26379` → `6379`                                      | Redis protocol, backing caches, the Socket.IO adapter, and proxy lookups.         |
| `minio`       | `29000` → `9000`, `29001` → `9001`                    | S3-compatible object storage API and console UI; probed at `/minio/health/live`.  |
| `minio-init`  | none                                                  | One-shot `minio/mc` job that creates the `boxlite` bucket; no listener.           |
| `registry`    | `25000` → `5000`                                      | Docker registry v2 API; probed at `/v2/`.                                         |
| `registry-ui` | `25052` → `80`                                        | Registry browser UI.                                                              |
| `dex`         | `25556` → `5556`                                      | OIDC provider served under the `/dex` issuer path.                                |
| `jaeger`      | `26686` → `16686`, `26687` → `4317`                   | Trace UI, plus an OTLP/gRPC receiver fed by the local collector.                  |
| `pgadmin`     | `25051` → `80`                                        | Postgres administration UI; probed at `/misc/ping`.                               |
| `otel`        | `24317` → `4317`, `24318` → `4318`, `23133` → `13133` | OTLP gRPC and HTTP receivers, plus a `health_check` extension at `/`.             |

The local collector is the upstream `otel/opentelemetry-collector` image with an
inline config, not the first-party build described in
[Telemetry collector API](#telemetry-collector-api): it enables OTLP gRPC as
well as HTTP, exports traces to the Jaeger box, and answers health at `/`
instead of `/health/status`.

This Dex box serves the inline `_DEX_CONFIG` from
[`services.py`](./infra-local/compose/services.py), written to
`/tmp/dex-config.yaml` at boot: one public static client, `boxlite`, whose
redirect URIs cover the dashboard, the Vite dev server, and the CLI loopback
callback at `http://127.0.0.1:5555/callback`, plus a password database holding
two static users. [`dex/config.yaml`](./dex/config.yaml) is a separate file for
a separate environment — see
[Container-based local environment](#container-based-local-environment).
`apps/infra` deploys no Dex service; deployed stacks point
`OIDC_ISSUER_BASE_URL` at a hosted provider and reach it through the same
`/.well-known/openid-configuration` discovery document.

</details>

<details>
<summary><b>Application processes</b> · 4 processes</summary>

| Process     | Host port | Interface                                                                  |
| ----------- | --------- | -------------------------------------------------------------------------- |
| `api`       | `3001`    | Control-plane and hosted BoxLite-compatible APIs; probed at `/api/health`. |
| `dashboard` | `3000`    | Vite dev server for the dashboard app.                                     |
| `proxy`     | `4000`    | Preview proxy API (`PROXY_PORT`).                                          |
| `runner`    | `3003`    | Runner API (`API_PORT`).                                                   |

The local API listens on `3001` rather than the deployed `3000`, which the
dashboard dev server uses; `BOXLITE_LOCAL_API_PORT` overrides it. This stack
starts no mail service and sets no `SMTP_HOST`.

</details>

## Container-based local environment

**Service:** `apps/scripts` · **Entry points:** `yarn dev:dex`, `yarn e2e:local`

A second local environment: [`local-dex-env.mjs`](./scripts/local-dex-env.mjs)
starts four Docker containers, then runs the same four application processes on
the host through the `serve-slim` target. It is the only environment here that
runs [`dex/config.yaml`](./dex/config.yaml), which it renders to
`.boxlite-home/dex/config.local.yaml` and mounts read-only into the Dex
container.

<details>
<summary><b>Containers</b> · 4 services</summary>

| Service    | Host port       | Interface                                                                                        |
| ---------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `dex`      | `5556`          | OIDC provider: `ghcr.io/dexidp/dex:v2.41.1` serving the rendered `dex/config.yaml`.              |
| `postgres` | `5432`          | PostgreSQL wire protocol: `postgres:16-alpine`, database `boxlite`.                              |
| `redis`    | `6379`          | Redis protocol: `redis:7-alpine`.                                                                |
| `registry` | `5001` → `5000` | Docker registry v2 API: `registry:2`, probed at `/v2/boxlite/{name}/manifests/{tag}` for images. |

</details>

<details>
<summary><b>Application processes</b> · 4 processes</summary>

| Process     | Host port | Interface                                                   |
| ----------- | --------- | ----------------------------------------------------------- |
| `api`       | `3001`    | Control-plane and hosted BoxLite-compatible APIs.           |
| `dashboard` | `3000`    | Vite dev server, kept on its own `/api` proxy path.         |
| `proxy`     | `4000`    | Preview proxy API.                                          |
| `runner`    | `8080`    | Runner API, left on the in-code default rather than `3003`. |

These are the same four projects the boxed stack serves, on the same `3000`,
`3001`, and `4000` host ports, so the two local environments cannot run at the
same time.

</details>

## Externally served APIs

These interfaces are called from this directory but served by systems outside
it, so no route table above owns them. The analytics and billing clients take
their base URL from `GET /api/config` and disable the corresponding UI when it
is unset; the same document carries PostHog's key and host to the browser.

<details>
<summary><b>External interfaces</b> · 2 APIs, 2 SaaS integrations</summary>

| Interface     | Client                                                                                 | Base URL source                  | What it covers                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Analytics API | [`libs/analytics-api-client`](./libs/analytics-api-client/), generated                 | `analyticsApiUrl`                | 8 routes: per-box and organization usage, aggregates, and charts, plus box logs, metrics, and traces.                                                        |
| Billing API   | [`billingApiClient.ts`](./dashboard/src/billing-api/billingApiClient.ts), hand-written | `billingApiUrl`                  | 20 routes: usage, wallet and top-ups, plans, invoices, coupons, billing emails, portal and checkout URLs.                                                    |
| PostHog       | `posthog-js` in the dashboard; `posthog-node` in the API                               | `posthog.apiKey`, `posthog.host` | Browser product analytics; server-side `api_*` operation events from the global metrics interceptor, two `groupIdentify` calls, and feature-flag evaluation. |
| Pylon         | [`App.tsx`](./dashboard/src/App.tsx) widget, production builds only                    | `pylonAppId`                     | Outbound support-chat widget; it registers no route here.                                                                                                    |

The analytics client is generated from
[`swagger.json`](./libs/analytics-api-client/swagger.json). Its four telemetry
routes duplicate the control plane's own [box telemetry](#control-plane-api)
routes, and the dashboard's box telemetry views call the analytics client only —
they disable themselves when `analyticsApiUrl` is unset rather than falling back.
Nothing in this directory registers the analytics or billing paths.

</details>

## Services without a first-party API

<details>
<summary><b>Non-API services and bundled tools</b> · 10 entries</summary>

| Service                     | Role                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard`            | Static browser application; it consumes the control-plane API and the [externally served APIs](#externally-served-apis), and registers no server API.                                                                                                                                                                                                                                    |
| `apps/dex`                  | Development-only configuration for the third-party Dex OIDC provider, plus a Dockerfile that bakes it into a `dex:v2.42.0` image nothing in this repository builds. The endpoints Dex serves are its own, not a BoxLite-owned API; the listener that does run this config is catalogued under [Container-based local environment](#container-based-local-environment), on `dex:v2.41.1`. |
| `apps/infra`                | Infrastructure-as-code and deployment tooling; it does not run an application API.                                                                                                                                                                                                                                                                                                       |
| `apps/infra-local`          | Local service orchestration; it registers no API of its own, but every listener it starts is catalogued under the [local development stack](#local-development-stack).                                                                                                                                                                                                                   |
| `apps/e2e`                  | End-to-end test client; it calls deployed APIs but does not expose one.                                                                                                                                                                                                                                                                                                                  |
| `apps/box-images`           | Image build inputs; they produce box images and do not run a service.                                                                                                                                                                                                                                                                                                                    |
| `apps/hack`, `apps/scripts` | Development and code-generation utilities; they register no API of their own, though `apps/scripts` starts the [container-based local environment](#container-based-local-environment).                                                                                                                                                                                                  |
| Jaeger                      | Bundled third-party trace ingestion and UI, not a BoxLite-owned API; deployed behind an internal load balancer on `80` for the UI (`16686`) and `4318` for OTLP/HTTP.                                                                                                                                                                                                                    |
| PgAdmin                     | Bundled third-party database administration UI; deployed behind an internal load balancer on `80`, reachable only from inside the VPC.                                                                                                                                                                                                                                                   |
| MailDev                     | Bundled third-party SMTP test service and UI in deployed environments, behind an internal load balancer on `80` (UI `1080`); not part of the local stack.                                                                                                                                                                                                                                |

MinIO, the registry UI, and Caddy are bundled only in the local development
stack, and a Docker registry appears in both local environments, so all of their
interfaces are listed under
[Local development stack](#local-development-stack) and
[Container-based local environment](#container-based-local-environment) rather
than here.

Libraries under `apps/libs` — generated API clients and shared Go packages —
are consumed by the services above; they are not services. A generated client
specification alone is therefore not treated as a live endpoint unless a
runtime application registers the route. Where a client has no in-repo server,
it is listed under [Externally served APIs](#externally-served-apis).

</details>

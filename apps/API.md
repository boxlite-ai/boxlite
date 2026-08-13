# BoxLite application API catalog

This catalog lists the interfaces registered by the applications in this
directory. It covers HTTP, WebSocket, CONNECT, OTLP, and health interfaces;
each entry names the owning service and what the interface does.

The inventory is implementation-grounded:

- Control-plane product routes come from the generated
  [`openapi.yaml`](./libs/api-client-go/api/openapi.yaml) and use the `/api`
  prefix applied in [`main.ts`](./api/src/main.ts).
- Hosted BoxLite-compatible routes come from the controllers in
  [`boxlite-rest`](./api/src/boxlite-rest/). They are excluded from the product
  OpenAPI document because their portable contract lives in
  [`openapi/box.openapi.yaml`](../openapi/box.openapi.yaml).
- Runner, proxy, and collector routes come from their runtime registration in
  [`server.go`](./runner/pkg/api/server.go),
  [`proxy.go`](./proxy/pkg/proxy/proxy.go), and
  [`config.yaml`](./otel-collector/config.yaml).

`openapi/box.openapi.yaml` also describes portable capabilities that the hosted
service does not currently register, including snapshots, clone, export,
import, images, and runtime-wide metrics. They are intentionally absent below;
`GET /api/v1/config` reports those optional capabilities as disabled.

## Control-plane API

**Service:** `apps/api` · **Base path:** `/api` · **Default port:** `3000`

This is the hosted product API used by the dashboard, SDKs, CLI, runners, and
internal services. Authentication and authorization vary by route; the health
and configuration discovery routes are public, while resource routes enforce
user, organization, runner, or admin credentials.

### Discovery and API keys

| Method   | Path                            | What it does                                                   |
| -------- | ------------------------------- | -------------------------------------------------------------- |
| `GET`    | `/api/config`                   | Returns browser/client configuration, including OIDC settings. |
| `GET`    | `/api/api-keys`                 | Lists API keys visible to the caller.                          |
| `POST`   | `/api/api-keys`                 | Creates an API key.                                            |
| `GET`    | `/api/api-keys/current`         | Returns details for the API key authenticating the request.    |
| `GET`    | `/api/api-keys/{name}`          | Gets an API key by name.                                       |
| `DELETE` | `/api/api-keys/{name}`          | Deletes the caller's API key by name.                          |
| `DELETE` | `/api/api-keys/{userId}/{name}` | Deletes a named API key belonging to a specified user.         |

### Users and authentication

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

### Organizations, membership, and invitations

| Method   | Path                                                                     | What it does                                             |
| -------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `GET`    | `/api/organizations`                                                     | Lists organizations available to the caller.             |
| `POST`   | `/api/organizations`                                                     | Creates an organization.                                 |
| `GET`    | `/api/organizations/{organizationId}`                                    | Gets an organization by ID.                              |
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

### Roles and regions

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

### Boxes and preview access

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

### Volumes and object storage

| Method   | Path                              | What it does                                       |
| -------- | --------------------------------- | -------------------------------------------------- |
| `GET`    | `/api/volumes`                    | Lists volumes visible to the caller.               |
| `POST`   | `/api/volumes`                    | Creates a volume.                                  |
| `GET`    | `/api/volumes/{volumeId}`         | Gets a volume by ID.                               |
| `DELETE` | `/api/volumes/{volumeId}`         | Deletes a volume.                                  |
| `GET`    | `/api/volumes/by-name/{name}`     | Gets a volume by name.                             |
| `GET`    | `/api/object-storage/push-access` | Returns temporary credentials for pushing objects. |

### Runners and jobs

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

### Administration

| Method   | Path                                 | What it does                                   |
| -------- | ------------------------------------ | ---------------------------------------------- |
| `GET`    | `/api/admin/runners`                 | Lists runners using admin authorization.       |
| `POST`   | `/api/admin/runners`                 | Registers a runner as an administrator.        |
| `GET`    | `/api/admin/runners/{id}`            | Gets a runner by ID as an administrator.       |
| `DELETE` | `/api/admin/runners/{id}`            | Deletes a runner as an administrator.          |
| `PATCH`  | `/api/admin/runners/{id}/scheduling` | Changes runner scheduling as an administrator. |
| `POST`   | `/api/admin/box/{boxId}/recover`     | Requests box recovery as an administrator.     |

### Webhooks, audit, telemetry, and health

| Method | Path                                                                         | What it does                                                             |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST` | `/api/webhooks/organizations/{organizationId}/app-portal-access`             | Creates access to the organization's Svix consumer portal.               |
| `POST` | `/api/webhooks/organizations/{organizationId}/send`                          | Sends a webhook event to the organization.                               |
| `GET`  | `/api/webhooks/organizations/{organizationId}/messages/{messageId}/attempts` | Lists delivery attempts for a webhook message.                           |
| `GET`  | `/api/webhooks/status`                                                       | Reports webhook service status.                                          |
| `GET`  | `/api/webhooks/organizations/{organizationId}/initialization-status`         | Reports whether organization webhooks are initialized.                   |
| `POST` | `/api/webhooks/organizations/{organizationId}/initialize`                    | Initializes webhooks for an organization.                                |
| `GET`  | `/api/audit`                                                                 | Lists audit records available to the caller.                             |
| `GET`  | `/api/audit/organizations/{organizationId}`                                  | Lists one organization's audit records.                                  |
| `GET`  | `/api/box/{boxId}/telemetry/logs`                                            | Queries logs for a box.                                                  |
| `GET`  | `/api/box/{boxId}/telemetry/traces`                                          | Queries traces for a box.                                                |
| `GET`  | `/api/box/{boxId}/telemetry/traces/{traceId}`                                | Gets spans for one trace.                                                |
| `GET`  | `/api/box/{boxId}/telemetry/metrics`                                         | Queries metrics for a box.                                               |
| `GET`  | `/api/organizations/otel-config/by-box-auth-token/{authToken}`               | Resolves a box token to its organization telemetry export configuration. |
| `GET`  | `/api/health`                                                                | Reports process liveness.                                                |
| `GET`  | `/api/health/ready`                                                          | Checks authenticated readiness, including Postgres and Redis.            |

### API documentation

| Method | Path        | What it does                                            |
| ------ | ----------- | ------------------------------------------------------- |
| `GET`  | `/api`      | Serves the interactive Swagger UI.                      |
| `GET`  | `/api-json` | Returns the generated product OpenAPI document as JSON. |
| `GET`  | `/api-yaml` | Returns the generated product OpenAPI document as YAML. |

### Realtime and asynchronous interfaces

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
| Kafka event              | `audit-logs` topic             | When the API worker and Kafka are enabled, consumes audit-log events and persists them, with bounded retries and dead-letter handling. |

## Hosted BoxLite-compatible API

**Service:** `apps/api` · **Base path:** `/api/v1` · **Default port:** `3000`

Most resource paths accept both an unprefixed form and an organization-prefixed
form. The tables write that as `[/{prefix}]`; clients can discover their prefix
through `GET /api/v1/me`. Except for configuration discovery, these routes use
the same combined bearer authentication and organization authorization as the
hosted control plane.

### Discovery

| Method | Path             | What it does                                                               |
| ------ | ---------------- | -------------------------------------------------------------------------- |
| `GET`  | `/api/v1/config` | Reports which optional portable API capabilities are enabled.              |
| `GET`  | `/api/v1/me`     | Returns the calling principal, path prefix, scopes, and credential expiry. |

### Box lifecycle

| Method   | Path                                     | What it does                                |
| -------- | ---------------------------------------- | ------------------------------------------- |
| `POST`   | `/api/v1[/{prefix}]/boxes`               | Creates a box and waits for it to start.    |
| `GET`    | `/api/v1[/{prefix}]/boxes`               | Lists boxes in the organization.            |
| `GET`    | `/api/v1[/{prefix}]/boxes/{boxId}`       | Gets a box by ID or name.                   |
| `HEAD`   | `/api/v1[/{prefix}]/boxes/{boxId}`       | Checks whether a box exists.                |
| `DELETE` | `/api/v1[/{prefix}]/boxes/{boxId}`       | Destroys a box.                             |
| `POST`   | `/api/v1[/{prefix}]/boxes/{boxId}/start` | Starts a box and waits until it is running. |
| `POST`   | `/api/v1[/{prefix}]/boxes/{boxId}/stop`  | Stops a box.                                |

### Execution, files, metrics, and networking

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

### Volumes

| Method   | Path                                                    | What it does                                  |
| -------- | ------------------------------------------------------- | --------------------------------------------- |
| `POST`   | `/api/v1[/{prefix}]/volumes`                            | Creates a volume and waits until it is ready. |
| `GET`    | `/api/v1[/{prefix}]/volumes`                            | Lists volumes in the organization.            |
| `GET`    | `/api/v1[/{prefix}]/volumes/{volumeId}`                 | Gets a volume by ID.                          |
| `DELETE` | `/api/v1[/{prefix}]/volumes/{volumeId}?force={boolean}` | Deletes a volume, optionally forcing removal. |

## Runner API

**Service:** `apps/runner` · **Base path:** `/` · **Default port:** `3003`

There is one runner daemon per EC2 instance. `GET /` and the development-only
Swagger UI are public; every other route requires the runner bearer token.
BoxLite is embedded in the runner, so these calls operate on the local BoxLite
runtime and its microVMs.

### Health and introspection

| Method | Path       | What it does                                        |
| ------ | ---------- | --------------------------------------------------- |
| `GET`  | `/`        | Reports runner process health.                      |
| `GET`  | `/api/*`   | Serves the runner Swagger UI in development only.   |
| `GET`  | `/metrics` | Exposes Prometheus runner metrics.                  |
| `GET`  | `/info`    | Returns runner identity, version, and capabilities. |

### Box lifecycle and toolbox

| Method | Path                               | What it does                                                  |
| ------ | ---------------------------------- | ------------------------------------------------------------- |
| `POST` | `/boxes`                           | Creates a box in the embedded BoxLite runtime.                |
| `GET`  | `/boxes/{boxId}`                   | Gets local box information.                                   |
| `POST` | `/boxes/{boxId}/destroy`           | Destroys a local box.                                         |
| `POST` | `/boxes/{boxId}/start`             | Starts a local box.                                           |
| `POST` | `/boxes/{boxId}/stop`              | Stops a local box.                                            |
| `POST` | `/boxes/{boxId}/recover`           | Recovers a local box.                                         |
| `POST` | `/boxes/{boxId}/is-recoverable`    | Checks whether a local box can be recovered.                  |
| `POST` | `/boxes/{boxId}/network-settings`  | Changes a local box's network settings.                       |
| `ANY`  | `/boxes/{boxId}/toolbox/{path...}` | Reverse-proxies HTTP or WebSocket traffic to the box toolbox. |

### Embedded BoxLite operations

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

The runner Swagger files contain historical routes that are no longer
registered by `server.go`; this catalog follows runtime registration.

## Preview proxy API

**Service:** `apps/proxy` · **Base host:** `proxy.<domain>` and
`<port>-<box>.proxy.<domain>` · **Default port:** `4000`

The proxy is host-routed. Base-host utility routes are listed first; valid
preview hosts route traffic to the matching box port on its runner.

| Method    | Host and path                                                  | What it does                                                                                     |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET`     | `proxy.<domain>/health`                                        | Reports proxy health and version.                                                                |
| `GET`     | `proxy.<domain>/callback`                                      | Completes the OIDC preview authentication flow.                                                  |
| `POST`    | `proxy.<domain>/accept-boxlite-preview-warning?redirect={url}` | Records preview-warning acceptance and redirects the browser.                                    |
| `ANY`     | `<port>-<box>.proxy.<domain>/{path...}`                        | Reverse-proxies HTTP and WebSocket traffic to the selected box port after preview access checks. |
| `CONNECT` | `<port>-<box>.proxy.<domain>`                                  | Authorizes the preview and opens a bidirectional TCP tunnel through the runner.                  |

## Telemetry collector API

**Service:** `apps/otel-collector` · **OTLP/HTTP port:** `4318` ·
**Health ports:** `13133` and `13132`

These VPC-internal interfaces receive box and host telemetry, resolve each box
token to its organization export configuration, and expose collector health.

| Protocol         | Path or service         | What it does                                                 |
| ---------------- | ----------------------- | ------------------------------------------------------------ |
| `POST` OTLP/HTTP | `:4318/v1/traces`       | Ingests OTLP trace batches.                                  |
| `POST` OTLP/HTTP | `:4318/v1/metrics`      | Ingests OTLP metric batches.                                 |
| `POST` OTLP/HTTP | `:4318/v1/logs`         | Ingests OTLP log batches.                                    |
| `GET` HTTP       | `:13133/health/status`  | Reports aggregate and component health.                      |
| `GET` HTTP       | `:13133/health/config`  | Returns the health extension's component configuration view. |
| gRPC             | `:13132` health service | Serves gRPC health checks.                                   |

## Services without a first-party API

| Service                     | Role                                                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard`            | Static browser application; it consumes the control-plane API and does not register a server API.                                                                                                     |
| `apps/dex`                  | Development configuration for the third-party Dex OIDC provider; Dex serves standard OIDC discovery, authorization, token, device-flow, and user-interface endpoints rather than a BoxLite-owned API. |
| `apps/infra`                | Infrastructure-as-code and deployment tooling; it does not run an application API.                                                                                                                    |
| `apps/infra-local`          | Local BoxLite-based service orchestration; it starts dependencies and application services but does not expose its own API.                                                                           |
| `apps/e2e`                  | End-to-end test client; it calls deployed APIs but does not expose one.                                                                                                                               |
| `apps/box-images`           | Image build inputs; they produce box images and do not run a service.                                                                                                                                 |
| `apps/hack`, `apps/scripts` | Development and code-generation utilities; they do not run application APIs.                                                                                                                          |
| Jaeger                      | Bundled third-party trace ingestion and UI, not a BoxLite-owned API.                                                                                                                                  |
| PgAdmin                     | Bundled third-party database administration UI, internal only.                                                                                                                                        |
| MailDev                     | Bundled third-party SMTP test service and UI, internal only.                                                                                                                                          |

Generated client libraries under `apps/libs` consume APIs; they are not
services. A generated client specification alone is therefore not treated as a
live endpoint unless a runtime application registers the route.

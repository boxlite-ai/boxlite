# BoxLite application API catalog

## Organization nested virtualization allowlist (RC)

System administrators control this Cloud creation rollout through the organization
allowlist. Runner captures `BOXLITE_EXPERIMENTAL` at startup and reports nesting
only when authorized and supported by the host. Local runtime and start behavior
retain main's contract.

| Current organization policy | Current Runner capability | New Box |
| --- | --- | --- |
| Disabled | Any | Ordinary; no capability request |
| Enabled | Confirmed true | Configure nested virtualization at creation |
| Enabled | False, missing, stale, invalid, failed or timed out | Ordinary |

`GET` and `PUT /api/admin/organizations/{organizationId}/nested-virtualization`
read or replace `{ "enabled": true }`. Both require a system administrator JWT
or Admin API key. Organization owners and ordinary organization keys cannot grant
permission. PUT requires a strict boolean and rejects unknown properties.
Unknown organizations return 404; audit records identify the target organization
and administrator. Other organization writers update only their owned fields.

At actual create dispatch, including UNKNOWN-state creation replay, the API reads
current uncached organization policy and checks the selected Runner under the
health deadline. Failed organization reads remain errors; capability discovery
failures choose an ordinary creation. Allowlisted creates bypass ordinary warm VMs.

V0 reads live `/info`; V2 reads the uncached authenticated heartbeat and requires
READY state with a report at most 60 seconds old. Runner rechecks authorization
and Linux KVM support before selecting new-box options. Guest privilege is independent.

The standard C/Go AdvancedBoxOptions setter configures the existing runtime
`advanced.nested_virtualization` option. Runtime create already persists BoxConfig;
no new persistence interface or Cloud Box column is added. Creation replay adopts
saved configuration without requesting a nesting upgrade; runtime's general reuse
compatibility rules remain unchanged.

Start takes no new options or nesting parameter. It uses the saved Box configuration
without querying organization policy. For example, enabling the organization does
not upgrade an existing ordinary Box on stop/start; disabling it does not downgrade
an existing nested Box. Future creates use the new policy. A previously nested Box
may fail to start if its assigned host later cannot provide the saved capability.

The C start ABI, Rust default start, Go Start(ctx), CLI and other SDKs retain their
original behavior. Recovery and migration gain no new nesting guarantee; archive
migration remains incomplete. Deploy organization and Runner capability migrations
before the compatible API and workers, then enable selected organizations.

## Interface inventory

This catalog lists the interfaces registered by the applications in this
directory. It covers HTTP, WebSocket, CONNECT, OTLP, health, static-asset, and
outbound event interfaces; each entry names the owning service and what the
interface does. Route tables are collapsed by default — expand a summary line
to see its routes.

The inventory is implementation-grounded:

- Control-plane product routes come from the controllers under
  [`api/src`](../../../../apps/api/src/), match the generated
  [`openapi.yaml`](../../../../apps/libs/api-client-go/api/openapi.yaml), and are
  listed by their public path under the [hosted base URL](#hosted-base-url).
- Hosted BoxLite-compatible routes come from the controllers in
  [`boxlite-rest`](../../../../apps/api/src/boxlite-rest/). They are excluded from the product
  OpenAPI document because their contracts live in [`openapi/box.openapi.yaml`](../../../../openapi/box.openapi.yaml)
  and, for cloud-only members and invitations, [`openapi/admin.openapi.yaml`](../../../../openapi/admin.openapi.yaml).
- The registry proxy's runner credential lookup is an internal service route.
  It is excluded from the Cloud OpenAPI document and generated customer clients;
  the proxy owns its request and response handling.
- Runner, proxy, and collector routes come from their runtime registration in
  [`server.go`](../../../../apps/runner/pkg/api/server.go),
  [`proxy.go`](../../../../apps/proxy/pkg/proxy/proxy.go), and
  [`config.yaml`](../../../../apps/otel-collector/config.yaml).
- Static asset trees come from the `ServeStaticModule` registrations in
  [`app.module.ts`](../../../../apps/api/src/app.module.ts).
- Outbound and asynchronous interfaces come from
  [`notification.gateway.ts`](../../../../apps/api/src/notification/gateways/notification.gateway.ts),
  [`webhook-events.constants.ts`](../../../../apps/api/src/webhook/constants/webhook-events.constants.ts),
  and [`kafka-exception.filter.ts`](../../../../apps/api/src/filters/kafka-exception.filter.ts).
- Local-stack listeners come from the service specs in
  [`services.py`](../../../../apps/infra-local/compose/services.py) and
  [`native.py`](../../../../apps/infra-local/compose/native.py); the container-based
  environment's come from
  [`local-dex-env.mjs`](../../../../apps/scripts/local-dex-env.mjs).

`openapi/box.openapi.yaml` also describes portable capabilities that the hosted
service does not currently register, including clone, binary archive import/export,
and runtime-wide metrics. `GET /v1/config` reports those archive capabilities as
disabled. Checkpoint capture and box creation from a checkpoint are a separate capability:
`checkpoints_enabled` requires both `CHECKPOINTS_ENABLED=true` and a configured
checkpoint archive prefix. Private tunnels are enabled; clients check that
capability before every private prepare.

## Services at a glance

| API                                                                       | Service                      | Base path or host                                                                    | Deployed port            |
| ------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| [Control-plane API](#control-plane-api)                                   | `apps/api`                   | `https://api.<domain>`                                                               | `3000`                   |
| [Hosted BoxLite-compatible API](#hosted-boxlite-compatible-api)           | `apps/api`                   | `https://api.<domain>/v1`                                                            | `3000`                   |
| [MCP endpoint](#mcp-endpoint)                                             | `apps/api`                   | `/mcp`                                                                               | `3000`                   |
| [Runner API](#runner-api)                                                 | `apps/runner`                | `/`                                                                                  | `3003`                   |
| [Preview proxy API](#preview-proxy-api)                                   | `apps/proxy`                 | `proxy.<domain>`, `<port>-<box>.proxy.<domain>`                                      | `4000`                   |
| [Registry proxy API](#registry-proxy-api)                                 | `apps/image-service`         | `/v2`                                                                                | `4100`                   |
| [Telemetry collector API](#telemetry-collector-api)                       | `apps/otel-collector`        | OTLP/HTTP and health listeners                                                       | `4318`, `13133`, `13132` |
| [Local development stack](#local-development-stack)                       | `apps/infra-local`           | `http://localhost:28080`                                                             | local host ports only    |
| [Container-based local environment](#container-based-local-environment)   | `apps/scripts`               | containers on `5556`, `5432`, `6379`, `5001`; apps on `3000`, `3001`, `4000`, `8080` | local host ports only    |
| [Externally served APIs](#externally-served-apis)                         | `apps/dashboard`, `apps/api` | discovered via `GET /config`                                                         | —                        |
| [Services without a first-party API](#services-without-a-first-party-api) | remaining apps               | —                                                                                    | —                        |

Ports are the values used in deployments. Service ports and the collector's
OTLP and HTTP health ports come from
[`settings.ts`](../../../../apps/infra/stack/settings.ts); the collector's gRPC health port
comes from its own [`config.yaml`](../../../../apps/otel-collector/config.yaml). Where an
in-code default differs, the section notes it.

## Hosted base URL

Call a hosted stage at its API host, with no path: `https://api.boxlite.ai` in
production and `https://api.dev.boxlite.ai` on dev. Every control-plane and
hosted BoxLite-compatible path in this catalog is relative to it, so listing
Boxes on dev is `GET https://api.dev.boxlite.ai/v1/boxes`. Bootstrap also names
a new stage's token audience (`OIDC_AUDIENCE`) by this host; dev and prod move
to it under [#2439](https://github.com/boxlite-ai/boxlite/issues/2439).

```
client   GET https://api.dev.boxlite.ai/v1/boxes
           │
balancer   adds /api/        (apiPrefixRouteRules)
           │
apps/api   GET /api/v1/boxes (setGlobalPrefix('api'))
```

The process mounts these routes under `/api`
([`main.ts`](../../../../apps/api/src/main.ts)), and the GCP load balancer, which
serves dev and prod, adds that prefix
([`apiPrefixRouteRules`](../../../../apps/infra/mdeploy/stack/providers/gcp/api.ts)).
Older clients that still send `/api/...` keep working, but new code and docs
use the host alone. The AWS stacks (`apps/infra/stack/` and the AWS provider
under `apps/infra/mdeploy/`) forward the host to the process unchanged, so a
stage they serve is called at `https://api.<domain>/api`. Local stacks have no
load balancer either: see [Local development stack](#local-development-stack).

## Admin organization metadata

These read-only views require system administrator authorization. Registration filters,
creator semantics and live pagination are documented in [the API README](../../../../apps/api/README.md#admin-organization-metadata).
Existing JWT organization reads and the Admin-key `by-box-id` lookup already return creation
fields; the existing admin routes now add cross-organization date filtering, coverage of
organizations without Boxes, and opt-in sections. Registration fields are always returned;
usage and activation are read only when explicitly included. Upgrade all producers before
enabling consumers of this contract.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/admin/organizations` | Lists registration metadata, counts and impact without usage reads; `include=memberEmails` adds up to 200 emails per organization. |
| `GET` | `/admin/organizations/{organizationId}` | Flat registration, member, Box and impact detail; `include=usage,activation` selects optional sections. |

The [removal-release notes](../../../../apps/api/README.md#retired-cloud-operations) list retired operations and their remaining alternatives.

## Control-plane API

**Service:** `apps/api` · **Base URL:** `https://api.<domain>` · **Port:** `3000` in
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
| `GET`    | `/config`                   | Returns browser/client configuration, including OIDC settings. |
| `GET`    | `/api-keys`                 | Lists API keys visible to the caller.                          |
| `POST`   | `/api-keys`                 | Creates an API key.                                            |
| `GET`    | `/api-keys/current`         | Returns details for the API key authenticating the request.    |
| `GET`    | `/api-keys/{name}`          | Gets an API key by name.                                       |
| `DELETE` | `/api-keys/{name}`          | Deletes the caller's API key by name.                          |
| `DELETE` | `/api-keys/{userId}/{name}` | Deletes a named API key belonging to a specified user.         |

Key creation takes an explicit `permissions` array. When authenticated with an API key,
the requested permissions must be a subset of that key's permissions, including for
owners and system admins; broader grants return 403 before a key is created.
The user's existing grantability checks still apply. An owner using a user JWT
can create a key with any supported permission.

Both DELETE routes require `write:members` when authenticated with an API key,
including owner/admin keys and revocation of the calling key itself. A
`read:members` key cannot revoke any key. User JWTs retain their existing access:
members can revoke their own keys; owners and admins can also revoke other users'
keys within the selected organization. The scope does not bypass these user or
organization boundaries.

</details>

<details>
<summary><b>Users and authentication</b> · 10 routes</summary>

| Method   | Path                                                     | What it does                                   |
| -------- | -------------------------------------------------------- | ---------------------------------------------- |
| `GET`    | `/users/me`                                          | Returns the authenticated user.                |
| `GET`    | `/users`                                             | Lists users.                                   |
| `POST`   | `/users`                                             | Creates a user.                                |
| `GET`    | `/users/{id}`                                        | Gets a user by ID.                             |
| `GET`    | `/users/account-providers`                           | Lists account providers available for linking. |
| `POST`   | `/users/linked-accounts`                             | Links an external account to the user.         |
| `DELETE` | `/users/linked-accounts/{provider}/{providerUserId}` | Unlinks an external account.                   |
| `GET`    | `/auth/end-session`                                  | Starts OIDC RP-initiated logout.               |
| `POST`   | `/auth/link/adopt`                                   | Moves a linked account's data for the Action.  |
| `GET`    | `/auth/link/status`                                  | Tells the Action whether BoxLite knows a user. |

</details>

<details>
<summary><b>Organizations, membership, and invitations</b> · 24 routes</summary>

| Method   | Path                                                                     | What it does                                             |
| -------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `GET`    | `/organizations`                                                     | Lists organizations available to the caller.             |
| `POST`   | `/organizations`                                                     | Creates an organization.                                 |
| `GET`    | `/organizations/{organizationId}`                                    | Gets an organization by ID.                              |
| `GET`    | `/organizations/{organizationId}/referral-code`                      | Gets or initializes the organization's invitation code.  |
| `GET`    | `/organizations/{organizationId}/concurrency`                        | Gets a bounded concurrency timeline from usage periods.  |
| `DELETE` | `/organizations/{organizationId}`                                    | Deletes an organization.                                 |
| `PATCH`  | `/organizations/{organizationId}/name`                               | Changes an organization's name.                          |
| `PATCH`  | `/organizations/{organizationId}/default-region`                     | Sets the organization's default region.                  |
| `POST`   | `/organizations/{organizationId}/leave`                              | Removes the caller and revokes their API keys here.      |
| `POST`   | `/organizations/{organizationId}/suspend`                            | Suspends the organization.                               |
| `POST`   | `/organizations/{organizationId}/unsuspend`                          | Restores a suspended organization.                       |
| `GET`    | `/organizations/by-box-id/{boxId}`                                   | Resolves the organization that owns a box.               |
| `POST`   | `/organizations/{organizationId}/box-default-limited-network-egress` | Changes the default limited-egress policy for new boxes. |
| `PUT`    | `/organizations/{organizationId}/experimental-config`                | Replaces the organization's experimental configuration.  |
| `GET`    | `/organizations/{organizationId}/users`                              | Lists organization members.                              |
| `POST`   | `/organizations/{organizationId}/users/{userId}/access`              | Changes access; refuses to demote a default-org creator. |
| `DELETE` | `/organizations/{organizationId}/users/{userId}`                     | Removes a member and revokes their API keys here.        |
| `GET`    | `/organizations/invitations`                                         | Lists invitations addressed to the caller.               |
| `GET`    | `/organizations/invitations/count`                                   | Counts invitations addressed to the caller.              |
| `POST`   | `/organizations/invitations/{invitationId}/accept`                   | Accepts an organization invitation.                      |
| `POST`   | `/organizations/invitations/{invitationId}/decline`                  | Declines an organization invitation.                     |
| `GET`    | `/organizations/{organizationId}/invitations`                        | Lists pending invitations, including expired ones.       |
| `POST`   | `/organizations/{organizationId}/invitations`                        | Creates an organization invitation.                      |
| `PUT`    | `/organizations/{organizationId}/invitations/{invitationId}`         | Changes a pending invitation.                            |
| `POST`   | `/organizations/{organizationId}/invitations/{invitationId}/cancel`  | Cancels a pending invitation, even after expiry.          |

</details>

<details>
<summary><b>Roles and regions</b> · 10 routes</summary>

| Method   | Path                                                 | What it does                                 |
| -------- | ---------------------------------------------------- | -------------------------------------------- |
| `GET`    | `/organizations/{organizationId}/roles`          | Lists organization roles.                    |
| `POST`   | `/organizations/{organizationId}/roles`          | Creates an organization role.                |
| `PUT`    | `/organizations/{organizationId}/roles/{roleId}` | Updates an organization role.                |
| `DELETE` | `/organizations/{organizationId}/roles/{roleId}` | Deletes an organization role.                |
| `POST`   | `/regions`                                       | Creates a region.                            |
| `GET`    | `/regions/{id}`                                  | Gets a region by ID.                         |
| `PATCH`  | `/regions/{id}`                                  | Updates a region's configuration.            |
| `DELETE` | `/regions/{id}`                                  | Deletes a region.                            |
| `POST`   | `/regions/{id}/regenerate-proxy-api-key`         | Regenerates the region proxy's API key.      |
| `GET`    | `/shared-regions`                                | Lists shared regions.                        |

</details>

<details>
<summary><b>Boxes and preview access</b> · 14 routes</summary>

| Method | Path                                                                    | What it does                                          |
| ------ | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET`  | `/box/paginated`                                                    | Lists boxes with pagination.                          |
| `GET`  | `/box/for-runner`                                                   | Lists boxes assigned to the authenticated runner.     |
| `GET`  | `/box/{boxIdOrName}`                                                | Gets a box by ID or name.                             |
| `POST` | `/box/{boxIdOrName}/recover`                                        | Requests recovery of a box in an error state.         |
| `PUT`  | `/box/{boxId}/state`                                                | Updates the control plane's recorded box state.       |
| `POST` | `/box/{boxId}/last-activity`                                        | Records the box's latest activity time.               |
| `POST` | `/box/{boxIdOrName}/attach-tickets`                                 | Issues a 30-second, single-use ticket for one `/v1` attach upgrade. |
| `GET`  | `/preview/{boxId}/inbound`                                          | Reports a box's inbound mode (`enabled` or `disabled`) to the proxy. |
| `GET`  | `/preview/{boxId}/tunnels/{port}`                                   | Checks an active public tunnel for the proxy.          |
| `POST` | `/preview/{boxId}/tunnels/{port}/access`                            | Proxy-only active tunnel policy, token verification and browser-user revalidation; returns no token verifier. |
| `GET`  | `/preview/{boxId}/tunnels/{port}/session`                            | Checks a user JWT and returns the tunnel grant and user ID for browser login. |
| `POST` | `/preview/tunnel-handoff`                                          | Proxy-only issue or single-use consumption of a 30-second browser login handoff. |
| `GET`  | `/preview/domains/{hostname}`                                       | Resolves a platform hostname to `{boxId, port}` for the proxy; `404` unless it may be forwarded now. |
| `POST` | `/preview/{boxId}/ensure-ready`                                     | Wakes a stopped box for the proxy, by auto-resume rules. |
| `GET`  | `/preview/{boxId}/access`                                           | Checks whether the caller may preview a box.          |

</details>

<details>
<summary><b>Volumes</b> · 4 routes</summary>

| Method   | Path                              | What it does                                       |
| -------- | --------------------------------- | -------------------------------------------------- |
| `GET`    | `/volumes`                    | Lists volumes visible to the caller.               |
| `POST`   | `/volumes`                    | Creates a volume.                                  |
| `GET`    | `/volumes/{volumeId}`         | Gets a volume by ID.                               |
| `DELETE` | `/volumes/{volumeId}`         | Deletes a volume.                                  |

</details>

<details>
<summary><b>Image catalog</b> · 6 routes</summary>

`upstreamMissingAt` records when a pull first found a version missing upstream.
`null` means no pull has recorded that observation; it does not confirm current
registry availability.

List and detail responses expose aliases only for READY versions, matching the
versions a box can resolve. Aliases of non-ready versions remain stored but are
omitted from those responses.

| Method   | Path                               | What it does                                                                                                                |
| -------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/images`                      | Lists the organization's images together with the operator's curated set.                                                   |
| `GET`    | `/images/usage`                | Counts held images against the limit and sums the sizes their versions declared.                                            |
| `GET`    | `/images/{idOrRef}`            | Gets an image, its versions with their aliases, last-use and upstream-missing timestamps, and the last 100 alias events. |
| `POST` | `/images/{idOrRef}/aliases` | Creates an alias for a ready version; existing names return 409, even for the same target. |
| `DELETE` | `/images/{idOrRef}/aliases/{alias}` | Deletes only the alias; versions and existing boxes remain. |
| `DELETE` | `/images/{idOrRef}`            | Removes the catalog entry, not the bytes, unless a box can still boot from it (409 lists the boxes).                        |

</details>

<details>
<summary><b>Registry credentials</b> · 4 routes</summary>

| Method   | Path                   | What it does                                                                          |
| -------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `GET`    | `/images/registries`      | Lists the organization's private registry logins, without passwords.                  |
| `POST`   | `/images/registries`      | Adds a login; the password is stored where the API cannot read it and never returned. |
| `PUT`    | `/images/registries/{id}` | Replaces username/password while preserving scope and dependent Boxes; requires `write:registries`. |
| `DELETE` | `/images/registries/{id}` | Removes a login, unless a box still pulls through it (409 lists the boxes).           |

Update requires both `username` and `password` (or token); host/prefix and other fields are rejected.
The response is the same password-free credential as creation; missing credentials in the authenticated organization return 404.
Concurrent mutations can return 409; retry after the other request finishes.

See [rotation ordering and recovery](../../../../apps/api/README.md#registry-credential-rotation) for secret retirement and cache limits.

</details>

<details>
<summary><b>Runners and jobs</b> · 16 routes</summary>

| Method   | Path                                   | What it does                                                   |
| -------- | -------------------------------------- | -------------------------------------------------------------- |
| `GET`    | `/runners`                         | Lists runners.                                                 |
| `POST`   | `/runners`                         | Registers a runner.                                            |
| `GET`    | `/runners/me`                      | Returns the authenticated runner's identity and configuration. |
| `POST`   | `/runners/me/cpu-incidents`         | Internal runner-only CPU incident ingestion; excluded from customer OpenAPI and SDKs. |
| `POST`   | `/runners/me/memory-incidents`      | Internal runner-only top-five memory snapshot ingestion; excluded from customer OpenAPI and SDKs. |
| `GET`    | `/runners/me/images/registry-credentials` | Internal registry-proxy lookup; excluded from customer OpenAPI and SDKs. |
| `GET`    | `/runners/by-box/{boxId}`          | Resolves the runner assigned to a box.                         |
| `GET`    | `/runners/{id}`                    | Gets a runner by ID.                                           |
| `GET`    | `/runners/{id}/full`               | Gets a runner with its full related data.                      |
| `DELETE` | `/runners/{id}`                    | Deletes a runner.                                              |
| `PATCH`  | `/runners/{id}/scheduling`         | Enables or disables scheduling onto a runner.                  |
| `PATCH`  | `/runners/{id}/draining`           | Enables or disables runner draining.                           |
| `POST`   | `/runners/healthcheck`             | Records or checks runner health; the optional `dataDiskRef` field refreshes the runner's data-disk identity (never cleared when omitted). |
| `GET`    | `/jobs`                            | Lists jobs assigned to the authenticated runner.               |
| `GET`    | `/jobs/poll`                       | Long-polls for work assigned to the runner.                    |
| `GET`    | `/jobs/{jobId}`                    | Gets a job by ID.                                              |
| `POST`   | `/jobs/{jobId}/status`             | Reports job progress, success, or failure.                     |

</details>

<details>
<summary><b>Administration</b> · 7 routes</summary>

| Method   | Path                                 | What it does                                   |
| -------- | ------------------------------------ | ---------------------------------------------- |
| `GET`    | `/admin/runner-cpu-incidents`      | Queries CPU incident evidence by capture completion time range for backoffice operations. |
| `GET`    | `/admin/runner-memory-incidents`   | Queries top-five memory snapshots by host sample time for backoffice operations. |
| `GET`    | `/admin/runners`                 | Lists runners using admin authorization.       |
| `POST`   | `/admin/runners`                 | Registers a runner as an administrator.        |
| `GET`    | `/admin/runners/{id}`            | Gets a runner by ID as an administrator.       |
| `DELETE` | `/admin/runners/{id}`            | Deletes a runner as an administrator.          |
| `PATCH`  | `/admin/runners/{id}/scheduling` | Changes runner scheduling as an administrator. |
| `POST`   | `/admin/box/{boxId}/recover`     | Requests box recovery as an administrator.     |

</details>

<details>
<summary><b>Webhooks and audit</b> · 8 routes</summary>

| Method | Path                                                                         | What it does                                               |
| ------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `POST` | `/webhooks/organizations/{organizationId}/app-portal-access`             | Creates access to the organization's Svix consumer portal. |
| `POST` | `/webhooks/organizations/{organizationId}/send`                          | Sends a webhook event to the organization.                 |
| `GET`  | `/webhooks/organizations/{organizationId}/messages/{messageId}/attempts` | Lists delivery attempts for a webhook message.             |
| `GET`  | `/webhooks/status`                                                       | Reports webhook service status.                            |
| `GET`  | `/webhooks/organizations/{organizationId}/initialization-status`         | Reports whether organization webhooks are initialized.     |
| `POST` | `/webhooks/organizations/{organizationId}/initialize`                    | Initializes webhooks for an organization.                  |
| `GET`  | `/audit`                                                                 | Lists audit records available to the caller.               |
| `GET`  | `/audit/organizations/{organizationId}`                                  | Lists one organization's audit records.                    |

</details>

<details>
<summary><b>Box telemetry configuration</b> · 1 route</summary>

| Method | Path                                                           | What it does                                                             |
| ------ | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET`  | `/organizations/otel-config/by-box-auth-token/{authToken}` | Resolves a box token to its organization telemetry export configuration. |

</details>

<details>
<summary><b>Health and API documentation</b> · 5 routes</summary>

| Method | Path                | What it does                                                  |
| ------ | ------------------- | ------------------------------------------------------------- |
| `GET`  | `/health`       | Reports process liveness.                                     |
| `GET`  | `/health/ready` | Checks authenticated readiness, including Postgres and Redis. |
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
[`app.module.ts`](../../../../apps/api/src/app.module.ts) and exclude `/api/{*path}`, so they
never shadow the routes above. The dashboard tree applies a content-addressed
cache policy from [`serve-static-cache.ts`](../../../../apps/api/src/serve-static-cache.ts):
hashed `/assets/*` files are `immutable` for a year, HTML is `no-cache`, and
everything else must revalidate.

The file that route resolves to is the runner binary
[`project.json`](../../../../apps/runner/project.json) builds at `dist/apps/runner-amd64`, so
the path serves something only in a full local build: the deployed image stages
just `dist/apps/api` and `dist/apps/dashboard`
([`Dockerfile`](../../../../apps/api/Dockerfile)). No in-repo client fetches it either — runners
take their binary from the artifact source resolved in
[`source.ts`](../../../../apps/infra/artifacts/source.ts), which defaults to a published
release fetched over HTTPS.

</details>

<details>
<summary><b>Realtime and asynchronous interfaces</b> · Socket.IO, 9 events, 4 webhook events, 2 Kafka topics</summary>

| Protocol                 | Path, topic, or event          | What it does                                                                                                                           |
| ------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Socket.IO over WebSocket | `/socket.io/`              | Authenticates a JWT or API key and joins the user room, plus the organization room for members only; removal ejects the member. |
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
[`openapi-webhooks.ts`](../../../../apps/api/src/openapi-webhooks.ts) adds to the generated
`openapi.3.1.0.json` only — not to the checked-in `openapi.yaml` named above.
The `template.*` values remain in the `WebhookEvent` enum but nothing emits
them.

</details>

## Experimental GitHub CI webhook

`POST /api/v1/ci/github/webhook` (Personal App) and
`POST /api/v1/ci/github/webhook/organization` (Organization App) use their respective
GitHub HMAC-SHA256 secrets to authenticate the raw
request body, not platform API-key authentication. Only supported, verified notifications
matching an established installation binding persist a wake hint. Success is 204;
invalid signatures are 401, conflicting delivery bodies 409, unsupported media/compression
415, bodies above 1 MiB 413, and unavailable persistence/capacity 503. See the
[ingress contract and recovery limitations](../../../../apps/api/README.md#github-ci-webhook-ingress-in-development).

## Experimental GitHub CI connect

Registered by `apps/api/src/ci/ci-connect.controller.ts`; excluded from generated
clients while the scheduler integration is in development. The same handlers are
also registered without `{prefix}`, using the authenticated organization.

| Method      | Path                                                               | Behavior                                                                                          |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `POST`      | `/api/v1/{prefix}/ci/connect`                                      | Starts GitHub device authorization for an installation binding.                                   |
| `POST`      | `/api/v1/{prefix}/ci/connect/{id}/poll`                            | Polls authorization and atomically establishes verified installation ownership.                   |
| `DELETE`    | `/api/v1/{prefix}/ci/connect/{id}`                                 | Cancels pending authorization; preserves an already completed binding.                            |
| `GET`       | `/api/v1/{prefix}/ci/connect/configuration`                        | Returns the public App installation link and browser-connect availability.                        |
| `POST`      | `/api/v1/{prefix}/ci/connect/web`                                  | Starts five-minute browser authorization with independent state and S256 PKCE.                    |
| `POST`      | `/api/v1/{prefix}/ci/connect/{id}/complete`                        | Validates original actor/state, claims one code exchange and uses the shared binding transaction. |
| `GET`       | `/api/v1/{prefix}/ci/connect/{id}`                                 | Resumes an authenticated browser grant without exchanging its code again.                         |
| `POST`      | `/api/v1/{prefix}/ci/connect/{id}/accounts`                        | Selects a verified owned account; connects or returns the matching CI App install URL.            |
| `GET`       | `/api/v1/{prefix}/ci/connect/{id}/accounts/{account}/repositories` | Reads one authorized installation repository page under the original active owned-account grant.  |
| `POST`      | `/api/v1/{prefix}/ci/connect/{id}/select`                          | Legacy installation selection under an authenticated browser grant; rechecks current ownership.   |
| `POST`      | `/api/v1/{prefix}/ci/connect/{id}/installation`                    | Verifies installation state, original target/App and current ownership before binding.            |
| `GET/PATCH` | `/api/v1/{prefix}/ci/settings`                                     | Reads/updates the account-wide CI maximum; null inherits Commerce and zero pauses new workers.    |

Every operation requires an organization owner or the explicit platform-admin exception;
API keys also need `write:boxes` and `delete:boxes`. A connected binding reports
its durable `listener_status`; authorization success can precede runner setup. See [API behavior and limits](../../../../apps/api/README.md#github-ci-installation-connect-in-development).

## Experimental GitHub CI management

Registered by `ci-management.controller.ts`; these routes also accept the
authenticated-organization form without `{prefix}` and are excluded from generated clients.

| Method   | Path                                                | Behavior                                                                                    |
| -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET`    | `/api/v1/{prefix}/ci/runners`                       | Lists original JIT Boxes with name filtering, pagination and organization-wide capacity.    |
| `PATCH`  | `/api/v1/{prefix}/ci/connections/{id}`              | Updates explicit Private-repository consent; installed Public repositories remain eligible. |
| `GET`    | `/api/v1/{prefix}/ci/connections/{id}/repositories` | Reads one authorized installation repository page under the original connected binding.     |
| `DELETE` | `/api/v1/{prefix}/ci/connections/{id}`              | Disables a connection while retaining original worker cleanup identities.                   |

Runner reads use existing organization Box access. Connection operations, including repository metadata reads, require the
current owner and both Box write/delete key scopes. Policy updates retain delivered
jobs; workers awaiting JIT may retire under the new policy. Connection deletion is
separate from cancelling a pending authorization attempt above. Repository reads
default to 25 entries and reject limits above 100. They recheck current ownership
and captured binding generation or grant validity after GitHub responds, before
returning Private metadata. Results include selection mode and the matching existing
GitHub installation settings URL. See
[management contracts](../../../../apps/api/README.md#hosted-ci-management).

## Hosted BoxLite-compatible API

**Service:** `apps/api` · **Base URL:** `https://api.<domain>/v1` · **Port:** `3000` in
deployments (shared with the control-plane API)

Most resource paths accept both an unprefixed form and an organization-prefixed
form. The tables write that as `[/{prefix}]`; clients can discover their prefix
through `GET /v1/me`. Except for configuration discovery, these routes use
combined bearer authentication, then organization authorization.

Image and registry management routes also consume the organization's authenticated
request quota, shared with `/images`, `/images/registries`, and other routes using
that quota. Canonical and prefixed SDK paths use the same counter. After the quota
is exhausted, requests return HTTP 429 with `Retry-After-authenticated` before
catalog changes or registry credential operations run; switching API surfaces
does not reset it.

Resource permissions are enforced per route. A box mutation — create, start,
stop, exec, signal, resize, execution kill, file transfer, WebSocket attach, an
attach ticket, and the network routes — requires `write:boxes`; deleting a box requires
`delete:boxes`. Box reads (list, get, head, execution status, metrics) carry no
permission and are reached by any member, because the model has no `read:boxes`.
Volume routes require `read:volumes`, `write:volumes`, or `delete:volumes` to
match, image routes `read:images`, `write:images`, or `delete:images`, and
registry login routes `read:registries`, `write:registries`, or
`delete:registries`. Attaching a managed volume while creating a box is authorized
independently of `write:boxes`: the caller must also hold `read:volumes` and
`write:volumes`, so a box-only credential cannot reach another's volume data
(GHSA-2qqv-7cwv-mj8h). A system admin and an interactive owner without an API key
are not permission-bounded; every API key is bounded by the permissions it
carries. The WebSocket `/attach` upgrade enforces `write:boxes` inline — an
upgrade never passes through the organization guard — using the same admin and
owner exemptions, so it resolves the caller's system role just as the HTTP path
does. A browser, which cannot set `Authorization` on a WebSocket, instead sends a
`?ticket=` bought from `POST /box/{boxIdOrName}/attach-tickets`. Spending it
re-checks the ticket's credential the same way:
the API key that bought it, which must still exist and be unexpired, or else
its user. The attach URL may omit `{prefix}`; the ticket already names the organization.
`GET /v1/me` can return `path_prefix: null` for an authenticated user with no
organization membership.

<details>
<summary><b>Discovery</b> · 2 routes</summary>

| Method | Path             | What it does                                                               |
| ------ | ---------------- | -------------------------------------------------------------------------- |
| `GET`  | `/v1/config` | Reports which optional portable API capabilities are enabled.              |
| `GET`  | `/v1/me`     | Returns the calling principal, path prefix, scopes, and credential expiry. |

</details>

<details>
<summary><b>Box lifecycle</b> · 7 routes</summary>

| Method   | Path                                     | What it does                                |
| -------- | ---------------------------------------- | ------------------------------------------- |
| `POST`   | `/v1[/{prefix}]/boxes`               | Creates a box and waits for it to start.    |
| `GET`    | `/v1[/{prefix}]/boxes`               | Lists boxes in the organization.            |
| `GET`    | `/v1[/{prefix}]/boxes/{boxId}`       | Gets a box by ID or name.                   |
| `HEAD`   | `/v1[/{prefix}]/boxes/{boxId}`       | Checks whether a box exists.                |
| `DELETE` | `/v1[/{prefix}]/boxes/{boxId}`       | Destroys a box.                             |
| `POST`   | `/v1[/{prefix}]/boxes/{boxId}/start` | Starts a box and waits until it is running. |
| `POST`   | `/v1[/{prefix}]/boxes/{boxId}/stop`  | Stops a box.                                |

</details>

<details>
<summary><b>Checkpoints</b> · 5 routes</summary>

| Method | Path | What it does |
| ------ | ---- | ------------ |
| `POST` | `/v1[/{prefix}]/checkpoints` | Captures an independent disk archive from `source_box_id`, with an optional `name`; returns `201`. |
| `GET` | `/v1[/{prefix}]/checkpoints` | Lists organization checkpoints; accepts `pageToken` or `page_token`, and returns `next_page_token`. |
| `GET` | `/v1[/{prefix}]/checkpoints/{key}` | Gets checkpoint metadata by ID or name, including state and optional `error_reason`. |
| `DELETE` | `/v1[/{prefix}]/checkpoints/{key}` | Deletes an unused checkpoint; `force=true` tolerates an already absent checkpoint, but active capture/use returns `409`; returns `204`. |
| `POST` | `/v1[/{prefix}]/boxes` | With `checkpoint_id`, creates a Box from a checkpoint; returns `201`. |

Ordinary Box creation takes the checkpoint: `{"checkpoint_id":"base","name":"child"}`
creates a Box that inherits the saved settings. `checkpoint_id` excludes `image` and
`rootfs_path`, and any field other than `name` returns `400`. There is no
`/boxes/import` route on the hosted service and no way to replace an existing Box
from a checkpoint.

Capture requires a stopped, idle source; callers stop the Box and wait for
`stopped` first. Other states return `409`; capture never automatically stops a Box.
The runner checks again under its source-operation lock before native export.

Capture, creation from a checkpoint, and deletion require `write:boxes`; reads require
organization membership. Turning off checkpoint admission leaves reads, deletion, and
already accepted work available. Creation waits for the Box to start; a failure after
admission includes `boxId`, which clients query before considering another create.
See [checkpoint capture and use](../../../../apps/api/README.md#checkpoint-capture)
for storage and lifecycle details.

</details>

<details>
<summary><b>Execution, files, metrics, networking, and SSH</b> · 16 routes</summary>

| Method   | Path                                                          | What it does                                            |
| -------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| `POST`   | `/v1[/{prefix}]/boxes/{boxId}/exec`                       | Starts a command execution through the assigned runner. |
| `GET`    | `/v1[/{prefix}]/boxes/{boxId}/executions`                 | Lists live guest executions, including the main session, without resuming the box or recording activity. |
| `GET`    | `/v1[/{prefix}]/boxes/{boxId}/executions/{execId}`        | Gets execution status and exit information.             |
| `DELETE` | `/v1[/{prefix}]/boxes/{boxId}/executions/{execId}`        | Kills an execution.                                     |
| `WS`     | `/v1[/{prefix}]/boxes/{boxId}/executions/{execId}/attach` | Attaches a bidirectional WebSocket to an execution; a browser authenticates with `?ticket=`. |
| `POST`   | `/v1[/{prefix}]/boxes/{boxId}/executions/{execId}/signal` | Sends a signal to an execution.                         |
| `POST`   | `/v1[/{prefix}]/boxes/{boxId}/executions/{execId}/resize` | Resizes an execution's terminal.                        |
| `PUT`    | `/v1[/{prefix}]/boxes/{boxId}/files?path={path}`          | Uploads a tar stream into a box path.                   |
| `GET`    | `/v1[/{prefix}]/boxes/{boxId}/files?path={path}`          | Downloads a box path as a tar stream.                   |
| `GET`    | `/v1[/{prefix}]/boxes/{boxId}/metrics`                    | Returns metrics for one box without marking it active.  |
| `POST`   | `/v1[/{prefix}]/boxes/{boxId}/network/tunnel?port={port}` | Prepares a tunnel with optional `isPublic` (default true); returns `uri`, `isPublic`, `token`. Private tokens are complete once, then masked. |
| `DELETE` | `/v1[/{prefix}]/boxes/{boxId}/network/tunnel?port={port}` | Revokes either access mode; `204`, idempotent. |
| `GET`    | `/v1[/{prefix}]/domains`                                  | Lists full hostnames, URLs, typed targets and the organization's allowance; no short `name` field. |
| `PUT`    | `/v1[/{prefix}]/domains/{domain}/target`                  | Routes an owned full hostname to a box port using `{"type":"box","box":"<id-or-name>","port":3000}`; replaces any existing binding without declaring the port public. |
| `DELETE` | `/v1[/{prefix}]/domains/{domain}/target`                  | Requires the full held hostname; stops routing it and keeps ownership; `204`, idempotent. |
| `PUT`    | `/v1[/{prefix}]/boxes/{boxId}/network/inbound`            | Enables or disables a box's inbound access.             |
| `POST`   | `/v1[/{prefix}]/boxes/{boxId}/ssh`                        | Replaces guest SSH configuration once; counts as activity and may auto-resume a box. |
| `POST`   | `/v1[/{prefix}]/boxes/{boxId}/ssh/enable`                 | Enables saved SSH configuration on a running box; no auto-resume or activity. |
| `GET`    | `/v1[/{prefix}]/boxes/{boxId}/ssh`                        | Reads guest SSH status without resuming the box or counting as activity. |
| `DELETE` | `/v1[/{prefix}]/boxes/{boxId}/ssh`                        | Disables guest SSH on a running box; otherwise `409`. No auto-resume or activity. |

Execution inventory is an organization-member read, like execution status; it
does not require `write:boxes`. Box lookup remains scoped to that organization.
The response is `{ "executions": [...] }`, with `execution_id`, `argv`,
`started_at` (Unix milliseconds), `tty`, and `is_main_session` on each entry.
Use the returned guest ID with the status, attach, signal, resize, and kill
routes, including for the main session; terminating main can stop the box.
Listing a stopped box returns an empty inventory and never starts it.

The exec, signal, resize, files, and metrics handlers are registered as
catch-all reverse proxies to the box's assigned runner; the methods shown are
the portable contract, which the runner's own route registration enforces.

SSH configuration uses the reported lifecycle state for admission: a stored
`stopped` or `unknown` state with desired state `started` is treated as `starting`
or `creating`, respectively. With auto-resume enabled, configuration waits for
that start, including for boxes with an explicit `cmd` or `entrypoint`. Before
submitting a new start, the API rechecks SSH startup restrictions against the
current box state under its lifecycle lock. The API waits for readiness before
forwarding configuration; the runner checks that the box is running and returns
`409 invalid_state` if that check fails.

</details>

<details>
<summary><b>Volumes</b> · 4 routes</summary>

| Method   | Path                                                    | What it does                                  |
| -------- | ------------------------------------------------------- | --------------------------------------------- |
| `POST`   | `/v1[/{prefix}]/volumes`                            | Creates a volume and waits until it is ready. |
| `GET`    | `/v1[/{prefix}]/volumes`                            | Lists volumes in the organization.            |
| `GET`    | `/v1[/{prefix}]/volumes/{volumeId}`                 | Gets a volume by ID.                          |
| `DELETE` | `/v1[/{prefix}]/volumes/{volumeId}?force={boolean}` | Deletes a volume, optionally forcing removal. |

</details>

<details>
<summary><b>Images</b> · 6 routes</summary>

| Method   | Path                                          | What it does                                                                                           |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET`    | `/v1[/{prefix}]/images`                   | Lists one row per reference the organization can boot from; curated images are left out.               |
| `GET`    | `/v1[/{prefix}]/images/usage`             | Counts held images against the limit and sums the sizes their versions declared.                       |
| `GET`    | `/v1[/{prefix}]/images/{name}`            | Gets an image: its versions with their aliases, last use and upstream state, and the last 100 alias events. |
| `POST` | `/v1[/{prefix}]/images/{name}/aliases` | Creates an alias from `alias` and `digest`; existing names return `already_exists`. |
| `DELETE` | `/v1[/{prefix}]/images/{name}/aliases/{alias}` | Removes only the alias; needs `write:images`. |
| `DELETE` | `/v1[/{prefix}]/images/{name}`            | Removes the catalog entry, not the bytes, unless a box can still boot from it.                         |

The same catalog as `/images`, in the box API's snake_case shapes and with
versions named by digest, for SDK clients.

</details>

<details>
<summary><b>Registries</b> · 3 routes</summary>

| Method   | Path                                 | What it does                                                                     |
| -------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `GET`    | `/v1[/{prefix}]/images/registries`      | Lists the organization's private registry logins, without passwords.             |
| `POST`   | `/v1[/{prefix}]/images/registries`      | Adds a login; a second one for the same registry and prefix is `already_exists`. |
| `DELETE` | `/v1[/{prefix}]/images/registries/{id}` | Removes a login, unless a box still pulls through it (409 lists the boxes).      |

The same logins as `/images/registries`, in the box API's snake_case shapes, for
SDK clients.

Credential deletion and private-image box persistence coordinate in PostgreSQL.
If they overlap, the contending request returns 409 and can be retried. A box
whose resolved proxy reference has lost its credential is also rejected before
it is saved. Once a dependent box commits, deletion returns 409 with its ID.
The dependency check reads candidate credentials once for the organization and
registry host, then matches each box in memory using the longest repository prefix.

</details>

<details>
<summary><b>Members and invitations</b> · 5 routes</summary>

Contract: [`openapi/admin.openapi.yaml`](../../../../openapi/admin.openapi.yaml). This cloud-only
Admin API manages an organization's users and invitations. Ordinary scoped API keys
and user JWTs can call it; a platform administrator account is not required.
Dedicated Admin SDK methods are not yet available. Existing Cloud API SDK methods
continue to manage organizations and invitations.

| Method | Path | Required API-key scope | Membership rule |
| --- | --- | --- | --- |
| `GET` | `/v1/organizations/users` | `read:members` | Member |
| `DELETE` | `/v1/organizations/users/{user_id}` | `write:members` | Owner |
| `GET` | `/v1/organizations/invites` | `read:members` | Member |
| `POST` | `/v1/organizations/invites` | `write:members` | Owner |
| `DELETE` | `/v1/organizations/invites/{invite_id}` | `write:members` | Owner |

The key selects its organization. JWT callers select an organization with
`X-BoxLite-Organization-ID`, or use their default organization. Read and write
scopes are independent; owner and platform-admin keys still need the declared
scope. For example, create a restricted key through the Cloud API/SDK with
`{"name":"member-reader","permissions":["read:members"]}`. It can list users and
invites but cannot invite users or delegate a key with `write:members`.
Console owner-created keys default to both member scopes.

The unmerged Tenant routes and scope names are replaced directly. Previously
stored tenant grants migrate to the equivalent member grants; keys without those
grants do not gain them. Removing a user revokes their organization keys. The last
owner and a user's personal/default organization membership remain protected.

Both lists accept `pageSize` (1–1000, default 100) and `pageToken`. Responses contain
`users` or `invites`, plus `next_page_token` when more records exist. Treat tokens
as opaque and return them unchanged; they are bound to the organization and
resource and never grant access. Lists use ascending resource IDs.

Users have `type: "user"`, `id` (the same as `/v1/me`'s `sub`), `email`, `name`,
`role`, and `added_at`. Email is `null` when absent or the user record is unavailable.
Invites have `type: "invite"`, `id`, `email`, `role`, `status`, `added_at`, and
`expires_at`. Lists include every state; pending invitations past their deadline
appear as `expired`. Expired pending invitations can be cancelled but not accepted.

Create an invitation with `{"email":"teammate@example.com","role":"owner"}`.
The role is required and currently only `owner` is accepted. Optional `expires_at`
must be in the future on initial creation; omission uses
`ORGANIZATION_INVITATION_TTL_SECONDS`, default seven days. Unknown request fields
are rejected. Clients should tolerate additional response fields.

An optional UUID `Idempotency-Key` makes create-invite retries return the original
201 response for 24 hours, scoped to the organization and acting user. A different
payload with the same key returns 422; a concurrent in-progress request returns
409 and may be retried. Replay works after cancellation or expiry and does not
send another email. This guarantee applies to create-invite only; it does not
change Box `/v1/config` capabilities. The email event is not a transactional outbox:
a process crash after commit can still lose notification delivery.

Admin errors use the shared Box shape, for example
`{"error":{"message":"Forbidden resource","type":"AuthError","code":"permission_denied"}}`.
All operations may return 429; respect `Retry-After` when present. Console Cloud
API errors retain their existing flat shape.

Invitees accept through the JWT-only Console endpoint
`/organizations/invitations/{invitationId}/accept`. Acceptance requires the
invited email and does not require member scopes or prior membership. Email links
resolve `/dashboard/user/invitations` against `DASHBOARD_URL` and accept after
sign-in. See [invitation link lifetime](../../../../apps/infra/docs/configuration.md#invitation-link-lifetime).

</details>

### Runner CPU incidents

Backoffice uses `GET /admin/runner-cpu-incidents` with an administrator API key
or JWT. Ordinary users and runner credentials receive 403; absent/invalid credentials
receive 401. Responses use `Cache-Control: private, no-store`.

| Query | Contract |
| --- | --- |
| `from` | Required RFC 3339 timestamp with timezone, at most milliseconds. Inclusive lower bound on `windowEndedAt`. |
| `to` | Required RFC 3339 timestamp with timezone, at most milliseconds. Exclusive upper bound on `windowEndedAt`; must be after `from`. |
| `limit` | Integer 1–200; default 50. First N rows in ID ascending order after per-Box maximum selection. |
| `runnerId` | Optional UUID filter. |

```bash
curl --get "https://api.<domain>/admin/runner-cpu-incidents" \
  --header "Authorization: Bearer $BOXLITE_ADMIN_API_KEY" \
  --data-urlencode "from=2026-10-29T00:00:00Z" \
  --data-urlencode "to=2026-10-30T00:00:00Z" \
  --data-urlencode "limit=100"
```

```json
{
  "items": [
    {
      "id": "42",
      "runnerId": "11111111-1111-4111-8111-111111111111",
      "eventId": "22222222-2222-4222-8222-222222222222",
      "highCpuSince": "2026-10-29T00:00:00.000Z",
      "windowStartedAt": "2026-10-29T00:05:00.000Z",
      "windowEndedAt": "2026-10-29T00:07:00.000Z",
      "runnerCpuPercent": 85,
      "boxId": "example-box",
      "image": "ubuntu:24.04",
      "cpuSeconds": 240,
      "samplingComplete": true,
      "receivedAt": "2026-10-29T00:12:01.000Z"
    }
  ]
}
```

Ranking queries have a five-second database statement timeout, including lock
waits. A timeout fails the request without partial results. Valid time ranges
remain unrestricted; a timed-out query can be retried with a narrower range.
The setting is transaction-local and does not affect ingestion or pooled sessions.

The range is `[from,to)` on capture completion time, not high-load start or server
receipt time. Adjacent ranges therefore do not share boundary rows. After the time
and optional Runner filters, each non-null `boxId` appears once, using the row
with the largest `cpuSeconds`; equal values retain the smaller numeric row ID.
Without a Runner filter, the same Box is deduplicated across Runners. All fields,
including the image and capture timestamps, come from that winning row.
Rows with `boxId=null` remain separate observations. Only after this selection are
results ordered by ID ascending and capped at `limit`; additional selected rows
are not returned. There is no pagination. An empty result is `{"items":[]}`. IDs remain
decimal strings to preserve bigint precision; ID order need not match completion
or commit order. Upload retries can add records to older ranges. Repeating a query
still returns only the first N selected rows; this endpoint is a per-Box maximum
view, not a complete incident history. Consumers must recheck the box's
current state before operations: evidence persists after migration or deletion.
`cpuSeconds / window duration in seconds * 100` gives average box CPU percent
on a one-core scale, which can exceed 100%. `samplingComplete=false` means the
ranking uses incomplete measurements; `boxId=null` means no positive CPU delta
was measurable. `image` is the winner's exact `BoxInfo.Image` string from its last
successful counter sample in the window, retained even if that box subsequently
exits. No winner or an older report without image produces `image=null`; an empty
string is preserved. This is the supplied image reference, not a resolved digest.
There is no acknowledgement or automatic box operation.

Runner ingestion is `POST /runners/me/cpu-incidents`, authenticated by the
runner's existing token. Its body is the example row without `id`, `runnerId`
and `receivedAt`. Valid first uploads and retries return 204. The API derives
`runnerId` from credentials, requires more than 80% CPU and at least five minutes
between `highCpuSince` and `windowStartedAt`, validates the capture and counters, and ignores
duplicate event IDs from the same runner. Malformed bodies/queries return 400.
The optional `image` accepts a string or null; it must be absent/null when `boxId`
is null. It travels in this same report without another runner API query.
This internal route is excluded from customer OpenAPI and generated SDKs;
the admin route is described by Nest Swagger.

Deploy the pre-deploy migration, then the API, then runners. See the
[runner monitoring contract](../../../../apps/runner/README.md#sustained-cpu-incidents) for sampling,
retry and restart limitations and [the table schema](schema.md#runner_cpu_incident)
for persistence guarantees.

### Runner memory incidents

Each minute, a host memory reading strictly above 80% triggers an immediate scan
of running Boxes. The Runner reports the five largest readable memory usages,
or fewer when fewer are available. There is no five-minute qualification or
two-minute capture window. CPU incidents retain their existing policy.

`POST /runners/me/memory-incidents` uses the Runner token and returns 204
for first ingestion and retries. The server derives `runnerId` from credentials;
duplicate `(runnerId,eventId)` reports leave the first snapshot unchanged.
The route is internal and excluded from customer OpenAPI and SDKs.

```json
{
  "eventId": "22222222-2222-4222-8222-222222222222",
  "sampledAt": "2026-11-05T00:01:00.000Z",
  "runnerMemoryPercent": 87.5,
  "boxes": [
    { "boxId": "box-a", "image": "ubuntu:24.04", "memoryBytes": "4294967296" },
    { "boxId": "box-b", "image": "python:3.13", "memoryBytes": "3221225472" }
  ],
  "samplingComplete": true
}
```

`boxes` is required and has at most five distinct business Box IDs, ordered by
bytes descending and then ID ascending. Each item requires a string `image`
(empty is preserved) and canonical decimal-string `memoryBytes` between zero
and 9223372036854775807. JSON numbers are rejected to prevent precision loss.
An empty array means no Box could be measured or no Boxes were running.
`samplingComplete=false` means enumeration or at least one reading failed;
the reported ranking then covers only successful observations. Unknown fields,
invalid nested items, duplicate IDs, incorrect ordering, invalid dates, and host
percentages outside `(80,100]` return 400.

Administrators query `GET /admin/runner-memory-incidents` using an admin API
key or JWT. Ordinary users and Runner credentials receive 403; missing or invalid
credentials receive 401. Responses use `Cache-Control: private, no-store`.

| Query | Contract |
| --- | --- |
| `from` | Required timezone-qualified timestamp, inclusive lower bound on `sampledAt`. |
| `to` | Required timezone-qualified timestamp, exclusive upper bound on `sampledAt`; after `from`. |
| `runnerId` | Optional UUID filter. |
| `limit` | Integer 1–200, default 50; first N snapshots in ID ascending order after per-Box maximum selection. |

Timestamps accept at most millisecond precision. Results are `{"items":[...]}`;
each item adds decimal-string `id`, authenticated `runnerId`, and server
`receivedAt` to the snapshot above. Across the full time range and optional Runner
filter, each `boxId` appears only in the snapshot containing its largest
`memoryBytes`, compared as an exact integer. Equal values retain the smaller
numeric snapshot ID. Without a Runner filter, deduplication spans Runners.
Each returned `boxes` array contains only the winning entries from that snapshot,
in their original order, with their original images and snapshot metadata.
Snapshots losing all entries are omitted; originally empty snapshots remain.
Then snapshots are ordered by ID and capped at `limit`. The limit counts snapshots,
not individual Boxes; one snapshot can still contain up to five Boxes.
Stored reports remain intact. Empty results are `{"items":[]}`.
As with CPU queries, ranking has a five-second transaction-local database statement
timeout, including lock waits. A timeout fails without partial results; retry with
a narrower range if necessary. Ingestion and other pooled queries are unaffected.
There is no pagination; repeated queries with the same limit do not enumerate
additional rows. Late retries retain their original `sampledAt`, so historical
ranges can gain records. Box deletion does not remove evidence.

Deploy the [pre-deploy table migration](schema.md#runner_memory_incident), then
the API, then Runners. See the [sampling and retry contract](../../../../apps/runner/README.md#memory-incident-snapshots)
for accounting scope and delivery limitations.

## MCP endpoint

**Service:** `apps/api` · **Path:** `/mcp` · **Port:** `3000` in deployments
(shared with the control-plane API)

The endpoint and its OAuth metadata sit outside the `api` global prefix
([`MCP_ROOT_ROUTES`](../../../../apps/api/src/mcp/mcp-auth-metadata.ts)), so the URL a client
connects to is also the OAuth resource that RFC 9728 discovery checks. The GCP URL
map passes both paths through unchanged, and `/api/mcp` is not served.

A Model Context Protocol server, served from [`mcp`](../../../../apps/api/src/mcp/) over
Streamable HTTP. It speaks both protocol eras on one endpoint: the 2025
`initialize` handshake, served statelessly, and the session-less 2026-07-28
revision. Every POST is answered with one JSON body; `subscriptions/listen` is
refused with `-32601`. A request that carries an `Origin` header is refused with
`403`, because MCP hosts call from servers and CLIs, not browsers.

```
claude mcp add --transport http boxlite https://<api-host>/mcp \
  --header "Authorization: Bearer $BOXLITE_API_KEY"
```

On a stage with `MCP_RESOURCE_URL` set and its tenant configured
([MCP client sign-in](../../../../apps/infra/docs/identity-and-mail.md#mcp-client-sign-in)), leave
out `--header`: the client opens a browser sign-in instead.

**Credentials.** A user API key, or an OAuth token whose audience is
`MCP_RESOURCE_URL`. Dashboard tokens are refused, as are the API keys of machine
principals (proxy, runner, collectors); without `MCP_RESOURCE_URL` every OAuth token
is refused. A `401` carries
`WWW-Authenticate: Bearer resource_metadata=...` naming the RFC 9728 document at
`/.well-known/oauth-protected-resource/mcp`, which lists the API's OIDC issuer
as the authorization server; it is published only when `MCP_RESOURCE_URL` is set,
and otherwise answers 404 (no `/.well-known/` path falls back to the dashboard page).

**OAuth callers.** [`McpAuthGuard`](../../../../apps/api/src/mcp/mcp-auth.guard.ts) turns an OAuth
token into an API-key-shaped caller, so the REST guards apply their API-key rules
unchanged:

| Property | Value |
| --- | --- |
| Organization | The user's default organization, read on every request; changing the default moves existing tokens with it |
| System role | Always `USER`, so no admin exemption applies to a token |
| Permissions | The token's `scope` limited to [`MCP_OAUTH_SCOPES`](../../../../apps/api/src/mcp/mcp-oauth-policy.ts) (box, volume, image and template permissions), then to what the user's role holds; an owner holds all |

[`McpScopeGuard`](../../../../apps/api/src/mcp/mcp-scope.guard.ts) checks every `tools/call` from
an OAuth caller before it runs, for direct tools and `invoke_api_endpoint` alike:

- An operation off `MCP_OAUTH_OPERATIONS` answers `403`: SSH keys, tunnels, network
  rules, domains, export and import, registries, members and invitations stay API-key
  only, since each grants access that outlives the token. New operations are denied
  until listed, and a spec fails until each v1 operation is classified.
- An operation whose route declares a permission the token lacks
  (`RequiredOrganizationResourcePermissions`, read at startup; an `@All` route such
  as the exec and file proxies decides every verb on its path) answers `403` with
  `WWW-Authenticate: Bearer error="insufficient_scope", scope="<granted> <missing>"`,
  so a client that re-authorizes keeps the scopes it had.

Sign-in requests every MCP scope, as Supabase's MCP server does: the `401` challenge
names no scope, so clients request the metadata's `scopes_supported`, which lists all
of `MCP_OAUTH_SCOPES`. One consent then covers every allowlisted operation; step-up
still covers a client or user that grants fewer. Whether a client completes step-up for the rest is
checked per client on the dev tenant. API-key callers skip both checks; the key's own
permissions apply in REST.

**Tools.** `tools/list` returns 13 tools:

| Tools | What they do |
| --- | --- |
| `createBox`, `listBoxes`, `getBox`, `startBox`, `stopBox`, `removeBox` | The box operations of the same `operationId` |
| `startExecution`, `getExecution` | Run a command; with `wait` (default) the result carries `stdout`, `stderr`, `exit_code` and `complete` |
| `uploadFiles`, `downloadFiles` | Tar archives as base64 (`body_base64`), up to 8 MiB; `/mcp` accepts JSON bodies up to 12 MiB for this, read only after the caller is authenticated, so an unauthenticated call gets its `401` (or `403` if it carries an `Origin` header) before any of the body is buffered; every other route keeps the default limit |
| `list_api_endpoints`, `get_api_endpoint_schema`, `invoke_api_endpoint` | Find, describe and call any other catalog operation by `operationId` |

Each box tool sets all four MCP tool annotations in
[`DIRECT_TOOLS`](../../../../apps/api/src/mcp/mcp-tools.ts), so hosts can prompt before destructive
calls and keep the read-only ones in a read-only mode:

| Tool | Read-only | Destructive | Idempotent | Open world |
| --- | --- | --- | --- | --- |
| `listBoxes`, `getBox`, `getExecution` | yes | no | yes | no |
| `downloadFiles` | yes | no | yes | yes |
| `createBox` | no | no | no | yes |
| `startBox` | no | no | yes | yes |
| `stopBox`, `removeBox`, `uploadFiles` | no | yes | yes | yes |
| `startExecution` | no | yes | no | yes |

The schema ignores the destructive and idempotent hints on read-only tools. Idempotent
describes the effect on the box, so a repeated `removeBox` counts even though it answers
`404`. `list_api_endpoints` and `get_api_endpoint_schema` are read-only;
`invoke_api_endpoint` carries no annotations because it reaches reads and deletes alike,
so hosts treat it as destructive.

The catalog is built at startup from [`openapi/box.openapi.yaml`](../../../../openapi/box.openapi.yaml),
[`openapi/admin.openapi.yaml`](../../../../openapi/admin.openapi.yaml) and the product Swagger
document. Tool names and argument schemas are the operations' own; the v1 specs win
an `operationId` both define. An operation is in the catalog only when this API
registered a route for it, so spec operations only `boxlite serve` implements
(snapshots, clone, export, import, `attachBox`) are left out. A product route must
also sit behind `CombinedAuthGuard` with no runner or proxy guard: runner, proxy,
browser-auth, health and JWT-only routes (organizations, roles, invitations, usage)
are left out.

**How a call runs.** A tool call never re-implements a route. It is sent to the
API's own Express app as the REST request for its operation, so that route's guards,
validation, throttles and audit run unchanged:

```
POST /mcp ─▶ McpOriginGuard, McpAuthGuard ─▶ caller
  tools/call ─▶ McpDispatcher ─▶ METHOD /api/... over a per-process Unix socket
                                 no Authorization, x-boxlite-mcp-delegation: <nonce>,
                                 X-Forwarded-For naming the MCP client
             ─▶ CombinedAuthGuard: mcp-delegation strategy ─▶ same caller ─▶ REST route
```

The caller's token is never forwarded (MCP forbids token passthrough). The nonce is
32 random bytes, valid for 30 seconds, consumed on first use and held only in the
process's memory; the socket lives in a fresh `0700` temporary directory, so a
request never reaches another cluster worker. A delegated call is cut off, and the
tool answers with an error, when its response passes 8 MiB, when it sends nothing
for five minutes, or when the MCP client disconnects. `startExecution` with `wait`
and `attachExecution` read output from the read-only attach WebSocket over the same
Unix socket (so no TLS name or port is involved), authenticated by a one-time
attach ticket; output printed before the attach is
replayed from the runner's 256 KiB per-stream backlog. A wait that runs out returns
`complete: false` with the output so far.

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
<summary><b>Box lifecycle</b> · 8 routes</summary>

| Method | Path                              | What it does                                   |
| ------ | --------------------------------- | ---------------------------------------------- |
| `POST` | `/boxes`                          | Creates a box in the embedded BoxLite runtime. |
| `GET`  | `/boxes/{boxId}`                  | Gets local box information.                    |
| `POST` | `/boxes/{boxId}/destroy`          | Destroys a local box.                          |
| `POST` | `/boxes/{boxId}/start`            | Starts a local box.                            |
| `POST` | `/boxes/{boxId}/stop`             | Stops a local box.                             |
| `POST` | `/boxes/{boxId}/recover`          | Recovers a local box.                          |
| `POST` | `/boxes/{boxId}/is-recoverable`   | Checks whether a local box can be recovered.   |
| `POST` | `/boxes/{boxId}/network-settings` | Changes a local box's network settings.        |

</details>

<details>
<summary><b>Embedded BoxLite operations</b> · 14 routes</summary>

| Method    | Path                                           | What it does                                          |
| --------- | ---------------------------------------------- | ----------------------------------------------------- |
| `POST`    | `/v1/boxes/{boxId}/exec`                       | Starts a command inside the local box.                |
| `GET`     | `/v1/boxes/{boxId}/executions`                 | Lists live guest execution IDs, including main; stopped boxes return an empty list without booting. |
| `GET`     | `/v1/boxes/{boxId}/executions/{execId}`        | Gets local execution status.                          |
| `DELETE`  | `/v1/boxes/{boxId}/executions/{execId}`        | Kills a local execution.                              |
| `WS`      | `/v1/boxes/{boxId}/executions/{execId}/attach` | Attaches a WebSocket to local execution I/O.          |
| `POST`    | `/v1/boxes/{boxId}/executions/{execId}/signal` | Sends a signal to a local execution.                  |
| `POST`    | `/v1/boxes/{boxId}/executions/{execId}/resize` | Resizes a local execution's terminal.                 |
| `PUT`     | `/v1/boxes/{boxId}/files?path={path}`          | Uploads a tar stream into the local box.              |
| `GET`     | `/v1/boxes/{boxId}/files?path={path}`          | Downloads a local box path as a tar stream.           |
| `GET`     | `/v1/boxes/{boxId}/metrics`                    | Returns local box metrics.                            |
| `CONNECT` | `/v1/boxes/{boxId}/network/tunnel?port={port}` | Opens a raw bidirectional TCP tunnel to a guest port; answers `409` with code `box_not_running` for a box that is not running, which the proxy uses to wake the box. |
| `POST`    | `/v1/boxes/{boxId}/ssh`                        | Configures guest SSH once after checking that the box is running; otherwise `409 invalid_state`. |
| `POST`    | `/v1/boxes/{boxId}/ssh/enable`                 | Enables saved SSH configuration only while running; otherwise `409 invalid_state`. |
| `GET`     | `/v1/boxes/{boxId}/ssh`                        | Reads guest SSH status; a stopped box answers disabled status without a handle. |
| `DELETE`  | `/v1/boxes/{boxId}/ssh`                        | Disables guest SSH on a running box; otherwise `409 invalid_state`. Never boots.              |

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
routing, so it works on every host. How the proxy authenticates these requests
and tunnels them to guest ports is in [`proxy/README.md`](../../../../apps/proxy/README.md).

<details>
<summary><b>Proxy routes</b> · 7 routes</summary>

| Method    | Host and path                                         | What it does                                                                                                      |
| --------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET`     | `proxy.<domain>/health`                               | Reports proxy health and version.                                                                                 |
| `GET`     | `proxy.<domain>/login`                                | Starts OIDC login with a host-only PKCE cookie and signed target state.                                           |
| `GET`     | `proxy.<domain>/callback`                             | Completes the OIDC preview authentication flow.                                                                   |
| `GET`     | `<port>-<box>.proxy.<domain>/__boxlite/auth/callback` | Consumes the login handoff and issues a host-only tunnel session cookie.                                          |
| `POST`    | `<any host>/accept-boxlite-preview-warning`           | Records preview-warning acceptance and redirects to the `redirect` form field (the query form is still accepted). |
| `ANY`     | `<port>-<box>.proxy.<domain>/{path...}`               | Reverse-proxies HTTP and WebSocket traffic to the selected box port after preview access checks.                  |
| `CONNECT` | `<port>-<box>.proxy.<domain>`                         | Opens a TCP stream after inbound and tunnel authorization; SDK/CLI sends its organization bearer.                 |

</details>

## Registry proxy API

**Service:** `apps/image-service` (binary `cmd/registry-proxy`) · **Base path:**
`/v2` · **Port:** `4100` in deployments (`REGISTRY_PROXY_PORT` environment
variable) · **Reached:** from inside the stage's network only, at its own Cloud
Run address over HTTP/2

The pull half of the OCI distribution protocol, served so a runner can fetch an
image whose registry credentials only the platform holds. The organization and
the upstream registry ride in the repository name — `<org>/<host>/<repo…>` —
because one proxy serves every registry and the path is what says which. A
manifest is relayed byte for byte and a blob is streamed, so the digest a client
verifies still covers what the upstream served. How callers are authenticated,
which upstreams are reachable, and how redirects are judged is in
[`image-service/README.md`](../../../../apps/image-service/README.md).

<details>
<summary><b>Registry proxy routes</b> · 4 routes</summary>

| Method       | Path                                               | What it does                                                                              |
| ------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET`        | `/health`                                          | Reports registry proxy health and version.                                                |
| `GET` `HEAD` | `/v2/`                                             | The distribution version check; answers an unauthenticated caller with a Basic challenge. |
| `GET` `HEAD` | `/v2/{org}/{host}/{repository...}/manifests/{ref}` | Relays the upstream manifest unmodified, with its digest and media type.                  |
| `GET` `HEAD` | `/v2/{org}/{host}/{repository...}/blobs/{digest}`  | Streams the upstream blob, following a registry's redirect to a permitted address.        |

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

`make up` in [`infra-local`](../../../../apps/infra-local/) starts the dependency services as
BoxLite boxes and the application processes on the host. Every listener below is
bound on the developer's machine; the host ports are fixed literals in
[`services.py`](../../../../apps/infra-local/compose/services.py) and
[`native.py`](../../../../apps/infra-local/compose/native.py), not deployment values. From
inside a box the same listeners are reachable as `host.boxlite.internal:<port>`.

<details>
<summary><b>Unified entry point</b> · 10 routes</summary>

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
| `ANY`  | `localhost:28080/maildev/*`                  | Reverse-proxies the MailDev caught-mail UI.                        |
| `ANY`  | `localhost:28080/`                           | Responds with a plain-text index of the routes above.              |

Caddy serves these over plain HTTP with `auto_https off`; host `28443` is
reserved for a future `tls internal` block. Its admin API is on host `12019`
(container `2019`), and `GET :12019/config/` is Caddy's own readiness probe —
each of the other services below carries one of its own.

</details>

<details>
<summary><b>Dependency services</b> · 11 services</summary>

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
| `maildev`     | `25053` → `1080`, `25054` → `1025`                    | Caught-mail UI and the SMTP sink the API sends to; probed at `/healthz`.          |
| `otel`        | `24317` → `4317`, `24318` → `4318`, `23133` → `13133` | OTLP gRPC and HTTP receivers, plus a `health_check` extension at `/`.             |

The local collector is the upstream `otel/opentelemetry-collector` image with an
inline config, not the first-party build described in
[Telemetry collector API](#telemetry-collector-api): it enables OTLP gRPC as
well as HTTP, exports traces to the Jaeger box, and answers health at `/`
instead of `/health/status`.

This Dex box serves the inline `_DEX_CONFIG` from
[`services.py`](../../../../apps/infra-local/compose/services.py), written to
`/tmp/dex-config.yaml` at boot: one public static client, `boxlite`, whose
redirect URIs cover the dashboard, the Vite dev server, and the CLI loopback
callback at `http://127.0.0.1:5555/callback`, plus a password database holding
two static users. [`dex/config.yaml`](../../../../apps/dex/config.yaml) is a separate file for
a separate environment — see
[Container-based local environment](#container-based-local-environment).
`apps/infra` deploys no Dex service; deployed stacks point
`OIDC_ISSUER_BASE_URL` at a hosted provider and reach it through the same
`/.well-known/openid-configuration` discovery document.

</details>

<details>
<summary><b>Application processes</b> · 5 processes</summary>

| Process          | Host port | Interface                                                                  |
| ---------------- | --------- | -------------------------------------------------------------------------- |
| `api`            | `3001`    | Control-plane and hosted BoxLite-compatible APIs; probed at `/api/health`. |
| `dashboard`      | `3000`    | Vite dev server for the dashboard app.                                     |
| `proxy`          | `4000`    | Preview proxy API (`PROXY_PORT`).                                          |
| `registry-proxy` | `4100`    | Registry proxy API (`REGISTRY_PROXY_PORT`); probed at `/health`.           |
| `runner`         | `3003`    | Runner API (`API_PORT`).                                                   |

The local API listens on `3001` rather than the deployed `3000`, which the
dashboard dev server uses; `BOXLITE_LOCAL_API_PORT` overrides it. This stack
points the API's `SMTP_HOST` at its own MailDev box, so the one email the API
sends — the organization invitation — is caught rather than dropped.

</details>

## Container-based local environment

**Service:** `apps/scripts` · **Entry points:** `yarn dev:dex`, `yarn e2e:local`

A second local environment: [`local-dex-env.mjs`](../../../../apps/scripts/local-dex-env.mjs)
starts four Docker containers, then runs the same four application processes on
the host through the `serve-slim` target. It is the only environment here that
runs [`dex/config.yaml`](../../../../apps/dex/config.yaml), which it renders to
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

These are four of the five projects the boxed stack serves — all but the
registry proxy — on the same `3000`, `3001`, and `4000` host ports, so the two
local environments cannot run at the same time.

</details>

## Externally served APIs

These interfaces are called from this directory but served by systems outside
it, so no route table above owns them. The analytics and billing clients take
their base URL from `GET /config` and disable the corresponding UI when it
is unset; the same document carries PostHog's key and host to the browser.

<details>
<summary><b>External interfaces</b> · 5 APIs, 2 SaaS integrations</summary>

| Interface     | Client                                                                                  | Base URL source                  | What it covers                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analytics API | [`libs/analytics-api-client`](../../../../apps/libs/analytics-api-client/), generated                  | `analyticsApiUrl`                | 8 routes: per-box and organization usage, aggregates, and charts, plus box logs, metrics, and traces.                                                                                                      |
| Billing API   | [`billingApiClient.ts`](../../../../apps/dashboard/src/billing-api/billingApiClient.ts), hand-written  | `billingApiUrl`                  | 22 routes: wallet and top-ups, signup credit delivery, plans, payment methods, invoices, usage series and prices, coupons, billing emails, portal and checkout URLs.                                                               |
| Box admission | [`commerce-box-limit.service.ts`](../../../../apps/api/src/boxlite-rest/commerce-box-limit.service.ts) | `billingApiUrl`                  | 2 server-side reads on Commerce: `GET /plan` and `GET /organization/{organizationId}/plan`, bearer `USAGE_EXPORT_TOKEN`, used by hosted CREATE BOX.                                                        |
| Usage export  | [`api/src/usage/services`](../../../../apps/api/src/usage/services/), hand-written                     | `usageExport.url`                | 2 routes on the same Commerce service, server-side: `POST /internal/usage-events` and `POST /internal/allocation-snapshot`, bearer `USAGE_EXPORT_TOKEN`, which must equal Commerce's `USAGE_INGEST_TOKEN`. |
| Internal state reads | [`box-billing-state.service.ts`](../../../../apps/api/src/box/services/box-billing-state.service.ts) | `usageExport.url` | `GET /internal/billing-states`, server-side bearer `USAGE_EXPORT_TOKEN`. |
| PostHog       | `posthog-js` in the dashboard; `posthog-node` in the API                                | `posthog.apiKey`, `posthog.host` | Browser product analytics; server-side `api_*` operation events from the global metrics interceptor, two `groupIdentify` calls, and feature-flag evaluation.                                               |
| Pylon         | [`App.tsx`](../../../../apps/dashboard/src/App.tsx) widget, production builds only                     | `pylonAppId`                     | Outbound support-chat widget; it registers no route here.                                                                                                                                                  |

The analytics client is generated from
[`swagger.json`](../../../../apps/libs/analytics-api-client/swagger.json). Its four telemetry
routes duplicate the control plane's own [box telemetry](#control-plane-api)
routes, and the dashboard's box telemetry views call the analytics client only —
they disable themselves when `analyticsApiUrl` is unset rather than falling back.
Nothing in this directory registers the analytics or billing paths.

The browser API and Box admission reads live under `/api/billing`, which
`BILLING_API_URL` already includes; admission authenticates with the shared
service token. When `BILLING_API_URL` is configured, the API validates that URL
and the shared token at startup. A request-time transport or 5xx failure is
logged and temporarily leaves creation unlimited without caching the fallback;
rejected credentials and malformed successful responses still return 503.
Successful per-organization resolutions are cached in Redis for 30 seconds.
Internal reads and usage export share `USAGE_EXPORT_URL`; an explicit value
overrides `BILLING_API_URL`'s origin, including an optional path prefix. The API
resolves that default in [`configuration.ts`](../../../../apps/api/src/config/configuration.ts),
and each client appends its internal route. Without either URL, enabled exporters
require `USAGE_EXPORT_URL` explicitly. `BILLING_API_URL` enables internal reads;
the two export flags independently control their respective delivery jobs.
The internal base and token are validated whenever a consumer is enabled.
Internal reads reject URL userinfo; export-only URLs with userinfo select Basic
auth instead of bearer authentication. Commerce reaches back
in one direction only: it resolves organization ownership against this control
plane using the caller's own token. The `billing` API role and `BILLING_API_KEY`
that widen [organization suspend/unsuspend](#control-plane-api) exist for
Commerce, which does not currently call them.

Admission applies the plan value to the organization's non-finalized Box total.
`STOPPED` and `UNKNOWN` Boxes count, while `ERROR`, `DESTROYING`, `DESTROYED`,
`ARCHIVING`, and `ARCHIVED` do not. The billing client is hand-written rather
than generated, so neither side detects its divergence. Five of its 20 routes —
the billing-email group — have no
implementation in Commerce, of which only `email/verify` has a live caller here
([`EmailVerify.tsx`](../../../../apps/dashboard/src/pages/EmailVerify.tsx)); Commerce in turn
serves card default/delete, `plan/pay-open-charge`, and a credit admission API
that nothing in this repository calls.

</details>

## Services without a first-party API

<details>
<summary><b>Non-API services and bundled tools</b> · 7 entries</summary>

| Service                     | Role                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard`            | Static browser application; it consumes the control-plane API and the [externally served APIs](#externally-served-apis), and registers no server API.                                                                                                                                                                                                                                    |
| `apps/dex`                  | Development-only configuration for the third-party Dex OIDC provider, plus a Dockerfile that bakes it into a `dex:v2.42.0` image nothing in this repository builds. The endpoints Dex serves are its own, not a BoxLite-owned API; the listener that does run this config is catalogued under [Container-based local environment](#container-based-local-environment), on `dex:v2.41.1`. |
| `apps/infra`                | Infrastructure-as-code and deployment tooling; it does not run an application API.                                                                                                                                                                                                                                                                                                       |
| `apps/infra-local`          | Local service orchestration; it registers no API of its own, but every listener it starts is catalogued under the [local development stack](#local-development-stack).                                                                                                                                                                                                                   |
| `apps/e2e`                  | End-to-end test client; it calls deployed APIs but does not expose one.                                                                                                                                                                                                                                                                                                                  |
| `apps/box-images`           | Image build inputs; they produce box images and do not run a service.                                                                                                                                                                                                                                                                                                                    |
| `apps/hack`, `apps/scripts` | Development and code-generation utilities; they register no API of their own, though `apps/scripts` starts the [container-based local environment](#container-based-local-environment).                                                                                                                                                                                                  |

MinIO, the registry UI, MailDev, Jaeger, pgAdmin and Caddy are bundled only in
the local development stack, and a Docker registry appears in both local
environments, so all of their interfaces are listed under
[Local development stack](#local-development-stack) and
[Container-based local environment](#container-based-local-environment) rather
than here.

Libraries under `apps/libs` — generated API clients and shared Go packages —
are consumed by the services above; they are not services. A generated client
specification alone is therefore not treated as a live endpoint unless a
runtime application registers the route. Where a client has no in-repo server,
it is listed under [Externally served APIs](#externally-served-apis).

</details>

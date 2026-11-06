# API

The NestJS control-plane service. See the
[hosted platform](../../docs/contributing/architecture/platform/README.md) for how it fits with
the other services and [service interfaces](../../docs/contributing/architecture/platform/api.md)
for its interfaces.

## Development runtime

API development and tests require Node.js 22.14+ within the 22.x line, or 24.10+,
as declared in [`../package.json`](../package.json).
Use Node.js 24 locally to match the production image:

```bash
nvm install 24
nvm use 24
corepack enable
```

The disposable-email dependency requires this runtime range. The Jest adapter uses
Node's native loader to exercise the published ESM package and its bundled domain list.
The API test configuration repeats the shared CI Listener aliases alongside that
dependency's type mapping because TypeScript replaces inherited `paths` as a whole.

Account-link flow tests load the Auth0 Action template with every deployment placeholder filled.
Their SPA fixtures leave the optional MCP resource URL empty, matching the deployment default.

## Registration email policy

The first API request from a new OIDC identity requires an email address.
`UserService.create` trims and lowercases each non-empty email, validates its syntax,
then rejects disposable domains before generating keys, persisting the user or creating a default organization.
This covers database, social and enterprise OIDC identities, CLI authentication and administrator-created users.

| Rejection | HTTP status | Error code |
| --- | --- | --- |
| New OIDC identity has no email | 403 | `email_required` |
| Provided email has invalid syntax | 400 | `invalid_email` |
| Disposable domain or its subdomain | 403 | `disposable_email` |

Existing users can still log in, update their email and link identities; the email-free bootstrap administrator is preserved.
Auth0 signup and verification emails are unchanged: this policy rejects local BoxLite account creation after authentication.
The API uses the bundled list from `@visulima/disposable-email-domains/edge`, pinned to version `2.0.20`.
The list includes `drtall.com` and `emailkeep.com` and matches their subdomains.
Deploy the API after upgrading the package to apply the new list.

Run `make test:apps:api TEST_FILES='user.service.registration-email|jwt.strategy'` for the registration checks,
and `make build:apps:api` to validate the production bundle and dependency imports.

## Box startup timeouts

REST creation persists the Box before waiting up to 30 seconds for `STARTED`.
If the wait expires, HTTP 408 includes the existing Box's public `boxId` in the
flat error body. The Box continues starting; clients can read its state with
their existing organization-scoped credentials instead of repeating creation.
The same identity accompanies other Box state-wait timeouts.

Image-preparation timeouts retain `progress` and `Retry-After`. The ID remains
available even if the best-effort progress lookup fails. HTTP status, message,
and synchronous SDK behavior are unchanged; a timeout is not a running Box.

## Registry credential rotation

`PUT /api/images/registries/{id}` replaces a stored username and password/token with `write:registries` permission.
Both fields are required, with the same validation limits as creation; other fields are refused.
The credential ID, registry host, repository prefix, creator and creation time remain unchanged, even while Boxes depend on it.

Deletion still refuses credentials selected by non-destroyed Boxes.

Rotation checks organization-scoped existence, then writes a fresh secret outside any database transaction.
A short PostgreSQL transaction locks and rechecks the credential, reads its current secret version, and updates the login and pointer.
After acknowledged commit, rotation retires the version read under lock; no secret-store call holds the update transaction open.
This reuses Secret Manager and exclusive local files without a migration or new IAM permissions.
Lock contention returns 409 for retry; another organization's credential returns 404 before any secret write.

Deletion or another rotation can finish while the replacement is being written.
A credential deleted before the locked recheck returns 404 and cleans up the replacement; a concurrent rotation retires the version current at the lock.
Transaction-start, lock and pre-commit update failures clean up the replacement after the transaction rejects, preserving the original failure.
An uncertain COMMIT outcome retains both secrets and emits an `update outcome is unknown` warning; reconcile the stored pointer before retiring either version.
A failed old-secret retirement emits `Could not destroy unused registry secret`; the committed update remains successful and cleanup needs retrying.

The warning identifies a version and the cleanup error cause, never its password; the API cannot read registry passwords or validate them upstream.

Before reusing a private bearer, each proxy queries the current credential metadata and compares its secret version with the cached token's version.
After update commits, newly started pulls reject old-version bearers even if old-secret retirement fails.
Secret payloads are read only on authentication challenges; unchanged credentials still reuse their bearer token.

Normally, each private manifest/blob request adds one control-plane lookup; lookup failures reject the pull even when a bearer is warm.
If a secret read races retirement, the proxy refreshes authorized metadata and retries that read once before failing the pull.
Requests whose lookup preceded update may finish; another rotation during the retry can still require a caller retry.
The upstream token itself is not revoked, and anonymous lookup caching keeps its existing TTL.

Deploy the API and proxy before the dashboard; older proxies retain the prior five-minute cache delay until upgraded.
This operation is additive to the control-plane API and does not add portable SDK methods.

Run `make test:apps:api TEST_FILES='registry/'`; set the normal `DB_*` variables to include the real-PostgreSQL mutation tests.
These cover live/stopped Boxes, organization isolation, rollback, concurrent mutations and lost COMMIT acknowledgment with real secret files.
Design: [registry credential updates](https://github.com/boxlite-ai/boxlite/issues/2304).

## Account deletion tests

`src/user/user-deletion-memberships.spec.ts` exercises account deletion through the real services
and event handlers. Its database double runs nested transaction callbacks with the same manager
and supports deletion by ID or field criteria; only the outer transaction records a commit.
The assertions check domain cleanup, preservation of shared organizations and their domains,
and membership revocation after the outer commit. Run it from the repository root with
`make test:apps:api TEST_FILES=user-deletion-memberships.spec.ts`.
The double checks callback execution and row selection; the real-Postgres organization-domain
lifecycle tests cover database rollback.

## Guest Docker privilege

REST creation accepts `advanced.privileged` (default false) and advertises
`privileged_enabled` in `/v1/config`. The option is stored on the Box and
forwarded by both runner adapters on creation and by v0 recovery. Subsequent
starts reuse the runtime's persisted guest settings. The
pre-deploy migration initializes existing Boxes to false. Privileged requests
require fresh Boxes, so a warm-pool Box cannot silently discard the requested
guest policy.

Runner v0 info and v2 health reports advertise `supportsPrivileged`. The API
stores it with a false default and clears it when a report omits it or sends
false. A failed v0 info read leaves the capability column untouched; a successful
report with the field omitted still clears it. Timed-out checks recheck cancellation
after reading the runner and before submitting a health update, so a delayed read
cannot resume and overwrite a retry's report or emit a stale state event.
Privileged creation and migration
select only runners reporting support; create and v0 recovery also reject an
unsupported target before dispatch.
Ordinary Boxes retain the existing scheduling rules. `/v1/config` describes API
support independently of current runner capacity. Run the pre-deploy migration
before updating the API; each upgraded runner becomes eligible after reporting
its capability.

This enables guest capabilities and writable kernel mounts. Runner host sandbox
settings remain independent; REST rejects host security options and explicit
capability policies. Operators must supply a Docker-capable guest kernel as
described in the [DinD guide](../../docs/guides/docker-in-docker.md).

Migration-backed integration suites that query `Box`, including usage accounting,
run `AddGuestPrivileged1792540800000` so their schema includes the persisted field.

## GitHub CI installation connect (in development)

The CI controller implements `POST /api/v1/{prefix}/ci/connect`,
`POST /api/v1/{prefix}/ci/connect/{id}/poll`, and
`DELETE /api/v1/{prefix}/ci/connect/{id}`. Browser connect adds
`GET /api/v1/{prefix}/ci/connect/configuration`,
`POST /api/v1/{prefix}/ci/connect/web`, and
`POST /api/v1/{prefix}/ci/connect/{id}/complete`,
`POST /api/v1/{prefix}/ci/connect/{id}/select`, and
`POST /api/v1/{prefix}/ci/connect/{id}/installation`. Routes without `{prefix}` use the existing
authenticated organization. These experimental routes are excluded from generated clients.

Start accepts `github_account`, `follow_installation: true`, and
`allow_public_repositories`. Existing platform authentication and organization guards
require an owner or the explicit platform-admin exception; API keys additionally need
`write:boxes` and `delete:boxes`. Transactions remain scoped to the initiating user and
organization. GitHub device authorization proves personal-account ownership or active
organization-admin membership and cross-checks the installation through App authentication.

The Dashboard's CI → Connects page uses GitHub App browser authorization with
an independent random state and S256 PKCE. CLI connect keeps Device Flow. Browser
start accepts `account_type: User | Organization` and the public-repository policy;
complete accepts only `code` and `state`. The selected type chooses the Personal
or Organization App before authorization. Five-minute attempts belong to the original BoxLite user,
organization and App. The API stores a state hash and encrypted verifier, claims
an attempt once and clears the verifier before exchanging the code. An uncertain
exchange is terminal; restart authorization instead of retrying the code.

The fixed callback is `${DASHBOARD_URL}/settings/ci/callback`; `DASHBOARD_URL`
must be an HTTPS origin without a path/query, or explicit localhost HTTP for local
development. Add the exact callback in the GitHub App settings. Leave wildcard
matching and automatic OAuth during installation disabled; BoxLite starts its own
explicit authorization. An installation setup callback alone grants no binding.

The browser removes callback query/fragment parameters before loading the app or
telemetry. Only attempt ID, original organization ID and expiry enter tab-scoped
session storage. Codes and state remain in module memory; verifier, Client Secret
and GitHub tokens remain on the API. Lost browser state or a new login requires a
fresh connect. Duplicate React StrictMode mounts share one completion request.
The API verifies the original identity/state/flow/deadline before exchange and
uses the same final binding transaction as CLI. After exchange, a user token is
encrypted server-side until selection or the original five-minute deadline;
refresh tokens are discarded. No GitHub user token reaches the browser or JIT Box.

After authorization, the API lists owned personal installations or organizations
where the user is an active owner. The browser shows those accounts for explicit
selection. `select` accepts only a numeric `installation_id`; the API freshly
verifies it with the same original App and user token before binding. Organization
ownership uses the paginated `/user/memberships/orgs` user endpoint, which needs
no `Members: read` App permission. Ordinary organization members cannot connect.

Both Apps use the same callback as their **Setup URL** and OAuth callback. The
install link carries the original attempt state. `/installation` requires that
state plus `installation_id`; it verifies current GitHub ownership and installation
identity before automatic binding. A naked setup callback never proves authority.
Selection, expiry, cancellation and terminal failure clear temporary token
ciphertext. The initial code exchange is never repeated during selection.

```mermaid
sequenceDiagram
    actor User
    participant UI as Dashboard
    participant API as CI Connect API
    participant App as Selected GitHub App
    participant DB as PostgreSQL
    User->>UI: Choose Personal or Organization
    UI->>API: Start web connect (BoxLite session)
    API->>DB: Persist actor, org, App, state hash and encrypted PKCE
    API-->>UI: Authorize URL for selected App
    UI->>App: OAuth authorization with state and S256
    App-->>UI: Code and state callback
    UI->>API: Complete (code, state)
    API->>App: Exchange code once
    API->>DB: Persist encrypted temporary user token
    API->>App: List installations and active owner memberships
    API-->>UI: Verified account choices
    alt Existing installation
        User->>UI: Select owned account
        UI->>API: Select installation ID
    else New installation
        UI->>App: Install selected App with original state
        App-->>UI: Setup callback (installation ID, state)
        UI->>API: Complete installation
    end
    API->>App: Recheck user ownership and original App installation
    API->>DB: Recheck BoxLite owner; atomically bind and wake inventory
    API->>DB: Clear temporary token
    API-->>UI: Connected
```

Postgres stores encrypted device codes, web verifiers or temporary selection tokens, polling leases, expiry and installation bindings.
A unique App/installation constraint prevents another organization from claiming the same
installation. Completion checks cancellation, expiry and lease ownership in the binding
transaction. Cancellation clears pending credentials; it does not revoke a completed binding.

After GitHub verification, the binding transaction rechecks the current user role and
organization ownership. API-key requests also require the exact current Key hash,
original user and organization, and both Box permissions; the ADMIN exception does not
bypass those Key checks. Authority rows remain locked through completion. The final
write checks attempt, lease and Key expiry against `clock_timestamp()`, so waiting for
a lock cannot extend authorization. Revoked, replaced or expired authority rolls back
the binding, including an installation claim inserted earlier in that transaction.

Successful binding and its installation inventory wake commit in the same transaction.
The final authorization/expiry decision follows that wake write; a persistence failure
or expired authority rolls back both. A running controller reads this wake on its next
reconciliation cycle, rather than waiting for the periodic directory refresh.
Repeated polling of a completed attempt does not enqueue another wake.

Successful binding returns `connected` and the persisted `listener_status`. It stays
`provisioning` until the managed Listener has published its original catalog and the API
has committed the catalog scopes to PostgreSQL. `ready` describes that binding
initialization; it does not certify available CI capacity. Configuration and the CLI flow are documented in the
[Listener README](../github-ci-runner/README.md#hosted-connect).

## GitHub CI webhook ingress (in development)

`POST /api/v1/ci/github/webhook` (Personal App) and
`POST /api/v1/ci/github/webhook/organization` (Organization App) accept GitHub's signed notifications without a
BoxLite API Key. Only this route uses raw bytes, capped at 1 MiB; compressed bodies
and non-JSON content types are rejected. `CI_GITHUB_WEBHOOK_SECRET` is injected by
the deployment platform from a secret reference. Its trimmed UTF-8 value must be
32–256 bytes; raw configuration is capped at 64 KiB. Configure the same trimmed
value as the GitHub App webhook secret, separately from the App private key.

HMAC-SHA256 verification precedes JSON parsing and database access. The shared
`Listener.receive` and `ListenerInbox` store receipts, notices and wakes in
`ci_listener_state`. Each ingress read/write transaction rechecks the configured
App, live installation binding and original actor's current owner/admin authority.
Unbound or revoked workflow notifications return 503 without storing a receipt.
An unconnected installation does not enqueue inventory: connect itself commits
the authoritative binding and wake together. Job notifications cannot create or
claim a connection, and revoked authority or known account mismatches store no inbox work.
Signed installation changes may record discovery hints even after a binding is
removed; those hints grant no execution authority.

Delivery UUID and body/event digest prevent conflicting replay. Distinct deliveries
update opaque record versions; settlement matches the captured version so an older
observation cannot erase newer work. Repository/run/job identity conflicts return
409 and roll back all inbox writes. A notice is demand to verify through GitHub,
not an exclusive job assignment or executable instructions.

HTTP 204 follows durable commit, duplicate recognition or a valid ignored event.
HTTP 503 retains unsettled work on database failure or capacity exhaustion. Requests,
secret reads and unsettled persistence operations are bounded; a response timeout
does not free a still-running operation. A late commit remains idempotent on retry.
Receipts are currently retained; automatic retention pruning is not implemented.

GitHub does not automatically retry failed webhook deliveries. The shared controller
uses App-wide delivery recovery when the webhook secret is configured, alongside
bounded compensation scans. The shared controller saves exact delivery IDs, GUIDs,
scan checkpoints and retry intents in PostgreSQL, then rechecks the current connect
binding and owner before requesting replay. Missing or revoked bindings cannot send
a replay or obtain execution authority. POST 202 only confirms a request; a local
receipt or later successful delivery observation stops transport retries. Recovery
metadata expires after the available history window; business receipts and unknown
resource allocations are not pruned by that cleanup.
A normal queued-job webhook supplies its exact job ID; it does not trigger short
polling of every repository. Apply the
connect and shared-state migrations before enabling this receiver. Real hosted App
CI and recovery acceptance are still pending.

### JIT Box deletion and capacity recovery

Hosted worker recovery checks the recorded Box ID and organization before
interpreting its lifecycle state. Platform soft deletion renames the Box; a
confirmed `DESTROYED` record for that original ID releases its physical capacity
even after the rename. Pending deletion retains capacity until confirmation.
Unknown IDs, conflicting ledgers, foreign organizations and renamed live Boxes
remain denied. Confirmed Box absence makes its physical capacity available; the
allocation remains recorded until the original runner cleanup also finishes.
A successful CI job alone does not prove that cleanup finished.

## Admin Box image

`GET /api/admin/boxes` and `GET /api/admin/boxes/{id}` include `image`, the stored
Box image reference, or null when none is recorded. Both select the existing
column in their current queries and use the same response projection; no extra
lookup or migration is required. For example, a Box created from `python:3.13`
returns `"image": "python:3.13"` in both responses. Upgrade strict consumers to
accept this field before rolling out the added response property.

## Business events

`recordBusinessEvent` (`src/common/utils/business-event.util.ts`) writes one structured log record
per business event; the attributes reach OTLP through nestjs-pino, where alerts query them.

| Event                                  | Recorded by                                       | Outcomes                      |
| -------------------------------------- | ------------------------------------------------- | ----------------------------- |
| `user.registration`                    | `UserService.create`, through `recordOutcomes`    | requested, success, exception |
| `user.login`                           | `LoginEventRecorder`                              | success                       |
| `box.create`, `box.stop`, `box.delete` | `BoxService`, the auto-stop and auto-delete crons | requested                     |
| `box.create`, `box.stop`, `box.delete` | `JobStateHandler`, when the runner job finishes   | success, exception            |

Box events go through `src/box/utils/box-business-event.util.ts`: the request and the outcome are
recorded in different places, so one call cannot cover both.

An event names its entity only by `correlation.id` (the user id or the box id). It carries no
`org.id`: the box table holds a box's organization, and the organization tables a user's.

### Who asked: the operation context

A service that records an event takes a required `ctx: Context` (`src/common/context/`) from its
caller. The compiler rejects a call that omits it.

```ts
return this.userService.create(createUserDto, Context.admin())
await this.stop(event.boxId, undefined, Context.platform(PlatformReason.ORG_SUSPENSION))
```

| Context                    | `actor.kind` | `event.reason`                                           |
| -------------------------- | ------------ | -------------------------------------------------------- |
| `Context.user()`           | `user`       | —                                                        |
| `Context.admin()`          | `admin`      | —                                                        |
| `Context.platform(reason)` | `platform`   | the `PlatformReason`, such as `auto_stop` or `bootstrap` |

- Only the platform gives a reason; user and admin contexts have none.
- The boot-time admin seed registers as `Context.platform(PlatformReason.BOOTSTRAP)`.
- Job outcome events carry no context: the runner reports after the request has ended.
- Add caller-decided fields to `Context`, not new service parameters.

## Admin organization metadata

System administrators read registration fields on the existing organization routes.
Authenticate with `Authorization: Bearer <admin-api-key>` or an administrator JWT;
an ordinary organization's API key does not grant system-wide access.

Upgrade every producer instance before enabling the updated consumer. Old list cursors
must be discarded because the default ordering now uses creation time and ID. Existing
callers needing current-month usage must explicitly select `include=usage`. Roll back
consumers before producers; mixed-version traffic is not supported during activation.

- `GET /api/admin/organizations` returns a bounded page with `createdAt`,
  stored `createdBy`, nullable current `creator`, member/Box counts and impact.
  `q` searches name or exact ID. `createdFrom` is inclusive and `createdTo` exclusive;
  timestamps require an offset and at most millisecond precision. `limit` is 1–200 (default 50).
  `boxCountScope=all` counts every retained state, including destroyed and archived,
  while impact considers only non-destroyed, non-archived Boxes. Omitting this parameter
  excludes destroyed and archived Boxes from the count.
  `organizationId=<UUID>` selects an exact primary key; it cannot combine with `q`.
  Registration collectors use the same full page with `boxCountScope=all` and date bounds.
  Creator lookup and inventory aggregation are restricted to the page's organization IDs;
  no separate per-organization inventory call is needed for the first observation.
  The list always returns `AdminOrganizationOverviewPage`, including counts and impact.
- `GET /api/admin/organizations/{organizationId}` returns flat organization
  details with registration, member/Box pages and impact. A missing organization returns 404.
  `memberCursor`, `boxCursor` and `sectionLimit` page each section. Explicit `include=usage`
  adds existing UTC month-to-date usage; `include=activation` adds retained activation
  evidence. Comma-separated `include=usage,activation` selects both. Omitting `include`
  reads neither section.

Admin detail also returns the stored `suspended` boolean from the same organization
lookup. This flag does not evaluate `suspendedUntil` or establish whether Boxes have
stopped. The response property is optional and read-only in generated clients for
older-server compatibility; an absent flag means unknown, never false. No schema
migration or additional query is needed.

`createdAt` is organization creation time, not user signup or first Box creation. `createdBy`
is the stored creator association, independent of current membership. Account linking
rewrites it to the primary user ID, so it is not an immutable historical identity.
When a creator no longer exists and the organization survives, `creator` is null; an existing
user without an email has `creator.email:null`. Names and email describe current identity.
The list response includes `creator.emailVerified` when the account's
current verification state is available. The organization detail response includes
creator fields (`userId`, `email`, `displayName`) and does not query verification state.
Pages read live data and exclude deleted organizations.
All-state counts cover only retained rows, not lifetime successful creations: cleanup can
remove destroyed rows and pending/failed rows can remain. `observedAt` remains the last
business modification; consumers must measure successful-read freshness separately.

List order and cursor seek both use creation time truncated to milliseconds plus
UUID, ascending. Cursors bind `q`, date filters and count scope and exact organization ID; changing them returns 400. Default-read cursors retain their prior encoding. Unknown
parameters, invalid dates, UUIDs, and incompatible
cursors return `400 invalid_organization_query`. Invalid credentials return 401;
non-admin access returns 403. Consumers may ignore additive fields but must validate
required fields and project their own allowed response fields.

For organizations created on October 20 in UTC+08:00, use this half-open UTC interval:

```bash
curl --get "$BOXLITE_API_URL/api/admin/organizations" \
  --header "Authorization: Bearer $BOXLITE_API_KEY" \
  --data-urlencode "createdFrom=2026-10-19T16:00:00Z" \
  --data-urlencode "createdTo=2026-10-20T16:00:00Z" \
  --data-urlencode "limit=50"
```

Keep the same filters while following `nextCursor` until null. Continue member
and Box cursors independently on detail. Responses use `Cache-Control: private, no-store`.

### Generated clients

The TypeScript organization-list method accepts Axios request options in the original
sixth position or after the new filters in the eighth position. This applies to the class,
factory, functional interface and request creator. For an initialized `admin` client:

```typescript
const options = { headers: { Authorization: `Bearer ${adminApiKey}` }, timeout: 5000 }
// Existing callers keep their headers and other Axios options.
await admin.adminListOrganizationsOverview(undefined, undefined, 50, undefined, undefined, options)
// New callers can select all retained Box states and an exact organization.
await admin.adminListOrganizationsOverview(
  undefined,
  undefined,
  50,
  undefined,
  undefined,
  'all',
  organizationId,
  options,
)
```

Request options remain outside URL query parameters. The TypeScript generation
postprocessor preserves both forms and fails if the expected generated signatures change.

The Go client uses `AdminOrganizationCreator` and `NullableAdminOrganizationCreator`
for both organization-list and detail models. Existing constructor and getter/setter
signatures remain compatible. For example, a value from `NewAdminOrganizationCreator`
can be passed directly to the overview's `SetCreator`.
The optional `EmailVerified` field carries verification from list responses;
`GetEmailVerifiedOk` distinguishes an absent state from `false`.
The Go generation postprocessor preserves these model names and signatures while
the HTTP schemas retain their separate list and detail fields.

Existing organization operation IDs and top-level response models are retained. Registration fields
are required; usage and activation remain optional, present only when selected. Query
parameters have explicit Swagger string types; runtime validation still applies. Regenerate the committed
clients from `apps/` with the pinned generator in `openapitools.json`:

```bash
yarn nx run api-client:generate:api-client
yarn nx run api-client-go:generate:api-client
yarn nx run analytics-api-client:generate:api-client
```

Use the example API environment and a local Redis for offline export, as in the API client
drift workflow. Commit generated methods, models, OpenAPI and generator indexes together;
a second uncached generation must leave them unchanged.

## Admin recorded resource usage

### Design and reuse

`GET /api/admin/usage` integrates recorded allocation periods over a half-open time window.
It uses the existing administrator guards, ledger tables, and Redis connection. Historical
organization, region and Box dimensions come from each period, without joining current Boxes;
deleted Boxes and reassigned resources therefore retain their recorded attribution.
The period writer records CPU in vCPU and memory/disk in GiB (`usage/usage-event.ts`).
Stopped Boxes can have storage-only periods.

The archive worker moves closed periods in one transaction and assigns new archive row IDs.
One SQL statement reads live and archive with `UNION ALL`, under PostgreSQL's statement snapshot,
so the move cannot duplicate or lose a period between reads. Allocations are cast to `numeric`
before integration; decimal strings avoid further JavaScript floating-point loss. This cannot
recover precision already lost in the ledger's floating-point columns.
See [PostgreSQL statement snapshots](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED)
and [exact numeric types](https://www.postgresql.org/docs/18/datatype-numeric.html#DATATYPE-NUMERIC-DECIMAL).

Event handling can fail, and reconciliation starts a correction at the current time rather
than backfilling the gap (`usage/services/usage.service.ts`). Every response therefore reports
`coverage: {status: "unknown", reason: "usage_events_not_backfilled"}`. Empty items mean no
recorded periods, not zero actual usage. Even a recorded value of `"0"` cannot establish a
complete zero total. `sourcePeriodCount` counts participating periods, not completeness.
No historical retention watermark is inferred from the oldest remaining row.

### Query and response

Authenticate with an Admin API key or administrator JWT. All pages reapply the normal guards.
Required `from` and `to` are RFC 3339 instants with an explicit timezone and at most milliseconds;
`to` cannot be in the future. `granularity` defaults to `window`; `hour` permits up to 7 days,
and `day`/`window` up to 90 days. Fixed hour/day buckets start at `from`, with the final bucket
clipped at `to`; they are not calendar/DST buckets.

`metrics` is a unique comma-separated selection of `computeVcpuSeconds,storageByteSeconds,
memoryGibSeconds`, defaulting to the first two. Values integrate allocation times overlap
seconds; storage converts GiB to bytes. They describe allocated resources, not utilization
or money. `groupBy` selects one or two of `organizationId,regionId,boxId`, defaulting to
`organizationId`. Optional filters use these same names. Organization IDs are UUIDs; Region
and Box filters allow 1–128 ASCII letters, digits, `.`, `_`, `:`, `-`, starting with a letter
or digit. The ledger stores string IDs, including historical IDs. Warm-pool unassigned
organization periods are excluded. Lists are normalized in the order shown above.

`limit` is 1–200 (default 50). Repeat all query conditions with `cursor` (maximum 2048 characters)
for subsequent pages. The response contains `queryId`, `generatedAt`, `expiresAt`,
`definitionVersion: "resource-usage-v1"`, normalized `query`, `coverage`, `items`, and
nullable `nextCursor`. Query excludes pagination and identity. Each item contains bucket
`from/to`, only selected `dimensions` and decimal-string `values`, and `sourcePeriodCount`
(1–200000). Only groups with recorded periods are returned.

```bash
curl --get "$BOXLITE_API_URL/api/admin/usage" \
  --header "Authorization: Bearer $BOXLITE_API_KEY" \
  --data-urlencode "from=2026-10-18T16:00:00Z" \
  --data-urlencode "to=2026-10-19T16:00:00Z" \
  --data-urlencode "groupBy=organizationId,regionId" \
  --data-urlencode "metrics=computeVcpuSeconds,memoryGibSeconds"
```

### Limits, pagination and verification

A first page calculates a fixed result, limited to 200000 candidate periods, 5000 result
rows, 2 MiB serialized cache data, and a 5-second database statement timeout. Limits fail
the whole query; there is no successful truncation. General ledger time-window indexes
support storage-only periods that the existing CPU-positive concurrency indexes omit.
The indexes build concurrently outside a transaction so ledger writes can continue.
CLI and application migration runners use `each`; other migrations remain transactional.
Retries preserve valid indexes and rebuild invalid leftovers from interrupted builds.
See [migration rollback](src/migrations/README.md#reverting-migrations) for the explicit
nontransactional revert required by these indexes. Builds still consume I/O and wait for
older transactions, so deployment planning must account for ledger size and transaction age.
These are protective bounds; production capacity requires workload testing before deployment.

Redis stores the result for 15 minutes without renewing expiration, using
[SET with expiration](https://redis.io/docs/latest/commands/set/). All pages share the same
query identity, timestamps and data; no database transaction spans requests. The cache binds
the normalized query, definition version and authenticated user. Any valid credential of that
user may continue, because Admin access belongs to the user rather than to one API key; the
binding omits key material so no credential digest is rehashed.
Optional `X-Usage-Snapshot-Owner` is exactly 64 lowercase hex characters and adds a caller
partition to that binding. It is not authentication and grants no access. Do not expose
that partition or use it as a substitute for authorization. Cursors are opaque and have no
independent authority.

Known errors are `400 invalid_usage_query`, `410 usage_query_expired`,
`422 usage_query_too_large`, and `503 usage_source_unavailable`. Expiration requires restarting
the complete query; oversize requires a narrower window or filters. Database/Redis failures
and malformed source data must not become empty success. Responses use `Cache-Control:
private, no-store`.

Verification covers real PostgreSQL integration/clipping, historic dimensions, sparse zeros,
open/archive rows, precision and budget limits; real Redis checks cover stable pagination,
identity/query binding, expiration and failure. HTTP checks cover validation, guards and
exported DTO schemas. Regenerate the clients together with other API DTO changes and require
a second uncached generation to produce no changes. These checks do not establish production
load capacity or historical completeness.

## Organization activation evidence

`GET /api/admin/organizations/{organizationId}?include=activation`
adds an optional `activation` section to the existing flat detail. A missing organization
returns 404. Omitting this selection avoids the facts query and field.

```json
{
  "activation": {
    "organizationId": "de80ad96-daa5-48a6-ad18-fb58aff3bbbf",
    "lastBoxCreatedAt": "2026-10-20T01:00:00.000Z",
    "lastBoxModifiedAt": "2026-10-20T01:00:01.000Z",
    "observedAt": "2026-10-20T02:00:00.000Z"
  }
}
```

`lastBoxCreatedAt` is the maximum retained Box creation or warm-pool claim time.
`lastBoxModifiedAt` is the maximum observed successful-start or accepted-deletion
time. Start means entering `started`; delete means the first request setting
`desiredState=destroyed`. Stops, label changes, retries, deletion completion and
delayed physical cleanup do not advance them. Use current Box state to identify
running Boxes; timestamps do not measure ongoing execution or user interaction.
Automatic lifecycle actions also count.

`BoxRepository` records these times after the Box write commits, with one
upsert that only moves a time forward. Box transactions never wait
on the facts row, and the follow-up waits at most one second for it before giving
up. The update is best effort: a failure, or a process exit right
after the commit, loses that advance and only logs it. A later event of the same
kind repairs it. Writes that bypass `BoxRepository`, such as raw SQL, are not recorded.

Facts survive Box deletion and are removed with the organization; a deleted
organization's foreign key rejects new writes. Preexisting organizations only
backfill maximum retained creation time; past start/delete history is unavailable
and remains null. Null therefore means none was recorded, not proof of inactivity:
compare the organization's `createdAt` with the tracking start, which is when the
facts migration ran in that environment. Box transfers
between real organizations do not move times to the destination.

The pre-deploy migration creates the facts table and backfills retained Box
creation evidence; it installs no triggers. It requires a transaction, limits lock
waits to five seconds and individual statements to sixty seconds, and rolls back
if either limit is exceeded; organization writes wait until the backfill commits.
During a rolling deploy, instances on the previous revision write no facts; the
next recorded creation, start or deletion request creates any missing row. Production migration
duration is unmeasured. Metadata validation rules and administrator authorization
apply to this selection. See the [activation design](../../docs/contributing/investigations/organization-activation-facts.md#review-follow-up-optimistic-updates-outside-box-transactions)
for the source evidence, concurrency model and verification boundaries.

## Onboarding persistence

See [organization onboarding](onboarding.md) for the profile, personal prompt
draft and idempotent handoff API contracts, migration order, and frontend integration behavior.

## Retention-policy reads and login activity

Retention-policy workers reuse the existing Backoffice Admin credential for
`GET /api/admin/organizations`. The endpoint retains its existing Admin authorization;
no policy-specific key or role is required. Registration reads use `createdFrom`, `createdTo`
and `boxCountScope=all`. Exact-org reads use `organizationId=<UUID>&boxCountScope=all`.

R2 reuses successful `user.login` records from `LoginEventRecorder`, with the user ID in
`correlation.id` and the observation time in `event.timestamp`. The existing recorder logs
first API use of each newly issued token, including refreshed tokens. R2 therefore treats a
qualifying token-use record as return activity; it does not require a new interactive login.
No additional event or issuer-claim configuration is required. Redis/log failures can omit records.

## Box creation and readiness

`POST /v1/{prefix}/boxes` returns the persisted Box identity with HTTP 201 without
waiting for runner startup. A new Box can report `configured`; an already running
warm Box reports `running`. Cloud startup continues in the background.

Callers retain `box_id` and observe that same Box until it is ready. The explicit
start endpoint retains its existing startup wait; the Listener observes the original
ID and registers a JIT runner only after `running`. A lost creation response remains
an uncertain outcome and must not trigger a blind retry or adoption by name.

## Native hosted CI Listener (in development)

`CiListenerService` imports the shared TypeScript `Listener` directly. Every API
replica can receive signed webhooks; a PostgreSQL execution lease selects one
scheduler. No CI process, private RPC channel or API-container state volume is
required. The shared journal retains original execution identities across restarts.

The host modules divide responsibilities:

| Module                   | Responsibility                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `ci-native-state.ts`     | Existing PostgreSQL pool, fixed App namespace, original binding and current owner authority |
| `ci-native-host.ts`      | Connected installation discovery, scoped GitHub credentials and binding-authorized inbox    |
| `ci-native-workers.ts`   | Internal BoxService creation/lifecycle and one-attempt JIT delivery                         |
| `ci-listener.service.ts` | API lifecycle, shared controller startup, ingress and shutdown                              |

Connect fixes the BoxLite organization/actor and GitHub installation. Jobs cannot
select another tenant. Discovery publishes catalog scopes before marking that binding
ready; readiness describes initialization, not available execution capacity.
Personal accounts use one runner pool per repository; organizations use the configured
selected, non-inherited runner group with the exact eligible repository inventory.
The group must already exist; automatic group provisioning remains unfinished.
The shared installation directory publishes successful catalogs independently.
An installation failure withholds that installation's new admissions and retains
its hints; other initialized accounts continue. Catalog requests run outside the
scheduler tick, with per-installation retry deadlines. A failed complete binding
index withholds admission until index recovery. This has local integration checks;
deployed dev acceptance is still pending.

### Original-resource and execution fencing

The shared journal keeps historical scopes, active allocations, quotas and external
operation intents. The native ledger uses `box-native/<allocation-id>` in the same
state table. BoxService's `onPersist` callback checks the current execution epoch,
original binding and owner, and records the actual Box ID in the Box transaction.
A denied or stale callback rolls back both rows. Commerce limits still apply;
providing the callback forces fresh Box creation.

Cleanup uses the known original Box ID and scope, even after admission is revoked.
A missing ownership record is an error. Only absence of the known original Box row
or a confirmed destroyed state permits the shared controller to mark it absent;
failed destruction does not. Physical capacity returns after original Box absence
is confirmed. Runner cleanup debt and the same-job dedup record remain until
GitHub runner absence is confirmed. An elapsed timeout or a completed notice does not prove
a running Box is idle.

The shared controller reconciles historical allocations before new demand.
One ordinary cleanup failure does not skip other workers; an absent Box's pending
runner cleanup does not hold physical capacity. Query failures retain capacity
and block that scope's admission. Lease loss, corrupt/conflicting state, abort
and pending credential retirement stop further work. These rules match standalone
Listener Boxes and recover from the existing PostgreSQL journal after restart.

API logs receive shared worker events with original binding, tenant, Box/runner,
trigger repository/run/job, state phases and effect. Clean exit 0 is informational;
unknown stop, error, unexpected deletion and deferred cleanup warn. Logs exclude
credentials and upstream error messages. They do not cancel CI, modify GitHub job
logs or infer a job's final status. See the
[event contract](../libs/ci-listener/README.md#worker-recovery-and-logs).

JIT configuration remains in memory until one delivery attempt. A durable claim in
the native ledger precedes private `.boxlite-jitconfig` content and its `.ready`
marker. Each upload rechecks the lease, original binding/owner, Box ID and runner
assignment after asynchronous resource lookup. Closing allocations reject admission.
Failed, cancelled and uncertain delivery attempts retain their claim. Requests reject
redirects and have a 30-second deadline. Runner credentials stay inside the API;
execution Boxes receive neither the App private key nor a BoxLite API Key.

### Personal and Organization Apps

`CiGitHubApp` shares authentication, connect verification and credential issuance
between both hosts. Hosted `CiGitHubService` selects one instance by account type
for new connect, and by the persisted client ID for existing work. The Personal
App requests repository Administration: Write and Actions: Read. The Organization
App requests organization Self-hosted runners: Write and Actions: Read, without
repository Administration. Both retain GitHub's default Metadata: Read and
subscribe to Workflow job events; neither needs Members: Read.

Both Apps share one PostgreSQL namespace, scheduling lease and BoxLite account
quota. Adding the Organization App does not double concurrency. Each scope has an
immutable original App association; missing or conflicting associations deny
execution. Original scopes are assigned to the original App once before the
association protocol activates. Do not replace that App or remove its credentials
while original cleanup work remains. New-connect role restrictions do not prevent
cleanup using the original App. Delivery recovery keeps separate App checkpoints.

### Hosted configuration and deployment

| Setting                                                          | Hosted API behavior                                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `CI_GITHUB_APP_CLIENT_ID` / `CI_GITHUB_APP_SLUG`                 | Personal App identity; required storage anchor when hosted CI is enabled                                                           |
| `CI_GITHUB_APP_CLIENT_SECRET`                                    | Optional secret reference for Dashboard browser connect; opaque single-line OAuth client secret, distinct from the RSA private key |
| `CI_GITHUB_APP_PRIVATE_KEY`                                      | Secret reference resolving to a private RSA PEM, at most 64 KiB; held in API memory                                                |
| `CI_GITHUB_WEBHOOK_SECRET`                                       | Secret reference resolving to the HMAC value described above; also enables delivery recovery                                       |
| `CI_GITHUB_ORG_APP_CLIENT_ID` / `CI_GITHUB_ORG_APP_SLUG`         | Optional Organization App identity, distinct from the Personal App                                                                 |
| `CI_GITHUB_ORG_APP_PRIVATE_KEY` / `CI_GITHUB_ORG_WEBHOOK_SECRET` | Organization App private-key and HMAC secret references; required together when that App is configured                             |
| `CI_GITHUB_ORG_APP_CLIENT_SECRET`                                | Optional Organization App OAuth secret reference for browser connect                                                               |
| `CI_SECRET_ENCRYPTION_KEY`                                       | Secret reference resolving to a canonical base64 encoding of 32 bytes for temporary connect state                                  |
| `CI_WORKER_CPUS` / `CI_WORKER_MEMORY_GB`                         | Defaults 2 CPUs / 2 GB; 1 GB = 1024 MiB                                                                                            |
| `CI_WORKER_IMAGE` / `CI_WORKER_GROUP_NAME`                       | Defaults `ghcr.io/actions/actions-runner:latest` / `boxlite-ci-runner`                                                             |

Hosted execution requires neither `BOXLITE_API_KEY` nor `CI_STATE_DIR`. The worker
label is fixed to `boxlite-ci-runner`; existing BoxLite authentication remains on
connect and Box APIs. Shared scheduling state uses the existing DataSource and
migration `1793700000000-add-ci-listener-state-migration.ts`, alongside the connect
migration `1793664000000`.

The committed mstage catalog declares these CI fields as optional API inputs.
When CI is configured, App identity and slug must be plain settings; all three
credentials must use mstage secret references. The deployment platform resolves
them into the API environment. Standalone Listener Boxes use their own private-file
configuration; the hosted API does not load secret files or accept their file inputs.
See [mdeploy CI configuration](../infra/mdeploy/README.md#hosted-github-ci-listener)
for reference syntax and deployment behavior.

Run Node 24 and use `make build:apps:api`. On GCP Cloud Run, background scheduling
requires CPU allocation while idle and at least one minimum instance. mdeploy adds
`cpuIdle: false` and a service-level minimum of one instance when hosted CI is configured;
unconfigured API deployments retain their existing defaults. This incurs idle instance
costs. The database lease handles restarts and overlapping replicas; minimum instances
do not guarantee that a process never restarts. These settings and formal hosted-App CI
still require dev deployment acceptance.

Apply `1793786400000-add-ci-web-connect-migration` and
`1793894400000-add-ci-account-selection-migration` before deploying the browser
connect endpoints, in addition to the existing connect/state migrations. The new
columns expand the same attempt table; Device Flow rows default to `device`.
Build both API and Dashboard artifacts for browser connect. On GCP, the API
Dockerfile bundles and serves both, so deploying that image updates the API and
Dashboard in one Cloud Run revision. The optional
`CI_GITHUB_APP_CLIENT_SECRET` reference enables the Dashboard grant without making
it mandatory for CLI-only deployments. GCP dev acceptance still needs the real
browser authorization, webhook and CI workflow checks after deployment.

### Hosted CI capacity

`GET/PATCH /api/v1/{organization-prefix}/ci/settings` uses the existing owner identity
and, for API keys, both Box write/delete permissions. Set `max_concurrent_jobs` to
`null` to inherit Commerce, `0` to pause new workers, or a nonnegative integer no
greater than the account allowance. A later plan downgrade clamps the configured
value. One BoxLite account shares this total across every connected installation
and repository; hosted capacity does not read `CI_WORKER_MAX`. Ordinary Boxes also
consume Commerce capacity, and the native Box creation transaction enforces that
final limit. Existing workers continue and recover after the limit is lowered.

The hosted `CiSettingsService` implements `CapacityProvider.resolve()`, while standalone
uses its fixed environment adapter. Policy versions and the execution index are
checked in the reservation transaction. Dashboard → CI → Runners shows and edits
this account total; Connects shows connected-account setup state.
Repository-specific limits are not available yet.

If another Box consumes the last Commerce slot after CI admission, the native
adapter records a definitive refusal for `BoxCreationLimitExceededError`
before `onPersist` starts. It also fences revocation before dispatch or a rejected
native persistence transaction. The durable original-operation fact shares the Box-ID
ledger key, preventing conflicting outcomes. The shared kernel can return the CI
reservation while keeping its queued notice, including after restart. A failed
proof write, generic HTTP error or uncertain persistence outcome keeps the
reservation for recovery. See the shared [worker recovery contract](../libs/ci-listener/README.md#worker-recovery-and-logs).

### Hosted CI management

`GET /api/v1/{organization-prefix}/ci/runners` uses existing organization Box-read
access: membership permits reading without a separate Box-read permission enum.
It accepts `page` (default 1) and `limit` (default 25, maximum 200), returns
`items`, `total`, `page`, `totalPages`, and `capacity`, and reuses the safe Box DTO conversion.
Optional `name` is a string of at most 128 characters. It trims outer whitespace
and matches a case-insensitive literal substring before count and pagination;
SQL wildcard characters have no special meaning. Capacity remains unfiltered.
Original native CI ledger IDs establish JIT identity; matching names do not.
Both original scope and current Box organization must match. Destroyed Boxes are
excluded; stopped/error/transitional Boxes remain visible until cleanup completes.

`capacity` contains `available`, `used`, `max_concurrent_jobs`, `commerce_limit`,
and `effective_limit`. Members may read this aggregate without owner settings access.
It contains no connection identities or credentials. `used` counts catalog-referenced
active allocations in this hosted namespace and original organization whose Box
phase is not `absent`, including reserved creation and cleanup. It is independent
of inventory pagination and Box row existence. The read-only repeatable-read
transaction validates scope and allocation records without borrowing a leader lease;
broken references or provider failures return errors rather than a zero/unlimited guess.
Owner writes retain the existing PATCH settings endpoint and authority checks.

`PATCH /api/v1/{organization-prefix}/ci/connections/{bindingId}` accepts only
`{ "allow_public_repositories": boolean }`, with the same owner and Box write/delete
key authorization as settings. It returns 204; a changed policy advances generation,
sets provisioning and writes the existing durable inventory wake in one transaction.
An identical value preserves state and generation but still rechecks key expiry.
Unknown/foreign bindings return 404; disabled connections return 409. Binding,
verified GitHub identity, original actor, quota, authorization attempts and workers
remain intact. Delivered jobs continue through original-resource recovery and
cleanup; workers not yet given JIT may retire when old admission is rejected.
Organization runner-group public access must still match on GitHub. The endpoint
does not mutate GitHub configuration. See the [update design](../../docs/contributing/investigations/2026-11-06-ci-connection-update.md).

`DELETE /api/v1/{organization-prefix}/ci/connections/{bindingId}` requires the
current owner and both Box write/delete key scopes. Unknown or foreign bindings
return 404. Success returns 204, disables the binding, and advances its generation
once; repeated deletion is idempotent. Settings omit disabled connections.
The transaction cancels stored unfinished attempts for the same organization/App
and clears temporary credentials, locking attempts before the binding to match
finalization. A subsequent verified request may reactivate that same organization's
binding with a fresh generation; another tenant cannot claim it.

Admission already holding its binding lock may finish before deletion commits.
Later admissions fail; original workers retain cleanup authority and the shared
quota remains unchanged. Deletion does not uninstall the GitHub App or cancel a
GitHub workflow. These management routes also support `/api/v1/ci/...` with the
authenticated organization. Design: [CI Dashboard navigation and connection lifecycle](https://linear.app/polygala/issue/BUI-1471/ci-dashboard-navigation-and-connection-lifecycle).

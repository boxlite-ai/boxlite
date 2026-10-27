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
The same sanitized attributes reach PostHog through the client shared with HTTP metrics.
Activity does not require the optional logging ClickHouse instance.

| Event | Recorded by | Outcomes |
| --- | --- | --- |
| `user.registration` | `UserService.create`, through `recordOutcomes` | requested, success, exception |
| `user.login` | `LoginEventRecorder` | success |
| `org.active` | `OrganizationActivityInterceptor`, best effort on a person's first request in an organization each UTC hour; a process exit or lost Redis acknowledgment after claiming the key can suppress the rest of that hour | success |
| `box.create`, `box.start`, `box.stop`, `box.delete` | `BoxService`, the auto-stop and auto-delete crons | requested |
| `box.create`, `box.start`, `box.stop`, `box.delete` | `JobStateHandler`, when the runner job finishes | success, exception |
| `box.exec`, `box.file_upload` | `BoxliteProxyController`, for `POST …/exec` and `PUT …/files` | requested, then success or exception by the response status |
| `tunnel.create` | `BoxliteProxyController`, through `recordOutcomes` | requested, success, exception |
| `api_key.create` | `ApiKeyService`, including platform bootstrap | requested, success, exception |
| `volume.create`, `volume.delete` | `VolumeService`, shared by REST and Dashboard | requested, success, exception |
| `box.open` | Authenticated preview proxy through the last-activity endpoint | success (sampled anonymous presence) |

Volume success means the command entered the lifecycle queue, not that backing storage is ready or deleted.
Force-deleting a missing or already-deleting volume is a no-op and emits no event. Mutation failures carry fixed
categories, never resource names, key material or database error messages. API-key correlation is a fresh UUID
for the attempt; volume correlation is the volume ID.

Browser presence requires an admitted GET with `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`.
The proxy sends `X-BoxLite-Preview-Open: 1` to the existing last-activity route; only the proxy role may trigger
an observation. The API derives organization from the stored box and leaves user/actor unknown. Assets, iframes,
polls and denied requests do not emit it; admission does not prove the guest rendered successfully.
Per-box proxy singleflight and a separate 60-second cooldown bound attempts (including failed delivery), with a
two-second request timeout. API Redis NX/EX 60 deduplicates across replicas; Redis failure suppresses the event.
Forwarding continues on telemetry failure. Reloads collapse and delivery is best effort: this is neither a
navigation count nor a visitor count, and it does not add to requested-operation totals.

The preview marker is internal to the proxy/API exchange and is absent from the public OpenAPI parameters;
ordinary heartbeat clients keep their existing signature and need no new header.

At most 1,440 preview rows per continuously active box/day add 0.15552 GB over 400 days at 270 bytes/row.
Before production, measure seven days of preview-active minutes and actual row sizes with other new events.
Recheck the 20% storage budget as traffic grows; provision capacity or reduce retention before exceeding it.

For v0 runners, which have no START_BOX job, BoxManager records an existing start's terminal
`box.start` outcome after its state is persisted. Returned runner errors, startup timeouts and
thrown starts yield `runner_start_failed`; v2 outcomes remain with JobStateHandler. Initial
creation and repeated terminal syncs do not emit an extra start outcome.
Both accepted-start writes atomically set internal `startEventPending`; it survives runner
instance loss and recreation across sync invocations. Entity invariants clear it in the
terminal or superseding state write, including v2 job completion. Logging remains best effort,
not an exactly-once outbox. Run the pre-deploy migration before upgrading the API; roll back
the API before dropping the column. Already in-flight UNKNOWN/CREATING operations from before
the upgrade have no marker and cannot be reliably backfilled as starts.

The API CI job sets `BOXLITE_TEST_POSTGRES_URL` to its PostgreSQL service so the start-intent
migration's up/down and existing-row defaults are exercised. Set this variable to a disposable
local PostgreSQL database when running `make coverage:api`; without it, that integration spec
is skipped. Caller-attribution tests cover JWT and API-key administrators and both proxied
exec/upload error categories without changing authentication policy.
Integration fixtures that build their schema with explicit migrations must also apply
the start-intent migration before querying the `Box` entity, including the usage ledger fixture.

Box events go through `src/box/utils/box-business-event.util.ts`: the request and the outcome are
recorded in different places, so one call cannot cover both. A proxied call that fails with an
HTTP status records `http_<status>`; a client that disconnects first records `client_closed`.
An already finished/closed response is accounted for after the box lookup, and outcome
listeners are removed once recorded. Organization-presence Redis warnings use fixed categories,
not raw error strings.

An event names its entity by `correlation.id`: the user id for `user.*` and `org.active`, the box
id for box and tunnel events (volume ID or an API-key attempt UUID for those mutations). It also carries `organization.id`, so an organization's activity
can be counted from the log alone. `user.login` has none, since a login spans organizations, and a
registration carries its default organization on success only.

### Querying Activity in PostHog

The producer uses the existing `POSTHOG_API_KEY`, `POSTHOG_HOST` and `POSTHOG_ENVIRONMENT` settings.
Without the key or host, analytics is disabled while business operations and operational logs continue.
AnalyticsService owns disabled-source and capture-error handling; the interceptor skips request extraction
when analytics is disabled.
Delivery is queued and best effort; application shutdown waits up to five seconds for the shared client.
SDK diagnostics are separate from the sanitized business-event payload. Retention follows the PostHog
project; BoxLite does not provision a second store or guarantee 400 days of history.

An Activity consumer needs the PostHog **API origin** (for example `https://us.posthog.com`, distinct
from an ingestion origin such as `https://us.i.posthog.com`), project ID and a backend-only personal
API key scoped to that project with **Query Read** permission. The producer's project capture key
cannot authorize reads. Keep the query key out of browser code.

Send a `POST /api/projects/<project-id>/query/` request with `Authorization: Bearer <query-read-key>`
and `Content-Type: application/json`. For example, this illustrative HogQL query counts requested
operations and failures in a half-open UTC window, grouped into Shanghai days:

```json
{
  "name": "customer_activity_days",
  "query": {
    "kind": "HogQLQuery",
    "query": "SELECT toString(toDate(toTimeZone(timestamp, 'Asia/Shanghai'))) AS day, countIf(properties['event.outcome'] = 'requested') AS operations, countIf(properties['event.outcome'] = 'exception') AS failures FROM events WHERE properties.activity_schema = '1' AND properties.environment = '<producer-environment>' AND properties['organization.id'] = '<organization-id>' AND timestamp >= fromUnixTimestamp64Milli(1793030400000) AND timestamp < fromUnixTimestamp64Milli(1793203200000) GROUP BY day ORDER BY day DESC LIMIT 32"
  }
}
```

Replace the example organization/environment and bounds with validated values; never interpolate raw
request text into SQL. Use explicit limits, bounded requests and strict response validation. PostHog
returns `columns` and positional `results` arrays, unlike ClickHouse's JSON object rows. See the
[Query API](https://posthog.com/docs/api/queries) and [supported SQL functions](https://posthog.com/docs/sql/clickhouse-functions).
The example documents the contract; it has not been executed against a live PostHog project.

| Activity field | PostHog value |
| --- | --- |
| Event/time | `event`, `timestamp` (the original event emission time) |
| Outcome/entity | `properties['event.outcome']`, `properties['correlation.id']` |
| Organization/person | `properties['organization.id']`, optional `properties['user.id']` |
| Actor/reason/failure | `properties['actor.kind']`, `properties['event.reason']`, `properties['exception.type']` |
| Client/auth | `properties['client.source']`, `properties['sdk.version']`, `properties['auth.method']` |

Always filter `properties.activity_schema = '1'` and the exact configured producer environment, including
nested queries. Legacy `api_*` events remain available for existing analytics but are not Activity rows.
Organization-scoped events also carry the existing `organization` group. Unknown people use namespaced
anonymous/platform distinct IDs with person profiles disabled; do not treat those IDs as people.
`user.login` has no organization: associate it only with users observed in the requested organization
and time window. Registration has an organization only on success.

For steps, select the fields above, group equal steps per minute, and request the UI limit plus one
to report truncation. Include requested/exception outcomes plus successes for `org.active`, `box.open`,
`user.login` and `user.registration`; ordinary success records confirm requests already listed.
Only requested outcomes contribute to operation totals. Preview presence remains anonymous and sampled.

### Who asked: the operation context

A service that records an event takes a required `ctx: Context` (`src/common/context/`) from its
caller. The compiler rejects a call that omits it.

```ts
return this.userService.create(createUserDto, Context.admin())
await this.stop(event.boxId, undefined, Context.platform(PlatformReason.ORG_SUSPENSION))
```

| Context | `actor.kind` | `event.reason` |
| --- | --- | --- |
| `Context.user(actor?)` | `user` | — |
| `Context.admin(actor?)` | `admin` | — |
| `Context.platform(reason)` | `platform` | the `PlatformReason`, such as `auto_stop` or `auto_resume` |

- Only the platform gives a reason; user and admin contexts have none.
- A request handler names its caller with `@UserContext() ctx`, or `requestContext(req)` where it
  already holds the request: `user.id`, `auth.method` (`api_key` or `jwt`) and, when the client
  sends `X-BoxLite-Source` or `X-BoxLite-SDK-Version`, `client.source` and `sdk.version`. Values must be 1–64 ASCII
  characters using letters, digits, `_`, `.`, `+`, `/`, space or `-`; invalid values are omitted.
- The boot-time admin seed registers as `Context.platform(PlatformReason.BOOTSTRAP)`.
- Job outcome events carry no context: the runner reports after the request has ended.
- Admin box recovery and user creation retain the authenticated administrator in `Context.admin(actor)`.
- The shared request context selects admin/user from the authenticated role, including tunnels,
  proxied exec/uploads and decorated mutation handlers. Client headers cannot choose actor kind;
  requested and terminal events retain the same caller identity. Service callers with no person
  keep their existing user context without an actor; explicit admin/platform decisions stay separate.
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

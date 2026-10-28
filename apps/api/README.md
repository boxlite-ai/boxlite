# API

The NestJS control-plane service. See the [apps hub](../README.md) for how it fits with the
other services and [`API.md`](../API.md) for its interfaces.

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

| Event | Recorded by | Outcomes |
| --- | --- | --- |
| `user.registration` | `UserService.create`, through `recordOutcomes` | requested, success, exception |
| `user.login` | `LoginEventRecorder` | success |
| `box.create`, `box.stop`, `box.delete` | `BoxService`, the auto-stop and auto-delete crons | requested |
| `box.create`, `box.stop`, `box.delete` | `JobStateHandler`, when the runner job finishes | success, exception |

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

| Context | `actor.kind` | `event.reason` |
| --- | --- | --- |
| `Context.user()` | `user` | — |
| `Context.admin()` | `admin` | — |
| `Context.platform(reason)` | `platform` | the `PlatformReason`, such as `auto_stop` or `bootstrap` |

- Only the platform gives a reason; user and admin contexts have none.
- The boot-time admin seed registers as `Context.platform(PlatformReason.BOOTSTRAP)`.
- Job outcome events carry no context: the runner reports after the request has ended.
- Add caller-decided fields to `Context`, not new service parameters.

## Admin organization metadata

System administrators read registration fields on the existing organization routes.
Authenticate with `Authorization: Bearer <admin-api-key>` or an administrator JWT;
an ordinary organization's API key does not grant system-wide access. These internal
routes use one contract: no view selector, capability probe, or capability response header.

Upgrade every producer instance before enabling the updated consumer. Old list cursors
must be discarded because the default ordering now uses creation time and ID. Existing
callers needing current-month usage must explicitly select `include=usage`. Roll back
consumers before producers; mixed-version traffic is not supported during activation.

- `GET /api/admin/organizations` returns a bounded page with `createdAt`,
  stored `createdBy`, nullable current `creator`, member/Box counts and impact.
  `q` searches name or exact ID. `createdFrom` is inclusive and `createdTo` exclusive;
  timestamps require an offset and at most millisecond precision. `limit` is 1–200 (default 50).
- `GET /api/admin/organizations/{organizationId}` returns flat organization
  details with registration, member/Box pages and impact. A missing organization returns 404.
  `memberCursor`, `boxCursor` and `sectionLimit` page each section. Explicit `include=usage`
  adds existing UTC month-to-date usage; `include=activation` adds retained activation
  evidence. Comma-separated `include=usage,activation` selects both. Omitting `include`
  reads neither section.

`createdAt` is organization creation time, not user signup or first Box creation. `createdBy`
is the stored creator association, independent of current membership. Account linking
rewrites it to the primary user ID, so it is not an immutable historical identity.
When a creator no longer exists and the organization survives, `creator` is null; an existing
user without an email has `creator.email:null`. Names and email describe current identity.
Pages read live data and exclude deleted organizations.

List order and cursor seek both use creation time truncated to milliseconds plus
UUID, ascending. Cursors bind `q` and date filters; changing them returns 400. Unknown
parameters (including the removed view selector), invalid dates, UUIDs, and incompatible
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

Existing organization operation IDs and response models are retained. Registration fields
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

See [organization onboarding](src/organization/ONBOARDING.md) for the profile, personal prompt
draft and idempotent handoff API contracts, migration order, and frontend integration behavior.

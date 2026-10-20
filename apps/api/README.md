# API

The NestJS control-plane service. See the [apps hub](../README.md) for how it fits with the
other services and [`API.md`](../API.md) for its interfaces.

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

System administrators can read organization creation metadata without querying usage.
Authenticate with `Authorization: Bearer <admin-api-key>` or an administrator JWT;
an ordinary organization's API key does not grant system-wide access.

Existing interfaces expose some of these fields, with different access and query boundaries:

| Existing route | Access and reuse boundary |
| --- | --- |
| `GET /api/organizations` and `/{organizationId}` | JWT only; return `createdAt/createdBy`, but list only the caller's organizations. |
| `GET /api/organizations/by-box-id/{boxId}` | Accepts an Admin API key and returns `createdAt/createdBy`; requires a Box, so it cannot enumerate new organizations that have no Boxes. |
| `GET /api/admin/organizations` and `/{organizationId}` | Accept Admin API keys; list has no creation fields/date filter, and detail always reads current-month usage. |

The metadata routes reuse the admin overview service and stored organization rows.
Separate routes preserve the old response contracts and make usage opt-in:

- `GET /api/admin/organizations/metadata` returns a bounded page of organizations with
  `createdAt`, stored `createdBy`, nullable current `creator`, member/Box counts and impact.
  `q` searches name or exact ID. `createdFrom` is inclusive and `createdTo` exclusive;
  timestamps require an offset and at most millisecond precision. `limit` is 1–200 (default 50).
- `GET /api/admin/organizations/{organizationId}/metadata` returns `{item: ...}` with the same
  registration fields, member/Box pages and impact. `{item:null}` means the organization is missing;
  an HTTP 404 means the route is unavailable. `memberCursor`, `boxCursor` and `sectionLimit`
  page each section. Only explicit `include=usage` queries and returns UTC month-to-date usage.

`createdAt` is organization creation time, not user signup or first Box creation. `createdBy`
is the organization's stored creator association, independent of current membership. Account
linking rewrites it to the primary user ID, so it is not an immutable historical identity.
When a creator no longer exists and the organization survives, `creator` is null; an existing
user without an email has `creator.email:null`. Names and email describe current identity.
Pages read live data and exclude deleted organizations; this is not a retained historical
census or an activation timeline.

List order and cursor seek both use creation time truncated to milliseconds plus UUID, ascending,
so database microseconds cannot cause a repeated or skipped row. Cursors bind `q` and date filters;
changing those filters returns 400. They follow the existing base64 cursor convention, carry no
authorization, and require the normal admin guards on every request. Unknown parameters return 400.
Legacy `/api/admin/organizations` and `/{organizationId}` keep their original response contracts
and default usage behavior. Deploy these new routes before consumers that depend on them.
On an older server, `/organizations/metadata` can match the legacy UUID detail route and return
400; do not treat that response as an empty list or retry through the usage-reading legacy detail.
Metadata validation errors therefore include the stable code `invalid_organization_metadata_query`
in their 400 response, covering query parameters, cursors and the detail organization UUID.
Consumers can classify this code as a caller error; a 400 without it may mean an unsupported
route and should be treated as an upstream compatibility failure. The legacy routes do not add
this code. HTTP regression checks cover each metadata failure category and the legacy UUID error.

For organizations created on October 20 in UTC+08:00, use the equivalent half-open UTC interval:

```bash
curl --get "$BOXLITE_API_URL/api/admin/organizations/metadata" \
  --header "Authorization: Bearer $BOXLITE_API_KEY" \
  --data-urlencode "createdFrom=2026-10-19T16:00:00Z" \
  --data-urlencode "createdTo=2026-10-20T16:00:00Z" \
  --data-urlencode "limit=50"
```

Keep the same filters when following `nextCursor` until it is null. To inspect one organization
without usage, call `/api/admin/organizations/{organizationId}/metadata?sectionLimit=50`;
continue `members.nextCursor` and `boxes.nextCursor` independently using `memberCursor` and
`boxCursor`. Unknown parameters, invalid dates/UUIDs, and incompatible cursors return 400.
Invalid credentials return 401; an authenticated non-admin caller is denied with 403.

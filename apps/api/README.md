# API

The NestJS control-plane service. See the [apps hub](../README.md) for how it fits with the
other services and [`API.md`](../API.md) for its interfaces.

## Generated clients

Controller and DTO changes, including administrator endpoints such as runner
drain, must include their generated TypeScript and Go clients. From `apps/`, run
the same targets as [API client drift CI](../../.github/workflows/api-client-drift.yml):

```bash
yarn nx run api-client:generate:api-client
yarn nx run api-client-go:generate:api-client
yarn nx run analytics-api-client:generate:api-client
```

Use the generator version pinned in `apps/openapitools.json` and a local Redis
instance for schema export. These targets apply required postprocessing; commit
the resulting models, methods, schema, manifests and docs together. Repeat
generation after committing: all three client directories must stay clean.

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

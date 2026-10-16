# API

The NestJS control-plane service. See the [apps hub](../README.md) for how it fits with the
other services and [`API.md`](../API.md) for its interfaces.

## Image registry admission

`ImageAdmissionService` checks tenant-supplied image references before catalog lookup
or job creation. `BOXLITE_IMAGE_REGISTRY_ALLOWLIST` configures exact registry
`host[:port]` matches; when unset or empty, the built-in list applies. Curated image
selectors bypass this check.

Admission does not resolve registry names or filter their resulting IP addresses.
An explicitly allowlisted `registry.corp.example:5000` remains allowed when it resolves
to a private address, as does an explicitly allowlisted IP and port. The allowlist
therefore trusts the selected registry names and their DNS resolution.

Local SDK and CLI pulls follow the [runtime registry configuration](../../docs/guides/image-registry-configuration.md#registry-addresses-and-proxies)
without the control plane's allowlist.

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

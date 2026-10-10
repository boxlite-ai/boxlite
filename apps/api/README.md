# API

The NestJS control-plane service. See the [apps hub](../README.md) for how it fits with the
other services and [`API.md`](../API.md) for its interfaces.

## Business events

`recordBusinessEvent` (`src/common/utils/business-event.util.ts`) writes one structured log record
per business event; the attributes reach OTLP through nestjs-pino, where alerts query them.

| Event | Recorded by | Outcomes |
| --- | --- | --- |
| `user.registration` | `UserService.create` | requested, success, exception |
| `user.login` | `LoginEventRecorder` | success |
| `box.create`, `box.stop`, `box.delete` | `BoxService`, the auto-stop and auto-delete crons | requested |
| `box.create`, `box.stop`, `box.delete` | `JobStateHandler`, when the runner job finishes | success, exception |

### Who asked: the log context

`actor.kind` comes from the entry point, not from a service parameter. The entry point runs the
service call inside `runWithLogContext` (`src/common/utils/business-event-context.ts`), an
`AsyncLocalStorage` store that follows the call's awaits; the service reads `currentLogContext()`.

```ts
return runWithLogContext({ actorKind: 'admin' }, () => this.userService.create(createUserDto))
```

- Outside a context, `UserService.create` records no registration: that is how the boot-time admin
  seed stays out of the events. Box events are still recorded, without `actor.kind`.
- Forgetting the wrapper compiles and runs; only the actor goes missing. Give every new entry point
  a spec that reads `currentLogContext()` inside the mocked service call, as
  `boxlite-box.controller.business-event.spec.ts` does.
- Job outcome events carry no actor: the runner reports on another async chain, after the context
  has ended.
- Pass a new object to a nested `runWithLogContext`; never mutate the current store, which sibling
  async work shares.
- Event listeners started inside a run inherit its actor, so a listener that records its own
  business event must set its own context.

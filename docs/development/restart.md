# Box Restart Policies

BoxLite supports restart policies for automatic recovery when a running Box VM
crashes while the embedding process is alive. BoxLite is an embedded library, not
a daemon, so crash monitoring runs inside the user process and stops when that
process exits.

This document describes the current in-process crash-restart path coordinated by
the runtime crash coordinator. Startup-time auto-restart of persisted crashed
boxes is intentionally out of scope for this phase.

## Architecture

Restart policy is implemented as an in-process crash-recovery pipeline. Health
checks detect shim process death and report it to the runtime crash coordinator;
the coordinator owns crash state updates, restart-policy evaluation, backoff,
and VM rebuilds.

```text
BoxImpl health check task
    |
    | shim process died
    v
mpsc::Sender<BoxID>
    |
    v
Runtime crash coordinator
    |
    | dedupe by BoxID
    | record Crashed state and exit metadata
    | evaluate RestartPolicy
    | wait with backoff
    v
RuntimeImpl::restart(expected_epoch)
    |
    v
fresh BoxImpl swapped into stable BoxHandle
    |
    | start()
    v
fresh BoxImpl reaches Running
    |
    v
coordinator rechecks lifecycle epoch and Running status
    |
    v
live StopInfo reset and the same snapshot persisted
```

## Runtime Flow

1. A Box starts with a health-check task when health checks are configured or
   auto-enabled by a restart policy.
2. The health-check task periodically pings the guest.
3. If the ping fails, the health-check task checks whether the shim process is
   still alive.
4. If the shim is alive, the task records health-check failure state. Guest
   unresponsiveness alone does not trigger restart policy.
5. If the shim process died, the task sends the Box ID to the runtime crash
   coordinator and exits.
6. The coordinator deduplicates notifications by Box ID.
7. The coordinator records the Box as `Crashed`, stores exit metadata, and
   evaluates the configured restart policy.
8. If restart is denied, the coordinator marks the Box `Stopped` with the
   appropriate `StopCause`.
9. If restart is allowed, the coordinator waits with exponential backoff and
   calls `RuntimeImpl::restart()` with the expected lifecycle epoch.
10. `restart()` transitions the Box through `Restarting`, swaps a fresh
    `BoxImpl` into the stable `BoxHandle`, and then starts it.
11. After `restart()` returns successfully, the coordinator rechecks the
    lifecycle epoch and the swapped-in `BoxImpl`'s `Running` status. It resets
    the live stop info and persists the same state snapshot.

Existing `LiteBox` values continue to work after a successful restart because
they point to the stable handle rather than directly to the old VM implementation.

## Detached Boxes

`detach=true` changes the Box lifetime, not the monitoring model. A detached
Box is skipped by runtime shutdown and can keep running after the embedding
process exits. The health-check task and crash coordinator still live inside the
embedding process.

After a runtime restart, startup recovery reads the PID file and can mark a live
detached Box as `Running`. It does not reconnect to the guest or start a new
health-check task at that point. Monitoring and restart policy resume after a
control-plane operation reattaches to the Box and initializes `LiveState`, such
as `exec()`.

This means `detach=true` plus a restart policy does not create daemon-style
self-healing while no BoxLite runtime is alive. It only restarts detected
crashes while a runtime is attached and monitoring the Box.

## Crash Coordinator

The crash coordinator is one background task per runtime. It owns:

- `mpsc::Receiver<BoxID>` for crash notifications.
- `HashSet<BoxID>` for per-box de-duplication.
- `JoinSet` for supervised crash/restart tasks.
- A task-ID map so completion, cancellation, and panic all release per-box
  de-duplication state.
- `Weak<RuntimeImpl>` plus cooperative-shutdown and forced-cancellation tokens.

Different boxes can still be handled concurrently. The coordinator spawns and
supervises each crash handler, then removes a Box ID from the pending set when
the task completes, is cancelled, or panics. Tasks are never detached from the
coordinator.

The coordinator task continues polling for new crash notifications while a box's
restart task waits in backoff. Crash handlers perform their synchronous database
and small per-box artifact operations inside the spawned task. Tasks hold only a
weak runtime reference and temporarily upgrade it when they need to read state,
write state, or call `restart()`.

Shutdown cancels the runtime token and stops accepting new crash notifications.
For a finite shutdown deadline, the coordinator gets up to five seconds to drain
cooperatively, bounded by the remaining shutdown time. If that grace period
expires, shutdown requests forced cancellation and stops waiting. The
coordinator aborts its supervised crash tasks when it next runs. Its handle
remains tracked so a later shutdown call can reap it. `shutdown(Some(-1))` waits
indefinitely and does not request forced cancellation. Synchronous work already
executing cannot be interrupted until it returns control to Tokio.

## Restart Policy Semantics

| Policy | Restart condition | Retry limit |
|--------|-------------------|-------------|
| `No` | Never restart after a crash. | N/A |
| `Always` | Restart after detected crashes. Manual stop is respected. | Unlimited |
| `OnFailure { max_retries }` | Restart when the exit code is non-zero or unknown, while the current retry count is below `max_retries`. | `max_retries` |
| `UnlessStopped` | Restart after detected crashes. Manual stop is respected because stale crash work cannot commit after lifecycle epoch changes. | Unlimited |

When a restart policy is set without a health check, BoxLite enables a default
health check so shim process death can be detected:

| Field | Default |
|-------|---------|
| `interval` | 5s |
| `timeout` | 10s |
| `retries` | 3 |
| `start_period` | 60s |

## State Model

Restart adds two runtime statuses:

- `Crashed`: the shim process died and the runtime has recorded crash metadata.
- `Restarting`: the runtime is rebuilding the VM after a crash.

```text
[Configured] --start()--> [Running] --stop()--> [Stopped]
      |                        |                 ^
      |                        | shim died       |
      |                        v                 |
      |                    [Crashed]--denied-----+
      |                        |
      |                  restart allowed
      |                        v
      +------------------[Restarting]--success--> [Running]
                               |
                               | cooperative shutdown / max retries /
                               | restart failed
                               v
                            [Stopped]
```

`StopInfo` stores the stop cause, exit code, exit time, restart count, and last
successful restart time. `last_restart_error` stores the most recent failed
restart attempt, if any.

Forced cancellation after the shutdown deadline can interrupt a crash task
before its final state commit. In that case, the database keeps the last state
that the task committed, such as `Crashed`, `Restarting`, or `Running`.

| Scenario | Final status | Stop cause |
|----------|--------------|------------|
| No policy or `RestartPolicy::No` | `Stopped` | `CrashedNoPolicy` |
| `OnFailure` with exit code `0` | `Stopped` | `Normal` |
| `OnFailure` retries exhausted | `Stopped` | `MaxRetriesExceeded` |
| Restart attempt failed but more retries remain | `Crashed` / `Restarting` | `RestartFailed` |
| Cooperative runtime shutdown during backoff | `Stopped` | `Normal` |
| Forced cancellation after the shutdown deadline | Last committed status | Last committed value |
| Successful restart | `Running` | stop info reset, `restarted_at` set |

## Backoff And Stale Restart Protection

Restart attempts use exponential backoff:

```text
100ms, 200ms, 400ms, 800ms, 1.6s, ... capped at 30s
```

Before committing an automatic restart, the crash path re-reads state. If a user
manually stopped, removed, or restarted the Box during backoff, the stale crash
work exits instead of overwriting the user's newer lifecycle operation.

Crash handling records the expected `lifecycle_epoch` when it first observes the
crash. Under the per-Box lifecycle lock, `restart()` rechecks the database and
starts a new VM only if the Box remains `Crashed` or `Restarting` at that epoch.
After the new `BoxImpl` reaches `Running`, the coordinator takes the same lock
and rechecks the live state at the same epoch before it resets `StopInfo`. It
updates the swapped-in `BoxImpl` first and persists the same snapshot so
existing `LiteBox` handles do not retain stale stop metadata.

## Startup Recovery Scope

`RuntimeImpl::new()` runs `recover_boxes()` to make persisted state consistent
before the runtime accepts new operations. This path cleans up stale process
state, reclaims per-box locks, recovers interrupted local snapshot operations,
and marks boxes whose verified or legacy shim PID is still alive as `Running`.
It does not reconnect to the guest or initialize `LiveState`.

Startup recovery does not evaluate restart policy or queue automatic restarts
for boxes that crashed while the embedding process was down. If no live shim
exists, recovery converts an interrupted `Restarting` state to `Stopped` with
`RestartFailed`; a valid crash report can instead produce `Failed`. A persisted
`Crashed` state is not startable until an explicit `stop()` acknowledges the
crash and moves the Box to `Stopped`.

## API Examples

Rust:

```rust
use boxlite::runtime::advanced_options::{AdvancedBoxOptions, RestartPolicy};
use boxlite::runtime::options::BoxOptions;

let options = BoxOptions {
    advanced: AdvancedBoxOptions {
        restart_policy: Some(RestartPolicy::OnFailure { max_retries: 3 }),
        ..Default::default()
    },
    ..Default::default()
};
```

Python:

```python
from boxlite import AdvancedBoxOptions, BoxOptions, RestartPolicy

options = BoxOptions(
    image="alpine:latest",
    advanced=AdvancedBoxOptions(
        restart_policy=RestartPolicy.on_failure(max_retries=3),
    ),
)
```

Node:

```ts
const box = await runtime.create({
  image: "alpine:latest",
  restartPolicy: { type: "on_failure", maxRetries: 3 },
});
```

## Current Limits

- Restart detection is in-process. If the embedding process exits, health checks
  and the crash coordinator stop.
- Startup-time evaluation of persisted crashed boxes is not included in this
  phase.
- Guest health-check failure only marks health state. It does not trigger
  restart policy unless the shim process is dead.
- Manual `start()` starts a stopped Box directly and does not evaluate restart
  policy.

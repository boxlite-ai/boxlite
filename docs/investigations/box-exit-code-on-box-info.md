# Publish the main command's exit code on box info

**Date:** 2026-09-18
**Status:** Implemented
**Issue:** POL-603 — cloud box info carries no exit code, so a command that succeeded and one that did not are indistinguishable

---

## Problem

`GET /v1/boxes/{id}` on BoxLite Cloud returns no exit code. A box whose main
command ran to completion and one whose main command failed both end up as
`status: stopped`, with nothing in the response telling them apart. For an
agent runtime this is the whole observability story of a workload: the box
_is_ the process, and the process's outcome is unreadable.

This is not a missing capability. The core has recorded the code all along —
the guest writes an exit file, `record_main_command_exit()`
(`src/boxlite/src/runtime/rt_impl.rs:51`) reads it into `BoxState.exit_code`,
and the local `boxlite serve` publishes it on the same REST shape
(`src/cli/src/commands/serve/mod.rs:1118`). The Rust REST client already parses
the field and carries a compatibility branch for servers that omit it
(`src/boxlite/src/rest/types.rs:385-389`).

A same-shape comparison — identical bare-REST call sequence, identical `cmd`,
only the base URL differs — isolates where it is lost:

| Target                       | Main command         | `exit_code`  |
| ---------------------------- | -------------------- | ------------ |
| local `boxlite serve` 0.10.2 | `exit 0` / `exit 42` | `0` / `42`   |
| Cloud                        | same                 | field absent |

So the value exists, is durable, and is already on the wire format. Only the
cloud path never carried it.

## Where it was lost

| Layer                      | Before                                                                |
| -------------------------- | --------------------------------------------------------------------- |
| core (Rust)                | records and persists it                                               |
| `openapi/box.openapi.yaml` | `Box` schema does not declare `exit_code`                             |
| C FFI / Go SDK             | `CBoxInfo` / `BoxInfo` have no such field — the runner cannot read it |
| runner's box info          | `BoxInfoResponse` reports state only                                 |
| API                        | no mapping, nothing to map                                           |

## Design

### The runner answers; the control plane does not keep a copy

The runtime records the code when the guest's init exits and keeps it in the
box's own record, so the runner can answer for as long as the box lives there.
`GetBoxInfo` reads it off the same `GetInfo` snapshot it reads the state from
(`apps/runner/pkg/boxlite/client.go`), and the API asks the box's runner when a
tenant reads that box.

Storing a copy in the control plane was the first shape of this change, and it
was rejected on review. The argument against it is not the column's cost; it is
that a copy can only ever be as good as the one delivery that fills it, and
that delivery is conditional. `UpdateBoxState` has a single call site
(`apps/runner/pkg/services/box_sync.go`), reached only when the runner's state
differs from the control plane's. When our state is already `stopped` — the
condition POL-606 reports, a box serving traffic while the API shows
`stopped` — the states match, nothing is reported, and the code never leaves
the runner. Reading on demand does not depend on that delivery.

Two consequences follow, and both are deliberate:

- **An unreachable runner reads as "no exit code recorded."** The read degrades
  to absent rather than failing the box response around it, so a runner outage
  does not take down every other field. In that window absence is a wrong
  answer, not a missing one. Failing the whole read instead would be worse.
- **A box that has migrated has no exit code at all.** Migration recreates the
  box on the target runner with a fresh `BoxState` and destroys the source, so
  `exit_code`, `started_at` and `error_reason` are all lost with it. That is a
  pre-existing gap, tracked in #1551, not something this change introduces.

### A stop records a code too

The code is how the main command ended, not only whether it ended by itself.
Stopping a box signals that command — `SIGTERM`, then `SIGKILL` after a grace
period (`src/guest/src/container/lifecycle.rs`) — and the guest records the
result the same way it records a self-chosen exit, folding a signal into
`128 + n` through `ExitStatus::shell_code()`.

Both reachable shapes were verified against a local `boxlite serve`: a command
trapping `SIGTERM` and exiting `7` reads back as `7`, while `sh -c 'sleep 600'`
reads back as `137`. There is no third — the main command is the container's
init, and an unhandled `SIGTERM` to PID 1 is dropped by the kernel, so either
the command handles it and chooses its own code or `SIGKILL` ends it.

So the field is not a "did it fail" flag, and `137` is not a fixed answer for a
stop. A caller that wants "did my workload fail" reads this together with
whether it asked for the stop.

### `0` is a value, not an absence

`CBoxInfo` spells absence as `0` for `pid` and `started_at`. An exit code
cannot follow that convention: `0` is precisely the answer that distinguishes a
command that succeeded from one that did not. The FFI therefore carries an
owned pointer, null for absent, released by `free_box_info` — the same shape
`CBoxInfo` already uses for `network`:

```c
int *exit_code;  // null when the runtime recorded none
```

A value plus a separate flag would work too, and was the first shape here. A
pointer is better because it makes the misuse unrepresentable rather than
merely documented: a caller that ignored the flag would read a plausible `0`,
while there is no value to misread when the field is null.

Each layer keeps the distinction in its own idiom — `*int` in Go, an optional
`number` in the API, and an absent JSON field on the wire. Inside the API the
value is passed through rather than tested, all the way to the REST mapper: a
truthiness check anywhere on that path would silently erase every successful
run. `null` is coalesced once, where the runner's JSON enters
(`BoxExitCodeService`), so no layer above it has to consider the shape.

### Only on a tenant's read

The runner call lives in `toBoxDtoWithExitCode`, which only the two endpoints
that answer a tenant's read of one box use. `toBoxDto` itself is untouched,
and that separation is the point: it is on the event path — `NotificationService`
converts through it for every `BoxEvents.STATE_UPDATED`, and
`BoxStateWaiterService` for every resolution — and a box reaching STOPPED is
exactly what fires those. Reading there would put a cross-service round trip
in front of every stop notification, and make each one wait out the timeout
precisely when the runner is what went wrong. Two tests hold the line: the
event path must not call the runner, the read path must.

Listing boxes does not carry the field either. A list would fan out to one
runner call per box, and the field is optional in the spec, so omitting it
there is conformant. The schema says so explicitly, because a client that read
a list and saw no `exit_code` would otherwise conclude none was recorded.

The read is also skipped for any box that is not `stopped` or `error`. A box
that is up, coming up, or already destroyed has no exit code to report, so
asking costs a round trip that can only answer "none".

That the answer really is "none" is the runtime's doing, not the gate's:
`init_live_state` clears `exit_code` when a box starts, the way docker clears
`ExitCode` (`src/boxlite/src/litebox/box_impl.rs:1282`). Verified directly —
a box stopped with `137` reports it, and reports nothing once started again.

This is worth naming, because the stored-copy design had to reimplement that
rule in the control plane, across all three writers of box state, and a box
that missed any one of them would answer with the previous run's code while it
was up and serving. Reading from the runtime inherits one rule that already
exists instead of keeping a second copy of it in sync.

## Changes

**FFI / SDK** — every binding, so `box.info()` answers in each language

- `sdks/c/src/info.rs` — `CBoxInfo.exit_code` as an owned `*mut c_int`, allocated in `from_box_info` and freed in `free_box_info`
- `sdks/c/include/boxlite.h` — regenerated header
- `sdks/go/info.go` — `BoxInfo.ExitCode *int` and its cgo conversion
- `sdks/node/src/info.rs` + `sdks/node/lib/native-contracts.ts` — `JsBoxStateInfo.exitCode`
- `sdks/python/src/info.rs` — `BoxStateInfo.exit_code`, also in both `__repr__`s
- `docs/reference/{nodejs,python}/README.md` — the `state` field's documented shape

**runner**

- `pkg/boxlite/client.go` — `GetBoxInfo` returns state and exit code from one snapshot
- `pkg/backend`, `pkg/models`, `pkg/services/box.go` — carry it through
- `pkg/api/controllers/box.go` — `BoxInfoResponse.exitCode`, a `*int` with `omitempty`

**API**

- `box/services/box-exit-code.service.ts` — the runner read, with the state gate and the degrade-to-absent rule
- `box/services/box.service.ts` — `toBoxDtoWithExitCode` for a tenant's read; `toBoxDto` and the list are untouched
- `box/dto/box.dto.ts`, `boxlite-rest/dto/box-response.dto.ts`, `boxlite-rest/mappers/box-to-box.mapper.ts` — publish it as `exit_code`

**Spec**

- `openapi/box.openapi.yaml` — optional `exit_code` on `Box`, documenting that
  absence, not `0`, means "not recorded", and that a server may leave it out of
  any response but a direct read of one box, so absence there says nothing. The
  spec permits both shapes; the reference server carries it everywhere, and
  this API carries it only on the read
- `openapi/reference-server/server.py` — serves the field, which it can only do now that the Python binding exposes it
- `apps/libs/runner-api-client` — regenerated from the runner's swagger
- `apps/libs/api-client{,-go}` — regenerated

No SDK-client change: `src/boxlite/src/rest/types.rs` already parses the field.

## Verification

Every test below was watched failing with its own layer's change removed, then
passing with it restored:

- `box_info_carries_exit_code_as_owned_pointer_null_when_absent` (Rust) and
  `TestCBoxInfoToGoCarriesTheMainCommandExitCode` (Go) — the FFI hop. `Some(0)`
  is the case that separates a pointer from a sentinel, so it is the one that
  fails first if absence ever becomes a value again
- `TestBoxInfoResponseDistinguishesZeroExitCodeFromNone` — the runner's wire
  shape: `0` reaches the wire as a value, "not recorded" leaves the key out
- `box-exit-code.service.spec.ts` — the API read: `0` and `137` returned, no
  code returned as absent, an unreachable runner degraded to absent, and no
  call made at all for a box that cannot hold one. Replacing `?? undefined`
  with a truthiness check fails exactly the clean-exit case and nothing else
- `box.service.dto.spec.ts` — the event path makes no runner call and the read
  path does, so moving the call back into `toBoxDto` fails the suite rather
  than quietly slowing every stop notification
- `box-to-box.mapper.spec.ts` and `box.dto.spec.ts` — the two publication
  surfaces, each pinning `0` as a value against nothing recorded, and each
  checking that absence survives serialization as a missing field
- `sdks/{node,python}/src/info.rs` — the binding conversions

End to end, against a local control plane — a real runner, the API, and
Postgres, with the box image `ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0`:

```text
[exit 0]   15s after stop   status=stopped   exit_code=0
[exit 42]  15s after stop   status=stopped   exit_code=42
[restart]                   status=running   (field absent)
```

The same run confirmed the control plane's `box` table has no `exitCode`
column, so each value came from the runner on the read. Four dependencies
around the subject were substituted — an OIDC discovery stub, S3 disabled
through the code's own opt-out, seeded org/key/runner rows, and runtime
artifacts from a non-stub build — none of which the exit code passes through.

What that run does not cover is the piece a unit test cannot reach either: the
runner's base URL, the bearer header and the route are exercised only when the
API really talks to a runner, and nothing in this repository pins them.

## Rejected: `pid`

The same comparison showed the cloud also omits `pid`, and folding it in was
considered. It does not belong here. `pid` is the VMM subprocess's id on the
runner host, not a process inside the box: a tenant has no access to that host,
so the number buys them nothing and leaks a little of the platform's shape.
The spec already treats it as optional — it is absent from `Box.required` — so
omitting it is conformant, not a gap.

The distinction that decides it: an exit code describes the tenant's own
workload; a host PID describes our implementation.

## Out of scope

`attach()` is untouched and is not an alternative to this. It streams a live
process, so reading an exit code through it means being attached before the
command ends; this field answers after the box has stopped, which is the case
POL-603 is about. The Node and Go SDKs still have no `attach()` at all, and the
cloud has no route for the main session — that is POL-598's territory, not
this change's.

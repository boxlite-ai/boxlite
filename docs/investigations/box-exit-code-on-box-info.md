# Publish the main command's exit code on box info

**Date:** 2026-09-18
**Status:** Implemented
**Issue:** POL-603 — cloud box info carries no exit code, so a clean exit and a crash are indistinguishable

---

## Problem

`GET /v1/boxes/{id}` on BoxLite Cloud returns no exit code. A box whose main
command ran to completion and one whose main command crashed both end up as
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
| runner → API               | `box_sync.go` reports state only                                      |
| API                        | no column, no mapping                                                 |

## Design

### The carrier: the stop report

A box that stops because its main command exited is reported to the control
plane by the runner's `BoxSyncService`, which polls local state and pushes any
mismatch. That report is the only moment the exit code can travel: the VM is
gone afterwards, so nothing can be asked for it again, and no later request can
reconstruct it. The code therefore rides `UpdateBoxStateDto` with the state it
was read beside, from one `BoxInfo` snapshot, so the two always describe the
same lifecycle.

`GetBoxState()` and the `backend.Backend` interface are deliberately untouched.
`GetLocalContainerStates` already holds the whole SDK `BoxInfo`; reading
`ExitCode` from the snapshot it already has avoids widening an interface and
its adapters for a value that is right there.

### `0` is a value, not an absence

`CBoxInfo` spells absence as `0` for `pid` and `started_at`. An exit code
cannot follow that convention: `0` is precisely the answer that distinguishes a
command that finished its work from one that died. The FFI therefore carries an
explicit flag beside the value:

```c
int exit_code;      // read only when has_exit_code is nonzero
int has_exit_code;
```

Each layer keeps the distinction in its own idiom — `*int` in Go, `number |
null` in the API, and an absent JSON field on the wire. The REST mapper uses
`?? undefined` rather than a falsy check for the same reason; a truthiness test
there would silently erase every successful run.

### A recorded code belongs to the run that ended

Nothing else clears the field: the runner only ever reports one when a box
stops. So a box that is started again would keep answering with the previous
run's code while it is up and serving — a worse failure than having no field at
all, because it reads exactly like a box that has already died.

The rule lives in one place, `beginsNewRun()`
(`apps/api/src/box/utils/exit-code.util.ts`), and covers `CREATING`,
`RESTORING`, `STARTING` and `STARTED`.

Box state has **three** writers, and all three apply it. Missing any one of
them leaves the stale value behind:

1. `BoxService.updateState()` — the runner-reported path
2. `BoxAction.updateBoxState()` — lifecycle actions
3. `JobStateHandlerService` — the CREATE_BOX / START_BOX completion handlers,
   which are where a resumed box actually becomes `STARTED`

## Changes

**FFI / SDK** — every binding, so `box.info()` answers in each language

- `sdks/c/src/info.rs` — `CBoxInfo.exit_code` + `has_exit_code`, filled in `from_box_info`
- `sdks/c/include/boxlite.h` — regenerated header
- `sdks/go/info.go` — `BoxInfo.ExitCode *int` and its cgo conversion
- `sdks/node/src/info.rs` + `sdks/node/lib/native-contracts.ts` — `JsBoxStateInfo.exitCode`
- `sdks/python/src/info.rs` — `BoxStateInfo.exit_code`, also in both `__repr__`s
- `docs/reference/{nodejs,python}/README.md` — the `state` field's documented shape

**runner**

- `apps/runner/pkg/services/box_sync.go` — `localContainerState.exitCode`, sent by `SyncBoxState`

**API**

- `update-box-state.dto.ts`, `box.controller.ts` — accept and pass the reported code
- `box.service.ts`, `box.action.ts`, `job-state-handler.service.ts` — persist it, and clear it per `beginsNewRun()`
- `box.entity.ts` + `migrations/pre-deploy/1787100000000-add-box-exit-code-migration.ts` — nullable `exitCode` column
- `box.dto.ts`, `box-response.dto.ts`, `box-to-box.mapper.ts` — publish it as `exit_code`
- `usage.service.integration.spec.ts` — the new migration joins that spec's
  replay list. It rebuilds its schema by replaying migrations rather than
  synchronizing, and `Box` is in its `entities`, so its repository selects
  every declared column: a migration missing from the list makes the reconcile
  pass query a column the database does not have. The failure surfaces as
  periods that silently never close, not as a missing column

**Spec**

- `openapi/box.openapi.yaml` — optional `exit_code` on `Box`, documenting that absence, not `0`, means "not recorded"
- `openapi/reference-server/server.py` — serves the field, which it can only do now that the Python binding exposes it
- `apps/libs/api-client{,-go}` — regenerated; both DTOs declare `type: 'integer'`
  so the generator emits `int32` rather than the `float32` a bare `number`
  would produce for an exit code

No SDK-client change: `src/boxlite/src/rest/types.rs` already parses the field.

## Verification

Every test below was watched failing with its own layer's change removed, then
passing with it restored:

- `box_info_encodes_exit_code_as_value_plus_flag` (Rust) and
  `TestCBoxInfoToGoCarriesTheMainCommandExitCode` (Go) — the FFI hop that
  re-encodes `Option<i32>` as a value plus a flag. Dropping the flag fails the
  Rust one on `Some(0)`; deriving presence from `exit_code != 0` instead fails
  the Go one on the clean exit, which is the case the flag exists for
- `TestPerformSyncReportsMainCommandExitCode` — the runner's stop report, for
  42, `0`, and "not recorded"
- `box.service.exit-code.spec.ts` — recorded on a reported stop, left alone
  when a stop reports none, cleared when the box starts again
- `box.action.exit-code.spec.ts` and the `JobStateHandlerService` cases in
  `job-state-handler.service.spec.ts` — the other two writers of box state
- `exit-code.util.spec.ts` — the clearing rule against the whole enum, typed
  as a total record so a new state cannot be added without a decision
- `box-to-box.mapper.spec.ts` and `box.dto.spec.ts` — the two publication
  surfaces, each pinning `0` as a value and `null`/`undefined` as absent
- `sdks/{node,python}/src/info.rs` — the binding conversions

`yarn nx run-many --target=generate:api-client` is idempotent over the
committed clients, so the api-client-drift check passes.

Against a real Postgres 16, the migration applies, reverts and re-applies, and
the column stores `0`, `137` and `NULL` as three distinguishable values — the
property the whole change rests on. The full API suite passes with that
database and a Redis attached (110 suites), which is what caught the replay
list above.

End to end, against a deployed cloud: create a box whose `cmd` exits with a
known code, poll until `stopped`, and read `exit_code` from
`GET /v1/boxes/{id}` — it must match the code and must survive the box being
stopped, which is what separates this from `attach()`. The same box started
again must report no exit code.

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

# Memory and VMState checkpoint API

**Status:** Proposed

## Summary

Add a `full` checkpoint option for disk, guest memory and VMState across the BoxLite API.
Preserve existing disk requests and reject full capture on servers that lack support.

## Scope and non-goals

This phase defines the API contract and passes it through from Rust Runtime Core to the REST
client, OpenAPI, the hosted API (`apps/api`), `boxlite serve` capability discovery, the CLI, and
the C, Go, Python and Node SDKs. The hosted API recognizes full capture requests and rejects
them before admission.

Local VMM, KVM, device and memory capture and restore are outside this phase. `FIFREEZE`,
`with_quiesce_async`, the SQLite schema and `boxlite-vmm` are outside its scope.

## Wire and API contract

### Capture request and source state

Expose `CheckpointOptions` with optional `kind` at SDK entry points. On the wire, add `kind`
directly to `CreateCheckpointRequest` using a `CheckpointKind` string schema with `disk` and
`full` values. Keep `required: [source_box_id]` and `additionalProperties: false`. Default
calls, empty options and explicit `disk` all use the legacy body
`{"source_box_id":"...","name":"..."}` with an optional `name` as before. `RestRuntime` omits
`kind` for both `None` and `Some(CheckpointKind::Disk)` and emits `"kind":"full"` only for
`Some(CheckpointKind::Full)`. This preserves compatibility with older servers that reject
unknown request fields. [CreateCheckpointRequest](../../../openapi/box.openapi.yaml#L3238-L3252)

Update the `createCheckpoint` summary and description to specify the state required by each
kind. `disk` requires a `stopped` source Box and `full` requires a `running` source Box. A state
mismatch returns HTTP 409 with `code: "invalid_state"` on a backend that supports the requested
kind. Capture leaves source lifecycle transitions to the caller.
[Create checkpoint operation](../../../openapi/box.openapi.yaml#L1920-L1924)

### Capability preflight and response verification

Add `memory_checkpoints_enabled` as an optional boolean under `ServerConfig.capabilities` in
OpenAPI. Add `checkpoints_enabled: Option<bool>` and `memory_checkpoints_enabled: Option<bool>`
to the Rust `ServerCapabilities`, following its existing optional boolean convention.
[OpenAPI capabilities](../../../openapi/box.openapi.yaml#L2835-L2845),
[REST capability types](../../../src/boxlite/src/rest/types.rs#L95-L108)

Only `Some(CheckpointKind::Full)` calls `require_memory_checkpoints_enabled()` before
`POST /checkpoints`. The helper fetches `GET /v1/config` without caching, using the existing
live capability checks. A missing capability object, missing field or `Some(false)` returns
`BoxliteError::Unsupported` with zero POSTs. `Some(true)` permits the POST. Default and
explicit disk requests incur zero extra round trips.
[Live preflight pattern](../../../src/boxlite/src/rest/client.rs#L627-L675),
[Capability error mapping](../../../src/boxlite/src/rest/client.rs#L808-L820)

The HTTP 201 response to an accepted full request must immediately echo `kind: "full"`, even
while `state` is `creating`. `memory_size_bytes` may be absent at that point. If the decoded
kind differs from `Full`, including an omitted kind or an unknown value, the client returns
`BoxliteError::Unsupported` with the returned `checkpoint_id` in the error message. The client
leaves that checkpoint available for inspection and issues no automatic delete or retry.

### Checkpoint metadata and restore

Keep the `Checkpoint` response's `required` list and add two optional properties. Represent
absence by omission, with neither property declared `nullable: true`. Keep them outside the
nullable field allowlist and test omission and explicit null separately.
[Checkpoint schema](../../../openapi/box.openapi.yaml#L3201-L3225),
[Schema nullability tests](../../../apps/api/src/boxlite-rest/boxlite-openapi.spec.ts#L55-L75)

| Field | Wire schema | Meaning |
|---|---|---|
| `kind` | `type: string`, `enum: [disk, full]` | Omission defaults to `disk`. Rust response decoding maps future strings to an `Unknown` variant, for example with `#[serde(other)]`, so `list()` and `get()` keep working. Request validation and serialization reject `Unknown`. |
| `memory_size_bytes` | `type: integer`, `format: int64`, `minimum: 0` | Archived memory payload size in bytes. Omit it for disk checkpoints, during `creating`, or when unavailable. Preserve a known `0`. |

Defer `target_arch` and `format_version` until the underlying VMM format stabilizes.

Update the `createBox` operation's `checkpoint_id` description. `POST /boxes` uses the existing
`checkpoint_id` and the checkpoint's own `kind` to select disk restore or disk, memory and
VMState restore. A ready checkpoint still supplies the saved execution settings, and only
`name` may accompany `checkpoint_id`. Local `RuntimeImpl` continues to return
`BoxliteError::Unsupported` for checkpoint-based creation. The local checkpoint handle uses
the same error for checkpoint management.
[Create Box operation](../../../openapi/box.openapi.yaml#L313-L319),
[Local restore guard](../../../src/boxlite/src/runtime/rt_impl.rs#L480-L489),
[Local checkpoint handle](../../../src/boxlite/src/runtime/checkpoints.rs#L99-L106)

## Layer-by-layer implementation

### Rust Runtime Core and REST client

- Define and re-export `CheckpointKind` and `CheckpointOptions` with
  `kind: Option<CheckpointKind>`. Extend `CheckpointInfo` with `kind: CheckpointKind` and
  `memory_size_bytes: Option<u64>`. Default a missing kind to `Disk` and omit `Disk` and absent
  memory size when serializing Core metadata. This preserves the legacy JSON shape for
  consumers that serialize `CheckpointInfo` directly. Keep unknown-kind tolerance on the
  response side. [Checkpoint types](../../../src/boxlite/src/runtime/checkpoints.rs),
  [Runtime exports](../../../src/boxlite/src/runtime/mod.rs),
  [Crate exports](../../../src/boxlite/src/lib.rs)
- Add `options: CheckpointOptions` directly to `pub(crate) CheckpointBackend::create`. Keep
  `CheckpointHandle::create(source, name)` delegating to
  `create_with_options(source, name, options)` with default options. Validate `source` and
  `name` before `backend()?` to preserve error ordering. Until the wire contract lands in PR-2,
  the REST backend uses the legacy request for disk and returns `Unsupported` for full before
  any request. PR-2 adds the preflight, full-only serialization and 201 response kind check.
  [Checkpoint backend and handle](../../../src/boxlite/src/runtime/checkpoints.rs),
  [REST runtime boundary](../../../src/boxlite/src/rest/runtime.rs)

### OpenAPI and servers

- Land the schema, operation docs and hosted DTO in PR-2. `CreateCheckpointDto` adds
  `@IsOptional() @IsIn(['disk', 'full']) kind?: 'disk' | 'full'`. Reject valid `full` before
  `CheckpointService.create` with HTTP 400 and the standard `ErrorResponse` with
  `code: "unsupported"`. Invalid `kind` returns HTTP 400 invalid argument. Reject explicit
  `null` before admission because `@IsOptional()` skips it and the schema accepts omission only.
  `response()` explicitly emits `kind: 'disk'`. The hosted config endpoint emits
  `memory_checkpoints_enabled: false`.
  [Hosted checkpoint controller](../../../apps/api/src/boxlite-rest/boxlite-checkpoint.controller.ts#L30-L89),
  [Hosted config controller](../../../apps/api/src/boxlite-rest/boxlite-config.controller.ts#L18-L32),
  [Shared HTTP error mapping](../../../src/shared/src/errors.rs#L168-L170)
- In `boxlite serve`, emit `memory_checkpoints_enabled: false` in `GET /v1/config` only. Defer
  `/checkpoints` routes until the local backend can serve them.
  [Serve capability types](../../../src/cli/src/commands/serve/types.rs),
  [Serve config handler](../../../src/cli/src/commands/serve/handlers/config.rs)

### CLI and SDKs

| Layer | Entry points and result metadata |
|---|---|
| CLI | Add one mode flag to `checkpoint create`, selected under Open decisions. Pass it through `CheckpointOptions`. Add `KIND` to `list` and `get` tables. Include `kind` explicitly in JSON, including `disk`, and include `memory_size_bytes` when present. Update disk-only help text. [Checkpoint commands](../../../src/cli/src/commands/checkpoint.rs), [CLI command help](../../../src/cli/src/cli.rs) |
| C | Keep `boxlite_checkpoint_create` and add `boxlite_checkpoint_create_with_options`. Copy and validate the optional `kind` string synchronously before `submit()`. Expose `kind` and `memory_size_bytes` with `has_memory_size_bytes: c_int`, following the presence flags in `CVolumeInfo` and `CImageInfo`. Select tail append or V2 under Open decisions. [C bindings](../../../sdks/c/src/checkpoints.rs), [C header](../../../sdks/c/include/boxlite.h) |
| Go | Add `CheckpointKind` and expose `CheckpointInfo.Kind` as `CheckpointKind` and `CheckpointInfo.MemorySizeBytes` as `*uint64`. Copy both to Go-owned values before freeing C metadata. Reject embedded NUL and invalid kinds before crossing CGo. Prefer keeping `Create` and adding `CreateWithOptions`, subject to Open decisions. If C uses V2, update the callback bridge and cleanup together. [Go API](../../../sdks/go/checkpoints.go), [Bridge header](../../../sdks/go/bridge.h), [Bridge implementation](../../../sdks/go/bridge.c), [Go callbacks](../../../sdks/go/checkpoint_callback.go) |
| Python | Add `PyCheckpointOptions(kind=None)` as `CheckpointOptions` and register it in the extension and package exports. This needs no `.pyi` change. Both async and `SyncCheckpointHandle.create(source, name=None, options=None)` pass the optional third argument through. Invalid `kind` raises `InvalidArgumentError`. Add `kind` and optional `memory_size_bytes` to checkpoint results. [Python bindings](../../../sdks/python/src/checkpoints.rs), [Extension registration](../../../sdks/python/src/lib.rs), [Package exports](../../../sdks/python/boxlite/__init__.py), [Sync checkpoint handle](../../../sdks/python/boxlite/sync_api/_checkpoints.py) |
| Node | Accept an optional third argument `CheckpointOptions { kind?: "disk" \| "full" }`. Use `Option<String>` and `TryFrom` at the native boundary, preserving the `invalid argument:` prefix used by `errorCode()`. Expose `kind` and optional `memorySizeBytes` on `CheckpointInfo`, with its numeric type pending. Sync the native TypeScript contract and public exports. [Node bindings](../../../sdks/node/src/checkpoints.rs), [Native contracts](../../../sdks/node/lib/native-contracts.ts), [Public exports](../../../sdks/node/lib/index.ts) |

## Design rationale and alternatives considered

- The hosted DTO must land with the wire schema. `forbidNonWhitelisted` treats `kind: "full"`
  as invalid until the DTO declares it. Once recognized, `unsupported` on HTTP 400 follows
  `BoxliteError::Unsupported` and the existing client error mapping. A 501 would add a second
  transport convention for the same error.
- Fresh capability discovery limits stale positives after a rollback or replica change.
  `Option<bool>` preserves the distinction between an older server with no field and a server
  that explicitly reports false. Both fail before POST, avoiding misleading invalid-argument
  responses and orphan `creating` records behind permissive proxies. A successful preflight
  cannot guarantee that the same backend handles the POST. The 201 kind check detects a silent
  downgrade and preserves the returned ID for reconciliation.
- Sending `kind: "disk"` would fail against legacy closed request schemas. Omitting it makes
  the explicit disk choice equivalent to the existing default at the wire boundary.
- Omission keeps the response additive and fits the OpenAPI nullable allowlist. It also
  distinguishes an unavailable memory size from an archived payload with a known size of zero.
  The CLI needs one selector for the same mode. Two mutually exclusive flags add a conflict
  rule without expressing an additional mode.

## Inside-out pull request roadmap

| Pull request | Dependencies and estimated code lines | Documentation |
|---|---|---|
| PR-1 · Runtime Core | First, ~100–140 LOC. Land the Rust types and `CheckpointHandle` contract with no OpenAPI changes. | [Rust reference](../../reference/rust/README.md) |
| PR-2 · REST, OpenAPI and servers | After PR-1 and the OpenAPI compatibility gate, ~150–200 LOC. Includes `apps/api` and `boxlite serve`. | [Platform API](../architecture/platform/api.md) |
| PR-3 · CLI | After PR-2, ~80–120 LOC. | [CLI reference](../../../src/cli/README.md) |
| PR-4 · C and Go SDKs | After PR-2, ~190–280 LOC. If C uses V2, split into PR-4a (C) and PR-4b (Go). | [C reference](../../reference/c/README.md), [Go SDK](../../../sdks/go/README.md) |
| PR-5 · Python and Node SDKs | After PR-2, ~170–230 LOC combined. Python (PR-5a) and Node (PR-5b) can proceed independently. | [Python reference](../../reference/python/README.md), [Node reference](../../reference/nodejs/README.md) |

1. **Blocking prerequisites.** PR-1 fixes the Rust types and handle signatures. PR-2 fixes the
   OpenAPI, REST client and hosted wire contract. The C FFI and `boxlite.h` contract must be
   available before implementing Go CGo bindings in PR-4.
2. **Independent streams.** After PR-2, PR-3, PR-4, PR-5a and PR-5b modify disjoint paths and
   can run in parallel.
3. **Shared mutable state.** No decomposition is needed. DTOs, option pass-through, JSON
   serialization, capability fields and hosted rejection require no shared mutable runtime
   state, lock changes or database schema changes.
4. **Minimum safe slice.** PR-1 alone lands the Rust Core contract with zero changes to wire
   or OpenAPI behavior and no local or REST regressions. With PR-1 as its base, PR-2 closes
   the wire, OpenAPI and hosted server loop without depending on the CLI or SDK work.

## Verification and test matrix

| Layer | Commands | Required coverage |
|---|---|---|
| OpenAPI and hosted API | `make test:unit:openapi`, `make test:apps:api` | Validate legacy and explicit-kind requests, response omission, zero and schema bounds. At the hosted HTTP boundary, verify default and disk reach `CheckpointService.create` and return `kind: 'disk'` on success. Preserve HTTP 409 `invalid_state` for a disk source in the wrong state. Full returns 400 `unsupported` with zero service calls, invalid input returns 400 invalid argument, and discovery advertises false. [Hosted HTTP tests](../../../apps/api/src/boxlite-rest/boxlite-checkpoint.controller.spec.ts) |
| Rust Core and REST client | `make test:unit:core` | Verify validation before backend lookup, local `Unsupported`, prior disk payloads with and without `name`, and response defaults. Assert exact requests and order on loopback, including zero config GETs for disk, zero POSTs for absent and false capabilities, a fresh GET per full request, accepted 201 `full` during `creating`, and mismatched kind errors carrying the ID without follow-up requests. Verify unknown kinds through `list()` and `get()`, reject `Unknown` on creation before transport, and preserve the existing `POST /boxes` body. Keep REST loopback tests in [rest/runtime.rs](../../../src/boxlite/src/rest/runtime.rs). The `RUST_UNIT_REST_ARGS` pass uses the `rest::` filter and silently skips them under [runtime/checkpoints/tests.rs](../../../src/boxlite/src/runtime/checkpoints/tests.rs). |
| CLI | `make coverage:cli` | Test the selected create flag, legacy disk payload, table `KIND`, JSON metadata including a known zero, and the local serve config value. [CLI checkpoint tests](../../../src/cli/tests/checkpoint.rs) |
| C and Go | `make dev:c`, `make test:unit:ffi`, `make test:unit:go` | Verify FFI validation before submission, callback and list ownership, absent size versus zero, and Go input guards and option forwarding. `make coverage:go:checkpoint` covers the local archive only. `make test:unit:go` exercises the REST boundary. [Go REST boundary tests](../../../sdks/go/checkpoints_test.go) |
| Python | `make dev:python && make test:unit:python` | Build the native `.so` so checkpoint tests run. Cover async and `SyncCheckpointHandle.create(..., options=...)`, invalid input as `InvalidArgumentError`, and optional size conversion. [Python checkpoint tests](../../../sdks/python/tests/test_checkpoint_handle.py) |
| Node | `make dev:node`, `make test:unit:node`, `make test:integration:node FILTER='^checkpoint '` | Put native conversion and error tests in a `#[cfg(test)]` module in [Node checkpoints.rs](../../../sdks/node/src/checkpoints.rs). Exercise the native REST boundary and public JS metadata in [checkpoints.integration.test.ts](../../../sdks/node/tests/checkpoints.integration.test.ts). Prefix new test names in that file with `checkpoint ` so the targeted integration run selects them. `make test:unit:node` excludes `*.integration.test.ts`. |
| Lint | `make lint` | Run for each implementation pull request. |

## Open decisions

1. **C ABI.** Tail-append fields to `CCheckpointInfo` for the pre-1.0 API to avoid a V2 struct,
   callback, event queue and Go bridge change. Freezing V1 and adding V2 preserves binary ABI
   compatibility for precompiled callers, including list traversal, where tail append changes
   the element stride.
2. **Node `memorySizeBytes`.** `number` matches `sizeBytes` and works with `JSON.stringify`.
   It represents integer byte counts exactly through `2^53 - 1`, just under 8 PiB. `bigint`
   follows `ssh.generation` and covers the full `int64` range.
3. **Go signature.** `Create(..., opts ...CheckpointOption)` preserves existing direct call
   sites but changes interface and method-value types. Keeping `Create` and adding
   `CreateWithOptions` preserves source compatibility for those callers as well.
4. **CLI flag.** `--kind <disk|full>` matches the wire and SDK terminology. `--memory` offers
   a boolean opt-in to full capture.
5. **OpenAPI compatibility gate.** The schema changes in `openapi/box.openapi.yaml` add only
   optional fields. Confirm whether PR-2 can proceed directly without a prior tracking GitHub
   issue.

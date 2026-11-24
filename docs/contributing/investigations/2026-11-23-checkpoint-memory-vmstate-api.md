# Memory and VMState checkpoint API

**Status:** Implemented

## Summary

The BoxLite API exposes a `full` checkpoint option for disk, guest memory and VMState. Disk
requests retain their existing behavior, and servers without full capture support reject `full`.

## Scope and non-goals

This phase defines the API contract and passes it through from Rust Runtime Core to the REST
client, OpenAPI, the hosted API (`apps/api`), `boxlite serve` capability discovery, the CLI, and
the C, Go, Python and Node SDKs. The hosted API recognizes full capture requests and rejects
them before admission.

Local VMM, KVM, device and memory capture and restore are outside this phase. `FIFREEZE`,
`with_quiesce_async`, the SQLite schema and `boxlite-vmm` are outside its scope.

## Wire and API contract

### Capture request and source state

SDK entry points expose `CheckpointOptions` with an optional `kind`. The wire schema uses the
`CheckpointKind` values `disk` and `full`, requires `source_box_id` and rejects extra properties.
Default calls, empty options and explicit `disk` all use the legacy body
`{"source_box_id":"...","name":"..."}` with an optional `name`. `RestRuntime` omits `kind` for
both `None` and `Some(CheckpointKind::Disk)` and emits `"kind":"full"` only for
`Some(CheckpointKind::Full)`. This preserves compatibility with older servers that reject
unknown request fields. [CreateCheckpointRequest](../../../openapi/box.openapi.yaml#L3266-L3281),
[CheckpointKind schema](../../../openapi/box.openapi.yaml#L3212-L3217)

The `createCheckpoint` operation requires a stopped and idle source Box for `disk` and a
running source Box for `full`. A state mismatch returns HTTP 409 with `code: "invalid_state"`
on a backend that supports the requested kind. Capture leaves lifecycle transitions to the caller.
[Create checkpoint operation](../../../openapi/box.openapi.yaml#L1921-L1934)

### Capability preflight and response verification

`ServerConfig.capabilities` defines optional booleans for `checkpoints_enabled` and
`memory_checkpoints_enabled`. The Rust `ServerCapabilities` represents both as `Option<bool>`.
[OpenAPI capabilities](../../../openapi/box.openapi.yaml#L2846-L2853),
[REST capability types](../../../src/boxlite/src/rest/types.rs#L90-L104)

Only `Some(CheckpointKind::Full)` calls `require_memory_checkpoints_enabled()` before
`POST /checkpoints`. The helper fetches `GET /v1/config` without caching, using the existing
live capability checks. A missing capability object, missing field or `Some(false)` returns
`BoxliteError::Unsupported` with zero POSTs. `Some(true)` permits the POST. Default and
explicit disk requests incur zero extra round trips.
[Config fetch](../../../src/boxlite/src/rest/client.rs#L605-L607),
[Full capture preflight](../../../src/boxlite/src/rest/client.rs#L677-L685),
[Capability validation](../../../src/boxlite/src/rest/client.rs#L818-L830)

The HTTP 201 response to an accepted full request must immediately echo `kind: "full"`, even
while `state` is `creating`. `memory_size_bytes` may be absent at that point. If the decoded
kind differs from `Full`, including an omitted kind or an unknown value, the client returns
`BoxliteError::Unsupported` with the returned checkpoint's `id` in the error message. The client
leaves that checkpoint available for inspection and issues no automatic delete or retry.
[REST response check](../../../src/boxlite/src/rest/runtime.rs#L71-L89)

### Checkpoint metadata and restore

The `Checkpoint` response schema defines two optional properties outside the nullable field
allowlist. The schema accepts omission and rejects explicit `null` for both properties.
[Checkpoint schema](../../../openapi/box.openapi.yaml#L3219-L3249),
[Schema nullability tests](../../../apps/api/src/boxlite-rest/boxlite-openapi.spec.ts#L42-L57)

| Field | Wire schema | Meaning |
|---|---|---|
| `kind` | `type: string`, `enum: [disk, full]` | Omission defaults to `disk`. Rust response decoding uses `#[serde(other)]` to map future strings to `Unknown` so `list()` and `get()` keep working. Creation request validation rejects `Unknown` in both the [Rust handle](../../../src/boxlite/src/runtime/checkpoints.rs#L149-L154) and the [REST backend](../../../src/boxlite/src/rest/runtime.rs#L50-L61). |
| `memory_size_bytes` | `type: integer`, `format: int64`, `minimum: 0` | Archived memory payload size in bytes. Omit it for disk checkpoints, during `creating`, or when unavailable. Preserve a known `0`. |

`target_arch` and `format_version` depend on a stable VMM format and are outside this contract.

The `createBox` contract uses `checkpoint_id` and the checkpoint's `kind` to select disk
restore or disk, memory and VMState restore on a server that supports the kind. A ready
checkpoint supplies the saved execution settings, and only `name` may accompany
`checkpoint_id`. Local `RuntimeImpl` returns `BoxliteError::Unsupported` for checkpoint-based
creation. The local checkpoint handle uses the same error for checkpoint management.
[Create Box operation](../../../openapi/box.openapi.yaml#L313-L319),
[Local restore guard](../../../src/boxlite/src/runtime/rt_impl.rs#L482-L489),
[Local checkpoint handle](../../../src/boxlite/src/runtime/checkpoints.rs#L172-L179)

## Layer-by-layer implementation

### Rust Runtime Core and REST client

- Rust re-exports `CheckpointKind` and `CheckpointOptions`, which has
  `kind: Option<CheckpointKind>`. `CheckpointInfo` has `kind: CheckpointKind` and
  `memory_size_bytes: Option<u64>`. A missing kind defaults to `Disk`. Serializing Core metadata
  omits `Disk` and absent memory size, preserving the legacy JSON shape for direct consumers.
  [Checkpoint types](../../../src/boxlite/src/runtime/checkpoints.rs),
  [Runtime exports](../../../src/boxlite/src/runtime/mod.rs),
  [Crate exports](../../../src/boxlite/src/lib.rs)
- `CheckpointBackend::create` takes `options: CheckpointOptions`.
  `CheckpointHandle::create(source, name)` delegates to
  `create_with_options(source, name, options)` with default options. The handle validates
  `source`, `name` and `kind` before looking up the backend.
  [Checkpoint backend and handle](../../../src/boxlite/src/runtime/checkpoints.rs)
- The REST backend sends the legacy body for disk. For full capture, it checks the live
  capability, sends `kind: "full"` and verifies that the creation response confirms `full`.
  [REST runtime boundary](../../../src/boxlite/src/rest/runtime.rs)

### OpenAPI and servers

- The hosted `CreateCheckpointRequest` DTO pairs `@ValidateIf((_obj, value) => value !== undefined)`
  with `@IsIn(['disk', 'full'])`. It accepts omission and rejects explicit `null` and other invalid
  values with HTTP 400. [Hosted request DTO](../../../apps/api/src/boxlite-rest/boxlite-checkpoint.controller.ts#L31-L37)
- The hosted controller rejects a valid `full` request before `CheckpointService.create` with
  HTTP 400. The flat JSON body includes `statusCode`, `error`, `message` and `code: "unsupported"`.
  A disk source state mismatch returns HTTP 409 with `code: "invalid_state"`.
  [Hosted capture handler](../../../apps/api/src/boxlite-rest/boxlite-checkpoint.controller.ts#L46-L56),
  [Hosted error body](../../../apps/api/src/filters/all-exceptions.filter.ts#L124-L133),
  [Source state guard](../../../apps/api/src/box/services/checkpoint.service.ts#L79-L89)
- Hosted checkpoint responses include `kind: "disk"`. Hosted `GET /v1/config` advertises
  `capabilities.memory_checkpoints_enabled: false`.
  [Hosted response mapping](../../../apps/api/src/boxlite-rest/boxlite-checkpoint.controller.ts#L87-L98),
  [Hosted config controller](../../../apps/api/src/boxlite-rest/boxlite-config.controller.ts#L18-L24)
- `boxlite serve` advertises `memory_checkpoints_enabled: false` in `GET /v1/config`.
  [Serve capability types](../../../src/cli/src/commands/serve/types.rs),
  [Serve config handler](../../../src/cli/src/commands/serve/handlers/config.rs)

### CLI and SDKs

| Layer | Entry points and result metadata |
|---|---|
| CLI | `checkpoint create --kind <disk\|full>` passes the selection through `CheckpointOptions`. Both `list` and `get` show `KIND` in tables. JSON and YAML include `kind`, including `disk`, and include `memory_size_bytes` when present. [Checkpoint commands](../../../src/cli/src/commands/checkpoint.rs) |
| C | `boxlite_checkpoint_create` selects disk. `boxlite_checkpoint_create_with_options` accepts an optional `const char *kind`, which it copies and validates synchronously before `submit()`. `CCheckpointInfo` ends with `uint64_t memory_size_bytes`, `int has_memory_size_bytes` and `char *kind`. [C bindings](../../../sdks/c/src/checkpoints.rs), [C header](../../../sdks/c/include/boxlite.h) |
| Go | `Create(ctx, source, name)` selects disk. `CreateWithOptions(ctx, source, name, opts)` accepts `CheckpointOptions`. Go rejects embedded NULs and invalid kinds before crossing cgo. `CheckpointInfo.Kind` is a `CheckpointKind` and `MemorySizeBytes` is a `*uint64`. Both are copied before freeing the C metadata. [Go API](../../../sdks/go/checkpoints.go) |
| Python | `CheckpointOptions(kind=None)` is exported by the extension and package. The async and sync handles accept `create(source, name=None, options=None)`. Invalid `kind` raises `InvalidArgumentError`. Results expose `kind` and optional `memory_size_bytes`. [Python bindings](../../../sdks/python/src/checkpoints.rs), [Extension registration](../../../sdks/python/src/lib.rs), [Package exports](../../../sdks/python/boxlite/__init__.py), [Sync checkpoint handle](../../../sdks/python/boxlite/sync_api/_checkpoints.py) |
| Node | `create(source, name?, options?)` accepts `CheckpointOptions { kind?: "disk" \| "full" \| null }`. Omission or `null` selects disk. The native boundary parses `Option<String>` with `TryFrom` and uses the `invalid argument:` prefix consumed by `errorCode()`. `CheckpointInfo` exposes `kind` and `memorySizeBytes?: number`. [Node bindings](../../../sdks/node/src/checkpoints.rs), [Native contracts](../../../sdks/node/lib/native-contracts.ts#L175-L197), [Public exports](../../../sdks/node/lib/index.ts) |

## Design rationale and alternatives considered

- Declaring `kind` in the hosted DTO allows valid values through `forbidNonWhitelisted`.
  HTTP 400 with `code: "unsupported"` follows the shared `BoxliteError::Unsupported` convention
  and preserves the error class in the REST client.
  [Shared HTTP error mapping](../../../src/shared/src/errors.rs#L166-L175),
  [REST error decoding](../../../src/boxlite/src/rest/error.rs#L73-L82)
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

## Original inside-out pull request roadmap

All layers were delivered together on this branch. The original roadmap grouped the work by
dependency and estimated source lines for each proposed pull request.

| Proposed pull request | Original dependencies and estimated code lines | Documentation |
|---|---|---|
| PR-1 · Runtime Core | First, ~100–140 LOC for the Rust types and `CheckpointHandle` contract. | [Rust reference](../../reference/rust/README.md) |
| PR-2 · REST, OpenAPI and servers | After PR-1 and the planned compatibility review, ~150–200 LOC for the wire contract, `apps/api` and `boxlite serve`. | [Platform API](../architecture/platform/api.md) |
| PR-3 · CLI | After PR-2, ~80–120 LOC. | [CLI reference](../../../src/cli/README.md) |
| PR-4 · C and Go SDKs | After PR-2, ~190–280 LOC. Go depends on the C FFI and `boxlite.h`. | [C reference](../../reference/c/README.md), [Go SDK](../../../sdks/go/README.md) |
| PR-5 · Python and Node SDKs | After PR-2, ~170–230 LOC combined for two independent SDKs. | [Python reference](../../reference/python/README.md), [Node reference](../../reference/nodejs/README.md) |

The Rust handle is the foundation for the wire contract. The CLI and SDKs use that contract,
and Go consumes the C FFI header. The API changes require no shared mutable runtime state,
lock changes or database schema changes.

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

## Decisions

1. **C ABI.** The pre-1.0 API appends fields to `CCheckpointInfo` and uses that struct for
   callbacks and list entries. The larger element stride requires precompiled list consumers
   to rebuild against the current header.
2. **Node `memorySizeBytes`.** The public type is `number`, matching `sizeBytes` and supporting
   `JSON.stringify`. The maximum safe integer is `2^53 - 1` bytes, just under 8 PiB.
3. **Go signature.** `Create` keeps its signature and delegates to `CreateWithOptions`. Existing
   direct calls, interfaces and method values retain their types.
4. **CLI flag.** `--kind <disk|full>` matches the wire and SDK terminology.
5. **OpenAPI compatibility.** The branch includes the additive schema changes in the REST
   implementation commit (`56d64028c`). The contract preserves required fields, the disk
   default and the existing disk request body.

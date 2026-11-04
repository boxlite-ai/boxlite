## TL;DR

Add single-public-key SSH setup and explicit enable to the local Rust runtime and CLI. Generate and persist the host key in the guest, preserving its identity across reconfiguration. Enable and disable require a running box.

# SSH quick configuration

Date: 2026-11-04. Implementation record for the approved
[design #2303](https://github.com/boxlite-ai/boxlite/issues/2303).
Research baseline: `4ad1423bd1511f15a4d22f44fd3cd95a60706fe1`.

## Scope and contract

| Operation | Contract |
| --- | --- |
| Rust `ssh.setup(client_public_key)` | Accept one OpenSSH public-key string. Replace authentication with one `box` account, that key, and no CA; listen on `0.0.0.0:22`; persist and enable. |
| Rust `ssh.configure(config)` | Retain the complete configuration interface and its replacement/restart behavior. |
| Rust `ssh.enable()` | Enable the saved configuration. Missing configuration is an error. A healthy enabled listener keeps its connections and generation. |
| Rust `ssh.disable()` | Stop SSH and disconnect clients, preserving credentials. Repeating it on a running box is supported. |
| Rust `ssh.status()` | Preserve existing observational behavior, including disabled status for fresh handles to idle boxes. |

`enable()` and `disable()` never start the VM or main command. On Configured or
Stopped boxes they return `InvalidState`, without changing saved configuration.
Invalidated handles continue to return `Stopped`. Quick configuration follows
the existing complete configuration startup policy: default-command boxes may
start implicitly; explicitly configured commands require `start()` first.

CLI usage:

```sh
boxlite ssh setup dev --authorized-key ~/.ssh/id_ed25519.pub
boxlite ssh disable dev
boxlite ssh enable dev
boxlite ssh forward dev
# Use the address printed by forward, logging in as box.
```

The quick command accepts exactly one key file. It prints the same `SshStatus`
JSON as the other control commands. `box` is an authentication name, not a
change to the container's configured execution UID/GID. Host forwarding remains
separate. Both configuration operations disconnect existing clients on success.

New public operations are limited to local Rust and CLI. REST-backed handles
return `Unsupported` for quick configuration and enable; no new HTTP routes or
language SDK methods are included. The stricter local disable behavior also
reaches existing SDK bindings and `boxlite serve`, which call the same runtime;
their affected documentation and old-contract assertions must be reconciled.
Remote disable behavior remains determined by the remote server.

## Research and alternatives

| Question | Evidence and finding | Decision |
| --- | --- | --- |
| Where does durable SSH identity live? | `src/guest/src/service/ssh/persistence.rs:77` loads `/etc/boxlite/ssh.cfg`; `:114` saves with confined paths, private permissions, atomic replacement, and sync. | Reuse this storage; do not create a second host-side key store. |
| How is mutation serialized? | `src/guest/src/service/ssh/mod.rs:141` holds the manager mutex through load, validation, save, stop, and start. Partial updates retain saved fields. | Build the quick configuration within the same critical section; avoid a separate load-then-configure RPC sequence. |
| Can enable reuse current machinery? | The same manager rejects enable without configuration and only restarts when configuration is supplied or the listener is unhealthy. | Expose `Control(enable=true)` through the runtime. |
| Why retain generated host keys? | OpenSSH [`ssh-keygen -A`](https://man.openbsd.org/ssh-keygen.1#A) creates missing host keys; existing ones are retained. | Adopt generate-once semantics, using the existing saved key even when it originally came from complete configuration. |
| Can existing cryptography generate the key? | `src/guest/src/service/ssh/tests.rs:55` already uses russh `PrivateKey::random`, `safe_rng()`, and Ed25519. `mod.rs:44` validates keys through the production parser and signing check. | Reuse russh in the guest, serialize an unencrypted OpenSSH key, and keep the production validation path. No new dependency or shell command. |
| Why a separate internal RPC? | [Protobuf's wire-safe changes](https://protobuf.dev/programming-guides/proto3/#binary-wire-safe-changes) allow old parsers to ignore added fields. A new quick-config field on `Control` could therefore be mistaken for a status request by an older guest. [gRPC status codes](https://grpc.io/docs/guides/status-codes/#full-list-of-status-codes) define `UNIMPLEMENTED` for unavailable operations. | Add `Ssh.Setup` with a one-field request. Old guests must fail explicitly, rather than report success without applying credentials. |

The versioned russh API page was unavailable during research; use the repository's
existing API calls as the integration evidence and verify compilation during
implementation. No claim is made that an upstream example proves this change.

Keeping only complete configuration would not remove client-side host-key
management. Generating a fresh host key on every call violates stable identity.
Reading the private key back to the host creates another secret boundary and a
read-modify-write race. The guest-owned operation avoids both.

## Implementation

1. Add `Setup(SshSetupRequest)` to the internal SSH service;
   its only input is `client_public_key`, and its result is `SshControlResponse`.
   Keep the existing `Control` schema and complete configuration strict.
2. Route both mutations through the guest's existing serialized update path.
   Quick setup loads saved state, reuses its host private key or generates an
   Ed25519 key if no configuration exists, builds the fixed configuration, and
   uses existing validation/persistence/activation. Corrupt or unreadable saved
   state is an error, not permission to silently rotate identity. Complete
   configuration retains its ability to replace corrupt saved state.
3. Add Rust handle/backend operations and the portal RPC adapter. Preserve the
   current timeout, shutdown cancellation, error mapping, and no-retry rules.
   Require an existing VM for enable/disable while keeping status observational.
4. Add CLI `setup` and `enable`, reusing key-file loading, box lookup,
   and status output. Update scoped help/completion coverage and SSH references.

Validation or persistence failure before activation leaves the existing service
unchanged. Existing bind/drain failure semantics remain: saved intent may have
changed even when activation fails. A disabled saved configuration retains its
key; restart restores the saved enabled switch. Two concurrent quick setups are
serialized and reuse one identity; the later accepted call replaces the earlier
client key. Neither quick setup nor enable implicitly rotates a host key.

Estimated production changes: roughly 250–350 added lines across the shared
schema, guest, host runtime, and CLI; tests and documentation are additional.
Measure the actual diff before any PR work.

## Validation

| Boundary | Required evidence |
| --- | --- |
| Guest RPC and authentication | Quick setup returns port 22 and a valid host identity; only the supplied key with login `box` authenticates. Reject empty, malformed, multi-key, or certificate input without changing live state. |
| Persistence | Reconfiguration, client-key replacement, disable/enable, and guest restart retain the fingerprint. Inspect saved production output for the fixed account and private file permissions. Concurrent quick setup must retain one host identity. |
| Complete configuration compatibility | Existing full configuration still replaces all fields; quick setup after it retains its host key while replacing address and credentials. |
| Runtime lifecycle and transport | Real socket mock records exactly one appropriate RPC. Enable/disable on idle boxes error without startup or RPC; status still observes. Cover errors, missing responses, cancellation, and deadlines for new operations. |
| CLI | Parsing accepts one public-key file and rejects missing/repeated credentials; help and completions expose both commands. Verify live setup, forwarding/login, disable, and enable with real VMs. |
| Unsupported backend/guest | REST-backed new operations return `Unsupported` without sending an invented HTTP request. A legacy guest rejects the new method explicitly. |

Before production edits, the changed idle-disable test failed at the assertion
expecting `InvalidState`, with the original implementation still in place.
The final runtime suite passes that assertion.

| Check | Observed result |
| --- | --- |
| `BOXLITE_DEPS_STUB=1 make test:unit:rust FILTER=ssh` | 13 runtime tests, 5 shared tests, and the 13-test REST-enabled runtime pass succeeded. |
| `BOXLITE_DEPS_STUB=1 make test:unit:cli` | 338 tests passed. |
| Linux `make test:unit:guest FILTER=ssh` | 134 tests passed in a local container; source and dependency caches were mounted read-only. The setup test isolates port 22 in its own network namespace. |
| `make test:integration:cli FILTER=ssh` | 37 tests passed, including real VM setup/login, enable/disable, restart, and existing REST behavior. Runtime artifacts were built without dependency stubs. |
| `make test:integration:rust SETUP_DONE=1 FILTER=runtime_ssh_` | 14 tests passed, including explicit-command and entrypoint guards for configured/stopped boxes. |
| `make lint:rust`, `make fmt:check:rust`, `git diff --check` | Passed. |

Existing language SDK idle-disable assertions now expect the shared runtime's
`InvalidState` error. No new SDK methods or HTTP routes were added.

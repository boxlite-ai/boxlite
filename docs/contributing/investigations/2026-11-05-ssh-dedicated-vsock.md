# Dedicated SSH transport

## TL;DR

Local SSH uses its own Unix socket/vsock bridge and accepts SSH `none` authentication on that host-only ingress. TCP SSH keeps its existing credential policy.

Design discussion: [#2351](https://github.com/boxlite-ai/boxlite/issues/2351).

## Scope and acceptance

Provide `runtime ↔ socket ↔ guest ↔ SSH` independently of the network data path,
without SSH user credentials on the host-only ingress. Reuse the existing Unix
socket/vsock bridge and SSH session lifecycle.

Acceptance: Rust SSH connections and forwarding reach embedded SSH with networking
disabled; no client key is needed on this ingress; TCP still rejects `none`;
disable/reconfigure closes both kinds of connection; an idle client cannot
block control, other connections or initialization. Existing SSH configuration
and saved enable/disable intent remain the source of lifecycle and host keys.
The SSH login on the host-only ingress does not select an OS identity: all work
runs as the configured container user. PTY and forwarding are allowed as for a
plain authorized key; agent/X11 forwarding remain unavailable.

No REST endpoint, protobuf, language binding, persistent configuration field,
or guest TCP address change is needed. CLI changes are outside this scope;
local and remote CLI retain their existing network/TCP tunnel behavior.
No automatic fallback from the dedicated Rust path.

## Related work and lessons

### Socket cleanup and error reporting

Remove stale SSH socket files through `BoxSockets::real_dir()`, while retaining
the short alias for socket binding and connection. At `f88a8ca`,
`src/boxlite/src/vmm/controller/shim.rs:360` removes `ssh_sock()`, which depends
on the alias. `src/boxlite/src/net/socket_path.rs:99,123` distinguishes the real
directory from the short binding path. Missing aliases can hide existing files
from cleanup; unlinking the real path does not use the socket address limit.

Normal startup already restores the alias in
`src/boxlite/src/runtime/layout.rs:605`. This change covers alias loss between
preparation and cleanup, rather than asserting that ordinary restarts fail.
Preserve missing-file tolerance and propagation of other cleanup errors. Avoid
adding another alias-repair step or extracting a cleanup abstraction for one file.

Validate by binding and closing a real Unix socket, removing its directory
alias, and invoking `ShimController::start()`. Place a directory at the stderr
file path to stop before process spawn (`spawn.rs:148,217`), then assert cleanup
removed the real file. With production
unchanged, that assertion must fail; with the real-path removal it must pass.
Also exercise cleanup with an existing alias and with no stale file.

Correct the guide and this investigation to match
`src/boxlite/src/litebox/network.rs:651`: stream I/O errors reach `connect()`
callers, but individual forwarded-client errors are logged. `wait()` and
`close()` return the listener's terminal result, not relay failures. Link this
investigation from the contributing landing page. These documentation changes
describe existing behavior and require no relay implementation change.

### Tunnel lifecycle alignment

SSH tunnel preparation follows the local network tunnel's lifecycle: start the
VM and container main command as needed, then retain a lazy connection opener.
Preparation does not configure or enable SSH. Connections and forwarded clients
use the box's socket path, which may belong to a restarted instance of that box.

Evidence at `f88a8ca3ffb2e9876cbc5fb3803f4c0c1a8d9bca`:

- `src/boxlite/src/litebox/box_impl.rs:1704` calls `live_state()` before returning
  a network tunnel; its opener captures the network backend without a shutdown
  token. `live_state()` at line 1116 boots and starts the container. Its shared
  startup path rejects spent handles and propagates startup failures.
- `src/boxlite/src/net/gvproxy/services.rs:481` connects to the saved control
  socket on each open, with a bounded handshake and no box-state or cancellation
  check. `src/boxlite/src/litebox/network.rs:339` reuses that opener for every
  forwarded client. A prepared tunnel does not restart a stopped box itself.
- `src/boxlite/src/litebox/ssh.rs:176` instead requires an already-running box
  and retains its shutdown token. This extra policy makes SSH preparation and
  reconnection differ from the network tunnel despite sharing `BoxTunnel`.

Reuse `live_state()` for SSH preparation and retain only the SSH path in its
opener. Keep the 15-second socket timeout, raw-byte behavior, disabled-network
support, and REST `Unsupported` response. Do not add instance-generation checks
or a second startup abstraction. Keeping the old SSH policy would preserve the
inconsistency; binding both transports to a VM generation would change the
existing network API and prevent reconnection to the same restarted box.

Validation planned before implementation:

- Mock guest startup: preparing SSH must issue `Container.Start`, propagate its
  failure, and leave SSH control untouched. The previous implementation skips it.
- Real Unix socket boundaries: prepared connections and a forwarder must reach
  a replacement listener after the old instance stops and its token is cancelled.
  No listener must still produce a network error, without initiating startup.
- Real VM: prepare SSH on a fresh box and a fresh stopped-box handle without
  explicit `start()`, then verify execution and saved disabled SSH intent.
- Run the regression tests with all non-test files restored to their pre-change
  state, observe the old behavior fail, then restore the change and rerun.

Working-tree baseline: `7f28cd5f295ac54f96c477141a096db590b936ed`.

| Question | Evidence and decision |
| --- | --- |
| Current path? | `src/cli/src/commands/ssh/mod.rs:224` prepares `network().tunnel()`; `src/boxlite/src/litebox/box_impl.rs:1700` opens it through the network backend. Control separately uses `Ssh.Control` over the portal. Keep control unchanged. |
| Existing transport? | `src/boxlite/src/vmm/krun/engine.rs:484` and `context.rs:490` map a Unix listener to a guest vsock port with `add_vsock_port(..., true)`. Reuse this mapping for a raw byte stream; the runtime sends no CONNECT preamble. Existing shared ports are 2695 (control) and 2696 (ready); allocate 2697 for SSH. |
| Direct stream or TCP relay? | Russh 0.62.4 `server::run_stream`, registry source `src/server/mod.rs:1049–1088`, accepts `AsyncRead + AsyncWrite`, writes identification then waits for peer identification before spawning its session. [VsockStream 0.7.2](https://docs.rs/tokio-vsock/0.7.2/tokio_vsock/struct.VsockStream.html#trait-implementations) supplies those traits and `AsFd`. Pass it directly to the existing session owner. A guest TCP relay adds buffering, another lifetime, and address mapping without needed functionality. |
| Trust boundary? | `src/guest/src/service/server.rs:160–180,326` checks the host CID because tenant processes can connect to guest vsock. Apply that check before selecting trusted authentication. SSH inherits the existing RPC directory permissions, including the real-path alias. Client input never selects the authentication mode. |
| Session ownership? | `src/guest/src/service/ssh/mod.rs` tracks connection permits, child task groups, handshake/auth deadlines and socket shutdown. Generalize its socket descriptor handling for TCP and vsock, retaining that lifecycle. `server.rs:76` commits authentication and signals its monitor; trusted `none` must use that same path. |
| Host forwarding? | `src/boxlite/src/litebox/network.rs:124–158,287–345` already supplies opaque duplex connections and prepared tunnel forwarding. Reuse these through `SshHandle::tunnel()` instead of introducing another relay API. |
| Path/sandbox integration? | `src/boxlite/src/net/socket_path.rs:118` is the socket path authority; `src/boxlite/src/jailer/mod.rs:613` grants exact bind endpoints and aliases. Add `ssh.sock` to both, including with networking disabled. Remove its stale file with the existing pre-spawn cleanup. |

Retaining the current network path fails the independent-channel
requirement; adding SSH inside gRPC would share the control transport and add
framing. Reusing russh directly has fewer owners than a guest TCP relay.

## How it works

```text
Rust SshHandle
  ↔ BoxConnection / existing forwarder
  ↔ ssh.sock beside box.sock (AF_UNIX stream, libkrun listener)
  ↔ guest vsock 2697 (host CID only)
  ↔ russh (SSH none authentication)
  ↔ existing container execution / SFTP / forwarding
```

1. The VMM registers the SSH mapping independently of gvproxy. The guest's
   vsock server selects dedicated SSH support before sending ready, without
   waiting for SSH configuration, a client, or any SSH handshake.
2. Enabling/restoring SSH binds its existing TCP listener and the dedicated
   vsock listener before publishing a healthy generation. Bind errors return
   failure and drop partially created listeners. Unix/TCP guest test servers
   do not require AF_VSOCK support.
3. Both listeners share the accept task and connection limit. Only a host-CID
   vsock accept selects trusted `none`; TCP retains credential authentication.
   Admit and spawn under the manager lock, but never await identification or
   authentication while holding it. A silent client consumes one bounded slot.
4. `SshHandle::tunnel()` starts the VM and container main command as needed through
   the same startup path as the network tunnel, without opening a connection or
   changing saved SSH configuration; disabled SSH fails when used. REST backends return
   Unsupported for this new local API. CLI does not use this API. Local socket
   failures never fall back to networking. `connect()` opens the Unix stream
   under a 15-second timeout, without an instance cancellation check;
   it returns without consuming any SSH bytes. The caller can immediately run
   OpenSSH or `russh::client::connect_stream` and authenticate with `none`.
   A prepared tunnel can fail or receive EOF if SSH is disabled concurrently.
   It does not start the box again when connected, but can reach the same box
   after another operation restarts it, including through an existing forwarder.
5. Reads and writes are independent, retaining existing bounded forwarding and
   half-close behavior. Local I/O errors on `connect()` streams propagate to the
   caller. Individual forwarded-client failures are logged and do not reach
   `wait()` or `close()`, which report the listener's terminal result. Guest SSH
   failures are logged without credentials and close the transport. No retries.
6. Disable/reconfigure/shutdown cancel both accepts and sessions, shut down
   duplicated socket descriptors, and drain existing task groups within the
   existing deadline. TCP and vsock use the same limits and cleanup. SSH host
   keys and protocol key exchange remain necessary; bypassing user credentials
   does not alter the SSH protocol or clients' host-key policies.

Explicit forwarding delegates access: calling `BoxTunnel::forward()` on the
SSH tunnel allows anyone able to reach the chosen listener to use the
credential-free channel. Loopback is reachable by other local users; a
non-loopback bind can expose it to other hosts. Document this contract and test
socket mapping and forwarding. `connect()` opens no listener. CLI retains its
existing credential-authenticated TCP behavior.

## Validation

Planned checks through make targets:

- Host unit tests: preparation starts the container and propagates startup errors,
  spent-handle refusal, lazy socket connect, no handshake wait, simultaneous byte
  transfer, half-close, missing socket, and reconnection after instance cancellation.
- Linux guest tests: trusted `none` succeeds without an authorized login/key;
  TCP `none` fails; trusted ingress rejects non-host CIDs; silent handshake
  does not block another connection or disable; disable drains trusted clients.
- Existing CLI SSH tests cover REST tunnel selection and stdio relay errors.
- Socket sandbox tests include both short and resolved SSH paths when network
  access is disabled. Existing socket path length invariant still holds.
- Rust formatting/lint and actual VM integration where build artifacts and
  virtualization permit. Socket fixtures do not prove libkrun bridging; report
  that separately if hardware integration cannot run.

### Observed results

| Check | Result |
| --- | --- |
| `BOXLITE_DEPS_STUB=1 make test:unit:rust FILTER=ssh` | 15 host tests passed in each feature pass. |
| `make test:unit:guest FILTER=ssh` in the local Linux container | 136 tests passed, including the three dedicated-ingress tests. |
| `BOXLITE_DEPS_STUB=1 make test:unit:cli` | 356 tests passed, including existing REST and stdio relay coverage. |
| `make test:unit:rust FILTER=sockets` and `FILTER=test_jailer_full_flow_with_real_tempdir` (dependency stubs) | Both endpoint aliases granted with and without networking; all selected tests passed. |
| `BOXLITE_DEPS_STUB=1 make test:unit:rust FILTER=binding_paths_are_short_and_deterministic` | SSH uses the existing short directory and remains within the socket path limit. |
| `make runtime:debug` | Built macOS arm64 shim, Linux arm64 guest and runtime tools. |
| `make test:integration:rust SETUP_DONE=1 FILTER=guest_ssh_dedicated_vsock_without_network_or_client_credentials` with the built runtime directory | Real macOS/libkrun VM passed: networking disabled, OpenSSH public-key/password methods disabled, unconfigured login, container UID/GID, disable, stop/reacquire/start, restored disabled intent, re-enable and SSH identification over the new mapping. |
| `make clippy`, `make fmt:check:rust`, `git diff --check` | Passed; clippy includes Linux guest cross-target checks. |

### Lifecycle alignment results

With every non-test file restored to `f88a8ca`,
`BOXLITE_DEPS_STUB=1 make test:unit:rust FILTER=ssh_dedicated_transport`
failed all four new regression cases: preparation skipped container startup and
its error, a prepared connection returned `Stopped` after cancellation, and a
forwarded client never reached the replacement listener within two seconds.
The modified real-VM test failed at initial preparation with
`InvalidState("SSH transport requires a running box")`.

With the implementation restored:

- `BOXLITE_DEPS_STUB=1 make test:unit:rust FILTER=ssh`: 19 host tests passed in
  each feature pass, plus five shared SSH tests.
- `make test:integration:rust SETUP_DONE=1 FILTER=guest_ssh_dedicated_vsock_without_network_or_client_credentials`,
  using the built runtime: passed on macOS/libkrun. Preparation booted the fresh
  box and restarted a stopped box without explicit `start()`, preserved saved
  disabled intent, and supported SSH execution with networking disabled.
- `make clippy`, `make fmt:check:rust`, and `git diff --check`: passed.

### Socket cleanup results

Before the real-path fix,
`BOXLITE_DEPS_STUB=1 make test:unit:rust FILTER=ssh_socket_cleanup_does_not_depend_on_binding_alias`
reached the cleanup assertion and failed with
`stale SSH socket survived cleanup: alias_present=false` in both feature passes.
After the fix, `BOXLITE_DEPS_STUB=1 make test:unit:rust FILTER=ssh` passed all
20 host tests in each pass, including all four alias/file combinations, plus
five shared SSH tests. The dedicated SSH real-VM test passed again on macOS;
`make clippy`, `make fmt:check:rust`, and `git diff --check` also passed.

Linux host KVM integration was not run. Linux guest unit tests used Unix stream pairs for stream handling,
while the macOS VM test exercised the actual Unix/vsock bridge.

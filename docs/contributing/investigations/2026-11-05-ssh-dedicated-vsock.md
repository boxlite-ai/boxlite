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
4. `SshHandle::tunnel()` prepares local access on an existing VM without starting
   it or opening a connection; disabled SSH fails when used. REST backends return
   Unsupported for this new local API. CLI does not use this API. Local socket
   failures never fall back to networking. `connect()` opens the Unix stream
   under a timeout and cancellation;
   it returns without consuming any SSH bytes. The caller can immediately run
   OpenSSH or `russh::client::connect_stream` and authenticate with `none`.
   A prepared tunnel can fail or receive EOF if SSH is disabled concurrently.
5. Reads and writes are independent, retaining existing bounded forwarding and
   half-close behavior. Local I/O errors propagate to the caller; guest SSH
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

- Host unit tests: disabled/stopped refusal, lazy socket connect, no handshake
  wait, simultaneous byte transfer, half-close, missing socket, cancellation.
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

Linux host KVM integration was not run. Linux guest unit tests used Unix stream pairs for stream handling,
while the macOS VM test exercised the actual Unix/vsock bridge.

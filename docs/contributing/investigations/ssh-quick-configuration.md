# CLI-managed SSH setup

Design: https://github.com/boxlite-ai/boxlite/issues/2303

## Contract

`boxlite ssh setup BOX` takes no key arguments. It generates Ed25519 client and
host keys under the resolved runtime home's `boxes/<box-id>/ssh/` directory,
then calls the existing Rust `configure(SshConfig)` API. The resulting SSH
configuration accepts login `box` with the generated client public key, has no
CA, listens on `0.0.0.0:22`, and is enabled immediately.

Setup owns the complete configuration and can replace a host key previously
installed by `configure`. Repeated setup reuses its managed identities and
reapplies the configuration, disconnecting existing SSH clients. The complete
configure interface retains its original parameters and behavior.

The key directory is 0700 and private files are 0600. Both keys are generated in
a private staging directory before installation. Existing incomplete, corrupt,
symlinked, or non-private credentials cause an error; setup never silently
replaces them. The client private key remains on the host, outside guest mounts.
Guest configuration failure retains the keys for retry. Removing the box removes
its managed keys; clone/export does not transfer the CLI-managed client identity.

Success prints an English summary and the private-key location, followed by a
copyable OpenSSH command. The command includes the private-key path, absolute CLI
executable, resolved home, selected context and canonical box ID.
Shell quoting and SSH percent-token escaping preserve arguments; unsupported
path encodings or substitutions fail before configuring SSH. Normal host-key
verification remains enabled. Setup requires installed OpenSSH client tools.

## Proxy and SDK boundary

`boxlite ssh proxy BOX` is a local-only ProxyCommand byte stream. It checks SSH
status and uses `BoxTunnel::connect()` plus its independent read/write halves.
It opens no local listener, changes no authentication, and sends diagnostics only
to stderr. Existing `forward` remains available for a local listener.

Stdin and stdout use dedicated threads with bounded channels; stdout writes are
acknowledged before reading more tunnel data. This avoids uncancellable Tokio
blocking-pool IO preventing process shutdown. Stdin EOF half-closes the tunnel;
remote output drains until EOF. Remote EOF or termination ends the relay even if
stdin remains open. SIGHUP, SIGTERM and Ctrl-C release the connection and runtime.

Proxy requires a running box and enabled SSH. It never starts the box or enables
SSH. The existing exclusive runtime home lock lasts through the connection;
other local CLI commands on that home must wait until the proxy exits. Use a
detached box so CLI exit does not stop it.

The Rust SDK exposes `configure`, `status`, `enable`, and `disable`. There is no
SDK setup method or internal Setup RPC. Enable restores saved configuration on
a running local box; healthy SSH keeps its connections. Enable without saved
configuration fails. Enable/disable on valid idle local handles return
`InvalidState` without starting the box or modifying saved intent; status remains
observational. Existing SDK bindings inherit the changed disable behavior.
REST retains its existing control routes; enable is unsupported on REST handles,
and CLI setup/proxy reject remote backends before creating credentials.

## Validation

The previous idle-disable assertion failed against the original production code
and passed with the lifecycle change. Keyless CLI setup and proxy are new
contracts over unchanged configure/tunnel dependencies, not fixes to equivalent
existing entry points.

Validation includes actual key generation, permission and corruption checks,
second-key generation failure with clean retry, nested shell/OpenSSH command
parsing, real VM login with the printed command, wrong-key rejection, binary
transfer, signal cleanup, saved identity reuse, and stop/start behavior.

Observed results for this revision:

| Check | Result |
| --- | --- |
| `BOXLITE_DEPS_STUB=1 make test:unit:cli` | 341 passed. |
| `BOXLITE_DEPS_STUB=1 make test:unit:rust FILTER=ssh` | SSH runtime/shared tests passed, including REST-enabled runtime coverage. |
| `make test:integration:cli FILTER=ssh` | 39 passed with real runtime artifacts. |
| `make test:integration:cli SETUP_DONE=1 FILTER=ssh_local_setup_enable_and_restart` | Enhanced journey passed: fresh box, partial generation failure, retained keys after configure failure, special paths, OpenSSH binary transfer, signal cleanup and restart. |

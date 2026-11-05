# Guest SSH control

SSH starts disabled when no saved configuration exists. The Rust runtime exposes `LiteBox::ssh()` to configure,
query, or disable it, for local boxes and for REST-backed boxes served by
`boxlite serve` ([HTTP control](#http-control-with-boxlite-serve)) or the
[hosted cloud API](#hosted-cloud-api). Only
`configure(config)` follows the implicit-start policy of exec, metrics, and file
copying. A `Configured` or `Stopped` box using the image's default command can
start implicitly. If `BoxOptions.cmd` or `entrypoint` explicitly sets the main
command, configuration returns `InvalidState` in these states; call `start()`
first. On a REST server, a stopped box with `auto_resume=false` is refused
instead of resumed.

`status()`, `enable()` and `disable()` never start the VM or container main command.
On valid `Configured` or `Stopped` local handles, `status()` returns disabled status
with generation zero and empty address and host identity fields. `enable()` and
`disable()` return `InvalidState`, leaving saved state unchanged; start the box first.
Disable SSH while the box is running to persist the disabled switch.
Running boxes send requests to the existing guest, including after `attach()`
before `start()` and after runtime recovery. Other lifecycle states return
`InvalidState`. Results describe the state observed by the call; a concurrent
`configure()` can subsequently enable SSH.

Creating the handle alone does not start anything. Deployments without SSH
control answer `404` or reject with `Unsupported`; there is no capability
negotiation. See the [SDK API references](../reference/README.md#sdk-api-references)
for language-specific control APIs.

SSH does not publish a host port; forward one with [`boxlite ssh --tunnel`](#cli)
or other network forwarding. For component diagrams and implementation details, see
[Guest SSH architecture](../../src/guest/src/service/ssh/README.md).

The SDKs expose `configure`, `status`, `enable`, and `disable`; Rust also exposes
the local [dedicated data channel](#local-data-channel).
Automatic credential management belongs to the CLI's [default setup](#cli) command.
`enable()` uses saved configuration, errors if none exists, and preserves
connections when SSH is already healthy. It requires a running box on both local
and REST backends; it never starts or auto-resumes the box.

Complete configuration remains available for custom addresses, host keys,
accounts, and certificate authorities:

```rust,ignore
use boxlite::{SshAccount, SshConfig};

let ssh = sandbox.ssh();
let status = ssh.configure(SshConfig {
    listen_address: "0.0.0.0:2222".into(),
    host_private_key: std::fs::read_to_string("host_key")?,
    accounts: vec![SshAccount {
        login: "alice".into(),
        authorized_keys: vec![std::fs::read_to_string("alice.pub")?],
        ca: None,
    }],
}).await?;
println!("{} {}", status.host_public_key, status.host_key_fingerprint);
let current = ssh.status().await?;
ssh.disable().await?;
```

`SshHandle` owns its backend reference and can outlive the `LiteBox` borrow.
A fresh handle to a running VM can query SSH without calling `start()` again.
For local SSH control, after startup each operation has a total 15-second budget:
the guest's 10-second cleanup limit plus 5 seconds for communication and
scheduling. Obtaining the SSH interface, connection setup, queueing, and the
RPC all consume this budget; VM and container startup time is excluded.
Connection or queueing delays can leave less than 10 seconds for guest cleanup.
Local runtime shutdown rejects new SSH control operations and cancels interface
acquisition and RPCs. In-progress VM initialization finishes before
cancellation is returned, so detached boxes remain recoverable; container
startup retains its own cancellation. Operations are not automatically retried.
Timeout or cancellation does not undo changes the guest may already have
applied.
Invalidated handles return `Stopped`; drop all references to the old box and
obtain a fresh handle with `runtime.get()`. That handle can query SSH without
restarting the box; enable/disable require a running box. A stopped box with an
explicit main command still requires `start()` before `configure()`.

## CLI

`boxlite ssh` wraps the same handle for local and REST boxes; the
[CLI reference](../reference/cli/README.md#boxlite-ssh) lists every flag.

```bash
# Use a detached box so it survives CLI exit.
boxlite run -d --name dev alpine:latest tail -f /dev/null
boxlite ssh dev
```

Default setup takes no key options. It generates Ed25519 client and host keys under
`<home>/boxes/<box-id>/ssh/` for local boxes, with a 0700 directory and 0600 private files.
The client private key stays on the host. Subsequent setup reuses both identities;
corrupt, incomplete, or unsafe key files cause an error instead of replacement.
Setup calls the existing complete configuration API, enabling `box` on
`0.0.0.0:22` with the generated client public key and no CA. It replaces any
previous configuration, including a host key supplied through `--configure`.
Login `box` still executes as the container's configured user.

On success, setup prints an English connection summary, the private-key path,
login, actual guest address and server host-key fingerprint, followed by a complete
command to copy and execute:

```bash
ssh -o 'IdentityFile="/boxlite-home/boxes/BOX_ID/ssh/client_key"' -o IdentitiesOnly=yes \
  -o 'ProxyCommand=/usr/local/bin/boxlite --home /boxlite-home ssh --proxy -- BOX_ID' box@BOX_ID
```

The actual command includes absolute paths, the selected context, and the box ID.
It preserves normal SSH host-key verification. `ssh-keygen` must be installed.
The `--proxy` command connects stdin/stdout to the enabled guest SSH listener
without opening a local port. Diagnostics use stderr. It reads status and refuses
disabled SSH; it never configures or enables SSH.

Local client credentials belong to this host's box directory: deleting the box removes
them, and clone/export does not transfer the CLI-managed client key. Failed guest
configuration retains generated keys for retry. Repeated setup disconnects existing
clients, as complete configuration does.

For a cloud box, select its existing connection context:

```bash
boxlite --context cloud ssh dev
# Copy and run the complete printed ssh command.
# Explicit endpoint/routing overrides also carry into the printed command:
boxlite --url https://api.example.com --path-prefix team ssh dev
```

Setup uses the context's authentication and the same URL/prefix precedence as
other commands. It stores keys on this machine under
`<home>/ssh/remote/<scope>/<box-id>/`, isolated by context, endpoint and routing
prefix. Repeating setup with the same selection reuses keys, including after a
failed configure request. Deleting a remote box leaves these files on the client;
remove that box's credential directory when no longer needed.

The generated command preserves a named context or an explicit URL, plus the
routing prefix, while loading credentials normally at execution time. Named
contexts reload their saved endpoint; URL selection uses default credentials.
An empty routing prefix is explicitly pinned with `--path-prefix=''`; adding a
prefix to the saved context later does not change the printed command's route.
The command does not embed API keys or access tokens. Keep
`BOXLITE_API_KEY` available if that is your authentication source. A scoped SSH
hostname separates remote host-key records. Local runtime configuration is
ignored for cloud setup, and remote CLI exit does not stop the box.

Cloud proxy needs enabled SSH, server tunnel support and inbound access. Setup
configures SSH without opening a tunnel; proxy opens the public tunnel on
connection. `boxlite serve` supports setup but has no tunnel endpoint for proxy.
Use `boxlite --context cloud ssh --enable dev` to reactivate saved configuration
on a running box without replacing keys or interrupting healthy SSH connections.

For custom credentials, keep using `boxlite ssh --configure dev --ssh-config ssh.json`
or `boxlite ssh --configure dev --host-key host_key --login alice --authorized-key alice.pub`.
The existing listener-based workflow remains available:

```bash
boxlite ssh --tunnel dev
boxlite ssh --disable dev
boxlite ssh --enable dev
```

Stop the foreground proxy/tunnel process before issuing another local CLI command
against the same home: the runtime holds an exclusive home lock for the connection.

- `--configure` replaces the whole configuration once, which disconnects
  every SSH client, including those connected through another tunnel.
- `--tunnel` reads status and targets the port SSH actually bound, so a guest
  listener on port `0` works. It leaves configuration and generation unchanged.
  Ctrl-C ends only local forwarding; guest SSH stays enabled.
- A local CLI exit stops boxes that are not detached (plain `boxlite run`, SDK
  boxes with `detach=false`). Saved SSH intent is restored when the box restarts.
  Boxes from `boxlite create` and `run -d` keep running. Setup prints this warning
  before its connection command: successful configuration alone does not mean a
  non-detached box will remain available after setup exits.
- Over REST, proxy/tunnel open the box's public tunnel for the SSH port and leave it
  open, so anyone who reaches it can attempt a login and wake a stopped box; SSH keys
  remain the access control. Close it with `boxlite network tunnel BOX PORT --revoke`.

## Local data channel

Rust `SshHandle::tunnel()` uses `runtime ↔ ssh.sock ↔ vsock ↔ guest SSH`.
`ssh.sock` sits in the existing per-box `sockets/` directory beside the RPC
`box.sock`, with the same directory permissions and short-path alias mechanism.
The guest SSH vsock port is 2697; RPC and ready notification retain 2695/2696.
This path works with box networking disabled and with a loopback TCP SSH address.
Preparing or connecting this channel publishes no TCP port. CLI `--proxy` and
`--tunnel` continue using the existing network/TCP path and authentication.

This channel accepts SSH `none` authentication: the client needs no user key,
certificate, password, or configured login. Commands still run as the container
user. SSH protocol key exchange and client host-key verification still apply.
Existing configuration supplies the server host key and enabled state; TCP and
REST connections retain their account authentication.

Rust can prepare `let tunnel = sandbox.ssh().tunnel().await?` and open
`let stream = tunnel.connect().await?`. As with a local network tunnel,
preparation starts the VM and container main command as needed, including an
explicit command, but opens no data connection. It does not configure or enable
SSH; startup restores saved SSH configuration and enabled state. To prepare a
new tunnel after stopping a box, obtain a fresh handle with `runtime.get()`.
Preparation on the old handle returns `Stopped` before VM initialization, even
if the box was stopped before its first boot.

`connect()` and each forwarded client open the saved socket path without starting
the box again or checking the previous instance's cancellation token. A tunnel
prepared before a stop can reach the same box after it restarts. Connections
already open are not migrated. Missing sockets return a network error.
`connect()` has a 15-second socket connection limit and returns without consuming
SSH bytes; then run an SSH client over the duplex stream. Disabled SSH
refuses/closes the stream. No local network fallback occurs. Runtime and guest
must be upgraded together and the VM restarted to install the new mapping. The
Rust data API returns `Unsupported` on REST handles.

Calling Rust `forward()` on this SSH tunnel explicitly delegates credential-free
access to everyone who can reach its listener. Loopback includes other local
users; an external bind address can expose it to other hosts. Use `connect()`
when no local listener is needed.

The existing relay supports concurrent reads/writes and write half-close, so
write EOF still allows a final response. On streams returned by `connect()`,
local I/O failures propagate to the caller. Individual forwarded-client failures
are logged; they do not reach `wait()` or `close()`, which report the listener's
terminal result. Guest SSH failures close the transport. Disable, reconfigure
and guest shutdown cancel and drain dedicated sessions with the same deadlines
as TCP.

## HTTP control with `boxlite serve`

The local server exposes the same handle at `/v1/boxes/{box_id}/ssh`. Against
another compatible server the Rust client uses the existing `path_prefix`
convention, `/{prefix}/boxes/{box_id}/ssh`:

| Method   | Behavior |
|----------|----------|
| `POST`   | Replace the complete `SshConfig` body; returns the resulting `SshStatus`. Every accepted call fully restarts the guest listener, so never retry it automatically. |
| `GET`    | Read `SshStatus`. Never starts the VM or its main command. |
| `DELETE` | Disable SSH idempotently on a running box; returns `SshStatus`. Never starts the VM or its main command. An idle local box returns `409 invalid_state`, leaving saved state unchanged. |

The separate bodyless `POST /v1/boxes/{box_id}/ssh/enable` endpoint enables
saved configuration and returns `SshStatus`. For example, after `disable()`,
call `enable()` to restore SSH without sending the keys again. A stopped box
returns `409 invalid_state`; a missing configuration also returns `409 invalid_state`.

The lifecycle and resume rules above also apply over HTTP. Authenticated
`POST /ssh` requests count as AutoStop activity, including rejected configurations;
`GET`, `HEAD`, `DELETE`, and `POST /ssh/enable` do not.

Send JSON with the fields defined in the [OpenAPI contract](../../openapi/box.openapi.yaml).
Unknown fields are rejected in the configuration, accounts, and CA objects.
Malformed bodies return `400 invalid_argument` with `invalid SSH configuration`,
without echoing request values. Invalid configurations leave the running
listener untouched. Other errors include `404 not_found`, `409 invalid_state`
for lifecycle conflicts (`409 conflict` for AutoResume refusal), and
`503 upstream_unavailable` for guest RPC failures.

The Rust client's 300-second request timeout includes startup; a timeout does
not undo configuration or stop work still running on the server. See the
[Rust SSH reference](../reference/rust/README.md#ssh-control) for types and API details.

Build the request body from local key files; do not commit it or paste a real
private key into a document:

```bash
# ssh-config.json carries the SshConfig shape, built locally from your keys.
curl -fsS -X POST "$BOXLITE_URL/v1/boxes/$BOX_ID/ssh" \
  -H "Authorization: Bearer $BOXLITE_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @ssh-config.json
```

## Hosted cloud API

The hosted API serves configuration, status and disable at `/v1/boxes/{box_id}/ssh` and
`/v1/{prefix}/boxes/{box_id}/ssh`, by box ID or name, within the caller's
organization. The API checks policy and lifecycle; the box's runner validates the
body and calls the guest once. Enable uses the `/ssh/enable` suffix on both paths.
It requires `write:boxes` and a running box, returns `409` for stopped or
transitional states, and neither auto-resumes nor records activity. The runner
checks the running state again before dispatch.

| Method   | Permission    | Activity | Lifecycle |
|----------|---------------|----------|-----------|
| `POST`   | `write:boxes` | Counts after authorization and box lookup, including lifecycle refusals | Running box: configured. `stopped` box: auto-resumed on its default command. `409` when the box is not ready and `auto_resume=false`, when it must start a box with an explicit `cmd`/`entrypoint`, or when it cannot resume (`error`, `archived`, …). |
| `GET`    | membership    | None      | `started` or `stopped` only; a stopped box reports disabled status with generation `0`. Other states answer `409`. |
| `DELETE` | `write:boxes` | None      | Running boxes only; repeated calls succeed even when SSH is already disabled. Stopped or transitional boxes return `409` without changing saved SSH intent. |

Cloud disable now matches the local runtime: a stopped box returns `409` instead
of the previous successful disabled status. Call disable while the box is
running to persist the disabled switch; status on a stopped box only reports
that no listener is currently running.

With auto-resume enabled, configuring SSH waits for a box already starting
(`creating`, `starting`, `restoring`), even with an explicit `cmd` or `entrypoint`.
You can request start, then configure SSH while that start completes.

Errors follow the [HTTP control](#http-control-with-boxlite-serve) rules, with two
differences:

- The API parses JSON before proxying. Malformed JSON returns `400` `Invalid JSON in
  request body`. Repeated keys collapse to their last value before the runner sees
  them; case-variant and unknown fields, and `null` values where the schema
  requires a string or array, are still rejected. The optional `ca` may be `null`.
- Lifecycle refusals from the API are a plain `409` with a message naming the
  reason; SDKs read them, like the runner's `409 invalid_state`, as `InvalidState`.

Hosted servers running an older runtime may require configuration again after a
restart. Forwarding fails while the listener is disabled.

Proxy and forwarding use the box's [public tunnel](#cli), which needs inbound
access enabled on the box. Ending the local `boxlite ssh --proxy` or `--tunnel`
leaves that tunnel open; revoke it with `boxlite network tunnel BOX PORT --revoke`.

## Guest protocol and lifecycle

The internal host-only `boxlite.v1.Ssh` gRPC service on `sockets/box.sock` exposes
one `Control` RPC. An empty request returns actual listener state, even before
`Guest.Init` completes, without disk reads or writes, listener startup, or restart.
Mutations require `Guest.Init` and a ready container root filesystem. Configuration
uses field 4 and optional enable uses field 5; legacy fields 1–3 remain reserved.
Host and guest versions must be upgraded together: old config-only calls no longer
enable SSH, and the former Configure, Status, and Disable RPCs are unavailable.

A supplied configuration contains an unencrypted OpenSSH host private key and a
non-empty `accounts` list. Each account has a unique `login` and at least one public key or
CA configuration. Logins are 1–128 ASCII letters, digits, dots, underscores, or
hyphens. Authentication selects only that login's credentials. A CA contains its
public key and the required certificate principal; the principal need not equal
the login. Certificate validity and permissions are checked as before; plain
authorized keys allow PTY and forwarding. Each `authorized_keys` entry is one
OpenSSH public key with an optional comment, without authorized_keys options.

The former global `SshConfig.ca` and `SshConfig.authorized_keys` fields (3 and 4)
are reserved, including their names. Accounts use field 5. Regenerate bindings
and migrate credentials into explicitly named accounts. An old configuration
decodes without accounts and returns `InvalidArgument`, leaving the existing
service running. There is no implicit `root` account.

Authentication accounts do not need entries in the container's `/etc/passwd`.
For example, `alice` and `bob` can both execute as the container's default `app`
user. Shell, exec, PTY, SFTP, and both directions of Unix socket forwarding
inherit the UID/GID selected at container creation from the image `USER` or box
user override. Accounts share that identity and its file permissions; they do
not provide operating-system isolation from one another.

After entering the container, SSH resolves the actual execution UID and sets
`USER`, `LOGNAME`, `HOME`, and `SHELL`. Client environment requests cannot override
these values or select an execution identity. A numeric UID without a passwd
entry uses its numeric name, `/` as home, and `/bin/sh` as shell. An empty passwd
shell also uses `/bin/sh`; a configured shell that is missing fails explicitly.
Shell and SFTP start in the user's home, falling back to `/` if it cannot be
entered. Non-root SFTP and Unix socket helpers clear effective, permitted,
inheritable, and ambient capabilities before serving; they retain the bounding
set. TCP forwarding remains guest-side and uses the session's authorization.

Configuration is saved in `/etc/boxlite/ssh.cfg` in the container filesystem,
with a root-owned 0700 directory and 0600 file. Container root and the host can
read the credentials; clones, snapshots, exports and imports carry both the
private key and SSH identity. A missing file defaults to disabled. Initialization
restores enabled SSH without running the main command; invalid or unreadable
state logs a sanitized warning and does not prevent container initialization.

The internal RPC `Control(enable, config)` retains each absent field and
replaces supplied configuration. Configuration-only preserves the switch, an empty update observes,
and enabling without configuration fails. Supplying configuration while enabled
restarts the listener even if unchanged; repeated enable of a healthy listener
preserves connections. A complete update supplying both fields replaces saved
content without reading it, so `configure(config)` can repair a corrupt file.
Partial updates reload saved state to retain omitted fields.

Explicit disable stops the current listener and drains SSH work before reading
or saving state, retaining credentials when persistence succeeds. If storage
fails, the call returns an error but current SSH stays stopped; the saved switch
may still be enabled and restore SSH after a restart. For example, a failed
`disable()` followed by disabled `status()` confirms only the current VM is
stopped. Repair storage and retry disable to persist it. Even if accompanying
configuration is invalid, explicit disable stops SSH before returning the error.
Other updates validate and persist before replacing the live listener; validation
or storage errors preserve it. A bind or drain failure leaves the saved intent
for a later retry. A post-rename sync error leaves disk durability uncertain,
and the next partial update reloads the file.

Status reports actual listener health and public host identity. Generation counts
successful starts in the current VM. Shutdown drains SSH without changing saved
intent and rejects new mutations. The existing public operations remain:
`configure(config)` replaces the configuration and enables SSH, `disable()` turns
it off while retaining credentials, `enable()` activates saved configuration,
and `status()` observes the live listener.
The local runtime's `BoxImpl` translates complete configuration to
`Control(enable=true, config=...)`, enable/disable to `Control(enable=true/false)`
on an existing VM, and status to an empty `Control()` request. The CLI's setup
builds a complete configuration and uses the same configure operation. No setup API or RPC is exposed. The portal forwards each RPC once.
Other partial updates remain internal. REST uses POST, DELETE and GET on `/ssh`,
and a bodyless POST on `/ssh/enable`.

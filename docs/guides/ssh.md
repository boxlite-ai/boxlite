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

The SDKs expose `configure`, `status`, `enable`, and `disable`.
Automatic credential management belongs to the CLI's [default login](#cli) command.
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
For a local box, after startup each operation has a total 15-second budget:
the guest's 10-second cleanup limit plus 5 seconds for communication and
scheduling. Obtaining the SSH interface, connection setup, queueing, and the
RPC all consume this budget; VM and container startup time is excluded.
Connection or queueing delays can leave less than 10 seconds for guest cleanup.
Local runtime shutdown rejects new SSH operations and cancels interface
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

Default login takes no key options and requires `ssh` and `ssh-keygen` on PATH.
The CLI checks execute access using its effective user/group before creating
credentials or changing guest SSH. Inaccessible tool files are skipped rather
than accepted because another permission class has an execute bit. PATH entries
that are not directories or cannot be searched do not block tools in later
entries. If no tool is found, a directory search permission error is preserved
rather than reported as a missing installation.

It generates Ed25519 client and host keys under `<home>/boxes/<box-id>/ssh/`
for local boxes, with a 0700 directory and 0600 private files. The client private
key stays on the host. Corrupt, incomplete, symlinked or unsafe credentials fail
instead of being regenerated.

OpenSSH file paths must be UTF-8 and contain neither control characters nor
literal `${`. These checks run before managed keys are created or guest SSH is
configured/enabled, so an unusable path leaves existing SSH configuration unchanged.

The CLI prepares SSH before connecting:

| Managed credentials and status | Service operation |
| --- | --- |
| New identity | Configure once with `box` on `0.0.0.0:22`, no CA |
| Existing identity, enabled | Read status only |
| Existing identity, disabled, generation greater than zero | Enable saved configuration once |
| Existing identity, disabled, generation zero | Configure once using saved keys |

Generation zero can describe idle boxes with persisted configuration; it is not
proof that no configuration exists. Configuration follows the startup rules above
and can disconnect existing clients. A first managed configuration replaces any
prior custom configuration. Later healthy connections never reconfigure a changed
host identity: they fail instead. Authentication failure also does not trigger
reconfiguration. Failed configuration retains generated keys for the next invocation;
service operations are not retried within one command.

OpenSSH logs in directly as `box`, which still executes as the container's
configured user. During login or alias installation, credential preparation
validates the local host private key and derives its public key once. The CLI
reuses that public key for status identity verification and
`<credential-directory>/known_hosts`, not the user's known-hosts file.
Local aliases use the canonical box ID; remote aliases include the credential
scope. Status identity must match this local key before connection.

The parent CLI retains its runtime and an ephemeral loopback forwarder until
OpenSSH exits. OpenSSH inherits stdin/stdout/stderr, automatically selects PTY
behavior, handles terminal resizing and sends interactive Ctrl-C to the guest.
Piped stdin works without forcing a PTY:

```bash
printf '%s\n' 'printf "direct-ssh-ok\n"; exit 42' | boxlite ssh dev
echo $? # 42
```

Automatic login ignores user and system SSH config (`-F /dev/null`), disables
agent authentication and connection sharing, and enforces strict host checking.
Default login does not edit `~/.ssh/config`. To use plain `ssh BOX`, explicitly
[install a managed alias](#managed-openssh-aliases). Use `--proxy` or `--tunnel`
with your own OpenSSH invocation when custom client options are needed.

For a cloud box, select its existing connection context:

```bash
boxlite --context cloud ssh dev
boxlite --url https://api.example.com --path-prefix team ssh dev
```

The same resolved authentication, URL and prefix are used throughout the session.
Keys live under `<home>/ssh/remote/<scope>/<box-id>/`, isolated by context,
effective endpoint and routing prefix. Repeating the same selection reuses both
keys, including after a failed configure request. Local runtime config is ignored
for REST login. Deleting a remote box leaves client files for manual cleanup;
deleting a local box removes its credentials. Clone/export does not transfer the
managed client identity.

Default cloud login requires SSH control, tunnel support and inbound access.
`boxlite serve` has no tunnel endpoint: explicit SSH control works, but default
login fails when creating its tunnel. It does not report setup success as a
substitute for connecting. `--proxy` reads status and relays only SSH bytes on
stdin/stdout; it never configures or enables SSH.

For custom credentials, keep using `boxlite ssh --configure dev --ssh-config ssh.json`
or `boxlite ssh --configure dev --host-key host_key --login alice --authorized-key alice.pub`.
The existing listener-based workflow remains available:

```bash
boxlite ssh --tunnel dev
boxlite ssh --disable dev
boxlite ssh --enable dev
```

Stop a local login, proxy or tunnel before issuing another local CLI command
against the same home: the runtime holds an exclusive home lock for the session.

- `--configure` replaces the whole configuration once, disconnecting every SSH
  client, including clients using other tunnels.
- `--tunnel` targets the actual guest port, including when configuration requested
  port `0`. It leaves configuration and generation unchanged. Ctrl-C ends only
  local forwarding; guest SSH stays enabled.
- Non-detached local boxes stay alive until login finishes, then stop when the
  CLI exits. Boxes from `boxlite create` and `run -d` keep running. Saved SSH
  intent is restored when the box restarts.
- The CLI returns the SSH exit code. INT/TERM/HUP/QUIT also cancel a pending tunnel
  preparation request, before OpenSSH is launched. During a session, these signals
  are forwarded to the child, which is reaped before forwarding closes and the
  runtime is released. Cancelling preparation does not roll back a server-side
  public tunnel or revoke one used by other connections.
- REST login, proxy and tunnel leave the public tunnel open. Anyone reaching it can
  attempt a login and wake a stopped box; SSH keys remain the access control.
  Revoke it with `boxlite network tunnel BOX PORT --revoke`. CLI exit does not stop
  the remote box.

### Managed OpenSSH aliases

Install an alias without opening an interactive session:

```bash
boxlite ssh dev --install-ssh-config
ssh dev

boxlite --context cloud ssh dev --install-ssh-config --alias dev-cloud
ssh dev-cloud
```

The installer uses the same credentials, host-key verification and SSH preparation
rules as default login, but does not open a tunnel or launch SSH. It adds one
leading Include to `~/.ssh/config` and writes its entries in
`~/.boxlite/ssh/config`, independently of the runtime/credential `--home`.
Existing user configuration is preserved in `~/.ssh/config.boxlite-backup`
before the first edit; reinstalling does not replace that backup. New managed
directories/files use 0700/0600 permissions. Unsafe ownership, writable
permissions, symlinks and ambiguous configurations fail rather than being
silently rewritten. Marked entries are checked for manual edits; use the CLI
to update their target instead of editing the generated stanza.

Installation requires `HOME` to resolve to the real user's account home, where
plain OpenSSH reads its default configuration. Different symlink spellings of
the same directory are accepted. A different directory is rejected before runtime
creation, key generation, or guest changes; restore `HOME` and retry. This does
not change the independent BoxLite `--home` or `BOXLITE_HOME` credential directory.

Include paths containing `%` work with both older and newer OpenSSH clients.
The installer detects the client version: Include treats `%` literally before
OpenSSH 9.9, while newer clients require `%%` for a literal percent sign.
After changing OpenSSH versions, reinstall the alias. Reinstallation also repairs
the previous managed Include encoding without changing handwritten configuration
or replacing the original backup.

The default SSH alias is the resolved box name, falling back to its complete ID.
Aliases must be a single ASCII hostname-like value; unsupported names require
`--alias NAME`. Aliases are stored in lowercase; use that spelling with `ssh`.
The actual proxy target is always the complete, case-sensitive box ID.
Installing the same alias for the same home and
target updates it idempotently. A different target gives two choices:

```bash
# Retain the original alias and install another.
boxlite ssh dev --install-ssh-config --alias dev-cloud
# Repoint only the existing BoxLite-managed alias.
boxlite ssh dev --install-ssh-config --overwrite
```

`--overwrite` does not change the old box, delete its keys, or overwrite a
handwritten Host block. Matching explicit Host patterns in user configuration,
including conventional nested Includes, are conflicts. General `Host *` defaults
are permitted unless they add authentication identities for the alias. Host
patterns use OpenSSH's case-sensitive matching.
Unknown backslash escapes in Host patterns remain literal, matching OpenSSH.
Exclude an alias with its exact spelling (`!dev`), not an escaped spelling such
as `!d\ev`.

User Includes support conventional quoting, relative paths, `~/` and globbing.
POSIX named character classes such as `[[:alpha:]]`, collating symbols and
equivalence classes are refused because the static scanner cannot expand them
like OpenSSH. Use ordinary wildcards such as `config.d/*.conf` instead.
Relative system Includes resolve under the selected OpenSSH client's compiled
configuration directory, without `~`
expansion. Other token/environment expansions and Match conditions other than
`Match all` are refused; the installer never executes `Match exec`.

The installer checks user and system Include graphs before preparing SSH and
again before publication. It discovers the client's compiled directory using
`ssh -G -F /dev/null`, without evaluating handwritten configuration, rather than
assuming `/etc/ssh`. Unrecognized or ambiguous defaults fail installation.
It also conservatively scans `/usr/etc/ssh/ssh_config` when present to cover
vendor configuration. Relative Includes in that file still use the compiled
directory. Reinstall aliases after changing OpenSSH clients.

An `IdentityFile` (including its legacy `IdentityFile2` spelling) or
`CertificateFile` applying to the alias is rejected: these options accumulate
despite `IdentitiesOnly yes`. A single `IdentityFile none` is allowed, including
case variants and supported double quoting; it does not clear other identities.
Escaped sentinel-like filenames remain rejected, as does `CertificateFile none`,
which OpenSSH treats as a filename. Keep personal identities in Host blocks that
exclude managed aliases, for example:

```sshconfig
Host * !dev !dev-cloud
  IdentityFile ~/.ssh/personal_key
```

Managed entries set `CanonicalizeHostname no`, preventing a second configuration
pass from reactivating identities excluded by the original alias. Other hosts
retain their canonicalization settings. Entries also set `KnownHostsCommand none`,
so a handwritten helper cannot add another host-key trust source. Reinstall
existing aliases to receive these settings. Explicit OpenSSH command-line options
can override managed settings.

Handwritten Includes must not match `~/.ssh/config.boxlite-backup`, even when
that backup does not exist yet. For example, narrow `Include config.*` to the
intended configuration files before installing. Otherwise installation fails
before publishing configuration or a backup, preventing recursive Includes
from breaking connections to unrelated hosts.

Generated ProxyCommands use the CLI's absolute executable path and capture runtime
home/configuration for local boxes, or credential home, context, effective URL and
routing prefix for remote boxes. Changing the saved default context cannot
redirect the alias. Local aliases force the embedded runtime without introducing
a `local` context. Remote aliases retain their installed endpoint even if the
context's endpoint later changes; authentication still reads that context's
current credentials. No API token or private key is embedded in SSH configuration.
Reinstall after moving the CLI executable or intentionally changing the target.

OpenSSH owns the session, so its normal command/PTY options work:

```bash
ssh dev 'printf "installed-alias-ok\n"'
```

The installed proxy only connects to enabled SSH; it never configures or enables
it. Use `boxlite ssh dev` to prepare it again when needed. Installation releases
the local runtime when it exits, so use a detached box if it must remain running.
An active local alias connection holds the same exclusive home lock as `--proxy`.
Remove an alias from the managed file to stop using it; deleting a remote box does
not automatically remove its SSH configuration or local credentials.


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
on an existing VM, and status to an empty `Control()` request. Default CLI login
selects the existing status/configure/enable operations; no setup API or RPC is exposed. The portal forwards each RPC once.
Other partial updates remain internal. REST uses POST, DELETE and GET on `/ssh`,
and a bodyless POST on `/ssh/enable`.

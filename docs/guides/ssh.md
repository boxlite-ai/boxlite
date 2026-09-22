# Guest SSH control

SSH starts disabled. Rust, Python, Node.js, Go, C, and the REST API expose
configure, status, and disable operations. Each operation ensures the VM and container main process
are running, starting them implicitly when needed. Querying status and disabling
SSH can therefore also start the box. Creating the handle alone does not start
anything. REST operations follow the server’s autoResume policy; a stopped box
with autoResume disabled must be started explicitly. CLI commands use the same
SDK startup and autoResume behavior.
SSH does not publish a host port; configure network forwarding separately when needed.

## CLI quick start

The CLI uses the system OpenSSH tools (`ssh-keygen` and, for login, `ssh`):

```bash
# Prepare keys and print a ready-to-run SSH command without connecting.
boxlite ssh setup mybox

# Keep localhost:2222 forwarding in the foreground; use the printed command
# from another terminal. Ctrl-C closes forwarding and leaves SSH configured.
boxlite ssh forward mybox

# Open an interactive session, or run a command and return its exit code.
boxlite ssh connect mybox
boxlite ssh connect mybox -- sh -c 'echo hello; exit 7'
```

These commands create separate Ed25519 host and user keys, configure login
`boxlite` on guest address `0.0.0.0:22`, and pin the host key in a dedicated
`known_hosts` file with strict verification. `forward --listen 127.0.0.1:2022`
selects another local TCP address; an occupied port fails without fallback.
`connect` uses `network tunnel --stdio` as the system SSH ProxyCommand, so no
local listening port is needed. Login information goes to stderr during connect;
stdout and the terminal belong to SSH.

Keys and the configuration record live on the client machine under
`<credential-home>/ssh/<target-digest>/<box-id>/` (default `~/.boxlite/ssh/`).
`--home` / `BOXLITE_HOME` select the credential home; `--config` can independently
select the local runtime directory. Local runtime paths and remote URL, routing
prefix, and profile combinations get separate records. Box names resolve to IDs.
Directories use mode `0700`; private keys and records use `0600`. User private
keys never leave the client. Host private keys are submitted only by configure,
and are not added to BoxOptions, the runtime database, snapshots, or archives.

Repeated setup, forward, and connect reuse owned keys and leave existing
sessions intact when host identity, listener, and generation match the record.
After disable or a VM restart, they configure the saved keys again. An enabled
configuration that does not match is refused; `--replace` explicitly generates
new keys and replaces it, disconnecting sessions. A local preparation lock
prevents concurrent updates. Keys are saved before configure; an ambiguous
failure retains them so the next invocation can query state before deciding
whether configuration is needed. Configure is never automatically retried.

For complete configuration control:

```bash
boxlite ssh configure mybox --file ssh.json
cat ssh.json | boxlite ssh configure mybox --file -
boxlite ssh status mybox
boxlite ssh disable mybox
```

The JSON file follows the Rust `SshConfig` fields shown below, including the
host private key and the full accounts list. Configure fully replaces SSH.
Control commands default to JSON; setup and forward default to YAML. All accept
`--format json|yaml`. Outputs include public status or login information, never
private key contents. All six commands support the usual `--home`, `--config`,
`--url`, `--profile`, and `--path-prefix` rules.

Local and REST SSH controls are supported. Remote forwarding and login also
require the server's tunnel API: `boxlite serve` currently has no tunnel route,
and the cloud tunnel requires a public box. These commands do not change public
visibility or add a server tunnel route.

## SDK configuration

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
For local backends, after startup, obtaining the SSH interface and making the RPC share a 5-second
deadline; VM and container startup time is excluded. Runtime shutdown cancels the
whole operation, including startup. Operations are not automatically retried.
Timeout or cancellation does not undo changes the guest may already have applied.
Invalidated handles return `Stopped`; drop all references to the old box and
obtain a fresh handle with `runtime.get()` to restart it.

The internal host-only `boxlite.v1.Ssh` gRPC service remains available on
`sockets/box.sock`; its schema is in `src/shared/proto/boxlite/v1/service.proto`.
Raw protocol callers must send `SshConfigureRequest.config` using field 4.
Legacy string fields 1–3 are reserved and ignored. A legacy-only request returns
`InvalidArgument` after Guest.Init without changing the current service.

Configure accepts an unencrypted OpenSSH host private key and a non-empty
`accounts` list. Each account has a unique `login` and at least one public key or
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

Every valid Configure fully restarts SSH, even if the configuration is identical:
validate → stop listener → disconnect all clients → wait for SSH execution and
forwarding cleanup → bind new listener. Invalid configuration returns a sanitized
`InvalidArgument` error and leaves the old service running. If stopping takes
longer than ten seconds, the request returns `DeadlineExceeded`; cleanup remains
tracked and a later Configure must finish draining it before starting another
listener. A bind failure returns `Unavailable` and leaves SSH disabled, without
restoring the old configuration. Disable performs the same drain and is idempotent.

Status contains only `enabled`, the actual bound `listen_address`, `generation`,
a comment-free `host_public_key`, and its SHA-256 `host_key_fingerprint`. Generation
increments on each successful listener start. Disabled status has empty address
and host identity fields. No authentication configuration or private key is returned.

Configuration and status live only in guest memory. Reconnecting to the same VM
preserves them. A VM restart starts disabled with generation zero and requires
Configure again. Create, clone, export, and import do not carry SSH configuration
or state. Old persisted SSH fields are ignored; existing databases and archives
are not migrated or rewritten by this change.

SSH restart terminates only SSH work. The container's main process and non-SSH
executions continue. Guest shutdown calls Disable before cleaning up executions
and containers, and continues cleanup even if Disable fails. SSH does not track
guest shutdown: concurrent Configure may briefly restart it, with VM shutdown
reclaiming any remaining resources.

## SDK and REST entry points

| Client | Entry point |
| --- | --- |
| Python | `await box.ssh.configure(config)`, `.status()`, `.disable()` |
| Python sync | `box.ssh.configure(config)`, `.status()`, `.disable()` |
| Node.js | `await box.ssh.configure(config)`, `.status()`, `.disable()` |
| Go | `ssh, err := box.SSH()`; `ssh.Configure(ctx, config)`, `Status(ctx)`, `Disable(ctx)`; `defer ssh.Close()` |
| C Native API | `boxlite_box_ssh`; `boxlite_ssh_configure/status/disable`; `boxlite_ssh_free` |

Python `SimpleBox.ssh` requires the box to have been initialized with `start()` or
its context manager. Node.js SimpleBox initializes lazily on the first operation.
Acquiring either handle does not initialize the box.

Python configuration uses `SshConfig`, `SshAccount`, and `SshCaConfig`, with the
same snake_case fields as Rust. Node.js uses objects with `listenAddress`,
`hostPrivateKey`, `accounts`, `authorizedKeys`, and `ca: { publicKey, principal }`.
Go uses `SSHConfig`, `SSHAccount`, and `SSHCAConfig`.

```python
config = boxlite.SshConfig("0.0.0.0:2222", host_private_key, [
    boxlite.SshAccount("alice", [alice_public_key])
])
status = await box.ssh.configure(config)
await box.ssh.disable()
```

C configure accepts a UTF-8 JSON `SshConfig` string, parsed and copied before the
function returns. Callbacks run through `boxlite_runtime_drain`. Each successful
callback transfers a `CSshStatus*` to the caller, who must release it using
`boxlite_ssh_status_free`; its strings are read-only. Releasing an SSH handle does
not disable the listener or invalidate already submitted operations.

REST uses `GET /ssh`, `POST /ssh/configure` (the configuration object as the body),
and `POST /ssh/disable`, relative to `/v1[/{prefix}]/boxes/{box_id}`. Each returns
HTTP 200 and the five status fields described above. REST uses its existing HTTP
request timeout. Older servers report unknown routes through the usual HTTP error
handling; clients do not fall back or retry. See the [OpenAPI contract](../../openapi/box.openapi.yaml).

Generation is unsigned 64-bit: Python exposes `int`, Node.js exposes `bigint`, and
Go/C expose `uint64`/`uint64_t`. JavaScript callers reading raw REST JSON must use
a parser that preserves integers beyond `Number.MAX_SAFE_INTEGER`.

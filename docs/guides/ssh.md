# Guest SSH control

SSH starts disabled. The local Rust runtime exposes `LiteBox::ssh()` to configure,
query, or disable it. All three operations follow the same implicit-start policy
as exec, metrics, and file copying. A `Configured` or `Stopped` box using the
image's default command can start implicitly, including on status queries and
disable calls. If `BoxOptions.cmd` or `entrypoint` explicitly sets the main
command, these states return `InvalidState`; call `start()` first. Running boxes
support all three operations. For example, querying SSH on a stopped box with
`cmd = ["python", "job.py"]` cannot run the job again.

Creating the handle alone does not start anything. The REST backend returns
`Unsupported`; CLI and other language SDKs have no SSH control API.
SSH does not publish a host port; configure network forwarding separately when needed.
For component diagrams and implementation details, see
[Guest SSH architecture](../../src/guest/src/service/ssh/README.md).

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
After startup, each operation has a total 15-second budget: the guest's 10-second
cleanup limit plus 5 seconds for communication and scheduling. Obtaining the SSH
interface, connection setup, queueing, and the RPC all consume this budget; VM and
container startup time is excluded. Connection or queueing delays can leave less
than 10 seconds for guest cleanup. Runtime shutdown rejects new SSH operations
and cancels interface acquisition and RPCs. In-progress VM initialization finishes
before cancellation is returned, so detached boxes remain recoverable; container
startup retains its own cancellation. Operations are not automatically retried.
Timeout or cancellation does not undo changes the guest may already have applied.
Invalidated handles return `Stopped`; drop all references to the old box and
obtain a fresh handle with `runtime.get()` to restart it.
The fresh handle still follows the same startup policy: a stopped box with an
explicit main command requires `start()` before any SSH operation.

The internal host-only `boxlite.v1.Ssh` gRPC service remains available on
`sockets/box.sock` after `Guest.Init` succeeds. It exposes `Configure`, `Status`,
and `Disable`; its schema is in `src/shared/proto/boxlite/v1/service.proto`.
Raw protocol callers must regenerate their bindings and send
`SshConfigureRequest.config` using field 4. Legacy string fields `listen_address`,
`ca_public_key`, and `principal` (fields 1–3) are reserved and ignored. A
legacy-only request returns `InvalidArgument` because `config` is missing,
without changing the current service. There is no legacy request conversion or
protocol version negotiation.

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
longer than ten seconds, the request returns `DeadlineExceeded`, which the Rust
runtime preserves as `BoxliteError::Rpc` with the original gRPC status; cleanup remains
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

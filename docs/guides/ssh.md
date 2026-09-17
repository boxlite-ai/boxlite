# Guest SSH control

SSH starts disabled. Control it through the existing host-only guest gRPC connection
at the box's `sockets/box.sock`, after `Guest.Init` succeeds. There is no LiteBox,
CLI, or language SDK SSH control API. SSH does not publish a host port; configure
network forwarding separately when needed.

`boxlite.v1.Ssh` exposes `Configure`, `Status`, and `Disable`. The complete schema
is in `src/shared/proto/boxlite/v1/service.proto`.

Callers must regenerate their protocol bindings and send `SshConfigureRequest.config`
using field number 4. The legacy string fields `listen_address`, `ca_public_key`,
and `principal` (field numbers 1–3) are reserved and ignored when decoding. After
Guest.Init succeeds, a legacy-only request returns `InvalidArgument` because
`config` is missing, without changing the current SSH service. There is no legacy
request conversion or protocol version negotiation.

```rust,ignore
use boxlite_shared::{SshAccount, SshClient, SshConfig, SshConfigureRequest, SshStatusRequest,
    SshDisableRequest};

// channel is a tonic Channel connected to the running box's box.sock.
let mut ssh = SshClient::new(channel);
let status = ssh.configure(SshConfigureRequest {
    config: Some(SshConfig {
        listen_address: "0.0.0.0:2222".into(),
        host_private_key: std::fs::read_to_string("host_key")?,
        accounts: vec![
            SshAccount {
                login: "alice".into(),
                authorized_keys: vec![std::fs::read_to_string("alice.pub")?],
                ca: None,
            },
            SshAccount {
                login: "bob".into(),
                authorized_keys: vec![std::fs::read_to_string("bob.pub")?],
                ca: None,
            },
        ],
    }),
}).await?.into_inner().status.unwrap();
println!("{} {}", status.host_public_key, status.host_key_fingerprint);
let current = ssh.status(SshStatusRequest {}).await?.into_inner().status;
ssh.disable(SshDisableRequest {}).await?;
```

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

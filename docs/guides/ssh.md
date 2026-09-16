# Guest SSH control

SSH starts disabled. Control it through the existing host-only guest gRPC connection
at the box's `sockets/box.sock`, after `Guest.Init` succeeds. There is no LiteBox,
CLI, or language SDK SSH control API. SSH does not publish a host port; configure
network forwarding separately when needed.

`boxlite.v1.Ssh` exposes `Configure`, `Status`, and `Disable`. The complete schema
is in `src/shared/proto/boxlite/v1/service.proto`.

```rust,ignore
use boxlite_shared::{SshClient, SshConfig, SshConfigureRequest, SshStatusRequest,
    SshDisableRequest};

// channel is a tonic Channel connected to the running box's box.sock.
let mut ssh = SshClient::new(channel);
let status = ssh.configure(SshConfigureRequest {
    config: Some(SshConfig {
        listen_address: "0.0.0.0:2222".into(),
        host_private_key: std::fs::read_to_string("host_key")?,
        ca: None,
        authorized_keys: vec![std::fs::read_to_string("user_key.pub")?],
    }),
}).await?.into_inner().status.unwrap();
println!("{} {}", status.host_public_key, status.host_key_fingerprint);
let current = ssh.status(SshStatusRequest {}).await?.into_inner().status;
ssh.disable(SshDisableRequest {}).await?;
```

Configure accepts an unencrypted OpenSSH host private key and at least one user
public key or CA configuration. A CA contains its public key and the required
certificate principal. Existing certificate permissions apply; plain authorized
keys allow PTY and forwarding. Login uses `root`. Each `authorized_keys` entry is
one OpenSSH public key with an optional comment, without authorized_keys options.

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

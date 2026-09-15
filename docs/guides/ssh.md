# SSH through the shim from the local Rust runtime

Use `litebox.ssh()` to configure SSH independently of `BoxOptions`. SSH is
disabled until configured and is exposed only by the local Rust API. SDKs, CLI
flags, and REST do not expose this configuration.

```text
Unix client → ssh.sock → libkrun → guest vsock:2697 → SSH → container workload
TCP client → optional TCP listener → SshForwarder → ssh.sock → guest
runtime → ShimClient::set(Option<(FD, SocketAddr)>) → SshForwarder::set
runtime → GuestSession::ssh → configure / disable / status
```

The runtime sends control requests and listening file descriptors directly to
the shim through the private `shim.sock` endpoint. The shim only forwards TCP
bytes. The runtime sends guest SSH configuration RPCs through the existing
`box.sock` bridge; SSH traffic uses `ssh.sock`. Neither interface calls the other:
closing forwarding does not disable guest SSH, and configuring the guest does
not change forwarding. The public runtime API explicitly combines both operations.

`SshConfig.tcp_listen_address: Option<SocketAddr>` enables an optional TCP
entrance. It defaults to `None` when omitted from JSON. Both IPv4 and IPv6 are
supported; port zero requests an available port. `status()` returns the actual
TCP address and a connectable short `socket_path` to the existing `ssh.sock`.
Unix clients use that path directly, including while TCP is enabled. There is
no custom Unix address or additional Unix listener.

The guest listens only on vsock and accepts only host CID 2. It opens no guest or
container TCP SSH listener. `NetworkSpec::Disabled` is supported. With
`advanced.security.network_enabled = false`, TCP ingress is rejected and Unix
ingress remains available. Configuring SSH does not grant host IP permissions.
Every login uses `root` inside the container.

## Start SSH locally

Generate a user key with `ssh-keygen -t ed25519 -N '' -f ./user_ed25519`, then:

```rust,no_run
use boxlite::{BoxOptions, BoxliteRuntime, NetworkSpec, RootfsSpec, SshAuth, SshConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = BoxliteRuntime::new(Default::default())?;
    let litebox = runtime.create(BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        network: NetworkSpec::Disabled,
        auto_delete: Some(0),
        ..Default::default()
    }, None).await?;
    let result = litebox.ssh().configure(SshConfig {
        enabled: true,
        tcp_listen_address: Some("127.0.0.1:2222".parse()?),
        host_private_key: None,
        auth: SshAuth::Keys {
            ca_public_keys: vec![],
            public_keys: vec![std::fs::read_to_string("user_ed25519.pub")?],
        },
    }).await?;
    println!("SSH configuration: {result:?}"); // Saved; this does not boot the VM.
    litebox.start().await?;
    println!("Box ID: {}", litebox.id());
    println!("SSH status: {:?}", litebox.ssh().status().await?);
    tokio::signal::ctrl_c().await?;
    litebox.stop().await?;
    runtime.shutdown(Some(10)).await?;
    Ok(())
}
```

For Unix-only SSH, set `tcp_listen_address: None`, then connect to the
`socket_path` returned by status. No additional TCP listener is bound and no
listener FD is passed through the control channel; libkrun owns the Unix listener.
For TCP, the runtime binds a listener and transfers its FD over the private
control channel with `SCM_RIGHTS`, alongside the actual bound address serialized
as a Serde `SocketAddr`. The shim validates the descriptor and exact endpoint.

Keep this example running until Ctrl-C. To let a box outlive its runtime
process, use `BoxOptions::detach = true` and omit the explicit `stop()`; its shim
owns the TCP listener and the fixed Unix bridge. Reopen the same runtime home to manage
it later.

## Authentication and host identity

`SshAuth::Keys { ca_public_keys, public_keys }` accepts a certificate from a
listed CA or an ordinary key from `public_keys`. Entries use OpenSSH public-key
format. Populate either or both lists; at least one must be nonempty. Malformed
entries reject the whole configuration. CA keys must be Ed25519. Ordinary keys
support the guest's Ed25519, ECDSA, RSA SHA-2, and OpenSSH security-key algorithms.

`SshAuth::NoAuth` explicitly enables the SSH `none` authentication method. Missing
or empty authentication settings never enable it. All modes still use encrypted
SSH with the guest's host key. Terminals, exec, SFTP, and TCP/Unix forwarding are
available; certificate extensions can restrict terminal and forwarding access.
Agent and X11 forwarding are unsupported.

CA certificates must be current user certificates, include the target Box ID in
the principal list, and have no critical options. To issue one:

```sh
ssh-keygen -t ed25519 -N '' -f ./ca_ed25519
BOX_ID='<Box ID printed by the Rust program>'
ssh-keygen -s ./ca_ed25519 -I boxlite-user -n "$BOX_ID" -V -1m:+1h ./user_ed25519.pub
```

Pass `ca_ed25519.pub` to `ca_public_keys`; CA private keys stay with the issuer.

Pin the guest host public key from the local configuration before connecting.
Read it from the runtime database, substituting your runtime home and Box ID:

```sh
BOX_ID='<Box ID printed by the Rust program>'
printf '%s ' "$BOX_ID" > ./known_hosts
key_file=$(mktemp)
chmod 600 "$key_file"
trap 'rm -f "$key_file"' EXIT
python3 - '<runtime-home>/db/boxlite.db' "$BOX_ID" > "$key_file" <<'PYKEY'
import json, pathlib, sqlite3, sys
uri = pathlib.Path(sys.argv[1]).resolve().as_uri() + "?mode=ro"
with sqlite3.connect(uri, uri=True) as db:
    row = db.execute("SELECT json FROM ssh_config WHERE box_id = ?", (sys.argv[2],)).fetchone()
    if row is None:
        raise SystemExit("SSH is not configured for this box")
    print(json.loads(row[0])["host_private_key"])
PYKEY
ssh-keygen -y -f "$key_file" >> ./known_hosts
rm -f "$key_file"

ssh -p 2222 -o HostKeyAlias="$BOX_ID" \
    -o UserKnownHostsFile=./known_hosts -o StrictHostKeyChecking=yes \
    -o IdentitiesOnly=yes -i ./user_ed25519 root@127.0.0.1 'id'
```

For a certificate, add `-o CertificateFile=./user_ed25519-cert.pub`. OpenSSH may
also offer an adjacent `*-cert.pub` automatically. For explicit `NoAuth`, replace
the identity options with `-o PreferredAuthentications=none`.

OpenSSH can use either entrance through `ProxyCommand`. These examples use an
OpenBSD-compatible `nc` (`-U` selects a Unix socket) and the same pinned identity:

```sh
# TCP; use the actual port from status() if configured with port zero.
ssh -o 'ProxyCommand=nc 127.0.0.1 2222' -o HostKeyAlias="$BOX_ID" \
    -o UserKnownHostsFile=./known_hosts -o StrictHostKeyChecking=yes \
    -o IdentitiesOnly=yes -i ./user_ed25519 root@boxlite 'id'

# Fixed Unix entrance; substitute socket_path from status().
ssh -o 'ProxyCommand=nc -U /tmp/bl-UID/BOX_ID/ssh.sock' -o HostKeyAlias="$BOX_ID" \
    -o UserKnownHostsFile=./known_hosts -o StrictHostKeyChecking=yes \
    -o IdentitiesOnly=yes -i ./user_ed25519 root@boxlite 'id'
```

Use the same options with `sftp`, or `ssh -t` for a terminal.

## Updates, status, and failures

All three methods are asynchronous:

| Method | Result |
| --- | --- |
| `config()` | Saved `Option<SshConfig>`, including the complete private key; `None` means unconfigured. |
| `configure(config)` | `SshApplyResult::Saved` while stopped, or `SshApplyResult::Applied(SshStatus)` after applying a live update. |
| `status()` | Actual `Option<SshStatus>` confirmed by the shim and guest; `None` while stopped. |

`SshStatus` combines the shim's optional actual `tcp_listen_address` with the
guest's `enabled`, `host_key_fingerprint`, and `generation`. When the guest is
enabled, the runtime also verifies the fixed Unix socket and returns its
`socket_path`. `application` is derived from the guest state (`Applied` or
`Disabled`); query failures are returned as errors, not stored by the shim.
The two queries are independent snapshots, not a configuration transaction.
Reading config or status never starts the box or changes either service.

```rust,no_run
# async fn update(litebox: &boxlite::LiteBox) -> Result<(), Box<dyn std::error::Error>> {
let ssh = litebox.ssh();
let mut config = ssh.config().await?.ok_or("SSH is not configured")?;
config.tcp_listen_address = None; // Switch to direct Unix only.
println!("{:?}", ssh.configure(config.clone()).await?);
config.enabled = false;
println!("{:?}", ssh.configure(config).await?);
# Ok(())
# }
```

The runtime's public `configure` entry point explicitly closes TCP forwarding,
disables guest SSH and its existing sessions, prepares a fresh optional TCP
listener, configures the guest, then passes the listener to the shim. Disabling
retains saved credentials and identity. Every TCP update binds a fresh listener;
port zero requests a new allocation and does not preserve the previous port.
The main workload keeps running, and ordinary exec/metrics operations on an
initialized box do not wait for the SSH update lock.

Validation or persistence failure leaves the previous live configuration intact.
After saving, bind/RPC failures and the 30-second application timeout return an
error explaining that the configuration was saved but application failed or was
not confirmed. A failed bind occurs after the explicit guest Disable. A failure
later in the sequence can leave guest SSH enabled without TCP forwarding. There
is no rollback, background retry, or shim-side guest cleanup. Query `status()`
after a failure or cancelled caller to learn the current state before retrying.
`status()` has a 30-second total timeout including lifecycle coordination.
The runtime coordinates its public operations with the per-box lifecycle lock;
the shim has no configuration generations, deadlines, or Begin/Apply/Abort protocol.

One dedicated OS thread per shim runs a single-thread Tokio runtime. Control
connections call `SshForwarder::set` or `get_socket_addr` directly under a mutex;
there is no SSH command queue. The forwarder privately owns its listener task
and connection cleanup. `set` closes and joins the old listener and forwarding
tasks before starting a replacement; `set(None)` leaves forwarding closed.
Once the listener task exits, its address query returns `None`.

Control and forwarding tasks run independently, so an incomplete control message
cannot block SSH ingress. Control allows 32 simultaneous connections and closes
excess connections. Each control frame is at most 1 MiB, with 10-second read/write
timeouts and a 30-second total client timeout. Replies never carry a listener FD.
Runtime and shim must be updated together for this private protocol.

The optional TCP forwarder supports at most 128 concurrent forwarding tasks;
the guest enforces its own connection limit for both routes. Each connection opens a separate guest
channel with a 10-second connection timeout. The TCP byte forwarder's
bidirectional copy preserves backpressure and TCP half-close. End-to-end SSH
tests cover channel EOF followed by the command's response on both entrances;
this is distinct from half-closing the raw SSH transport. Updates and shutdown
cancel remaining connections.

## Persistence and cleanup

`<runtime-home>/db/boxlite.db` is the only persistent SSH source. Schema v11
adds an independent `ssh_config` table keyed by Box ID. Its `json` column stores
the complete configuration, including the **plaintext private host key**.
There is no listener-path persistence. An
absent row means SSH is unconfigured. Disabling retains configuration and identity.
The dedicated database directory is `0700`; the database, WAL, and SHM files are
`0600`, including when opening an older database. Debug output redacts the key.
The Rust `config()` API returns the same saved configuration, including the key.

The first configuration with `host_private_key: None` generates Ed25519 identity;
later submissions with `None` reuse the database key. `Some` replaces it and must
contain an unencrypted OpenSSH Ed25519 private key. Update the client's pinned key
when replacing identity. Startup applies saved settings after `Container.Init`;
a bind or application failure fails a new or restarted boot. Reattachment to an
already running box keeps its workload running if SSH reconciliation fails.
Reopening a running box leaves its sessions intact. Use `configure()` to update
settings; direct database edits are not watched.

Configuration commits before applying a live update. A failed transaction retains
the previous configuration and identity. A saved configuration can differ from
the applied state; query `status()` after an application failure.

The fixed `ssh.sock` belongs to the existing box socket lifecycle. It may remain
present while SSH is disabled; file existence does not prove guest SSH is
available. Update and Disable stop the guest service without unlinking the
bridge. Guest shutdown requests SSH session teardown before stopping containers.
The Unix bridge follows the existing VM process cleanup and is not guaranteed
to reject connections immediately when `stop()` returns. Restart and box removal
use the existing socket-directory cleanup.
No arbitrary external Unix paths are stored or deleted.

Configuration IO retains its per-box coordinator even if its caller is cancelled.
Removal drains pending blocking IO before deleting the box and cascading its SSH
row, so a cancelled save cannot recreate identity after removal.

Clones and exports/imports do not inherit SSH configuration or identity,
including explicitly supplied keys. Configure every derived box separately.
Certificates must use the derived box's own ID.

Upgrading from v10 only creates the empty SSH table; existing box configuration
and state are unchanged. Older binaries reject v11 under the existing schema
version check. **Legacy `ssh/config.json` and `ssh/listener.json` are never read,
imported, or rewritten**, and their host keys are not inherited. Boxes configured
with those files must be configured again; when omitting a key, expect a new
identity and update client pins. This unreleased v11 definition and private
control protocol are updated directly; older development SSH configurations are
not compatible. No existing user configuration or external socket is deleted
automatically. Runtime and shim must be rebuilt together.

The bridge uses libkrun's `krun_add_vsock_port2(..., listen=true)`
([libkrun.h](../../src/deps/libkrun-sys/vendor/libkrun/include/libkrun.h#L895)).
Its host-initiated Unix-to-vsock transport follows the same direction as
[Firecracker's vsock design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md#host-initiated-connections);
BoxLite's bridge does not use Firecracker's textual `CONNECT` preamble.

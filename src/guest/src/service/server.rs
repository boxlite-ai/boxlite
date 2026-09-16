use crate::container::Container;
use crate::layout::GuestLayout;
use crate::service::exec::registry::ExecutionRegistry;
use boxlite_shared::{BoxTransport, BoxliteResult};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tonic::transport::Server;
use tracing::{info, warn};

/// Guest initialization state.
///
/// Tracks the state set by Guest.Init, which must be called before Container.Init.
#[derive(Default)]
pub(crate) struct GuestInitState {
    /// Whether guest has been initialized
    pub initialized: bool,
}

/// Guest agent server.
///
/// Implements the guest's gRPC services:
/// - Guest: Agent initialization and management
/// - Ssh: Live embedded-SSH listener control
/// - Container: OCI container lifecycle
/// - Execution: Command execution with bidirectional streaming
/// - Files: Container-rootfs file transfer
pub(crate) struct GuestServer {
    /// Guest filesystem layout
    pub layout: GuestLayout,

    /// Guest initialization state (set by Guest.Init)
    pub init_state: Arc<Mutex<GuestInitState>>,

    /// Container registry: container_id -> Container
    pub containers: Arc<Mutex<HashMap<String, Arc<Mutex<Container>>>>>,

    /// Execution registry for tracking running executions
    pub registry: ExecutionRegistry,

    /// Independently reconfigurable embedded SSH listener.
    pub ssh_manager: crate::service::ssh::SshManager,

    /// Mount points frozen by Quiesce RPC, thawed by Thaw RPC.
    pub frozen_mounts: Mutex<Vec<PathBuf>>,

    /// Set when a host-driven Shutdown RPC is in progress. The reaper's
    /// init-exit action checks this to avoid powering the VM off underneath a
    /// host-orchestrated teardown.
    pub shutting_down: Arc<std::sync::atomic::AtomicBool>,

    /// Each container init's exit slot, keyed by container id.
    ///
    /// Kept so `Shutdown` can write the exit record *itself* before answering
    /// the host. The reaper's action writes the same record from the same slot,
    /// but on its own task — without this, the RPC could return, the host could
    /// read the exit file, and the record it wanted may not be there yet. The
    /// host's `stop()` reports the code the box died with (docker leaves
    /// ExitCode 137 after a `docker stop`), and that must be ordered, not
    /// lucky.
    pub init_exits: Arc<Mutex<HashMap<String, crate::reaper::ExitSlot>>>,
}

impl GuestServer {
    /// Create a new server with the given layout.
    ///
    /// Server starts uninitialized. Guest.Init must be called first to setup
    /// the environment, then Container.Init to start the container.
    pub fn new(layout: GuestLayout) -> Self {
        Self {
            layout,
            init_state: Arc::new(Mutex::new(GuestInitState::default())),
            containers: Arc::new(Mutex::new(HashMap::new())),
            registry: ExecutionRegistry::new(),
            ssh_manager: crate::service::ssh::SshManager::default(),
            frozen_mounts: Mutex::new(Vec::new()),
            shutting_down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            init_exits: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Run the tonic server listening on the specified transport.
    ///
    /// Binds to the specified transport (Unix, TCP, or Vsock) and serves
    /// all guest gRPC services on a single port.
    ///
    /// If `notify_uri` is provided, connects to that URI after the server
    /// is ready to serve, signaling readiness to the host.
    pub async fn run(self, listen_uri: String, notify_uri: Option<String>) -> BoxliteResult<()> {
        info!("Starting tonic gRPC server");

        // Parse the listen URI to determine transport type
        let transport = BoxTransport::from_uri(&listen_uri).map_err(|e| {
            boxlite_shared::errors::BoxliteError::Internal(format!(
                "Invalid listen URI '{}': {}",
                listen_uri, e
            ))
        })?;

        info!("Parsed transport from URI: {:?}", transport);

        // Wrap self in Arc for sharing across services
        let server = Arc::new(self);
        server.ssh_manager.attach_guest(&server);

        let server_builder = Server::builder()
            .add_service(boxlite_shared::ContainerServer::from_arc(server.clone()))
            .add_service(boxlite_shared::GuestServer::from_arc(server.clone()))
            .add_service(boxlite_shared::SshServer::from_arc(server.clone()))
            .add_service(boxlite_shared::ExecutionServer::from_arc(server.clone()))
            .add_service(boxlite_shared::FilesServer::from_arc(server.clone()));

        match transport {
            BoxTransport::Vsock { port } => {
                use tokio_stream::StreamExt as _;
                use tokio_vsock::{VsockAddr, VsockListener, VMADDR_CID_ANY};

                info!("Binding to vsock port {}", port);
                let addr = VsockAddr::new(VMADDR_CID_ANY, port);
                let listener = VsockListener::bind(addr).map_err(|e| {
                    boxlite_shared::errors::BoxliteError::Internal(format!(
                        "Failed to bind vsock: {}",
                        e
                    ))
                })?;
                info!("Listening on vsock://{}:{}", VMADDR_CID_ANY, port);
                eprintln!(
                    "[guest] T+{}ms: server bound (vsock:{})",
                    crate::boot_elapsed_ms(),
                    port
                );

                // AF_VSOCK is not a trust boundary by itself: a tenant process
                // can make a loopback vsock connection from inside the VM. All
                // guest RPCs are host control-plane operations, so reject every
                // peer CID except the well-known host CID before tonic sees it.
                let incoming = listener
                    .incoming()
                    .filter_map(|connection| match connection {
                        Ok(stream) => match stream.peer_addr() {
                            Ok(peer) if is_host_vsock_peer(peer) => Some(Ok(stream)),
                            Ok(peer) => {
                                warn!(peer_cid = peer.cid(), "Rejected non-host guest RPC peer");
                                None
                            }
                            Err(error) => {
                                warn!(%error, "Rejected guest RPC peer with no vsock address");
                                None
                            }
                        },
                        Err(error) => Some(Err(error)),
                    });

                tokio::spawn(async move {
                    if let Err(e) = notify_host_ready(notify_uri).await {
                        warn!("Failed to notify host: {}", e);
                    }
                });

                server_builder
                    .serve_with_incoming(incoming)
                    .await
                    .map_err(|e| {
                        boxlite_shared::errors::BoxliteError::Internal(format!(
                            "Server error: {}",
                            e
                        ))
                    })?;
            }

            BoxTransport::Unix { socket_path } => {
                use tokio_stream::wrappers::UnixListenerStream;

                // Remove socket if it exists
                if socket_path.exists() {
                    std::fs::remove_file(&socket_path)?;
                }

                // Ensure parent directory exists
                if let Some(parent) = socket_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }

                info!("Binding to Unix socket: {}", socket_path.display());
                let listener = tokio::net::UnixListener::bind(&socket_path)?;
                info!("Listening on unix://{}", socket_path.display());
                eprintln!(
                    "[guest] T+{}ms: server bound (unix)",
                    crate::boot_elapsed_ms()
                );

                let incoming = UnixListenerStream::new(listener);

                tokio::spawn(async move {
                    if let Err(e) = notify_host_ready(notify_uri).await {
                        warn!("Failed to notify host: {}", e);
                    }
                });

                server_builder
                    .serve_with_incoming(incoming)
                    .await
                    .map_err(|e| {
                        boxlite_shared::errors::BoxliteError::Internal(format!(
                            "Server error: {}",
                            e
                        ))
                    })?;
            }

            BoxTransport::Tcp { port } => {
                use tokio_stream::wrappers::TcpListenerStream;

                let addr = format!("127.0.0.1:{}", port);
                info!("Binding to TCP address: {}", addr);
                let listener = tokio::net::TcpListener::bind(&addr).await?;
                info!("Listening on tcp://{}", addr);
                eprintln!(
                    "[guest] T+{}ms: server bound (tcp:{})",
                    crate::boot_elapsed_ms(),
                    port
                );

                let incoming = TcpListenerStream::new(listener);

                tokio::spawn(async move {
                    if let Err(e) = notify_host_ready(notify_uri).await {
                        warn!("Failed to notify host: {}", e);
                    }
                });

                server_builder
                    .serve_with_incoming(incoming)
                    .await
                    .map_err(|e| {
                        boxlite_shared::errors::BoxliteError::Internal(format!(
                            "Server error: {}",
                            e
                        ))
                    })?;
            }
        }

        Ok(())
    }
}

/// Notify host that guest is ready by connecting to the notify URI.
///
/// The connection itself is the signal - no data needs to be sent.
async fn notify_host_ready(notify_uri: Option<String>) -> BoxliteResult<()> {
    let uri = match notify_uri {
        Some(uri) => uri,
        None => {
            info!("No notify URI provided, skipping host notification");
            return Ok(());
        }
    };

    let transport = BoxTransport::from_uri(uri.as_str()).map_err(|e| {
        boxlite_shared::errors::BoxliteError::Internal(format!(
            "Invalid notify URI '{}': {}",
            uri, e
        ))
    })?;

    match transport {
        BoxTransport::Vsock { port } => {
            use tokio_vsock::{VsockAddr, VsockStream, VMADDR_CID_HOST};

            info!("Notifying host via vsock:{}", port);
            let addr = VsockAddr::new(VMADDR_CID_HOST, port);
            let _stream = VsockStream::connect(addr).await.map_err(|e| {
                boxlite_shared::errors::BoxliteError::Internal(format!(
                    "Failed to connect to notify vsock: {}",
                    e
                ))
            })?;
            eprintln!(
                "[guest] T+{}ms: host notified (vsock:{})",
                crate::boot_elapsed_ms(),
                port
            );
            info!("Host notified successfully");
            // Connection itself signals readiness, drop immediately
        }
        BoxTransport::Unix { socket_path } => {
            info!("Notifying host via unix:{}", socket_path.display());
            let _stream = tokio::net::UnixStream::connect(&socket_path)
                .await
                .map_err(|e| {
                    boxlite_shared::errors::BoxliteError::Internal(format!(
                        "Failed to connect to notify socket: {}",
                        e
                    ))
                })?;
            eprintln!(
                "[guest] T+{}ms: host notified (unix)",
                crate::boot_elapsed_ms()
            );
            info!("Host notified successfully");
        }
        BoxTransport::Tcp { port } => {
            info!("Notifying host via tcp:127.0.0.1:{}", port);
            let _stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
                .await
                .map_err(|e| {
                    boxlite_shared::errors::BoxliteError::Internal(format!(
                        "Failed to connect to notify tcp: {}",
                        e
                    ))
                })?;
            eprintln!(
                "[guest] T+{}ms: host notified (tcp:{})",
                crate::boot_elapsed_ms(),
                port
            );
            info!("Host notified successfully");
        }
    }

    Ok(())
}

fn is_host_vsock_peer(peer: tokio_vsock::VsockAddr) -> bool {
    peer.cid() == tokio_vsock::VMADDR_CID_HOST
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_vsock::{VsockAddr, VMADDR_CID_HOST, VMADDR_CID_LOCAL};

    #[test]
    fn guest_control_vsock_accepts_only_the_host_cid() {
        assert!(is_host_vsock_peer(VsockAddr::new(VMADDR_CID_HOST, 1234)));
        assert!(!is_host_vsock_peer(VsockAddr::new(VMADDR_CID_LOCAL, 1234)));
        assert!(!is_host_vsock_peer(VsockAddr::new(42, 1234)));
    }
}

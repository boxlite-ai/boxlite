//! Connection management.
//!
//! Converts BoxTransport to tonic Channel with lazy initialization.

use std::sync::Arc;
use std::time::Duration;

use boxlite_shared::{BoxTransport, BoxliteError, BoxliteResult};
use hyper_util::rt::TokioIo;
use tokio::sync::OnceCell;
use tonic::transport::{Channel, Endpoint, Uri};
use tower::service_fn;

/// Lazy connection to guest.
///
/// Connects on first use to ensure connection happens in the correct async runtime.
#[derive(Clone)]
pub struct Connection {
    transport: BoxTransport,
    channel: Arc<OnceCell<Channel>>,
}

impl Connection {
    /// Create a lazy connection (does not connect immediately).
    pub fn new(transport: BoxTransport) -> Self {
        Self {
            transport,
            channel: Arc::new(OnceCell::new()),
        }
    }

    /// Get or establish the channel.
    pub async fn channel(&self) -> BoxliteResult<Channel> {
        let channel = self
            .channel
            .get_or_try_init(|| async { connect_transport(&self.transport).await })
            .await?;

        Ok(channel.clone())
    }
}

/// Connect to a transport.
async fn connect_transport(transport: &BoxTransport) -> BoxliteResult<Channel> {
    match transport {
        BoxTransport::Unix { socket_path } => {
            tracing::debug!("Connecting via Unix: {}", socket_path.display());
            connect_unix(socket_path).await
        }
        BoxTransport::Tcp { port } => {
            tracing::debug!("Connecting via TCP: 127.0.0.1:{}", port);
            connect_tcp(*port).await
        }
        BoxTransport::Vsock { port } => Err(BoxliteError::Internal(format!(
            "Vsock client not yet implemented (port: {})",
            port
        ))),
    }
}

async fn connect_unix(socket_path: &std::path::Path) -> BoxliteResult<Channel> {
    let diagnostic_path = socket_path.to_path_buf();
    let diagnostic_started = std::time::Instant::now();
    let socket_path = socket_path.to_path_buf();

    let channel = Endpoint::try_from("http://[::]:50051")?
        .connect_timeout(Duration::from_secs(30))
        .connect_with_connector(service_fn(move |_: Uri| {
            let socket_path = socket_path.clone();
            async move {
                let stream = tokio::net::UnixStream::connect(socket_path).await?;
                Ok::<_, std::io::Error>(TokioIo::new(stream))
            }
        }))
        .await
        .inspect_err(|error| {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let directory = std::path::PathBuf::from(format!(
                "/tmp/pr2524-rpc-observed/{}-{stamp}",
                std::process::id()
            ));
            let details = format!(
                "elapsed={:?} path={:?} error={error:?} metadata={:?}\n",
                diagnostic_started.elapsed(),
                diagnostic_path,
                std::fs::metadata(&diagnostic_path)
            );
            eprintln!("[PR2524-DIAG] {details} evidence={}", directory.display());
            let _ = std::fs::create_dir_all(&directory);
            let _ = std::fs::write(directory.join("rpc-error.txt"), details);
            let mut observations = String::new();
            for sample in 0..101 {
                let timestamp = std::time::SystemTime::now();
                let metadata = std::fs::metadata(&diagnostic_path);
                let table = std::fs::read_to_string("/proc/net/unix").unwrap_or_default();
                let bound = table
                    .lines()
                    .filter(|line| line.ends_with(diagnostic_path.to_string_lossy().as_ref()))
                    .collect::<Vec<_>>();
                observations.push_str(&format!(
                    "sample={sample} time={timestamp:?} metadata={metadata:?} bound={bound:?}\n"
                ));
                if metadata.is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            eprintln!("[PR2524-DIAG] socket observations: {observations}");
            let _ = std::fs::write(directory.join("socket-observations.txt"), observations);
            if let Some(parent) = diagnostic_path.parent() {
                let real = std::fs::canonicalize(parent).or_else(|_| std::fs::read_link(parent));
                if let Ok(sockets) = real {
                    if let Some(box_home) = sockets.parent() {
                        let _ = std::fs::write(
                            directory.join("box-home.txt"),
                            box_home.display().to_string(),
                        );
                        for name in ["shim.stderr", "shim.pid", "exit.json"] {
                            let _ = std::fs::copy(box_home.join(name), directory.join(name));
                        }
                        if let Ok(logs) = std::fs::read_dir(box_home.join("logs")) {
                            for log in logs.flatten() {
                                if log.file_type().is_ok_and(|kind| kind.is_file()) {
                                    let _ =
                                        std::fs::copy(log.path(), directory.join(log.file_name()));
                                }
                            }
                        }
                    }
                }
            }
        })?;

    tracing::debug!("Connected via Unix socket");
    Ok(channel)
}

async fn connect_tcp(port: u16) -> BoxliteResult<Channel> {
    let addr = format!("http://127.0.0.1:{}", port);
    let channel = Endpoint::try_from(addr)?
        .connect_timeout(Duration::from_secs(30))
        .connect()
        .await?;

    tracing::debug!("Connected via TCP");
    Ok(channel)
}

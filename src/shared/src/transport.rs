//! BoxTransport types for host-guest communication.

use std::path::PathBuf;

/// BoxTransport mechanism for host-guest communication.
///
/// Represents the underlying connection type used by both host (to connect)
/// and guest (to listen).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum BoxTransport {
    /// TCP transport
    Tcp { port: u16 },

    /// Unix socket transport
    Unix { socket_path: PathBuf },

    /// Vsock transport (guest-specific)
    Vsock { port: u32 },
}

impl BoxTransport {
    /// Create a TCP transport.
    pub fn tcp(port: u16) -> Self {
        Self::Tcp { port }
    }

    /// Create a Unix socket transport.
    pub fn unix(socket_path: PathBuf) -> Self {
        Self::Unix { socket_path }
    }

    /// Create a Vsock transport.
    pub fn vsock(port: u32) -> Self {
        Self::Vsock { port }
    }

    /// Get the URI representation of this transport.
    pub fn to_uri(&self) -> String {
        match self {
            BoxTransport::Tcp { port } => format!("tcp://127.0.0.1:{}", port),
            BoxTransport::Unix { socket_path } => format!("unix://{}", socket_path.display()),
            BoxTransport::Vsock { port } => format!("vsock://{}", port),
        }
    }

    /// Parse a transport from a URI string.
    pub fn from_uri(uri: &str) -> Result<Self, String> {
        if let Some(rest) = uri.strip_prefix("tcp://") {
            let port = rest
                .split(':')
                .nth(1)
                .ok_or_else(|| format!("invalid TCP URI '{}': missing port", uri))?
                .parse::<u16>()
                .map_err(|e| format!("invalid TCP port in '{}': {}", uri, e))?;
            Ok(Self::tcp(port))
        } else if let Some(path) = uri.strip_prefix("unix://") {
            Ok(Self::unix(PathBuf::from(path)))
        } else if let Some(port_str) = uri.strip_prefix("vsock://") {
            let port = port_str
                .parse::<u32>()
                .map_err(|e| format!("invalid vsock port in '{}': {}", uri, e))?;
            Ok(Self::vsock(port))
        } else {
            Err(format!(
                "invalid transport URI '{}': expected tcp://, unix://, or vsock://",
                uri
            ))
        }
    }
}

impl std::fmt::Display for BoxTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_uri())
    }
}

impl std::str::FromStr for BoxTransport {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_uri(s)
    }
}

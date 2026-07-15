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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn to_uri_from_uri_roundtrips_every_variant() {
        for t in [
            BoxTransport::tcp(8080),
            BoxTransport::unix(PathBuf::from("/tmp/box/net.sock")),
            BoxTransport::vsock(1024),
        ] {
            let uri = t.to_uri();
            assert_eq!(
                BoxTransport::from_uri(&uri).unwrap(),
                t,
                "roundtrip via {uri}"
            );
        }
    }

    #[test]
    fn to_uri_renders_scheme_per_variant() {
        assert_eq!(BoxTransport::tcp(80).to_uri(), "tcp://127.0.0.1:80");
        assert_eq!(
            BoxTransport::unix(PathBuf::from("/a/b.sock")).to_uri(),
            "unix:///a/b.sock"
        );
        assert_eq!(BoxTransport::vsock(42).to_uri(), "vsock://42");
    }

    #[test]
    fn from_uri_rejects_unknown_scheme_and_bad_ports() {
        assert!(BoxTransport::from_uri("http://x").is_err()); // unknown scheme
        assert!(BoxTransport::from_uri("tcp://127.0.0.1").is_err()); // no :port
        assert!(BoxTransport::from_uri("tcp://127.0.0.1:").is_err()); // empty port
        assert!(BoxTransport::from_uri("tcp://h:70000").is_err()); // u16 overflow
        assert!(BoxTransport::from_uri("vsock://nope").is_err()); // non-numeric vsock
    }

    #[test]
    fn display_and_fromstr_delegate_to_uri_helpers() {
        let t = BoxTransport::unix(PathBuf::from("/tmp/s.sock"));
        assert_eq!(t.to_string(), t.to_uri()); // Display == to_uri
        assert_eq!(
            "vsock://7".parse::<BoxTransport>().unwrap(),
            BoxTransport::vsock(7)
        ); // FromStr == from_uri
    }

    #[test]
    fn serde_json_roundtrips_every_variant() {
        for t in [
            BoxTransport::tcp(8080),
            BoxTransport::unix(PathBuf::from("/tmp/box/net.sock")),
            BoxTransport::vsock(1024),
        ] {
            let json = serde_json::to_string(&t).unwrap();
            assert_eq!(serde_json::from_str::<BoxTransport>(&json).unwrap(), t);
        }
    }

    #[test]
    fn tcp_from_uri_keeps_only_the_port_component() {
        assert_eq!(
            BoxTransport::from_uri("tcp://0.0.0.0:443").unwrap(),
            BoxTransport::tcp(443)
        );
    }
}

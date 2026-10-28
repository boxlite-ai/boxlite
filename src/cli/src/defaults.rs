//! Defaults for CLI authentication and the local REST server listener.

/// Port `boxlite serve` binds when `--port` is not given.
pub const LOCAL_SERVE_PORT: u16 = 8100;

/// Address `boxlite serve` binds when `--host` is not given. Loopback only:
/// the server grants full box control to any caller when no API key is set.
pub const LOCAL_SERVE_HOST: &str = "127.0.0.1";

/// REST API URL authentication commands use when no server is configured.
pub const DEFAULT_REST_URL: &str = "https://api.boxlite.ai";

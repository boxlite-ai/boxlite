//! Shared defaults for `boxlite serve` (the local REST server) and any
//! client command that targets it (`boxlite auth login`, `auth status`,
//! `auth logout`, etc.). Keeping the port, host, and client URL in one
//! place prevents drift between the bind address and the URL clients use.

/// Port `boxlite serve` binds when `--port` is not given.
pub const LOCAL_SERVE_PORT: u16 = 8100;

/// Address `boxlite serve` binds when `--host` is not given. Loopback only:
/// the server grants full box control to any caller when no API key is set.
pub const LOCAL_SERVE_HOST: &str = "127.0.0.1";

/// URL clients use to reach `boxlite serve` on the same host. Must stay
/// in sync with `LOCAL_SERVE_PORT`.
pub const LOCAL_SERVE_URL: &str = "http://localhost:8100";

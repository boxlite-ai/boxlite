//! REST API client backend for BoxLite.
//!
//! Provides a REST-based `RuntimeBackend` and `BoxBackend` implementation
//! that delegates all operations to a remote BoxLite REST API server.
//!
//! Enabled with the `rest` feature flag.

pub(crate) mod client;
pub(crate) mod error;
mod exec;
pub(crate) mod litebox;
pub mod options;
pub(crate) mod runtime;
pub(crate) mod types;

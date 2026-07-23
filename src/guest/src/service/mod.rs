//! Guest agent service implementations.
//!
//! This module contains the gRPC server and service implementations:
//! - `guest`: Guest initialization and management (Init, Ping, Shutdown RPCs)
//! - `container`: Container lifecycle (Init RPC)
//! - `execution`: Command execution (Exec, Wait, Kill RPCs)

mod container;
pub(crate) mod exec;
pub(crate) mod files;
mod guest;
pub(crate) mod server;

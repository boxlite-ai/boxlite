//! BoxLite distributed server with coordinator and worker roles.
//!
//! - **Coordinator**: Accepts client REST requests, dispatches to workers via gRPC
//! - **Worker**: Runs `BoxliteRuntime` directly, exposes gRPC `WorkerService`

pub mod coordinator;
pub mod error;
pub mod scheduler;
pub mod store;
pub mod types;
pub mod worker;

/// Generated protobuf types for the worker gRPC service.
pub mod proto {
    tonic::include_proto!("boxlite.server");
}

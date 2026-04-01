//! Error types for the boxlite-server.

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("worker not found: {0}")]
    WorkerNotFound(String),

    #[error("no available workers for placement")]
    NoAvailableWorkers,

    #[error("box not found in routing table: {0}")]
    BoxNotRouted(String),

    #[error("gRPC error: {0}")]
    Grpc(#[from] Box<tonic::Status>),

    #[error("store error: {0}")]
    Store(String),

    #[error("worker health check failed for {worker_id}: {reason}")]
    HealthCheckFailed { worker_id: String, reason: String },

    #[error("boxlite error: {0}")]
    Boxlite(#[from] boxlite_shared::errors::BoxliteError),

    #[error("{0}")]
    Internal(String),
}

impl From<rusqlite::Error> for ServerError {
    fn from(e: rusqlite::Error) -> Self {
        ServerError::Store(e.to_string())
    }
}

pub type ServerResult<T> = Result<T, ServerError>;

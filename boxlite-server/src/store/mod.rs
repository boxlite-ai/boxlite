//! State store abstraction for the coordinator.
//!
//! The `StateStore` trait defines the persistence interface for worker
//! registry and box-to-worker mappings. The default implementation uses
//! SQLite; alternative backends (Redis, PostgreSQL) can be added for
//! multi-coordinator deployments.

pub mod schema;
pub mod sqlite;

use async_trait::async_trait;

use crate::error::ServerResult;
use crate::types::{BoxMapping, WorkerCapacity, WorkerInfo, WorkerStatus};

/// Persistence layer for coordinator state.
///
/// Implementations must be thread-safe (`Send + Sync`) and safe for
/// concurrent access from multiple Tokio tasks.
#[async_trait]
pub trait StateStore: Send + Sync + 'static {
    // ── Worker operations ──

    /// Insert or update a worker record.
    async fn upsert_worker(&self, worker: &WorkerInfo) -> ServerResult<()>;

    /// Get a worker by ID.
    async fn get_worker(&self, id: &str) -> ServerResult<Option<WorkerInfo>>;

    /// List all workers.
    async fn list_workers(&self) -> ServerResult<Vec<WorkerInfo>>;

    /// Remove a worker and its box mappings (CASCADE).
    async fn remove_worker(&self, id: &str) -> ServerResult<()>;

    /// Update heartbeat timestamp and capacity for a worker.
    async fn update_worker_heartbeat(
        &self,
        id: &str,
        capacity: &WorkerCapacity,
    ) -> ServerResult<()>;

    /// Update worker status (e.g., mark as unreachable).
    async fn update_worker_status(&self, id: &str, status: WorkerStatus) -> ServerResult<()>;

    // ── Box mapping operations ──

    /// Record which worker owns a box.
    async fn insert_box_mapping(&self, mapping: &BoxMapping) -> ServerResult<()>;

    /// Look up which worker owns a box.
    async fn get_box_mapping(&self, box_id: &str) -> ServerResult<Option<BoxMapping>>;

    /// Remove a box mapping (box deleted).
    async fn remove_box_mapping(&self, box_id: &str) -> ServerResult<()>;

    /// List all box mappings for a given worker.
    async fn list_box_mappings_for_worker(&self, worker_id: &str) -> ServerResult<Vec<BoxMapping>>;

    /// List all box mappings for a given namespace.
    async fn list_box_mappings_by_namespace(
        &self,
        namespace: &str,
    ) -> ServerResult<Vec<BoxMapping>>;
}

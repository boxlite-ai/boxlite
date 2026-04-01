//! Scheduler for selecting which worker should host a new box.

use async_trait::async_trait;

use crate::error::{ServerError, ServerResult};
use crate::store::StateStore;
use crate::types::{ScheduleRequest, WorkerInfo, WorkerStatus};

/// Selects a worker for new box placement.
#[async_trait]
pub trait Scheduler: Send + Sync {
    async fn select_worker(
        &self,
        store: &dyn StateStore,
        request: &ScheduleRequest,
    ) -> ServerResult<WorkerInfo>;
}

/// Picks the active worker with the fewest running boxes
/// that satisfies the resource constraints.
pub struct LeastLoadedScheduler;

#[async_trait]
impl Scheduler for LeastLoadedScheduler {
    async fn select_worker(
        &self,
        store: &dyn StateStore,
        request: &ScheduleRequest,
    ) -> ServerResult<WorkerInfo> {
        let workers = store.list_workers().await?;

        workers
            .into_iter()
            .filter(|w| w.status == WorkerStatus::Active)
            .filter(|w| {
                let cap = &w.capacity;
                request.cpus.is_none_or(|c| cap.available_cpus >= c as u32)
                    && request
                        .memory_mib
                        .is_none_or(|m| cap.available_memory_mib >= m as u64)
            })
            .min_by_key(|w| w.capacity.running_boxes)
            .ok_or(ServerError::NoAvailableWorkers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::sqlite::SqliteStateStore;
    use crate::types::{WorkerCapacity, WorkerInfo, WorkerStatus};
    use chrono::Utc;
    use std::collections::HashMap;

    fn worker(id: &str, running: u32, cpus: u32, mem: u64) -> WorkerInfo {
        WorkerInfo {
            id: id.to_string(),
            name: format!("test-{id}"),
            url: format!("http://{id}:9100"),
            labels: HashMap::new(),
            registered_at: Utc::now(),
            last_heartbeat: Utc::now(),
            status: WorkerStatus::Active,
            capacity: WorkerCapacity {
                max_boxes: 100,
                available_cpus: cpus,
                available_memory_mib: mem,
                running_boxes: running,
            },
        }
    }

    #[tokio::test]
    async fn test_picks_least_loaded() {
        let store = SqliteStateStore::open_in_memory().unwrap();
        store
            .upsert_worker(&worker("w1", 5, 8, 16384))
            .await
            .unwrap();
        store
            .upsert_worker(&worker("w2", 2, 8, 16384))
            .await
            .unwrap();
        store
            .upsert_worker(&worker("w3", 8, 8, 16384))
            .await
            .unwrap();

        let scheduler = LeastLoadedScheduler;
        let selected = scheduler
            .select_worker(&store, &ScheduleRequest::default())
            .await
            .unwrap();
        assert_eq!(selected.id, "w2");
    }

    #[tokio::test]
    async fn test_filters_by_cpu() {
        let store = SqliteStateStore::open_in_memory().unwrap();
        store
            .upsert_worker(&worker("w1", 0, 2, 16384))
            .await
            .unwrap();
        store
            .upsert_worker(&worker("w2", 0, 8, 16384))
            .await
            .unwrap();

        let scheduler = LeastLoadedScheduler;
        let req = ScheduleRequest {
            cpus: Some(4),
            memory_mib: None,
        };
        let selected = scheduler.select_worker(&store, &req).await.unwrap();
        assert_eq!(selected.id, "w2");
    }

    #[tokio::test]
    async fn test_filters_by_memory() {
        let store = SqliteStateStore::open_in_memory().unwrap();
        store
            .upsert_worker(&worker("w1", 0, 8, 2048))
            .await
            .unwrap();
        store
            .upsert_worker(&worker("w2", 0, 8, 8192))
            .await
            .unwrap();

        let scheduler = LeastLoadedScheduler;
        let req = ScheduleRequest {
            cpus: None,
            memory_mib: Some(4096),
        };
        let selected = scheduler.select_worker(&store, &req).await.unwrap();
        assert_eq!(selected.id, "w2");
    }

    #[tokio::test]
    async fn test_skips_non_active_workers() {
        let store = SqliteStateStore::open_in_memory().unwrap();
        let mut w1 = worker("w1", 0, 8, 16384);
        w1.status = WorkerStatus::Draining;
        store.upsert_worker(&w1).await.unwrap();

        let mut w2 = worker("w2", 0, 8, 16384);
        w2.status = WorkerStatus::Unreachable;
        store.upsert_worker(&w2).await.unwrap();

        store
            .upsert_worker(&worker("w3", 5, 8, 16384))
            .await
            .unwrap();

        let scheduler = LeastLoadedScheduler;
        let selected = scheduler
            .select_worker(&store, &ScheduleRequest::default())
            .await
            .unwrap();
        assert_eq!(selected.id, "w3");
    }

    #[tokio::test]
    async fn test_no_available_workers() {
        let store = SqliteStateStore::open_in_memory().unwrap();

        let scheduler = LeastLoadedScheduler;
        let result = scheduler
            .select_worker(&store, &ScheduleRequest::default())
            .await;
        assert!(matches!(result, Err(ServerError::NoAvailableWorkers)));
    }
}

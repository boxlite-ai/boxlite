//! SQLite-backed StateStore implementation.
//!
//! Follows the same patterns as `boxlite/src/db/mod.rs`:
//! - `parking_lot::Mutex<Connection>` for thread safety
//! - WAL mode for concurrent reads
//! - JSON blob + queryable columns

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};

use chrono::DateTime;
use serde::Serialize;

use crate::error::{ServerError, ServerResult};
use crate::store::StateStore;
use crate::store::schema;
use crate::types::{BoxMapping, WorkerCapacity, WorkerInfo, WorkerStatus};

// ── Helpers ──

fn to_json<T: Serialize>(value: &T, field: &str) -> ServerResult<String> {
    serde_json::to_string(value)
        .map_err(|e| ServerError::Store(format!("Failed to serialize {field}: {e}")))
}

fn from_json<T: serde::de::DeserializeOwned>(json: &str, field: &str) -> ServerResult<T> {
    serde_json::from_str(json)
        .map_err(|e| ServerError::Store(format!("Failed to deserialize {field}: {e}")))
}

fn parse_timestamp(s: &str) -> ServerResult<DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| ServerError::Store(format!("Invalid timestamp: {e}")))
}

/// SQLite-backed state store for the coordinator.
#[derive(Clone)]
pub struct SqliteStateStore {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteStateStore {
    /// Open or create the coordinator database.
    pub fn open(db_path: &Path) -> ServerResult<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ServerError::Store(format!(
                    "Failed to create database directory {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }

        let conn = Connection::open(db_path)?;

        conn.execute_batch(
            "
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON;
            PRAGMA busy_timeout=100000;
            ",
        )?;

        Self::init_schema(&conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Open an in-memory database (for testing).
    #[cfg(test)]
    pub fn open_in_memory() -> ServerResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn init_schema(conn: &Connection) -> ServerResult<()> {
        conn.execute_batch(schema::SCHEMA_VERSION_TABLE)?;

        let current_version: Option<i32> = conn
            .query_row(
                "SELECT version FROM schema_version WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;

        match current_version {
            None => {
                for sql in schema::all_schemas() {
                    conn.execute_batch(sql)?;
                }
                let now = Utc::now().to_rfc3339();
                conn.execute(
                    "INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?1, ?2)",
                    params![schema::SCHEMA_VERSION, now],
                )?;
                tracing::info!(
                    "Initialized coordinator database schema v{}",
                    schema::SCHEMA_VERSION
                );
            }
            Some(v) if v == schema::SCHEMA_VERSION => {}
            Some(v) if v > schema::SCHEMA_VERSION => {
                return Err(ServerError::Store(format!(
                    "Schema version mismatch: database has v{v}, process expects v{}. \
                     Upgrade boxlite-server to a newer version.",
                    schema::SCHEMA_VERSION
                )));
            }
            Some(v) => {
                tracing::warn!(
                    "Database schema v{v} is older than expected v{}, migrations not yet implemented",
                    schema::SCHEMA_VERSION
                );
            }
        }

        Ok(())
    }
}

impl SqliteStateStore {
    /// Query box mappings with a parameterized WHERE clause.
    fn query_box_mappings(&self, where_clause: &str, param: &str) -> ServerResult<Vec<BoxMapping>> {
        let conn = self.conn.lock();
        let sql = format!(
            "SELECT box_id, worker_id, namespace, created_at FROM box_mapping WHERE {where_clause}"
        );
        let mut stmt = conn.prepare(&sql)?;
        let mappings = stmt
            .query_map(params![param], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .filter_map(|r| {
                r.ok()
                    .and_then(|(box_id, worker_id, namespace, created_at)| {
                        Some(BoxMapping {
                            box_id,
                            worker_id,
                            namespace,
                            created_at: parse_timestamp(&created_at).ok()?,
                        })
                    })
            })
            .collect();
        Ok(mappings)
    }
}

#[async_trait]
impl StateStore for SqliteStateStore {
    async fn upsert_worker(&self, worker: &WorkerInfo) -> ServerResult<()> {
        let json = to_json(worker, "worker")?;
        let labels_json = to_json(&worker.labels, "labels")?;
        let capacity_json = to_json(&worker.capacity, "capacity")?;

        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO worker (id, url, labels, registered_at, last_heartbeat, status, capacity, json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
               url = excluded.url,
               labels = excluded.labels,
               last_heartbeat = excluded.last_heartbeat,
               status = excluded.status,
               capacity = excluded.capacity,
               json = excluded.json",
            params![
                worker.id,
                worker.url,
                labels_json,
                worker.registered_at.to_rfc3339(),
                worker.last_heartbeat.to_rfc3339(),
                worker.status.as_str(),
                capacity_json,
                json,
            ],
        )?;
        Ok(())
    }

    async fn get_worker(&self, id: &str) -> ServerResult<Option<WorkerInfo>> {
        let conn = self.conn.lock();
        let result = conn
            .query_row(
                "SELECT json FROM worker WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        match result {
            Some(json) => Ok(Some(from_json(&json, "worker")?)),
            None => Ok(None),
        }
    }

    async fn list_workers(&self) -> ServerResult<Vec<WorkerInfo>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT json FROM worker ORDER BY registered_at")?;
        let workers = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter_map(|json| serde_json::from_str::<WorkerInfo>(&json).ok())
            .collect();
        Ok(workers)
    }

    async fn remove_worker(&self, id: &str) -> ServerResult<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM worker WHERE id = ?1", params![id])?;
        Ok(())
    }

    async fn update_worker_heartbeat(
        &self,
        id: &str,
        capacity: &WorkerCapacity,
    ) -> ServerResult<()> {
        let now = Utc::now();
        let capacity_json = to_json(capacity, "capacity")?;
        let conn = self.conn.lock();

        let current_json: Option<String> = conn
            .query_row(
                "SELECT json FROM worker WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(json_str) = current_json {
            let mut worker: WorkerInfo = from_json(&json_str, "worker")?;
            worker.last_heartbeat = now;
            worker.capacity = capacity.clone();
            let updated_json = to_json(&worker, "worker")?;
            conn.execute(
                "UPDATE worker SET last_heartbeat = ?1, capacity = ?2, json = ?3 WHERE id = ?4",
                params![now.to_rfc3339(), capacity_json, updated_json, id],
            )?;
        }
        Ok(())
    }

    async fn update_worker_status(&self, id: &str, status: WorkerStatus) -> ServerResult<()> {
        let conn = self.conn.lock();

        let current_json: Option<String> = conn
            .query_row(
                "SELECT json FROM worker WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(json_str) = current_json {
            let mut worker: WorkerInfo = from_json(&json_str, "worker")?;
            worker.status = status;
            let updated_json = to_json(&worker, "worker")?;
            conn.execute(
                "UPDATE worker SET status = ?1, json = ?2 WHERE id = ?3",
                params![status.as_str(), updated_json, id],
            )?;
        }
        Ok(())
    }

    async fn insert_box_mapping(&self, mapping: &BoxMapping) -> ServerResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO box_mapping (box_id, worker_id, namespace, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                mapping.box_id,
                mapping.worker_id,
                mapping.namespace,
                mapping.created_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    async fn get_box_mapping(&self, box_id: &str) -> ServerResult<Option<BoxMapping>> {
        let conn = self.conn.lock();
        let result = conn
            .query_row(
                "SELECT box_id, worker_id, namespace, created_at FROM box_mapping WHERE box_id = ?1",
                params![box_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;

        match result {
            Some((box_id, worker_id, namespace, created_at)) => Ok(Some(BoxMapping {
                box_id,
                worker_id,
                namespace,
                created_at: parse_timestamp(&created_at)?,
            })),
            None => Ok(None),
        }
    }

    async fn remove_box_mapping(&self, box_id: &str) -> ServerResult<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM box_mapping WHERE box_id = ?1", params![box_id])?;
        Ok(())
    }

    async fn list_box_mappings_for_worker(&self, worker_id: &str) -> ServerResult<Vec<BoxMapping>> {
        self.query_box_mappings("worker_id = ?1", worker_id)
    }

    async fn list_box_mappings_by_namespace(
        &self,
        namespace: &str,
    ) -> ServerResult<Vec<BoxMapping>> {
        self.query_box_mappings("namespace = ?1", namespace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{WorkerCapacity, WorkerInfo, WorkerStatus};
    use std::collections::HashMap;

    fn test_worker(id: &str, url: &str) -> WorkerInfo {
        WorkerInfo {
            id: id.to_string(),
            name: format!("test-worker-{id}"),
            url: url.to_string(),
            labels: HashMap::new(),
            registered_at: Utc::now(),
            last_heartbeat: Utc::now(),
            status: WorkerStatus::Active,
            capacity: WorkerCapacity {
                max_boxes: 10,
                available_cpus: 4,
                available_memory_mib: 8192,
                running_boxes: 0,
            },
        }
    }

    #[tokio::test]
    async fn test_worker_crud() {
        let store = SqliteStateStore::open_in_memory().unwrap();

        // Insert
        let worker = test_worker("w1", "http://localhost:9100");
        store.upsert_worker(&worker).await.unwrap();

        // Get
        let got = store.get_worker("w1").await.unwrap().unwrap();
        assert_eq!(got.id, "w1");
        assert_eq!(got.url, "http://localhost:9100");

        // List
        let workers = store.list_workers().await.unwrap();
        assert_eq!(workers.len(), 1);

        // Update (upsert)
        let mut updated = worker.clone();
        updated.url = "http://localhost:9200".to_string();
        store.upsert_worker(&updated).await.unwrap();
        let got = store.get_worker("w1").await.unwrap().unwrap();
        assert_eq!(got.url, "http://localhost:9200");

        // Remove
        store.remove_worker("w1").await.unwrap();
        assert!(store.get_worker("w1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_worker_heartbeat() {
        let store = SqliteStateStore::open_in_memory().unwrap();
        let worker = test_worker("w1", "http://localhost:9100");
        store.upsert_worker(&worker).await.unwrap();

        let new_capacity = WorkerCapacity {
            max_boxes: 10,
            available_cpus: 2,
            available_memory_mib: 4096,
            running_boxes: 3,
        };
        store
            .update_worker_heartbeat("w1", &new_capacity)
            .await
            .unwrap();

        let got = store.get_worker("w1").await.unwrap().unwrap();
        assert_eq!(got.capacity.running_boxes, 3);
        assert_eq!(got.capacity.available_memory_mib, 4096);
    }

    #[tokio::test]
    async fn test_worker_status_update() {
        let store = SqliteStateStore::open_in_memory().unwrap();
        let worker = test_worker("w1", "http://localhost:9100");
        store.upsert_worker(&worker).await.unwrap();

        store
            .update_worker_status("w1", WorkerStatus::Unreachable)
            .await
            .unwrap();

        let got = store.get_worker("w1").await.unwrap().unwrap();
        assert_eq!(got.status, WorkerStatus::Unreachable);
    }

    #[tokio::test]
    async fn test_box_mapping_crud() {
        let store = SqliteStateStore::open_in_memory().unwrap();

        // Must have a worker first (FK constraint)
        let worker = test_worker("w1", "http://localhost:9100");
        store.upsert_worker(&worker).await.unwrap();

        let mapping = BoxMapping {
            box_id: "box-123".to_string(),
            worker_id: "w1".to_string(),
            namespace: "default".to_string(),
            created_at: Utc::now(),
        };
        store.insert_box_mapping(&mapping).await.unwrap();

        // Get
        let got = store.get_box_mapping("box-123").await.unwrap().unwrap();
        assert_eq!(got.worker_id, "w1");

        // List by worker
        let mappings = store.list_box_mappings_for_worker("w1").await.unwrap();
        assert_eq!(mappings.len(), 1);

        // Remove
        store.remove_box_mapping("box-123").await.unwrap();
        assert!(store.get_box_mapping("box-123").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_cascade_delete_worker_removes_mappings() {
        let store = SqliteStateStore::open_in_memory().unwrap();
        let worker = test_worker("w1", "http://localhost:9100");
        store.upsert_worker(&worker).await.unwrap();

        let mapping = BoxMapping {
            box_id: "box-456".to_string(),
            worker_id: "w1".to_string(),
            namespace: "default".to_string(),
            created_at: Utc::now(),
        };
        store.insert_box_mapping(&mapping).await.unwrap();

        // Deleting worker should cascade to box_mapping
        store.remove_worker("w1").await.unwrap();
        assert!(store.get_box_mapping("box-456").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_get_nonexistent_worker() {
        let store = SqliteStateStore::open_in_memory().unwrap();
        assert!(store.get_worker("nonexistent").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_get_nonexistent_box_mapping() {
        let store = SqliteStateStore::open_in_memory().unwrap();
        assert!(
            store
                .get_box_mapping("nonexistent")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn test_multiple_workers() {
        let store = SqliteStateStore::open_in_memory().unwrap();

        store
            .upsert_worker(&test_worker("w1", "http://host1:9100"))
            .await
            .unwrap();
        store
            .upsert_worker(&test_worker("w2", "http://host2:9100"))
            .await
            .unwrap();
        store
            .upsert_worker(&test_worker("w3", "http://host3:9100"))
            .await
            .unwrap();

        let workers = store.list_workers().await.unwrap();
        assert_eq!(workers.len(), 3);
    }
}

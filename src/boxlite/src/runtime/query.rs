//! Read committed metadata without acquiring Runtime ownership.
//!
//! Each query uses a short SQLite read transaction. These results do not probe
//! or repair live VM state, and may lag the owner's in-memory state. SQLite's
//! normal WAL coordination remains enabled; the database is not immutable.

use std::path::PathBuf;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use crate::db::{BoxStore, Database, ImageIndexStore};
use crate::runtime::layout::{FilesystemLayout, FsLayoutConfig};
use crate::runtime::types::{BoxInfo, ImageInfo};

/// Read-only view of an existing home's committed metadata.
#[derive(Debug, Clone)]
pub struct ReadOnlyRuntime {
    db_path: PathBuf,
}

impl ReadOnlyRuntime {
    pub fn new(home_dir: PathBuf) -> Self {
        let layout = FilesystemLayout::new(home_dir, FsLayoutConfig::default());
        Self {
            db_path: layout.db_dir().join("boxlite.db"),
        }
    }

    pub async fn list_info(&self) -> BoxliteResult<Vec<BoxInfo>> {
        self.read(|db| {
            Ok(BoxStore::new(db)
                .list_all()?
                .into_iter()
                .map(|(config, state)| BoxInfo::new(&config, &state))
                .collect())
        })
        .await
    }

    pub async fn list_images(&self) -> BoxliteResult<Vec<ImageInfo>> {
        self.read(|db| {
            Ok(ImageIndexStore::new(db)
                .list_all()?
                .into_iter()
                .map(|(reference, cached)| ImageInfo::from_cached(reference, cached))
                .collect())
        })
        .await
    }

    /// Box metadata and image count from the same committed snapshot.
    pub async fn info(&self) -> BoxliteResult<(Vec<BoxInfo>, usize)> {
        self.read(|db| {
            let boxes = BoxStore::new(db.clone())
                .list_all()?
                .into_iter()
                .map(|(config, state)| BoxInfo::new(&config, &state))
                .collect();
            Ok((boxes, ImageIndexStore::new(db).len()?))
        })
        .await
    }

    async fn read<T: Send + 'static>(
        &self,
        query: impl FnOnce(Database) -> BoxliteResult<T> + Send + 'static,
    ) -> BoxliteResult<T> {
        let path = self.db_path.clone();
        tokio::task::spawn_blocking(move || query(Database::open_read_only_snapshot(&path)?))
            .await
            .map_err(|e| BoxliteError::Internal(format!("Read-only query task failed: {e}")))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CachedImage;
    use crate::runtime::types::BoxStatus;
    use crate::{
        BoxliteRuntime,
        runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec},
    };

    fn database(home: &std::path::Path) -> Database {
        Database::open(&home.join("db/boxlite.db")).unwrap()
    }

    fn cached_image() -> CachedImage {
        CachedImage {
            manifest_digest: "sha256:1234567890abcdef".into(),
            config_digest: "sha256:config".into(),
            layers: vec!["sha256:layer".into()],
            cached_at: "2026-09-10T00:00:00Z".into(),
            complete: true,
        }
    }

    #[tokio::test]
    async fn missing_database_is_not_created() {
        let home = tempfile::tempdir().unwrap();
        let query = ReadOnlyRuntime::new(home.path().to_path_buf());
        let error = query.list_info().await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Failed to open read-only database")
        );
        assert!(!home.path().join("db").exists());
    }

    #[tokio::test]
    async fn incompatible_schema_is_not_migrated() {
        for version in [0, 4, 999] {
            let home = tempfile::tempdir().unwrap();
            let db = database(home.path());
            db.conn()
                .execute("UPDATE schema_version SET version = ?1", [version])
                .unwrap();
            let query = ReadOnlyRuntime::new(home.path().to_path_buf());
            let before: String = db
                .conn()
                .query_row("SELECT group_concat(sql) FROM sqlite_master", [], |row| {
                    row.get(0)
                })
                .unwrap();
            let error = query.info().await.unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("Read-only schema version mismatch")
            );
            let actual: i32 = db
                .conn()
                .query_row("SELECT version FROM schema_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(actual, version);
            let after: String = db
                .conn()
                .query_row("SELECT group_concat(sql) FROM sqlite_master", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(before, after);
        }
    }

    #[tokio::test]
    async fn absent_schema_is_not_initialized() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("db/boxlite.db");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let writer = rusqlite::Connection::open(&path).unwrap();
        let query = ReadOnlyRuntime::new(home.path().to_path_buf());
        assert!(
            query
                .list_info()
                .await
                .unwrap_err()
                .to_string()
                .contains("schema_version")
        );
        let tables: i64 = writer
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tables, 0);
    }

    #[tokio::test]
    async fn images_use_committed_index_and_shared_conversion() {
        let home = tempfile::tempdir().unwrap();
        let db = database(home.path());
        let index = ImageIndexStore::new(db.clone());
        let query = ReadOnlyRuntime::new(home.path().to_path_buf());
        db.conn().execute_batch("BEGIN IMMEDIATE").unwrap();
        index.upsert("alpine:3.21", &cached_image()).unwrap();
        assert!(query.list_images().await.unwrap().is_empty());
        db.conn().execute_batch("COMMIT").unwrap();
        let images = query.list_images().await.unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].reference, "alpine:3.21");
        assert_eq!(images[0].repository, "library/alpine");
        assert_eq!(images[0].tag, "3.21");
        assert_eq!(images[0].id, "sha256:1234567890abcdef");
        assert_eq!(
            images[0].cached_at.to_rfc3339(),
            "2026-09-10T00:00:00+00:00"
        );
        assert_eq!(query.info().await.unwrap().1, 1);
        assert!(!home.path().join("images").exists());
        index.remove("alpine:3.21").unwrap();
        assert!(query.list_images().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn actual_read_only_connection_rejects_writes_and_releases_snapshot() {
        let home = tempfile::tempdir().unwrap();
        let db = database(home.path());
        let query = ReadOnlyRuntime::new(home.path().to_path_buf());
        query
            .read(|reader| {
                let error = reader
                    .conn()
                    .execute("DELETE FROM image_index", [])
                    .unwrap_err();
                assert_eq!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::ReadOnly)
                );
                Ok(())
            })
            .await
            .unwrap();
        ImageIndexStore::new(db.clone())
            .upsert("alpine:latest", &cached_image())
            .unwrap();
        // TRUNCATE can complete only when the previous read transaction is gone.
        let checkpoint: (i32, i32, i32) = db
            .conn()
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(checkpoint, (0, 0, 0));
    }

    #[tokio::test]
    async fn busy_database_has_a_bounded_wait() {
        let home = tempfile::tempdir().unwrap();
        let db = database(home.path());
        db.conn()
            .execute_batch("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;")
            .unwrap();
        let query = ReadOnlyRuntime::new(home.path().to_path_buf());
        let start = std::time::Instant::now();
        let error = query.list_info().await.unwrap_err();
        assert!(error.to_string().contains("database is locked"), "{error}");
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
        db.conn().execute_batch("ROLLBACK").unwrap();
        assert!(query.list_info().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn schema_and_queries_share_one_snapshot() {
        let home = tempfile::tempdir().unwrap();
        let db = database(home.path());
        let query = ReadOnlyRuntime::new(home.path().to_path_buf());
        let writer = db.clone();
        query.read(move |reader| {
            // Simulate a competing schema commit after the reader checked its version.
            writer.conn().execute_batch("BEGIN; UPDATE schema_version SET version=999; DROP TABLE image_index; COMMIT;").unwrap();
            assert_eq!(ImageIndexStore::new(reader).len()?, 0);
            Ok(())
        }).await.unwrap();
        assert!(
            query
                .list_images()
                .await
                .unwrap_err()
                .to_string()
                .contains("schema version mismatch")
        );
    }

    #[tokio::test]
    async fn runtime_query_contract_observes_commits_without_repairing_stored_state() {
        let home = boxlite_test_utils::home::PerTestBoxHome::isolated();
        let runtime = BoxliteRuntime::new(BoxliteOptions {
            home_dir: home.path.clone(),
            image_registries: vec![],
        })
        .unwrap();
        let handle = runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("issue258:latest".into()),
                    auto_delete: Some(0),
                    ..Default::default()
                },
                Some("query-contract".into()),
            )
            .await
            .unwrap();
        let id = handle.id().to_string();
        let query = ReadOnlyRuntime::new(home.path.clone());
        assert_eq!(
            query.list_info().await.unwrap()[0].status,
            BoxStatus::Configured
        );
        // Fixture injection through the project store, not a live VM transition:
        // the invalid PID deliberately makes liveness repair observable.
        let writer = database(&home.path);
        let store = BoxStore::new(writer);
        let mut state = store.load_state(&id).unwrap().unwrap();
        state.set_status(BoxStatus::Running);
        state.set_pid(Some(u32::MAX));
        store.update_state(&id, &state).unwrap();
        assert_eq!(
            query.list_info().await.unwrap()[0].status,
            BoxStatus::Running
        );
        assert_eq!(store.load_state(&id).unwrap().unwrap().pid, Some(u32::MAX));
        assert_eq!(
            store.load_state(&id).unwrap().unwrap().status,
            BoxStatus::Running
        );
        state.set_status(BoxStatus::Configured);
        state.set_pid(None);
        store.update_state(&id, &state).unwrap();
        drop(handle);
        runtime.remove(&id, false).await.unwrap();
        assert!(query.list_info().await.unwrap().is_empty());
    }
}

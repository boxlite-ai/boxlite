//! Image index storage operations.
//!
//! Provides database-backed storage for the image index, replacing the
//! JSON file-based approach for better reliability and concurrent access.

use rusqlite::{OptionalExtension, params};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Database, db_err};

/// Metadata for a cached image.
#[derive(Debug, Clone)]
pub struct CachedImage {
    /// Manifest digest of the final image (sha256:...)
    /// For multi-platform images, this is the platform-specific manifest digest
    pub manifest_digest: String,

    /// Config blob digest (sha256:...)
    pub config_digest: String,

    /// Layer digests in order
    pub layers: Vec<String>,

    /// When the image was cached (ISO 8601)
    pub cached_at: String,

    /// Whether all layers are fully downloaded
    pub complete: bool,

    /// When the image disk built from these layers was last used, in unix
    /// seconds. The eviction order for the image disk cache; 0 means no use
    /// has been recorded yet, which ranks the entry coldest.
    pub last_used_at: i64,
}

/// Image index storage wrapping Database.
///
/// Manages image index entries in the database.
#[derive(Clone)]
pub struct ImageIndexStore {
    db: Database,
}

impl ImageIndexStore {
    /// Create a new ImageIndexStore from a Database.
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Get cached image by reference.
    ///
    /// Returns None if image not in index.
    pub fn get(&self, reference: &str) -> BoxliteResult<Option<CachedImage>> {
        let conn = self.db.conn();

        let row: Option<(String, String, String, String, i32, i64)> = db_err!(
            conn.query_row(
                "SELECT manifest_digest, config_digest, layers, cached_at, complete, last_used_at FROM image_index WHERE reference = ?1",
                params![reference],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .optional()
        )?;

        match row {
            Some((
                manifest_digest,
                config_digest,
                layers_json,
                cached_at,
                complete,
                last_used_at,
            )) => {
                let layers: Vec<String> = serde_json::from_str(&layers_json).map_err(|e| {
                    BoxliteError::Database(format!("Failed to deserialize layers: {}", e))
                })?;
                Ok(Some(CachedImage {
                    manifest_digest,
                    config_digest,
                    layers,
                    cached_at,
                    complete: complete != 0,
                    last_used_at,
                }))
            }
            None => Ok(None),
        }
    }

    /// Add or update cached image.
    pub fn upsert(&self, reference: &str, image: &CachedImage) -> BoxliteResult<()> {
        let conn = self.db.conn();

        let layers_json = serde_json::to_string(&image.layers)
            .map_err(|e| BoxliteError::Database(format!("Failed to serialize layers: {}", e)))?;

        db_err!(conn.execute(
            r#"
            INSERT INTO image_index (reference, manifest_digest, config_digest, layers, cached_at, complete, last_used_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(reference) DO UPDATE SET
                manifest_digest = excluded.manifest_digest,
                config_digest = excluded.config_digest,
                layers = excluded.layers,
                cached_at = excluded.cached_at,
                complete = excluded.complete,
                last_used_at = excluded.last_used_at
            "#,
            params![
                reference,
                image.manifest_digest,
                image.config_digest,
                layers_json,
                image.cached_at,
                if image.complete { 1 } else { 0 },
                image.last_used_at
            ],
        ))?;

        Ok(())
    }

    /// Record that this reference's image disk was just used.
    ///
    /// A no-op for a reference with no row: an image disk whose row is gone is
    /// unreachable, and the reclaim sweep — not the eviction order — is what
    /// deals with it.
    pub fn touch(&self, reference: &str, used_at: i64) -> BoxliteResult<()> {
        let conn = self.db.conn();
        db_err!(conn.execute(
            "UPDATE image_index SET last_used_at = ?2 WHERE reference = ?1",
            params![reference, used_at],
        ))?;
        Ok(())
    }

    /// Remove cached image from index.
    #[allow(dead_code)]
    pub fn remove(&self, reference: &str) -> BoxliteResult<bool> {
        let conn = self.db.conn();
        let rows_affected = db_err!(conn.execute(
            "DELETE FROM image_index WHERE reference = ?1",
            params![reference]
        ))?;
        Ok(rows_affected > 0)
    }

    /// Get number of cached images in index.
    pub fn len(&self) -> BoxliteResult<usize> {
        let conn = self.db.conn();
        let count: i64 =
            db_err!(conn.query_row("SELECT COUNT(*) FROM image_index", [], |row| row.get(0)))?;
        Ok(count as usize)
    }

    /// Check if index is empty.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> BoxliteResult<bool> {
        Ok(self.len()? == 0)
    }

    /// List all cached images.
    pub fn list_all(&self) -> BoxliteResult<Vec<(String, CachedImage)>> {
        let conn = self.db.conn();
        let mut stmt = db_err!(conn.prepare(
            r#"
            SELECT reference, manifest_digest, config_digest, layers, cached_at, complete, last_used_at
            FROM image_index
            ORDER BY cached_at DESC
            "#
        ))?;

        let rows = db_err!(stmt.query_map([], |row| {
            let reference: String = row.get(0)?;
            let manifest_digest: String = row.get(1)?;
            let config_digest: String = row.get(2)?;
            let layers_json: String = row.get(3)?;
            let cached_at: String = row.get(4)?;
            let complete: i32 = row.get(5)?;
            let last_used_at: i64 = row.get(6)?;
            Ok((
                reference,
                manifest_digest,
                config_digest,
                layers_json,
                cached_at,
                complete,
                last_used_at,
            ))
        }))?;

        let mut result = Vec::new();
        for row in rows {
            let (
                reference,
                manifest_digest,
                config_digest,
                layers_json,
                cached_at,
                complete,
                last_used_at,
            ) = db_err!(row)?;
            let layers: Vec<String> = serde_json::from_str(&layers_json).map_err(|e| {
                BoxliteError::Database(format!("Failed to deserialize layers: {}", e))
            })?;

            result.push((
                reference,
                CachedImage {
                    manifest_digest,
                    config_digest,
                    layers,
                    cached_at,
                    complete: complete != 0,
                    last_used_at,
                },
            ));
        }

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_db() -> (ImageIndexStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();
        (ImageIndexStore::new(db), dir)
    }

    #[test]
    fn test_upsert_and_get() {
        let (store, _dir) = create_test_db();

        let image = CachedImage {
            manifest_digest: "sha256:abc123".to_string(),
            config_digest: "sha256:config123".to_string(),
            layers: vec!["sha256:layer1".to_string(), "sha256:layer2".to_string()],
            cached_at: "2025-10-24T12:00:00Z".to_string(),
            complete: true,
            last_used_at: 0,
        };

        store.upsert("python:alpine", &image).unwrap();

        let loaded = store.get("python:alpine").unwrap();
        assert!(loaded.is_some());
        let loaded = loaded.unwrap();
        assert_eq!(loaded.manifest_digest, "sha256:abc123");
        assert_eq!(loaded.config_digest, "sha256:config123");
        assert_eq!(loaded.layers.len(), 2);
        assert!(loaded.complete);
    }

    #[test]
    fn test_upsert_updates_existing() {
        let (store, _dir) = create_test_db();

        let image1 = CachedImage {
            manifest_digest: "sha256:abc123".to_string(),
            config_digest: "sha256:config123".to_string(),
            layers: vec!["sha256:layer1".to_string()],
            cached_at: "2025-10-24T12:00:00Z".to_string(),
            complete: true,
            last_used_at: 0,
        };

        store.upsert("python:alpine", &image1).unwrap();

        let image2 = CachedImage {
            manifest_digest: "sha256:def456".to_string(),
            config_digest: "sha256:config456".to_string(),
            layers: vec!["sha256:layer2".to_string()],
            cached_at: "2025-10-25T12:00:00Z".to_string(),
            complete: false,
            last_used_at: 0,
        };

        store.upsert("python:alpine", &image2).unwrap();

        let loaded = store.get("python:alpine").unwrap().unwrap();
        assert_eq!(loaded.manifest_digest, "sha256:def456");
        assert!(!loaded.complete);

        assert_eq!(store.len().unwrap(), 1);
    }

    #[test]
    fn test_get_nonexistent() {
        let (store, _dir) = create_test_db();
        let loaded = store.get("nonexistent:tag").unwrap();
        assert!(loaded.is_none());
    }

    #[test]
    fn test_remove() {
        let (store, _dir) = create_test_db();

        let image = CachedImage {
            manifest_digest: "sha256:abc123".to_string(),
            config_digest: "sha256:config123".to_string(),
            layers: vec![],
            cached_at: "2025-10-24T12:00:00Z".to_string(),
            complete: true,
            last_used_at: 0,
        };

        store.upsert("python:alpine", &image).unwrap();
        assert_eq!(store.len().unwrap(), 1);

        let removed = store.remove("python:alpine").unwrap();
        assert!(removed);
        assert_eq!(store.len().unwrap(), 0);

        let removed_again = store.remove("python:alpine").unwrap();
        assert!(!removed_again);
    }

    #[test]
    fn test_len_and_is_empty() {
        let (store, _dir) = create_test_db();

        assert!(store.is_empty().unwrap());
        assert_eq!(store.len().unwrap(), 0);

        let image = CachedImage {
            manifest_digest: "sha256:abc123".to_string(),
            config_digest: "sha256:config123".to_string(),
            layers: vec![],
            cached_at: "2025-10-24T12:00:00Z".to_string(),
            complete: true,
            last_used_at: 0,
        };

        store.upsert("python:alpine", &image).unwrap();
        assert!(!store.is_empty().unwrap());
        assert_eq!(store.len().unwrap(), 1);
    }

    /// `touch` is the only writer of the eviction signal, and it must move
    /// the value forward without disturbing the rest of the row.
    #[test]
    fn touch_advances_last_used_at_only() {
        let (store, _dir) = create_test_db();

        let image = CachedImage {
            manifest_digest: "sha256:abc123".to_string(),
            config_digest: "sha256:config123".to_string(),
            layers: vec!["sha256:layer1".to_string()],
            cached_at: "2026-01-21T10:00:00Z".to_string(),
            complete: true,
            last_used_at: 100,
        };
        store.upsert("python:alpine", &image).unwrap();

        store.touch("python:alpine", 900).unwrap();

        let loaded = store.get("python:alpine").unwrap().unwrap();
        assert_eq!(loaded.last_used_at, 900);
        assert_eq!(loaded.cached_at, "2026-01-21T10:00:00Z");
        assert_eq!(loaded.manifest_digest, "sha256:abc123");
    }

    /// A reference with no row is not an error: an unreachable disk is the
    /// reclaim sweep's business, not the eviction order's.
    #[test]
    fn touch_is_a_no_op_for_an_unknown_reference() {
        let (store, _dir) = create_test_db();
        store.touch("never-pulled:latest", 900).unwrap();
        assert!(store.is_empty().unwrap());
    }

    #[test]
    fn test_list_all_empty() {
        let (store, _dir) = create_test_db();
        let images = store.list_all().unwrap();
        assert_eq!(images.len(), 0);
    }

    #[test]
    fn test_list_all_multiple_ordered() {
        let (store, _dir) = create_test_db();

        let image1 = CachedImage {
            manifest_digest: "sha256:abc123".to_string(),
            config_digest: "sha256:config123".to_string(),
            layers: vec!["sha256:layer1".to_string()],
            cached_at: "2026-01-21T10:00:00Z".to_string(),
            complete: true,
            last_used_at: 0,
        };

        let image2 = CachedImage {
            manifest_digest: "sha256:def456".to_string(),
            config_digest: "sha256:config456".to_string(),
            layers: vec!["sha256:layer2".to_string()],
            cached_at: "2026-01-21T14:00:00Z".to_string(),
            complete: true,
            last_used_at: 0,
        };

        let image3 = CachedImage {
            manifest_digest: "sha256:ghi789".to_string(),
            config_digest: "sha256:config789".to_string(),
            layers: vec!["sha256:layer3".to_string()],
            cached_at: "2026-01-21T08:00:00Z".to_string(),
            complete: true,
            last_used_at: 0,
        };

        store.upsert("alpine:latest", &image1).unwrap();
        store.upsert("python:alpine", &image2).unwrap();
        store.upsert("nginx:latest", &image3).unwrap();

        let images = store.list_all().unwrap();
        assert_eq!(images.len(), 3);

        // Newest first
        assert_eq!(images[0].0, "python:alpine"); // 14:00
        assert_eq!(images[1].0, "alpine:latest"); // 10:00
        assert_eq!(images[2].0, "nginx:latest"); // 08:00
    }
}

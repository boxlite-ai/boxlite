//! SSH configuration is independent of box configuration and is never imported from files.

use std::path::Path;

use boxlite_shared::{BoxliteError, BoxliteResult};
use rusqlite::Connection;

use super::Migration;
use crate::db::{db_err, schema};

pub(super) struct AddSshConfig;

impl Migration for AddSshConfig {
    fn source_version(&self) -> i32 {
        10
    }

    fn target_version(&self) -> i32 {
        11
    }

    fn description(&self) -> &str {
        "Add independent SSH configuration and host identity"
    }

    fn run(&self, conn: &Connection, _home_dir: Option<&Path>) -> BoxliteResult<()> {
        db_err!(conn.execute_batch(schema::SSH_CONFIG_TABLE))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::os::unix::fs::PermissionsExt;

    fn v10(path: &Path) -> Connection {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let conn = Connection::open(path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .unwrap();
        for sql in [
            schema::SCHEMA_VERSION_TABLE,
            schema::BOX_CONFIG_TABLE,
            schema::BOX_STATE_TABLE,
            schema::ALIVE_TABLE,
            schema::IMAGE_INDEX_TABLE,
            schema::BASE_DISK_TABLE,
            schema::BASE_DISK_REF_TABLE,
            schema::SNAPSHOT_TABLE,
        ] {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute_batch("INSERT INTO schema_version VALUES (1, 10, 'before');
            INSERT INTO box_config VALUES ('existing', 'existing-name', 123, '{\"options\":{\"auto_delete\":0},\"id\":\"existing\"}');
            INSERT INTO box_state VALUES ('existing', 'stopped', NULL, '{\"status\":\"stopped\"}');").unwrap();
        conn
    }

    fn box_json(conn: &Connection) -> (String, String, String, i64) {
        conn.query_row("SELECT c.json, s.json, c.name, c.created_at FROM box_config c JOIN box_state s ON c.id = s.id", [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap()
    }

    #[test]
    fn ssh_v10_migration_preserves_boxes_and_protects_existing_database_files() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("db/boxlite.db");
        let old = v10(&path);
        let before = box_json(&old);
        let paths = [
            (path.parent().unwrap().to_owned(), 0o700),
            (path.clone(), 0o600),
            (path.with_file_name("boxlite.db-wal"), 0o600),
            (path.with_file_name("boxlite.db-shm"), 0o600),
        ];
        for (path, _) in &paths {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o777)).unwrap();
        }
        for _ in 0..2 {
            let db = Database::open(&path).unwrap();
            let conn = db.conn();
            assert_eq!(box_json(&conn), before);
            assert_eq!(
                conn.query_row("SELECT version FROM schema_version", [], |row| row
                    .get::<_, i32>(0))
                    .unwrap(),
                11
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM ssh_config", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            for (path, mode) in &paths {
                assert_eq!(
                    std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    *mode
                );
            }
        }
    }

    #[test]
    fn ssh_v10_migration_retries_after_version_commit_failure() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("db/boxlite.db");
        let old = v10(&path);
        let before = box_json(&old);
        old.execute_batch("CREATE TRIGGER fail_version BEFORE UPDATE ON schema_version BEGIN SELECT RAISE(ABORT, 'version failure'); END;").unwrap();
        assert!(Database::open(&path).is_err());
        assert_eq!(box_json(&old), before);
        assert_eq!(
            old.query_row("SELECT version FROM schema_version", [], |row| row
                .get::<_, i32>(0))
                .unwrap(),
            10
        );
        old.execute_batch("DROP TRIGGER fail_version").unwrap();
        let db = Database::open(&path).unwrap();
        assert_eq!(box_json(&db.conn()), before);
        assert_eq!(
            db.conn()
                .query_row("SELECT version FROM schema_version", [], |row| row
                    .get::<_, i32>(0))
                .unwrap(),
            11
        );
    }
}

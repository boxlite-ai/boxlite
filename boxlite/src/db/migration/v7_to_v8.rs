//! Migration v7 → v8: Rename NetworkSpec::Isolated to NetworkSpec::Enabled.
//!
//! Old format: `"network":"Isolated"`
//! New format: `"network":{"Enabled":{"allow_net":[]}}`

use std::path::Path;

use rusqlite::Connection;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Migration, db_err};

pub(crate) struct RenameNetworkSpec;

impl Migration for RenameNetworkSpec {
    fn source_version(&self) -> i32 {
        7
    }
    fn target_version(&self) -> i32 {
        8
    }
    fn description(&self) -> &str {
        "Rename NetworkSpec::Isolated to NetworkSpec::Enabled{allow_net:[]}"
    }

    fn run(&self, conn: &Connection, _home_dir: Option<&Path>) -> BoxliteResult<()> {
        // Update all box configs: replace unit variant with struct variant
        let updated = db_err!(conn.execute(
            r#"UPDATE box_config SET json = REPLACE(json, '"network":"Isolated"', '"network":{"Enabled":{"allow_net":[]}}')"#,
            [],
        ))?;

        tracing::info!("Migrated {updated} box configs: NetworkSpec::Isolated → Enabled");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migration_replaces_isolated() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE box_config (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, json TEXT)",
        )
        .unwrap();

        // Insert old-format config
        conn.execute(
            "INSERT INTO box_config VALUES ('box1', 'test', 0, ?)",
            [r#"{"id":"box1","network":"Isolated","ports":[]}"#],
        )
        .unwrap();

        // Run migration
        let m = RenameNetworkSpec;
        m.run(&conn, None).unwrap();

        // Verify
        let json: String = conn
            .query_row("SELECT json FROM box_config WHERE id = 'box1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            json.contains(r#""network":{"Enabled":{"allow_net":[]}}"#),
            "should be migrated: {json}"
        );
        assert!(
            !json.contains(r#""Isolated""#),
            "should not contain Isolated: {json}"
        );
    }
}

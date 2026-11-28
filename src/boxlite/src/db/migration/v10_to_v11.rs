//! Migration v10 → v11: rewrite legacy box status strings.
//!
//! `BoxStatus` has dropped variants over time (`starting`, and the transient
//! `snapshotting` / `restoring` / `exporting` / `cloning`). A stored row can
//! still carry one of them, in the `box_state.status` column and in the
//! `status` field of the state JSON.
//!
//! `BoxStatus::from_str` still accepts those names, but a stored state is
//! decoded by serde, which knows only the current variants. Startup recovery
//! reads every box, so one such row would fail to load instead of being
//! reconciled. Rewriting the rows once, here, keeps the decoder strict.
//!
//! Mapping, identical to the `from_str` compatibility arms:
//! - `starting` → `configured`
//! - `snapshotting`, `restoring`, `exporting`, `cloning` → `stopped`
//!
//! `detached` is also not a variant. Nothing is known to have written it, so
//! there is no recorded intent to preserve; it becomes `unknown`, which
//! recovery reconciles against the real process table.

use std::path::Path;

use rusqlite::Connection;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Migration, db_err};

pub(crate) struct NormalizeLegacyBoxStatus;

/// Current name for a status string that no longer exists; `None` if the
/// string needs no rewrite.
fn current_status(legacy: &str) -> Option<&'static str> {
    match legacy {
        "starting" => Some("configured"),
        "snapshotting" | "restoring" | "exporting" | "cloning" => Some("stopped"),
        "detached" => Some("unknown"),
        _ => None,
    }
}

impl Migration for NormalizeLegacyBoxStatus {
    fn source_version(&self) -> i32 {
        10
    }

    fn target_version(&self) -> i32 {
        11
    }

    fn description(&self) -> &str {
        "Rewrite legacy box status strings to current BoxStatus values"
    }

    fn run(&self, conn: &Connection, _home_dir: Option<&Path>) -> BoxliteResult<()> {
        let rows = {
            let mut statement = db_err!(conn.prepare("SELECT id, status, json FROM box_state"))?;
            let rows = db_err!(statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            }))?;
            db_err!(rows.collect::<Result<Vec<_>, _>>())?
        };

        let mut updates = Vec::new();

        for (id, column, json) in rows {
            let mut state: serde_json::Value = serde_json::from_str(&json).map_err(|error| {
                BoxliteError::Database(format!(
                    "parse box_state {id} while migrating legacy status: {error}"
                ))
            })?;

            let legacy_json = state
                .get("status")
                .and_then(|status| status.as_str())
                .and_then(current_status);
            let legacy_column = current_status(&column);
            if legacy_json.is_none() && legacy_column.is_none() {
                continue;
            }

            if let Some(status) = legacy_json {
                state["status"] = serde_json::Value::from(status);
            }
            let json = serde_json::to_string(&state).map_err(|error| {
                BoxliteError::Database(format!(
                    "serialize box_state {id} while migrating legacy status: {error}"
                ))
            })?;
            // The column mirrors the status the JSON decodes to; fall back to
            // rewriting it on its own only when the JSON carries no status.
            let column = match state.get("status").and_then(|status| status.as_str()) {
                Some(status) => status.to_owned(),
                None => legacy_column.map_or(column, str::to_owned),
            };
            updates.push((id, column, json));
        }

        let transaction = db_err!(conn.unchecked_transaction())?;
        for (id, column, json) in &updates {
            db_err!(transaction.execute(
                "UPDATE box_state SET status = ?1, json = ?2 WHERE id = ?3",
                rusqlite::params![column, json, id],
            ))?;
        }
        db_err!(transaction.commit())?;

        if !updates.is_empty() {
            tracing::info!(
                boxes = updates.len(),
                "Rewrote legacy status strings on stored box states"
            );
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_with_box_state(rows: &[(&str, &str, &str)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE box_state (
                id TEXT PRIMARY KEY NOT NULL,
                status TEXT NOT NULL,
                pid INTEGER,
                json TEXT NOT NULL
            )",
        )
        .unwrap();
        for (id, status, json) in rows {
            conn.execute(
                "INSERT INTO box_state (id, status, pid, json) VALUES (?1, ?2, NULL, ?3)",
                rusqlite::params![id, status, json],
            )
            .unwrap();
        }
        conn
    }

    fn load(conn: &Connection, id: &str) -> (String, serde_json::Value) {
        let (status, json): (String, String) = conn
            .query_row(
                "SELECT status, json FROM box_state WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        (status, serde_json::from_str(&json).unwrap())
    }

    #[test]
    fn rewrites_each_legacy_status_in_column_and_json() {
        let cases = [
            ("starting", "configured"),
            ("snapshotting", "stopped"),
            ("restoring", "stopped"),
            ("exporting", "stopped"),
            ("cloning", "stopped"),
            ("detached", "unknown"),
        ];
        let jsons: Vec<String> = cases
            .iter()
            .map(|(legacy, _)| format!(r#"{{"status":"{legacy}","pid":null}}"#))
            .collect();
        let rows: Vec<(&str, &str, &str)> = cases
            .iter()
            .zip(&jsons)
            .map(|((legacy, _), json)| (*legacy, *legacy, json.as_str()))
            .collect();
        let conn = open_with_box_state(&rows);

        NormalizeLegacyBoxStatus.run(&conn, None).unwrap();

        for (legacy, current) in cases {
            let (column, json) = load(&conn, legacy);
            assert_eq!(column, current, "column for {legacy}");
            assert_eq!(json["status"], current, "json for {legacy}");
            assert!(json.get("pid").is_some(), "other fields are preserved");
        }
    }

    #[test]
    fn leaves_current_statuses_untouched() {
        let json = r#"{"status":"running","pid":42}"#;
        let conn = open_with_box_state(&[("live", "running", json)]);

        NormalizeLegacyBoxStatus.run(&conn, None).unwrap();

        let (column, value) = load(&conn, "live");
        assert_eq!(column, "running");
        assert_eq!(
            value,
            serde_json::from_str::<serde_json::Value>(json).unwrap()
        );
    }

    #[test]
    fn realigns_a_legacy_column_with_current_json() {
        let conn = open_with_box_state(&[("split", "starting", r#"{"status":"running"}"#)]);

        NormalizeLegacyBoxStatus.run(&conn, None).unwrap();

        let (column, json) = load(&conn, "split");
        assert_eq!(column, "running");
        assert_eq!(json["status"], "running");
    }

    #[test]
    fn rewrites_a_legacy_json_status_when_the_column_is_current() {
        let conn = open_with_box_state(&[("split", "stopped", r#"{"status":"starting"}"#)]);

        NormalizeLegacyBoxStatus.run(&conn, None).unwrap();

        let (column, json) = load(&conn, "split");
        assert_eq!(json["status"], "configured");
        assert_eq!(column, "configured");
    }

    #[test]
    fn rejects_unparseable_state_json() {
        let conn = open_with_box_state(&[("broken", "starting", "not json")]);

        assert!(NormalizeLegacyBoxStatus.run(&conn, None).is_err());
    }
}

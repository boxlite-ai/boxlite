//! Migration v10 → v11: split the fused deletion axes on persisted boxes.
//!
//! `auto_remove` and `auto_delete` used to resolve to one policy:
//!
//! ```ignore
//! auto_delete.unwrap_or(auto_remove as u32) > 0   // removes on stop
//! ```
//!
//! so `auto_delete` *overrode* `auto_remove` whenever it was present, and the
//! released CLI always made it present — `Some(0)` for an ordinary box and
//! `Some(1)` for `--rm`. `auto_remove` was never written and so serialized as
//! its `true` default, which the old rule then ignored.
//!
//! `removes_on_stop()` now reads `auto_remove` alone, so those same rows would
//! be read as "remove this box the moment it stops": every ordinary box
//! persisted by an older build carries `auto_remove:true` next to its
//! `auto_delete:0`. `recover_boxes` acts on that during `initialize`, so
//! without this migration the first command after upgrading — a bare
//! `boxlite ls` — deletes every pre-upgrade box that was not created with
//! `--rm`.
//!
//! Rewriting the rows once, here, is where the database's copy of the old
//! shape is resolved while it can still be read as what it meant. Afterwards
//! the two fields are independent: a `auto_delete` deadline is a real deferred
//! deadline rather than a spelling of remove-on-stop, so the key is dropped and
//! `auto_remove` carries the whole decision. No pre-split box can have had a
//! deferred deadline — nothing enforced one — so nothing is lost by clearing
//! it.
//!
//! The database is not the only store holding that shape: an exported archive
//! carries the same fused `box_options` in its manifest, and
//! `options_from_manifest` resolves it there by the same rule for anything
//! below `SPLIT_DELETION_ARCHIVE_VERSION`. A migration cannot reach that copy,
//! because import writes a *new* row long after this has run.

use std::path::Path;

use rusqlite::Connection;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Migration, db_err};

pub(crate) struct SplitFusedDeletionAxes;

/// The pre-split rule, applied to the persisted JSON shape.
///
/// `auto_delete` present wins, exactly as `effective_auto_delete` did; only a
/// missing (or null) `auto_delete` fell back to `auto_remove`, which itself
/// defaulted to `true` when absent.
fn removed_on_stop(options: &serde_json::Map<String, serde_json::Value>) -> bool {
    match options
        .get("auto_delete")
        .and_then(serde_json::Value::as_u64)
    {
        Some(seconds) => seconds > 0,
        None => options
            .get("auto_remove")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
    }
}

impl Migration for SplitFusedDeletionAxes {
    fn source_version(&self) -> i32 {
        10
    }

    fn target_version(&self) -> i32 {
        11
    }

    fn description(&self) -> &str {
        "Split the fused auto_remove/auto_delete policy on legacy box configs"
    }

    fn run(&self, conn: &Connection, _home_dir: Option<&Path>) -> BoxliteResult<()> {
        let configs = {
            let mut statement = db_err!(conn.prepare("SELECT id, json FROM box_config"))?;
            let rows = db_err!(statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }))?;
            db_err!(rows.collect::<Result<Vec<_>, _>>())?
        };

        let mut updates = Vec::new();

        for (id, json) in configs {
            let mut config: serde_json::Value = serde_json::from_str(&json).map_err(|error| {
                BoxliteError::Database(format!(
                    "parse box_config {id} while splitting deletion axes: {error}"
                ))
            })?;

            let Some(options) = config.pointer_mut("/options") else {
                continue;
            };
            let Some(options) = options.as_object_mut() else {
                continue;
            };

            let removes = removed_on_stop(options);
            options.insert("auto_remove".to_string(), serde_json::Value::Bool(removes));
            options.remove("auto_delete");

            let json = serde_json::to_string(&config).map_err(|error| {
                BoxliteError::Database(format!(
                    "serialize box_config {id} while splitting deletion axes: {error}"
                ))
            })?;
            updates.push((id, json));
        }

        let transaction = db_err!(conn.unchecked_transaction())?;
        for (id, json) in &updates {
            db_err!(transaction.execute(
                "UPDATE box_config SET json = ?1 WHERE id = ?2",
                rusqlite::params![json, id],
            ))?;
        }
        db_err!(transaction.commit())?;

        if !updates.is_empty() {
            tracing::info!(
                boxes = updates.len(),
                "Split fused deletion policy on legacy box configs"
            );
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_with_box_config(rows: &[(&str, &str)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE box_config (
                id TEXT PRIMARY KEY,
                name TEXT,
                created_at INTEGER,
                json TEXT NOT NULL
            )",
        )
        .unwrap();
        for (id, json) in rows {
            conn.execute(
                "INSERT INTO box_config (id, name, created_at, json) VALUES (?1, NULL, 0, ?2)",
                rusqlite::params![id, json],
            )
            .unwrap();
        }
        conn
    }

    fn load_json(conn: &Connection, id: &str) -> serde_json::Value {
        let json: String = conn
            .query_row("SELECT json FROM box_config WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .unwrap();
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn an_ordinary_legacy_box_survives_the_upgrade() {
        // The shape every `boxlite run` / `create` without `--rm` persisted:
        // an explicit `auto_delete:0` beside the untouched `auto_remove:true`
        // default. Read under the new rule this says "delete on stop", and
        // recovery would destroy the box on the next command.
        let conn = open_with_box_config(&[(
            "ordinary",
            r#"{"options":{"auto_remove":true,"auto_delete":0}}"#,
        )]);

        SplitFusedDeletionAxes.run(&conn, None).unwrap();

        let value = load_json(&conn, "ordinary");
        assert_eq!(value.pointer("/options/auto_remove"), Some(&false.into()));
        assert!(
            value.pointer("/options/auto_delete").is_none(),
            "the fused sentinel must not survive as a deferred deadline"
        );

        // Read the migrated row back through the type whose reading of it is
        // the actual bug: `recover_boxes` asks `removes_on_stop()`, not the
        // JSON, and that is what must now answer "keep".
        let options: crate::runtime::options::BoxOptions =
            serde_json::from_value(value.pointer("/options").unwrap().clone())
                .expect("a migrated row must still deserialize");
        assert!(
            !options.removes_on_stop(),
            "recovery must not treat a migrated legacy box as ephemeral"
        );
    }

    #[test]
    fn a_legacy_rm_box_keeps_removing_on_stop() {
        // `--rm` was spelled `auto_delete:1`; that must land on the synchronous
        // axis rather than becoming a 1-second deadline.
        let conn = open_with_box_config(&[(
            "ephemeral",
            r#"{"options":{"auto_remove":true,"auto_delete":1}}"#,
        )]);

        SplitFusedDeletionAxes.run(&conn, None).unwrap();

        let value = load_json(&conn, "ephemeral");
        assert_eq!(value.pointer("/options/auto_remove"), Some(&true.into()));
        assert!(value.pointer("/options/auto_delete").is_none());
    }

    #[test]
    fn a_row_without_auto_delete_falls_back_to_auto_remove() {
        // Only a missing `auto_delete` ever consulted `auto_remove`, so both
        // spellings of that fallback must be preserved.
        let conn = open_with_box_config(&[
            ("kept", r#"{"options":{"auto_remove":false}}"#),
            ("removed", r#"{"options":{"auto_remove":true}}"#),
            ("defaulted", r#"{"options":{}}"#),
        ]);

        SplitFusedDeletionAxes.run(&conn, None).unwrap();

        assert_eq!(
            load_json(&conn, "kept").pointer("/options/auto_remove"),
            Some(&false.into())
        );
        assert_eq!(
            load_json(&conn, "removed").pointer("/options/auto_remove"),
            Some(&true.into())
        );
        // An absent `auto_remove` deserialized as its `true` default.
        assert_eq!(
            load_json(&conn, "defaulted").pointer("/options/auto_remove"),
            Some(&true.into())
        );
    }

    #[test]
    fn leaves_a_config_with_no_options_section_alone() {
        let conn = open_with_box_config(&[("bare", r#"{"id":"bare"}"#)]);

        // Must not error when there's nothing to migrate.
        SplitFusedDeletionAxes.run(&conn, None).unwrap();

        assert!(load_json(&conn, "bare").pointer("/options").is_none());
    }
}

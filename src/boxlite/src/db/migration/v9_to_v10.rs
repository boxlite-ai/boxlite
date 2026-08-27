//! Migration v9 → v10: drop the now-ambiguous empty capability policy.
//!
//! Before this PR's capability-policy work, `advanced.capabilities` was a
//! plain, always-serialized `ContainerCapabilities`, so every ordinary
//! (never customized) box's persisted JSON already contained
//! `"capabilities":{"add":[],"drop":[]}`. After the field became
//! `Option<ContainerCapabilities>`, that exact JSON shape deserializes as
//! `Some(empty)` — "the caller explicitly asked for an empty policy" — not
//! `None` — "the caller never touched it" — which is what it actually meant
//! for every box persisted before this migration exists. `Some(empty)` and
//! `None` are otherwise indistinguishable on the wire, so there is no way to
//! tell them apart after the fact except by rewriting the old rows once,
//! here, while we still know which shape produced them.
//!
//! Without this, `archive_version_for_options` stamps every such
//! pre-existing box's export as `CAPABILITY_POLICY_ARCHIVE_VERSION` instead
//! of `ARCHIVE_VERSION`, even though it never had a real capability
//! override — an older, v3-only importer would then refuse a perfectly
//! ordinary archive that it accepted before the host upgraded.
//!
//! Only the exact empty shape is dropped. A box whose `add`/`drop` carries
//! anything — including a privileged box's persisted `add:["ALL"]` — keeps
//! its `capabilities` key untouched; that's a real, meaningful policy, not
//! an artifact of the old always-present field.

use std::path::Path;

use rusqlite::Connection;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Migration, db_err};

pub(crate) struct DropAmbiguousEmptyCapabilities;

impl Migration for DropAmbiguousEmptyCapabilities {
    fn source_version(&self) -> i32 {
        9
    }

    fn target_version(&self) -> i32 {
        10
    }

    fn description(&self) -> &str {
        "Drop the now-ambiguous empty capability policy from legacy box configs"
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
                    "parse box_config {id} while migrating capability policy: {error}"
                ))
            })?;

            let Some(advanced) = config.pointer_mut("/options/advanced") else {
                continue;
            };
            let Some(advanced_obj) = advanced.as_object_mut() else {
                continue;
            };
            let is_empty_policy = advanced_obj
                .get("capabilities")
                .and_then(|c| c.as_object())
                .is_some_and(|c| {
                    c.get("add")
                        .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
                        && c.get("drop")
                            .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
                });
            if !is_empty_policy {
                continue;
            }
            advanced_obj.remove("capabilities");

            let json = serde_json::to_string(&config).map_err(|error| {
                BoxliteError::Database(format!(
                    "serialize box_config {id} while migrating capability policy: {error}"
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
                "Cleared ambiguous empty capability policy on legacy box configs"
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
    fn drops_the_legacy_always_present_empty_policy() {
        let conn = open_with_box_config(&[(
            "ordinary",
            r#"{"options":{"advanced":{"capabilities":{"add":[],"drop":[]},"privileged":false}}}"#,
        )]);

        DropAmbiguousEmptyCapabilities.run(&conn, None).unwrap();

        let value = load_json(&conn, "ordinary");
        assert!(value.pointer("/options/advanced/capabilities").is_none());
    }

    #[test]
    fn keeps_a_real_non_empty_policy_untouched() {
        let conn = open_with_box_config(&[(
            "customized",
            r#"{"options":{"advanced":{"capabilities":{"add":["SYS_ADMIN"],"drop":[]},"privileged":false}}}"#,
        )]);

        DropAmbiguousEmptyCapabilities.run(&conn, None).unwrap();

        let value = load_json(&conn, "customized");
        assert_eq!(
            value.pointer("/options/advanced/capabilities/add"),
            Some(&serde_json::json!(["SYS_ADMIN"]))
        );
    }

    #[test]
    fn keeps_a_legacy_privileged_boxs_all_shape_untouched() {
        // An old build mutated `capabilities` to `add:["ALL"]` when privileged
        // was enabled — that's a real, meaningful policy (handled by
        // `is_privileged_capability_shape`), not the ambiguous empty case.
        let conn = open_with_box_config(&[(
            "legacy_privileged",
            r#"{"options":{"advanced":{"capabilities":{"add":["ALL"],"drop":[]},"privileged":true}}}"#,
        )]);

        DropAmbiguousEmptyCapabilities.run(&conn, None).unwrap();

        let value = load_json(&conn, "legacy_privileged");
        assert_eq!(
            value.pointer("/options/advanced/capabilities/add"),
            Some(&serde_json::json!(["ALL"]))
        );
    }

    #[test]
    fn leaves_a_config_with_no_advanced_section_alone() {
        let conn = open_with_box_config(&[("bare", r#"{"options":{}}"#)]);

        // Must not error when there's nothing to migrate.
        DropAmbiguousEmptyCapabilities.run(&conn, None).unwrap();

        let value = load_json(&conn, "bare");
        assert!(value.pointer("/options/advanced").is_none());
    }
}

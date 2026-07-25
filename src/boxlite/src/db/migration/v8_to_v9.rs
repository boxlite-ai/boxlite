//! Migration v8 → v9: preserve legacy published-port behavior.
//!
//! Before v9, `host_port: null` meant "use the guest port". In v9 it means
//! "let the OS select an available port", so persisted mappings must be made
//! explicit before the new interpretation is used.

use std::path::Path;

use rusqlite::Connection;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::{Migration, db_err};
use crate::runtime::options::{PortSpec, normalize_legacy_ports};
use crate::util::{PidFileReader, ProcessIdentity};

pub(crate) struct PreservePublishedPorts;

impl Migration for PreservePublishedPorts {
    fn source_version(&self) -> i32 {
        8
    }

    fn target_version(&self) -> i32 {
        9
    }

    fn description(&self) -> &str {
        "Preserve legacy published-port behavior"
    }

    fn run(&self, conn: &Connection, home_dir: Option<&Path>) -> BoxliteResult<()> {
        ensure_no_live_legacy_shims(home_dir)?;

        let configs = {
            let mut statement = db_err!(conn.prepare("SELECT id, json FROM box_config"))?;
            let rows = db_err!(statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }))?;
            db_err!(rows.collect::<Result<Vec<_>, _>>())?
        };

        let mut updates = Vec::new();
        let mut totals = crate::runtime::options::LegacyPortNormalization::default();

        for (id, json) in configs {
            let mut config: serde_json::Value = serde_json::from_str(&json).map_err(|error| {
                BoxliteError::Database(format!(
                    "parse box_config {id} while migrating published ports: {error}"
                ))
            })?;
            let Some(ports_value) = config.pointer_mut("/options/ports") else {
                continue;
            };
            let mut ports: Vec<PortSpec> =
                serde_json::from_value(ports_value.clone()).map_err(|error| {
                    BoxliteError::Database(format!(
                        "parse box_config {id} options.ports while migrating: {error}"
                    ))
                })?;
            let report = normalize_legacy_ports(&mut ports);
            totals.same_port_defaults += report.same_port_defaults;
            totals.udp_coercions += report.udp_coercions;
            totals.discarded_host_ips += report.discarded_host_ips;
            totals.duplicate_host_ports += report.duplicate_host_ports;
            *ports_value = serde_json::to_value(ports).map_err(|error| {
                BoxliteError::Database(format!(
                    "serialize box_config {id} options.ports while migrating: {error}"
                ))
            })?;
            let json = serde_json::to_string(&config).map_err(|error| {
                BoxliteError::Database(format!(
                    "serialize box_config {id} while migrating published ports: {error}"
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

        if totals.same_port_defaults
            + totals.udp_coercions
            + totals.discarded_host_ips
            + totals.duplicate_host_ports
            > 0
        {
            tracing::warn!(
                boxes = updates.len(),
                same_port_defaults = totals.same_port_defaults,
                udp_coercions = totals.udp_coercions,
                discarded_host_ips = totals.discarded_host_ips,
                duplicate_host_ports = totals.duplicate_host_ports,
                "Canonicalized legacy published-port configuration"
            );
        }

        Ok(())
    }
}

fn ensure_no_live_legacy_shims(home_dir: Option<&Path>) -> BoxliteResult<()> {
    let Some(home_dir) = home_dir else {
        return Ok(());
    };
    let boxes_dir = home_dir.join(crate::runtime::layout::dirs::BOXES_DIR);
    let entries = match std::fs::read_dir(&boxes_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(BoxliteError::Storage(format!(
                "scan {} before published-port migration: {error}",
                boxes_dir.display()
            )));
        }
    };

    let mut live = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            BoxliteError::Storage(format!(
                "scan {} before published-port migration: {error}",
                boxes_dir.display()
            ))
        })?;
        let pid_path = entry
            .path()
            .join(crate::runtime::layout::dirs::SHIM_PID_FILE);
        let pid = match PidFileReader::at(pid_path).process_identity() {
            ProcessIdentity::Verified(pid) | ProcessIdentity::Legacy(pid) => pid,
            ProcessIdentity::Absent => continue,
        };
        live.push(format!(
            "{} (pid {pid})",
            entry.file_name().to_string_lossy()
        ));
    }

    if live.is_empty() {
        return Ok(());
    }

    Err(BoxliteError::Database(format!(
        "cannot migrate published-port behavior while a running box uses the previous runtime: {}. \
         Stop these boxes with the previous BoxLite version, then retry",
        live.join(", ")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_requires_legacy_shims_to_be_stopped() {
        let home = tempfile::tempdir().unwrap();
        let box_dir = home.path().join("boxes/box1");
        std::fs::create_dir_all(&box_dir).unwrap();
        std::fs::write(
            box_dir.join("shim.pid"),
            format!("{}\n", std::process::id()),
        )
        .unwrap();

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

        let error = PreservePublishedPorts
            .run(&conn, Some(home.path()))
            .unwrap_err();
        assert!(error.to_string().contains("running box"));
        assert!(error.to_string().contains("box1"));
    }

    #[test]
    fn migration_makes_old_same_port_default_explicit() {
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
        conn.execute(
            "INSERT INTO box_config (id, name, created_at, json) VALUES (?1, NULL, 0, ?2)",
            rusqlite::params![
                "box1",
                r#"{"options":{"ports":[{"host_port":null,"guest_port":3000,"protocol":"Tcp","host_ip":null}]}}"#
            ],
        )
        .unwrap();

        PreservePublishedPorts.run(&conn, None).unwrap();

        let json: String = conn
            .query_row("SELECT json FROM box_config WHERE id = 'box1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value.pointer("/options/ports/0/host_port"),
            Some(&serde_json::json!(3000))
        );
    }
}

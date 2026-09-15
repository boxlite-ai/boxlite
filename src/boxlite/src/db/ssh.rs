//! SQLite persistence for SSH configuration and host identity.

use boxlite_shared::ssh::ssh_key::{LineEnding, PrivateKey, private::Ed25519Keypair};
use boxlite_shared::{BoxliteError, BoxliteResult};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use super::{Database, db_err};
use crate::runtime::ssh::SshConfig;

#[derive(Clone)]
pub(crate) struct SshConfigStore {
    db: Database,
}

impl SshConfigStore {
    pub(crate) fn new(db: Database) -> Self {
        Self { db }
    }

    pub(crate) fn load(&self, box_id: &str) -> BoxliteResult<Option<SshConfig>> {
        Self::load_config(&self.db.conn(), box_id)
    }

    pub(crate) fn save(&self, box_id: &str, mut config: SshConfig) -> BoxliteResult<SshConfig> {
        #[cfg(test)]
        let _completed = crate::runtime::ssh::tests::pause_io(box_id, "save");
        config.validate()?;
        let mut conn = self.db.conn();
        // Keep identity selection and the update together, including across connections.
        let transaction = db_err!(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
        if config.host_private_key.is_none() {
            config.host_private_key =
                Self::load_config(&transaction, box_id)?.and_then(|saved| saved.host_private_key);
        }
        if config.host_private_key.is_none() {
            let key = PrivateKey::from(Ed25519Keypair::from_seed(&rand::random()));
            config.host_private_key = Some(
                key.to_openssh(LineEnding::LF)
                    .map_err(|error| {
                        BoxliteError::Internal(format!("encode SSH host key: {error}"))
                    })?
                    .to_string(),
            );
        }
        let json = serde_json::to_string(&config).map_err(|_| {
            BoxliteError::Config(format!("encode SSH configuration for box {box_id}"))
        })?;
        db_err!(transaction.execute(
            "INSERT INTO ssh_config (box_id, json) VALUES (?1, ?2)
             ON CONFLICT(box_id) DO UPDATE SET json = excluded.json",
            params![box_id, json],
        ))?;
        db_err!(transaction.commit())?;
        Ok(config)
    }

    fn load_config(conn: &Connection, box_id: &str) -> BoxliteResult<Option<SshConfig>> {
        let json: Option<String> = db_err!(
            conn.query_row(
                "SELECT json FROM ssh_config WHERE box_id = ?1",
                [box_id],
                |row| row.get(0),
            )
            .optional()
        )?;
        json.map(|json| {
            // Serde's messages may quote private input misplaced in another field.
            let config: SshConfig = serde_json::from_str(&json).map_err(|error| {
                BoxliteError::Config(format!(
                    "invalid SSH configuration for box {box_id}: {:?} error at line {}, column {}",
                    error.classify(),
                    error.line(),
                    error.column()
                ))
            })?;
            config.validate().map_err(|error| {
                BoxliteError::Config(format!(
                    "invalid SSH configuration for box {box_id}: {error}"
                ))
            })?;
            Ok(config)
        })
        .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SshAuth;

    fn fixture() -> (tempfile::TempDir, Database, SshConfigStore) {
        let home = tempfile::tempdir().unwrap();
        let db = Database::open(&home.path().join("db/boxlite.db")).unwrap();
        db.conn()
            .execute(
                "INSERT INTO box_config (id, created_at, json) VALUES ('box', 0, '{}')",
                [],
            )
            .unwrap();
        let store = SshConfigStore::new(db.clone());
        (home, db, store)
    }

    fn config() -> SshConfig {
        SshConfig {
            enabled: true,
            tcp_listen_address: Some("127.0.0.1:0".parse().unwrap()),
            host_private_key: None,
            auth: SshAuth::NoAuth,
        }
    }

    fn json(db: &Database) -> String {
        db.conn()
            .query_row(
                "SELECT json FROM ssh_config WHERE box_id = 'box'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn ssh_config_round_trip_identity_and_optional_tcp() {
        let (_home, _db, store) = fixture();
        assert!(store.load("box").unwrap().is_none());
        let saved = store.save("box", config()).unwrap();
        assert!(saved.host_private_key.is_some());
        let mut changed = config();
        changed.enabled = false;
        changed.tcp_listen_address = None;
        let changed = store.save("box", changed).unwrap();
        assert_eq!(changed.host_private_key, saved.host_private_key);
        let loaded = store.load("box").unwrap().unwrap();
        assert!(!loaded.enabled);
        assert_eq!(loaded.tcp_listen_address, changed.tcp_listen_address);
        let replacement = PrivateKey::from(Ed25519Keypair::from_seed(&rand::random()))
            .to_openssh(LineEnding::LF)
            .unwrap()
            .to_string();
        let mut changed = config();
        changed.host_private_key = Some(replacement.clone());
        store.save("box", changed).unwrap();
        assert_eq!(
            store.load("box").unwrap().unwrap().host_private_key,
            Some(replacement)
        );
        assert_ne!(
            store.load("box").unwrap().unwrap().host_private_key,
            saved.host_private_key
        );
    }

    #[test]
    fn ssh_config_write_failures_roll_back_without_losing_identity() {
        let (_home, db, store) = fixture();
        store.save("box", config()).unwrap();
        let before = json(&db);
        // AFTER UPDATE proves rollback of a write that already changed the row.
        db.conn().execute_batch("CREATE TRIGGER fail_ssh AFTER UPDATE ON ssh_config BEGIN SELECT RAISE(ABORT, 'injected SQLite write failure'); END;").unwrap();
        let mut changed = config();
        changed.enabled = false;
        assert!(matches!(
            store.save("box", changed),
            Err(BoxliteError::Database(_))
        ));
        assert_eq!(json(&db), before);
        db.conn()
            .execute_batch("DROP TRIGGER fail_ssh; PRAGMA query_only=ON;")
            .unwrap();
        assert!(store.save("box", config()).is_err());
        assert_eq!(json(&db), before);
        db.conn().execute_batch("PRAGMA query_only=OFF").unwrap();
        store.save("box", config()).unwrap();
        assert_eq!(json(&db), before);
    }

    #[test]
    fn ssh_config_foreign_key_and_cascade_prevent_orphan_identity() {
        let (_home, db, store) = fixture();
        assert!(store.save("missing", config()).is_err());
        store.save("box", config()).unwrap();
        super::super::BoxStore::new(db).delete("box").unwrap();
        assert!(store.load("box").unwrap().is_none());
    }

    #[test]
    fn ssh_save_and_delete_commit_orders_leave_no_orphan_identity() {
        use std::sync::mpsc;
        use std::time::Duration;

        for save_first in [true, false] {
            let (home, db, store) = fixture();
            let deleting_db = Database::open(&home.path().join("db/boxlite.db")).unwrap();
            let saving_store = store.clone();
            let (save_release, save_wait) = mpsc::channel();
            let (delete_release, delete_wait) = mpsc::channel();
            let (saved, save_result) = mpsc::channel();
            let (deleted, delete_result) = mpsc::channel();
            let saving = std::thread::spawn(move || {
                save_wait.recv_timeout(Duration::from_secs(10)).unwrap();
                saved.send(saving_store.save("box", config())).unwrap();
            });
            let deleting = std::thread::spawn(move || {
                delete_wait.recv_timeout(Duration::from_secs(10)).unwrap();
                deleted
                    .send(super::super::BoxStore::new(deleting_db).delete("box"))
                    .unwrap();
            });
            if save_first {
                save_release.send(()).unwrap();
                assert!(
                    save_result
                        .recv_timeout(Duration::from_secs(10))
                        .unwrap()
                        .unwrap()
                        .host_private_key
                        .is_some()
                );
                delete_release.send(()).unwrap();
                delete_result
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap()
                    .unwrap();
            } else {
                delete_release.send(()).unwrap();
                delete_result
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap()
                    .unwrap();
                save_release.send(()).unwrap();
                let error = save_result
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap()
                    .unwrap_err();
                assert!(matches!(error, BoxliteError::Database(_)));
                assert!(
                    error.to_string().contains("FOREIGN KEY constraint failed"),
                    "{error}"
                );
            }
            saving.join().unwrap();
            deleting.join().unwrap();
            assert!(store.load("box").unwrap().is_none());
            let remaining: i64 = db
                .conn()
                .query_row("SELECT COUNT(*) FROM box_config", [], |row| row.get(0))
                .unwrap();
            assert_eq!(remaining, 0);
        }
    }

    #[test]
    fn ssh_config_corrupt_json_and_validation_errors_do_not_expose_private_input() {
        let (_home, db, store) = fixture();
        let saved = store.save("box", config()).unwrap();
        let private = saved.host_private_key.as_ref().unwrap();
        let mut value = serde_json::to_value(&saved).unwrap();
        value["auth"]["type"] = serde_json::json!(private);
        for corrupt in [
            "{corrupt".to_owned(),
            serde_json::to_string(&value).unwrap(),
        ] {
            db.conn()
                .execute(
                    "UPDATE ssh_config SET json = ?1 WHERE box_id = 'box'",
                    [&corrupt],
                )
                .unwrap();
            for error in [
                store.load("box").unwrap_err(),
                store.save("box", config()).unwrap_err(),
            ] {
                assert!(error.to_string().contains("invalid SSH configuration"));
                assert!(!error.to_string().contains("PRIVATE KEY"));
                assert!(!error.to_string().contains(private));
            }
            assert_eq!(json(&db), corrupt);
        }
    }

    #[test]
    fn ssh_config_invalid_update_leaves_saved_value_unchanged() {
        let (_home, db, store) = fixture();
        store.save("box", config()).unwrap();
        let before = json(&db);
        let mut invalid = config();
        invalid.host_private_key = Some("invalid private key".into());
        assert!(store.save("box", invalid).is_err());
        assert_eq!(json(&db), before);
    }
}

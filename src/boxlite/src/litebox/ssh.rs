//! Local SSH facade. Handles follow the box ID across stopped VM instances.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use boxlite_shared::{BoxliteError, BoxliteResult};

use super::box_impl::BoxImpl;
use crate::BoxID;
use crate::runtime::backend::BoxBackend;
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::runtime::ssh::{SshApplyResult, SshConfig, SshCoordinator, SshStatus};

/// Persist and apply SSH settings through a local runtime.
///
/// Configuration replaces the entire configuration. Every successful live
/// update disconnects all SSH clients. A stopped box is never booted here.
#[derive(Clone)]
pub struct SshHandle {
    local: Option<(SharedRuntimeImpl, BoxID)>,
}

impl std::fmt::Debug for SshHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshHandle")
            .field("box_id", &self.local.as_ref().map(|(_, id)| id))
            .finish()
    }
}

impl SshHandle {
    pub(crate) fn new(backend: Arc<dyn BoxBackend>) -> Self {
        Self {
            local: backend
                .as_any_arc()
                .downcast::<BoxImpl>()
                .ok()
                .map(|backend| (backend.runtime.clone(), backend.config.id.clone())),
        }
    }

    /// Read the saved configuration, including the full private host key.
    pub async fn config(&self) -> BoxliteResult<Option<SshConfig>> {
        let (runtime, id) = self.local()?;
        let lock = runtime.ssh_locks.get(id);
        let _guard = lock.updates.lock().await;
        self.current().await?;
        runtime.ssh_store(id).load().await
    }

    /// Save a complete configuration, then apply it if the guest is running.
    ///
    /// Omit the private key to reuse the saved key or generate the first one.
    /// If applying fails, the error explicitly reports that the new configuration was
    /// saved. It remains the configuration for the next boot; no rollback or
    /// background retry is performed.
    pub async fn configure(&self, config: SshConfig) -> BoxliteResult<SshApplyResult> {
        let (runtime, id) = self.local()?;
        let lock = runtime.ssh_locks.get(id);
        let _guard = lock.updates.lock().await;
        let current = self.current().await?;
        if config.enabled
            && config.tcp_listen_address.is_some()
            && !current.config.options.advanced.security.network_enabled
        {
            return Err(BoxliteError::InvalidArgument(
                "TCP SSH requires security.network_enabled=true".into(),
            ));
        }
        let store = runtime.ssh_store(id);
        let saved = store.save(config).await?;
        let Some(session) = current.ssh_session() else {
            return Ok(SshApplyResult::Saved);
        };
        let sockets = current.config.sockets();
        let apply = store.apply(&sockets, &session, saved);
        let status = tokio::time::timeout(Duration::from_secs(30), apply)
            .await
            .map_err(|_| BoxliteError::Rpc("SSH application timed out after 30 seconds".into()))
            .and_then(|result| result)
            .map_err(|error| {
                BoxliteError::Rpc(format!(
                    "SSH configuration for box {id} was saved, but application failed or was not confirmed: {error}"
                ))
            })?;
        Ok(SshApplyResult::Applied(status))
    }

    /// Query the shim and guest listener state; `None` means the box is stopped.
    pub async fn status(&self) -> BoxliteResult<Option<SshStatus>> {
        let (runtime, id) = self.local()?;
        tokio::time::timeout(Duration::from_secs(30), async {
            let lock = runtime.ssh_locks.get(id);
            let _guard = lock.updates.lock().await;
            let current = self.current().await?;
            let Some(session) = current.ssh_session() else {
                return Ok(None);
            };
            runtime
                .ssh_store(id)
                .status(&current.config.sockets(), &session)
                .await
                .map(Some)
        })
        .await
        .map_err(|_| {
            BoxliteError::Rpc(format!(
                "SSH status for box {id} timed out after 30 seconds"
            ))
        })?
    }

    fn local(&self) -> BoxliteResult<&(SharedRuntimeImpl, BoxID)> {
        self.local.as_ref().ok_or_else(|| {
            BoxliteError::Unsupported("SSH configuration requires the local Rust runtime".into())
        })
    }

    async fn current(&self) -> BoxliteResult<Arc<BoxImpl>> {
        let (runtime, id) = self.local()?;
        // Deletion can leave a previously resolved handle in the cache. Check
        // the record while the caller holds the shared lifecycle lock.
        let runtime_owned = runtime.clone();
        let id_owned = id.clone();
        runtime
            .ssh_store(id)
            .with_io("resolve configuration", move |_| {
                if !runtime_owned.box_manager.has_box(&id_owned)? {
                    return Err(BoxliteError::NotFound(format!(
                        "SSH configuration for box {id_owned}"
                    )));
                }
                Ok(())
            })
            .await?;
        let current = runtime
            .get(id.as_str())
            .await?
            .ok_or_else(|| BoxliteError::NotFound(format!("SSH configuration for box {id}")))?;
        current
            .box_backend
            .as_any_arc()
            .downcast::<BoxImpl>()
            .map_err(|_| BoxliteError::Internal(format!("local box {id} has a non-local backend")))
    }
}

/// Weak entries retain coordination while any operation is using the lock.
/// Entries with no remaining owners can be pruned without splitting a lock.
#[derive(Default)]
pub(crate) struct SshLocks(Mutex<HashMap<BoxID, Weak<SshCoordinator>>>);

impl SshLocks {
    pub(crate) fn get(&self, id: &BoxID) -> Arc<SshCoordinator> {
        let mut locks = self.0.lock().unwrap();
        if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
            return lock;
        }
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = Arc::new(SshCoordinator::default());
        locks.insert(id.clone(), Arc::downgrade(&lock));
        lock
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::rt_impl::RuntimeImpl;
    use crate::{BoxOptions, BoxStatus, BoxliteOptions, SshAuth};

    fn config() -> SshConfig {
        SshConfig {
            enabled: true,
            tcp_listen_address: Some("127.0.0.1:2222".parse().unwrap()),
            host_private_key: None,
            auth: SshAuth::NoAuth,
        }
    }

    fn runtime(home: &std::path::Path) -> SharedRuntimeImpl {
        RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.to_owned(),
            image_registries: vec![],
        })
        .unwrap()
    }

    fn box_options() -> BoxOptions {
        BoxOptions {
            auto_delete: Some(0),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn ssh_sqlite_does_not_create_legacy_files() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = runtime(home.path());
        let litebox = runtime.create(box_options(), None).await.unwrap();
        litebox.ssh().configure(config()).await.unwrap();
        let box_home = runtime.layout.boxes_dir().join(litebox.id().as_str());
        assert!(
            !box_home.join("ssh").exists(),
            "SSH save created the legacy directory"
        );
    }

    #[tokio::test]
    async fn ssh_sqlite_ignores_legacy_config_and_identity() {
        use boxlite_shared::ssh::ssh_key::{LineEnding, PrivateKey, private::Ed25519Keypair};
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = runtime(home.path());
        let litebox = runtime.create(box_options(), None).await.unwrap();
        let legacy = runtime
            .layout
            .boxes_dir()
            .join(litebox.id().as_str())
            .join("ssh");
        std::fs::create_dir_all(&legacy).unwrap();
        let mut legacy_config = config();
        legacy_config.host_private_key = Some(
            PrivateKey::from(Ed25519Keypair::from_seed(&rand::random()))
                .to_openssh(LineEnding::LF)
                .unwrap()
                .to_string(),
        );
        std::fs::write(
            legacy.join("config.json"),
            serde_json::to_vec(&legacy_config).unwrap(),
        )
        .unwrap();
        assert!(
            litebox.ssh().config().await.unwrap().is_none(),
            "SSH loaded a legacy file"
        );
        std::fs::write(legacy.join("listener.json"), b"incompatible legacy record").unwrap();
        litebox.ssh().configure(config()).await.unwrap();
        let saved = litebox.ssh().config().await.unwrap().unwrap();
        assert!(saved.host_private_key != legacy_config.host_private_key);
        litebox.stop().await.unwrap();
        assert_eq!(
            std::fs::read(legacy.join("listener.json")).unwrap(),
            b"incompatible legacy record"
        );
    }

    #[tokio::test]
    async fn ssh_offline_configuration_survives_runtime_reopen_without_booting() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = runtime(home.path());
        let litebox = runtime.create(box_options(), None).await.unwrap();
        let id = litebox.id().clone();
        let ssh = litebox.ssh();
        assert!(ssh.config().await.unwrap().is_none());
        assert!(ssh.status().await.unwrap().is_none());
        assert!(matches!(
            ssh.configure(config()).await.unwrap(),
            SshApplyResult::Saved
        ));
        let saved = ssh.config().await.unwrap().unwrap();
        let info = litebox.info().await.unwrap();
        assert_eq!(info.status, BoxStatus::Configured);
        assert!(info.pid.is_none());
        assert!(saved.host_private_key.is_some());
        let stored_box = runtime.box_manager.box_by_id(&id).unwrap().unwrap().0;
        let json = serde_json::to_value(&stored_box.options).unwrap();
        assert!(json.get("ssh").is_none());
        assert!(
            !serde_json::to_string(&stored_box)
                .unwrap()
                .contains("PRIVATE KEY")
        );
        drop(ssh);
        drop(litebox);
        drop(runtime);

        let reopened = self::runtime(home.path());
        let litebox = reopened.get(id.as_str()).await.unwrap().unwrap();
        assert_eq!(
            litebox
                .ssh()
                .config()
                .await
                .unwrap()
                .unwrap()
                .host_private_key,
            saved.host_private_key
        );
        assert!(litebox.ssh().status().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn ssh_running_and_paused_rpc_failure_reports_saved_configuration() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = runtime(home.path());
        let litebox = runtime.create(box_options(), None).await.unwrap();
        let ssh = litebox.ssh();
        let current = ssh.current().await.unwrap();
        for status in [BoxStatus::Running, BoxStatus::Paused] {
            current.state.write().status = status;
            let mut updated = config();
            updated.tcp_listen_address = Some(
                if status == BoxStatus::Paused {
                    "127.0.0.1:2223"
                } else {
                    "127.0.0.1:2222"
                }
                .parse()
                .unwrap(),
            );
            let error = ssh.configure(updated.clone()).await.unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("was saved, but application failed or was not confirmed"),
                "{error}"
            );
            assert_eq!(
                ssh.config().await.unwrap().unwrap().tcp_listen_address,
                updated.tcp_listen_address
            );
            assert!(ssh.status().await.is_err());
        }
        current.state.write().status = BoxStatus::Configured;
    }

    #[tokio::test]
    async fn ssh_old_handle_resolves_replacement_and_shares_its_lock() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = runtime(home.path());
        let litebox = runtime.create(box_options(), None).await.unwrap();
        let ssh = litebox.ssh();
        let old = ssh.current().await.unwrap();
        litebox.stop().await.unwrap();
        let replacement = runtime.get(litebox.id().as_str()).await.unwrap().unwrap();
        let current = replacement.ssh().current().await.unwrap();
        assert!(!Arc::ptr_eq(&old, &current));
        assert!(Arc::ptr_eq(&ssh.current().await.unwrap(), &current));

        let lock = runtime.ssh_locks.get(litebox.id());
        let guard = lock.updates.lock().await;
        let mut pending = Box::pin(ssh.configure(config()));
        assert!(futures::poll!(&mut pending).is_pending());
        assert!(
            runtime
                .ssh_config_store
                .load(litebox.id().as_str())
                .unwrap()
                .is_none()
        );
        current.state.write().status = BoxStatus::Paused;
        drop(guard);
        let error = pending.await.unwrap_err();
        assert!(error.to_string().contains("was saved"));
        current.state.write().status = BoxStatus::Configured;
    }

    #[tokio::test]
    async fn ssh_start_queued_behind_stop_rejects_the_spent_handle() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = runtime(home.path());
        let litebox = runtime.create(box_options(), None).await.unwrap();
        let lock = runtime.ssh_locks.get(litebox.id());
        let guard = lock.updates.lock().await;
        let mut stop = Box::pin(litebox.stop());
        assert!(futures::poll!(&mut stop).is_pending());
        let mut start = Box::pin(litebox.start());
        assert!(futures::poll!(&mut start).is_pending());
        drop(guard);
        stop.await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), start).await;
        assert!(
            matches!(result, Ok(Err(BoxliteError::Stopped(_)))),
            "queued start must reject a handle invalidated by stop before boot; got {result:?}"
        );
    }

    #[tokio::test]
    async fn ssh_stale_cache_cannot_access_a_deleted_database_record() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = runtime(home.path());
        let litebox = runtime.create(box_options(), None).await.unwrap();
        let ssh = litebox.ssh();
        let current = ssh.current().await.unwrap();
        // A lookup that read before deletion can leave a cached BoxImpl after
        // the record disappears. SSH must validate existence under its lock.
        runtime.box_manager.remove_box(litebox.id()).unwrap();

        assert!(matches!(
            ssh.configure(config()).await,
            Err(BoxliteError::NotFound(_))
        ));
        assert!(matches!(ssh.config().await, Err(BoxliteError::NotFound(_))));
        assert!(matches!(ssh.status().await, Err(BoxliteError::NotFound(_))));
        assert!(!current.config.box_home.exists());
    }

    #[tokio::test]
    async fn ssh_network_validation_and_storage_failure_precede_application() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = runtime(home.path());
        let mut options = BoxOptions {
            network: crate::NetworkSpec::Disabled,
            ..Default::default()
        };
        options.advanced.security.network_enabled = false;
        let litebox = runtime.create(options, None).await.unwrap();
        let ssh = litebox.ssh();
        let current = ssh.current().await.unwrap();
        let error = ssh.configure(config()).await.unwrap_err();
        assert!(error.to_string().contains("security.network_enabled"));
        assert!(ssh.config().await.unwrap().is_none());
        let mut disabled = config();
        disabled.enabled = false;
        assert!(matches!(
            ssh.configure(disabled.clone()).await.unwrap(),
            SshApplyResult::Saved
        ));
        runtime
            .box_manager
            .db()
            .conn()
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        current.state.write().status = BoxStatus::Running;
        let error = ssh.configure(disabled).await.unwrap_err();
        assert!(matches!(error, BoxliteError::Database(_)), "{error}");
        assert!(!error.to_string().contains("was saved"));
        runtime
            .box_manager
            .db()
            .conn()
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        current.state.write().status = BoxStatus::Configured;
    }
    #[tokio::test]
    async fn ssh_status_timeout_includes_lifecycle_lock() {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = runtime(home.path());
        let litebox = runtime.create(box_options(), None).await.unwrap();
        let ssh = litebox.ssh();
        let lock = runtime.ssh_locks.get(litebox.id());
        let _guard = lock.updates.lock().await;
        tokio::time::pause();
        let result = tokio::time::timeout(Duration::from_secs(31), ssh.status()).await;
        assert!(
            matches!(result, Ok(Err(BoxliteError::Rpc(ref error))) if error.contains("timed out after 30 seconds")),
            "status did not bound the lifecycle lock wait: {result:?}"
        );
    }
}

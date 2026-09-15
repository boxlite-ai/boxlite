//! Local SSH configuration and per-box host identity preparation.

use boxlite_shared::ssh::ssh_key::HashAlg;
use boxlite_shared::ssh::{SshKeySet, parse_host_key};
use boxlite_shared::{
    BoxliteError, BoxliteResult, SshConfigureRequest, SshKeyAuth, SshNoAuth, ssh_configure_request,
};
use serde::{Deserialize, Serialize};
use std::os::fd::OwnedFd;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use std::net::SocketAddr;

/// Host forwarding address and guest SSH state queried independently.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshStatus {
    pub enabled: bool,
    pub tcp_listen_address: Option<SocketAddr>,
    /// Connectable short path to libkrun’s SSH bridge, only after confirmed enablement.
    pub socket_path: Option<PathBuf>,
    /// Generation reported by the guest SSH service.
    pub generation: u64,
    pub host_key_fingerprint: String,
    pub application: SshApplicationState,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum SshApplicationState {
    #[default]
    Disabled,
    Applying,
    Applied,
    Failed,
}

/// Complete local SSH configuration. Disabling preserves the remaining settings.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SshConfig {
    pub enabled: bool,
    /// Optional TCP entrance in addition to the fixed Unix socket.
    #[serde(default)]
    pub tcp_listen_address: Option<SocketAddr>,
    /// Unencrypted OpenSSH Ed25519 private key, stored in the runtime SQLite database.
    /// Omit to reuse the saved identity, or generate one on first configuration.
    pub host_private_key: Option<String>,
    pub auth: SshAuth,
}

impl std::fmt::Debug for SshConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshConfig")
            .field("enabled", &self.enabled)
            .field("tcp_listen_address", &self.tcp_listen_address)
            .field(
                "host_private_key",
                &self.host_private_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field("auth", &self.auth)
            .finish()
    }
}

/// Whether a configuration was saved for the next boot or confirmed by the guest.
#[derive(Clone, Debug, PartialEq)]
pub enum SshApplyResult {
    Saved,
    Applied(SshStatus),
}

/// `Keys` accepts either a trusted CA certificate or a listed user public key.
/// Only `NoAuth` permits the SSH `none` authentication method.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum SshAuth {
    Keys {
        #[serde(default)]
        ca_public_keys: Vec<String>,
        #[serde(default)]
        public_keys: Vec<String>,
    },
    NoAuth,
}

impl<'de> Deserialize<'de> for SshAuth {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Internally tagged unit variants otherwise ignore extra credentials.
        #[derive(Deserialize)]
        #[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
        enum Auth {
            Keys {
                #[serde(default)]
                ca_public_keys: Vec<String>,
                #[serde(default)]
                public_keys: Vec<String>,
            },
            NoAuth {},
        }
        Ok(match Auth::deserialize(deserializer)? {
            Auth::Keys {
                ca_public_keys,
                public_keys,
            } => Self::Keys {
                ca_public_keys,
                public_keys,
            },
            Auth::NoAuth {} => Self::NoAuth,
        })
    }
}

impl SshConfig {
    pub(crate) fn validate(&self) -> BoxliteResult<()> {
        if let SshAuth::Keys {
            ca_public_keys,
            public_keys,
        } = &self.auth
        {
            SshKeySet::parse(ca_public_keys, public_keys)?;
        }
        if let Some(key) = &self.host_private_key {
            parse_host_key(key)?;
        }
        Ok(())
    }
}

/// Shared for the box ID, including detached blocking work after cancellation.
#[derive(Default)]
pub(crate) struct SshCoordinator {
    pub(crate) updates: Mutex<()>,
    io: Arc<Mutex<()>>,
}

impl SshCoordinator {
    pub(crate) async fn drain_io(&self) {
        let _guard = self.io.lock().await;
    }
}

/// Per-box SSH application and coordinated blocking IO. SQLite owns persistence.
#[derive(Clone)]
pub(crate) struct SshStore {
    coordinator: Arc<SshCoordinator>,
    configs: crate::db::SshConfigStore,
    box_id: String,
}

impl SshStore {
    pub(crate) fn new(
        configs: crate::db::SshConfigStore,
        box_id: &str,
        coordinator: Arc<SshCoordinator>,
    ) -> Self {
        Self {
            coordinator,
            configs,
            box_id: box_id.to_owned(),
        }
    }

    pub(crate) async fn load(&self) -> BoxliteResult<Option<SshConfig>> {
        self.with_io("load", |store| store.configs.load(&store.box_id))
            .await
    }

    pub(crate) async fn save(&self, config: SshConfig) -> BoxliteResult<SshConfig> {
        config.validate()?;
        self.with_io("save", move |store| {
            store.configs.save(&store.box_id, config)
        })
        .await
    }

    /// Explicitly compose forwarding and guest configuration for the public API.
    pub(crate) async fn apply(
        &self,
        sockets: &crate::net::socket_path::BoxSockets,
        session: &crate::portal::GuestSession,
        config: SshConfig,
    ) -> BoxliteResult<SshStatus> {
        let shim = crate::vmm::shim_server::ShimClient::new(sockets);
        shim.set(None).await?;
        let mut guest = session.ssh().await?;
        guest.disable().await?;
        if config.enabled {
            let listener = config
                .tcp_listen_address
                .map(Self::bind_listener)
                .transpose()?;
            let prepared = PreparedSsh::prepare(config, &self.box_id)?;
            guest.configure(prepared).await?;
            shim.set(listener).await?;
        }
        self.status(sockets, session).await
    }

    pub(crate) async fn status(
        &self,
        sockets: &crate::net::socket_path::BoxSockets,
        session: &crate::portal::GuestSession,
    ) -> BoxliteResult<SshStatus> {
        let tcp_listen_address = crate::vmm::shim_server::ShimClient::new(sockets)
            .get_socket_addr()
            .await?;
        let guest = session.ssh().await?.status().await?;
        let socket_path = if guest.enabled {
            use std::os::unix::fs::FileTypeExt;
            let path = sockets.ssh_sock();
            let metadata = tokio::fs::symlink_metadata(&path).await.map_err(|error| {
                BoxliteError::Network(format!(
                    "inspect SSH Unix socket {}: {error}",
                    path.display()
                ))
            })?;
            if !metadata.file_type().is_socket() {
                return Err(BoxliteError::Network(format!(
                    "SSH Unix path {} is not a socket",
                    path.display()
                )));
            }
            Some(path)
        } else {
            None
        };
        Ok(SshStatus {
            enabled: guest.enabled,
            tcp_listen_address,
            socket_path,
            generation: guest.generation,
            host_key_fingerprint: guest.host_key_fingerprint,
            application: if guest.enabled {
                SshApplicationState::Applied
            } else {
                SshApplicationState::Disabled
            },
            error: None,
        })
    }

    /// Bind outside the sandbox and transfer the actual endpoint with the FD.
    fn bind_listener(address: SocketAddr) -> BoxliteResult<(OwnedFd, SocketAddr)> {
        let bind = || -> std::io::Result<_> {
            let socket = if address.is_ipv4() {
                tokio::net::TcpSocket::new_v4()?
            } else {
                tokio::net::TcpSocket::new_v6()?
            };
            // Rebinding a fixed port must also work after old connections close.
            socket.set_reuseaddr(true)?;
            socket.bind(address)?;
            let listener = socket.listen(128)?.into_std()?;
            let actual = listener.local_addr()?;
            Ok((listener.into(), actual))
        };
        bind().map_err(|error| {
            BoxliteError::Network(format!("bind SSH TCP listener {address}: {error}"))
        })
    }

    pub(crate) async fn with_io<T, F>(&self, operation: &'static str, action: F) -> BoxliteResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Self) -> BoxliteResult<T> + Send + 'static,
    {
        let guard = self.coordinator.io.clone().lock_owned().await;
        let store = self.clone();
        // A cancelled caller cannot interrupt spawn_blocking. Keep both the IO
        // guard and coordinator alive until its blocking operation has completed.
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            action(&store)
        })
        .await
        .map_err(|error| BoxliteError::Internal(format!("SSH {operation} task failed: {error}")))?
    }

    #[cfg(test)]
    pub(crate) fn for_test(home: &Path, coordinator: Arc<SshCoordinator>) -> Self {
        let db = crate::db::Database::open(&home.join("db/boxlite.db")).unwrap();
        db.conn().execute(
            "INSERT INTO box_config (id, created_at, json) VALUES ('test-box', 0, '{}') ON CONFLICT(id) DO NOTHING", []
        ).unwrap();
        Self::new(crate::db::SshConfigStore::new(db), "test-box", coordinator)
    }
}

/// A complete request plus the host's expected identity, prepared after persistence.
pub(crate) struct PreparedSsh {
    pub request: SshConfigureRequest,
    pub host_key_fingerprint: String,
}

impl PreparedSsh {
    pub(crate) fn prepare(config: SshConfig, box_id: &str) -> BoxliteResult<Self> {
        config.validate()?;
        let host_private_key = config.host_private_key.ok_or_else(|| {
            BoxliteError::Config(
                "SSH host private key must be saved before applying configuration".into(),
            )
        })?;
        let host_key_fingerprint = parse_host_key(&host_private_key)?
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let auth = match config.auth {
            SshAuth::Keys {
                ca_public_keys,
                public_keys,
            } => ssh_configure_request::Auth::Keys(SshKeyAuth {
                ca_public_keys,
                public_keys,
            }),
            SshAuth::NoAuth => ssh_configure_request::Auth::NoAuth(SshNoAuth {}),
        };
        Ok(Self {
            request: SshConfigureRequest {
                principal: box_id.to_owned(),
                host_private_key,
                auth: Some(auth),
            },
            host_key_fingerprint,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::runtime::backend::RuntimeBackend;
    use crate::runtime::rt_impl::{LocalRuntime, RuntimeImpl};
    use crate::{BoxOptions, BoxliteOptions};
    use boxlite_shared::ssh::ssh_key::{LineEnding, PrivateKey, private::Ed25519Keypair};
    use serde_json::json;

    use std::sync::mpsc;
    use std::time::Duration;
    use tokio::sync::oneshot;

    struct IoPause {
        box_id: String,
        operation: &'static str,
        started: oneshot::Sender<()>,
        release: mpsc::Receiver<()>,
        completed: oneshot::Sender<()>,
    }

    static IO_PAUSES: std::sync::Mutex<Vec<IoPause>> = std::sync::Mutex::new(Vec::new());

    // Pause the real operation before it takes a database lock, so competitors
    // can reach SQLite. Each pause belongs to one box and is consumed once.
    pub(crate) fn pause_io(box_id: &str, operation: &str) -> Option<IoCompletion> {
        let pause = {
            let mut pauses = IO_PAUSES.lock().unwrap();
            let index = pauses
                .iter()
                .position(|pause| pause.box_id == box_id && pause.operation == operation)?;
            pauses.remove(index)
        };
        let _ = pause.started.send(());
        pause.release.recv_timeout(Duration::from_secs(10)).unwrap();
        Some(IoCompletion(Some(pause.completed)))
    }

    pub(crate) struct IoCompletion(Option<oneshot::Sender<()>>);

    impl Drop for IoCompletion {
        fn drop(&mut self) {
            let _ = self.0.take().unwrap().send(());
        }
    }

    struct PausedIo {
        started: Option<oneshot::Receiver<()>>,
        release: Option<mpsc::Sender<()>>,
        completed: Option<oneshot::Receiver<()>>,
    }

    impl PausedIo {
        fn new(box_id: &str, operation: &'static str) -> Self {
            let (started, started_receiver) = oneshot::channel();
            let (release_sender, release) = mpsc::channel();
            let (completed, completed_receiver) = oneshot::channel();
            IO_PAUSES.lock().unwrap().push(IoPause {
                box_id: box_id.to_owned(),
                operation,
                started,
                release,
                completed,
            });
            Self {
                started: Some(started_receiver),
                release: Some(release_sender),
                completed: Some(completed_receiver),
            }
        }

        async fn wait_started(&mut self) {
            tokio::time::timeout(Duration::from_secs(10), self.started.take().unwrap())
                .await
                .unwrap()
                .unwrap();
        }

        async fn finish(mut self) {
            self.release.take().unwrap().send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(10), self.completed.take().unwrap())
                .await
                .unwrap()
                .unwrap();
        }
    }

    impl Drop for PausedIo {
        fn drop(&mut self) {
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
        }
    }

    async fn runtime_box() -> (tempfile::TempDir, Arc<RuntimeImpl>, crate::LiteBox) {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_owned(),
            image_registries: vec![],
        })
        .unwrap();
        let litebox = runtime
            .create(
                BoxOptions {
                    auto_delete: Some(0),
                    // A regressed start fails locally before any image pull or VM boot.
                    rootfs: crate::RootfsSpec::RootfsPath(
                        home.path().join("missing-rootfs").display().to_string(),
                    ),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        (home, runtime, litebox)
    }

    fn store(box_home: &Path) -> SshStore {
        SshStore::for_test(box_home, Arc::new(SshCoordinator::default()))
    }

    fn key() -> String {
        PrivateKey::from(Ed25519Keypair::from_seed(&rand::random()))
            .to_openssh(LineEnding::LF)
            .unwrap()
            .to_string()
    }

    fn config() -> SshConfig {
        SshConfig {
            enabled: true,
            tcp_listen_address: Some("127.0.0.1:2222".parse().unwrap()),
            host_private_key: None,
            auth: SshAuth::NoAuth,
        }
    }

    #[tokio::test]
    async fn ssh_omitted_tcp_address_round_trips_as_unix_only() {
        let config: SshConfig = serde_json::from_value(json!({
            "enabled": true, "auth": {"type": "no_auth"}
        }))
        .unwrap();
        assert!(config.tcp_listen_address.is_none());
        let home = tempfile::tempdir().unwrap();
        let store = store(home.path());
        store.save(config).await.unwrap();
        let restored = store.load().await.unwrap().unwrap();
        assert!(restored.enabled);
        assert!(restored.tcp_listen_address.is_none());
        assert!(
            serde_json::from_value::<SshConfig>(json!({
                "enabled": true, "listen_address": {"unix": "/tmp/old.sock"},
                "auth": {"type": "no_auth"}
            }))
            .is_err()
        );
    }

    #[test]
    fn ssh_requires_explicit_enabled_and_auth() {
        for value in [
            json!({}),
            json!({"enabled": true, "tcp_listen_address": "127.0.0.1:2222"}),
            json!({"tcp_listen_address": "127.0.0.1:2222", "auth": {"type": "no_auth"}}),
            json!({"enabled": true, "tcp_listen_address": "127.0.0.1:2222", "auth": null}),
            json!({"enabled": true, "tcp_listen_address": "localhost:2222", "auth": {"type": "no_auth"}}),
            json!({"enabled": true, "tcp_listen_address": "127.0.0.1:2222", "auth": {"type": "no_auth", "public_keys": []}}),
            json!({"enabled": true, "tcp_listen_address": "127.0.0.1:2222", "auth": {"type": "none"}}),
        ] {
            assert!(serde_json::from_value::<SshConfig>(value).is_err());
        }
        let restored: SshConfig = serde_json::from_value(json!({
            "enabled": false,
            "tcp_listen_address": "127.0.0.1:2222",
            "auth": {"type": "no_auth"},
        }))
        .unwrap();
        assert!(!restored.enabled);
        assert!(restored.host_private_key.is_none());
        assert!(matches!(restored.auth, SshAuth::NoAuth));
    }

    #[test]
    fn ssh_accepts_dynamic_tcp_port_and_rejects_empty_keys_even_while_disabled() {
        let mut ssh = config();
        ssh.tcp_listen_address = Some("127.0.0.1:0".parse().unwrap());
        ssh.validate().unwrap();
        ssh = config();
        ssh.enabled = false;
        ssh.auth = SshAuth::Keys {
            ca_public_keys: vec![],
            public_keys: vec![],
        };
        assert!(
            ssh.validate()
                .unwrap_err()
                .to_string()
                .contains("at least one")
        );
    }

    #[test]
    fn ssh_keys_accept_either_list_and_reject_every_invalid_entry() {
        let public = parse_host_key(&key())
            .unwrap()
            .public_key()
            .to_openssh()
            .unwrap();
        for (cas, users) in [
            (vec![public.clone()], vec![]),
            (vec![], vec![public.clone()]),
            (vec![public.clone()], vec![public.clone()]),
        ] {
            let mut ssh = config();
            ssh.auth = SshAuth::Keys {
                ca_public_keys: cas.clone(),
                public_keys: users.clone(),
            };
            ssh.validate().unwrap();
            for bad in ["", "not a key"] {
                ssh.auth = SshAuth::Keys {
                    ca_public_keys: [cas.clone(), vec![bad.into()]].concat(),
                    public_keys: users.clone(),
                };
                assert!(ssh.validate().is_err());
                ssh.auth = SshAuth::Keys {
                    ca_public_keys: cas.clone(),
                    public_keys: [users.clone(), vec![bad.into()]].concat(),
                };
                assert!(ssh.validate().is_err());
            }
        }
    }

    #[test]
    fn ssh_rejects_encrypted_or_non_ed25519_host_keys_and_non_ed25519_cas() {
        use russh::keys::{Algorithm, EcdsaCurve};
        let mut rng = russh::keys::key::safe_rng();
        let ecdsa = PrivateKey::random(
            &mut rng,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
        )
        .unwrap();
        let encrypted = parse_host_key(&key())
            .unwrap()
            .encrypt(&mut rng, "test-only-passphrase")
            .unwrap();
        for private in [&ecdsa, &encrypted] {
            let mut ssh = config();
            ssh.host_private_key = Some(private.to_openssh(LineEnding::LF).unwrap().to_string());
            assert!(
                ssh.validate()
                    .unwrap_err()
                    .to_string()
                    .contains("unencrypted OpenSSH Ed25519")
            );
        }
        let public = ecdsa.public_key().to_openssh().unwrap();
        let mut ssh = config();
        ssh.auth = SshAuth::Keys {
            ca_public_keys: vec![public.clone()],
            public_keys: vec![],
        };
        assert!(
            ssh.validate()
                .unwrap_err()
                .to_string()
                .contains("CA public key [0] must use Ed25519")
        );
        ssh.auth = SshAuth::Keys {
            ca_public_keys: vec![],
            public_keys: vec![public],
        };
        ssh.validate().unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ssh_cancelled_save_cannot_overwrite_a_later_successful_configuration() {
        let (_home, runtime, litebox) = runtime_box().await;
        let ssh = litebox.ssh();
        let mut initial = config();
        initial.host_private_key = Some(key());
        let mut pause = PausedIo::new(litebox.id().as_str(), "save");
        let initial_ssh = ssh.clone();
        let caller = tokio::spawn(async move { initial_ssh.configure(initial).await });
        pause.wait_started().await;
        caller.abort();
        // Join after releasing the operation: abort cannot interrupt an inline poll.

        let mut latest = config();
        latest.tcp_listen_address = Some("127.0.0.1:3333".parse().unwrap());
        latest.host_private_key = Some(key());
        let mut saving = Box::pin(ssh.configure(latest.clone()));
        // Give B an opportunity to finish while A is paused. With coordination,
        // B waits; without it, B commits first and A can subsequently overwrite it.
        let early = tokio::time::timeout(Duration::from_secs(1), &mut saving).await;
        let completed_before_a = early.is_ok();
        pause.finish().await;
        let _ = caller.await;
        let result = match early {
            Ok(result) => result,
            Err(_) => tokio::time::timeout(Duration::from_secs(10), saving)
                .await
                .unwrap(),
        };
        assert!(matches!(result.unwrap(), SshApplyResult::Saved));
        let persisted = runtime
            .ssh_config_store
            .load(litebox.id().as_str())
            .unwrap()
            .unwrap();
        assert_eq!(
            persisted.tcp_listen_address, latest.tcp_listen_address,
            "cancelled A overwrote B; B completed while A was paused: {completed_before_a}"
        );
        assert!(
            persisted.host_private_key == latest.host_private_key,
            "cancelled A replaced B's host identity"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ssh_remove_waits_for_configuration_that_already_resolved_the_box() {
        let (_home, runtime, litebox) = runtime_box().await;
        let id = litebox.id();
        let box_home = runtime.layout.boxes_dir().join(id.as_str());
        let ssh = litebox.ssh();
        let mut pause = PausedIo::new(id.as_str(), "save");
        let configuring_ssh = ssh.clone();
        let configuring = tokio::spawn(async move { configuring_ssh.configure(config()).await });
        pause.wait_started().await;
        let coordinator = runtime.ssh_locks.get(id);
        assert!(coordinator.updates.try_lock().is_err());
        let local = LocalRuntime(runtime.clone());
        let mut removing = Box::pin(local.remove(id.as_str(), false));
        assert!(futures::poll!(&mut removing).is_pending());
        pause.finish().await;
        assert!(matches!(
            configuring.await.unwrap().unwrap(),
            SshApplyResult::Saved
        ));
        tokio::time::timeout(Duration::from_secs(10), removing)
            .await
            .unwrap()
            .unwrap();
        assert!(runtime.box_manager.box_by_id(id).unwrap().is_none());
        assert!(
            runtime
                .ssh_config_store
                .load(id.as_str())
                .unwrap()
                .is_none()
        );
        assert!(
            !box_home.exists(),
            "SSH configuration recreated the removed box directory"
        );
        assert!(matches!(
            ssh.configure(config()).await,
            Err(BoxliteError::NotFound(_))
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ssh_remove_leaves_no_identity_after_a_cancelled_background_save() {
        let (_home, runtime, litebox) = runtime_box().await;
        let id = litebox.id();
        let mut pause = PausedIo::new(id.as_str(), "save");
        let ssh = litebox.ssh();
        let caller = tokio::spawn(async move { ssh.configure(config()).await });
        pause.wait_started().await;
        caller.abort();
        // Join after releasing the operation: abort cannot interrupt an inline poll.
        let local = LocalRuntime(runtime.clone());
        let mut removing = Box::pin(local.remove(id.as_str(), false));
        let early = tokio::time::timeout(Duration::from_secs(1), &mut removing).await;
        pause.finish().await;
        let _ = caller.await;
        match early {
            Ok(result) => result.unwrap(),
            Err(_) => tokio::time::timeout(Duration::from_secs(10), removing)
                .await
                .unwrap()
                .unwrap(),
        }
        assert!(runtime.box_manager.box_by_id(id).unwrap().is_none());
        assert!(
            runtime
                .ssh_config_store
                .load(id.as_str())
                .unwrap()
                .is_none(),
            "cancelled SSH save left a private key after removal"
        );
        assert!(!runtime.layout.boxes_dir().join(id.as_str()).exists());
        let error = runtime.ssh_store(id).save(config()).await.unwrap_err();
        assert!(matches!(error, BoxliteError::Database(_)));
        assert!(
            error.to_string().contains("FOREIGN KEY constraint failed"),
            "{error}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ssh_start_waits_for_cancelled_background_removal() {
        let (_home, runtime, litebox) = runtime_box().await;
        let id = litebox.id().clone();
        let box_home = runtime.layout.boxes_dir().join(id.as_str());
        std::fs::create_dir_all(&box_home).unwrap();
        std::fs::write(box_home.join("cleanup-marker"), b"resource to remove").unwrap();
        litebox.ssh().configure(config()).await.unwrap();
        let mut pause = PausedIo::new(id.as_str(), "remove box");
        let local = LocalRuntime(runtime.clone());
        let removing_id = id.clone();
        let caller = tokio::spawn(async move { local.remove(removing_id.as_str(), false).await });
        pause.wait_started().await;
        caller.abort();
        // Join after releasing the operation: abort cannot interrupt an inline poll.
        let mut starting = Box::pin(litebox.start());
        let early = tokio::time::timeout(Duration::from_secs(1), &mut starting).await;
        let started_before_cleanup = early.is_ok();
        pause.finish().await;
        let _ = caller.await;
        let result = match early {
            Ok(result) => result,
            Err(_) => tokio::time::timeout(Duration::from_secs(10), starting)
                .await
                .unwrap(),
        };
        assert!(runtime.box_manager.box_by_id(&id).unwrap().is_none());
        assert!(
            runtime
                .ssh_config_store
                .load(id.as_str())
                .unwrap()
                .is_none()
        );
        assert!(!box_home.exists(), "background removal left box resources");
        assert!(
            matches!(result, Err(BoxliteError::Stopped(_))),
            "start must reject the handle invalidated by removal; finished before cleanup: {started_before_cleanup}; got {result:?}"
        );
    }

    #[tokio::test]
    async fn ssh_config_is_absent_until_first_save() {
        let home = tempfile::tempdir().unwrap();
        assert!(store(home.path()).load().await.unwrap().is_none());
        assert!(!home.path().join("ssh").exists());
    }

    #[tokio::test]
    async fn ssh_generated_key_is_persisted_reused_and_redacted() {
        let home = tempfile::tempdir().unwrap();
        let store = store(home.path());
        let first = store.save(config()).await.unwrap();
        let reused = store.save(config()).await.unwrap();
        let restored = store.load().await.unwrap().unwrap();
        assert_eq!(first.host_private_key, reused.host_private_key);
        assert_eq!(first.host_private_key, restored.host_private_key);
        assert!(!format!("{first:?}").contains("BEGIN OPENSSH PRIVATE KEY"));
        let prepared = PreparedSsh::prepare(first, "box_1").unwrap();
        assert_eq!(prepared.request.principal, "box_1");
        assert_eq!(
            prepared.request.host_private_key,
            restored.host_private_key.unwrap()
        );
        assert!(!format!("{:?}", prepared.request).contains("BEGIN OPENSSH PRIVATE KEY"));
    }

    #[tokio::test]
    async fn ssh_save_replaces_explicit_key_and_preserves_disabled_settings() {
        let home = tempfile::tempdir().unwrap();
        let store = store(home.path());
        let original = store.save(config()).await.unwrap();
        let replacement = key();
        let public = parse_host_key(&replacement)
            .unwrap()
            .public_key()
            .to_openssh()
            .unwrap();
        let mut changed = config();
        changed.enabled = false;
        changed.tcp_listen_address = Some("127.0.0.1:2223".parse().unwrap());
        changed.host_private_key = Some(replacement.clone());
        changed.auth = SshAuth::Keys {
            ca_public_keys: vec![public.clone()],
            public_keys: vec![public.clone()],
        };
        store.save(changed).await.unwrap();
        let restored = store.load().await.unwrap().unwrap();
        assert!(!restored.enabled);
        assert_eq!(
            restored.tcp_listen_address,
            Some("127.0.0.1:2223".parse().unwrap())
        );
        assert_eq!(restored.host_private_key, Some(replacement));
        assert_ne!(restored.host_private_key, original.host_private_key);
        match restored.auth {
            SshAuth::Keys {
                ca_public_keys,
                public_keys,
            } => {
                assert_eq!(ca_public_keys, vec![public.clone()]);
                assert_eq!(public_keys, vec![public]);
            }
            SshAuth::NoAuth => panic!("key authentication was not persisted"),
        }
    }
}

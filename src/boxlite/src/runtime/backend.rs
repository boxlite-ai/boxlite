//! Runtime backend trait — internal abstraction for local vs REST execution.

use std::any::Any;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;

use crate::litebox::copy::CopyOptions;
use crate::litebox::snapshot_mgr::SnapshotInfo;
use crate::litebox::{
    AttachOptions, BoxCommand, BoxTunnel, Execution, LiteBox, SshConfig, SshStatus,
};
use crate::metrics::{BoxMetrics, RuntimeMetrics};
use crate::runtime::options::{
    BoxArchive, BoxOptions, CloneOptions, ExportOptions, InboundNetworkConfig,
    OutboundNetworkConfig, SnapshotOptions,
};
use crate::runtime::types::BoxInfo;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::id::BoxID;

/// Backend abstraction for runtime operations.
///
/// Local backend delegates to `RuntimeImpl` (VM management).
/// REST backend delegates to HTTP API calls.
///
/// This trait is `pub(crate)` — internal implementation detail.
/// The public API (`BoxliteRuntime`) is unchanged.
#[allow(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
pub(crate) trait RuntimeBackend: Send + Sync {
    async fn create(&self, options: BoxOptions, name: Option<String>) -> BoxliteResult<LiteBox>;

    async fn get_or_create(
        &self,
        options: BoxOptions,
        name: Option<String>,
    ) -> BoxliteResult<(LiteBox, bool)>;

    async fn create_with_outbound_policy(
        &self,
        _options: BoxOptions,
        _name: Option<String>,
        _policy: crate::net::CompleteOutboundPolicy,
        _reuse_existing: bool,
    ) -> BoxliteResult<(LiteBox, bool)> {
        Err(BoxliteError::Unsupported(
            "complete outbound creation requires a local runtime".into(),
        ))
    }

    async fn create_with_complete_outbound_policy(
        &self,
        options: BoxOptions,
        name: Option<String>,
        policy: crate::net::CompleteOutboundPolicy,
        reuse_existing: bool,
    ) -> crate::net::OutboundPolicyResult<(LiteBox, bool)> {
        Ok(self
            .create_with_outbound_policy(options, name, policy, reuse_existing)
            .await?)
    }

    async fn prepare_hosted_outbound_create(
        &self,
        _policy: crate::net::CompleteOutboundPolicy,
        _revision: crate::net::OutboundRevision,
    ) -> BoxliteResult<crate::net::PreparedOutboundCreate> {
        Err(BoxliteError::Unsupported(
            "hosted outbound preparation requires a local runtime".into(),
        ))
    }

    async fn get_or_create_with_prepared_outbound(
        &self,
        _options: BoxOptions,
        _name: String,
        _prepared: crate::net::PreparedOutboundCreate,
    ) -> BoxliteResult<(LiteBox, bool)> {
        Err(BoxliteError::Unsupported(
            "prepared outbound creation requires a local runtime".into(),
        ))
    }

    async fn get(&self, id_or_name: &str) -> BoxliteResult<Option<LiteBox>>;

    async fn get_info(&self, id_or_name: &str) -> BoxliteResult<Option<BoxInfo>>;

    async fn list_info(&self) -> BoxliteResult<Vec<BoxInfo>>;

    async fn exists(&self, id_or_name: &str) -> BoxliteResult<bool>;

    async fn metrics(&self) -> BoxliteResult<RuntimeMetrics>;

    async fn remove(&self, id_or_name: &str, force: bool) -> BoxliteResult<()>;

    async fn shutdown(&self, timeout: Option<i32>) -> BoxliteResult<()>;

    async fn import_box(
        &self,
        _archive: BoxArchive,
        _name: Option<String>,
    ) -> BoxliteResult<LiteBox> {
        Err(BoxliteError::Unsupported(
            "This operation is only supported for local runtimes (not REST backends)".to_string(),
        ))
    }

    /// Synchronous shutdown for atexit/Drop contexts.
    /// Default no-op (REST backend doesn't manage local processes).
    fn shutdown_sync(&self) {}
}

/// Backend abstraction for individual box operations.
///
/// Local backend is implemented directly by `BoxImpl`.
/// REST backend delegates to HTTP API calls.
#[allow(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
pub(crate) trait BoxBackend: Send + Sync + Any {
    /// Owned downcast helper (`Arc` upcast), so callers can move the local
    /// backend out of the trait object without borrowing `&self` across an
    /// `await`.
    fn as_any_arc(self: Arc<Self>) -> Arc<dyn Any + Send + Sync>;

    fn id(&self) -> &BoxID;

    fn name(&self) -> Option<&str>;

    /// Return metadata for this box.
    async fn info(&self) -> BoxliteResult<BoxInfo>;

    async fn start(&self) -> BoxliteResult<()>;

    async fn exec(&self, command: BoxCommand) -> BoxliteResult<Execution>;

    async fn list_executions(&self) -> BoxliteResult<Vec<crate::ExecutionInfo>>;

    async fn get_execution(&self, execution_id: &str) -> BoxliteResult<Execution>;

    /// Attach to a session in the box.
    ///
    /// [`AttachOptions::main`] follows the box's main command session (docker
    /// semantics: `run`'s COMMAND is the container init, registered under
    /// execution_id = container id, which the caller cannot name). The
    /// unqualified verb mirrors the ecosystem convention (`ContainerAttach`,
    /// `podman attach`, CRI `Attach`).
    ///
    /// [`AttachOptions::execution`] reattaches to an already-running exec
    /// session (docker's `ContainerExecAttach`): a fresh `Execution` on a new
    /// stream, so the caller discards any prior handle for the same id. Returns
    /// `BoxliteError::SessionReaped` if the server reports it no longer
    /// attachable.
    ///
    /// [`AttachOptions::read_only`] drops stdin. Backends must enforce that
    /// rather than rely on the caller: the returned `Execution` has no stdin
    /// sender, and a backend that talks over a bidirectional transport refuses
    /// writes on it.
    ///
    /// Default is `Unsupported`; both production backends implement existing
    /// session attachment. Output reader conflicts must remain explicit.
    async fn attach(&self, _options: AttachOptions) -> BoxliteResult<Execution> {
        Err(BoxliteError::Unsupported(
            "this backend does not support attaching to sessions".into(),
        ))
    }

    async fn metrics(&self) -> BoxliteResult<BoxMetrics>;

    async fn stop(&self) -> BoxliteResult<()>;

    async fn copy_into(
        &self,
        host_src: &Path,
        container_dst: &str,
        opts: CopyOptions,
    ) -> BoxliteResult<()>;

    async fn copy_out(
        &self,
        container_src: &str,
        host_dst: &Path,
        opts: CopyOptions,
    ) -> BoxliteResult<()>;

    async fn clone_box(
        &self,
        options: CloneOptions,
        name: Option<String>,
    ) -> BoxliteResult<LiteBox>;

    async fn clone_boxes(
        &self,
        options: CloneOptions,
        count: usize,
        names: Vec<String>,
    ) -> BoxliteResult<Vec<LiteBox>>;

    async fn export_box(&self, options: ExportOptions, dest: &Path) -> BoxliteResult<BoxArchive>;

    /// Replace the guest's SSH configuration (see [`crate::litebox::SshHandle`]).
    async fn ssh_configure(&self, config: SshConfig) -> BoxliteResult<SshStatus>;

    /// Enable the saved SSH configuration on an existing VM.
    async fn ssh_enable(&self) -> BoxliteResult<SshStatus> {
        Err(BoxliteError::Unsupported(
            "SSH enable is not supported by this backend".into(),
        ))
    }

    /// Read the guest's SSH state without starting the box.
    async fn ssh_status(&self) -> BoxliteResult<SshStatus>;

    /// Stop the guest's SSH listener without starting the box.
    async fn ssh_disable(&self) -> BoxliteResult<SshStatus>;
}

/// Backend abstraction for box network operations.
///
/// Kept separate from `BoxBackend` so lifecycle/exec/file operations do not own
/// network data-plane capabilities directly.
#[allow(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
pub(crate) trait BoxNetworkBackend: Send + Sync {
    async fn published_ports(
        &self,
    ) -> BoxliteResult<Option<Vec<crate::runtime::types::PublishedPort>>> {
        Err(BoxliteError::Unsupported(
            "this backend does not support reading published ports".into(),
        ))
    }

    async fn complete_outbound_snapshot(
        &self,
    ) -> BoxliteResult<crate::net::CompleteOutboundSnapshot> {
        Err(BoxliteError::Unsupported(
            "this backend does not support complete outbound policies".into(),
        ))
    }

    async fn complete_outbound_status(&self) -> BoxliteResult<crate::net::CompleteOutboundStatus> {
        Err(BoxliteError::Unsupported(
            "this backend does not support complete outbound policies".into(),
        ))
    }

    async fn outbound_policy_status(&self) -> BoxliteResult<crate::net::OutboundPolicyStatus> {
        Ok(self.complete_outbound_status().await?.into())
    }

    async fn replace_verified_outbound_policy(
        &self,
        policy: crate::net::CompleteOutboundPolicy,
        expected: Option<crate::net::OutboundRevision>,
    ) -> crate::net::OutboundPolicyResult<crate::net::OutboundPolicyReplacement> {
        use crate::net::{OutboundPolicyReplacement, OutboundReplaceOutcome, OutboundRevision};

        let previous = self.complete_outbound_snapshot().await?;
        if expected
            .as_ref()
            .is_some_and(|expected| *expected != previous.revision)
        {
            return Err(
                BoxliteError::InvalidState("outbound revision does not match".into()).into(),
            );
        }
        let candidate = policy.prepare(previous.admission, OutboundRevision::fresh())?;
        match self
            .replace_complete_outbound(policy, candidate.revision.clone(), Some(previous.revision))
            .await?
        {
            OutboundReplaceOutcome::Applied => Ok(OutboundPolicyReplacement::from_readback(
                candidate,
                self.outbound_policy_status().await,
            )),
            OutboundReplaceOutcome::PreconditionFailed => {
                Err(BoxliteError::InvalidState("outbound revision does not match".into()).into())
            }
        }
    }

    async fn hosted_outbound(
        &self,
        _command: crate::net::HostedOutboundCommand,
    ) -> BoxliteResult<crate::net::HostedOutboundReceipt> {
        Err(BoxliteError::Unsupported(
            "hosted outbound control requires the local Runtime".into(),
        ))
    }

    async fn replace_complete_outbound(
        &self,
        _policy: crate::net::CompleteOutboundPolicy,
        _revision: crate::net::OutboundRevision,
        _expected: Option<crate::net::OutboundRevision>,
    ) -> BoxliteResult<crate::net::OutboundReplaceOutcome> {
        Err(BoxliteError::Unsupported(
            "this backend does not support complete outbound policies".into(),
        ))
    }

    async fn outbound_status(&self) -> BoxliteResult<crate::net::OutboundStatus> {
        Err(BoxliteError::Unsupported(
            "this backend does not support revisioned outbound status".into(),
        ))
    }

    async fn outbound_snapshot(&self) -> BoxliteResult<crate::net::OutboundSnapshot> {
        Err(BoxliteError::Unsupported(
            "this backend does not support revisioned outbound control".into(),
        ))
    }

    async fn replace_outbound_snapshot(
        &self,
        _replacement: crate::net::OutboundReplacement,
    ) -> BoxliteResult<crate::net::OutboundReplaceOutcome> {
        Err(BoxliteError::Unsupported(
            "this backend does not support revisioned outbound control".into(),
        ))
    }

    async fn update_inbound(&self, _config: InboundNetworkConfig) -> BoxliteResult<()> {
        Err(BoxliteError::Unsupported(
            "this backend does not support inbound policy updates".into(),
        ))
    }

    async fn update_outbound(&self, _config: OutboundNetworkConfig) -> BoxliteResult<()> {
        Err(BoxliteError::Unsupported(
            "this backend does not support outbound policy updates".into(),
        ))
    }

    /// Prepare a one-shot tunnel to a service inside the box under `options`.
    /// `target` is already resolved to the guest address.
    ///
    /// Check here that the box can carry the tunnel and mint any public URI,
    /// but open no connection: return a [`BoxTunnel::new`] whose future opens
    /// it on `connect()`, so a port nothing listens on fails there.
    async fn tunnel(
        &self,
        target: SocketAddr,
        options: crate::litebox::TunnelOptions,
    ) -> BoxliteResult<BoxTunnel>;

    /// Withdraw the tunnel declaration `tunnel()` made for `port`.
    ///
    /// A backend that publishes nothing, like the local one, has nothing to
    /// withdraw. Connections already open are not closed.
    async fn revoke_tunnel(&self, _port: u16) -> BoxliteResult<()> {
        Ok(())
    }
}

/// Backend abstraction for snapshot lifecycle operations on a box.
///
/// Kept separate from `BoxBackend` so lifecycle/exec/file operations can evolve
/// independently from snapshot/clone/export behavior.
#[allow(dead_code)] // Snapshots temporarily disabled; will be re-enabled
#[allow(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
pub(crate) trait SnapshotBackend: Send + Sync {
    async fn create(&self, options: SnapshotOptions, name: &str) -> BoxliteResult<SnapshotInfo>;

    async fn list(&self) -> BoxliteResult<Vec<SnapshotInfo>>;

    async fn get(&self, name: &str) -> BoxliteResult<Option<SnapshotInfo>>;

    async fn remove(&self, name: &str) -> BoxliteResult<()>;

    async fn restore(&self, name: &str) -> BoxliteResult<()>;
}

/// Backend abstraction for execution control (signal, kill, resize).
///
/// Local backend is implemented by `ExecutionInterface`. REST backend
/// delegates to HTTP API calls.
///
/// `signal(id, n)` sends signal `n` to the execution and returns; the exec
/// continues running (or not) based on whether the process honors the signal.
/// `kill(id)` is the explicit terminate-and-evict verb — for the REST
/// backend it issues `DELETE /executions/{id}`; for the local backend it
/// defaults to `signal(id, SIGKILL)`. Splitting them lets callers ask for
/// SIGINT/SIGTERM/SIGHUP without the request body being silently coerced
/// to SIGKILL on the server side (the historical bug).
#[allow(
    clippy::double_must_use,
    reason = "async_trait generates a must-use boxed future"
)]
#[async_trait]
pub(crate) trait ExecBackend: Send + Sync {
    async fn signal(&mut self, execution_id: &str, signal: i32) -> BoxliteResult<()>;

    async fn kill(&mut self, execution_id: &str) -> BoxliteResult<()> {
        self.signal(execution_id, 9).await
    }

    async fn resize_tty(
        &mut self,
        execution_id: &str,
        rows: u32,
        cols: u32,
        x_pixels: u32,
        y_pixels: u32,
    ) -> BoxliteResult<()>;
}

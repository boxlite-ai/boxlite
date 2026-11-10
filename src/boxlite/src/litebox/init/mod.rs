//! Box initialization orchestration.
//!
//! ## Architecture
//!
//! Initialization is table-driven with different execution plans based on BoxStatus:
//!
//! ```text
//! Starting (new box):
//!   1. Filesystem           (create layout)
//!   2. BootAssets       ─┬─  (stage custom kernel/initramfs)
//!      ContainerRootfs  ├─  (pull image, create COW disk)
//!      GuestRootfs      ─┘  (prepare guest, create COW disk)
//!   3. VmmSpawn             (build config + spawn VM)
//!   4. GuestConnect         (wait for guest ready)
//!   5. GuestInit       ─┬─   (initialize container)
//!      PortPublish     ─┘    (publish host ports)
//!
//! Stopped (restart):
//!   1. Filesystem           (load existing layout)
//!   2. BootAssets       ─┬─  (reuse box-scoped boot assets)
//!      ContainerRootfs  ├─  (reuse existing COW disk - preserves user data)
//!      GuestRootfs      ─┘  (reuse existing COW disk)
//!   3. VmmSpawn             (build config + spawn NEW VM)
//!   4. GuestConnect         (wait for guest ready)
//!   5. GuestInit       ─┬─   (re-initialize container in new VM)
//!      PortPublish     ─┘    (republish host ports)
//!
//! Running (reattach):
//!   1. VmmAttach            (attach to running VM)
//!   2. GuestConnect         (reconnect to guest)
//!   3. PortPublish          (reconcile publication after a core crash)
//! ```
//!
//! `CleanupGuard` cleans up failed starts; reconnect failures leave the live VM intact.

mod tasks;
mod types;

pub(crate) use crate::litebox::box_impl::LiveState;

/// What a completed build hands back.
///
/// A struct rather than a tuple because the third element is unlike the other
/// two: `live` and `guard` are the box, `resolved_image` is a fact about it the
/// caller records.
pub(crate) struct BuiltBox {
    pub(crate) live: LiveState,
    pub(crate) guard: types::CleanupGuard,
    /// Present when this build made a new disk from a registry image; see
    /// [`crate::litebox::state::BoxState::resolved_image`].
    pub(crate) resolved_image: Option<crate::images::ResolvedImage>,
}

use crate::litebox::BoxStatus;
use crate::litebox::config::BoxConfig;
use crate::metrics::BoxMetricsStorage;
use crate::pipeline::{
    BoxedTask, ExecutionPlan, PipelineBuilder, PipelineExecutor, PipelineMetrics, Stage,
};
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::runtime::types::BoxState;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::sync::Arc;
use tokio::sync::Mutex;

pub(crate) use tasks::PortPublishTask;
use tasks::{
    BootAssetsTask, ContainerRootfsTask, FilesystemTask, GuestConnectTask, GuestInitTask,
    GuestRootfsTask, InitCtx, VmmAttachTask, VmmSpawnTask,
};
use types::InitPipelineContext;

// ============================================================================
// EXECUTION PLAN
// ============================================================================

/// Get execution plan based on BoxStatus.
///
/// Returns Err for states that aren't valid init entry points
/// (e.g. Unknown from a corrupted DB row, or future variants). Callers
/// should treat this as a user-facing precondition error.
fn get_execution_plan(status: BoxStatus) -> BoxliteResult<ExecutionPlan<InitCtx>> {
    let stages: Vec<Stage<BoxedTask<InitCtx>>> = match status {
        BoxStatus::Configured => vec![
            // First start: Full pipeline
            // Phase 1: Setup filesystem layout first
            Stage::sequential(vec![Box::new(FilesystemTask)]),
            // Phase 2: Prepare independent boot and rootfs inputs after the
            // filesystem task has established their box-scoped destinations.
            Stage::parallel(vec![
                Box::new(BootAssetsTask),
                Box::new(ContainerRootfsTask),
                Box::new(GuestRootfsTask),
            ]),
            // Phase 3: Build config and spawn VM
            Stage::sequential(vec![Box::new(VmmSpawnTask)]),
            Stage::sequential(vec![Box::new(GuestConnectTask)]),
            Stage::parallel(vec![Box::new(GuestInitTask), Box::new(PortPublishTask)]),
        ],
        // Stopped and Failed both run the restart pipeline. A Failed box
        // has its rootfs preserved (per BoxStatus::Failed doc) and is
        // retryable per BoxStatus::can_start.
        BoxStatus::Stopped | BoxStatus::Failed => vec![
            // Restart: Same flow but rootfs tasks reuse existing COW disks
            // (preserves user modifications from previous run)
            Stage::sequential(vec![Box::new(FilesystemTask)]),
            Stage::parallel(vec![
                Box::new(BootAssetsTask),
                Box::new(ContainerRootfsTask),
                Box::new(GuestRootfsTask),
            ]),
            Stage::sequential(vec![Box::new(VmmSpawnTask)]),
            Stage::sequential(vec![Box::new(GuestConnectTask)]),
            // GuestInit must run - new VM process has fresh guest daemon
            Stage::parallel(vec![Box::new(GuestInitTask), Box::new(PortPublishTask)]),
        ],
        BoxStatus::Running => vec![
            // Reattach: vmm_attach gates on ProcessIdentity AND surfaces
            // any crash via exit_file, then connect to guest and reconcile
            // any publication interrupted by a prior core-process crash.
            Stage::sequential(vec![Box::new(VmmAttachTask)]),
            Stage::sequential(vec![Box::new(GuestConnectTask)]),
            Stage::sequential(vec![Box::new(PortPublishTask)]),
        ],
        other => {
            return Err(BoxliteError::InvalidState(format!(
                "Cannot initialize box in {other} state"
            )));
        }
    };

    Ok(ExecutionPlan::new(stages))
}

fn box_metrics_from_pipeline(pipeline_metrics: &PipelineMetrics) -> BoxMetricsStorage {
    let mut metrics = BoxMetricsStorage::new();

    if let Some(duration_ms) = pipeline_metrics.task_duration_ms("filesystem_setup") {
        metrics.set_stage_filesystem_setup(duration_ms);
    }
    if let Some(duration_ms) = pipeline_metrics.task_duration_ms("container_rootfs_prep") {
        metrics.set_stage_image_prepare(duration_ms);
    }
    if let Some(duration_ms) = pipeline_metrics.task_duration_ms("guest_rootfs_init") {
        metrics.set_stage_guest_rootfs(duration_ms);
    }
    if let Some(duration_ms) = pipeline_metrics.task_duration_ms("vmm_spawn") {
        metrics.set_stage_box_spawn(duration_ms);
    }
    if let Some(duration_ms) = pipeline_metrics.task_duration_ms("vmm_attach") {
        metrics.set_stage_box_spawn(duration_ms);
    }
    if let Some(_duration_ms) = pipeline_metrics.task_duration_ms("guest_connect") {
        // Track guest connection time
        // Could add a new metric field if needed
    }
    if let Some(duration_ms) = pipeline_metrics.task_duration_ms("guest_init") {
        metrics.set_stage_container_init(duration_ms);
    }

    metrics
}

/// Builds and initializes box components.
///
/// # Example
///
/// ```ignore
/// let inner = BoxBuilder::new(runtime, config, &state)
///     .build()
///     .await?;
/// ```
pub(crate) struct BoxBuilder {
    runtime: SharedRuntimeImpl,
    config: BoxConfig,
    state: BoxState,
}

fn validate_persisted_options(
    features: &crate::experimental::ExperimentalFeatures,
    options: &crate::BoxOptions,
) -> BoxliteResult<()> {
    features.require_for_options(options)?;
    options.sanitize_persisted()
}

impl BoxBuilder {
    /// Create a new builder from config and state.
    ///
    /// The state determines initialization mode:
    /// - `Starting`: normal init (pull image or use rootfs path)
    /// - `Stopped`: restart (reuse existing rootfs at box_home/rootfs)
    ///
    /// # Arguments
    ///
    /// * `runtime` - Runtime providing resources (layout, guest_rootfs, etc.)
    /// * `config` - Box configuration (immutable after creation)
    /// * `state` - Current box state (determines init mode)
    pub(crate) fn new(
        runtime: SharedRuntimeImpl,
        config: BoxConfig,
        state: BoxState,
    ) -> BoxliteResult<Self> {
        // External source paths were validated at create time. Persisted boxes
        // validate only their stored shape here; the boot-assets task reopens a
        // source only when no complete box-scoped generation exists.
        let options = &config.options;
        options.validate_secret_headers()?;
        validate_persisted_options(&runtime.experimental_features, options)?;

        Ok(Self {
            runtime,
            config,
            state,
        })
    }

    /// Build and initialize LiveState.
    ///
    /// Failed starts clean up automatically. Reattaching to a Running box leaves
    /// its VM and persisted state intact if reconnecting fails. The caller must
    /// disarm the returned guard after a successful start and DB persist.
    pub(crate) async fn build(self) -> BoxliteResult<BuiltBox> {
        use std::time::Instant;

        let total_start = Instant::now();

        let BoxBuilder {
            runtime,
            config,
            state,
        } = self;

        let status = state.status;
        let reuse_rootfs = status == BoxStatus::Stopped;
        let skip_guest_wait = status == BoxStatus::Running;

        let mut ctx = InitPipelineContext::new(
            config,
            runtime.clone(),
            reuse_rootfs,
            skip_guest_wait,
            state.resolved_image.clone(),
        );
        if status == BoxStatus::Running {
            // Adoption borrows an existing VM; a reconnect failure must not stop it
            // or replace its Running state with an initialization failure.
            ctx.guard.disarm();
        }
        ctx.outbound_policy = state.outbound_policy.clone();
        let ctx = Arc::new(Mutex::new(ctx));
        let ctx_for_cleanup = Arc::clone(&ctx);

        // New and restarted VMs stay guarded through the caller's DB persist.
        // Capture initialization errors so cleanup preserves their cause.
        let inner = async move {
            let plan = get_execution_plan(status)?;
            let pipeline = PipelineBuilder::from_plan(plan);
            let pipeline_metrics = PipelineExecutor::execute(pipeline, Arc::clone(&ctx)).await?;

            let mut ctx = ctx.lock().await;
            let total_create_duration_ms = total_start.elapsed().as_millis();
            let handler = ctx
                .guard
                .take_handler()
                .ok_or_else(|| BoxliteError::Internal("handler was not set".into()))?;

            let mut metrics = box_metrics_from_pipeline(&pipeline_metrics);
            metrics.set_total_create_duration(total_create_duration_ms);

            metrics.log_init_stages();

            // Start guards remain armed through the caller's DB persist;
            // the Running adoption guard was disarmed before pipeline work.

            // Get guest_session from GuestConnectTask
            let guest_session = ctx.guest_session.take().ok_or_else(|| {
                BoxliteError::Internal("guest_connect task must run first".into())
            })?;

            // Get disks from context (for Running, create disk reference directly)
            let (container_disk, guest_disk) = if status == BoxStatus::Running {
                // Reattach: create disk reference to existing qcow2
                use crate::disk::DiskFormat;
                use crate::disk::constants::filenames;
                let disk = crate::disk::Disk::new(
                    ctx.config.box_home.join(filenames::CONTAINER_DISK),
                    DiskFormat::Qcow2,
                    true,
                );
                (disk, None)
            } else {
                // Starting/Stopped: get disks from rootfs tasks
                let container_disk = ctx
                    .container_disk
                    .take()
                    .ok_or_else(|| BoxliteError::Internal("rootfs task must run first".into()))?;
                (container_disk, ctx.guest_disk.take())
            };

            #[cfg(target_os = "linux")]
            let bind_mount = ctx.bind_mount.take();

            // Take the guard out of context, replacing with a disarmed placeholder.
            // For starts, the caller disarms the returned guard after all
            // operations succeed (including DB persist).
            let mut placeholder =
                types::CleanupGuard::new(ctx.runtime.clone(), ctx.config.id.clone());
            placeholder.disarm();
            let guard = std::mem::replace(&mut ctx.guard, placeholder);

            // Own the box's one network backend beside guest_session — created by
            // vmm_spawn (which also used it to produce the wire spec) or, on the
            // reattach path, by vmm_attach; both thread it here for runtime control.
            let network = ctx.network_backend.take();
            let published_ports = ctx.published_ports.take();

            // Build LiveState
            let live_state = LiveState::new(
                handler,
                guest_session,
                network,
                published_ports,
                metrics,
                container_disk,
                guest_disk,
                #[cfg(target_os = "linux")]
                bind_mount,
            );

            Ok::<BuiltBox, BoxliteError>(BuiltBox {
                live: live_state,
                guard,
                resolved_image: ctx.resolved_image.take(),
            })
        };

        match inner.await {
            Ok(parts) => Ok(parts),
            Err(e) => {
                // Armed start guards persist the initialization failure cause.
                ctx_for_cleanup.lock().await.guard.set_last_error(&e);
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod plan_tests {
    use super::*;
    use crate::experimental::ExperimentalFeatures;
    use crate::experimental::custom_kernel::{KernelFormat, KernelOptions};
    use crate::pipeline::ExecutionMode;

    #[tokio::test]
    async fn required_headers_activation_preserves_stored_state() {
        use crate::litebox::config::ContainerRuntimeConfig;
        use crate::runtime::{
            id::BoxIDMint,
            options::{BoxOptions, BoxliteOptions},
            rt_impl::RuntimeImpl,
            types::ContainerID,
        };
        for status in [BoxStatus::Stopped, BoxStatus::Running] {
            for suffix in [
                ",\"headers\":{\"Host\":\"{value}\"}",
                ",\"headers\":{\"Bad Header\":\"{value}\"}",
                ",\"headers\":{\"X-Bad\":\"{value}{value}\"}",
                ",\"headers\":{\"X-Bad\":\"{value}\\r\\n\"}",
                "",
                ",\"headers\":null",
                ",\"headers\":{}",
                ",\"headers\":{\"X-Key\":\"{value}\"}",
            ] {
                let home = tempfile::tempdir().unwrap();
                let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
                    home_dir: home.path().into(),
                    ..Default::default()
                })
                .unwrap();
                let id = BoxIDMint::mint();
                let secret = serde_json::from_str(&format!(r#"{{"name":"x","hosts":["api.test.com"],"placeholder":"dummy","value":"private-token"{suffix}}}"#)).unwrap();
                let config = BoxConfig {
                    id: id.clone(),
                    name: None,
                    created_at: chrono::Utc::now(),
                    container: ContainerRuntimeConfig {
                        id: ContainerID::new(),
                    },
                    options: BoxOptions {
                        secrets: vec![secret],
                        auto_delete: Some(0),
                        ..Default::default()
                    },
                    engine_kind: crate::vmm::VmmKind::Libkrun,
                    box_home: runtime.layout.boxes_dir().join(id.as_str()),
                };
                std::fs::create_dir_all(&config.box_home).unwrap();
                std::fs::write(config.box_home.join("keep"), "original").unwrap();
                let mut state = BoxState::new();
                state.status = status;
                runtime.box_manager.add_box(&config, &state).unwrap();
                let before = serde_json::to_value(&state).unwrap();
                let result = BoxBuilder::new(runtime.clone(), config.clone(), state);
                if suffix.contains("X-Key") {
                    assert!(
                        result.is_ok(),
                        "valid headers must allow activation planning"
                    );
                    continue;
                }
                assert!(
                    result.is_err(),
                    "activation accepted missing headers for {status:?}"
                );
                let error = result.err().unwrap().to_string();
                assert!(
                    error.contains("secret \"x\"") && !error.contains("private-token"),
                    "{error}"
                );
                assert!(runtime.get_info(id.as_str()).await.unwrap().is_some());
                let (_, after) = runtime.box_manager.box_by_id(&id).unwrap().unwrap();
                assert_eq!(serde_json::to_value(after).unwrap(), before);
                assert_eq!(
                    std::fs::read_to_string(config.box_home.join("keep")).unwrap(),
                    "original"
                );
                assert!(!config.box_home.join("sockets").exists());
            }
        }
    }

    fn plan_shape(status: BoxStatus) -> Vec<(ExecutionMode, Vec<String>)> {
        get_execution_plan(status)
            .unwrap()
            .stages()
            .into_iter()
            .map(|stage| {
                (
                    stage.execution,
                    stage
                        .tasks
                        .into_iter()
                        .map(|task| task.name().to_string())
                        .collect(),
                )
            })
            .collect()
    }

    fn boot_pipeline_shape() -> Vec<(ExecutionMode, Vec<String>)> {
        vec![
            (
                ExecutionMode::Sequential,
                vec!["filesystem_setup".to_string()],
            ),
            (
                ExecutionMode::Parallel,
                vec![
                    "boot_assets_prepare".to_string(),
                    "container_rootfs_prep".to_string(),
                    "guest_rootfs_init".to_string(),
                ],
            ),
            (ExecutionMode::Sequential, vec!["vmm_spawn".to_string()]),
            (ExecutionMode::Sequential, vec!["guest_connect".to_string()]),
            // Publication needs a live gvproxy, which the shim binds before
            // it boots the VM; it has no reason to gate container init.
            (
                ExecutionMode::Parallel,
                vec!["guest_init".to_string(), "port_publish".to_string()],
            ),
        ]
    }

    #[test]
    fn configured_box_prepares_boot_assets_before_vmm_spawn() {
        assert_eq!(plan_shape(BoxStatus::Configured), boot_pipeline_shape());
    }

    #[test]
    fn restartable_boxes_prepare_boot_assets_before_vmm_spawn() {
        let expected = boot_pipeline_shape();
        assert_eq!(plan_shape(BoxStatus::Stopped), expected);
        assert_eq!(plan_shape(BoxStatus::Failed), boot_pipeline_shape());
    }

    #[test]
    fn running_box_reattach_does_not_prepare_boot_assets() {
        assert_eq!(
            plan_shape(BoxStatus::Running),
            vec![
                (ExecutionMode::Sequential, vec!["vmm_attach".to_string()]),
                (ExecutionMode::Sequential, vec!["guest_connect".to_string()]),
                // Reattach has no guest_init to overlap with.
                (ExecutionMode::Sequential, vec!["port_publish".to_string()]),
            ]
        );
    }

    #[test]
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    fn persisted_custom_kernel_uses_injected_feature_state() {
        #[cfg(target_arch = "x86_64")]
        let format = KernelFormat::Elf;
        #[cfg(target_arch = "aarch64")]
        let format = KernelFormat::PeGz;

        let mut options = crate::BoxOptions::default();
        options.advanced.kernel =
            Some(KernelOptions::new("/source/no-longer-needed").with_format(format));

        let error = validate_persisted_options(&ExperimentalFeatures::default(), &options)
            .expect_err("persisted custom kernel must be disabled by default");
        assert!(
            error
                .to_string()
                .contains("ExperimentalFeature::CustomKernel")
        );

        let enabled = ExperimentalFeatures::parse("custom-kernel").unwrap();
        validate_persisted_options(&enabled, &options).unwrap();
    }

    #[test]
    fn persisted_nested_virtualization_uses_injected_feature_state() {
        let mut advanced = crate::runtime::advanced_options::AdvancedBoxOptions::default();
        advanced.nested_virtualization = true;
        let options = crate::BoxOptions {
            advanced,
            ..Default::default()
        };

        let error = validate_persisted_options(&ExperimentalFeatures::default(), &options)
            .expect_err("persisted nested virtualization must be disabled by default");
        assert!(
            error
                .to_string()
                .contains("ExperimentalFeature::NestedVirtualization")
        );

        let enabled = ExperimentalFeatures::parse("nested-virtualization").unwrap();
        validate_persisted_options(&enabled, &options).unwrap();
    }

    #[test]
    fn persisted_engine_choice_uses_injected_feature_state() {
        let mut advanced = crate::runtime::advanced_options::AdvancedBoxOptions::default();
        advanced.engine = Some(crate::vmm::VmmKind::Native);
        let options = crate::BoxOptions {
            advanced,
            ..Default::default()
        };

        let error = validate_persisted_options(&ExperimentalFeatures::default(), &options)
            .expect_err("a persisted engine choice must be disabled by default");
        assert!(error.to_string().contains("ExperimentalFeature::NativeVmm"));

        let enabled = ExperimentalFeatures::parse("native-vmm").unwrap();
        validate_persisted_options(&enabled, &options).unwrap();
    }
}

#[cfg(test)]
mod required_start_safety_tests {
    use super::*;
    use crate::litebox::config::ContainerRuntimeConfig;
    use crate::runtime::{
        id::BoxIDMint,
        options::{BoxOptions, BoxliteOptions, RootfsSpec},
        rt_impl::RuntimeImpl,
        types::ContainerID,
    };

    #[tokio::test]
    async fn required_headers_public_start_preserves_state() {
        assert_rejection_preserves_state(BoxStatus::Stopped, false).await;
    }

    #[tokio::test]
    async fn required_headers_public_reconnect_preserves_state() {
        assert_rejection_preserves_state(BoxStatus::Running, false).await;
    }

    #[tokio::test]
    async fn required_headers_restart_keeps_stopped_box_data() {
        assert_rejection_preserves_state(BoxStatus::Running, true).await;
    }

    async fn assert_rejection_preserves_state(status: BoxStatus, stop_first: bool) {
        for extra in ["", ",\"headers\":null", ",\"headers\":{}"] {
            let home = tempfile::tempdir().unwrap();
            let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
                home_dir: home.path().join("runtime"),
                ..Default::default()
            })
            .unwrap();
            let id = BoxIDMint::mint();
            let secret = serde_json::from_str(&format!(r#"{{"name":"x","hosts":["api.test.com"],"placeholder":"dummy","value":"token"{extra}}}"#)).unwrap();
            let config = BoxConfig {
                id: id.clone(),
                name: None,
                created_at: chrono::Utc::now(),
                container: ContainerRuntimeConfig {
                    id: ContainerID::new(),
                },
                options: BoxOptions {
                    rootfs: RootfsSpec::RootfsPath(home.path().to_string_lossy().into_owned()),
                    secrets: vec![secret],
                    auto_delete: Some(0),
                    detach: true,
                    ..Default::default()
                },
                engine_kind: crate::vmm::VmmKind::Libkrun,
                box_home: runtime.layout.boxes_dir().join(id.as_str()),
            };
            std::fs::create_dir_all(&config.box_home).unwrap();
            std::fs::write(config.box_home.join("keep"), "original").unwrap();
            let mut state = BoxState::new();
            state.status = status;
            state.set_lock_id(runtime.lock_manager.allocate().unwrap());
            runtime.box_manager.add_box(&config, &state).unwrap();
            let mut handle = runtime.get(id.as_str()).await.unwrap().unwrap();
            assert_eq!(handle.info().await.unwrap().id, id);
            if stop_first {
                handle.stop().await.unwrap();
                handle = runtime.get(id.as_str()).await.unwrap().unwrap();
                assert_eq!(handle.info().await.unwrap().status, BoxStatus::Stopped);
            }
            let (_, before) = runtime.box_manager.box_by_id(&id).unwrap().unwrap();
            let before = serde_json::to_value(before).unwrap();
            let result = handle.start().await;
            let (_, after) = runtime.box_manager.box_by_id(&id).unwrap().unwrap();
            assert_eq!(
                serde_json::to_value(after).unwrap(),
                before,
                "activation modified stored state"
            );
            assert_eq!(
                std::fs::read_to_string(config.box_home.join("keep")).unwrap(),
                "original"
            );
            let message = result
                .expect_err("activation accepted missing headers")
                .to_string();
            assert!(
                message.contains("secret \"x\" has no headers; recreate the box with headers"),
                "{status:?}: {message}"
            );
        }
    }
}

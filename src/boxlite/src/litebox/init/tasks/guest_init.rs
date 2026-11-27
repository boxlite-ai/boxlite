//! Task: Guest initialization.
//!
//! Sends init configuration to the guest and *creates* the container. Running
//! its init is a separate, host-driven step (`Container.Start`), so a client can
//! attach to the created-but-not-started session first and miss none of its
//! output. Builds guest volumes from the volume manager, uses rootfs config from
//! the vmm_config stage.

use super::{InitCtx, log_task_error, task_start};
use crate::net::constants::{GATEWAY_IP, GUEST_CIDR, GUEST_INTERFACE};
use crate::pipeline::PipelineTask;
use crate::portal::GuestSession;
use crate::portal::interfaces::{ContainerInitConfig, GuestInitConfig, NetworkInitConfig};
use crate::runtime::constants::vm_defaults::{DEFAULT_CPUS, DEFAULT_MEMORY_MIB};
use crate::runtime::cpu_count::{CPU_PERIOD_US, CpuCount};
use crate::runtime::options::BoxOptions;
use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use boxlite_shared::{ContainerDevice, ContainerResources};

/// Oldest guest release that honors `advanced.capabilities` on
/// `Container.Init`. An earlier guest drops the field and starts the container
/// with the default capability set while the caller believes a policy applied.
/// Guest rootfs images are cached per version and reused, so a host can meet
/// one long after its own release.
const MIN_CAPABILITY_GUEST_VERSION: crate::portal::interfaces::guest::GuestVersion = (0, 9, 8);

/// Oldest guest release that applies the privileged DinD spec shape. The
/// privileged field ships in the same release as the capability policy above,
/// so it carries the same floor: a guest new enough to honor one understands
/// the other. Requiring a later release would reject the very guest that
/// introduces the feature.
const MIN_PRIVILEGED_CONTAINER_GUEST_VERSION: crate::portal::interfaces::guest::GuestVersion =
    (0, 9, 8);

/// Oldest guest release that honors `devices` on `Container.Init`. Same trap as
/// capabilities above: an earlier guest drops the field and starts the workload
/// with no `/dev/kvm` while the caller believes nesting was granted.
const MIN_DEVICE_GUEST_VERSION: crate::portal::interfaces::guest::GuestVersion = (0, 9, 8);

pub struct GuestInitTask;

struct GuestBootstrapConfig {
    guest: GuestInitConfig,
    container: ContainerInitConfig,
}

#[async_trait]
impl PipelineTask<InitCtx> for GuestInitTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;

        let (guest_session, volume_mgr, rootfs_init, container_mounts, bootstrap) = {
            let mut ctx = ctx.lock().await;
            let guest_session = ctx
                .guest_session
                .take()
                .ok_or_else(|| BoxliteError::Internal("connect task must run first".into()))?;
            let image = ctx
                .container_image_config
                .clone()
                .ok_or_else(|| BoxliteError::Internal("rootfs task must run first".into()))?;
            let volume_mgr = ctx
                .volume_mgr
                .take()
                .ok_or_else(|| BoxliteError::Internal("vmm_spawn task must run first".into()))?;
            let rootfs_init = ctx
                .rootfs_init
                .take()
                .ok_or_else(|| BoxliteError::Internal("vmm_spawn task must run first".into()))?;
            let container_mounts = ctx
                .container_mounts
                .take()
                .ok_or_else(|| BoxliteError::Internal("vmm_spawn task must run first".into()))?;

            let network = match &ctx.config.options.network {
                crate::runtime::options::NetworkSpec::Enabled { .. } => Some(NetworkInitConfig {
                    interface: GUEST_INTERFACE.to_string(),
                    ip: Some(GUEST_CIDR.to_string()),
                    gateway: Some(GATEWAY_IP.to_string()),
                }),
                crate::runtime::options::NetworkSpec::Disabled => None,
            };
            let advanced = ctx.config.options.advanced.resolve_container_security()?;
            let bootstrap = GuestBootstrapConfig {
                guest: GuestInitConfig {
                    volumes: if ctx.config.engine_kind == crate::vmm::VmmKind::Native {
                        volume_mgr
                            .build_aggregate_mounts(
                                boxlite_shared::constants::mount_tags::AGGREGATE,
                            )?
                            .guest_mounts
                    } else {
                        volume_mgr.build_guest_mounts()
                    },
                    network,
                },
                container: ContainerInitConfig {
                    container_id: ctx.config.container.id.as_str().to_owned(),
                    image,
                    rootfs: rootfs_init.clone(),
                    mounts: container_mounts.clone(),
                    ca_certs: ctx.ca_cert_pem.iter().cloned().collect(),
                    tty: ctx.config.options.tty,
                    devices: if ctx.config.options.advanced.nested_virtualization {
                        vec![kvm_device()]
                    } else {
                        Vec::new()
                    },
                    resources: container_resources(&ctx.config.options)?,
                    advanced: advanced.into(),
                },
            };

            (
                guest_session,
                volume_mgr,
                rootfs_init,
                container_mounts,
                bootstrap,
            )
        };

        let records = run_guest_init(guest_session.clone(), bootstrap)
            .await
            .inspect_err(|e| log_task_error(&box_id, task_name, e))?;

        let mut ctx = ctx.lock().await;
        if !records {
            // The guest got plain binds, so no directory of this run has an
            // identity an online removal could select.
            ctx.confirmed.clear();
        }
        ctx.guest_session = Some(guest_session);
        ctx.volume_mgr = Some(volume_mgr);
        ctx.rootfs_init = Some(rootfs_init);
        ctx.container_mounts = Some(container_mounts);

        Ok(())
    }

    fn name(&self) -> &str {
        "guest_init"
    }
}

fn requires_safe_volume_sub_path(mounts: &[crate::volumes::ContainerMount]) -> bool {
    mounts.iter().any(|mount| {
        matches!(
            mount.payload,
            crate::volumes::ContainerMountPayload::ManagedSubDirectory { .. }
        )
    })
}

/// Deliver each declared directory as the plain bind it was created as: the
/// guest cannot record it, so an online removal cannot select it.
fn unrecord(mounts: &mut [crate::volumes::ContainerMount]) {
    for mount in mounts {
        if matches!(
            mount.payload,
            crate::volumes::ContainerMountPayload::RecordedDirectory { .. }
        ) {
            mount.payload = crate::volumes::ContainerMountPayload::WholeDirectory;
        }
    }
}

/// Initialize the guest and create the container (init is *not* run here).
/// Returns whether the guest records the mounts of declared directories.
async fn run_guest_init(
    guest_session: GuestSession,
    mut bootstrap: GuestBootstrapConfig,
) -> BoxliteResult<bool> {
    // Step 1: Guest Init (volumes + network)
    tracing::info!("Sending guest initialization request");
    let mut guest_interface = guest_session.guest().await?;
    if !bootstrap.container.advanced.capabilities.is_empty() {
        guest_interface
            .require_min_version(MIN_CAPABILITY_GUEST_VERSION)
            .await?;
    }
    // An older guest's Container.Init doesn't understand
    // readonly_paths/mount.options at all and would silently keep its own
    // hardened defaults, so privileged mode needs a version gate the same way
    // capability overrides do. (No masked_paths here: it never varies with
    // `privileged` — see advanced_options.rs — so it carries no version
    // requirement of its own.)
    if bootstrap.container.advanced.linux.readonly_paths.is_empty() {
        guest_interface
            .require_min_version(MIN_PRIVILEGED_CONTAINER_GUEST_VERSION)
            .await?;
    }
    if !bootstrap.container.devices.is_empty() {
        guest_interface
            .require_min_version(MIN_DEVICE_GUEST_VERSION)
            .await?;
    }
    if requires_safe_volume_sub_path(&bootstrap.container.mounts) {
        guest_interface.require_safe_volume_sub_path().await?;
    }
    // The guest records the mounts of declared directories while it creates
    // the container, which is what lets an online removal select them.
    let recorded = |mount: &crate::volumes::ContainerMount| {
        matches!(
            mount.payload,
            crate::volumes::ContainerMountPayload::RecordedDirectory { .. }
        )
    };
    let records = if !bootstrap.container.mounts.iter().any(recorded) {
        true
    } else {
        match guest_interface.require_boot_mount_records().await {
            Ok(()) => true,
            // Only a guest without the capability gets plain binds. Any other
            // failure is reported, so a retry keeps the records.
            Err(error) if !matches!(error, BoxliteError::Unsupported(_)) => return Err(error),
            Err(error) => {
                // A directory added at runtime needs its record.
                let added = |mount: &crate::volumes::ContainerMount| {
                    matches!(
                        mount.payload,
                        crate::volumes::ContainerMountPayload::RecordedDirectory {
                            added: true,
                            ..
                        }
                    )
                };
                if bootstrap.container.mounts.iter().any(added) {
                    return Err(error);
                }
                // One created with the box keeps its plain delivery instead: it
                // then leaves only with the box.
                unrecord(&mut bootstrap.container.mounts);
                false
            }
        }
    };
    guest_interface.init(bootstrap.guest).await?;
    tracing::info!("Guest initialized successfully");

    // Step 2: create the container (rootfs + image config + user mounts). This
    // does NOT run init — Container.Init only creates.
    tracing::info!("Sending container configuration to guest");
    let mut container_interface = guest_session.container().await?;
    let returned_id = container_interface.init(bootstrap.container).await?;
    tracing::info!(container_id = %returned_id, "Container created");

    // Running init is deliberately *not* done here. The container is created and
    // left standing at the gate; the host runs it with `Container.Start` after a
    // client has attached, so nothing it prints can be missed however fast it is.

    Ok(records)
}

/// The box limits the container reads in its cgroup, from the values the VM
/// really gets: unset options fall back to the VM defaults, and the CPU quota
/// is the host jailer's, legacy `max_cpu_time` cap included. No guest pids
/// limit is exposed yet, so `pids.max` stays `max`.
fn container_resources(options: &BoxOptions) -> BoxliteResult<ContainerResources> {
    let cpus = match options.cpu_count()? {
        Some(cpus) => cpus,
        None => CpuCount::new(f64::from(DEFAULT_CPUS))?,
    };
    let max_cpu_time = options.advanced.security.resource_limits.max_cpu_time;
    let memory_mib = options.memory_mib.unwrap_or(DEFAULT_MEMORY_MIB);
    Ok(ContainerResources {
        cpu_quota_us: i64::try_from(cpus.cfs_quota_us(max_cpu_time)).unwrap_or(i64::MAX),
        cpu_period_us: CPU_PERIOD_US,
        memory_limit_bytes: i64::from(memory_mib) << 20,
        pids_limit: 0,
    })
}

/// The guest VM's own `/dev/kvm`, republished into the OCI workload so a nested
/// hypervisor can open it. The host's `/dev/kvm` is never passed through.
fn kvm_device() -> ContainerDevice {
    ContainerDevice {
        source: "/dev/kvm".to_string(),
        destination: "/dev/kvm".to_string(),
        file_mode: Some(0o666),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn limits_for(cpus: Option<f64>, memory_mib: Option<u32>, cap: Option<u64>) -> (i64, u64, i64) {
        let mut options = BoxOptions {
            cpus,
            memory_mib,
            ..Default::default()
        };
        options.advanced.security.resource_limits.max_cpu_time = cap;
        let resources = container_resources(&options).expect("valid options");
        assert_eq!(resources.pids_limit, 0, "no guest pids limit is exposed");
        (
            resources.cpu_quota_us,
            resources.cpu_period_us,
            resources.memory_limit_bytes,
        )
    }

    /// The container reads the same budget the VM and the host jailer enforce,
    /// including the defaults applied when the caller leaves them unset.
    #[test]
    fn container_resources_mirror_the_box_size() {
        assert_eq!(
            limits_for(Some(2.0), Some(3072), None),
            (200_000, 100_000, 3_221_225_472)
        );
        assert_eq!(
            limits_for(None, None, None),
            (100_000, 100_000, 1_073_741_824)
        );
        assert_eq!(limits_for(Some(0.5), Some(512), None).0, 50_000);
        // The legacy cap lowers the guest quota exactly as it lowers the host's.
        assert_eq!(limits_for(Some(2.0), None, Some(1)).0, 100_000);
    }
    /// A privileged request always carries the capability policy it expands to,
    /// so any guest that satisfies the privileged floor must already satisfy
    /// the capability floor. Pinning the constants to literals only restates
    /// them; this is the relation that catches a privileged floor set to a
    /// release later than the one introducing the feature, which would reject
    /// that very guest.
    #[test]
    fn privileged_gate_is_never_newer_than_the_capability_gate() {
        assert!(
            MIN_PRIVILEGED_CONTAINER_GUEST_VERSION <= MIN_CAPABILITY_GUEST_VERSION,
            "privileged floor {MIN_PRIVILEGED_CONTAINER_GUEST_VERSION:?} is newer than the capability floor {MIN_CAPABILITY_GUEST_VERSION:?}"
        );
    }

    #[test]
    fn managed_sub_directories_require_a_safe_guest_before_init() {
        let mount = |payload| crate::volumes::ContainerMount {
            volume_name: "uservol0".to_string(),
            destination: "/data".to_string(),
            read_only: true,
            owner_uid: 0,
            owner_gid: 0,
            payload,
        };
        let managed = mount(crate::volumes::ContainerMountPayload::ManagedSubDirectory {
            sub_path: "team/backend".to_string(),
        });
        assert!(requires_safe_volume_sub_path(&[managed]));
        assert!(!requires_safe_volume_sub_path(&[
            mount(crate::volumes::ContainerMountPayload::WholeDirectory),
            mount(crate::volumes::ContainerMountPayload::SingleFile {
                file_name: "app.conf".to_string(),
            }),
        ]));
    }

    #[derive(Clone)]
    struct VersionedGuest {
        version: &'static str,
        safe_managed_volume_sub_path: bool,
        records_boot_mounts: bool,
        guest_init_calls: Arc<std::sync::Mutex<usize>>,
        container_init_calls: Arc<std::sync::Mutex<usize>>,
        container_mounts: Arc<std::sync::Mutex<Vec<boxlite_shared::BindMount>>>,
    }

    #[tonic::async_trait]
    impl boxlite_shared::Guest for VersionedGuest {
        async fn init(
            &self,
            _: tonic::Request<boxlite_shared::GuestInitRequest>,
        ) -> Result<tonic::Response<boxlite_shared::GuestInitResponse>, tonic::Status> {
            *self.guest_init_calls.lock().unwrap() += 1;
            Ok(tonic::Response::new(boxlite_shared::GuestInitResponse {
                result: Some(boxlite_shared::guest_init_response::Result::Success(
                    boxlite_shared::GuestInitSuccess {},
                )),
            }))
        }

        async fn ping(
            &self,
            _: tonic::Request<boxlite_shared::PingRequest>,
        ) -> Result<tonic::Response<boxlite_shared::PingResponse>, tonic::Status> {
            Ok(tonic::Response::new(boxlite_shared::PingResponse {
                version: self.version.to_string(),
                safe_managed_volume_sub_path: self.safe_managed_volume_sub_path,
                records_boot_mounts: self.records_boot_mounts,
            }))
        }

        async fn sync_clock(
            &self,
            _: tonic::Request<boxlite_shared::SyncClockRequest>,
        ) -> Result<tonic::Response<boxlite_shared::SyncClockResponse>, tonic::Status> {
            Err(tonic::Status::unimplemented("not used by these tests"))
        }

        async fn shutdown(
            &self,
            _: tonic::Request<boxlite_shared::ShutdownRequest>,
        ) -> Result<tonic::Response<boxlite_shared::ShutdownResponse>, tonic::Status> {
            Ok(tonic::Response::new(boxlite_shared::ShutdownResponse {}))
        }

        async fn quiesce(
            &self,
            _: tonic::Request<boxlite_shared::QuiesceRequest>,
        ) -> Result<tonic::Response<boxlite_shared::QuiesceResponse>, tonic::Status> {
            Ok(tonic::Response::new(boxlite_shared::QuiesceResponse {
                frozen_count: 0,
            }))
        }

        async fn thaw(
            &self,
            _: tonic::Request<boxlite_shared::ThawRequest>,
        ) -> Result<tonic::Response<boxlite_shared::ThawResponse>, tonic::Status> {
            Ok(tonic::Response::new(boxlite_shared::ThawResponse {
                thawed_count: 0,
            }))
        }

        async fn resize_filesystem(
            &self,
            _: tonic::Request<boxlite_shared::ResizeFilesystemRequest>,
        ) -> Result<tonic::Response<boxlite_shared::ResizeFilesystemResponse>, tonic::Status>
        {
            Err(tonic::Status::unimplemented("not used by these tests"))
        }
    }

    #[tonic::async_trait]
    impl boxlite_shared::Container for VersionedGuest {
        async fn init(
            &self,
            request: tonic::Request<boxlite_shared::ContainerInitRequest>,
        ) -> Result<tonic::Response<boxlite_shared::ContainerInitResponse>, tonic::Status> {
            *self.container_init_calls.lock().unwrap() += 1;
            let request = request.into_inner();
            *self.container_mounts.lock().unwrap() = request.mounts;
            let container_id = request.container_id;
            Ok(tonic::Response::new(
                boxlite_shared::ContainerInitResponse {
                    result: Some(boxlite_shared::container_init_response::Result::Success(
                        boxlite_shared::ContainerInitSuccess { container_id },
                    )),
                },
            ))
        }

        async fn start(
            &self,
            _: tonic::Request<boxlite_shared::ContainerStartRequest>,
        ) -> Result<tonic::Response<boxlite_shared::ContainerStartResponse>, tonic::Status>
        {
            Err(tonic::Status::unimplemented("not used by these tests"))
        }

        async fn mount(
            &self,
            _: tonic::Request<boxlite_shared::ContainerMountRequest>,
        ) -> Result<tonic::Response<boxlite_shared::ContainerMountResponse>, tonic::Status>
        {
            Err(tonic::Status::unimplemented("not used by these tests"))
        }

        async fn detach(
            &self,
            _: tonic::Request<boxlite_shared::ContainerDetachRequest>,
        ) -> Result<tonic::Response<boxlite_shared::ContainerDetachResponse>, tonic::Status>
        {
            Err(tonic::Status::unimplemented("not used by these tests"))
        }
    }

    fn bootstrap_for_version_gate() -> GuestBootstrapConfig {
        GuestBootstrapConfig {
            guest: GuestInitConfig {
                volumes: vec![],
                network: None,
            },
            container: crate::portal::interfaces::ContainerInitConfig {
                container_id: "container-1".to_string(),
                image: crate::images::ContainerImageConfig::default(),
                rootfs: crate::portal::interfaces::ContainerRootfsInitConfig::Merged,
                mounts: vec![crate::volumes::ContainerMount {
                    volume_name: "uservol0".to_string(),
                    destination: "/data".to_string(),
                    read_only: true,
                    owner_uid: 0,
                    owner_gid: 0,
                    payload: crate::volumes::ContainerMountPayload::ManagedSubDirectory {
                        sub_path: "team/backend".to_string(),
                    },
                }],
                ca_certs: vec![],
                tty: false,
                devices: vec![],
                resources: ContainerResources::default(),
                advanced: Default::default(),
            },
        }
    }

    fn guest_that(version: &'static str, safe_managed_volume_sub_path: bool) -> VersionedGuest {
        VersionedGuest {
            version,
            safe_managed_volume_sub_path,
            records_boot_mounts: true,
            guest_init_calls: Arc::new(std::sync::Mutex::new(0)),
            container_init_calls: Arc::new(std::sync::Mutex::new(0)),
            container_mounts: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    async fn run_with_guest(
        guest: VersionedGuest,
        bootstrap: GuestBootstrapConfig,
    ) -> (BoxliteResult<bool>, VersionedGuest) {
        let served = guest.clone();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(boxlite_shared::GuestServer::new(guest.clone()))
                .add_service(boxlite_shared::ContainerServer::new(guest))
                .serve(addr)
                .await
                .unwrap();
        });
        for _ in 0..100 {
            if tokio::net::TcpStream::connect(addr).await.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let result = run_guest_init(
            crate::portal::GuestSession::new(boxlite_shared::BoxTransport::tcp(addr.port())),
            bootstrap,
        )
        .await;
        (result, served)
    }

    async fn run_with_guest_version(
        version: &'static str,
        safe_managed_volume_sub_path: bool,
    ) -> (BoxliteResult<bool>, usize, usize) {
        let guest = guest_that(version, safe_managed_volume_sub_path);
        let (result, guest) = run_with_guest(guest, bootstrap_for_version_gate()).await;
        let calls = (
            *guest.guest_init_calls.lock().unwrap(),
            *guest.container_init_calls.lock().unwrap(),
        );
        (result, calls.0, calls.1)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_guest_init_requires_safe_subpath_capability_before_any_init() {
        let (result, guest_calls, container_calls) = run_with_guest_version("0.14.0", false).await;
        assert!(matches!(result, Err(BoxliteError::Unsupported(_))));
        assert_eq!((guest_calls, container_calls), (0, 0));

        let (result, guest_calls, container_calls) = run_with_guest_version("0.14.0", true).await;
        result.unwrap();
        assert_eq!((guest_calls, container_calls), (1, 1));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_a_directory_added_at_runtime_needs_a_guest_that_records_mounts() {
        let recorded = |added| crate::volumes::ContainerMount {
            volume_name: "uservol0".to_string(),
            destination: "/data".to_string(),
            read_only: true,
            owner_uid: 0,
            owner_gid: 0,
            payload: crate::volumes::ContainerMountPayload::RecordedDirectory {
                key: "delivery-1".to_string(),
                added,
            },
        };
        let mut creation = bootstrap_for_version_gate();
        creation.container.mounts = vec![recorded(false)];
        let mut added = bootstrap_for_version_gate();
        added.container.mounts = vec![recorded(true)];

        // A directory created with the box is delivered as the plain bind it is.
        let silent = || {
            let mut guest = guest_that("0.15.0", false);
            guest.records_boot_mounts = false;
            guest
        };
        let (result, served) = run_with_guest(silent(), creation).await;
        assert!(!result.unwrap());
        assert_eq!(
            (
                *served.guest_init_calls.lock().unwrap(),
                *served.container_init_calls.lock().unwrap()
            ),
            (1, 1)
        );
        assert!(
            served
                .container_mounts
                .lock()
                .unwrap()
                .iter()
                .all(|mount| mount.record_key.is_empty()),
            "a directory created with the box reached the guest as a recorded mount"
        );

        // One added at runtime has no identity without its record.
        let (result, served) = run_with_guest(silent(), added).await;
        assert!(matches!(result, Err(BoxliteError::Unsupported(_))));
        assert_eq!(
            (
                *served.guest_init_calls.lock().unwrap(),
                *served.container_init_calls.lock().unwrap()
            ),
            (0, 0)
        );
    }
}

//! Task: Guest initialization.
//!
//! Configures the guest and creates its container. For boots that do not
//! need attach-before-start, Bootstrap also releases the container's init.

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
use boxlite_shared::{
    ContainerDevice, ContainerInitRequest, ContainerResources, GuestBootstrapRequest,
    GuestInitRequest,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

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

/// Bootstrap may start init, so fields introduced after its first release
/// must be version-checked before sending the request.
const FIRST_BOOTSTRAP_GUEST_VERSION: crate::portal::interfaces::guest::GuestVersion = (0, 15, 0);

pub struct GuestInitTask {
    pub auto_start: bool,
    pub started: Arc<AtomicBool>,
}

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

        let started = run_guest_init(guest_session.clone(), bootstrap, self.auto_start)
            .await
            .inspect_err(|e| log_task_error(&box_id, task_name, e))?;
        self.started.store(started, Ordering::Relaxed);

        let mut ctx = ctx.lock().await;
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

/// Returns whether Bootstrap also started the container.
async fn run_guest_init(
    guest_session: GuestSession,
    bootstrap: GuestBootstrapConfig,
    auto_start: bool,
) -> BoxliteResult<bool> {
    let mut guest_interface = guest_session.guest().await?;
    let advanced = &bootstrap.container.advanced;
    let minimum = [
        (!advanced.capabilities.is_empty()).then_some(MIN_CAPABILITY_GUEST_VERSION),
        // Older guests silently retain hardened defaults in privileged mode.
        advanced
            .linux
            .readonly_paths
            .is_empty()
            .then_some(MIN_PRIVILEGED_CONTAINER_GUEST_VERSION),
        (!bootstrap.container.devices.is_empty()).then_some(MIN_DEVICE_GUEST_VERSION),
    ]
    .into_iter()
    .flatten()
    .max();
    if let Some(minimum) = minimum.filter(|&version| version > FIRST_BOOTSTRAP_GUEST_VERSION) {
        guest_interface.require_min_version(minimum).await?;
    }
    let needs_safe_subpaths = requires_safe_volume_sub_path(&bootstrap.container.mounts);
    let guest_init = GuestInitRequest::from(bootstrap.guest);
    let container_init = ContainerInitRequest::from(bootstrap.container);
    let started = guest_interface
        .bootstrap(GuestBootstrapRequest {
            guest_init: Some(guest_init.clone()),
            container_init: Some(container_init.clone()),
            auto_start,
        })
        .await?;

    // Bootstrap supplies version and capabilities inline. On legacy guests,
    // only the checks that apply to this request need Ping before either Init.
    if let Some(minimum) = minimum.filter(|&version| version <= FIRST_BOOTSTRAP_GUEST_VERSION) {
        guest_interface.require_min_version(minimum).await?;
    }
    if needs_safe_subpaths {
        guest_interface.require_safe_volume_sub_path().await?;
    }
    if let Some(started) = started {
        return Ok(started);
    }

    guest_interface.init(guest_init).await?;
    guest_session
        .container()
        .await?
        .init(container_init)
        .await?;
    Ok(false)
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
        guest_init_calls: Arc<std::sync::Mutex<usize>>,
        container_init_calls: Arc<std::sync::Mutex<usize>>,
    }

    #[tonic::async_trait]
    impl boxlite_shared::Guest for VersionedGuest {
        async fn bootstrap(
            &self,
            _: tonic::Request<GuestBootstrapRequest>,
        ) -> Result<tonic::Response<boxlite_shared::GuestBootstrapResponse>, tonic::Status>
        {
            Err(tonic::Status::unimplemented("legacy guest"))
        }

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
            let container_id = request.into_inner().container_id;
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

    async fn run_with_guest_version(
        version: &'static str,
        safe_managed_volume_sub_path: bool,
    ) -> (BoxliteResult<()>, usize, usize) {
        let guest_init_calls = Arc::new(std::sync::Mutex::new(0));
        let container_init_calls = Arc::new(std::sync::Mutex::new(0));
        let guest = VersionedGuest {
            version,
            safe_managed_volume_sub_path,
            guest_init_calls: Arc::clone(&guest_init_calls),
            container_init_calls: Arc::clone(&container_init_calls),
        };
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
            bootstrap_for_version_gate(),
            false,
        )
        .await
        .map(|_| ());
        let guest_calls = *guest_init_calls.lock().unwrap();
        let container_calls = *container_init_calls.lock().unwrap();
        (result, guest_calls, container_calls)
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
}

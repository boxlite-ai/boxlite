//! Container service interface.

use boxlite_shared::{
    BindMount, BoxliteError, BoxliteResult, CaCert,
    ContainerAdvancedOptions as ProtoContainerAdvancedOptions,
    ContainerCapabilities as ProtoContainerCapabilities, ContainerClient,
    ContainerConfig as ProtoContainerConfig, ContainerDevice, ContainerInitErrorKind,
    ContainerInitRequest, DiskRootfs, MergedRootfs, OverlayRootfs, RootfsInit,
    container_init_response,
};
use tonic::transport::Channel;

use crate::images::ContainerImageConfig;
use crate::runtime::advanced_options::ContainerCapabilities;
use crate::volumes::ContainerMount;

/// Container rootfs initialization strategy.
/// Guest constructs paths from container_id using its own layout knowledge.
#[derive(Debug, Clone)]
pub enum ContainerRootfsInitConfig {
    /// Single merged rootfs - guest constructs path from container_id
    #[allow(dead_code)] // Reserved for future merged rootfs mode
    Merged,
    /// Overlayfs from multiple layers - guest constructs paths from container_id and layer_names
    #[allow(dead_code)] // Reserved for future overlayfs mode
    Overlay {
        /// Layer directory names (e.g., "sha256-abc123")
        layer_names: Vec<String>,
        /// Whether to copy layers to disk before overlayfs (default: true)
        copy_layers: bool,
    },
    /// Disk-based rootfs - block device mounted directly as container rootfs
    DiskImage {
        /// Block device path (e.g., "/dev/vda")
        device: String,
        /// Whether to format the device before mounting
        need_format: bool,
        /// Whether to resize filesystem after mounting to fill disk
        need_resize: bool,
    },
}

impl ContainerRootfsInitConfig {
    pub(crate) fn into_proto(self) -> RootfsInit {
        match self {
            ContainerRootfsInitConfig::Merged => RootfsInit {
                strategy: Some(boxlite_shared::rootfs_init::Strategy::Merged(
                    MergedRootfs {},
                )),
            },
            ContainerRootfsInitConfig::Overlay {
                layer_names,
                copy_layers,
            } => RootfsInit {
                strategy: Some(boxlite_shared::rootfs_init::Strategy::Overlay(
                    OverlayRootfs {
                        layer_names,
                        copy_layers,
                    },
                )),
            },
            ContainerRootfsInitConfig::DiskImage {
                device,
                need_format,
                need_resize,
            } => RootfsInit {
                strategy: Some(boxlite_shared::rootfs_init::Strategy::Disk(DiskRootfs {
                    device,
                    need_format,
                    need_resize,
                })),
            },
        }
    }
}

/// Everything needed to create one container in the guest.
///
/// Keeping this as a request object makes the host-to-guest boundary explicit
/// and prevents each new container option from widening [`ContainerInterface::init`].
pub struct ContainerInitConfig {
    pub container_id: String,
    pub image: ContainerImageConfig,
    pub rootfs: ContainerRootfsInitConfig,
    pub mounts: Vec<ContainerMount>,
    pub ca_certs: Vec<String>,
    pub tty: bool,
    /// Guest device nodes to reproduce inside the OCI workload.
    pub devices: Vec<ContainerDevice>,
    pub advanced: ContainerAdvancedConfig,
}

/// Expert-only options crossing the host-to-guest container boundary.
pub struct ContainerAdvancedConfig {
    pub capabilities: ContainerCapabilities,
}

/// Container service interface.
pub struct ContainerInterface {
    client: ContainerClient<Channel>,
}

impl ContainerInterface {
    /// Create from a channel.
    pub fn new(channel: Channel) -> Self {
        Self {
            client: ContainerClient::new(channel),
        }
    }

    /// Create the container — rootfs, image config, mounts. Does **not** run
    /// init; call [`Self::start`] for that. Creation and start are separate so
    /// the host can attach to the main command in between. Returns the
    /// container id on success.
    pub async fn init(&mut self, config: ContainerInitConfig) -> BoxliteResult<String> {
        let ContainerInitConfig {
            container_id,
            image,
            rootfs,
            mounts,
            ca_certs,
            tty,
            devices,
            advanced,
        } = config;

        let proto_config = ProtoContainerConfig {
            entrypoint: image.final_cmd(),
            env: image.env.clone(),
            workdir: image.working_dir.clone(),
            user: image.user.clone(),
            // Not an image property: `run -t` decides it, and init is the
            // process it applies to (OCI `process.terminal`).
            tty,
            advanced: Some(ProtoContainerAdvancedOptions {
                capabilities: Some(ProtoContainerCapabilities {
                    add: advanced.capabilities.add,
                    drop: advanced.capabilities.drop,
                }),
            }),
        };

        // Convert ContainerMount to proto BindMount
        // Uses convention-based paths - guest will construct full path from volume_name
        let proto_mounts: Vec<BindMount> = mounts
            .into_iter()
            .map(|m| BindMount {
                volume_name: m.volume_name,
                destination: m.destination,
                read_only: m.read_only,
                owner_uid: m.owner_uid,
                owner_gid: m.owner_gid,
                subpath: m.subpath.unwrap_or_default(),
            })
            .collect();

        tracing::debug!(container_id = %container_id, "Sending ContainerInit request");
        tracing::trace!(
            container_id = %container_id,
            entrypoint = ?image.entrypoint,
            cmd = ?image.cmd,
            user = %image.user,
            workdir = %image.working_dir,
            env_count = image.env.len(),
            advanced = ?proto_config.advanced,
            rootfs = ?rootfs,
            mounts_count = proto_mounts.len(),
            device_count = devices.len(),
            "Container configuration"
        );

        let request = ContainerInitRequest {
            container_id: container_id.clone(),
            container_config: Some(proto_config),
            rootfs: Some(rootfs.into_proto()),
            mounts: proto_mounts,
            ca_certs: ca_certs.into_iter().map(|pem| CaCert { pem }).collect(),
            // Init's session id = container_id. The host declares it here so
            // `LiteBox::attach()` can address the main command with the same id
            // it sent, instead of both sides separately hard-coding it.
            execution_id: container_id.clone(),
            devices,
        };

        let response = self
            .client
            .init(request)
            .await
            .map_err(map_container_init_status)?
            .into_inner();

        match response.result {
            Some(container_init_response::Result::Success(success)) => {
                tracing::debug!(container_id = %success.container_id, "Container initialized");
                Ok(success.container_id)
            }
            Some(container_init_response::Result::Error(err)) => {
                tracing::error!(container_id = %container_id, "Container init failed: {}", err.reason);
                let reason = format!("Container init failed: {}", err.reason);
                match ContainerInitErrorKind::try_from(err.kind) {
                    Ok(ContainerInitErrorKind::Unsupported) => {
                        Err(BoxliteError::Unsupported(reason))
                    }
                    _ => Err(BoxliteError::Internal(reason)),
                }
            }
            None => Err(BoxliteError::Internal(
                "ContainerInit response missing result".to_string(),
            )),
        }
    }

    /// Run the init process of a created container.
    ///
    /// The second half of docker's create → attach → start: the caller has
    /// attached to the main command's session, so nothing it prints and no code
    /// it exits with can be missed, however fast it finishes.
    pub async fn start(&mut self, container_id: &str) -> BoxliteResult<()> {
        use boxlite_shared::{ContainerStartRequest, container_start_response};

        let response = match self
            .client
            .start(ContainerStartRequest {
                container_id: container_id.to_string(),
            })
            .await
        {
            Ok(response) => response.into_inner(),
            // A guest agent that predates #988 has no `Container.Start`; tonic
            // answers the unknown method with `Unimplemented`. On that agent the
            // fused `Container.Init` — still called on every boot — already
            // started the container, so `Start` is a redundant no-op here.
            // Treat it as started rather than surfacing a cryptic gRPC error;
            // the code must be read before `?` flattens it into `Rpc(String)`.
            // (Recreate the box to regain attach-before-start semantics.)
            Err(status) if status.code() == tonic::Code::Unimplemented => {
                tracing::warn!(
                    container_id = %container_id,
                    "guest agent predates Container.Start (pre-#988); its Init already \
                     started the container — treating as started"
                );
                return Ok(());
            }
            Err(status) => return Err(status.into()),
        };

        match response.result {
            Some(container_start_response::Result::Success(_)) => {
                tracing::debug!(container_id = %container_id, "Container started");
                Ok(())
            }
            Some(container_start_response::Result::Error(err)) => {
                tracing::error!(container_id = %container_id, "Container start failed: {}", err.reason);
                Err(BoxliteError::Internal(format!(
                    "Container start failed: {}",
                    err.reason
                )))
            }
            None => Err(BoxliteError::Internal(
                "ContainerStart response missing result".to_string(),
            )),
        }
    }
}

fn map_container_init_status(status: tonic::Status) -> BoxliteError {
    if status.code() == tonic::Code::InvalidArgument {
        return BoxliteError::InvalidArgument(status.message().to_owned());
    }
    status.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite_shared::{
        Container as ContainerService, ContainerInitRequest, ContainerInitResponse,
        ContainerInitSuccess, ContainerServer, ContainerStartRequest, ContainerStartResponse,
        ContainerStartSuccess, container_init_response, container_start_response,
    };
    use std::sync::{Arc, Mutex};
    use tonic::transport::{Endpoint, Server};
    use tonic::{Request, Response, Status};

    #[test]
    fn container_init_preserves_invalid_argument_status() {
        let error = map_container_init_status(Status::invalid_argument(
            "unknown Linux capability 'CAP_FUTURE'",
        ));

        assert!(matches!(error, BoxliteError::InvalidArgument(_)));
        assert_eq!(error.http().0, 400);
    }

    /// How the stub guest answers `Container.Start`.
    #[derive(Clone, Copy)]
    enum StartReply {
        /// Emulates a pre-#988 agent that lacks the method: tonic answers an
        /// unknown method with `Unimplemented` (empty message).
        Unimplemented,
        /// A genuine server-side failure that must NOT be swallowed.
        RealError,
        /// A current agent that starts the container.
        Success,
    }

    struct StubGuest {
        start_reply: StartReply,
        /// Last `Container.Init` request the stub saw, for wire assertions.
        seen_init: Arc<Mutex<Option<ContainerInitRequest>>>,
    }

    #[tonic::async_trait]
    impl ContainerService for StubGuest {
        async fn init(
            &self,
            request: Request<ContainerInitRequest>,
        ) -> Result<Response<ContainerInitResponse>, Status> {
            let request = request.into_inner();
            let container_id = request.container_id.clone();
            *self.seen_init.lock().unwrap() = Some(request);
            Ok(Response::new(ContainerInitResponse {
                result: Some(container_init_response::Result::Success(
                    ContainerInitSuccess { container_id },
                )),
            }))
        }

        async fn start(
            &self,
            request: Request<ContainerStartRequest>,
        ) -> Result<Response<ContainerStartResponse>, Status> {
            let container_id = request.into_inner().container_id;
            match self.start_reply {
                StartReply::Unimplemented => Err(Status::unimplemented("")),
                StartReply::RealError => Err(Status::internal("guest blew up")),
                StartReply::Success => Ok(Response::new(ContainerStartResponse {
                    result: Some(container_start_response::Result::Success(
                        ContainerStartSuccess { container_id },
                    )),
                })),
            }
        }
    }

    /// Serve `StubGuest` on an ephemeral loopback port and return a
    /// `ContainerInterface` wired to it.
    async fn interface_for(start_reply: StartReply) -> ContainerInterface {
        interface_recording(start_reply, Arc::new(Mutex::new(None))).await
    }

    async fn interface_recording(
        start_reply: StartReply,
        seen_init: Arc<Mutex<Option<ContainerInitRequest>>>,
    ) -> ContainerInterface {
        // Bind with std to learn a free port, then hand the address to tonic.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        tokio::spawn(async move {
            Server::builder()
                .add_service(ContainerServer::new(StubGuest {
                    start_reply,
                    seen_init,
                }))
                .serve(addr)
                .await
                .unwrap();
        });

        let endpoint = Endpoint::from_shared(format!("http://{addr}")).unwrap();
        let mut attempts = 0;
        let channel = loop {
            match endpoint.connect().await {
                Ok(channel) => break channel,
                Err(e) => {
                    attempts += 1;
                    assert!(
                        attempts < 100,
                        "stub guest never accepted a connection: {e}"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }
        };
        ContainerInterface::new(channel)
    }

    /// #988 regression: a guest agent that predates `Container.Start` answers
    /// with gRPC `Unimplemented`. Its fused `Container.Init` already started the
    /// container, so the host must treat the missing method as "already started"
    /// rather than surfacing `code=16`. Without the degrade this returns
    /// `BoxliteError::Rpc` and the restarted box fails to come up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn container_start_tolerates_unimplemented_from_legacy_guest() {
        let mut iface = interface_for(StartReply::Unimplemented).await;
        let result = iface.start("box-legacy").await;
        assert!(
            result.is_ok(),
            "legacy guest (Start Unimplemented) must be tolerated, got {result:?}"
        );
    }

    /// The degrade must be narrow: a real server-side error on `Start` still
    /// surfaces as an error, never swallowed as "started".
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn container_start_propagates_real_error() {
        let mut iface = interface_for(StartReply::RealError).await;
        let result = iface.start("box-broken").await;
        assert!(
            result.is_err(),
            "a real Start error must not be swallowed: {result:?}"
        );
    }

    /// Normal path against a current guest is unaffected.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn container_start_ok_on_success() {
        let mut iface = interface_for(StartReply::Success).await;
        assert!(iface.start("box-ok").await.is_ok());
    }

    /// Devices are container-scoped, so they must reach the guest on the
    /// request itself rather than inside the process config — and init's
    /// session id must equal the container id, the rule `LiteBox::attach()`
    /// relies on. Asserted on what actually crossed the wire.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn container_init_sends_devices_and_session_id() {
        let seen = Arc::new(Mutex::new(None));
        let mut iface = interface_recording(StartReply::Success, Arc::clone(&seen)).await;

        iface
            .init(ContainerInitConfig {
                container_id: "container-1".to_string(),
                image: crate::images::ContainerImageConfig::default(),
                rootfs: ContainerRootfsInitConfig::Merged,
                mounts: Vec::new(),
                ca_certs: Vec::new(),
                tty: true,
                devices: vec![ContainerDevice {
                    source: "/dev/kvm".to_string(),
                    destination: "/dev/kvm".to_string(),
                    file_mode: Some(0o666),
                }],
                advanced: ContainerAdvancedConfig {
                    capabilities: Default::default(),
                },
            })
            .await
            .unwrap();

        let request = seen.lock().unwrap().take().expect("guest saw Init");
        assert_eq!(request.devices.len(), 1);
        assert_eq!(request.devices[0].destination, "/dev/kvm");
        assert_eq!(request.devices[0].file_mode, Some(0o666));
        assert_eq!(request.container_id, "container-1");
        assert_eq!(request.execution_id, "container-1");
        // Non-default, so it proves the field is threaded rather than defaulted.
        assert!(request.container_config.expect("process config").tty);
    }
}

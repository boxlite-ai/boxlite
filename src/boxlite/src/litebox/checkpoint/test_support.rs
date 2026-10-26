//! Test doubles for checkpoint flows: a guest agent served over the box's
//! own socket, and synthetic KRUNVM images.

use super::GuestIdentity;
use super::archive::{
    self, BootRecord, DeviceLayout, DiskLayout, ImageRecord, Manifest, ShareLayout, VsockPort,
};
use crate::images::ContainerImageConfig;
use crate::runtime::constants::mount_tags;
use crate::runtime::options::{BoxOptions, NetworkSpec};
use boxlite_shared::constants::network::{GUEST_AGENT_PORT, GUEST_READY_PORT};
use boxlite_shared::{
    AttachRequest, ExecRequest, ExecResponse, ExecStdin, Execution, ExecutionServer, KillRequest,
    KillResponse, ResizeTtyRequest, ResizeTtyResponse, SendInputAck, WaitRequest, WaitResponse,
};
use boxlite_shared::{
    Container, ContainerInitRequest, ContainerInitResponse, ContainerRunningState, ContainerServer,
    ContainerStartRequest, ContainerStartResponse, Guest, GuestInitRequest, GuestInitResponse,
    GuestServer, PingRequest, PingResponse, QuiesceRequest, QuiesceResponse, RunningStateRequest,
    RunningStateResponse, ShutdownRequest, ShutdownResponse, ThawRequest, ThawResponse,
};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tonic::{Request, Response, Status};

/// A guest agent that reports `boot_id` and one container, and records
/// every RPC it receives.
pub(crate) struct FakeGuest {
    pub(crate) boot_id: Mutex<String>,
    pub(crate) container_id: String,
    pub(crate) init_pid: u32,
    calls: Mutex<Vec<String>>,
}

impl FakeGuest {
    pub(crate) fn new(container_id: &str) -> Arc<Self> {
        Arc::new(Self {
            boot_id: Mutex::new("boot-1".into()),
            container_id: container_id.into(),
            init_pid: 42,
            calls: Mutex::new(Vec::new()),
        })
    }

    pub(crate) fn identity(&self) -> GuestIdentity {
        GuestIdentity {
            boot_id: self.boot_id.lock().unwrap().clone(),
            container_id: self.container_id.clone(),
            init_pid: self.init_pid,
        }
    }

    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    // Used by the resume tests, which run where checkpoints do.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    pub(crate) fn called(&self, name: &str) -> bool {
        self.calls().iter().any(|call| call == name)
    }

    fn call(&self, name: impl Into<String>) {
        self.calls.lock().unwrap().push(name.into());
    }
}

#[derive(Clone)]
struct Service(Arc<FakeGuest>);

#[tonic::async_trait]
impl Guest for Service {
    async fn init(
        &self,
        _: Request<GuestInitRequest>,
    ) -> Result<Response<GuestInitResponse>, Status> {
        self.0.call("Guest.Init");
        Err(Status::unimplemented("fake guest"))
    }
    async fn ping(&self, _: Request<PingRequest>) -> Result<Response<PingResponse>, Status> {
        self.0.call("Guest.Ping");
        Ok(Response::new(PingResponse {
            version: "0.0.0".into(),
        }))
    }
    async fn shutdown(
        &self,
        _: Request<ShutdownRequest>,
    ) -> Result<Response<ShutdownResponse>, Status> {
        self.0.call("Guest.Shutdown");
        Ok(Response::new(ShutdownResponse {}))
    }
    async fn quiesce(
        &self,
        _: Request<QuiesceRequest>,
    ) -> Result<Response<QuiesceResponse>, Status> {
        self.0.call("Guest.Quiesce");
        Err(Status::unimplemented("fake guest"))
    }
    async fn thaw(&self, _: Request<ThawRequest>) -> Result<Response<ThawResponse>, Status> {
        self.0.call("Guest.Thaw");
        Err(Status::unimplemented("fake guest"))
    }
    async fn running_state(
        &self,
        _: Request<RunningStateRequest>,
    ) -> Result<Response<RunningStateResponse>, Status> {
        self.0.call("Guest.RunningState");
        Ok(Response::new(RunningStateResponse {
            boot_id: self.0.boot_id.lock().unwrap().clone(),
            agent_version: "0.0.0".into(),
            initialized: true,
            containers: vec![ContainerRunningState {
                container_id: self.0.container_id.clone(),
                running: true,
                init_pid: self.0.init_pid,
            }],
            executions: Vec::new(),
        }))
    }
}

#[tonic::async_trait]
impl Container for Service {
    async fn init(
        &self,
        _: Request<ContainerInitRequest>,
    ) -> Result<Response<ContainerInitResponse>, Status> {
        self.0.call("Container.Init");
        Err(Status::unimplemented("fake guest"))
    }
    async fn start(
        &self,
        _: Request<ContainerStartRequest>,
    ) -> Result<Response<ContainerStartResponse>, Status> {
        self.0.call("Container.Start");
        Err(Status::unimplemented("fake guest"))
    }
}

/// Exec sessions: an attach streams nothing and ends; a wait reports exit 7.
#[tonic::async_trait]
impl Execution for Service {
    async fn exec(&self, _: Request<ExecRequest>) -> Result<Response<ExecResponse>, Status> {
        self.0.call("Execution.Exec");
        Err(Status::unimplemented("fake guest"))
    }
    type AttachStream = futures::stream::Empty<Result<boxlite_shared::ExecOutput, Status>>;
    async fn attach(
        &self,
        request: Request<AttachRequest>,
    ) -> Result<Response<Self::AttachStream>, Status> {
        self.0.call(format!(
            "Execution.Attach:{}",
            request.into_inner().execution_id
        ));
        Ok(Response::new(futures::stream::empty()))
    }
    async fn send_input(
        &self,
        _: Request<tonic::Streaming<ExecStdin>>,
    ) -> Result<Response<SendInputAck>, Status> {
        Err(Status::unimplemented("fake guest"))
    }
    async fn wait(&self, request: Request<WaitRequest>) -> Result<Response<WaitResponse>, Status> {
        self.0.call(format!(
            "Execution.Wait:{}",
            request.into_inner().execution_id
        ));
        Ok(Response::new(WaitResponse {
            exit_code: 7,
            ..Default::default()
        }))
    }
    async fn kill(&self, _: Request<KillRequest>) -> Result<Response<KillResponse>, Status> {
        Err(Status::unimplemented("fake guest"))
    }
    async fn resize_tty(
        &self,
        _: Request<ResizeTtyRequest>,
    ) -> Result<Response<ResizeTtyResponse>, Status> {
        Err(Status::unimplemented("fake guest"))
    }
}

/// Serve `guest` on the Unix socket `socket` (the box's guest transport).
pub(crate) fn serve_guest(socket: &Path, guest: Arc<FakeGuest>) -> tokio::task::JoinHandle<()> {
    let _ = std::fs::remove_file(socket);
    let listener = tokio::net::UnixListener::bind(socket).expect("bind fake guest");
    let incoming = futures::stream::unfold(listener, |listener| async move {
        let accepted = listener.accept().await.map(|(stream, _)| stream);
        Some((accepted, listener))
    });
    tokio::spawn(async move {
        let service = Service(guest);
        let _ = tonic::transport::Server::builder()
            .add_service(GuestServer::new(service.clone()))
            .add_service(ContainerServer::new(service.clone()))
            .add_service(ExecutionServer::new(service))
            .serve_with_incoming(incoming)
            .await;
    })
}

/// Sizes of the synthetic image's parts.
pub(crate) const RAM: u64 = 4096;
pub(crate) const DISKS: [u64; 2] = [8192, 4096];
pub(crate) const SHARE_PAYLOADS: u64 = 100;

/// The layout of a VM booted for `options` (see [`DeviceLayout::check_for`]).
pub(crate) fn layout_for(options: &BoxOptions) -> DeviceLayout {
    let mut shares = vec![ShareLayout {
        tag: mount_tags::SHARED.into(),
        read_only: false,
        dax_bytes: crate::vmm::checkpoint::DAX_WINDOW_BYTES,
    }];
    shares.extend(
        options
            .volumes
            .iter()
            .enumerate()
            .map(|(i, volume)| ShareLayout {
                tag: archive::volume_tag(i),
                read_only: volume.read_only,
                dax_bytes: crate::vmm::checkpoint::DAX_WINDOW_BYTES,
            }),
    );
    DeviceLayout {
        vcpus: usize::from(
            options
                .cpus
                .unwrap_or(crate::runtime::constants::vm_defaults::DEFAULT_CPUS),
        ),
        ram_bytes: RAM,
        disks: vec![
            DiskLayout {
                read_only: false,
                bytes: DISKS[0],
            },
            DiskLayout {
                read_only: true,
                bytes: DISKS[1],
            },
        ],
        shares,
        vm_owned_shares: 1,
        nic_mac: matches!(options.network, NetworkSpec::Enabled { .. })
            .then_some(crate::net::constants::GUEST_MAC),
        vsock_ports: vec![
            VsockPort {
                port: GUEST_AGENT_PORT,
                listen: true,
            },
            VsockPort {
                port: GUEST_READY_PORT,
                listen: false,
            },
        ],
    }
}

/// A KRUNVM v8 image with `layout`'s devices and zeroed payloads.
pub(crate) fn image_for(layout: &DeviceLayout) -> Vec<u8> {
    let mut devices: Vec<_> = layout
        .shares
        .iter()
        .map(|share| {
            let dax = (share.dax_bytes > 0)
                .then(|| serde_json::json!({"gpa": 1u64 << 40, "len": share.dax_bytes}));
            serde_json::json!({"tag": share.tag, "read_only": share.read_only, "vm_owned": false, "dax": dax})
        })
        .collect();
    devices
        .extend((0..layout.vm_owned_shares).map(
            |_| serde_json::json!({"tag": "/dev/root", "read_only": false, "vm_owned": true}),
        ));
    let metadata = serde_json::json!({
        "cpus": vec![serde_json::json!({}); layout.vcpus],
        "regions": [{"gpa": 0, "len": layout.ram_bytes, "attributes": 0}],
        "disks": layout.disks.iter().map(|disk| serde_json::json!({
            "read_only": disk.read_only, "disk_bytes": disk.bytes,
        })).collect::<Vec<_>>(),
        "nic": layout.nic_mac.map(|mac| serde_json::json!({"mac": mac})),
        "vsock": {"ports": layout.vsock_ports},
        "fs": {"devices": devices},
    });
    let json = serde_json::to_vec(&metadata).unwrap();
    let mut image = b"KRUNVM\0\0".to_vec();
    image.extend_from_slice(&8u32.to_le_bytes());
    image.extend_from_slice(&(json.len() as u32).to_le_bytes());
    image.extend_from_slice(&json);
    let payload = layout.ram_bytes + layout.disks.iter().map(|d| d.bytes).sum::<u64>();
    image.resize(image.len() + (payload + SHARE_PAYLOADS) as usize, 0);
    image
}

/// A checkpoint of a box with `options` and `guest`, written to `path`;
/// returns its manifest.
pub(crate) fn write_checkpoint(
    path: &Path,
    options: &BoxOptions,
    guest: GuestIdentity,
    image: &[u8],
) -> Manifest {
    let raw = path.with_extension("raw");
    std::fs::write(&raw, image).unwrap();
    let (length, sha256) = archive::digest(&raw).unwrap();
    let (layout, _) = archive::read_image_layout(&raw).unwrap();
    let manifest = Manifest {
        format: archive::FORMAT.into(),
        version: archive::VERSION,
        created_at: chrono::Utc::now(),
        source_box_id: "source".into(),
        guest,
        image: ImageRecord {
            krunvm_version: archive::KRUNVM_VERSION,
            length,
            sha256,
        },
        layout,
        boot: BootRecord {
            options: options.clone(),
            outbound_policy: None,
            container_image_config: ContainerImageConfig::default(),
        },
    };
    let mut out = std::fs::File::create(path).unwrap();
    archive::write(&mut out, &manifest, &raw).unwrap();
    std::fs::remove_file(&raw).unwrap();
    manifest
}

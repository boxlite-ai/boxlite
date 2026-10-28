//! Test doubles for checkpoint flows: a guest agent served over the box's
//! own socket, and synthetic KRUNVM images.

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use super::GuestIdentity;
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

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
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

use super::*;
use crate::disk::DiskFormat;
use crate::litebox::ssh::*;
use crate::litebox::{
    BoxState,
    config::{BoxConfig, ContainerRuntimeConfig},
};
use crate::runtime::rt_impl::RuntimeImpl;
use crate::vmm::controller::VmmMetrics;
use crate::{BoxIDMint, BoxOptions, BoxStatus, BoxliteOptions, ContainerID};
use boxlite_shared as proto;
use std::sync::Mutex;
use tonic::{Request, Response, Status};

#[derive(Default)]
struct Mock {
    requests: Mutex<Vec<&'static str>>,
    config: Mutex<Option<proto::SshConfig>>,
    error: Mutex<Option<tonic::Code>>,
    missing: Mutex<bool>,
    block: Mutex<bool>,
    entered: tokio::sync::Notify,
    start_entered: tokio::sync::Notify,
    start_release: tokio::sync::Notify,
    start_block: Mutex<bool>,
    start_fail: Mutex<bool>,
}

impl Mock {
    #[expect(
        clippy::result_large_err,
        reason = "mock returns the tonic service error type"
    )]
    async fn reply(&self, name: &'static str) -> Result<Option<proto::SshStatus>, Status> {
        self.requests.lock().unwrap().push(name);
        self.entered.notify_one();
        let block = *self.block.lock().unwrap();
        if block {
            std::future::pending::<()>().await;
        }
        if let Some(code) = *self.error.lock().unwrap() {
            return Err(Status::new(code, "mock rejection"));
        }
        Ok((!*self.missing.lock().unwrap()).then(|| proto::SshStatus {
            enabled: true,
            generation: 7,
            listen_address: "0.0.0.0:2222".into(),
            host_public_key: "public host".into(),
            host_key_fingerprint: "SHA256:test".into(),
        }))
    }
}

struct MockService(Arc<Mock>);

#[tonic::async_trait]
impl proto::Ssh for MockService {
    async fn configure(
        &self,
        request: Request<proto::SshConfigureRequest>,
    ) -> Result<Response<proto::SshConfigureResponse>, Status> {
        *self.0.config.lock().unwrap() = request.into_inner().config;
        Ok(Response::new(proto::SshConfigureResponse {
            status: self.0.reply("configure").await?,
        }))
    }
    async fn status(
        &self,
        _: Request<proto::SshStatusRequest>,
    ) -> Result<Response<proto::SshStatusResponse>, Status> {
        Ok(Response::new(proto::SshStatusResponse {
            status: self.0.reply("status").await?,
        }))
    }
    async fn disable(
        &self,
        _: Request<proto::SshDisableRequest>,
    ) -> Result<Response<proto::SshDisableResponse>, Status> {
        Ok(Response::new(proto::SshDisableResponse {
            status: self.0.reply("disable").await?,
        }))
    }
}

#[tonic::async_trait]
impl proto::Container for MockService {
    async fn init(
        &self,
        _: Request<proto::ContainerInitRequest>,
    ) -> Result<Response<proto::ContainerInitResponse>, Status> {
        unreachable!("fixture already has an initialized LiveState")
    }

    async fn start(
        &self,
        request: Request<proto::ContainerStartRequest>,
    ) -> Result<Response<proto::ContainerStartResponse>, Status> {
        self.0.start_entered.notify_one();
        let block = *self.0.start_block.lock().unwrap();
        if block {
            self.0.start_release.notified().await;
        }
        if *self.0.start_fail.lock().unwrap() {
            return Err(Status::internal("injected Container.Start failure"));
        }
        Ok(Response::new(proto::ContainerStartResponse {
            result: Some(proto::container_start_response::Result::Success(
                proto::ContainerStartSuccess {
                    container_id: request.into_inner().container_id,
                },
            )),
        }))
    }
}

struct TestHandler;
impl VmmHandler for TestHandler {
    fn stop(&mut self) -> BoxliteResult<()> {
        Ok(())
    }
    fn metrics(&self) -> BoxliteResult<VmmMetrics> {
        Ok(VmmMetrics::default())
    }
    fn is_running(&self) -> bool {
        true
    }
    fn pid(&self) -> u32 {
        0
    }
}

struct Fixture {
    ssh: SshHandle,
    backend: Arc<BoxImpl>,
    mock: Arc<Mock>,
    server: tokio::task::JoinHandle<()>,
    _home: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn fixture() -> Fixture {
    fixture_with_container(true).await
}

async fn fixture_with_container(started: bool) -> Fixture {
    let home = tempfile::TempDir::new_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().into(),
        image_registries: vec![],
    })
    .unwrap();
    let id = BoxIDMint::mint();
    let config = BoxConfig {
        box_home: runtime.layout.boxes_dir().join(id.as_str()),
        id,
        name: None,
        created_at: chrono::Utc::now(),
        container: ContainerRuntimeConfig {
            id: ContainerID::new(),
        },
        options: BoxOptions::default(),
        engine_kind: crate::vmm::VmmKind::Libkrun,
    };
    let mut state = BoxState::new();
    state.status = BoxStatus::Running;
    state.pid = Some(std::process::id());
    let backend = Arc::new(BoxImpl::new(
        config,
        state,
        runtime.clone(),
        runtime.shutdown_token.child_token(),
    ));
    let live = LiveState::new(
        Box::new(TestHandler),
        GuestSession::new(backend.config.transport()),
        None,
        None,
        BoxMetricsStorage::new(),
        Disk::new(home.path().join("container.qcow2"), DiskFormat::Qcow2, true),
        None,
        #[cfg(target_os = "linux")]
        None,
    );
    assert!(backend.live.set(live).is_ok());
    if started {
        backend.container_start.set(()).unwrap();
    }
    std::fs::create_dir_all(backend.layout.sockets().real_dir()).unwrap();
    backend.layout.sockets().ensure().unwrap();
    let proto::BoxTransport::Unix { socket_path } = backend.config.transport() else {
        unreachable!()
    };
    let listener = tokio::net::UnixListener::bind(socket_path).unwrap();
    let incoming = futures::stream::unfold(listener, |listener| async {
        Some((listener.accept().await.map(|(stream, _)| stream), listener))
    });
    let mock = Arc::new(Mock::default());
    let service = mock.clone();
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(proto::ContainerServer::new(MockService(service.clone())))
            .add_service(proto::SshServer::new(MockService(service)))
            .serve_with_incoming(incoming)
            .await
            .unwrap();
    });
    let ssh = SshHandle::new(backend.clone());
    Fixture {
        ssh,
        backend,
        mock,
        server,
        _home: home,
    }
}

fn config() -> SshConfig {
    SshConfig {
        listen_address: "0.0.0.0:2222".into(),
        host_private_key: "private sentinel".into(),
        accounts: vec![SshAccount {
            login: "alice".into(),
            authorized_keys: vec!["authorized sentinel".into()],
            ca: Some(SshCaConfig {
                public_key: "ca sentinel".into(),
                principal: "principal sentinel".into(),
            }),
        }],
    }
}

#[tokio::test]
async fn ssh_requests_and_responses_cross_wire() {
    let f = fixture().await;
    let status = f.ssh.configure(config()).await.unwrap();
    assert_eq!(
        status,
        SshStatus {
            enabled: true,
            generation: 7,
            listen_address: "0.0.0.0:2222".into(),
            host_public_key: "public host".into(),
            host_key_fingerprint: "SHA256:test".into()
        }
    );
    assert_eq!(f.ssh.status().await.unwrap(), status);
    assert_eq!(f.ssh.disable().await.unwrap(), status);
    let received = f.mock.config.lock().unwrap().clone().unwrap();
    assert_eq!(received.listen_address, "0.0.0.0:2222");
    assert_eq!(received.host_private_key, "private sentinel");
    assert_eq!(received.accounts[0].login, "alice");
    assert_eq!(
        received.accounts[0].authorized_keys,
        ["authorized sentinel"]
    );
    let ca = received.accounts[0].ca.as_ref().unwrap();
    assert_eq!(ca.public_key, "ca sentinel");
    assert_eq!(ca.principal, "principal sentinel");
    assert_eq!(
        *f.mock.requests.lock().unwrap(),
        ["configure", "status", "disable"]
    );
}

#[tokio::test]
async fn ssh_errors_missing_status_and_no_retry() {
    let f = fixture().await;
    for operation in 0..3 {
        for code in [
            tonic::Code::InvalidArgument,
            tonic::Code::FailedPrecondition,
            tonic::Code::Unimplemented,
            tonic::Code::Unavailable,
        ] {
            *f.mock.error.lock().unwrap() = Some(code);
            let error = match operation {
                0 => f.ssh.configure(config()).await,
                1 => f.ssh.status().await,
                _ => f.ssh.disable().await,
            }
            .unwrap_err();
            assert!(match code {
                tonic::Code::InvalidArgument => matches!(error, BoxliteError::InvalidArgument(_)),
                tonic::Code::FailedPrecondition => matches!(error, BoxliteError::InvalidState(_)),
                tonic::Code::Unimplemented => matches!(error, BoxliteError::Unsupported(_)),
                _ => matches!(error, BoxliteError::Rpc(_)),
            });
            assert!(error.to_string().contains("mock rejection"));
        }
        *f.mock.error.lock().unwrap() = None;
        *f.mock.missing.lock().unwrap() = true;
        let error = match operation {
            0 => f.ssh.configure(config()).await,
            1 => f.ssh.status().await,
            _ => f.ssh.disable().await,
        }
        .unwrap_err();
        assert!(matches!(error, BoxliteError::Internal(_)));
        *f.mock.missing.lock().unwrap() = false;
    }
    assert_eq!(f.mock.requests.lock().unwrap().len(), 15);
}

async fn operate(ssh: SshHandle, operation: usize) -> BoxliteResult<SshStatus> {
    match operation {
        0 => ssh.configure(config()).await,
        1 => ssh.status().await,
        _ => ssh.disable().await,
    }
}

#[tokio::test]
async fn ssh_waits_for_container_start_without_charging_rpc_deadline() {
    for operation in 0..3 {
        let f = fixture_with_container(false).await;
        assert!(
            !f.backend.container_start.initialized(),
            "creating a handle must not start"
        );
        *f.mock.start_block.lock().unwrap() = true;
        let call = tokio::spawn(operate(f.ssh.clone(), operation));
        tokio::select! {
            _ = f.mock.start_entered.notified() => {}
            _ = f.mock.entered.notified() => panic!("SSH RPC sent before Container.Start"),
        }
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(6)).await;
        tokio::task::yield_now().await;
        assert!(
            !call.is_finished(),
            "startup must not consume the SSH deadline"
        );
        assert!(f.mock.requests.lock().unwrap().is_empty());
        tokio::time::resume();
        f.mock.start_release.notify_one();
        tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(f.backend.container_start.initialized());
        assert_eq!(f.mock.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn ssh_container_start_failure_sends_no_ssh_rpc() {
    for operation in 0..3 {
        let f = fixture_with_container(false).await;
        *f.mock.start_fail.lock().unwrap() = true;
        let error = operate(f.ssh.clone(), operation).await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("injected Container.Start failure"),
            "{error}"
        );
        assert!(f.mock.requests.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn ssh_shutdown_cancels_container_start() {
    for operation in 0..3 {
        let f = fixture_with_container(false).await;
        *f.mock.start_block.lock().unwrap() = true;
        let call = tokio::spawn(operate(f.ssh.clone(), operation));
        tokio::select! {
            _ = f.mock.start_entered.notified() => {}
            _ = f.mock.entered.notified() => panic!("SSH RPC sent before Container.Start"),
        }
        f.backend.runtime.shutdown_token.cancel();
        let error = tokio::time::timeout(Duration::from_secs(1), call)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, BoxliteError::Stopped(_)));
        assert!(f.mock.requests.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn ssh_spent_and_cancelled_handles_send_nothing() {
    let f = fixture().await;
    f.backend.state.write().status = BoxStatus::Stopped;
    for operation in 0..3 {
        assert!(matches!(
            operate(f.ssh.clone(), operation).await,
            Err(BoxliteError::Stopped(_))
        ));
    }
    f.backend.state.write().status = BoxStatus::Running;
    f.backend.shutdown_token.cancel();
    for operation in 0..3 {
        assert!(matches!(
            operate(f.ssh.clone(), operation).await,
            Err(BoxliteError::Stopped(_))
        ));
    }
    assert!(f.mock.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn ssh_timeout_and_runtime_shutdown() {
    for operation in 0..3 {
        for cancel in [false, true] {
            let f = fixture().await;
            *f.mock.block.lock().unwrap() = true;
            let ssh = f.ssh.clone();
            let call = tokio::spawn(async move {
                match operation {
                    0 => ssh.configure(config()).await,
                    1 => ssh.status().await,
                    _ => ssh.disable().await,
                }
            });
            f.mock.entered.notified().await;
            if cancel {
                f.backend.runtime.shutdown_token.cancel();
            } else {
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(6)).await;
            }
            let error = tokio::time::timeout(Duration::from_millis(100), call)
                .await
                .expect("SSH operation must finish within its 5-second deadline")
                .unwrap()
                .unwrap_err();
            if cancel {
                assert!(matches!(error, BoxliteError::Stopped(_)));
            } else {
                assert!(error.to_string().contains("timed out after 5 seconds"));
                tokio::time::resume();
            }
            assert_eq!(f.mock.requests.lock().unwrap().len(), 1);
        }
    }
}

#[test]
fn ssh_debug_redacts_credentials() {
    let debug = format!("{:?}", config());
    assert!(!debug.contains("sentinel"), "{debug}");
}

#[tokio::test]
async fn ssh_deadline_and_shutdown_include_connection_handshake() {
    for cancel in [false, true] {
        let mut f = fixture().await;
        f.server.abort();
        let _ = (&mut f.server).await;
        let proto::BoxTransport::Unix { socket_path } = f.backend.config.transport() else {
            unreachable!()
        };
        std::fs::remove_file(&socket_path).unwrap();
        let listener = tokio::net::UnixListener::bind(socket_path).unwrap();
        let ssh = f.ssh.clone();
        let call = tokio::spawn(async move { ssh.status().await });
        // Accept the transport but never answer the HTTP/2 handshake.
        let (_connection, _) = listener.accept().await.unwrap();
        if cancel {
            f.backend.runtime.shutdown_token.cancel();
        } else {
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(6)).await;
        }
        let error = tokio::time::timeout(Duration::from_millis(100), call)
            .await
            .expect("SSH operation must finish within its 5-second deadline")
            .unwrap()
            .unwrap_err();
        if cancel {
            assert!(matches!(error, BoxliteError::Stopped(_)));
        } else {
            assert!(error.to_string().contains("timed out after 5 seconds"));
            tokio::time::resume();
        }
        assert!(f.mock.requests.lock().unwrap().is_empty());
    }
}

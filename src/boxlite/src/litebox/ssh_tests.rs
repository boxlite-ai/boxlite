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
    release: tokio::sync::Notify,
    start_entered: tokio::sync::Notify,
    start_release: tokio::sync::Notify,
    start_block: Mutex<bool>,
    start_fail: Mutex<bool>,
}

impl Mock {
    /// Record each RPC before injecting a blocked, rejected, or incomplete response.
    /// The notification lets tests cancel or advance time after the RPC arrives.
    #[expect(
        clippy::result_large_err,
        reason = "mock returns the tonic service error type"
    )]
    async fn reply(&self, name: &'static str) -> Result<Option<proto::SshStatus>, Status> {
        self.requests.lock().unwrap().push(name);
        self.entered.notify_one();
        let block = *self.block.lock().unwrap();
        if block {
            self.release.notified().await;
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
    /// Capture the decoded configuration so assertions cover the serialization boundary.
    async fn configure(
        &self,
        request: Request<proto::SshConfigureRequest>,
    ) -> Result<Response<proto::SshConfigureResponse>, Status> {
        *self.0.config.lock().unwrap() = request.into_inner().config;
        Ok(Response::new(proto::SshConfigureResponse {
            status: self.0.reply("configure").await?,
        }))
    }
    /// Use the shared response controls to exercise status errors and cancellation.
    async fn status(
        &self,
        _: Request<proto::SshStatusRequest>,
    ) -> Result<Response<proto::SshStatusResponse>, Status> {
        Ok(Response::new(proto::SshStatusResponse {
            status: self.0.reply("status").await?,
        }))
    }
    /// Exercise disable's RPC path without simulating guest listener lifecycle.
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
    /// Reject reinitialization: the fixture already represents a booted guest.
    async fn init(
        &self,
        _: Request<proto::ContainerInitRequest>,
    ) -> Result<Response<proto::ContainerInitResponse>, Status> {
        unreachable!("fixture already has an initialized LiveState")
    }

    /// Gate or fail container startup independently of the subsequent SSH request.
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
    /// Allow normal backend cleanup without stopping a real VM.
    fn stop(&mut self) -> BoxliteResult<()> {
        Ok(())
    }
    /// Supply neutral metrics because these tests exercise RPCs, not hypervisor accounting.
    fn metrics(&self) -> BoxliteResult<VmmMetrics> {
        Ok(VmmMetrics::default())
    }
    /// Model a live VM while tests independently control the container's startup state.
    fn is_running(&self) -> bool {
        true
    }
    /// Use a sentinel PID because the fixture never spawns a VMM process.
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
    /// Abort the socket server so blocked mock RPCs do not outlive the fixture.
    fn drop(&mut self) {
        self.server.abort();
    }
}

/// Skip startup to isolate SSH request, response, and deadline behavior.
async fn fixture() -> Fixture {
    fixture_with_container(true).await
}

/// Connect a local box backend to mock guest services over its real Unix socket path.
/// Optionally leave Container.Start pending so tests can observe the startup boundary.
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

/// Populate every credential field with recognizable sentinels for wire and redaction checks.
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

/// Preserve configuration fields and guest status across serialization for all three RPCs.
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

/// Guest rejections retain their error categories; missing status is an error, and
/// neither failure causes an extra request that could repeat a configuration change.
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

/// Apply the same lifecycle assertions to configure (0), status (1), and disable (2).
async fn operate(ssh: SshHandle, operation: usize) -> BoxliteResult<SshStatus> {
    match operation {
        0 => ssh.configure(config()).await,
        1 => ssh.status().await,
        _ => ssh.disable().await,
    }
}

/// Allow legitimate guest work beyond five seconds and preserve its drain error.
#[tokio::test]
async fn ssh_waits_for_guest_response_within_total_deadline() {
    for operation in 0..3 {
        for (seconds, code) in [(6, None), (10, Some(tonic::Code::DeadlineExceeded))] {
            let f = fixture().await;
            *f.mock.block.lock().unwrap() = true;
            *f.mock.error.lock().unwrap() = code;
            let call = tokio::spawn(operate(f.ssh.clone(), operation));
            f.mock.entered.notified().await;
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(seconds)).await;
            tokio::task::yield_now().await;
            tokio::time::resume();
            f.mock.release.notify_one();
            let result = tokio::time::timeout(Duration::from_secs(1), call)
                .await
                .unwrap()
                .unwrap();
            if let Some(code) = code {
                let error = result.unwrap_err();
                assert!(matches!(error, BoxliteError::Rpc(_)), "{error}");
                assert!(
                    error.to_string().contains(&format!("status: {code:?}")),
                    "{error}"
                );
                assert!(error.to_string().contains("mock rejection"), "{error}");
            } else {
                assert!(result.unwrap().enabled);
            }
            assert_eq!(f.mock.requests.lock().unwrap().len(), 1);
        }
    }
}

/// Handle creation is lazy; RPCs wait for container startup, whose duration must not
/// consume the SSH deadline even when startup exceeds fifteen seconds.
#[tokio::test]
async fn ssh_waits_for_container_start_without_charging_rpc_deadline() {
    for operation in 0..3 {
        let f = fixture_with_container(false).await;
        assert!(
            !f.backend.container_start.initialized(),
            "creating a handle must not start"
        );
        *f.mock.start_block.lock().unwrap() = true;
        *f.mock.block.lock().unwrap() = true;
        let call = tokio::spawn(operate(f.ssh.clone(), operation));
        tokio::select! {
            _ = f.mock.start_entered.notified() => {}
            _ = f.mock.entered.notified() => panic!("SSH RPC sent before Container.Start"),
        }
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(16)).await;
        tokio::task::yield_now().await;
        assert!(
            !call.is_finished(),
            "startup must not consume the SSH deadline"
        );
        assert!(f.mock.requests.lock().unwrap().is_empty());
        tokio::time::resume();
        f.mock.start_release.notify_one();
        f.mock.entered.notified().await;
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(6)).await;
        tokio::task::yield_now().await;
        tokio::time::resume();
        f.mock.release.notify_one();
        tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(f.backend.container_start.initialized());
        assert_eq!(f.mock.requests.lock().unwrap().len(), 1);
    }
}

/// A startup failure must reach the caller before any SSH request is sent.
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

/// Runtime shutdown must interrupt pending startup without reaching the SSH service.
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

/// Neither a spent live-state handle nor a cancelled backend may send another SSH RPC.
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

/// Bound an unanswered RPC by the deadline or shutdown signal, without retrying it.
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
                tokio::time::advance(Duration::from_secs(14)).await;
                tokio::task::yield_now().await;
                assert!(!call.is_finished(), "SSH must have a 15-second budget");
                tokio::time::advance(Duration::from_secs(1)).await;
            }
            let error = tokio::time::timeout(Duration::from_millis(100), call)
                .await
                .expect("SSH operation must finish within its 15-second deadline")
                .unwrap()
                .unwrap_err();
            if cancel {
                assert!(matches!(error, BoxliteError::Stopped(_)));
            } else {
                assert!(matches!(error, BoxliteError::Rpc(_)));
                assert!(error.to_string().contains("timed out after 15 seconds"));
                tokio::time::resume();
            }
            assert_eq!(f.mock.requests.lock().unwrap().len(), 1);
        }
    }
}

/// Nested account and CA credentials must stay out of configuration debug output.
#[test]
fn ssh_debug_redacts_credentials() {
    let debug = format!("{:?}", config());
    assert!(!debug.contains("sentinel"), "{debug}");
}

/// A peer accepting the socket but stalling HTTP/2 must not bypass the SSH deadline
/// or shutdown cancellation while the interface is being acquired.
#[tokio::test]
async fn ssh_deadline_and_shutdown_include_connection_handshake() {
    for operation in 0..3 {
        for cancel in [false, true] {
            let mut f = fixture().await;
            f.server.abort();
            let _ = (&mut f.server).await;
            let proto::BoxTransport::Unix { socket_path } = f.backend.config.transport() else {
                unreachable!()
            };
            std::fs::remove_file(&socket_path).unwrap();
            let listener = tokio::net::UnixListener::bind(socket_path).unwrap();
            let call = tokio::spawn(operate(f.ssh.clone(), operation));
            // Accept the transport but never answer the HTTP/2 handshake.
            let (_connection, _) = listener.accept().await.unwrap();
            if cancel {
                f.backend.runtime.shutdown_token.cancel();
            } else {
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(14)).await;
                tokio::task::yield_now().await;
                assert!(!call.is_finished(), "SSH must have a 15-second budget");
                tokio::time::advance(Duration::from_secs(1)).await;
            }
            let error = tokio::time::timeout(Duration::from_millis(100), call)
                .await
                .expect("SSH operation must finish within its 15-second deadline")
                .unwrap()
                .unwrap_err();
            if cancel {
                assert!(matches!(error, BoxliteError::Stopped(_)));
            } else {
                assert!(matches!(error, BoxliteError::Rpc(_)));
                assert!(error.to_string().contains("timed out after 15 seconds"));
                tokio::time::resume();
            }
            assert!(f.mock.requests.lock().unwrap().is_empty());
        }
    }
}

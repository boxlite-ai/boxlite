use super::*;
use boxlite_shared::{
    ExecResponse, Execution as ExecutionService, ExecutionServer, KillResponse,
    ListExecutionsRequest, ListExecutionsResponse, ResizeTtyRequest, ResizeTtyResponse,
    SendInputAck,
};
use std::{future::Future, pin::Pin, time::Duration};
use tokio::sync::oneshot;
use tonic::{Request, Response, Status, Streaming};

#[derive(Debug)]
struct WaitCall {
    execution_id: String,
    result: oneshot::Sender<Result<WaitResponse, Status>>,
    cancelled: oneshot::Receiver<()>,
}

struct CancelOnDrop(Option<oneshot::Sender<()>>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

struct RecordingExecutionService {
    unkeyed_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    waits: mpsc::UnboundedSender<WaitCall>,
    attaches: mpsc::UnboundedSender<(String, oneshot::Receiver<()>)>,
}

#[tonic::async_trait]
impl ExecutionService for RecordingExecutionService {
    async fn exec(&self, _: Request<ExecRequest>) -> Result<Response<ExecResponse>, Status> {
        self.unkeyed_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(Status::unimplemented("exec is not used by these tests"))
    }

    async fn exec_keyed(
        &self,
        request: Request<ExecRequest>,
    ) -> Result<Response<ExecResponse>, Status> {
        let status = match request.get_ref().program.as_str() {
            "unsupported" => Some(Status::unimplemented("keyed execution is unavailable")),
            "invalid" => Some(Status::invalid_argument("payload mismatch")),
            "expired" => Some(Status::failed_precondition("request expired")),
            "full" => Some(Status::resource_exhausted("request capacity reached")),
            _ => None,
        };
        if let Some(status) = status {
            return Err(status);
        }
        Ok(Response::new(ExecResponse {
            execution_id: "keyed".into(),
            ..Default::default()
        }))
    }

    async fn list_executions(
        &self,
        _: Request<ListExecutionsRequest>,
    ) -> Result<Response<ListExecutionsResponse>, Status> {
        Err(Status::unimplemented("list is not used by these tests"))
    }

    type AttachStream =
        Pin<Box<dyn futures::Stream<Item = Result<ExecOutput, Status>> + Send + 'static>>;

    async fn attach(
        &self,
        request: Request<AttachRequest>,
    ) -> Result<Response<Self::AttachStream>, Status> {
        let (cancelled_tx, cancelled) = oneshot::channel();
        let _cancel_on_drop = CancelOnDrop(Some(cancelled_tx));
        self.attaches
            .send((request.into_inner().execution_id, cancelled))
            .expect("attach recorder must remain open");
        std::future::pending().await
    }

    async fn send_input(
        &self,
        _: Request<Streaming<ExecStdin>>,
    ) -> Result<Response<SendInputAck>, Status> {
        Err(Status::unimplemented("stdin is not used by these tests"))
    }

    async fn wait(&self, request: Request<WaitRequest>) -> Result<Response<WaitResponse>, Status> {
        let (result, response) = oneshot::channel();
        let (cancelled_tx, cancelled) = oneshot::channel();
        let mut cancel_on_drop = CancelOnDrop(Some(cancelled_tx));
        self.waits
            .send(WaitCall {
                execution_id: request.into_inner().execution_id,
                result,
                cancelled,
            })
            .expect("wait recorder must remain open");
        let response = response.await.expect("test must supply a wait response");
        cancel_on_drop.0 = None;
        response.map(Response::new)
    }

    async fn kill(&self, _: Request<KillRequest>) -> Result<Response<KillResponse>, Status> {
        Err(Status::unimplemented("kill is not used by these tests"))
    }

    async fn resize_tty(
        &self,
        _: Request<ResizeTtyRequest>,
    ) -> Result<Response<ResizeTtyResponse>, Status> {
        Err(Status::unimplemented("resize is not used by these tests"))
    }
}

struct RpcFixture {
    unkeyed_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    interface: ExecutionInterface,
    waits: mpsc::UnboundedReceiver<WaitCall>,
    attaches: mpsc::UnboundedReceiver<(String, oneshot::Receiver<()>)>,
    server: tokio::task::JoinHandle<()>,
}

impl RpcFixture {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (waits_tx, waits) = mpsc::unbounded_channel();
        let (attaches_tx, attaches) = mpsc::unbounded_channel();
        let unkeyed_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let service = RecordingExecutionService {
            unkeyed_calls: unkeyed_calls.clone(),
            waits: waits_tx,
            attaches: attaches_tx,
        };
        let incoming = futures::stream::unfold(listener, |listener| async move {
            let connection = listener.accept().await.map(|(socket, _)| socket);
            Some((connection, listener))
        });
        let server = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(ExecutionServer::new(service))
                .serve_with_incoming(incoming)
                .await
                .unwrap();
        });
        let channel = Channel::from_shared(format!("http://{address}"))
            .unwrap()
            .connect()
            .await
            .unwrap();
        Self {
            unkeyed_calls,
            interface: ExecutionInterface::new(channel),
            waits,
            attaches,
            server,
        }
    }

    async fn next_wait(&mut self) -> WaitCall {
        within_deadline(self.waits.recv())
            .await
            .expect("wait recorder closed before request entered")
    }
}

impl Drop for RpcFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn within_deadline<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(2), future)
        .await
        .expect("execution RPC did not complete before test deadline")
}

#[tokio::test]
async fn keyed_unsupported_guest_returns_typed_error_without_unkeyed_fallback() {
    let mut fixture = RpcFixture::new().await;
    let result = fixture
        .interface
        .exec(
            BoxCommand::new("unsupported").idempotency_key("internal.deadline"),
            CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(result, Err(BoxliteError::Unsupported(message)) if message == "keyed execution is unavailable")
    );
    assert_eq!(
        fixture
            .unkeyed_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert!(fixture.waits.try_recv().is_err());
    assert!(fixture.attaches.try_recv().is_err());
}

#[tokio::test]
async fn keyed_rpc_errors_preserve_admission_classification_without_fallback() {
    let mut fixture = RpcFixture::new().await;
    for program in ["invalid", "expired", "full"] {
        let result = fixture
            .interface
            .exec(
                BoxCommand::new(program).idempotency_key("internal.deadline"),
                CancellationToken::new(),
            )
            .await;
        match program {
            "invalid" => assert!(
                matches!(result, Err(BoxliteError::InvalidArgument(message)) if message == "payload mismatch")
            ),
            "expired" => assert!(
                matches!(result, Err(BoxliteError::InvalidState(message)) if message == "request expired")
            ),
            "full" => assert!(
                matches!(result, Err(BoxliteError::ResourceExhausted(message)) if message == "request capacity reached")
            ),
            _ => unreachable!(),
        }
    }
    assert_eq!(
        fixture
            .unkeyed_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert!(fixture.waits.try_recv().is_err());
    assert!(fixture.attaches.try_recv().is_err());
}

#[tokio::test]
async fn keyed_replay_does_not_create_stdin_or_output_ownership() {
    let mut fixture = RpcFixture::new().await;
    for _ in 0..2 {
        let components = fixture
            .interface
            .exec(
                BoxCommand::new("cat").idempotency_key("internal.deadline"),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(components.execution_id, "keyed");
        assert!(
            components.stdin_tx.is_none(),
            "dropping a retry must not send stdin EOF"
        );
        let wait = fixture.next_wait().await;
        wait.result.send(Ok(WaitResponse::default())).unwrap();
        drop(components);
    }
    assert!(
        fixture.attaches.try_recv().is_err(),
        "keyed startup leaves output acquisition to attach"
    );
}

#[tokio::test]
async fn wait_survives_dropping_one_execution_clone() {
    let mut fixture = RpcFixture::new().await;
    let execution = fixture
        .interface
        .control_existing("survivor", CancellationToken::new());
    let survivor = execution.clone();
    let call = fixture.next_wait().await;
    assert_eq!(call.execution_id, "survivor");

    drop(execution);
    call.result
        .send(Ok(WaitResponse {
            exit_code: 42,
            ..Default::default()
        }))
        .unwrap();
    let result = within_deadline(survivor.wait()).await.unwrap();
    assert_eq!(result.exit_code, 42);
    assert_eq!(result.error_message, None);
}

#[tokio::test]
async fn wait_cancels_when_last_execution_clone_drops() {
    let mut fixture = RpcFixture::new().await;
    let execution = fixture
        .interface
        .control_existing("abandoned", CancellationToken::new());
    let last_clone = execution.clone();
    let mut call = fixture.next_wait().await;
    assert_eq!(call.execution_id, "abandoned");

    drop(execution);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut call.cancelled)
            .await
            .is_err(),
        "dropping one clone must leave the survivor's wait request active"
    );
    drop(last_clone);
    within_deadline(call.cancelled)
        .await
        .expect("server must observe cancellation of the abandoned wait");
}

#[tokio::test]
async fn wait_preserves_sighup_and_sigkill_diagnostics() {
    let mut fixture = RpcFixture::new().await;
    for (execution_id, signal, diagnostic) in [
        ("sighup", libc::SIGHUP, ""),
        ("sigkill", libc::SIGKILL, "guest reported an OOM kill"),
    ] {
        let execution = fixture
            .interface
            .control_existing(execution_id, CancellationToken::new());
        let call = fixture.next_wait().await;
        assert_eq!(call.execution_id, execution_id);
        call.result
            .send(Ok(WaitResponse {
                signal,
                error_message: diagnostic.into(),
                ..Default::default()
            }))
            .unwrap();

        let result = within_deadline(execution.wait()).await.unwrap();
        assert_eq!(result.exit_code, -signal);
        assert_eq!(
            result.error_message.as_deref(),
            (!diagnostic.is_empty()).then_some(diagnostic)
        );
    }
}

#[tokio::test]
async fn wait_rpc_failure_returns_error_without_terminal_result() {
    let mut fixture = RpcFixture::new().await;
    let execution = fixture
        .interface
        .control_existing("rpc-failure", CancellationToken::new());
    let call = fixture.next_wait().await;
    assert_eq!(call.execution_id, "rpc-failure");
    call.result
        .send(Err(Status::unavailable("guest connection lost")))
        .unwrap();

    let error = within_deadline(execution.wait()).await.unwrap_err();
    assert!(matches!(
        &error,
        BoxliteError::Internal(message) if message.contains("no longer observable")
    ));
}

#[tokio::test]
async fn wait_shutdown_preserves_exit_file_fallback_status() {
    let mut fixture = RpcFixture::new().await;
    let shutdown = CancellationToken::new();
    let execution = fixture
        .interface
        .control_existing("shutdown", shutdown.clone());
    let call = fixture.next_wait().await;
    assert_eq!(call.execution_id, "shutdown");

    shutdown.cancel();
    let result = within_deadline(execution.wait()).await.unwrap();
    assert_eq!(result.exit_code, -1);
    assert_eq!(result.error_message, None);
    within_deadline(call.cancelled)
        .await
        .expect("shutdown must cancel the guest wait request");
}

#[tokio::test]
async fn attach_existing_cancels_pending_claim_on_shutdown() {
    let mut fixture = RpcFixture::new().await;
    let shutdown = CancellationToken::new();
    let mut interface = fixture.interface.clone();
    let attach_shutdown = shutdown.clone();
    let attach = tokio::spawn(async move {
        interface
            .attach_existing("pending-attach", false, attach_shutdown)
            .await
    });
    let (execution_id, cancelled) = within_deadline(fixture.attaches.recv()).await.unwrap();
    assert_eq!(execution_id, "pending-attach");

    shutdown.cancel();
    let outcome = within_deadline(attach).await.unwrap();
    assert!(matches!(outcome, Err(BoxliteError::Stopped(_))));
    within_deadline(cancelled)
        .await
        .expect("shutdown must cancel the guest attach request");
    assert!(matches!(
        fixture.waits.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
}

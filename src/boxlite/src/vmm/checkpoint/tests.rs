//! Control socket behavior against a fake owner over a real Unix socket.

use super::fake::FakeOwner;
use super::*;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

struct Fixture {
    _dir: tempfile::TempDir,
    socket: PathBuf,
    owner: Arc<FakeOwner>,
}

impl Fixture {
    fn new(state: VmRunState) -> Self {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let socket = dir.path().join("ctl.sock");
        let owner = FakeOwner::new(state);
        super::fake::serve(&socket, owner.clone());
        Self {
            _dir: dir,
            socket,
            owner,
        }
    }

    /// A fresh client, as a host that reconnects would build.
    fn client(&self) -> ControlClient {
        ControlClient::new(&self.socket)
    }
}

async fn send(client: &ControlClient, request: ControlRequest) -> Outcome {
    Outcome::from_result(client.send(&request).await)
}

fn pause(host_writers_stopped: bool) -> ControlRequest {
    ControlRequest::Pause {
        host_writers_stopped,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn checkpoint_control_reports_owner_results_and_a_reconnect_reads_the_real_state() {
    let fx = Fixture::new(VmRunState::Running);
    let mode = std::fs::metadata(&fx.socket).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600, "control socket must be owner-only");

    assert_eq!(
        send(&fx.client(), pause(true)).await,
        Outcome::Done(VmRunState::Paused)
    );
    // A different client (a reattaching host process) learns the state from
    // the owner, not from anything it cached.
    assert_eq!(
        send(&fx.client(), ControlRequest::State).await,
        Outcome::Done(VmRunState::Paused)
    );
    // A refused mutation carries the owner's state, unchanged.
    match send(&fx.client(), pause(false)).await {
        Outcome::Refused { state, failure } => {
            assert_eq!(state, VmRunState::Paused);
            assert_eq!(failure.kind, FailureKind::Rejected);
        }
        other => panic!("second pause: {other:?}"),
    }
    assert_eq!(
        send(&fx.client(), ControlRequest::Resume).await,
        Outcome::Done(VmRunState::Running)
    );
    assert_eq!(fx.owner.calls(), ["pause(true)", "pause(false)", "resume"]);
}

async fn begin_capture(client: &ControlClient) -> (u64, std::os::unix::net::UnixStream) {
    let (peer, owner) = std::os::unix::net::UnixStream::pair().unwrap();
    let (reply, _) = client
        .descriptors(
            protocol::DescriptorRequest::Begin { disk_only: false },
            vec![owner.into()],
        )
        .await
        .unwrap();
    assert!(reply.error.is_none());
    (reply.metadata["token"].as_u64().unwrap(), peer)
}
fn export_files() -> Vec<std::os::fd::OwnedFd> {
    (0..2)
        .map(|_| tempfile::tempfile().unwrap().into())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn checkpoint_control_capture_reservation_excludes_resume_and_stop_bypasses_export() {
    let fx = Fixture::new(VmRunState::Paused);
    let (token, _peer) = begin_capture(&fx.client()).await;
    let (entered, release) = fx.owner.hold();
    let client = fx.client();
    let exporter = tokio::spawn(async move {
        client
            .descriptors(
                protocol::DescriptorRequest::Export {
                    token,
                    metadata: serde_json::Value::Null,
                },
                export_files(),
            )
            .await
    });
    tokio::task::spawn_blocking(move || entered.recv().unwrap())
        .await
        .unwrap();
    let reply = fx.client().send(&ControlRequest::Resume).await.unwrap();
    assert_eq!(reply.error.unwrap().kind, FailureKind::Busy);
    let reply = fx.client().send(&ControlRequest::State).await.unwrap();
    assert_eq!(reply.state, VmRunState::Paused);
    assert_eq!(reply.in_flight, Some(Operation::Capture));
    assert_eq!(
        send(&fx.client(), ControlRequest::Stop).await,
        Outcome::Done(VmRunState::Stopped)
    );
    release.send(()).unwrap();
    assert_eq!(
        exporter.await.unwrap().unwrap().0.state,
        VmRunState::Stopped
    );
    assert_eq!(fx.owner.calls(), ["export_fd", "stop"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn checkpoint_control_known_export_error_stays_paused_and_legacy_paths_are_refused() {
    let fx = Fixture::new(VmRunState::Paused);
    let (token, _peer) = begin_capture(&fx.client()).await;
    *fx.owner.export_error.lock().unwrap() =
        Some(OwnerError::new(FailureKind::Io, "No space left on device"));
    let (reply, _) = fx
        .client()
        .descriptors(
            protocol::DescriptorRequest::Export {
                token,
                metadata: serde_json::Value::Null,
            },
            export_files(),
        )
        .await
        .unwrap();
    assert_eq!(reply.state, VmRunState::Paused);
    assert_eq!(reply.error.unwrap().kind, FailureKind::Io);
    for name in ["vm.img", "../escape", "/tmp/absolute"] {
        let reply = fx
            .client()
            .send(&ControlRequest::ExportRaw { name: name.into() })
            .await
            .unwrap();
        assert_eq!(reply.error.unwrap().kind, FailureKind::Rejected);
    }
    assert_eq!(fx.owner.calls(), ["export_fd"]);
    let (reply, _) = fx
        .client()
        .descriptors(
            protocol::DescriptorRequest::End {
                token,
                cancel: false,
            },
            Vec::new(),
        )
        .await
        .unwrap();
    assert!(reply.error.is_none());
    assert_eq!(reply.state, VmRunState::Paused);
}

#[tokio::test(flavor = "multi_thread")]
async fn checkpoint_control_timeout_and_disconnect_are_uncertain_and_nothing_sent_is_unavailable() {
    // Timeout: the owner is still pausing when the deadline passes.
    let fx = Fixture::new(VmRunState::Running);
    let (_entered, release) = fx.owner.hold();
    let result = fx
        .client()
        .send_with_deadline(&pause(true), Some(Duration::from_millis(200)))
        .await;
    assert!(
        matches!(Outcome::from_result(result.clone()), Outcome::Uncertain(_)),
        "{result:?}"
    );
    release.send(()).unwrap();

    // Disconnect: a peer that reads the request and closes without a reply.
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = dir.path().join("ctl.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let peer = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = std::io::BufReader::new(&stream);
        let _: ControlRequest = protocol::read_line(&mut reader).unwrap();
        drop(stream);
    });
    let result = ControlClient::new(&socket)
        .send(&ControlRequest::Resume)
        .await;
    assert!(
        matches!(Outcome::from_result(result.clone()), Outcome::Uncertain(_)),
        "{result:?}"
    );
    peer.join().unwrap();

    // No socket: nothing was delivered.
    let missing = ControlClient::new(dir.path().join("missing.sock"));
    let result = missing.send(&ControlRequest::Stop).await;
    assert!(
        matches!(
            Outcome::from_result(result.clone()),
            Outcome::Unavailable(_)
        ),
        "{result:?}"
    );
}

#[test]
fn checkpoint_enter_keeps_the_guest_exit_code_from_the_final_state() {
    assert_eq!(enter_result(0, VmRunState::Exited(42)).unwrap(), Some(42));
    assert_eq!(enter_result(0, VmRunState::Exited(0)).unwrap(), Some(0));
    assert_eq!(enter_result(0, VmRunState::Stopped).unwrap(), None);
    assert!(enter_result(0, VmRunState::Failed).is_err());
    assert!(enter_result(-libc::EINVAL, VmRunState::Failed).is_err());
    assert!(enter_result(0, VmRunState::Paused).is_err());
}

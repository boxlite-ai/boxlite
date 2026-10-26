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
    export_dir: PathBuf,
    owner: Arc<FakeOwner>,
}

impl Fixture {
    fn new(state: VmRunState) -> Self {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let socket = dir.path().join("ctl.sock");
        let export_dir = dir.path().join("checkpoint");
        std::fs::create_dir(&export_dir).unwrap();
        let owner = FakeOwner::new(state);
        super::fake::serve(&socket, &export_dir, owner.clone());
        Self {
            _dir: dir,
            socket,
            export_dir,
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

#[tokio::test(flavor = "multi_thread")]
async fn checkpoint_control_serializes_mutations_and_answers_state_and_stop_during_an_export() {
    let fx = Fixture::new(VmRunState::Paused);
    let (entered, release) = fx.owner.hold();
    let exporter = {
        let client = fx.client();
        tokio::spawn(async move {
            send(
                &client,
                ControlRequest::ExportRaw {
                    name: "vm.img".into(),
                },
            )
            .await
        })
    };
    tokio::task::spawn_blocking(move || entered.recv().unwrap())
        .await
        .unwrap();

    // A second mutation is refused without reaching the owner.
    match send(&fx.client(), ControlRequest::Resume).await {
        Outcome::Refused { state, failure } => {
            assert_eq!(state, VmRunState::Paused);
            assert_eq!(failure.kind, FailureKind::Busy);
            assert!(failure.message.contains("export"), "{}", failure.message);
        }
        other => panic!("resume during export: {other:?}"),
    }
    // State does not wait for the export and names it.
    let reply = fx.client().send(&ControlRequest::State).await.unwrap();
    assert_eq!(reply.state, VmRunState::Paused);
    assert_eq!(reply.in_flight, Some(Operation::ExportRaw));
    assert_eq!(reply.error, None);

    release.send(()).unwrap();
    assert_eq!(exporter.await.unwrap(), Outcome::Done(VmRunState::Paused));
    let export = format!("export({})", fx.export_dir.join("vm.img").display());
    assert_eq!(fx.owner.calls(), std::slice::from_ref(&export));

    // Stop is not queued behind a mutation: it reaches the owner while an
    // export still holds the mutation lock.
    let (entered, release) = fx.owner.hold();
    let exporter = {
        let client = fx.client();
        tokio::spawn(async move {
            send(
                &client,
                ControlRequest::ExportRaw {
                    name: "vm.img".into(),
                },
            )
            .await
        })
    };
    tokio::task::spawn_blocking(move || entered.recv().unwrap())
        .await
        .unwrap();
    assert_eq!(
        send(&fx.client(), ControlRequest::Stop).await,
        Outcome::Done(VmRunState::Stopped)
    );
    release.send(()).unwrap();
    exporter.await.unwrap();
    assert_eq!(fx.owner.calls(), [export.clone(), export, "stop".into()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn checkpoint_control_export_failure_leaves_the_guest_paused_and_bad_names_never_reach_the_owner()
 {
    let fx = Fixture::new(VmRunState::Paused);
    *fx.owner.export_error.lock().unwrap() =
        Some(OwnerError::new(FailureKind::Io, "No space left on device"));
    match send(
        &fx.client(),
        ControlRequest::ExportRaw {
            name: "vm.img".into(),
        },
    )
    .await
    {
        Outcome::Refused { state, failure } => {
            assert_eq!(state, VmRunState::Paused);
            assert_eq!(failure.kind, FailureKind::Io);
        }
        other => panic!("failed export: {other:?}"),
    }

    for name in ["../escape.img", "/tmp/abs.img", "a/b.img", "", ".."] {
        match send(
            &fx.client(),
            ControlRequest::ExportRaw { name: name.into() },
        )
        .await
        {
            Outcome::Refused { failure, .. } => assert_eq!(failure.kind, FailureKind::Rejected),
            other => panic!("export name {name:?}: {other:?}"),
        }
    }
    assert_eq!(fx.owner.calls().len(), 1, "{:?}", fx.owner.calls());
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
fn checkpoint_control_export_does_not_inherit_the_device_control_deadline() {
    assert_eq!(
        client::reply_deadline(&ControlRequest::ExportRaw { name: "x".into() }),
        None
    );
    for request in [
        ControlRequest::State,
        pause(true),
        ControlRequest::Resume,
        ControlRequest::Stop,
    ] {
        assert_eq!(
            client::reply_deadline(&request),
            Some(client::CONTROL_TIMEOUT)
        );
    }
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

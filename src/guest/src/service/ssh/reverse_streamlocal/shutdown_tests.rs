use super::*;
use crate::reaper::Reaper;
use crate::service::exec::{
    exec_handle::ExecHandle, process_instance::ProcessInstance, state::ExecutionState,
};
use nix::unistd::Pid;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use tokio::sync::oneshot;

#[test]
#[ignore = "invoked as an isolated helper subprocess"]
fn helper_subprocess() {
    let socket_path = std::env::var("BOXLITE_TEST_HELPER_SOCKET").unwrap();
    let ingress = std::env::var("BOXLITE_TEST_HELPER_INGRESS")
        .unwrap()
        .parse()
        .unwrap();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(serve_reverse_streamlocal(
            InternalArgs {
                socket_path,
                ingress,
            },
            tokio::io::stdin(),
            tokio::io::stderr(),
        ))
        .unwrap();
}

struct ChildGuard(std::process::Child, Option<ProcessInstance>);

impl ChildGuard {
    fn pid(&self) -> Pid {
        Pid::from_raw(self.0.id() as i32)
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _fence = crate::reaper::reap_fence();
        if self.1.is_some() && ProcessInstance::capture(self.pid()) == self.1 {
            let _ = self.0.kill();
        }
        // The production reaper normally won this wait; it is a fallback for
        // assertions in fixture setup, before async cleanup could take over.
        let _ = self.0.wait();
    }
}

async fn fixture(
    server: Arc<GuestServer>,
    connection_tasks: Arc<super::super::TaskGroup>,
    path: &Path,
    ingress: SocketAddrV4,
) -> (RunningHelper, ChildGuard) {
    let reaper = Reaper::install();
    let spawned = std::time::Instant::now();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "service::ssh::reverse_streamlocal::shutdown_tests::helper_subprocess",
            "--ignored",
            "--nocapture",
        ])
        .env("BOXLITE_TEST_HELPER_SOCKET", path)
        .env("BOXLITE_TEST_HELPER_INGRESS", ingress.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = Pid::from_raw(child.id() as i32);
    let mut guard = ChildGuard(child, ProcessInstance::capture(pid));
    let handle = ExecHandle::new(
        pid,
        guard.0.stdin.take().unwrap().into(),
        guard.0.stderr.take().unwrap().into(),
        None,
    )
    .unwrap();
    let state = ExecutionState::new_init_session(
        handle,
        reaper.register(pid, spawned).await,
        ProcessInstance::capture(pid),
    );
    let registry = server.registry.clone();
    let execution_id = "reverse-helper-test".to_string();
    assert!(registry.register(execution_id.clone(), state).await);
    let (stdin, input) = mpsc::channel(2);
    let opening = ExecStdin {
        execution_id: execution_id.clone(),
        data: Vec::new(),
        close: false,
    };
    let input_task = server
        .send_execution_input(opening, Box::pin(ReceiverStream::new(input).map(Ok)))
        .await
        .unwrap();
    let stdin_task = connection_tasks.spawn_tracked(|_| async move {
        input_task.await.unwrap().unwrap();
    });
    let mut output = server.attach_execution(&execution_id).await.unwrap();
    stdin
        .send(ExecStdin {
            execution_id: execution_id.clone(),
            data: "9e3d4f4f-e9e5-4896-a42c-9fe5f53244af".as_bytes().to_vec(),
            close: false,
        })
        .await
        .unwrap();
    let buffered_stdout = read_marker(
        &mut output,
        REVERSE_STREAMLOCAL_READY_MAGIC,
        Vec::new(),
        REVERSE_STREAMLOCAL_STOPPED_MAGIC.len(),
    )
    .await
    .unwrap();
    (
        RunningHelper {
            connection_tasks,
            cancel: Default::default(),
            server,
            registry,
            execution_id,
            stdin,
            stdin_task,
            output,
            buffered_stdout,
        },
        guard,
    )
}

#[derive(Clone, Copy)]
enum Shutdown {
    Disable,
    Configure,
    Connection,
}

fn configuration() -> boxlite_shared::SshConfig {
    let key = russh::keys::PrivateKey::random(
        &mut russh::keys::key::safe_rng(),
        russh::keys::Algorithm::Ed25519,
    )
    .unwrap();
    boxlite_shared::SshConfig {
        listen_address: "127.0.0.1:0".into(),
        host_private_key: key.to_openssh(Default::default()).unwrap().to_string(),
        accounts: vec![boxlite_shared::SshAccount {
            login: "root".into(),
            authorized_keys: vec![key.public_key().to_openssh().unwrap()],
            ca: None,
        }],
    }
}

async fn shutdown_silent_helper(cancel_after_stop: bool, shutdown: Shutdown) {
    let _serial = crate::reaper::reap_test_guard().await;
    let root = tempfile::tempdir().unwrap();
    let server = Arc::new(GuestServer::new(crate::layout::GuestLayout::with_base(
        root.path(),
    )));
    server.ssh_manager.attach_guest(&server);
    let configuration = configuration();
    if matches!(shutdown, Shutdown::Configure) {
        server
            .ssh_manager
            .configure(configuration.clone())
            .await
            .unwrap();
    }
    let service_tasks = server
        .ssh_manager
        .state
        .lock()
        .await
        .service_tasks
        .clone()
        .unwrap_or_default();
    server.ssh_manager.state.lock().await.service_tasks = Some(service_tasks.clone());
    let path = root.path().join("helper.sock");
    let ingress = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let SocketAddr::V4(address) = ingress.local_addr().unwrap() else {
        unreachable!()
    };
    let (mut helper, guard) = fixture(server.clone(), service_tasks.clone(), &path, address).await;
    let mut unix = UnixStream::connect(&path).await.unwrap();
    let (mut tcp, _) = ingress.accept().await.unwrap();
    let mut token = [0; INGRESS_TOKEN_BYTES];
    tcp.read_exact(&mut token).await.unwrap();
    if !cancel_after_stop {
        service_tasks.cancel();
    }
    assert!(helper.stop_listener().await);
    assert!(!path.exists());
    // Listener revocation preserves both an established request and a response
    // sent after request EOF.
    if cancel_after_stop {
        unix.write_all(b"request").await.unwrap();
        unix.shutdown().await.unwrap();
        let mut request = Vec::new();
        tcp.read_to_end(&mut request).await.unwrap();
        assert_eq!(request, b"request");
        tcp.write_all(b"response").await.unwrap();
        let mut response = [0; 8];
        unix.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"response");
        // Keep this reverse direction open while the helper drains.
    }
    helper.spawn_cleanup(HelperCleanup::Drain);
    let state = server.registry.get("reverse-helper-test").await.unwrap();
    let started = tokio::time::Instant::now();
    let stopped = tokio::time::timeout(Duration::from_secs(3), async {
        match shutdown {
            Shutdown::Disable => server.ssh_manager.disable().await.map(|_| ()),
            Shutdown::Configure => server
                .ssh_manager
                .configure(configuration.clone())
                .await
                .map(|_| ()),
            Shutdown::Connection => {
                let (authenticated, _) = oneshot::channel();
                let connection = super::super::server::SshConnection::new(
                    server.clone(),
                    super::super::SshConfig::parse(configuration)
                        .unwrap()
                        .authorizer,
                    authenticated,
                    service_tasks.clone(),
                );
                drop(connection);
                service_tasks.wait().await;
                Ok(())
            }
        }
    })
    .await;
    let elapsed = started.elapsed();
    let released = server.registry.get("reverse-helper-test").await.is_none();
    // Cleanup precedes every defect assertion, including the old-code timeout.
    drop((unix, tcp, ingress));
    let _ = server.kill_execution("reverse-helper-test", 9, true).await;
    tokio::time::timeout(Duration::from_secs(5), service_tasks.wait())
        .await
        .unwrap();
    let exit = state.wait_process().await;
    let reaped = nix::sys::wait::waitpid(guard.pid(), Some(nix::sys::wait::WaitPidFlag::WNOHANG));
    drop(guard);
    server.ssh_manager.disable().await.unwrap();
    assert_eq!(reaped, Err(nix::errno::Errno::ECHILD));
    assert!(
        stopped.is_ok(),
        "SSH Disable waited for the helper relay drain"
    );
    assert!(stopped.unwrap().is_ok(), "SSH shutdown failed");
    assert!(
        elapsed < PROCESS_TERMINATION_GRACE,
        "confirmed helper received an extra termination grace: {elapsed:?}"
    );
    assert!(
        released,
        "helper execution was not released before Disable completed"
    );
    assert!(matches!(
        exit,
        crate::service::exec::exec_handle::ExitStatus::Signal(nix::sys::signal::Signal::SIGKILL)
    ));
}

#[tokio::test]
async fn shutdown_terminates_silent_helper() {
    shutdown_silent_helper(false, Shutdown::Disable).await;
}

#[tokio::test]
async fn shutdown_upgrades_revoked_helper_drain() {
    shutdown_silent_helper(true, Shutdown::Disable).await;
}

#[derive(Clone, Copy)]
enum Confirmation {
    Fragmented,
    Missing,
    Invalid,
    FullInputQueue,
    AlreadyExited,
}

async fn confirmation_during_shutdown(scenario: Confirmation) {
    let _serial = crate::reaper::reap_test_guard().await;
    let root = tempfile::tempdir().unwrap();
    let server = Arc::new(GuestServer::new(crate::layout::GuestLayout::with_base(
        root.path(),
    )));
    let connection_tasks = Arc::new(super::super::TaskGroup::default());
    let path = root.path().join("confirm.sock");
    let ingress = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let SocketAddr::V4(address) = ingress.local_addr().unwrap() else {
        unreachable!()
    };
    let (mut helper, guard) =
        fixture(server.clone(), connection_tasks.clone(), &path, address).await;
    let state = server.registry.get(&helper.execution_id).await.unwrap();
    if matches!(scenario, Confirmation::AlreadyExited) {
        assert!(helper.request_stop().await);
        assert!(helper.wait_stopped().await);
        state.wait_process().await;
    }
    let (status, output) = mpsc::channel(2);
    let mut original_output = std::mem::replace(&mut helper.output, output);
    connection_tasks
        .spawn_tracked(|_| async move { while original_output.recv().await.is_some() {} });
    let (blocked_input, blocked_receiver) = mpsc::channel(1);
    if matches!(scenario, Confirmation::FullInputQueue) {
        blocked_input
            .send(ExecStdin {
                execution_id: helper.execution_id.clone(),
                data: vec![],
                close: false,
            })
            .await
            .unwrap();
        helper.stdin = blocked_input.clone();
    }
    let stdout = |bytes: &[u8]| ExecOutput {
        event: Some(exec_output::Event::Stdout(boxlite_shared::Stdout {
            data: bytes.to_vec(),
            ..Default::default()
        })),
    };
    let start = tokio::time::Instant::now();
    let acknowledged = {
        let status = status;
        let stop = helper.stop_listener();
        tokio::pin!(stop);
        if matches!(scenario, Confirmation::Fragmented) {
            let split = REVERSE_STREAMLOCAL_STOPPED_MAGIC.len() / 2;
            status
                .send(Ok(stdout(&REVERSE_STREAMLOCAL_STOPPED_MAGIC[..split])))
                .await
                .unwrap();
            // Poll through production parsing before cancellation. Restarting
            // read_marker here would reject the remaining suffix.
            assert!(futures::poll!(&mut stop).is_pending());
            connection_tasks.cancel();
            status
                .send(Ok(stdout(&REVERSE_STREAMLOCAL_STOPPED_MAGIC[split..])))
                .await
                .unwrap();
        } else {
            connection_tasks.cancel();
            if matches!(scenario, Confirmation::Invalid) {
                status.send(Ok(stdout(b"invalid"))).await.unwrap();
            }
        }
        if matches!(scenario, Confirmation::AlreadyExited) {
            drop(status);
        }
        tokio::time::timeout(Duration::from_millis(1500), &mut stop).await
    };
    let elapsed = start.elapsed();
    helper.spawn_cleanup(HelperCleanup::Kill);
    drop(blocked_receiver);
    drop(blocked_input);
    tokio::time::timeout(Duration::from_secs(5), connection_tasks.wait())
        .await
        .unwrap();
    let released = server.registry.get("reverse-helper-test").await.is_none();
    let reaped = nix::sys::wait::waitpid(guard.pid(), Some(nix::sys::wait::WaitPidFlag::WNOHANG));
    drop(guard);
    assert!(released);
    assert_eq!(reaped, Err(nix::errno::Errno::ECHILD));
    assert!(
        acknowledged.is_ok(),
        "shutdown confirmation exceeded its one-second budget"
    );
    assert_eq!(
        acknowledged.unwrap(),
        matches!(scenario, Confirmation::Fragmented)
    );
    if matches!(
        scenario,
        Confirmation::Missing | Confirmation::FullInputQueue
    ) {
        assert!(elapsed >= PROCESS_TERMINATION_GRACE);
    }
}

#[tokio::test]
async fn shutdown_keeps_fragmented_confirmation_progress() {
    confirmation_during_shutdown(Confirmation::Fragmented).await;
}
#[tokio::test]
async fn shutdown_bounds_missing_confirmation() {
    confirmation_during_shutdown(Confirmation::Missing).await;
}
#[tokio::test]
async fn shutdown_rejects_invalid_confirmation() {
    confirmation_during_shutdown(Confirmation::Invalid).await;
}
#[tokio::test]
async fn shutdown_bounds_stop_request_and_confirmation_together() {
    confirmation_during_shutdown(Confirmation::FullInputQueue).await;
}
#[tokio::test]
async fn shutdown_reaps_an_already_exited_helper() {
    confirmation_during_shutdown(Confirmation::AlreadyExited).await;
}

#[tokio::test]
async fn shutdown_aborts_and_joins_pending_channel_opens() {
    let cancel = tokio_util::sync::CancellationToken::new();
    let (held, closed) = oneshot::channel::<()>();
    let mut pending = JoinSet::new();
    pending.spawn(async move {
        let _held = held;
        std::future::pending::<()>().await;
    });
    cancel.cancel();
    let finished = tokio::time::timeout(
        Duration::from_secs(1),
        finish_or_cancel_pending_opens(&mut pending, &cancel),
    )
    .await;
    pending.abort_all();
    finish_pending_opens(&mut pending).await;
    assert!(
        finished.is_ok(),
        "shutdown waited for pending channel opens"
    );
    assert!(pending.is_empty());
    assert!(closed.await.is_err());
}

#[tokio::test]
async fn shutdown_configure_terminates_revoked_helper() {
    shutdown_silent_helper(true, Shutdown::Configure).await;
}

#[tokio::test]
async fn shutdown_connection_drop_terminates_revoked_helper() {
    shutdown_silent_helper(true, Shutdown::Connection).await;
}

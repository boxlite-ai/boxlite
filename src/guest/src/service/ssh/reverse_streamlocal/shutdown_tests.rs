use super::*;
use crate::reaper::Reaper;
use crate::service::exec::{
    exec_handle::ExecHandle, process_instance::ProcessInstance, state::ExecutionState,
};
use crate::service::ssh::forwarding_fixture::{completes, ForwardingSession};
use nix::unistd::Pid;
use std::os::fd::AsFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use tokio::sync::oneshot;

#[test]
#[ignore = "invoked as an isolated helper subprocess"]
fn helper_subprocess() {
    if std::env::var_os("BOXLITE_TEST_IGNORE_TERM").is_some() {
        // Only this isolated child changes its signal disposition.
        unsafe {
            nix::sys::signal::signal(
                nix::sys::signal::Signal::SIGTERM,
                nix::sys::signal::SigHandler::SigIgn,
            )
            .unwrap();
        }
    }
    let socket_path = std::env::var("BOXLITE_TEST_HELPER_SOCKET").unwrap();
    let ingress = std::env::var("BOXLITE_TEST_HELPER_INGRESS")
        .unwrap()
        .parse()
        .unwrap();
    if std::env::var_os("BOXLITE_TEST_IGNORE_TERM").is_some() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let control = tokio::net::unix::pipe::Receiver::from_owned_fd(
                    std::io::stdin().as_fd().try_clone_to_owned().unwrap(),
                )
                .unwrap();
                let status = tokio::net::unix::pipe::Sender::from_owned_fd(
                    std::io::stderr().as_fd().try_clone_to_owned().unwrap(),
                )
                .unwrap();
                serve_until_terminated(
                    InternalArgs {
                        socket_path,
                        ingress,
                    },
                    control,
                    status,
                    std::future::pending(),
                )
                .await
                .unwrap();
            });
    } else {
        // The test harness writes to stdout; reserve stderr for helper status.
        use std::os::fd::AsRawFd;
        let original_stdout = std::io::stdout().as_fd().try_clone_to_owned().unwrap();
        assert_ne!(unsafe { nix::libc::dup2(2, 1) }, -1);
        run_internal(InternalArgs {
            socket_path,
            ingress,
        })
        .unwrap();
        assert_ne!(
            unsafe { nix::libc::dup2(original_stdout.as_raw_fd(), 1) },
            -1
        );
    }
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
    fixture_with_signals(server, connection_tasks, path, ingress, false).await
}

async fn fixture_with_signals(
    server: Arc<GuestServer>,
    connection_tasks: Arc<super::super::TaskGroup>,
    path: &Path,
    ingress: SocketAddrV4,
    ignore_term: bool,
) -> (RunningHelper, ChildGuard) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    if ignore_term {
        command.env("BOXLITE_TEST_IGNORE_TERM", "1");
    }
    command
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
        .process_group(0);
    let guard = register_helper(&server, &mut command).await;
    let registry = server.registry.clone();
    let execution_id = "reverse-helper-test".to_string();
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
    if cancel_after_stop {
        assert!(helper.stop_listener().await);
        assert!(!path.exists());
    }
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
    assert!(!path.exists());
    assert_eq!(reaped, Err(nix::errno::Errno::ECHILD));
    assert!(
        stopped.is_ok(),
        "SSH Disable waited for the helper relay drain"
    );
    assert!(stopped.unwrap().is_ok(), "SSH shutdown failed");

    assert!(
        released,
        "helper execution was not released before Disable completed"
    );
    assert!(matches!(
        exit,
        crate::service::exec::exec_handle::ExitStatus::Code(0)
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
    let mut original_stdin = None;
    if matches!(scenario, Confirmation::FullInputQueue) {
        blocked_input
            .send(ExecStdin {
                execution_id: helper.execution_id.clone(),
                data: vec![],
                close: false,
            })
            .await
            .unwrap();
        original_stdin = Some(std::mem::replace(&mut helper.stdin, blocked_input.clone()));
    }
    let stdout = |bytes: &[u8]| ExecOutput {
        event: Some(exec_output::Event::Stdout(boxlite_shared::Stdout {
            data: bytes.to_vec(),
            ..Default::default()
        })),
    };
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
            // Consume part of STOPPED before connection cancellation interrupts it.
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
    helper.spawn_cleanup(HelperCleanup::Terminate);
    drop(blocked_receiver);
    drop(blocked_input);
    drop(original_stdin);
    tokio::time::timeout(Duration::from_secs(5), connection_tasks.wait())
        .await
        .unwrap();
    let released = server.registry.get("reverse-helper-test").await.is_none();
    let reaped = nix::sys::wait::waitpid(guard.pid(), Some(nix::sys::wait::WaitPidFlag::WNOHANG));
    drop(guard);
    assert!(matches!(
        state.wait_process().await,
        crate::service::exec::exec_handle::ExitStatus::Code(0)
    ));
    assert!(!path.exists());
    assert!(released);
    assert_eq!(reaped, Err(nix::errno::Errno::ECHILD));
    assert!(
        acknowledged.is_ok(),
        "connection cancellation waited for stop acknowledgement"
    );
    assert!(
        !acknowledged.unwrap(),
        "connection cancellation must abandon STOPPED"
    );
}

#[tokio::test]
async fn shutdown_interrupts_fragmented_confirmation() {
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
async fn shutdown_interrupts_a_full_stdin_queue() {
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

struct ListenerFixture {
    root: tempfile::TempDir,
    server: Arc<GuestServer>,
    tasks: Arc<super::super::TaskGroup>,
    listeners: ListenerRegistry,
    permits: Arc<Semaphore>,
    ingress: SocketAddrV4,
    guard: ChildGuard,
    state: ExecutionState,
    ssh: ForwardingSession,
}

impl ListenerFixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let server = Arc::new(GuestServer::new(crate::layout::GuestLayout::with_base(
            root.path(),
        )));
        let tasks = Arc::new(super::super::TaskGroup::default());
        let ssh = ForwardingSession::new(server.clone(), tasks.clone()).await;
        let ingress = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let SocketAddr::V4(address) = ingress.local_addr().unwrap() else {
            unreachable!()
        };
        let path = root.path().join("listener.sock");
        let (helper, guard) =
            completes(fixture(server.clone(), tasks.clone(), &path, address)).await;
        let state = server.registry.get(&helper.execution_id).await.unwrap();
        let listeners = ListenerRegistry::default();
        let registration = listeners
            .register(path.to_str().unwrap().into(), 1, &tasks)
            .unwrap();
        let permits = Arc::new(Semaphore::new(1));
        spawn_listener(
            ingress,
            path.to_str().unwrap().into(),
            "9e3d4f4f-e9e5-4896-a42c-9fe5f53244af".into(),
            ssh.handle.clone(),
            permits.clone(),
            helper,
            registration,
        );
        Self {
            root,
            server,
            tasks,
            listeners,
            permits,
            ingress: address,
            guard,
            state,
            ssh,
        }
    }

    fn path(&self) -> std::path::PathBuf {
        self.root.path().join("listener.sock")
    }

    async fn finish(self) {
        completes(self.ssh.close()).await;
        completes(self.tasks.wait()).await;
        assert!(self.tasks.is_cancelled());
        assert!(self
            .server
            .registry
            .get("reverse-helper-test")
            .await
            .is_none());
        assert_eq!(self.listeners.len(), 0);
        assert_eq!(self.permits.available_permits(), 1);
        completes(self.state.wait_process()).await;
        assert_eq!(
            nix::sys::wait::waitpid(self.guard.pid(), Some(nix::sys::wait::WaitPidFlag::WNOHANG)),
            Err(nix::errno::Errno::ECHILD)
        );
        assert!(TcpStream::connect(self.ingress).await.is_err());
    }
}

#[tokio::test]
async fn listener_revocation_preserves_forwarded_channel_and_response_after_eof() {
    let _serial = crate::reaper::reap_test_guard().await;
    completes(async {
        let mut fixture = ListenerFixture::new().await;
        let mut unix = UnixStream::connect(fixture.path()).await.unwrap();
        let opened = fixture.ssh.channels.recv().await.unwrap();
        assert_eq!(opened.address, fixture.path().to_str().unwrap());
        opened.reply.accept().await;
        let mut channel = opened.channel.into_stream();
        unix.write_all(b"before").await.unwrap();
        let mut before = [0; 6];
        channel.read_exact(&mut before).await.unwrap();
        assert_eq!(&before, b"before");
        assert!(
            fixture
                .listeners
                .cancel(fixture.path().to_str().unwrap())
                .await
        );
        assert!(!fixture.path().exists());
        let path = fixture.path();
        let replacement = UnixListener::bind(&path).unwrap();
        let _client = UnixStream::connect(&path).await.unwrap();
        replacement.accept().await.unwrap();
        unix.write_all(b"after").await.unwrap();
        unix.shutdown().await.unwrap();
        let mut request = Vec::new();
        channel.read_to_end(&mut request).await.unwrap();
        assert_eq!(request, b"after");
        channel.write_all(b"response").await.unwrap();
        let mut response = [0; 8];
        unix.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"response");
        assert!(futures::poll!(std::pin::pin!(fixture.state.wait_process())).is_pending());
        // The response direction stays open: disconnect must cancel this drain.
        let state = fixture.state.clone();
        fixture.finish().await;
        assert!(matches!(
            state.wait_process().await,
            crate::service::exec::exec_handle::ExitStatus::Code(0)
        ));
    })
    .await;
}

#[tokio::test]
async fn disconnect_cancels_unconfirmed_channel_and_reaps_listener_helper() {
    let _serial = crate::reaper::reap_test_guard().await;
    completes(async {
        let mut fixture = ListenerFixture::new().await;
        let _unix = UnixStream::connect(fixture.path()).await.unwrap();
        let pending = fixture.ssh.channels.recv().await.unwrap();
        assert_eq!(fixture.permits.available_permits(), 0);
        // Keep the reply alive without accepting or rejecting it until after
        // production SshConnection::drop has cancelled and drained its tasks.
        fixture.finish().await;
        drop(pending);
    })
    .await;
}

#[tokio::test]
async fn rejected_channel_releases_capacity_for_a_completed_relay() {
    let _serial = crate::reaper::reap_test_guard().await;
    completes(async {
        let mut fixture = ListenerFixture::new().await;
        let mut rejected = UnixStream::connect(fixture.path()).await.unwrap();
        let opened = fixture.ssh.channels.recv().await.unwrap();
        opened
            .reply
            .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
            .await;
        let mut bytes = Vec::new();
        rejected.read_to_end(&mut bytes).await.unwrap();
        assert!(bytes.is_empty());
        drop(rejected);
        let mut unix = UnixStream::connect(fixture.path()).await.unwrap();
        let opened = fixture.ssh.channels.recv().await.unwrap();
        opened.reply.accept().await;
        let mut channel = opened.channel.into_stream();
        unix.shutdown().await.unwrap();
        channel.read_to_end(&mut bytes).await.unwrap();
        channel.shutdown().await.unwrap();
        unix.read_to_end(&mut bytes).await.unwrap();
        assert!(
            fixture
                .listeners
                .cancel(fixture.path().to_str().unwrap())
                .await
        );
        completes(fixture.state.wait_process()).await;
        fixture.finish().await;
    })
    .await;
}

#[tokio::test]
async fn invalid_ingress_and_connection_limit_do_not_open_channels() {
    let _serial = crate::reaper::reap_test_guard().await;
    completes(async {
        let fixture = ListenerFixture::new().await;
        let mut invalid = TcpStream::connect(fixture.ingress).await.unwrap();
        invalid
            .write_all(&[b'x'; INGRESS_TOKEN_BYTES])
            .await
            .unwrap();
        let mut bytes = Vec::new();
        invalid.read_to_end(&mut bytes).await.unwrap();
        assert!(bytes.is_empty());
        let permit = fixture.permits.clone().acquire_owned().await.unwrap();
        let mut limited = TcpStream::connect(fixture.ingress).await.unwrap();
        limited.read_to_end(&mut bytes).await.unwrap();
        assert!(bytes.is_empty());
        drop(permit);
        fixture.finish().await;
    })
    .await;
}

async fn helper_output_failure(output: Option<Result<ExecOutput, tonic::Status>>) {
    let _serial = crate::reaper::reap_test_guard().await;
    completes(async {
        let root = tempfile::tempdir().unwrap();
        let server = Arc::new(GuestServer::new(crate::layout::GuestLayout::with_base(
            root.path(),
        )));
        let tasks = Arc::new(super::super::TaskGroup::default());
        let ssh = ForwardingSession::new(server.clone(), tasks.clone()).await;
        let ingress = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let SocketAddr::V4(address) = ingress.local_addr().unwrap() else {
            unreachable!()
        };
        let path = root.path().join("output.sock");
        let (mut helper, guard) = fixture(server.clone(), tasks.clone(), &path, address).await;
        let state = server.registry.get(&helper.execution_id).await.unwrap();
        let (sender, receiver) = mpsc::channel(4);
        let mut original = std::mem::replace(&mut helper.output, receiver);
        tasks.spawn_tracked(|_| async move { while original.recv().await.is_some() {} });
        sender.send(Ok(ExecOutput { event: None })).await.unwrap();
        sender
            .send(Ok(ExecOutput {
                event: Some(exec_output::Event::Stderr(boxlite_shared::Stderr {
                    data: b"diagnostic".to_vec(),
                    ..Default::default()
                })),
            }))
            .await
            .unwrap();
        if let Some(output) = output {
            sender.send(output).await.unwrap();
        }
        drop(sender);
        let listeners = ListenerRegistry::default();
        let registration = listeners
            .register(path.to_str().unwrap().into(), 1, &tasks)
            .unwrap();
        spawn_listener(
            ingress,
            path.to_str().unwrap().into(),
            "9e3d4f4f-e9e5-4896-a42c-9fe5f53244af".into(),
            ssh.handle.clone(),
            Arc::new(Semaphore::new(1)),
            helper,
            registration,
        );
        state.wait_process().await;
        ssh.close().await;
        tasks.wait().await;
        assert_eq!(listeners.len(), 0);
        assert!(server.registry.get("reverse-helper-test").await.is_none());
        assert_eq!(
            nix::sys::wait::waitpid(guard.pid(), Some(nix::sys::wait::WaitPidFlag::WNOHANG)),
            Err(nix::errno::Errno::ECHILD)
        );
    })
    .await;
}

#[derive(Clone, Copy)]
enum FailedStartExit {
    Natural,
    Term,
    Kill,
}

async fn failed_helper_start(expected: FailedStartExit) {
    let _serial = crate::reaper::reap_test_guard().await;

    completes(async {
        let root = tempfile::tempdir().unwrap();
        let server = Arc::new(GuestServer::new(crate::layout::GuestLayout::with_base(
            root.path(),
        )));
        let tasks = Arc::new(super::super::TaskGroup::default());
        let ingress = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let SocketAddr::V4(address) = ingress.local_addr().unwrap() else {
            unreachable!()
        };
        let (helper, guard) = fixture_with_signals(
            server.clone(),
            tasks.clone(),
            &root.path().join("failed.sock"),
            address,
            matches!(expected, FailedStartExit::Kill),
        )
        .await;
        let state = server.registry.get(&helper.execution_id).await.unwrap();
        let _relay = if matches!(expected, FailedStartExit::Natural) {
            None
        } else {
            let unix = UnixStream::connect(root.path().join("failed.sock"))
                .await
                .unwrap();
            let (mut tcp, _) = ingress.accept().await.unwrap();
            let mut token = [0; INGRESS_TOKEN_BYTES];
            tcp.read_exact(&mut token).await.unwrap();
            Some((unix, tcp))
        };
        let RunningHelper {
            stdin,
            stdin_task,
            output,
            execution_id,
            registry,
            ..
        } = helper;
        if matches!(expected, FailedStartExit::Natural) {
            stdin
                .send(ExecStdin {
                    execution_id: execution_id.clone(),
                    data: vec![],
                    close: true,
                })
                .await
                .unwrap();
        }
        if matches!(expected, FailedStartExit::Natural) {
            state.wait_process().await;
        }
        spawn_execution_cleanup(
            tasks.clone(),
            server.clone(),
            registry,
            execution_id,
            HelperIo {
                stdin: Some(stdin),
                output: Some(output),
                stdin_task: Some(stdin_task),
            },
            HelperCleanup::Terminate,
        );
        tasks.wait().await;
        let exit = state.wait_process().await;
        use crate::service::exec::exec_handle::ExitStatus;
        use nix::sys::signal::Signal;
        match expected {
            FailedStartExit::Natural => assert!(matches!(exit, ExitStatus::Code(0))),
            FailedStartExit::Term => assert!(matches!(exit, ExitStatus::Code(0))),
            FailedStartExit::Kill => assert!(matches!(exit, ExitStatus::Signal(Signal::SIGKILL))),
        }
        assert!(server.registry.get("reverse-helper-test").await.is_none());
        assert_eq!(
            nix::sys::wait::waitpid(guard.pid(), Some(nix::sys::wait::WaitPidFlag::WNOHANG)),
            Err(nix::errno::Errno::ECHILD)
        );
    })
    .await;
}

#[tokio::test]
async fn invalid_helper_output_removes_listener() {
    helper_output_failure(Some(Ok(ExecOutput {
        event: Some(exec_output::Event::Stdout(boxlite_shared::Stdout {
            data: b"invalid".to_vec(),
            ..Default::default()
        })),
    })))
    .await;
}

#[tokio::test]
async fn helper_output_error_removes_listener() {
    helper_output_failure(Some(Err(tonic::Status::internal("test output failure")))).await;
}

#[tokio::test]
async fn helper_output_eof_removes_listener() {
    helper_output_failure(None).await;
}

#[tokio::test]
async fn failed_helper_start_allows_natural_exit() {
    failed_helper_start(FailedStartExit::Natural).await;
}

#[tokio::test]
async fn failed_helper_start_terminates_normally() {
    failed_helper_start(FailedStartExit::Term).await;
}

#[tokio::test]
async fn failed_helper_start_escalates_to_kill() {
    failed_helper_start(FailedStartExit::Kill).await;
}

#[tokio::test]
async fn premature_helper_exit_removes_listener_and_releases_execution() {
    let _serial = crate::reaper::reap_test_guard().await;
    completes(async {
        let fixture = ListenerFixture::new().await;
        assert!(fixture
            .server
            .kill_execution("reverse-helper-test", 9, true)
            .await
            .unwrap());
        fixture.state.wait_process().await;
        // Await the production registry release while SSH is still connected.
        while fixture.server.registry.exists("reverse-helper-test").await {
            tokio::task::yield_now().await;
        }
        assert_eq!(fixture.listeners.len(), 0);
        assert!(TcpStream::connect(fixture.ingress).await.is_err());
        fixture.finish().await;
    })
    .await;
}

async fn register_helper(server: &GuestServer, command: &mut Command) -> ChildGuard {
    let reaper = Reaper::install();
    let spawned = std::time::Instant::now();
    let child = command.spawn().unwrap();
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
    guard
}

// Report the exact I/O boundary from inside the production helper future. The
// parent never guesses signal readiness from a sleep or pathname polling.
struct ObservedControl {
    pipe: tokio::net::unix::pipe::Receiver,
    report_pending: bool,
}

impl AsyncRead for ObservedControl {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let result = std::pin::Pin::new(&mut self.pipe).poll_read(cx, buffer);
        if result.is_pending() && self.report_pending {
            self.report_pending = false;
            report_blocked();
        }
        result
    }
}

struct BlockedStatus {
    marker: &'static [u8],
    reported: bool,
}

impl AsyncWrite for BlockedStatus {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        if bytes == self.marker {
            if !self.reported {
                self.reported = true;
                report_blocked();
            }
            return std::task::Poll::Pending;
        }
        std::task::Poll::Ready(Ok(bytes.len()))
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

fn report_blocked() {
    use std::io::Write;
    if std::env::var("BOXLITE_TEST_BLOCKED_PHASE").as_deref() == Ok("startup") {
        std::io::stdout().write_all(b"BLOCKED\n").unwrap();
    } else {
        std::io::stderr().write_all(b"BLOCKED\n").unwrap();
    }
}

#[test]
#[ignore = "invoked as an isolated helper subprocess"]
fn blocked_io_helper_subprocess() {
    let phase = std::env::var("BOXLITE_TEST_BLOCKED_PHASE").unwrap();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let control = ObservedControl {
                pipe: tokio::net::unix::pipe::Receiver::from_owned_fd(
                    std::io::stdin().as_fd().try_clone_to_owned().unwrap(),
                )
                .unwrap(),
                report_pending: phase == "token",
            };
            let status = BlockedStatus {
                marker: if phase == "stopped" {
                    REVERSE_STREAMLOCAL_STOPPED_MAGIC
                } else {
                    REVERSE_STREAMLOCAL_READY_MAGIC
                },
                reported: false,
            };
            serve_reverse_streamlocal(
                InternalArgs {
                    socket_path: std::env::var("BOXLITE_TEST_HELPER_SOCKET").unwrap(),
                    ingress: "127.0.0.1:1".parse().unwrap(),
                },
                control,
                status,
            )
            .await
            .unwrap();
        });
}

async fn terminate_blocked_helper(phase: &str) {
    let _serial = crate::reaper::reap_test_guard().await;
    completes(async {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("blocked.sock");
        let server = Arc::new(GuestServer::new(crate::layout::GuestLayout::with_base(
            root.path(),
        )));
        let tasks = Arc::new(super::super::TaskGroup::default());
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "service::ssh::reverse_streamlocal::shutdown_tests::blocked_io_helper_subprocess",
                "--ignored",
                "--nocapture",
            ])
            .env("BOXLITE_TEST_BLOCKED_PHASE", phase)
            .env("BOXLITE_TEST_HELPER_SOCKET", &path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .process_group(0);
        let guard = register_helper(&server, &mut command).await;
        let execution_id = "reverse-helper-test".to_string();
        let state = server.registry.get(&execution_id).await.unwrap();
        let mut output = server.attach_execution(&execution_id).await.unwrap();
        let (stdin, input) = mpsc::channel(2);
        let input_task = server
            .send_execution_input(
                ExecStdin {
                    execution_id: execution_id.clone(),
                    data: vec![],
                    close: false,
                },
                Box::pin(ReceiverStream::new(input).map(Ok)),
            )
            .await
            .unwrap();
        let stdin_task = tasks.spawn_tracked(|_| async move {
            let _ = input_task.await;
        });
        if phase != "token" {
            stdin
                .send(ExecStdin {
                    execution_id: execution_id.clone(),
                    data: b"9e3d4f4f-e9e5-4896-a42c-9fe5f53244af".to_vec(),
                    close: phase == "stopped",
                })
                .await
                .unwrap();
        }
        read_marker(&mut output, b"BLOCKED\n", vec![], 0)
            .await
            .unwrap();
        assert_eq!(path.exists(), phase == "ready");
        spawn_execution_cleanup(
            tasks.clone(),
            server.clone(),
            server.registry.clone(),
            execution_id.clone(),
            HelperIo {
                stdin: Some(stdin),
                output: Some(output),
                stdin_task: Some(stdin_task),
            },
            HelperCleanup::Terminate,
        );
        tasks.wait().await;
        assert!(
            matches!(
                state.wait_process().await,
                crate::service::exec::exec_handle::ExitStatus::Code(0)
            ),
            "SIGTERM must exit normally while {phase} is blocked"
        );
        assert!(!path.exists());
        assert!(!server.registry.exists(&execution_id).await);
        assert_eq!(
            nix::sys::wait::waitpid(guard.pid(), Some(nix::sys::wait::WaitPidFlag::WNOHANG)),
            Err(nix::errno::Errno::ECHILD)
        );
    })
    .await;
}

#[tokio::test]
async fn term_interrupts_token_read() {
    terminate_blocked_helper("token").await;
}

#[tokio::test]
async fn term_interrupts_ready_output() {
    terminate_blocked_helper("ready").await;
}

#[tokio::test]
async fn term_interrupts_stopped_output() {
    terminate_blocked_helper("stopped").await;
}

#[tokio::test]
async fn shutdown_configure_terminates_active_helper() {
    shutdown_silent_helper(false, Shutdown::Configure).await;
}

#[tokio::test]
async fn shutdown_disconnect_terminates_active_helper() {
    shutdown_silent_helper(false, Shutdown::Connection).await;
}

#[tokio::test]
async fn term_preserves_replacement_socket() {
    let _serial = crate::reaper::reap_test_guard().await;
    completes(async {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("owned.sock");
        let displaced = root.path().join("displaced.sock");
        let server = Arc::new(GuestServer::new(crate::layout::GuestLayout::with_base(
            root.path(),
        )));
        let tasks = Arc::new(super::super::TaskGroup::default());
        let ingress = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let SocketAddr::V4(address) = ingress.local_addr().unwrap() else {
            unreachable!()
        };
        let (helper, _guard) = fixture(server.clone(), tasks.clone(), &path, address).await;
        let state = server.registry.get(&helper.execution_id).await.unwrap();
        std::fs::rename(&path, &displaced).unwrap();
        let replacement = UnixListener::bind(&path).unwrap();
        helper.spawn_cleanup(HelperCleanup::Terminate);
        tasks.wait().await;
        assert!(matches!(
            state.wait_process().await,
            crate::service::exec::exec_handle::ExitStatus::Code(0)
        ));
        let _client = UnixStream::connect(&path).await.unwrap();
        replacement.accept().await.unwrap();
        assert!(!server.registry.exists("reverse-helper-test").await);
    })
    .await;
}

#[tokio::test]
async fn startup_cancellation_hands_execution_to_tracked_cleanup() {
    let _serial = crate::reaper::reap_test_guard().await;
    completes(async {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("startup.sock");
        let server = Arc::new(GuestServer::new(crate::layout::GuestLayout::with_base(
            root.path(),
        )));
        let tasks = Arc::new(super::super::TaskGroup::default());
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "service::ssh::reverse_streamlocal::shutdown_tests::blocked_io_helper_subprocess",
                "--ignored",
                "--nocapture",
            ])
            .env("BOXLITE_TEST_BLOCKED_PHASE", "startup")
            .env("BOXLITE_TEST_HELPER_SOCKET", &path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut guard = register_helper(&server, &mut command).await;
        let events =
            tokio::net::unix::pipe::Receiver::from_owned_fd(guard.0.stdout.take().unwrap().into())
                .unwrap();
        let mut events = tokio::io::BufReader::new(events);
        let state = server.registry.get("reverse-helper-test").await.unwrap();
        let start = RunningHelper::attach(
            tasks.clone(),
            server.clone(),
            server.registry.clone(),
            "reverse-helper-test".into(),
            "9e3d4f4f-e9e5-4896-a42c-9fe5f53244af".into(),
        );
        tokio::pin!(start);
        let blocked = async {
            use tokio::io::AsyncBufReadExt;
            let mut line = String::new();
            loop {
                assert_ne!(events.read_line(&mut line).await.unwrap(), 0);
                if line.contains("BLOCKED") {
                    break;
                }
                line.clear();
            }
        };
        tokio::select! {
            _ = blocked => {},
            _ = &mut start => panic!("startup returned before helper status was blocked"),
        }
        tasks.cancel();
        let result = start.await;
        if let Ok(helper) = result {
            helper.spawn_cleanup(HelperCleanup::Terminate);
            panic!("cancelled startup unexpectedly succeeded");
        }
        assert!(
            result.err().unwrap().contains("cancelled"),
            "startup must observe connection cancellation"
        );
        tasks.wait().await;
        assert!(matches!(
            state.wait_process().await,
            crate::service::exec::exec_handle::ExitStatus::Code(0)
        ));
        assert!(!path.exists());
        assert!(!server.registry.exists("reverse-helper-test").await);
        assert_eq!(
            nix::sys::wait::waitpid(guard.pid(), Some(nix::sys::wait::WaitPidFlag::WNOHANG)),
            Err(nix::errno::Errno::ECHILD)
        );
    })
    .await;
}

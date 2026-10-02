use super::*;
use crate::reaper::Reaper;
use crate::service::exec::{
    exec_handle::{ExecHandle, ExitStatus},
    process_instance::ProcessInstance,
    state::ExecutionState,
};
use crate::service::ssh::forwarding_fixture::completes;
use nix::{sys::signal::Signal, unistd::Pid};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command as ProcessCommand, Stdio};

struct ProcessGuard(Child, Option<ProcessInstance>);

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        let _fence = crate::reaper::reap_fence();
        let pid = Pid::from_raw(self.0.id() as i32);
        if self.1.is_some() && ProcessInstance::capture(pid) == self.1 {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

async fn running_execution(server: &GuestServer) -> (ProcessGuard, ExecutionState) {
    let reaper = Reaper::install();
    let started = std::time::Instant::now();
    // Readiness follows signal setup so cleanup must reach SIGKILL, even if
    // the scheduler runs the parent immediately after receiving this marker.
    let child = ProcessCommand::new("/bin/sh")
        .args(["-c", "trap '' HUP TERM; printf ready; read line"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = Pid::from_raw(child.id() as i32);
    let mut guard = ProcessGuard(child, ProcessInstance::capture(pid));
    let handle = ExecHandle::new(
        pid,
        guard.0.stdin.take().unwrap().into(),
        guard.0.stdout.take().unwrap().into(),
        None,
    )
    .unwrap();
    let state = ExecutionState::new_init_session(
        handle,
        reaper.register(pid, started).await,
        ProcessInstance::capture(pid),
    );
    assert!(
        server
            .registry
            .register("bridge-cleanup".into(), state.clone())
            .await
    );
    let mut output = server.attach_execution("bridge-cleanup").await.unwrap();
    let mut ready = Vec::new();
    while ready.len() < 5 {
        let frame = output.recv().await.unwrap().unwrap();
        if let Some(boxlite_shared::exec_output::Event::Stdout(stdout)) = frame.event {
            ready.extend(stdout.data);
        }
    }
    assert_eq!(ready, b"ready");
    (guard, state)
}

#[tokio::test]
async fn failed_start_terminates_reaps_and_releases_execution() {
    let _serial = crate::reaper::reap_test_guard().await;
    completes(async {
        let root = tempfile::tempdir().unwrap();
        let server = Arc::new(GuestServer::new(crate::layout::GuestLayout::with_base(
            root.path(),
        )));
        let tasks = Arc::new(super::super::TaskGroup::default());
        let (guard, state) = running_execution(&server).await;
        cleanup_failed_execution_start(tasks.clone(), server.clone(), "bridge-cleanup".into());
        tasks.wait().await;
        assert!(matches!(
            state.wait_process().await,
            ExitStatus::Signal(Signal::SIGKILL)
        ));
        assert!(!server.registry.exists("bridge-cleanup").await);
        assert_eq!(
            nix::sys::wait::waitpid(
                Pid::from_raw(guard.0.id() as i32),
                Some(nix::sys::wait::WaitPidFlag::WNOHANG)
            ),
            Err(nix::errno::Errno::ECHILD)
        );
    })
    .await;
}

#[tokio::test]
async fn bridge_drop_cancels_output_and_reaps_process_before_parent_finishes() {
    let _serial = crate::reaper::reap_test_guard().await;
    completes(async {
        let root = tempfile::tempdir().unwrap();
        let server = Arc::new(GuestServer::new(crate::layout::GuestLayout::with_base(
            root.path(),
        )));
        let connection_tasks = Arc::new(super::super::TaskGroup::default());
        let tasks = connection_tasks.child();
        let (guard, state) = running_execution(&server).await;
        let (started, running) = oneshot::channel();
        let (held, released) = oneshot::channel::<()>();
        let output = tasks.spawn(async move {
            let _held = held;
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        running.await.unwrap();
        spawn_execution_cleanup(
            tasks.clone(),
            server.clone(),
            "bridge-cleanup".into(),
            output,
        );
        let (sender, _receiver) = mpsc::channel(1);
        let bridge = ChannelBridge {
            channel_tasks: tasks.clone(),
            server: server.clone(),
            execution_id: "bridge-cleanup".into(),
            stdin: StdinForwarder {
                channel_tasks: tasks,
                execution_id: "bridge-cleanup".into(),
                sender,
            },
            output_activate: None,
        };
        drop(bridge);
        connection_tasks.wait().await;
        assert!(released.await.is_err());
        assert!(matches!(
            state.wait_process().await,
            ExitStatus::Signal(Signal::SIGKILL)
        ));
        assert!(!server.registry.exists("bridge-cleanup").await);
        assert!(!connection_tasks.is_cancelled());
        assert_eq!(
            nix::sys::wait::waitpid(
                Pid::from_raw(guard.0.id() as i32),
                Some(nix::sys::wait::WaitPidFlag::WNOHANG)
            ),
            Err(nix::errno::Errno::ECHILD)
        );
    })
    .await;
}

#[tokio::test]
async fn bridge_start_without_container_releases_child_task_group() {
    use crate::service::ssh::forwarding_fixture::ForwardingSession;

    completes(async {
        let root = tempfile::tempdir().unwrap();
        let server = Arc::new(GuestServer::new(crate::layout::GuestLayout::with_base(
            root.path(),
        )));
        let tasks = Arc::new(super::super::TaskGroup::default());
        let mut ssh = ForwardingSession::new(server.clone(), tasks.clone()).await;
        let handle = ssh.handle.clone();
        let (channel, ()) = tokio::join!(
            handle.channel_open_forwarded_streamlocal("/test.sock"),
            async {
                let opened = ssh.channels.recv().await.unwrap();
                opened.reply.accept().await;
            }
        );
        let channel = channel.unwrap();
        let result = ChannelBridge::start(
            tasks.clone(),
            server,
            Command::Shell,
            None,
            HashMap::new(),
            channel.id(),
            ssh.handle.clone(),
        )
        .await;
        assert!(matches!(result, Err(BridgeError::Target(_))));
        ssh.close().await;
        tasks.wait().await;
    })
    .await;
}

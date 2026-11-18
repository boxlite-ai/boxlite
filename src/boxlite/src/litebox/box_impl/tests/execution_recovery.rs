use super::*;
use boxlite_shared::{
    AttachRequest, ExecOutput, ExecRequest, ExecResponse, Execution as ExecutionService,
    ExecutionInfo as GuestExecutionInfo, ExecutionServer, KillRequest, KillResponse,
    ListExecutionsRequest, ListExecutionsResponse, ResizeTtyRequest, ResizeTtyResponse,
    SendInputAck, WaitRequest, WaitResponse,
};
use std::pin::Pin;

struct ExitRecoveryGuest {
    main_id: String,
}

#[tonic::async_trait]
impl ExecutionService for ExitRecoveryGuest {
    async fn exec(&self, _: Request<ExecRequest>) -> Result<Response<ExecResponse>, Status> {
        panic!("recovering an execution must not start a command");
    }

    async fn list_executions(
        &self,
        _: Request<ListExecutionsRequest>,
    ) -> Result<Response<ListExecutionsResponse>, Status> {
        Ok(Response::new(ListExecutionsResponse {
            executions: vec![
                GuestExecutionInfo {
                    execution_id: self.main_id.clone(),
                    is_main_session: true,
                    ..Default::default()
                },
                GuestExecutionInfo {
                    execution_id: "auxiliary".into(),
                    ..Default::default()
                },
            ],
        }))
    }

    type AttachStream =
        Pin<Box<dyn futures::Stream<Item = Result<ExecOutput, Status>> + Send + 'static>>;

    async fn attach(
        &self,
        _: Request<AttachRequest>,
    ) -> Result<Response<Self::AttachStream>, Status> {
        panic!("control recovery must not claim an output reader");
    }

    async fn send_input(
        &self,
        _: Request<tonic::Streaming<boxlite_shared::ExecStdin>>,
    ) -> Result<Response<SendInputAck>, Status> {
        panic!("control recovery must not claim stdin");
    }

    async fn wait(&self, request: Request<WaitRequest>) -> Result<Response<WaitResponse>, Status> {
        if request.into_inner().execution_id == self.main_id {
            return Err(Status::unavailable(
                "guest powered off after writing init exit",
            ));
        }
        Ok(Response::new(WaitResponse {
            signal: libc::SIGHUP,
            error_message: "guest reported SIGHUP".into(),
            ..Default::default()
        }))
    }

    async fn kill(&self, _: Request<KillRequest>) -> Result<Response<KillResponse>, Status> {
        panic!("recovering an execution must not kill it");
    }

    async fn resize_tty(
        &self,
        _: Request<ResizeTtyRequest>,
    ) -> Result<Response<ResizeTtyResponse>, Status> {
        panic!("recovering an execution must not resize it");
    }
}

#[tokio::test]
async fn recovered_main_wait_uses_exit_file_without_changing_auxiliary_status() {
    let gate = Arc::new(StartGate::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind execution guest");
    let address = listener.local_addr().expect("execution guest address");
    let incoming = tonic::transport::server::TcpIncoming::from_listener(listener, true, None)
        .expect("configure execution guest listener");
    let mut fixture = running_box_for_start_test_with_live(Arc::clone(&gate), |live| {
        live.guest_session = GuestSession::new(BoxTransport::tcp(address.port()));
    })
    .await;
    let main_id = fixture.box_impl.container_id().to_owned();
    fixture.server.abort();
    fixture.server = tokio::spawn(async move {
        Server::builder()
            .add_service(ExecutionServer::new(ExitRecoveryGuest { main_id }))
            .serve_with_incoming(incoming)
            .await
            .expect("serve execution guest");
    });
    let box_impl = &fixture.box_impl;
    let exit_file = box_impl.layout.container_exit_file(box_impl.container_id());
    std::fs::create_dir_all(exit_file.parent().unwrap()).expect("create exit-file directory");
    boxlite_shared::layout::ExitRecord { exit_code: 129 }
        .write(&exit_file)
        .expect("write guest exit record");

    for (id, expected) in [(box_impl.container_id(), 129), ("auxiliary", -libc::SIGHUP)] {
        let mut execution = box_impl.get_execution(id).await.expect("recover execution");
        assert!(execution.stdin().is_none());
        assert!(execution.stdout().is_none());
        assert!(execution.stderr().is_none());
        let result = tokio::time::timeout(Duration::from_secs(5), execution.wait())
            .await
            .expect("recovered wait must complete")
            .expect("wait for recovered execution");
        assert_eq!(result.exit_code, expected);
        let diagnostic = if id == box_impl.container_id() {
            None
        } else {
            Some("guest reported SIGHUP")
        };
        assert_eq!(result.error_message.as_deref(), diagnostic);
    }
    assert_eq!(gate.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn dropping_main_wait_receiver_releases_the_upstream() {
    let fixture = running_box_for_start_test(Arc::new(StartGate::default())).await;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let downstream = fixture
        .box_impl
        .exit_code_from_file_when_portal_has_none(rx);
    drop(downstream);
    tokio::time::timeout(Duration::from_secs(1), tx.closed())
        .await
        .expect("discarding a recovered main handle retained its upstream wait");
}

struct BindingBlocker(std::path::PathBuf);

impl Drop for BindingBlocker {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[tokio::test]
async fn cold_execution_list_failure_preserves_running_shim() {
    let temp_dir = TempDir::new_in("/tmp").expect("create temp dir");
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: temp_dir.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    })
    .expect("create runtime");
    let (mut child, id, pid) = running_box_with_standin(&runtime, false, 0, Vec::new());
    let layout = runtime
        .layout
        .box_layout(id.as_str(), false)
        .expect("box layout");
    let sockets = layout.sockets();
    sockets.ensure().expect("prepare socket binding parent");
    sockets.remove();
    let binding = sockets.binding_dir();
    std::fs::write(&binding, "occupied binding path").expect("place binding blocker");
    let _blocker = BindingBlocker(binding.clone());
    let litebox = runtime
        .get(id.as_str())
        .await
        .expect("get box")
        .expect("box exists");

    let error = litebox
        .executions()
        .list()
        .await
        .expect_err("guest reconnect must reject the non-symlink binding");
    let message = error.to_string();
    assert!(message.contains("not a symlink"), "{message}");
    assert!(
        message.contains(&binding.display().to_string()),
        "{message}"
    );
    let (_, persisted) = runtime
        .box_manager
        .box_by_id(&id)
        .expect("load persisted box")
        .expect("box remains registered");
    assert_eq!(persisted.status, BoxStatus::Running);
    assert_eq!(persisted.pid, Some(pid));
    assert!(
        child
            .0
            .try_wait()
            .expect("query stand-in process")
            .is_none(),
        "failed discovery must leave the existing shim alive"
    );
}

#[tokio::test]
async fn list_executions_rejects_frozen_and_leaves_idle_boxes_unstarted() {
    let temp_dir = TempDir::new_in("/tmp").expect("create temp dir");
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: temp_dir.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    })
    .expect("create runtime");
    for status in [
        BoxStatus::Configured,
        BoxStatus::Stopped,
        BoxStatus::Paused,
        BoxStatus::Quiesced,
    ] {
        let id = BoxIDMint::mint();
        let config = BoxConfig {
            id: id.clone(),
            name: None,
            created_at: Utc::now(),
            container: ContainerRuntimeConfig {
                id: ContainerID::new(),
            },
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            box_home: runtime.layout.boxes_dir().join(id.as_str()),
        };
        let mut state = BoxState::new();
        state.status = status;
        let lock_id = runtime.lock_manager.allocate().unwrap();
        runtime
            .disk_lock_manager
            .allocate_and_retrieve(lock_id)
            .unwrap();
        state.set_lock_id(lock_id);
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("persist test box");
        let box_impl = BoxImpl::new(
            config,
            state,
            runtime.clone(),
            runtime.shutdown_token.child_token(),
        );

        if matches!(status, BoxStatus::Paused | BoxStatus::Quiesced) {
            assert!(matches!(
                box_impl.ensure_booted().await,
                Err(BoxliteError::InvalidState(_))
            ));
            assert!(matches!(
                box_impl.start().await,
                Err(BoxliteError::InvalidState(_))
            ));
            assert!(matches!(
                box_impl.live_state().await,
                Err(BoxliteError::InvalidState(_))
            ));
        }
        let result = box_impl.list_executions().await;
        if matches!(status, BoxStatus::Paused | BoxStatus::Quiesced) {
            assert!(matches!(result, Err(BoxliteError::InvalidState(_))));
        } else {
            assert!(result.expect("list idle box").is_empty());
        }
        assert_eq!(box_impl.state.read().status, status);
        assert!(!box_impl.live.initialized());
        assert!(!box_impl.container_start.initialized());
        let (_, persisted) = runtime
            .box_manager
            .box_by_id(&id)
            .expect("load persisted box")
            .expect("box remains registered");
        assert_eq!(persisted.status, status);
        assert_eq!(persisted.pid, None);
    }
}

async fn recovered_frozen_standin(
    status: BoxStatus,
    legacy: bool,
) -> (TempDir, SharedRuntimeImpl, ChildGuard, BoxID, u32) {
    let home = TempDir::new_in("/tmp").unwrap();
    let options = BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    };
    let runtime = RuntimeImpl::new_for_test(options.clone()).unwrap();
    let (child, id, pid) = running_box_with_standin(&runtime, false, 0, Vec::new());
    let mut state = runtime.box_manager.update_box(&id).unwrap();
    state.set_status(status);
    runtime.box_manager.save_box(&id, &state).unwrap();
    if legacy {
        let layout = runtime.layout.box_layout(id.as_str(), false).unwrap();
        std::fs::write(layout.pid_file_path(), pid.to_string()).unwrap();
    }
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGSTOP) }, 0);
    // No handles were handed out by the first runtime; leave the shim for recovery.
    runtime.shutdown(None).await.unwrap();
    drop(runtime);
    let recovered = RuntimeImpl::new_for_test(options).unwrap();
    (home, recovered, child, id, pid)
}

#[tokio::test]
async fn stop_terminates_recovered_frozen_shim() {
    for status in [BoxStatus::Paused, BoxStatus::Quiesced] {
        let (_home, runtime, _child, id, pid) = recovered_frozen_standin(status, false).await;
        let handle = runtime.get(id.as_str()).await.unwrap().unwrap();
        let bx = Arc::clone(&handle.box_backend)
            .as_any_arc()
            .downcast::<BoxImpl>()
            .ok()
            .unwrap();
        assert_eq!(bx.state.read().status, status);
        assert!(!bx.live.initialized());

        handle.stop().await.unwrap();

        assert!(!is_process_alive(pid), "stop left the {status} shim alive");
        assert!(!bx.live.initialized());
        assert!(!bx.layout.pid_file_path().exists());
        let persisted = runtime.box_manager.update_box(&id).unwrap();
        assert_eq!(
            (persisted.status, persisted.pid),
            (BoxStatus::Stopped, None)
        );
    }
}

#[tokio::test]
async fn sync_shutdown_terminates_recovered_frozen_shim() {
    let (_home, runtime, _child, id, pid) =
        recovered_frozen_standin(BoxStatus::Quiesced, false).await;
    runtime.shutdown_sync();

    assert!(!is_process_alive(pid), "sync shutdown left the shim alive");
    let persisted = runtime.box_manager.update_box(&id).unwrap();
    assert_eq!(
        (persisted.status, persisted.pid),
        (BoxStatus::Stopped, None)
    );
    let layout = runtime.layout.box_layout(id.as_str(), false).unwrap();
    assert!(!layout.pid_file_path().exists());
}

#[tokio::test]
async fn snapshot_restore_rejects_recovered_unknown_shim() {
    let (_home, runtime, _child, id, pid) = recovered_frozen_standin(BoxStatus::Paused, true).await;
    let handle = runtime.get(id.as_str()).await.unwrap().unwrap();
    let (config, persisted) = runtime.box_manager.box_by_id(&id).unwrap().unwrap();
    assert_eq!(
        (persisted.status, persisted.pid),
        (BoxStatus::Unknown, Some(pid))
    );
    let disks = config.box_home.join("disks");
    std::fs::create_dir_all(&disks).unwrap();
    let disk = disks.join(crate::disk::constants::filenames::CONTAINER_DISK);
    crate::disk::Qcow2Helper::create_disk(&disk, true)
        .unwrap()
        .leak();
    for name in ["restore-point", "current-point"] {
        runtime
            .snapshot_mgr
            .create(&config.box_home, name, id.as_str())
            .unwrap();
    }
    let before = std::fs::read(&disk).unwrap();

    let result = handle.snapshots().restore("restore-point").await;

    assert!(
        std::fs::read(&disk).unwrap() == before,
        "restore replaced the Unknown box's disk: {result:?}"
    );
    assert!(matches!(result, Err(BoxliteError::InvalidState(_))));
}

async fn assert_snapshot_rejects_recovered_frozen_shim(status: BoxStatus) {
    let (_home, runtime, _child, id, pid) = recovered_frozen_standin(status, false).await;
    if status == BoxStatus::Quiesced {
        // Simulate SIGCONT having landed without the Running state being saved.
        assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGCONT) }, 0);
    }
    let handle = runtime.get(id.as_str()).await.unwrap().unwrap();
    let (config, persisted) = runtime.box_manager.box_by_id(&id).unwrap().unwrap();
    assert_eq!((persisted.status, persisted.pid), (status, Some(pid)));
    let layout = runtime.layout.box_layout(id.as_str(), false).unwrap();
    let pid_file = layout.pid_file_path();
    let pid_record = std::fs::read(&pid_file).unwrap();
    assert_eq!(PidFileReader::at(&pid_file).read().unwrap().pid, pid);

    let disks = config.box_home.join("disks");
    std::fs::create_dir_all(&disks).unwrap();
    let disk = disks.join(crate::disk::constants::filenames::CONTAINER_DISK);
    crate::disk::Qcow2Helper::create_disk(&disk, true)
        .unwrap()
        .leak();
    let before = std::fs::read(&disk).unwrap();

    let snapshots = handle.snapshots();
    let result = snapshots.create(Default::default(), "blocked").await;

    assert!(
        std::fs::read(&disk).unwrap() == before,
        "snapshot disk callback ran for {status}: {result:?}"
    );
    assert!(snapshots.list().await.unwrap().is_empty());
    assert!(matches!(result, Err(BoxliteError::InvalidState(_))));
    let persisted = runtime.box_manager.update_box(&id).unwrap();
    assert_eq!((persisted.status, persisted.pid), (status, Some(pid)));
    assert_eq!(std::fs::read(pid_file).unwrap(), pid_record);
}

#[tokio::test]
async fn snapshot_rejects_recovered_quiesced_shim() {
    assert_snapshot_rejects_recovered_frozen_shim(BoxStatus::Quiesced).await;
}

#[tokio::test]
async fn snapshot_rejects_recovered_paused_shim() {
    assert_snapshot_rejects_recovered_frozen_shim(BoxStatus::Paused).await;
}

#[tokio::test]
async fn quiesce_rejects_recovered_unknown_shim_from_pid_file() {
    let (_home, runtime, _child, id, _) = recovered_frozen_standin(BoxStatus::Quiesced, true).await;
    let handle = runtime.get(id.as_str()).await.unwrap().unwrap();
    let bx = Arc::clone(&handle.box_backend)
        .as_any_arc()
        .downcast::<BoxImpl>()
        .ok()
        .unwrap();
    let mut persisted = runtime.box_manager.update_box(&id).unwrap();
    assert_eq!(persisted.status, BoxStatus::Unknown);
    persisted.set_pid(None);
    runtime.box_manager.save_box(&id, &persisted).unwrap();

    let mut called = false;
    let result = bx
        .with_quiesce_async(async {
            called = true;
            Ok(())
        })
        .await;

    assert!(!called, "quiesce ran disk work for a live Unknown box");
    assert!(matches!(result, Err(BoxliteError::InvalidState(_))));
    assert_eq!(bx.state.read().pid, None);
}

#[tokio::test]
async fn stop_preserves_unverified_frozen_shim() {
    let (_home, runtime, _child, id, pid) =
        recovered_frozen_standin(BoxStatus::Paused, false).await;
    let handle = runtime.get(id.as_str()).await.unwrap().unwrap();
    let pid_file = runtime
        .layout
        .box_layout(id.as_str(), false)
        .unwrap()
        .pid_file_path();
    let fingerprint = crate::util::process_start_time(pid).unwrap();
    let record = format!("{pid}\n{}\n", fingerprint + 1);
    std::fs::write(&pid_file, &record).unwrap();

    let result = handle.stop().await;

    assert!(
        matches!(result, Err(BoxliteError::InvalidState(_))),
        "stop accepted an unverified frozen shim: {result:?}"
    );
    assert!(is_process_alive(pid));
    assert_eq!(std::fs::read_to_string(pid_file).unwrap(), record);
    let persisted = runtime.box_manager.update_box(&id).unwrap();
    assert_eq!(
        (persisted.status, persisted.pid),
        (BoxStatus::Paused, Some(pid))
    );
}

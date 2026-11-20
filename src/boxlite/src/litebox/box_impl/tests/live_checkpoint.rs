use super::*;
use crate::BoxliteRuntime;
use crate::db::BoxStore;
use crate::experimental::ExperimentalFeatures;
use crate::litebox::box_impl::live_checkpoint::LiveCheckpointController;
use crate::lock::LockGuard;
use crate::runtime::checkpoints::{CheckpointAction, CheckpointRequest};
use crate::runtime::rt_impl::LocalRuntime;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, mpsc};
use tokio::sync::oneshot;
use tokio::time::timeout;

const DEADLINE: Duration = Duration::from_secs(5);
const RECOVERY_BOOT_ID: &str = "checkpoint-restart";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Freeze,
    Export,
    Settle,
}

type CheckpointCalls = Arc<Mutex<Vec<(String, Phase)>>>;

struct TestCheckpointController<F> {
    boot_id: Option<&'static str>,
    checkpoint: F,
}

impl<F> LiveCheckpointController for TestCheckpointController<F>
where
    F: FnMut(&CheckpointRequest<'_>) -> BoxliteResult<()> + Send,
{
    fn checkpoint(&mut self, request: &CheckpointRequest<'_>) -> BoxliteResult<()> {
        (self.checkpoint)(request)
    }

    fn host_boot_id(&self) -> Option<String> {
        self.boot_id.map(str::to_owned)
    }
}

struct Fixture {
    runtime: BoxliteRuntime,
    home: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let home = TempDir::new_in("/tmp").unwrap();
        let runtime = BoxliteRuntime::new_for_test(runtime_options(home.path())).unwrap();
        Self { home, runtime }
    }

    async fn box_named(&self, name: &str, ephemeral: bool) -> Source {
        let handle = self
            .runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::Image("alpine:latest".into()),
                    detach: !ephemeral,
                    auto_delete: Some(u32::from(ephemeral)),
                    ..Default::default()
                },
                Some(name.into()),
            )
            .await
            .unwrap();
        let bx = Arc::clone(&handle.box_backend)
            .as_any_arc()
            .downcast::<BoxImpl>()
            .ok()
            .unwrap();
        let child = ChildGuard(
            std::process::Command::new("sleep")
                .arg("300")
                .spawn()
                .unwrap(),
        );
        let pid = child.0.id();
        let record = PidRecord {
            pid,
            start_time: Some(crate::util::process_start_time(pid).unwrap()),
        };
        fs::create_dir_all(&bx.config.box_home).unwrap();
        write_shim(&bx.layout.pid_file_path(), record);

        let mut state = bx.state.read().clone();
        state.set_pid(Some(pid));
        state.set_status(BoxStatus::Running);
        state.mark_started();
        bx.runtime.box_manager.save_box(bx.id(), &state).unwrap();
        *bx.state.write() = state.clone();
        Source {
            handle,
            bx,
            child,
            record,
            state,
        }
    }
}

fn runtime_options(home: &Path) -> BoxliteOptions {
    BoxliteOptions {
        home_dir: home.to_owned(),
        image_registries: vec![],
        ..Default::default()
    }
}

struct Source {
    handle: crate::LiteBox,
    bx: SharedBoxImpl,
    child: ChildGuard,
    record: PidRecord,
    state: BoxState,
}

impl Source {
    fn marker(&self) -> PathBuf {
        self.bx.config.box_home.join(".checkpoint_pending")
    }

    fn checkpoint_root(&self) -> PathBuf {
        self.bx.runtime.layout.home_dir().join("live-checkpoints")
    }

    fn attach(
        &self,
        handler: impl VmmHandler + 'static,
        controller: Option<Box<dyn LiveCheckpointController>>,
    ) {
        let mut live = LiveState::new(
            Box::new(handler),
            GuestSession::new(BoxTransport::tcp(0)),
            None,
            None,
            BoxMetricsStorage::new(),
            Disk::new(
                self.bx.config.box_home.join("container.qcow2"),
                DiskFormat::Qcow2,
                true,
            ),
            None,
            #[cfg(target_os = "linux")]
            None,
        );
        live.checkpoint_controller = controller.map(Mutex::new);
        assert!(self.bx.live.set(live).is_ok());
    }

    fn record_calls(
        &self,
        mut at_phase: impl FnMut(Phase) -> BoxliteResult<()> + Send + 'static,
    ) -> CheckpointCalls {
        let calls = CheckpointCalls::default();
        let observed = Arc::clone(&calls);
        let marker = self.marker();
        let root = self.checkpoint_root();
        let id = self.bx.id().to_string();
        let record = self.record;
        let controller = TestCheckpointController {
            boot_id: Some(RECOVERY_BOOT_ID),
            checkpoint: move |request: &CheckpointRequest<'_>| {
                let phase = match request.action {
                    CheckpointAction::FreezeGuest => Phase::Freeze,
                    CheckpointAction::ExportAtomic { staging_dir } => {
                        assert_eq!(staging_dir, staging_path(&root, request.operation_id));
                        fs::write(staging_dir.join("capture"), b"VM checkpoint")?;
                        Phase::Export
                    }
                    CheckpointAction::Settle => Phase::Settle,
                };
                let mut expected = marker_contents(&id, request.operation_id, record);
                expected["boot_id"] = RECOVERY_BOOT_ID.into();
                assert_eq!(read_marker(&marker), expected);
                assert!(!root.join(request.operation_id).exists());
                observed
                    .lock()
                    .unwrap()
                    .push((request.operation_id.to_owned(), phase));
                at_phase(phase)
            },
        };
        self.attach(InfoTestHandler(record.pid), Some(Box::new(controller)));
        calls
    }

    fn assert_same_run(&self) {
        let state = self
            .bx
            .runtime
            .box_manager
            .update_box(self.bx.id())
            .unwrap();
        assert_eq!(
            (state.status, state.pid, state.started_at),
            (BoxStatus::Running, self.state.pid, self.state.started_at)
        );
        assert_eq!(
            PidFileReader::at(self.bx.layout.pid_file_path())
                .read()
                .unwrap(),
            self.record
        );
        assert!(is_process_alive(self.record.pid));
    }
}

fn write_shim(path: &Path, record: PidRecord) {
    PidFileWriter::at(path)
        .unwrap()
        .write_shim(&ShimPidRecord::with_runtime_port_control(record))
        .unwrap();
}

fn marker_contents(id: &str, operation_id: &str, shim: PidRecord) -> serde_json::Value {
    serde_json::json!({"version": 1, "operation_id": operation_id, "box_id": id, "shim": shim})
}

fn read_marker(path: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn staging_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!(".{id}.staging"))
}

#[tokio::test]
async fn live_checkpoint_handle_allows_reopening_the_runtime_home() {
    let Fixture { home, runtime } = Fixture::new();
    let checkpoints = runtime.checkpoints();
    drop(runtime);

    let _reopened = BoxliteRuntime::new_for_test(runtime_options(home.path())).unwrap();
    assert!(matches!(
        checkpoints.capture_live("source").await,
        Err(BoxliteError::Stopped(_))
    ));
}

fn phases(calls: &CheckpointCalls) -> Vec<Phase> {
    calls
        .lock()
        .unwrap()
        .iter()
        .map(|(_, phase)| *phase)
        .collect()
}

#[tokio::test]
async fn live_checkpoint_routes_by_id_and_name_and_commits_once_per_request() {
    let fixture = Fixture::new();
    let source = fixture.box_named("capture-source", false).await;
    let calls = source.record_calls(|_| Ok(()));
    let checkpoints = fixture.runtime.checkpoints();
    let mut destinations = Vec::new();

    for key in [source.bx.id().as_str(), "capture-source"] {
        let output = timeout(DEADLINE, checkpoints.capture_live(key))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(output.join("capture")).unwrap(), b"VM checkpoint");
        let id = output.file_name().unwrap().to_str().unwrap();
        assert_eq!(output.parent().unwrap(), source.checkpoint_root());
        assert!(!staging_path(&source.checkpoint_root(), id).exists());
        assert!(!source.marker().exists());
        source.assert_same_run();
        destinations.push(id.to_owned());
    }

    assert_ne!(destinations[0], destinations[1]);
    for (calls, id) in calls
        .lock()
        .unwrap()
        .as_chunks::<3>()
        .0
        .iter()
        .zip(&destinations)
    {
        assert_eq!(
            calls,
            &[
                (id.clone(), Phase::Freeze),
                (id.clone(), Phase::Export),
                (id.clone(), Phase::Settle)
            ]
        );
    }
    assert_eq!(calls.lock().unwrap().len(), 6);
}

#[tokio::test]
async fn live_checkpoint_requires_boot_id_before_creating_marker_or_freezing() {
    let fixture = Fixture::new();
    let source = fixture.box_named("missing-boot-id", false).await;
    let controller = TestCheckpointController {
        boot_id: None,
        checkpoint: |_: &CheckpointRequest<'_>| panic!("missing boot ID reached the VMM"),
    };
    source.attach(
        InfoTestHandler(source.record.pid),
        Some(Box::new(controller)),
    );

    let error = fixture
        .runtime
        .checkpoints()
        .capture_live("missing-boot-id")
        .await
        .unwrap_err();
    assert!(matches!(error, BoxliteError::InvalidState(_)), "{error}");
    assert!(!source.marker().exists());
    assert!(!source.checkpoint_root().exists());
    source.assert_same_run();
}

#[tokio::test]
async fn live_checkpoint_rejects_invalid_status_identity_handles_and_marker() {
    let fixture = Fixture::new();
    let source = fixture.box_named("rejected-source", false).await;
    let calls = source.record_calls(|_| panic!("invalid source reached the VMM"));
    let checkpoints = fixture.runtime.checkpoints();
    let id = source.bx.id();
    let persist = |state: &BoxState| source.bx.runtime.box_manager.save_box(id, state).unwrap();

    for status in [
        BoxStatus::Paused,
        BoxStatus::Unknown,
        BoxStatus::Stopped,
        BoxStatus::Configured,
    ] {
        let mut invalid = source.state.clone();
        invalid.set_status(status);
        persist(&invalid);
        assert!(matches!(
            checkpoints.capture_live(id.as_str()).await,
            Err(BoxliteError::InvalidState(_))
        ));
        if status == BoxStatus::Unknown {
            assert!(matches!(
                source.bx.ensure_booted().await,
                Err(BoxliteError::InvalidState(_))
            ));
        }
        // Restore the cached run before the next case so each rejection tests
        // its own precondition.
        *source.bx.state.write() = source.state.clone();
    }
    let mut invalid = source.state.clone();
    invalid.set_pid(None);
    persist(&invalid);
    // An initialized handle considers a missing DB PID a different run.
    assert!(checkpoints.capture_live(id.as_str()).await.is_err());
    *source.bx.state.write() = source.state.clone();

    let mut invalid = source.state.clone();
    invalid.started_at = source
        .state
        .started_at
        .map(|time| time + chrono::Duration::seconds(1));
    persist(&invalid);
    assert!(matches!(
        checkpoints.capture_live(id.as_str()).await,
        Err(BoxliteError::Stopped(_))
    ));
    persist(&source.state);

    let mut invalid = source.state.clone();
    invalid.set_pid(Some(source.record.pid + 1));
    persist(&invalid);
    assert!(matches!(
        checkpoints.capture_live(id.as_str()).await,
        Err(BoxliteError::Stopped(_))
    ));
    persist(&source.state);

    let pid_path = source.bx.layout.pid_file_path();
    write_shim(
        &pid_path,
        PidRecord {
            start_time: source.record.start_time.map(|time| time + 1),
            ..source.record
        },
    );
    assert!(matches!(
        checkpoints.capture_live(id.as_str()).await,
        Err(BoxliteError::InvalidState(_))
    ));
    write_shim(&pid_path, source.record);

    fs::write(source.marker(), b"unresolved").unwrap();
    let error = checkpoints
        .capture_live("rejected-source")
        .await
        .unwrap_err();
    assert!(error.to_string().contains(".checkpoint_pending"), "{error}");
    assert_eq!(fs::read(source.marker()).unwrap(), b"unresolved");
    fs::remove_file(source.marker()).unwrap();

    source.bx.shutdown_token.cancel();
    assert!(matches!(
        checkpoints.capture_live(id.as_str()).await,
        Err(BoxliteError::Stopped(_))
    ));
    source.bx.runtime.box_manager.remove_box(id).unwrap();
    assert!(matches!(
        checkpoints.capture_live(id.as_str()).await,
        Err(BoxliteError::NotFound(_))
    ));
    assert!(matches!(
        checkpoints.capture_live("missing-source").await,
        Err(BoxliteError::NotFound(_))
    ));
    assert!(calls.lock().unwrap().is_empty());
    assert!(!source.checkpoint_root().exists());

    let cold = fixture.box_named("cold-source", false).await;
    let mut missing = cold.state.clone();
    missing.set_pid(None);
    cold.bx
        .runtime
        .box_manager
        .save_box(cold.bx.id(), &missing)
        .unwrap();
    assert!(matches!(
        checkpoints.capture_live("cold-source").await,
        Err(BoxliteError::InvalidState(_))
    ));
    assert!(!cold.bx.live.initialized());
}

#[tokio::test]
async fn live_checkpoint_rolls_back_freeze_and_export_failures() {
    for failed in [Phase::Freeze, Phase::Export] {
        let fixture = Fixture::new();
        let source = fixture.box_named("rollback-source", false).await;
        let calls = source.record_calls(move |phase| {
            if phase == failed {
                return Err(BoxliteError::Engine(format!("{phase:?} failed")));
            }
            Ok(())
        });

        let error = fixture
            .runtime
            .checkpoints()
            .capture_live("rollback-source")
            .await
            .unwrap_err();
        assert!(matches!(error, BoxliteError::Engine(_)), "{error}");
        let expected = if failed == Phase::Freeze {
            vec![Phase::Freeze, Phase::Settle]
        } else {
            vec![Phase::Freeze, Phase::Export, Phase::Settle]
        };
        assert_eq!(phases(&calls), expected);
        assert!(!source.marker().exists());
        assert!(
            fs::read_dir(source.checkpoint_root())
                .unwrap()
                .next()
                .is_none()
        );
        source.assert_same_run();
    }
}

#[tokio::test]
async fn live_checkpoint_unsupported_freeze_rolls_back_without_settling() {
    let fixture = Fixture::new();
    let source = fixture.box_named("unsupported-freeze", false).await;
    let calls = source.record_calls(|phase| match phase {
        Phase::Freeze => Err(BoxliteError::Unsupported("test VMM cannot freeze".into())),
        _ => panic!("unsupported freeze reached {phase:?}"),
    });

    let result = fixture
        .runtime
        .checkpoints()
        .capture_live("unsupported-freeze")
        .await;
    assert!(matches!(result, Err(BoxliteError::Unsupported(_))));
    assert_eq!(phases(&calls), [Phase::Freeze]);
    assert!(!source.marker().exists());
    assert!(
        fs::read_dir(source.checkpoint_root())
            .unwrap()
            .next()
            .is_none()
    );
    source.assert_same_run();
}

#[tokio::test]
async fn live_checkpoint_revalidates_the_run_before_publishing() {
    for replaced_at in [Phase::Export, Phase::Settle] {
        let fixture = Fixture::new();
        let source = fixture.box_named("replaced-source", false).await;
        let pid_path = source.bx.layout.pid_file_path();
        let replacement = PidRecord {
            start_time: source.record.start_time.map(|time| time + 1),
            ..source.record
        };
        let calls = source.record_calls(move |phase| {
            if phase == replaced_at {
                write_shim(&pid_path, replacement);
            }
            Ok(())
        });
        let error = fixture
            .runtime
            .checkpoints()
            .capture_live("replaced-source")
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("Cannot verify checkpoint shim"),
            "{error}"
        );
        if replaced_at == Phase::Export {
            assert_eq!(phases(&calls), [Phase::Freeze, Phase::Export]);
            let marker = read_marker(&source.marker());
            let id = marker["operation_id"].as_str().unwrap();
            assert!(!source.checkpoint_root().join(id).exists());
        } else {
            assert_eq!(
                phases(&calls),
                [Phase::Freeze, Phase::Export, Phase::Settle]
            );
            assert!(!source.marker().exists());
            assert!(
                fs::read_dir(source.checkpoint_root())
                    .unwrap()
                    .next()
                    .is_none()
            );
        }
        assert!(is_process_alive(source.record.pid));
    }
}

#[tokio::test]
async fn live_checkpoint_settlement_failure_blocks_conflicting_operations() {
    let fixture = Fixture::new();
    let source = fixture.box_named("unsettled-source", false).await;
    let calls = source.record_calls(|phase| {
        if phase == Phase::Settle {
            return Err(BoxliteError::Engine("thaw unconfirmed".into()));
        }
        Ok(())
    });
    let checkpoints = fixture.runtime.checkpoints();

    let error = checkpoints
        .capture_live("unsettled-source")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("thaw unconfirmed"), "{error}");
    assert_eq!(
        phases(&calls),
        [Phase::Freeze, Phase::Export, Phase::Settle, Phase::Settle]
    );
    let marker = read_marker(&source.marker());
    let id = marker["operation_id"].as_str().unwrap();
    assert!(!source.checkpoint_root().join(id).exists());

    let snapshots = source.handle.snapshots();
    for error in [
        checkpoints
            .capture_live("unsettled-source")
            .await
            .unwrap_err(),
        source.handle.stop().await.unwrap_err(),
        snapshots
            .create(Default::default(), "checkpoint-conflict")
            .await
            .unwrap_err(),
        snapshots.restore("checkpoint-conflict").await.unwrap_err(),
        fixture
            .runtime
            .remove("unsettled-source", true)
            .await
            .unwrap_err(),
    ] {
        assert!(error.to_string().contains(".checkpoint_pending"), "{error}");
    }
    assert!(!source.bx.config.box_home.join(".snapshot_pending").exists());
    assert_eq!(read_marker(&source.marker()), marker);
    source.assert_same_run();
}

/// Paired notifications put the async test and blocking handler on opposite sides
/// of a VMM call. The timeout also releases the blocking worker on a test panic.
struct HandlerGate {
    entered: oneshot::Sender<()>,
    release: mpsc::Receiver<()>,
}

impl HandlerGate {
    fn new() -> (Self, oneshot::Receiver<()>, mpsc::Sender<()>) {
        let (entered, observed) = oneshot::channel();
        let (release, wait_for_release) = mpsc::channel();
        (
            Self {
                entered,
                release: wait_for_release,
            },
            observed,
            release,
        )
    }

    fn hold(self) {
        self.entered.send(()).unwrap();
        self.release.recv_timeout(DEADLINE).unwrap();
    }
}

#[tokio::test]
async fn live_checkpoint_holds_both_admissions_during_export_and_rollback() {
    let fixture = Fixture::new();
    let source = fixture.box_named("locked-source", false).await;
    let other = fixture.box_named("independent-source", false).await;
    let (export_gate, export_entered, release_export) = HandlerGate::new();
    let (settle_gate, settle_entered, release_settle) = HandlerGate::new();
    let mut export_gate = Some(export_gate);
    let mut settle_gate = Some(settle_gate);
    let calls = source.record_calls(move |phase| {
        if phase == Phase::Export
            && let Some(gate) = export_gate.take()
        {
            gate.hold();
            return Err(BoxliteError::Engine("export failed".into()));
        }
        if phase == Phase::Settle
            && let Some(gate) = settle_gate.take()
        {
            gate.hold();
        }
        Ok(())
    });
    other.record_calls(|_| Ok(()));

    let checkpoints = fixture.runtime.checkpoints();
    let first = checkpoints.clone();
    let first = tokio::spawn(async move { first.capture_live("locked-source").await });
    timeout(DEADLINE, export_entered).await.unwrap().unwrap();

    let snapshots = source.handle.snapshots();
    let mut capture = Box::pin(checkpoints.capture_live("locked-source"));
    let mut stop = Box::pin(source.handle.stop());
    let mut create = Box::pin(snapshots.create(Default::default(), "checkpoint-conflict"));
    let mut restore = Box::pin(snapshots.restore("checkpoint-conflict"));
    for entered in [None, Some(settle_entered)] {
        if let Some(entered) = entered {
            timeout(DEADLINE, entered).await.unwrap().unwrap();
        }
        assert!(futures::poll!(capture.as_mut()).is_pending());
        assert!(futures::poll!(stop.as_mut()).is_pending());
        assert!(futures::poll!(create.as_mut()).is_pending());
        assert!(futures::poll!(restore.as_mut()).is_pending());
        let error = fixture
            .runtime
            .remove("locked-source", true)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("operation in progress"),
            "{error}"
        );
        timeout(DEADLINE, checkpoints.capture_live("independent-source"))
            .await
            .unwrap()
            .unwrap();
        assert!(source.marker().exists());
        if phases(&calls).last() == Some(&Phase::Export) {
            release_export.send(()).unwrap();
        }
    }
    drop((stop, create, restore));
    release_settle.send(()).unwrap();
    assert!(matches!(
        timeout(DEADLINE, first).await.unwrap().unwrap(),
        Err(BoxliteError::Engine(_))
    ));
    let output = timeout(DEADLINE, capture).await.unwrap().unwrap();
    assert_eq!(fs::read(output.join("capture")).unwrap(), b"VM checkpoint");
    assert_eq!(
        phases(&calls),
        [
            Phase::Freeze,
            Phase::Export,
            Phase::Settle,
            Phase::Freeze,
            Phase::Export,
            Phase::Settle
        ],
    );
    assert!(!source.marker().exists());
    source.assert_same_run();
}

#[tokio::test]
async fn live_checkpoint_dropped_caller_does_not_release_locks_or_commit() {
    let fixture = Fixture::new();
    let source = fixture.box_named("cancelled-source", false).await;
    let (export_gate, export_entered, release_export) = HandlerGate::new();
    let (settle_gate, settle_entered, release_settle) = HandlerGate::new();
    let mut export_gate = Some(export_gate);
    let mut settle_gate = Some(settle_gate);
    let calls = source.record_calls(move |phase| {
        match phase {
            Phase::Freeze => {}
            Phase::Export => export_gate.take().unwrap().hold(),
            Phase::Settle => settle_gate.take().unwrap().hold(),
        }
        Ok(())
    });
    let checkpoints = fixture.runtime.checkpoints();
    let caller = tokio::spawn(async move { checkpoints.capture_live("cancelled-source").await });
    timeout(DEADLINE, export_entered).await.unwrap().unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    release_export.send(()).unwrap();
    timeout(DEADLINE, settle_entered).await.unwrap().unwrap();
    assert!(source.marker().exists());
    let mut admitted = Box::pin(
        source
            .bx
            .with_disk_admission(source.bx.with_operation(async { Ok(()) })),
    );
    assert!(futures::poll!(admitted.as_mut()).is_pending());
    release_settle.send(()).unwrap();
    timeout(DEADLINE, admitted).await.unwrap().unwrap();

    assert_eq!(
        phases(&calls),
        [Phase::Freeze, Phase::Export, Phase::Settle]
    );
    assert!(
        fs::read_dir(source.checkpoint_root())
            .unwrap()
            .next()
            .is_none()
    );
    assert!(!source.marker().exists());
    source.assert_same_run();
}

fn write_pending(source: &Source) -> (String, PathBuf, PathBuf, PathBuf) {
    let id = uuid::Uuid::new_v4().to_string();
    let marker = source.marker();
    let root = source.checkpoint_root();
    let staging = staging_path(&root, &id);
    let finalized = root.join(&id);
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("capture"), b"simulated artifact").unwrap();
    let mut contents = marker_contents(source.bx.id().as_str(), &id, source.record);
    contents["boot_id"] = RECOVERY_BOOT_ID.into();
    fs::write(&marker, contents.to_string()).unwrap();
    (id, marker, staging, finalized)
}

#[tokio::test]
async fn live_checkpoint_restart_settles_verified_run_and_preserves_renamed_capture() {
    for finalized in [false, true] {
        let fixture = Fixture::new();
        let source = fixture.box_named("verified-source", false).await;
        let (operation, marker, staging, final_dir) = write_pending(&source);
        if finalized {
            fs::rename(&staging, &final_dir).unwrap();
        }
        let id = source.bx.id().clone();
        let Source {
            handle,
            bx,
            child: _child,
            state,
            record,
        } = source;
        drop((handle, bx));
        let Fixture { home, runtime } = fixture;
        drop(runtime);

        let mut settled = 0;
        let recovered = RuntimeImpl::initialize_recovering(
            runtime_options(home.path()),
            ExperimentalFeatures::default(),
            |runtime| {
                runtime.recover_boxes_with_checkpoint_settle(
                    Some(RECOVERY_BOOT_ID),
                    |box_id, pid_file, identity, request| {
                        assert_eq!(box_id, &id);
                        assert_eq!(PidFileReader::at(pid_file).read().unwrap(), record);
                        assert_eq!(identity, record);
                        assert!(matches!(request.action, CheckpointAction::Settle));
                        assert_eq!(request.operation_id, operation);
                        assert!(marker.exists());
                        if finalized {
                            assert_eq!(
                                fs::read(final_dir.join("capture")).unwrap(),
                                b"simulated artifact"
                            );
                        }
                        settled += 1;
                        Ok(())
                    },
                )
            },
        )
        .unwrap();
        assert_eq!(settled, 1);
        assert!(!marker.exists());
        assert!(!staging.exists());
        assert_eq!(final_dir.exists(), finalized);

        recovered
            .recover_boxes_with_checkpoint_settle(Some(RECOVERY_BOOT_ID), |_, _, _, _| {
                panic!("completed checkpoint was settled again")
            })
            .unwrap();
        let current = recovered.box_manager.update_box(&id).unwrap();
        assert_eq!(
            (current.status, current.pid, current.started_at),
            (BoxStatus::Running, state.pid, state.started_at)
        );
        assert_eq!(final_dir.exists(), finalized);
    }
}

#[tokio::test]
async fn live_checkpoint_restart_discards_dead_shim_staging_and_keeps_final_output() {
    let fixture = Fixture::new();
    let mut source = fixture.box_named("dead-source", false).await;
    let (_, marker, staging, final_dir) = write_pending(&source);
    fs::create_dir(&final_dir).unwrap();
    fs::write(final_dir.join("capture"), b"final capture").unwrap();
    let id = source.bx.id().clone();
    source.child.0.kill().unwrap();
    source.child.0.wait().unwrap();
    drop(source);
    let Fixture { home, runtime } = fixture;
    drop(runtime);

    let recovered = RuntimeImpl::initialize_recovering(
        runtime_options(home.path()),
        ExperimentalFeatures::default(),
        |runtime| {
            runtime.recover_boxes_with_checkpoint_settle(Some(RECOVERY_BOOT_ID), |_, _, _, _| {
                panic!("recovery sent Settle to a dead shim")
            })
        },
    )
    .unwrap();
    assert!(!marker.exists());
    assert!(!staging.exists());
    assert_eq!(
        fs::read(final_dir.join("capture")).unwrap(),
        b"final capture"
    );
    let state = recovered.box_manager.update_box(&id).unwrap();
    assert_eq!((state.status, state.pid), (BoxStatus::Stopped, None));
}

#[tokio::test]
async fn live_checkpoint_restart_ignores_shim_identity_from_another_boot() {
    let fixture = Fixture::new();
    let source = fixture.box_named("previous-boot", false).await;
    let (_, marker, staging, _) = write_pending(&source);
    let mut contents = read_marker(&marker);
    contents["boot_id"] = "previous-boot".into();
    fs::write(&marker, contents.to_string()).unwrap();
    let id = source.bx.id().clone();
    let pid_file = source.bx.layout.pid_file_path();
    let pid = source.record.pid;
    let _child = source.child;
    drop((source.handle, source.bx));
    let Fixture { home, runtime } = fixture;
    drop(runtime);

    let recovered = RuntimeImpl::initialize_recovering(
        runtime_options(home.path()),
        ExperimentalFeatures::default(),
        |runtime| {
            runtime.recover_boxes_with_checkpoint_settle(Some("current-boot"), |_, _, _, _| {
                panic!("recovery sent Settle to a shim identity from a previous boot")
            })
        },
    )
    .unwrap();

    assert!(!marker.exists());
    assert!(!staging.exists());
    assert!(!pid_file.exists());
    assert!(is_process_alive(pid));
    let state = recovered.box_manager.update_box(&id).unwrap();
    assert_eq!((state.status, state.pid), (BoxStatus::Stopped, None));
}

#[tokio::test]
async fn live_checkpoint_restart_preserves_marker_when_either_boot_id_is_missing() {
    for (recorded_boot_id, current_boot_id) in [
        (None, Some(RECOVERY_BOOT_ID)),
        (Some(RECOVERY_BOOT_ID), None),
    ] {
        let fixture = Fixture::new();
        let source = fixture.box_named("unknown-boot", true).await;
        let (_, marker, staging, _) = write_pending(&source);
        let mut contents = read_marker(&marker);
        contents["boot_id"] = serde_json::json!(recorded_boot_id);
        let contents = contents.to_string();
        fs::write(&marker, &contents).unwrap();
        let id = source.bx.id().clone();
        let pid_path = source.bx.layout.pid_file_path();
        let _child = source.child;
        drop((source.handle, source.bx));
        let Fixture { home, runtime } = fixture;
        drop(runtime);

        let recovered = RuntimeImpl::initialize_recovering(
            runtime_options(home.path()),
            ExperimentalFeatures::default(),
            |runtime| {
                let mut settled = 0;
                runtime.recover_boxes_with_checkpoint_settle(current_boot_id, |_, _, _, _| {
                    settled += 1;
                    Err(BoxliteError::Unsupported("test VMM cannot settle".into()))
                })?;
                assert_eq!(settled, 0, "missing boot ID must block settlement");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(fs::read_to_string(marker).unwrap(), contents);
        assert!(staging.exists());
        assert_eq!(PidFileReader::at(pid_path).read().unwrap(), source.record);
        let state = recovered.box_manager.update_box(&id).unwrap();
        assert_eq!(
            (state.status, state.pid),
            (BoxStatus::Running, source.state.pid)
        );
    }
}

#[tokio::test]
async fn live_checkpoint_restart_stops_settled_ephemeral_shim_before_cleanup() {
    let fixture = Fixture::new();
    let source = fixture.box_named("settled-ephemeral", true).await;
    let (_, marker, staging, _) = write_pending(&source);
    let id = source.bx.id().clone();
    let box_home = source.bx.config.box_home.clone();
    let pid = source.record.pid;
    let _child = source.child;
    drop((source.handle, source.bx));
    let Fixture { home, runtime } = fixture;
    drop(runtime);

    let mut settled = false;
    let recovered = RuntimeImpl::initialize_recovering(
        runtime_options(home.path()),
        ExperimentalFeatures::default(),
        |runtime| {
            runtime.recover_boxes_with_checkpoint_settle(
                Some(RECOVERY_BOOT_ID),
                |_, _, _, request| {
                    assert!(matches!(request.action, CheckpointAction::Settle));
                    assert!(is_process_alive(pid));
                    assert!(marker.exists());
                    settled = true;
                    Ok(())
                },
            )
        },
    )
    .unwrap();

    assert!(settled);
    assert!(
        !is_process_alive(pid),
        "ephemeral shim survived startup cleanup"
    );
    assert!(!box_home.exists());
    assert!(!staging.exists());
    assert!(recovered.box_manager.box_by_id(&id).unwrap().is_none());
}

#[tokio::test]
async fn live_checkpoint_restart_preserves_ephemeral_boxes_when_shim_exit_is_unconfirmed() {
    assert_ephemeral_box_survives_recovery(false, false).await;
}

#[tokio::test]
async fn live_checkpoint_normal_drop_preserves_unverified_ephemeral_box_on_reopen() {
    assert_ephemeral_box_survives_recovery(false, true).await;
}

#[tokio::test]
async fn live_checkpoint_restart_preserves_ephemeral_boxes_with_invalid_pid_files() {
    assert_ephemeral_box_survives_recovery(true, false).await;
}

async fn assert_ephemeral_box_survives_recovery(missing_pid: bool, normal_drop: bool) {
    let fixture = Fixture::new();
    let source = fixture.box_named("unconfirmed-shim", true).await;
    let mut state = source.state.clone();
    let id = source.bx.id().clone();
    let box_home = source.bx.config.box_home.clone();
    let pid_path = source.bx.layout.pid_file_path();
    if missing_pid {
        state.set_pid(None);
        source.bx.runtime.box_manager.save_box(&id, &state).unwrap();
        fs::write(&pid_path, b"invalid PID").unwrap();
    } else {
        write_shim(
            &pid_path,
            PidRecord {
                start_time: source.record.start_time.map(|time| time + 1),
                ..source.record
            },
        );
    }
    let contents = fs::read(&pid_path).unwrap();
    let _child = source.child;
    let locker = source.bx.runtime.box_locker(&id).unwrap().unwrap();
    drop((source.handle, source.bx));
    let Fixture { home, runtime } = fixture;
    if normal_drop {
        drop(runtime);
    } else {
        drop_without_stopping_ephemeral(runtime, &*locker);
    }

    for _ in 0..2 {
        assert!(is_process_alive(source.record.pid));
        let recovered = RuntimeImpl::new_for_test(runtime_options(home.path())).unwrap();
        assert!(is_process_alive(source.record.pid));
        assert!(box_home.is_dir());
        assert!(pid_path.is_file(), "recovery removed shim.pid");
        assert_eq!(fs::read(&pid_path).unwrap(), contents);
        let current = recovered.box_manager.update_box(&id).unwrap();
        assert_eq!(
            (current.status, current.pid),
            (BoxStatus::Running, state.pid)
        );
        let locker = recovered.box_locker(&id).unwrap().unwrap();
        drop_without_stopping_ephemeral(recovered, &*locker);
    }
}

fn drop_without_stopping_ephemeral<T>(runtime: T, locker: &dyn crate::lock::Locker) {
    // Startup recovery must see the artifacts of an interrupted runtime.
    let _guard = LockGuard::try_new(locker).unwrap();
    drop(runtime);
}

#[tokio::test]
async fn live_checkpoint_restart_does_not_signal_a_matching_pid_file_after_reboot() {
    assert_ephemeral_box_resets_on_reboot(BoxStatus::Running).await;
}

#[tokio::test]
async fn live_checkpoint_restart_resets_ephemeral_paused_box_after_reboot() {
    assert_ephemeral_box_resets_on_reboot(BoxStatus::Paused).await;
}

async fn assert_ephemeral_box_resets_on_reboot(status: BoxStatus) {
    let fixture = Fixture::new();
    let source = fixture.box_named("rebooted-ephemeral", true).await;
    let id = source.bx.id().clone();
    let mut state = source.state.clone();
    state.set_status(status);
    source.bx.runtime.box_manager.save_box(&id, &state).unwrap();
    let db = source.bx.runtime.layout.db_dir().join("boxlite.db");
    BoxStore::new(crate::db::Database::open(&db).unwrap())
        .check_and_update_boot_with(Some("previous-boot"))
        .unwrap();
    let pid = source.record.pid;
    let _child = source.child;
    let locker = source
        .bx
        .runtime
        .box_locker(source.bx.id())
        .unwrap()
        .unwrap();
    drop((source.handle, source.bx));
    let Fixture { home, runtime } = fixture;
    drop_without_stopping_ephemeral(runtime, &*locker);
    assert!(is_process_alive(pid));

    let recovered = RuntimeImpl::initialize_recovering(
        runtime_options(home.path()),
        ExperimentalFeatures::default(),
        |runtime| {
            runtime.recover_boxes_with_checkpoint_settle(Some(RECOVERY_BOOT_ID), |_, _, _, _| {
                panic!("ephemeral box has no checkpoint marker")
            })
        },
    )
    .unwrap();
    assert!(
        is_process_alive(pid),
        "recovery stopped a process from another boot"
    );
    let state = recovered.box_manager.update_box(&id).unwrap();
    assert_eq!((state.status, state.pid), (BoxStatus::Stopped, None));
}

#[tokio::test]
async fn live_checkpoint_restart_retains_unsettled_markers_before_ephemeral_cleanup() {
    let fixture = Fixture::new();
    let mut retained = Vec::new();
    let mut children = Vec::new();
    for kind in [
        "unavailable",
        "corrupt",
        "legacy",
        "reused",
        "orphan",
        "unsafe-id",
        "eperm",
    ] {
        let source = fixture.box_named(kind, true).await;
        let (_, marker, staging, _) = write_pending(&source);
        let pid_path = source.bx.layout.pid_file_path();
        let mut pid = source.record.pid;
        match kind {
            "corrupt" => fs::write(&marker, b"corrupt").unwrap(),
            "legacy" => fs::write(&pid_path, pid.to_string()).unwrap(),
            "reused" => {
                // The marker and PID file agree with each other. Only the live OS
                // fingerprint can show that this PID belongs to a different run.
                let expected = PidRecord {
                    start_time: source.record.start_time.map(|time| time + 1),
                    ..source.record
                };
                write_shim(&pid_path, expected);
                let mut contents = read_marker(&marker);
                contents["shim"] = serde_json::to_value(expected).unwrap();
                fs::write(&marker, contents.to_string()).unwrap();
            }
            "orphan" => source
                .bx
                .runtime
                .box_manager
                .remove_box(source.bx.id())
                .unwrap(),
            "unsafe-id" => {
                let mut contents = read_marker(&marker);
                contents["operation_id"] = "../unexpected".into();
                fs::write(&marker, contents.to_string()).unwrap();
            }
            "eperm" => {
                // PID 1 belongs to a different user on unprivileged runners.
                // The other cases still run on privileged hosts.
                if unsafe { libc::kill(1, 0) } == 0
                    || std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM)
                {
                    fs::remove_file(marker).unwrap();
                    continue;
                }
                pid = 1;
                let mut state = source.state.clone();
                state.set_pid(Some(pid));
                source
                    .bx
                    .runtime
                    .box_manager
                    .save_box(source.bx.id(), &state)
                    .unwrap();
                let inaccessible = PidRecord {
                    pid,
                    start_time: Some(1),
                };
                write_shim(&pid_path, inaccessible);
                let mut contents = read_marker(&marker);
                contents["shim"] = serde_json::to_value(inaccessible).unwrap();
                fs::write(&marker, contents.to_string()).unwrap();
            }
            _ => {}
        }
        retained.push((
            kind,
            source.bx.id().clone(),
            fs::read(&marker).unwrap(),
            marker,
            staging,
            pid,
        ));
        children.push(source.child);
    }
    let Fixture { home, runtime } = fixture;
    drop(runtime);

    let recovered = RuntimeImpl::initialize_recovering(
        runtime_options(home.path()),
        ExperimentalFeatures::default(),
        |runtime| {
            runtime.recover_boxes_with_checkpoint_settle(Some(RECOVERY_BOOT_ID), |_, _, _, _| {
                Err(BoxliteError::Unsupported("test VMM cannot settle".into()))
            })
        },
    )
    .unwrap();
    let mut attempted = Vec::new();
    recovered
        .recover_boxes_with_checkpoint_settle(Some(RECOVERY_BOOT_ID), |id, _, _, request| {
            assert!(matches!(request.action, CheckpointAction::Settle));
            attempted.push(id.clone());
            Err(BoxliteError::Unsupported("test VMM cannot settle".into()))
        })
        .unwrap();
    assert_eq!(attempted, [retained[0].1.clone()]);

    let facade = BoxliteRuntime::from_local(LocalRuntime(Arc::clone(&recovered)));
    for (kind, id, contents, marker, staging, pid) in retained {
        assert_eq!(fs::read(marker).unwrap(), contents, "{kind}");
        assert!(staging.exists(), "{kind}");
        if kind == "orphan" {
            assert!(recovered.box_manager.box_by_id(&id).unwrap().is_none());
            continue;
        }
        if kind != "eperm" {
            assert!(is_process_alive(pid), "{kind}");
        }
        let state = recovered.box_manager.update_box(&id).unwrap();
        assert_eq!(
            (state.status, state.pid),
            (BoxStatus::Running, Some(pid)),
            "{kind}"
        );
        let error = facade
            .checkpoints()
            .capture_live(id.as_str())
            .await
            .unwrap_err();
        assert!(error.to_string().contains(".checkpoint_pending"), "{error}");
    }
    drop(children);
}

#[tokio::test]
async fn live_checkpoint_shim_handler_is_unsupported_without_effects() {
    let fixture = Fixture::new();
    let source = fixture.box_named("shim-source", false).await;
    let root = source.checkpoint_root();
    let shim = ShimHandler::from_pid(source.record.pid, source.bx.id().clone());
    source.attach(shim, None);
    let checkpoints = fixture.runtime.checkpoints();
    let pid_file = source.bx.layout.pid_file_path();
    for legacy in [false, true] {
        if legacy {
            fs::write(&pid_file, source.record.pid.to_string()).unwrap();
        }
        let result = checkpoints.capture_live("shim-source").await;
        assert!(
            matches!(result, Err(BoxliteError::Unsupported(_))),
            "{result:?}"
        );
        assert!(!source.marker().exists());
        assert!(!root.exists());
        if !legacy {
            source.assert_same_run();
        }
    }
    assert!(!shim_is_stopped(source.record.pid));
}

#[cfg(target_os = "macos")]
fn shim_is_stopped(pid: u32) -> bool {
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    let bytes = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    assert_eq!(bytes, size);
    unsafe { info.assume_init() }.pbi_status == libc::SSTOP
}

#[cfg(target_os = "linux")]
fn shim_is_stopped(pid: u32) -> bool {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    stat.rsplit_once(')')
        .unwrap()
        .1
        .trim_start()
        .starts_with('T')
}

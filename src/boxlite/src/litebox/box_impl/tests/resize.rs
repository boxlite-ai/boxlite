use super::*;
use crate::disk::constants::filenames::CONTAINER_DISK;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::litebox::archive::{ArchiveManifest, MANIFEST_FILENAME, extract_archive};
use crate::litebox::config::ContainerRuntimeConfig;
use crate::runtime::id::BoxIDMint;
use crate::runtime::options::{BoxOptions, BoxliteOptions, NetworkMode, OutboundNetworkConfig};
use crate::runtime::rt_impl::RuntimeImpl;
use crate::runtime::types::ContainerID;
use crate::vmm::VmmKind;
use crate::vmm::vmm_socket::{self, ControlError, ControlOp, ControlReply};
use boxlite_shared::*;
use chrono::Utc;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{OnceLock, Weak};
use tokio::sync::Semaphore;
use tonic::{Request, Response, Status};

struct GuestGate {
    fail: AtomicBool,
    control_refuses: AtomicBool,
    control_reports_wrong_size: AtomicBool,
    control_calls: AtomicUsize,
    calls: AtomicUsize,
    entered: Semaphore,
    release: Semaphore,
    completed: Semaphore,
    disk_replacement_on_thaw: OnceLock<(PathBuf, Weak<BoxImpl>)>,
}

impl GuestGate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            fail: AtomicBool::new(true),
            control_refuses: AtomicBool::new(false),
            control_reports_wrong_size: AtomicBool::new(false),
            control_calls: AtomicUsize::new(0),
            calls: AtomicUsize::new(0),
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            completed: Semaphore::new(0),
            disk_replacement_on_thaw: OnceLock::new(),
        })
    }

    async fn entered(&self) {
        tokio::time::timeout(Duration::from_secs(5), self.entered.acquire())
            .await
            .expect("filesystem request reached the guest")
            .unwrap()
            .forget();
    }
}

struct ResizeGuest(Arc<GuestGate>);

#[tonic::async_trait]
impl Guest for ResizeGuest {
    async fn bootstrap(
        &self,
        _: Request<GuestBootstrapRequest>,
    ) -> Result<Response<GuestBootstrapResponse>, Status> {
        Err(Status::unimplemented("fixture is already initialized"))
    }

    async fn init(
        &self,
        _: Request<GuestInitRequest>,
    ) -> Result<Response<GuestInitResponse>, Status> {
        Err(Status::unimplemented("fixture is already initialized"))
    }
    async fn ping(&self, _: Request<PingRequest>) -> Result<Response<PingResponse>, Status> {
        Ok(Response::new(PingResponse {
            version: "0.13.1".into(),
            ..Default::default()
        }))
    }
    async fn shutdown(
        &self,
        _: Request<ShutdownRequest>,
    ) -> Result<Response<ShutdownResponse>, Status> {
        Ok(Response::new(ShutdownResponse {}))
    }
    async fn quiesce(
        &self,
        _: Request<QuiesceRequest>,
    ) -> Result<Response<QuiesceResponse>, Status> {
        Ok(Response::new(QuiesceResponse { frozen_count: 0 }))
    }
    async fn thaw(&self, _: Request<ThawRequest>) -> Result<Response<ThawResponse>, Status> {
        if let Some((replacement, source)) = self.0.disk_replacement_on_thaw.get() {
            let source = source
                .upgrade()
                .ok_or_else(|| Status::internal("copy source fixture was dropped"))?;
            tokio::fs::rename(replacement, source.layout.disk_path())
                .await
                .map_err(|error| Status::internal(error.to_string()))?;
            let policy = OutboundNetworkConfig {
                mode: NetworkMode::Disabled,
                ..Default::default()
            };
            source
                .runtime
                .box_manager
                .save_outbound(source.id(), &policy)
                .map_err(|error| Status::internal(error.to_string()))?;
        }
        Ok(Response::new(ThawResponse { thawed_count: 0 }))
    }
    async fn sync_clock(
        &self,
        _: Request<SyncClockRequest>,
    ) -> Result<Response<SyncClockResponse>, Status> {
        Err(Status::unimplemented("unused"))
    }
    async fn resize_filesystem(
        &self,
        request: Request<ResizeFilesystemRequest>,
    ) -> Result<Response<ResizeFilesystemResponse>, Status> {
        let request = request.into_inner();
        assert_eq!(request.device, "/dev/vda");
        assert_eq!(request.minimum_bytes, 20_u64 << 30);
        let gate = Arc::clone(&self.0);
        // The guest keeps resizing after the RPC caller stops waiting.
        tokio::spawn(async move {
            gate.calls.fetch_add(1, Ordering::SeqCst);
            gate.entered.add_permits(1);
            gate.release.acquire().await.unwrap().forget();
            if gate.fail.load(Ordering::SeqCst) {
                return Err(Status::unimplemented("injected old guest"));
            }
            gate.completed.add_permits(1);
            Ok(Response::new(ResizeFilesystemResponse {}))
        })
        .await
        .unwrap()
    }
}

struct Handler;
impl VmmHandler for Handler {
    fn stop(&mut self) -> BoxliteResult<()> {
        Ok(())
    }
    fn metrics(&self) -> BoxliteResult<crate::vmm::controller::VmmMetrics> {
        Ok(Default::default())
    }
    fn is_running(&self) -> bool {
        true
    }
    fn pid(&self) -> u32 {
        0
    }
}

struct Fixture {
    bx: Arc<crate::LiteBox>,
    inner: Arc<BoxImpl>,
    home: tempfile::TempDir,
    server: JoinHandle<()>,
}

impl Fixture {
    fn completed_disk_size_gb(&self) -> Option<i64> {
        self.inner
            .runtime
            .box_manager
            .db()
            .conn()
            .query_row(
                "SELECT json_extract(json, '$.disk_size_gb') FROM box_state WHERE id = ?1",
                [self.inner.id().as_str()],
                |row| row.get(0),
            )
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn fixture(gate: Arc<GuestGate>, kind: VmmKind) -> Fixture {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    })
    .unwrap();
    let id = BoxIDMint::mint();
    let config = BoxConfig {
        id: id.clone(),
        name: None,
        created_at: Utc::now(),
        container: ContainerRuntimeConfig {
            id: ContainerID::new(),
        },
        options: BoxOptions {
            disk_size_gb: Some(10),
            auto_delete: Some(0),
            detach: true,
            ..Default::default()
        },
        engine_kind: kind,
        box_home: runtime.layout.boxes_dir().join(id.as_str()),
    };
    let mut state = BoxState::new();
    state.status = BoxStatus::Running;
    let lock_id = runtime.lock_manager.allocate().unwrap();
    runtime
        .disk_lock_manager
        .allocate_and_retrieve(lock_id)
        .unwrap();
    state.set_lock_id(lock_id);
    runtime.box_manager.add_box(&config, &state).unwrap();
    let inner = BoxImpl::new(
        config,
        state,
        runtime.clone(),
        runtime.shutdown_token.child_token(),
    );
    let disk = Qcow2Helper::create_disk(&inner.layout.disk_path(), true).unwrap();
    let base = Qcow2Helper::create_disk(&home.path().join("base.qcow2"), true).unwrap();
    std::fs::create_dir_all(inner.layout.sockets_dir()).unwrap();
    inner.layout.sockets().ensure().unwrap();
    let path = inner.layout.disk_path();
    let control_gate = gate.clone();
    vmm_socket::serve(&inner.layout.sockets().vmm_sock(), move |op, directory| {
        assert!(directory.is_none());
        let (block_id, bytes) = match op {
            ControlOp::ResizeDisk { block_id, bytes } => (block_id, bytes),
            #[cfg(feature = "native")]
            _ => panic!("expected a disk resize request"),
        };
        assert_eq!(block_id, "vda");
        control_gate.control_calls.fetch_add(1, Ordering::SeqCst);
        if control_gate.control_refuses.load(Ordering::SeqCst) {
            return Err(ControlError::InvalidInput("injected resize refusal".into()));
        }
        if Qcow2Helper::qcow2_virtual_size(&path).unwrap() < bytes {
            // Fake the device boundary with a real image made by production code.
            // The native acceptance test covers imago's in-place grow separately.
            let replacement = path.with_extension("replacement");
            let image = Qcow2Helper::create_cow_child_disk(
                base.path(),
                BackingFormat::Qcow2,
                &replacement,
                bytes,
            )
            .unwrap();
            std::fs::rename(image.path(), &path).unwrap();
        }
        let actual = Qcow2Helper::qcow2_virtual_size(&path).unwrap();
        if control_gate
            .control_reports_wrong_size
            .load(Ordering::SeqCst)
        {
            return Ok(ControlReply::DiskSize(actual - 512));
        }
        Ok(ControlReply::DiskSize(actual))
    })
    .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let incoming =
        tonic::transport::server::TcpIncoming::from_listener(listener, true, None).unwrap();
    let server = tokio::spawn(async move {
        tonic::transport::Server::builder()
            .add_service(GuestServer::new(ResizeGuest(gate)))
            .serve_with_incoming(incoming)
            .await
            .unwrap();
    });
    let live = LiveState::new(
        Box::new(Handler),
        GuestSession::new(BoxTransport::tcp(address.port())),
        None,
        None,
        BoxMetricsStorage::new(),
        disk,
        None,
        None,
    );
    assert!(inner.live.set(live).is_ok());
    let inner = Arc::new(inner);
    let bx = Arc::new(crate::LiteBox::new(
        inner.clone(),
        inner.clone(),
        Arc::new(crate::litebox::LocalSnapshotBackend::new(inner.clone())),
    ));
    Fixture {
        bx,
        inner,
        home,
        server,
    }
}

const SAVED_DISK_GIB: u64 = 20;
const COPIED_DISK_BYTES: u64 = 22 << 30;
const GROWN_DISK_BYTES: u64 = 24 << 30;

async fn copy_fixture() -> (Fixture, tokio::process::Child) {
    let gate = GuestGate::new();
    gate.fail.store(false, Ordering::SeqCst);
    gate.release.add_permits(1);
    let fixture = fixture(Arc::clone(&gate), VmmKind::Native).await;
    fixture
        .bx
        .resize(crate::ResizeOptions {
            disk_size_gb: Some(SAVED_DISK_GIB),
        })
        .await
        .unwrap();
    assert_eq!(
        OutboundNetworkConfig::from(&fixture.inner.config.options.network).mode,
        NetworkMode::Enabled
    );

    vmm_socket::grow_disk(
        &fixture.inner.layout.sockets().vmm_sock(),
        "vda",
        COPIED_DISK_BYTES,
    )
    .await
    .unwrap();
    let replacement = Qcow2Helper::create_cow_child_disk(
        &fixture.home.path().join("base.qcow2"),
        BackingFormat::Qcow2,
        &fixture.home.path().join("grown.qcow2"),
        GROWN_DISK_BYTES,
    )
    .unwrap()
    .leak();
    // Thaw runs after the image capture and before recording the copy options.
    gate.disk_replacement_on_thaw
        .set((replacement, Arc::downgrade(&fixture.inner)))
        .unwrap();

    let shim = tokio::process::Command::new("sleep")
        .arg("300")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut state = fixture.inner.state.write();
    state.pid = Some(shim.id().unwrap());
    fixture
        .inner
        .runtime
        .box_manager
        .save_box(fixture.inner.id(), &state)
        .unwrap();
    drop(state);
    (fixture, shim)
}

fn restore_source_network(fixture: &Fixture) {
    fixture
        .inner
        .runtime
        .box_manager
        .save_outbound(fixture.inner.id(), &OutboundNetworkConfig::default())
        .unwrap();
}

fn assert_copied_disk_and_options(fixture: &Fixture, copied_disk: &Path, options: &BoxOptions) {
    assert_eq!(
        Qcow2Helper::qcow2_virtual_size(&fixture.inner.layout.disk_path()).unwrap(),
        GROWN_DISK_BYTES,
        "the source must grow when the guest thaws"
    );
    let copied_bytes = Qcow2Helper::qcow2_virtual_size(copied_disk).unwrap();
    assert_eq!(copied_bytes, COPIED_DISK_BYTES);
    assert_eq!(
        OutboundNetworkConfig::from(&options.network).mode,
        NetworkMode::Disabled,
        "the copy must carry the outbound policy committed during thaw"
    );
    assert_eq!(
        options.disk_size_gb,
        Some(SAVED_DISK_GIB),
        "the copy options must carry the last saved disk size"
    );
}

#[tokio::test]
async fn export_copy_uses_latest_saved_disk_size() {
    let (fixture, _shim) = copy_fixture().await;
    let archive = fixture
        .bx
        .export(
            Default::default(),
            &fixture.home.path().join("copy.boxlite"),
        )
        .await
        .unwrap();
    restore_source_network(&fixture);
    let extracted = tempfile::tempdir_in(fixture.home.path()).unwrap();
    extract_archive(archive.path(), extracted.path()).unwrap();
    let manifest: ArchiveManifest =
        serde_json::from_slice(&std::fs::read(extracted.path().join(MANIFEST_FILENAME)).unwrap())
            .unwrap();
    assert_copied_disk_and_options(
        &fixture,
        &extracted.path().join(CONTAINER_DISK),
        &manifest.box_options.unwrap(),
    );
}

#[tokio::test]
async fn clone_copy_uses_latest_saved_disk_size() {
    let (fixture, _shim) = copy_fixture().await;
    let clone = fixture
        .bx
        .clone_box(Default::default(), None)
        .await
        .unwrap();
    restore_source_network(&fixture);
    let (config, _) = fixture
        .inner
        .runtime
        .box_manager
        .box_by_id(clone.id())
        .unwrap()
        .unwrap();
    assert_copied_disk_and_options(
        &fixture,
        &config.box_home.join("disks").join(CONTAINER_DISK),
        &config.options,
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_persists_after_guest_success_when_caller_cancels() {
    let gate = GuestGate::new();
    let fixture = fixture(gate.clone(), VmmKind::Native).await;
    let target = crate::ResizeOptions {
        disk_size_gb: Some(20),
    };
    let bx = fixture.bx.clone();
    let first = tokio::spawn(async move { bx.resize(target).await });
    gate.entered().await;
    assert_eq!(fixture.completed_disk_size_gb(), None);
    gate.release.add_permits(1);
    let error = first.await.unwrap().unwrap_err();
    assert!(matches!(error, BoxliteError::Unsupported(_)));
    assert!(error.to_string().contains("partially completed"));
    assert_eq!(fixture.completed_disk_size_gb(), None);
    assert_eq!(
        fixture
            .bx
            .resize(Default::default())
            .await
            .unwrap()
            .disk_size_gb,
        20
    );
    assert_eq!(fixture.completed_disk_size_gb(), None);

    gate.fail.store(false, Ordering::SeqCst);
    let bx = fixture.bx.clone();
    let retry = tokio::spawn(async move { bx.resize(target).await });
    gate.entered().await;
    assert_eq!(fixture.completed_disk_size_gb(), None);
    retry.abort();
    assert!(retry.await.unwrap_err().is_cancelled());
    let locker = fixture
        .inner
        .runtime
        .lock_manager
        .retrieve(fixture.inner.state.read().lock_id.unwrap())
        .unwrap();
    assert!(
        LockGuard::try_new(locker.as_ref()).is_none(),
        "the detached resize still owns lifecycle admission"
    );
    let inner = fixture.inner.clone();
    let mut stop = tokio::spawn(async move { inner.stop().await });
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut stop)
            .await
            .is_err(),
        "stop waits for the admitted grow"
    );
    gate.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), stop)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let (config, state) = fixture
        .inner
        .runtime
        .box_manager
        .box_by_id(fixture.inner.id())
        .unwrap()
        .unwrap();
    assert_eq!(fixture.completed_disk_size_gb(), Some(20));
    assert_eq!(config.options.disk_size_gb, Some(10));
    assert_eq!(state.status, BoxStatus::Stopped);
    assert_eq!(gate.control_calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        gate.calls.load(Ordering::SeqCst),
        2,
        "equal target retries the filesystem step"
    );
}

#[tokio::test]
async fn resize_retries_after_guest_timeout_and_late_completion() {
    let gate = GuestGate::new();
    gate.fail.store(false, Ordering::SeqCst);
    let fixture = fixture(gate.clone(), VmmKind::Native).await;
    let target = crate::ResizeOptions {
        disk_size_gb: Some(20),
    };
    let bx = fixture.bx.clone();
    let first = tokio::spawn(async move { bx.resize(target).await });
    gate.entered().await;

    // Advance the host deadline once the device request has finished.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(61)).await;
    tokio::time::resume();
    let error = tokio::time::timeout(Duration::from_secs(5), first)
        .await
        .expect("the host filesystem deadline must bound the resize")
        .unwrap()
        .unwrap_err();
    let BoxliteError::Engine(message) = error else {
        panic!("expected a guest timeout error, got {error}");
    };
    assert!(
        message.contains("guest filesystem resize timed out"),
        "{message}"
    );
    assert!(message.contains("partially completed"), "{message}");
    assert!(message.contains("retry the target"), "{message}");
    assert_eq!(fixture.completed_disk_size_gb(), None);

    gate.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), gate.completed.acquire())
        .await
        .expect("the guest finishes even after the host times out")
        .unwrap()
        .forget();
    assert_eq!(fixture.completed_disk_size_gb(), None);

    let bx = fixture.bx.clone();
    let retry = tokio::spawn(async move { bx.resize(target).await });
    gate.entered().await;
    assert_eq!(fixture.completed_disk_size_gb(), None);
    gate.release.add_permits(1);
    let grown = retry.await.unwrap().unwrap();
    assert_eq!(grown.disk_size_gb, 20);
    assert_eq!(fixture.completed_disk_size_gb(), Some(20));
    assert_eq!(gate.control_calls.load(Ordering::SeqCst), 2);
    assert_eq!(gate.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn resize_rejects_other_engines_and_stopped_boxes() {
    let fixture = fixture(GuestGate::new(), VmmKind::Libkrun).await;
    assert!(matches!(
        fixture.bx.resize(Default::default()).await,
        Err(BoxliteError::Unsupported(_))
    ));
    let fixture = self::fixture(GuestGate::new(), VmmKind::Native).await;
    fixture.inner.stop().await.unwrap();
    assert!(matches!(
        fixture.bx.resize(Default::default()).await,
        Err(BoxliteError::InvalidState(_))
    ));
}

#[tokio::test]
async fn device_refusal_preserves_disk_capacity_and_saved_target() {
    let gate = GuestGate::new();
    gate.control_refuses.store(true, Ordering::SeqCst);
    let fixture = fixture(gate.clone(), VmmKind::Native).await;
    let error = fixture
        .bx
        .resize(crate::ResizeOptions {
            disk_size_gb: Some(20),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        BoxliteError::InvalidArgument(message) if message == "injected resize refusal"
    ));
    assert_eq!(fixture.completed_disk_size_gb(), None);
    assert_eq!(
        fixture
            .bx
            .resize(Default::default())
            .await
            .unwrap()
            .disk_size_gb,
        10
    );
    assert_eq!(fixture.completed_disk_size_gb(), None);
    assert_eq!(gate.control_calls.load(Ordering::SeqCst), 1);
    assert_eq!(gate.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn resize_retries_after_mismatched_device_reply() {
    let gate = GuestGate::new();
    gate.control_reports_wrong_size
        .store(true, Ordering::SeqCst);
    let fixture = fixture(gate.clone(), VmmKind::Native).await;
    let target = crate::ResizeOptions {
        disk_size_gb: Some(20),
    };
    let error = fixture.bx.resize(target).await.unwrap_err();
    let BoxliteError::Engine(message) = error else {
        panic!("expected a device reply error, got {error}");
    };
    assert!(message.contains("shim reported"), "{message}");
    assert!(!message.contains("partially completed"), "{message}");
    assert_eq!(gate.calls.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.completed_disk_size_gb(), None);
    assert!(message.contains("completion is unknown"), "{message}");
    assert!(message.contains("retry the target"), "{message}");
    assert_eq!(
        fixture
            .bx
            .resize(Default::default())
            .await
            .unwrap()
            .disk_size_gb,
        20
    );
    assert_eq!(fixture.completed_disk_size_gb(), None);
    assert_eq!(gate.control_calls.load(Ordering::SeqCst), 1);
    gate.control_reports_wrong_size
        .store(false, Ordering::SeqCst);
    gate.fail.store(false, Ordering::SeqCst);
    gate.release.add_permits(1);
    let grown = fixture.bx.resize(target).await.unwrap();
    assert_eq!(grown, crate::BoxResources { disk_size_gb: 20 });
    assert_eq!(fixture.completed_disk_size_gb(), Some(20));
    assert_eq!(gate.control_calls.load(Ordering::SeqCst), 2);
    assert_eq!(gate.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn resize_reports_partial_completion_after_database_failure_and_retries() {
    let gate = GuestGate::new();
    gate.fail.store(false, Ordering::SeqCst);
    gate.release.add_permits(1);
    let fixture = fixture(gate.clone(), VmmKind::Native).await;
    let db = fixture.inner.runtime.box_manager.db();
    db.conn()
        .execute_batch(
            "CREATE TRIGGER fail_disk_capacity_save BEFORE UPDATE ON box_state
         WHEN json_extract(NEW.json, '$.disk_size_gb') = 20
         BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END;",
        )
        .unwrap();
    let target = crate::ResizeOptions {
        disk_size_gb: Some(20),
    };
    let error = fixture.bx.resize(target).await.unwrap_err();
    let BoxliteError::Database(message) = error else {
        panic!("expected a database error, got {error}");
    };
    assert_eq!(gate.control_calls.load(Ordering::SeqCst), 1);
    assert_eq!(gate.calls.load(Ordering::SeqCst), 1);
    assert!(message.contains("partially completed"), "{message}");
    assert!(message.contains("20 GiB"), "{message}");
    assert!(
        message.contains("injected persistence failure"),
        "{message}"
    );
    assert!(message.contains("retry the target"), "{message}");
    assert_eq!(fixture.completed_disk_size_gb(), None);
    assert_eq!(
        fixture
            .bx
            .resize(Default::default())
            .await
            .unwrap()
            .disk_size_gb,
        20
    );
    assert_eq!(fixture.completed_disk_size_gb(), None);
    assert_eq!(gate.control_calls.load(Ordering::SeqCst), 1);

    db.conn()
        .execute_batch("DROP TRIGGER fail_disk_capacity_save;")
        .unwrap();
    gate.release.add_permits(1);
    let grown = fixture.bx.resize(target).await.unwrap();
    assert_eq!(grown, crate::BoxResources { disk_size_gb: 20 });
    assert_eq!(fixture.completed_disk_size_gb(), Some(20));
    assert_eq!(gate.control_calls.load(Ordering::SeqCst), 2);
    assert_eq!(gate.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn resize_rejects_a_handle_from_an_earlier_vm_run() {
    let gate = GuestGate::new();
    gate.fail.store(false, Ordering::SeqCst);
    gate.release.add_permits(1);
    let fixture = fixture(gate.clone(), VmmKind::Native).await;
    let mut replacement = fixture
        .inner
        .runtime
        .box_manager
        .update_box(fixture.inner.id())
        .unwrap();
    replacement.started_at = Some(Utc::now());
    fixture
        .inner
        .runtime
        .box_manager
        .save_box(fixture.inner.id(), &replacement)
        .unwrap();

    let result = fixture
        .bx
        .resize(crate::ResizeOptions {
            disk_size_gb: Some(20),
        })
        .await;
    assert!(
        matches!(result, Err(BoxliteError::Stopped(_))),
        "a cached guest connection must not resize a replacement VM: {result:?}"
    );
    assert_eq!(gate.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        Qcow2Helper::qcow2_virtual_size(&fixture.inner.layout.disk_path()).unwrap(),
        10_u64 << 30
    );
}

#[tokio::test]
async fn resize_serializes_with_disk_operations_and_stop_uses_the_lifecycle_lock() {
    let gate = GuestGate::new();
    gate.fail.store(false, Ordering::SeqCst);
    let fixture = fixture(gate.clone(), VmmKind::Native).await;
    let disk_locker = fixture.inner.disk_locker().unwrap();
    let disk_guard = LockGuard::new_async(disk_locker.as_ref()).await;
    let bx = fixture.bx.clone();
    let mut grow = tokio::spawn(async move {
        bx.resize(crate::ResizeOptions {
            disk_size_gb: Some(20),
        })
        .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut grow)
            .await
            .is_err()
    );
    assert_eq!(
        Qcow2Helper::qcow2_virtual_size(&fixture.inner.layout.disk_path()).unwrap(),
        10_u64 << 30
    );
    drop(disk_guard);
    gate.entered().await;
    let lock_id = fixture.inner.state.read().lock_id.unwrap();
    let independent = fixture
        .inner
        .runtime
        .lock_manager
        .retrieve(lock_id)
        .unwrap();
    assert!(
        LockGuard::try_new(&*independent).is_none(),
        "grow owns the lifecycle lock"
    );
    let mut stop = Box::pin(fixture.inner.stop());
    assert!(futures::poll!(&mut stop).is_pending());
    assert!(
        !fixture.inner.shutdown_token.is_cancelled(),
        "stop must wait until the admitted filesystem grow finishes"
    );
    gate.release.add_permits(1);
    grow.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), stop)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn resize_capacity_is_carried_into_clones_and_exported_options() {
    let gate = GuestGate::new();
    gate.fail.store(false, Ordering::SeqCst);
    gate.release.add_permits(1);
    let fixture = fixture(gate, VmmKind::Native).await;
    fixture
        .bx
        .resize(crate::ResizeOptions {
            disk_size_gb: Some(20),
        })
        .await
        .unwrap();
    fixture.bx.stop().await.unwrap();

    let cloned = fixture
        .bx
        .clone_box(Default::default(), None)
        .await
        .unwrap();
    let (config, _) = fixture
        .inner
        .runtime
        .box_manager
        .box_by_id(cloned.id())
        .unwrap()
        .unwrap();
    assert_eq!(config.options.disk_size_gb, Some(20));
    assert_eq!(
        config
            .options
            .advanced
            .security
            .resource_limits
            .max_file_size,
        None
    );

    let destination = tempfile::tempdir().unwrap();
    let exported = fixture
        .bx
        .export(Default::default(), destination.path())
        .await
        .unwrap();
    let file = std::fs::File::open(exported.path()).unwrap();
    let mut archive = ::tar::Archive::new(zstd::Decoder::new(file).unwrap());
    let mut found = false;
    for entry in archive.entries().unwrap() {
        let entry = entry.unwrap();
        if entry.path().unwrap() == std::path::Path::new(crate::litebox::archive::MANIFEST_FILENAME)
        {
            let manifest: crate::litebox::archive::ArchiveManifest =
                serde_json::from_reader(entry).unwrap();
            let options = manifest.box_options.unwrap();
            assert_eq!(options.disk_size_gb, Some(20));
            assert_eq!(
                options.advanced.security.resource_limits.max_file_size,
                None
            );
            found = true;
            break;
        }
    }
    assert!(found, "export contains the effective options");
}

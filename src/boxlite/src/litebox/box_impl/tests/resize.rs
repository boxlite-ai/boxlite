use super::*;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::litebox::config::ContainerRuntimeConfig;
use crate::runtime::id::BoxIDMint;
use crate::runtime::options::{BoxOptions, BoxliteOptions};
use crate::runtime::rt_impl::RuntimeImpl;
use crate::runtime::types::ContainerID;
use crate::vmm::VmmKind;
use crate::vmm::vmm_socket::{self, ControlError, ControlOp, ControlReply};
use boxlite_shared::*;
use chrono::Utc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Semaphore;
use tonic::{Request, Response, Status};

struct GuestGate {
    fail: AtomicBool,
    control_fails: AtomicBool,
    calls: AtomicUsize,
    entered: Semaphore,
    release: Semaphore,
}

impl GuestGate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            fail: AtomicBool::new(true),
            control_fails: AtomicBool::new(false),
            calls: AtomicUsize::new(0),
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
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
        Err(Status::unimplemented("unused"))
    }
    async fn thaw(&self, _: Request<ThawRequest>) -> Result<Response<ThawResponse>, Status> {
        Err(Status::unimplemented("unused"))
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
        self.0.calls.fetch_add(1, Ordering::SeqCst);
        self.0.entered.add_permits(1);
        self.0.release.acquire().await.unwrap().forget();
        if self.0.fail.load(Ordering::SeqCst) {
            Err(Status::unimplemented("injected old guest"))
        } else {
            Ok(Response::new(ResizeFilesystemResponse {}))
        }
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
    _home: tempfile::TempDir,
    server: JoinHandle<()>,
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
    vmm_socket::serve(&inner.layout.sockets().vmm_sock(), move |op| {
        let ControlOp::ResizeDisk { block_id, bytes } = op;
        assert_eq!(block_id, "vda");
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
        if control_gate.control_fails.load(Ordering::SeqCst) {
            return Err(ControlError::Failed("injected completion failure".into()));
        }
        Ok(ControlReply::DiskSize(
            Qcow2Helper::qcow2_virtual_size(&path).unwrap(),
        ))
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
        _home: home,
        server,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_persists_before_guest_failure_and_finishes_after_caller_cancellation() {
    let gate = GuestGate::new();
    let fixture = fixture(gate.clone(), VmmKind::Native).await;
    let bx = fixture.bx.clone();
    let first = tokio::spawn(async move {
        bx.resize(crate::ResizeOptions {
            disk_size_gb: Some(20),
        })
        .await
    });
    gate.entered().await;
    assert_eq!(
        fixture
            .inner
            .runtime
            .box_manager
            .update_box(fixture.inner.id())
            .unwrap()
            .resources
            .unwrap()
            .disk_size_gb,
        20
    );
    gate.release.add_permits(1);
    let error = first.await.unwrap().unwrap_err();
    assert!(matches!(error, BoxliteError::Unsupported(_)));
    assert!(error.to_string().contains("partially completed"));
    assert_eq!(
        fixture
            .bx
            .resize(Default::default())
            .await
            .unwrap()
            .disk_size_gb,
        20
    );

    gate.fail.store(false, Ordering::SeqCst);
    let bx = fixture.bx.clone();
    let retry = tokio::spawn(async move {
        bx.resize(crate::ResizeOptions {
            disk_size_gb: Some(20),
        })
        .await
    });
    gate.entered().await;
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
    let state = fixture
        .inner
        .runtime
        .box_manager
        .update_box(fixture.inner.id())
        .unwrap();
    assert_eq!(state.resources.unwrap().disk_size_gb, 20);
    assert_eq!(state.status, BoxStatus::Stopped);
    assert_eq!(
        gate.calls.load(Ordering::SeqCst),
        2,
        "equal target retries the filesystem step"
    );
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
async fn resize_records_observed_growth_when_device_completion_fails() {
    let gate = GuestGate::new();
    gate.control_fails.store(true, Ordering::SeqCst);
    let fixture = fixture(gate.clone(), VmmKind::Native).await;
    let error = fixture
        .bx
        .resize(crate::ResizeOptions {
            disk_size_gb: Some(20),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, BoxliteError::Engine(_)));
    assert!(
        error
            .to_string()
            .contains("partially completed: 20 GiB allocated")
    );
    assert_eq!(gate.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .bx
            .resize(Default::default())
            .await
            .unwrap()
            .disk_size_gb,
        20
    );
    assert_eq!(
        fixture
            .inner
            .runtime
            .box_manager
            .update_box(fixture.inner.id())
            .unwrap()
            .resources
            .unwrap()
            .disk_size_gb,
        20
    );
}

#[tokio::test]
async fn resize_recovers_actual_allocation_after_a_database_write_failure() {
    let gate = GuestGate::new();
    let fixture = fixture(gate.clone(), VmmKind::Native).await;
    fixture.bx.resize(Default::default()).await.unwrap();
    let db = fixture.inner.runtime.box_manager.db();
    db.conn()
        .execute_batch(
            "CREATE TRIGGER fail_grown_allocation BEFORE UPDATE ON box_state
         WHEN json_extract(NEW.json, '$.resources.disk_size_gb') > 10
         BEGIN SELECT RAISE(ABORT, 'injected allocation failure'); END;",
        )
        .unwrap();
    let error = fixture
        .bx
        .resize(crate::ResizeOptions {
            disk_size_gb: Some(20),
        })
        .await
        .unwrap_err();
    assert!(matches!(error, BoxliteError::Database(_)));
    assert!(
        error
            .to_string()
            .contains("observed 20 GiB disk allocation could not be persisted")
    );
    assert_eq!(gate.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .inner
            .runtime
            .box_manager
            .update_box(fixture.inner.id())
            .unwrap()
            .resources
            .unwrap()
            .disk_size_gb,
        10
    );
    db.conn()
        .execute_batch("DROP TRIGGER fail_grown_allocation;")
        .unwrap();
    assert_eq!(
        fixture
            .bx
            .resize(Default::default())
            .await
            .unwrap()
            .disk_size_gb,
        20
    );
    assert_eq!(
        fixture
            .inner
            .runtime
            .box_manager
            .update_box(fixture.inner.id())
            .unwrap()
            .resources
            .unwrap()
            .disk_size_gb,
        20
    );
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

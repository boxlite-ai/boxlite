//! Host ownership regressions: real runtime/disk operations, a stand-in shim,
//! and loopback guest RPCs. These do not establish VM filesystem correctness.

use super::*;
use crate::disk::constants::filenames::CONTAINER_DISK;
use crate::disk::{BackingFormat, Qcow2Helper};
use crate::lock::LockGuard;
use crate::runtime::options::{ExportOptions, SnapshotOptions};
use boxlite_shared::{
    Guest as GuestService, GuestInitRequest, GuestInitResponse, GuestServer, PingRequest,
    PingResponse, QuiesceRequest, QuiesceResponse, ShutdownRequest, ShutdownResponse, ThawRequest,
    ThawResponse,
};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, LazyLock, Mutex as StdMutex, Weak};
use tracing_subscriber::layer::SubscriberExt;

const DEADLINE: Duration = Duration::from_secs(3);

struct RpcGate {
    entered: Semaphore,
    release: Semaphore,
}

impl RpcGate {
    fn new() -> Self {
        Self {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        }
    }

    async fn pass(&self) {
        self.entered.add_permits(1);
        self.release
            .acquire()
            .await
            .expect("RPC gate closed")
            .forget();
    }

    async fn wait(&self) {
        tokio::time::timeout(DEADLINE, self.entered.acquire())
            .await
            .expect("production operation did not reach guest RPC")
            .expect("RPC gate closed")
            .forget();
    }

    fn open(&self) {
        self.release.add_permits(1);
    }
}

struct QuiesceGuest {
    freeze: RpcGate,
    thaw: RpcGate,
    thawed: AtomicBool,
}

#[derive(Clone)]
struct QuiesceService(Arc<QuiesceGuest>);

#[tonic::async_trait]
impl GuestService for QuiesceService {
    async fn init(
        &self,
        _: Request<GuestInitRequest>,
    ) -> Result<Response<GuestInitResponse>, Status> {
        Err(Status::unimplemented(
            "fixture installs an already-booted guest",
        ))
    }

    async fn ping(&self, _: Request<PingRequest>) -> Result<Response<PingResponse>, Status> {
        Ok(Response::new(PingResponse {
            version: "quiesce-fixture".into(),
        }))
    }

    async fn shutdown(
        &self,
        _: Request<ShutdownRequest>,
    ) -> Result<Response<ShutdownResponse>, Status> {
        Err(Status::unimplemented("fixture owns the stand-in process"))
    }

    async fn quiesce(
        &self,
        _: Request<QuiesceRequest>,
    ) -> Result<Response<QuiesceResponse>, Status> {
        self.0.freeze.pass().await;
        Ok(Response::new(QuiesceResponse { frozen_count: 1 }))
    }

    async fn thaw(&self, _: Request<ThawRequest>) -> Result<Response<ThawResponse>, Status> {
        self.0.thaw.pass().await;
        self.0.thawed.store(true, Ordering::SeqCst);
        Ok(Response::new(ThawResponse { thawed_count: 1 }))
    }
}

struct QuiesceFixture {
    facade: Arc<BoxImpl>,
    guest: Arc<QuiesceGuest>,
    server: JoinHandle<()>,
    _child: ChildGuard,
    _home: TempDir,
}

impl Drop for QuiesceFixture {
    fn drop(&mut self) {
        self.guest.freeze.open();
        self.guest.thaw.open();
        self.server.abort();
    }
}

impl QuiesceFixture {
    async fn new() -> Self {
        let home = TempDir::new_in("/tmp").expect("create runtime home");
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            image_registries: vec![],
            ..Default::default()
        })
        .expect("create runtime");
        let child = ChildGuard(
            std::process::Command::new("sleep")
                .arg("300")
                .spawn()
                .expect("spawn stand-in shim"),
        );
        let pid = child.0.id();
        let id = BoxIDMint::mint();
        let box_home = runtime.layout.boxes_dir().join(id.as_str());
        let config = BoxConfig {
            id: id.clone(),
            name: None,
            created_at: Utc::now(),
            container: ContainerRuntimeConfig {
                id: ContainerID::new(),
            },
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                detach: true,
                auto_delete: Some(0),
                ..Default::default()
            },
            engine_kind: VmmKind::Libkrun,
            box_home: box_home.clone(),
        };
        let mut state = BoxState::new();
        state.status = BoxStatus::Running;
        state.mark_started();
        state.pid = Some(pid);
        state.set_lock_id(
            runtime
                .lock_manager
                .allocate()
                .expect("allocate lifecycle lock"),
        );
        std::fs::create_dir_all(box_home.join("disks")).expect("create disk directory");
        let layout = runtime
            .layout
            .box_layout(id.as_str(), false)
            .expect("box layout");
        let started = crate::util::process_start_time(pid).expect("shim start time");
        std::fs::write(layout.pid_file_path(), format!("{pid}\n{started}\n"))
            .expect("write shim identity");
        runtime
            .box_manager
            .add_box(&config, &state)
            .expect("persist box");

        // Noncompressible backing data keeps archive output larger than a FIFO's
        // capacity. The qcow2 header itself comes from the production disk helper.
        let raw = box_home.join("base.raw");
        let mut seed = 0x1234_5678_u32;
        let bytes: Vec<u8> = (0..1024 * 1024)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as u8
            })
            .collect();
        std::fs::write(&raw, &bytes).expect("write raw backing data");
        let disk_path = box_home.join("disks").join(CONTAINER_DISK);
        Qcow2Helper::create_cow_child_disk(
            &raw,
            BackingFormat::Raw,
            &disk_path,
            bytes.len() as u64,
        )
        .expect("create real qcow2 fixture")
        .leak();

        let guest = Arc::new(QuiesceGuest {
            freeze: RpcGate::new(),
            thaw: RpcGate::new(),
            thawed: AtomicBool::new(false),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind guest");
        let address = listener.local_addr().expect("guest address");
        let incoming = tonic::transport::server::TcpIncoming::from_listener(listener, true, None)
            .expect("guest listener");
        let service = Arc::clone(&guest);
        let server = tokio::spawn(async move {
            Server::builder()
                .add_service(GuestServer::new(QuiesceService(service)))
                .serve_with_incoming(incoming)
                .await
                .expect("serve guest");
        });
        Endpoint::from_shared(format!("http://{address}"))
            .expect("guest endpoint")
            .connect()
            .await
            .expect("connect loopback guest");

        let handle = runtime
            .get(id.as_str())
            .await
            .expect("runtime.get")
            .expect("persisted box");
        let facade = handle
            .box_backend
            .clone()
            .as_any_arc()
            .downcast::<BoxImpl>()
            .unwrap_or_else(|_| panic!("expected local runtime facade"));
        let again = runtime
            .get(id.as_str())
            .await
            .expect("second runtime.get")
            .expect("cached box");
        let same = again
            .box_backend
            .clone()
            .as_any_arc()
            .downcast::<BoxImpl>()
            .unwrap_or_else(|_| panic!("expected cached local facade"));
        assert!(
            Arc::ptr_eq(&facade, &same),
            "fixture must retain the original disk_ops mutex"
        );
        let live = LiveState::new(
            Box::new(InfoTestHandler(pid)),
            GuestSession::new(BoxTransport::tcp(address.port())),
            None,
            None,
            BoxMetricsStorage::new(),
            Disk::new(disk_path, DiskFormat::Qcow2, true),
            None,
            #[cfg(target_os = "linux")]
            None,
        );
        assert!(facade.live.set(live).is_ok(), "install booted live state");
        Self {
            facade,
            guest,
            server,
            _child: child,
            _home: home,
        }
    }

    fn marker(&self) -> PathBuf {
        self.facade.config.box_home.join(".snapshot_pending")
    }

    fn lifecycle_available(&self) -> bool {
        let id = self.facade.state.read().lock_id.expect("persisted lock id");
        let locker = self
            .facade
            .runtime
            .lock_manager
            .retrieve(id)
            .expect("independent lifecycle handle");
        LockGuard::try_new(locker.as_ref()).is_some()
    }

    fn assert_quiesce_owned(&self) {
        assert!(
            self.facade.disk_ops.try_lock().is_err(),
            "caller cancellation released original disk_ops before quiesce cleanup"
        );
        assert!(
            !self.lifecycle_available(),
            "caller cancellation released lifecycle admission before resume/thaw"
        );
    }

    async fn finish(&self) {
        let _disk = tokio::time::timeout(DEADLINE, self.facade.disk_ops.lock())
            .await
            .expect("completed owner did not release original disk_ops");
        assert!(
            self.guest.thawed.load(Ordering::SeqCst),
            "disk admission preceded guest thaw"
        );
        assert!(
            self.lifecycle_available(),
            "completed quiesce retained lifecycle admission"
        );
        assert_eq!(
            self.facade.state.read().status,
            BoxStatus::Running,
            "shim was not resumed"
        );
        assert!(
            !self.marker().exists(),
            "completed snapshot owner left its pending marker"
        );
    }

    fn snapshot(&self) -> JoinHandle<BoxliteResult<crate::litebox::snapshot_mgr::SnapshotInfo>> {
        use crate::runtime::backend::SnapshotBackend;
        let backend = crate::litebox::LocalSnapshotBackend::new(Arc::clone(&self.facade));
        tokio::spawn(async move {
            backend
                .create(SnapshotOptions::default(), "cancelled")
                .await
        })
    }

    fn export(
        &self,
        destination: PathBuf,
    ) -> JoinHandle<BoxliteResult<crate::runtime::options::BoxArchive>> {
        let facade = Arc::clone(&self.facade);
        tokio::spawn(async move {
            facade
                .export_box(ExportOptions::default(), &destination)
                .await
        })
    }
}

async fn cancel<T: Send + 'static>(caller: JoinHandle<T>) {
    caller.abort();
    assert!(
        caller
            .await
            .err()
            .expect("caller was not cancelled")
            .is_cancelled()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_cancellation_during_freeze_keeps_owner_through_marker_cleanup() {
    let fixture = QuiesceFixture::new().await;
    let caller = fixture.snapshot();
    fixture.guest.freeze.wait().await;
    assert!(
        fixture.marker().exists(),
        "snapshot did not create recovery marker"
    );
    cancel(caller).await;
    fixture.assert_quiesce_owned();
    fixture.guest.freeze.open();
    fixture.guest.thaw.wait().await;
    fixture.assert_quiesce_owned();
    fixture.guest.thaw.open();
    fixture.finish().await;
    assert!(
        fixture
            .facade
            .runtime
            .snapshot_mgr
            .exists(fixture.facade.id().as_str(), "cancelled")
            .expect("snapshot lookup"),
        "cancelled caller prevented snapshot completion"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_cancellation_during_thaw_keeps_owner_through_marker_cleanup() {
    let fixture = QuiesceFixture::new().await;
    fixture.guest.freeze.open();
    let caller = fixture.snapshot();
    fixture.guest.thaw.wait().await;
    assert!(
        fixture.marker().exists(),
        "marker must survive until thaw finishes"
    );
    assert_eq!(fixture.facade.state.read().status, BoxStatus::Running);
    cancel(caller).await;
    fixture.assert_quiesce_owned();
    fixture.guest.thaw.open();
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_error_resumes_thaws_and_removes_pending_marker() {
    let fixture = QuiesceFixture::new().await;
    std::fs::remove_file(
        fixture
            .facade
            .config
            .box_home
            .join("disks")
            .join(CONTAINER_DISK),
    )
    .expect("remove disk to force real snapshot failure");
    fixture.guest.freeze.open();
    let caller = fixture.snapshot();
    fixture.guest.thaw.wait().await;
    fixture.assert_quiesce_owned();
    assert!(fixture.marker().exists());
    fixture.guest.thaw.open();
    let error = caller
        .await
        .expect("snapshot task panicked")
        .expect_err("missing disk must fail");
    assert!(
        matches!(error, BoxliteError::Storage(_)),
        "unexpected failure: {error}"
    );
    fixture.finish().await;
}

// The production flatten trace is a scheduling gate only. Disk parsing and
// copying still run unchanged, after the gate opens. Path matching isolates
// concurrent tests; dropping the registration always unblocks a paused worker.
struct FlattenGate {
    source: PathBuf,
    entered: Semaphore,
    released: StdMutex<bool>,
    changed: Condvar,
}

struct FlattenPause(Arc<FlattenGate>);

static FLATTEN_GATES: LazyLock<StdMutex<Vec<Weak<FlattenGate>>>> = LazyLock::new(|| {
    tracing::subscriber::set_global_default(tracing_subscriber::registry().with(FlattenLayer))
        .expect("install production trace scheduling gate");
    StdMutex::new(Vec::new())
});

struct FlattenLayer;

#[derive(Default)]
struct FlattenFields {
    source: String,
    message: String,
}

impl tracing::field::Visit for FlattenFields {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let value = format!("{value:?}");
        match field.name() {
            "src" => self.source = value.trim_matches('"').to_owned(),
            "message" => self.message = value.trim_matches('"').to_owned(),
            _ => {}
        }
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for FlattenLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        let mut fields = FlattenFields::default();
        event.record(&mut fields);
        if fields.message != "Flattening QCOW2 disk image" {
            return;
        }
        let gate = FLATTEN_GATES
            .lock()
            .unwrap()
            .iter()
            .filter_map(Weak::upgrade)
            .find(|gate| gate.source.to_string_lossy() == fields.source);
        if let Some(gate) = gate {
            let released = gate.released.lock().unwrap();
            gate.entered.add_permits(1);
            let (released, _) = gate
                .changed
                .wait_timeout_while(released, Duration::from_secs(10), |open| !*open)
                .unwrap();
            assert!(*released, "test did not release production flatten worker");
        }
    }
}

impl FlattenPause {
    fn new(source: PathBuf) -> Self {
        let gate = Arc::new(FlattenGate {
            source,
            entered: Semaphore::new(0),
            released: StdMutex::new(false),
            changed: Condvar::new(),
        });
        let mut gates = FLATTEN_GATES.lock().unwrap();
        gates.retain(|gate| gate.strong_count() != 0);
        gates.push(Arc::downgrade(&gate));
        Self(gate)
    }

    async fn wait(&self) {
        tokio::time::timeout(DEADLINE, self.0.entered.acquire())
            .await
            .expect("export did not enter real blocking flatten worker")
            .expect("flatten gate closed")
            .forget();
    }

    fn open(&self) {
        *self.0.released.lock().unwrap() = true;
        self.0.changed.notify_all();
    }
}

impl Drop for FlattenPause {
    fn drop(&mut self) {
        self.open();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_cancellation_during_flatten_keeps_owner_until_resume_and_thaw() {
    let fixture = QuiesceFixture::new().await;
    let pause = FlattenPause::new(
        fixture
            .facade
            .config
            .box_home
            .join("disks")
            .join(CONTAINER_DISK),
    );
    fixture.guest.freeze.open();
    let archive = fixture.facade.config.box_home.join("export.boxlite");
    let caller = fixture.export(archive.clone());
    pause.wait().await;
    assert_eq!(fixture.facade.state.read().status, BoxStatus::Paused);
    cancel(caller).await;
    fixture.assert_quiesce_owned();
    pause.open();
    fixture.guest.thaw.wait().await;
    fixture.assert_quiesce_owned();
    fixture.guest.thaw.open();
    fixture.finish().await;
    assert_archive(&archive, &fixture.facade.config.box_home.join("extracted"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_flatten_error_still_resumes_and_thaws() {
    let fixture = QuiesceFixture::new().await;
    std::fs::remove_file(
        fixture
            .facade
            .config
            .box_home
            .join("disks")
            .join(CONTAINER_DISK),
    )
    .expect("remove disk to fail blocking export worker");
    fixture.guest.freeze.open();
    let caller = fixture.export(fixture.facade.config.box_home.join("failed.boxlite"));
    fixture.guest.thaw.wait().await;
    fixture.assert_quiesce_owned();
    fixture.guest.thaw.open();
    let error = caller
        .await
        .expect("export task panicked")
        .expect_err("missing disk must fail");
    assert!(
        matches!(error, BoxliteError::Storage(_)),
        "unexpected failure: {error}"
    );
    fixture.finish().await;
}

fn assert_archive(archive: &Path, extracted: &Path) {
    use crate::litebox::archive::{
        ArchiveManifest, MANIFEST_FILENAME, extract_archive, sha256_file,
    };
    std::fs::create_dir_all(extracted).expect("create extraction directory");
    extract_archive(archive, extracted).expect("completed export must be a valid archive");
    let manifest: ArchiveManifest = serde_json::from_slice(
        &std::fs::read(extracted.join(MANIFEST_FILENAME)).expect("read exported manifest"),
    )
    .expect("decode exported manifest");
    assert_eq!(
        manifest.container_disk_checksum,
        sha256_file(&extracted.join(CONTAINER_DISK)).expect("checksum archived disk")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_finalization_cancellation_releases_lifecycle_but_retains_disk_until_archive_finishes()
 {
    let fixture = QuiesceFixture::new().await;
    let output = fixture.facade.config.box_home.join("archive.fifo");
    let path =
        std::ffi::CString::new(output.as_os_str().as_encoded_bytes()).expect("FIFO pathname");
    // A FIFO pauses the actual archive writer without modifying production.
    assert_eq!(
        unsafe { libc::mkfifo(path.as_ptr(), 0o600) },
        0,
        "create archive FIFO"
    );
    let mut reader = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&output)
        .expect("open archive reader");
    fixture.guest.freeze.open();
    let caller = fixture.export(output);
    fixture.guest.thaw.wait().await;
    fixture.assert_quiesce_owned();
    fixture.guest.thaw.open();
    // The first actual byte (not FIFO readability, which can also mean EOF
    // before a writer opens) proves finalization reached the archive writer.
    // Leave the remaining incompressible image buffered so the writer blocks.
    let first_byte = tokio::time::timeout(DEADLINE, async {
        loop {
            let mut byte = [0];
            match reader.read(&mut byte) {
                Ok(1) => break byte[0],
                Ok(0) => tokio::task::yield_now().await,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::task::yield_now().await;
                }
                Err(error) => panic!("read archive writer: {error}"),
                Ok(_) => unreachable!("one-byte buffer"),
            }
        }
    })
    .await
    .expect("archive finalization did not write its first byte");
    assert!(fixture.guest.thawed.load(Ordering::SeqCst));
    assert!(
        fixture.lifecycle_available(),
        "archive finalization retained lifecycle admission"
    );
    assert!(
        fixture.facade.disk_ops.try_lock().is_err(),
        "archive finalization lost disk admission"
    );
    cancel(caller).await;
    assert!(
        fixture.lifecycle_available(),
        "cancelled finalizer reacquired lifecycle admission"
    );
    assert!(
        fixture.facade.disk_ops.try_lock().is_err(),
        "caller cancellation released disk_ops while archive worker was still writing"
    );

    // The final byte is emitted only after a reader drains the real archive.
    let flags = unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_GETFL) };
    assert!(flags >= 0, "read FIFO flags");
    assert_eq!(
        unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK) },
        0
    );
    let bytes = tokio::time::timeout(
        DEADLINE,
        tokio::task::spawn_blocking(move || {
            let mut bytes = vec![first_byte];
            reader
                .read_to_end(&mut bytes)
                .expect("drain archive through EOF");
            bytes
        }),
    )
    .await
    .expect("archive writer did not finish after drain")
    .expect("archive reader panicked");
    fixture.finish().await;
    let archive = fixture.facade.config.box_home.join("completed.boxlite");
    std::fs::write(&archive, bytes).expect("save streamed archive");
    assert_archive(&archive, &fixture.facade.config.box_home.join("extracted"));
}

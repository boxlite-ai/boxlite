//! Local reproducer for stopping a box while its first boot is in progress.

use boxlite::runtime::options::{BoxOptions, BoxliteOptions, NetworkSpec, RootfsSpec, VolumeSpec};
use boxlite::{BoxStatus, BoxliteRuntime};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use tracing::field::{Field, Visit};
use tracing_subscriber::prelude::*;

#[derive(Default)]
struct BeforeSpawn {
    entered: Notify,
    start_cancelled: Notify,
    released: Mutex<bool>,
    changed: Condvar,
    published_pid: AtomicU32,
}

impl BeforeSpawn {
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}

#[derive(Default)]
struct LifecycleEvent {
    before_spawn: bool,
    start_cancelled: bool,
    published: bool,
    pid: Option<u32>,
}

impl Visit for LifecycleEvent {
    fn record_u64(&mut self, field: &Field, value: u64) {
        if field.name() == "pid" {
            self.pid = u32::try_from(value).ok();
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "task" && format!("{value:?}") == "vmm_spawn" {
            self.before_spawn = true;
        }
        if field.name() == "message"
            && format!("{value:?}") == "Container start cancelled because the box is stopping"
        {
            self.start_cancelled = true;
        }
        if field.name() == "message" && format!("{value:?}") == "Read PID from file and saved to DB"
        {
            self.published = true;
        }
    }
}

struct PauseBeforeSpawn(Arc<BeforeSpawn>);

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for PauseBeforeSpawn {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        let mut lifecycle = LifecycleEvent::default();
        event.record(&mut lifecycle);
        if lifecycle.published
            && let Some(pid) = lifecycle.pid
        {
            self.0.published_pid.store(pid, Ordering::SeqCst);
        }
        if lifecycle.start_cancelled {
            self.0.start_cancelled.notify_one();
        }
        if lifecycle.before_spawn {
            // Pause at a production trace event before the VM is spawned. This
            // changes scheduling only; neither lifecycle state nor results are faked.
            self.0.entered.notify_one();
            let released = self.0.released.lock().unwrap();
            let (_released, timeout) = self
                .0
                .changed
                .wait_timeout_while(released, Duration::from_secs(60), |released| !*released)
                .unwrap();
            assert!(!timeout.timed_out(), "reproducer did not release VM spawn");
        }
    }
}

async fn run_start_stop(stop_during_boot: bool) {
    let home = tempfile::TempDir::new_in("/tmp").unwrap();
    let evidence = home.path().join("evidence");
    std::fs::create_dir(&evidence).unwrap();
    let main_started = evidence.join("main-started");
    let rootfs = std::env::var("BOXLITE_REPRO_ROOTFS").expect("set BOXLITE_REPRO_ROOTFS");
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    })
    .expect("create VM-capable runtime");
    let handle = Arc::new(
        runtime
            .create(
                BoxOptions {
                    rootfs: RootfsSpec::RootfsPath(rootfs),
                    auto_delete: Some(0),
                    detach: true,
                    network: NetworkSpec::Disabled,
                    volumes: vec![VolumeSpec::bind_mount(
                        evidence.to_str().unwrap(),
                        "/evidence",
                    )],
                    cmd: Some(vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "echo started > /evidence/main-started; exec /bin/sleep 300".into(),
                    ]),
                    ..Default::default()
                },
                None,
            )
            .await
            .expect("create box"),
    );

    let gate = Arc::new(BeforeSpawn::default());
    if stop_during_boot {
        tracing::subscriber::set_global_default(
            tracing_subscriber::registry().with(PauseBeforeSpawn(Arc::clone(&gate))),
        )
        .expect("install scheduling gate");
    }

    let starter = handle.clone();
    let start = tokio::spawn(async move { starter.start().await });
    let stop_waited;
    let stop_result = if stop_during_boot {
        let entered = tokio::time::timeout(Duration::from_secs(60), gate.entered.notified()).await;
        if entered.is_err() {
            gate.release();
            let result = start.await;
            panic!("VM spawn boundary was not reached; start result: {result:?}");
        }
        let before_stop = handle.info().await.expect("inspect before stop");
        assert_eq!(before_stop.status, BoxStatus::Configured);
        let stopped = handle.stop();
        tokio::pin!(stopped);
        stop_waited = futures::poll!(&mut stopped).is_pending();
        gate.release();
        tokio::time::timeout(Duration::from_secs(90), stopped)
            .await
            .expect("stop timed out after boot was released")
    } else {
        // The control must traverse the same real boot pipeline successfully.
        tokio::time::timeout(Duration::from_secs(90), start)
            .await
            .expect("control start timed out")
            .expect("control task panicked")
            .expect("control boot failed");
        let running = handle.info().await.expect("inspect control boot");
        assert_eq!(running.status, BoxStatus::Running);
        let marker_seen = tokio::time::timeout(Duration::from_secs(5), async {
            while !main_started.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();
        let stopped = handle.stop().await;
        let after_stop = handle.info().await.expect("inspect control stop");
        eprintln!(
            "control: stop={stopped:?}, status={:?}, main_started={marker_seen}",
            after_stop.status
        );
        runtime.shutdown(Some(15)).await.expect("shutdown control");
        stopped.expect("control stop failed");
        assert!(marker_seen, "control main command never wrote its marker");
        assert_eq!(after_stop.status, BoxStatus::Stopped);
        return;
    };

    let start_result = tokio::time::timeout(Duration::from_secs(90), start)
        .await
        .expect("start timed out after release")
        .expect("start task panicked");
    let cancelled =
        tokio::time::timeout(Duration::from_secs(5), gate.start_cancelled.notified()).await;
    let marker_seen = main_started.exists();
    let after_start = handle.info().await.expect("inspect after raced start");
    let persisted = runtime
        .get_info(handle.id().as_str())
        .await
        .expect("read persisted box")
        .expect("box must be retained");
    let published_pid = gate.published_pid.load(Ordering::SeqCst);
    assert_ne!(published_pid, 0, "did not observe the real shim PID");
    let alive = unsafe { libc::kill(published_pid as i32, 0) } == 0;
    eprintln!(
        "race: stop={stop_result:?}, start={start_result:?}, status={:?}, persisted={:?}, pid={:?}, alive={alive}, main_started={marker_seen}, container_start_cancelled={}",
        after_start.status,
        persisted.status,
        after_start.pid,
        cancelled.is_ok(),
    );

    // Collect evidence before cleanup, and clean up before the defect assertion.
    let cleanup = handle.stop().await;
    runtime
        .shutdown(Some(15))
        .await
        .expect("shutdown reproducer");
    cleanup.expect("cleanup stop failed");
    let alive_after_cleanup = unsafe { libc::kill(published_pid as i32, 0) } == 0;
    eprintln!("cleanup: alive={alive_after_cleanup}");
    assert!(!alive_after_cleanup, "reproducer left its shim running");
    assert!(
        stop_waited,
        "stop returned before the in-progress boot released its lock"
    );
    stop_result.expect("raced stop failed");
    start_result.expect("boot failed; this does not reproduce the lifecycle defect");
    assert_eq!(
        after_start.status,
        BoxStatus::Stopped,
        "stop did not finish teardown after waiting for boot (pid={published_pid}, alive={alive})",
    );
    assert_eq!(persisted.status, BoxStatus::Stopped);
    assert!(!alive, "stop left its shim running");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Opt-in VM reproducer; requires BOXLITE_REPRO_ROOTFS and a real runtime"]
async fn start_stop_control() {
    run_start_stop(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Opt-in VM regression; requires BOXLITE_REPRO_ROOTFS and a real runtime"]
async fn start_stop_during_first_boot() {
    run_start_stop(true).await;
}

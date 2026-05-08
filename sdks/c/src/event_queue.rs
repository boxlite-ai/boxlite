//! Per-runtime event queue and callback typedefs for the post-and-drain C API.
//!
//! Tokio tasks push completion events here; the user thread pops them via
//! `boxlite_runtime_drain` and dispatches the typed callbacks on the calling
//! thread. Callbacks therefore NEVER fire on Tokio worker threads.

use std::collections::VecDeque;
use std::os::raw::{c_int, c_void};
use std::sync::{Condvar, Mutex};

use boxlite::BoxliteError;

use crate::images::{CImageInfoList, CImagePullResult};
use crate::info::{CBoxInfo, CBoxInfoList};
use crate::metrics::{CBoxMetrics, CRuntimeMetrics};

/// Maximum number of buffered events before producer tasks yield.
pub const QUEUE_CAPACITY: usize = 4096;

// ─── Callback typedefs ─────────────────────────────────────────────────────
//
// All callbacks are `extern "C" fn(...)` aliases so cbindgen emits proper
// `typedef`s. They are invoked by `boxlite_runtime_drain` on the calling
// thread, never from a Tokio worker.

/// Streaming stdout chunk callback.
pub type CBoxStdoutCb = extern "C" fn(*const u8, usize, *mut c_void);

/// Streaming stderr chunk callback.
pub type CBoxStderrCb = extern "C" fn(*const u8, usize, *mut c_void);

/// Process exit callback (fired once per execution).
pub type CBoxExitCb = extern "C" fn(c_int, *mut c_void);

/// Box creation completion.
pub type CBoxCreateBoxCb =
    extern "C" fn(*mut crate::CBoxHandle, *mut crate::CBoxliteError, *mut c_void);

/// Box start completion.
pub type CBoxStartBoxCb = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Box stop completion.
pub type CBoxStopBoxCb = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Box attach (get) completion.
pub type CBoxGetBoxCb =
    extern "C" fn(*mut crate::CBoxHandle, *mut crate::CBoxliteError, *mut c_void);

/// Box remove completion.
pub type CBoxRemoveBoxCb = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Image pull completion.
pub type CBoxImagePullCb =
    extern "C" fn(*mut CImagePullResult, *mut crate::CBoxliteError, *mut c_void);

/// Image list completion.
pub type CBoxImageListCb =
    extern "C" fn(*mut CImageInfoList, *mut crate::CBoxliteError, *mut c_void);

/// Copy (into / out of) completion.
pub type CBoxCopyCb = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Box info completion.
pub type CBoxInfoCb = extern "C" fn(*mut CBoxInfo, *mut crate::CBoxliteError, *mut c_void);

/// Box info list completion.
pub type CBoxInfoListCb = extern "C" fn(*mut CBoxInfoList, *mut crate::CBoxliteError, *mut c_void);

/// Per-box metrics completion.
pub type CBoxMetricsCb = extern "C" fn(*mut CBoxMetrics, *mut crate::CBoxliteError, *mut c_void);

/// Runtime metrics completion.
pub type CRuntimeMetricsCb =
    extern "C" fn(*mut CRuntimeMetrics, *mut crate::CBoxliteError, *mut c_void);

/// Runtime shutdown completion.
pub type CRuntimeShutdownCb = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Execution wait completion (carries exit code on success).
pub type CExecutionWaitCb = extern "C" fn(c_int, *mut crate::CBoxliteError, *mut c_void);

/// Execution kill completion.
pub type CExecutionKillCb = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Execution PTY resize completion.
pub type CExecutionResizeCb = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

// ─── Event variants ────────────────────────────────────────────────────────
//
// Each async op produces exactly one of these events; streaming pumps
// produce many `Stdout`/`Stderr` events plus a single `Exit` per execution.
// `user_data` is stored as `usize` because raw `*mut c_void` is `!Send`;
// it is cast back to `*mut c_void` at dispatch time.

pub enum RuntimeEvent {
    /* Streaming */
    Stdout {
        cb: CBoxStdoutCb,
        user_data: usize,
        data: Vec<u8>,
    },
    Stderr {
        cb: CBoxStderrCb,
        user_data: usize,
        data: Vec<u8>,
    },
    Exit {
        cb: CBoxExitCb,
        user_data: usize,
        exit_code: i32,
    },

    /* Lifecycle */
    CreateBox {
        cb: CBoxCreateBoxCb,
        user_data: usize,
        result: Result<usize, BoxliteError>, // *mut CBoxHandle encoded as usize for Send
    },
    StartBox {
        cb: CBoxStartBoxCb,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    StopBox {
        cb: CBoxStopBoxCb,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    GetBox {
        cb: CBoxGetBoxCb,
        user_data: usize,
        result: Result<usize, BoxliteError>, // *mut CBoxHandle encoded as usize
    },
    RemoveBox {
        cb: CBoxRemoveBoxCb,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    ImagePull {
        cb: CBoxImagePullCb,
        user_data: usize,
        result: Result<usize, BoxliteError>, // *mut CImagePullResult encoded as usize
    },
    ImageList {
        cb: CBoxImageListCb,
        user_data: usize,
        result: Result<usize, BoxliteError>, // *mut CImageInfoList encoded as usize
    },
    Copy {
        cb: CBoxCopyCb,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    Info {
        cb: CBoxInfoCb,
        user_data: usize,
        result: Result<usize, BoxliteError>, // *mut CBoxInfo encoded as usize
    },
    InfoList {
        cb: CBoxInfoListCb,
        user_data: usize,
        result: Result<usize, BoxliteError>, // *mut CBoxInfoList encoded as usize
    },
    Metrics {
        cb: CBoxMetricsCb,
        user_data: usize,
        result: Result<CBoxMetrics, BoxliteError>,
    },
    RtMetrics {
        cb: CRuntimeMetricsCb,
        user_data: usize,
        result: Result<CRuntimeMetrics, BoxliteError>,
    },
    Shutdown {
        cb: CRuntimeShutdownCb,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    Wait {
        cb: CExecutionWaitCb,
        user_data: usize,
        result: Result<i32, BoxliteError>,
    },
    Kill {
        cb: CExecutionKillCb,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    Resize {
        cb: CExecutionResizeCb,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
}

// SAFETY: every contained field is `Send`:
//  - extern "C" fn pointers are Send.
//  - usize (user_data, encoded handle pointers) is Send.
//  - Vec<u8>, BoxliteError, CBoxMetrics, CRuntimeMetrics own their data.
// Handles encoded as usize represent ownership transfer from the producing
// Tokio task to the consuming drain thread; no aliasing occurs in transit.
unsafe impl Send for RuntimeEvent {}

// ─── Queue ─────────────────────────────────────────────────────────────────

pub struct EventQueue {
    pub inner: Mutex<VecDeque<RuntimeEvent>>,
    pub cv: Condvar,
}

impl EventQueue {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
        }
    }
}

impl Default for EventQueue {
    fn default() -> Self {
        Self::new()
    }
}

/// Push an event to the queue. If the queue is full, cooperatively yield and
/// retry — Tokio workers stay free for other tasks.
pub async fn push_event(queue: &EventQueue, ev: RuntimeEvent) {
    push_event_with_capacity(queue, ev, QUEUE_CAPACITY).await;
}

/// Push an event with a caller-supplied capacity. Used by tests to exercise
/// the cooperative-yield path without flooding the production-sized queue.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn push_event_with_capacity(
    queue: &EventQueue,
    ev: RuntimeEvent,
    capacity: usize,
) {
    let mut ev = Some(ev);
    loop {
        {
            let mut g = queue.inner.lock().unwrap();
            if g.len() < capacity {
                g.push_back(ev.take().expect("event consumed exactly once"));
                drop(g);
                queue.cv.notify_one();
                return;
            }
        }
        tokio::task::yield_now().await;
    }
}

// ─── Phase-2 regression tests ──────────────────────────────────────────────
//
// These tests guard the cardinal architectural invariant introduced by the
// post-and-drain redesign: callbacks NEVER fire on Tokio worker threads.
// They were the root cause of the May 2026 outage; if they regress, the bug
// class returns. Each test exercises the real `boxlite_runtime_drain` and
// `push_event` paths against a `RuntimeHandle` built on top of a stub REST
// runtime (no real VM is required to validate the queue + dispatch).

#[cfg(test)]
mod phase2_regression_tests {
    use super::*;

    use std::collections::HashSet;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread::{self, ThreadId};
    use std::time::{Duration, Instant};

    use std::sync::OnceLock;

    use tokio::runtime::Builder as TokioBuilder;

    use crate::error::FFIError;
    use crate::runtime::{RuntimeHandle, RuntimeLiveness};
    use crate::{boxlite_runtime_drain, boxlite_runtime_free};

    /// Process-wide recorder shared with the [A] callback. Tests serialize
    /// via the standard cargo-test thread (one test fn at a time per
    /// `#[test]`); we still acquire `RECORDER`'s mutex on every cb call.
    static RECORDER: OnceLock<StdMutex<HashSet<ThreadId>>> = OnceLock::new();

    fn recorder() -> &'static StdMutex<HashSet<ThreadId>> {
        RECORDER.get_or_init(|| StdMutex::new(HashSet::new()))
    }

    extern "C" fn record_thread_id_cb(_data: *const u8, _len: usize, _ud: *mut c_void) {
        recorder().lock().unwrap().insert(thread::current().id());
    }

    /// Build a stub `RuntimeHandle` backed by a REST `BoxliteRuntime` (no VM
    /// I/O is exercised by these tests; only the queue + drain). The caller
    /// owns the returned `*mut RuntimeHandle` and must `boxlite_runtime_free`
    /// it.
    fn new_stub_runtime_handle(tokio_workers: usize) -> *mut RuntimeHandle {
        let tokio_rt = Arc::new(
            TokioBuilder::new_multi_thread()
                .worker_threads(tokio_workers)
                .enable_all()
                .build()
                .expect("tokio runtime"),
        );
        let runtime = boxlite::runtime::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(
            "http://127.0.0.1:1",
        ))
        .expect("rest runtime");
        Box::into_raw(Box::new(RuntimeHandle {
            runtime,
            tokio_rt,
            liveness: Arc::new(RuntimeLiveness::new()),
            queue: Arc::new(EventQueue::new()),
        }))
    }

    /// [A] Cardinal invariant: callbacks fire ONLY on the drain thread,
    /// NEVER on a Tokio worker. The original outage stemmed from the
    /// opposite — the regression guard for that bug class.
    #[test]
    fn callbacks_fire_on_drain_thread_only() {
        const NUM_EVENTS: usize = 100;
        const NUM_WORKERS: usize = 4;

        // Reset the recorder for a clean run (the static persists across
        // tests in the same process).
        recorder().lock().unwrap().clear();

        let rt_ptr = new_stub_runtime_handle(NUM_WORKERS);

        // Capture every Tokio worker id by spawning enough scout tasks to
        // cover all workers. Each scout reports its current thread id.
        let worker_ids: Arc<StdMutex<HashSet<ThreadId>>> = Arc::new(StdMutex::new(HashSet::new()));
        {
            let rt = unsafe { &*rt_ptr };
            for _ in 0..(NUM_WORKERS * 4) {
                let workers = worker_ids.clone();
                rt.tokio_rt.spawn(async move {
                    workers.lock().unwrap().insert(thread::current().id());
                    // Hold the worker for a tick so siblings get scheduled
                    // onto distinct threads.
                    tokio::time::sleep(Duration::from_millis(5)).await;
                });
            }
            // Give scouts a moment to populate the worker-id set before we
            // start producing events.
            std::thread::sleep(Duration::from_millis(50));
        }

        // Producers: NUM_EVENTS Tokio tasks, each pushing one Stdout event.
        {
            let rt = unsafe { &*rt_ptr };
            for i in 0..NUM_EVENTS {
                let queue = rt.queue.clone();
                rt.tokio_rt.spawn(async move {
                    push_event(
                        &queue,
                        RuntimeEvent::Stdout {
                            cb: record_thread_id_cb,
                            user_data: 0,
                            data: vec![i as u8],
                        },
                    )
                    .await;
                });
            }
        }

        // Drain on this (test) thread. Capture the thread id and accumulate
        // events until we've seen all NUM_EVENTS dispatches.
        let drain_thread_id = thread::current().id();
        let mut dispatched: i32 = 0;
        let started = Instant::now();
        let mut error = FFIError::default();
        while dispatched < NUM_EVENTS as i32 {
            let n = unsafe { boxlite_runtime_drain(rt_ptr, 100, &mut error as *mut _) };
            assert!(n >= 0, "drain returned -1");
            dispatched += n;
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "drain did not dispatch all events within 10s (got {dispatched})"
            );
        }
        unsafe { crate::boxlite_error_free(&mut error as *mut _) };

        let recorded = recorder().lock().unwrap().clone();
        let workers = worker_ids.lock().unwrap().clone();

        // Assertions: every dispatch happened on the drain thread.
        assert_eq!(
            recorded.len(),
            1,
            "callbacks fired on multiple threads: {recorded:?} (workers: {workers:?})"
        );
        assert!(
            recorded.contains(&drain_thread_id),
            "recorded id {recorded:?} != drain thread {drain_thread_id:?}"
        );
        assert!(
            recorded.is_disjoint(&workers),
            "callback fired on a Tokio worker thread (recorded {recorded:?}, workers {workers:?})"
        );

        unsafe { boxlite_runtime_free(rt_ptr) };
    }

    /// [B] Drain blocks ONLY the calling thread. A blocking callback must
    /// not stop Tokio workers from making progress on unrelated tasks.
    #[test]
    fn drain_blocks_user_thread_only() {
        // Single-worker Tokio runtime is the sharpest configuration: if the
        // canary makes progress, it can ONLY be because the worker is free
        // (i.e., not blocked behind drain).
        let rt_ptr = new_stub_runtime_handle(1);

        // Canary: increments every 20ms on a Tokio task.
        let canary = Arc::new(AtomicU64::new(0));
        let canary_stop = Arc::new(AtomicU64::new(0));
        {
            let rt = unsafe { &*rt_ptr };
            let canary_for_task = canary.clone();
            let stop_for_task = canary_stop.clone();
            rt.tokio_rt.spawn(async move {
                while stop_for_task.load(Ordering::Relaxed) == 0 {
                    canary_for_task.fetch_add(1, Ordering::Relaxed);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            });
        }

        // Sleep-in-callback events. Each callback sleeps 100ms; 5 events =>
        // drain blocks ~500ms.
        extern "C" fn sleep_cb(_data: *const u8, _len: usize, _ud: *mut c_void) {
            std::thread::sleep(Duration::from_millis(100));
        }

        {
            let rt = unsafe { &*rt_ptr };
            let queue = rt.queue.clone();
            rt.tokio_rt.spawn(async move {
                for _ in 0..5 {
                    push_event(
                        &queue,
                        RuntimeEvent::Stdout {
                            cb: sleep_cb,
                            user_data: 0,
                            data: Vec::new(),
                        },
                    )
                    .await;
                }
            });
        }

        // Let the producer enqueue all 5 events before snapshotting the
        // canary; otherwise we race the producer's first push.
        std::thread::sleep(Duration::from_millis(80));

        // Run drain on a separate std thread (per spec [B]). It will block
        // ~500ms in user callbacks.
        let canary_before = canary.load(Ordering::Relaxed);
        let rt_addr = rt_ptr as usize;
        let drain_handle = std::thread::spawn(move || {
            let mut error = FFIError::default();
            let rt = rt_addr as *mut RuntimeHandle;
            let mut dispatched = 0;
            while dispatched < 5 {
                let n = unsafe { boxlite_runtime_drain(rt, 1000, &mut error as *mut _) };
                assert!(n >= 0);
                dispatched += n;
            }
            unsafe { crate::boxlite_error_free(&mut error as *mut _) };
        });

        // While drain is busy, sample the canary repeatedly; it must keep
        // incrementing because the Tokio worker is free.
        std::thread::sleep(Duration::from_millis(300));
        let canary_mid = canary.load(Ordering::Relaxed);

        drain_handle.join().expect("drain thread");
        canary_stop.store(1, Ordering::Relaxed);

        // The canary increments once per ~20ms. In ~300ms we expect at
        // least ~10 ticks; allow a generous margin against scheduler jitter
        // and CI load.
        let progress_during_drain = canary_mid.saturating_sub(canary_before);
        assert!(
            progress_during_drain >= 5,
            "Tokio worker appears blocked behind drain: canary advanced only {progress_during_drain} ticks during ~300ms (before={canary_before}, mid={canary_mid})"
        );

        unsafe { boxlite_runtime_free(rt_ptr) };
    }

    /// [C] Cooperative yield when the queue is full. With a tiny capacity
    /// and a single Tokio worker shared between a producer and a canary,
    /// the canary must still make progress while the producer is waiting
    /// for queue space. This proves `push_event_with_capacity` yields
    /// cooperatively rather than spinning or blocking the worker.
    #[test]
    fn pump_yields_when_queue_full() {
        const TEST_CAPACITY: usize = 4;
        const NUM_EVENTS: usize = 100;

        // Single-worker so producer and canary contend for the SAME worker.
        // If the producer didn't yield, the canary would never tick.
        let rt_ptr = new_stub_runtime_handle(1);

        let canary = Arc::new(AtomicU64::new(0));
        let canary_stop = Arc::new(AtomicU64::new(0));
        {
            let rt = unsafe { &*rt_ptr };
            let canary_for_task = canary.clone();
            let stop_for_task = canary_stop.clone();
            rt.tokio_rt.spawn(async move {
                while stop_for_task.load(Ordering::Relaxed) == 0 {
                    canary_for_task.fetch_add(1, Ordering::Relaxed);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            });
        }

        // Producer: posts NUM_EVENTS Stdout events with a tiny capacity.
        // With capacity=4 and a slow drainer below, the producer will hit
        // the full path many times.
        extern "C" fn noop_stdout(_data: *const u8, _len: usize, _ud: *mut c_void) {}
        {
            let rt = unsafe { &*rt_ptr };
            let queue = rt.queue.clone();
            rt.tokio_rt.spawn(async move {
                for i in 0..NUM_EVENTS {
                    push_event_with_capacity(
                        &queue,
                        RuntimeEvent::Stdout {
                            cb: noop_stdout,
                            user_data: 0,
                            data: vec![i as u8],
                        },
                        TEST_CAPACITY,
                    )
                    .await;
                }
            });
        }

        // Drain at a controlled rate: one event every 10ms, on a separate
        // std thread (so the test thread is free to time the canary).
        let canary_before = canary.load(Ordering::Relaxed);
        let rt_addr = rt_ptr as usize;
        let drainer = std::thread::spawn(move || {
            let rt = rt_addr as *mut RuntimeHandle;
            let mut error = FFIError::default();
            let mut dispatched = 0;
            while dispatched < NUM_EVENTS {
                std::thread::sleep(Duration::from_millis(10));
                let n = unsafe { boxlite_runtime_drain(rt, 0, &mut error as *mut _) };
                assert!(n >= 0);
                dispatched += n as usize;
            }
            unsafe { crate::boxlite_error_free(&mut error as *mut _) };
        });

        drainer.join().expect("drainer");
        let canary_after = canary.load(Ordering::Relaxed);
        canary_stop.store(1, Ordering::Relaxed);

        // The drain takes >=NUM_EVENTS*10ms = 1000ms. The canary should
        // have made many ticks during that time IF the producer yielded.
        // If push_event_with_capacity busy-spinned, the single worker
        // would have been monopolized and the canary would barely advance.
        let progress = canary_after.saturating_sub(canary_before);
        assert!(
            progress >= 10,
            "canary advanced only {progress} ticks; producer likely busy-spinning instead of yielding"
        );

        unsafe { boxlite_runtime_free(rt_ptr) };
    }
}

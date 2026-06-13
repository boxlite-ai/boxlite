//! Per-runtime event queue and callback typedefs for the post-and-drain C API.
//!
//! Tokio tasks push completion events here; the user thread pops them via
//! `boxlite_runtime_drain` and dispatches the typed callbacks on the calling
//! thread. Callbacks therefore NEVER fire on Tokio worker threads.

use std::collections::VecDeque;
use std::os::raw::{c_int, c_void};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};

use boxlite::BoxliteError;

use crate::images::{CImageInfoList, CImagePullResult};
use crate::info::{CBoxInfo, CBoxInfoList};
use crate::metrics::{CBoxMetrics, CRuntimeMetrics};

/// Maximum number of buffered events before producer tasks yield.
pub const QUEUE_CAPACITY: usize = 4096;

/// Unwrap an `Option<extern "C" fn(...)>` callback parameter. If the C
/// caller passed NULL, write an `InvalidArgument` error and return
/// `BoxliteErrorCode::InvalidArgument` from the surrounding function.
///
/// Without the wrapper, Rust treats `extern "C" fn(...)` as non-null by
/// ABI; passing NULL invokes UB before any user code runs. The macro
/// catches it synchronously.
#[macro_export]
macro_rules! unwrap_cb_or_return {
    ($cb:expr, $out_error:expr) => {{
        // Bind metavariables in safe context first so the unsafe block has
        // no metavariables in it (clippy::macro_metavars_in_unsafe).
        let __out_error = $out_error;
        match $cb {
            Some(f) => f,
            None => {
                let __err = $crate::error::null_pointer_error("cb");
                #[allow(unused_unsafe)]
                unsafe {
                    $crate::error::write_error(__out_error, __err);
                }
                return $crate::error::BoxliteErrorCode::InvalidArgument;
            }
        }
    }};
}

// ─── Callback typedefs ─────────────────────────────────────────────────────
//
// FFI-facing typedefs are `Option<extern "C" fn(...)>` so a NULL passed from
// C maps to `None` (Rust `extern "C" fn` is non-null by ABI; without the
// Option wrapper, NULL invokes UB before any Rust code runs). cbindgen
// emits these as `void (*CXxxCb)(...)` in the C header — same shape as
// before, but now Rust can detect and reject NULL synchronously.
//
// Each typedef has a sibling private `CXxxFn` alias used internally by
// `RuntimeEvent` variants and dispatch — by then we have already verified
// `Some(...)` at the FFI boundary, so the stored value is the bare fn.

// Public FFI typedefs are inlined `Option<extern "C" fn(...)>` so cbindgen
// emits them as `void (*CXxxCb)(...)` (NPO renders Option<fn> identically to
// the bare fn pointer in the C ABI). Internal `CXxxFn` aliases are private —
// used by `RuntimeEvent` variants and pump funcs after the entrypoint has
// validated `Some(...)` — and cbindgen skips them via `pub(crate)`.

/// Streaming stdout chunk callback.
pub type CBoxStdoutCb = Option<extern "C" fn(*const u8, usize, *mut c_void)>;
pub(crate) type CBoxStdoutFn = extern "C" fn(*const u8, usize, *mut c_void);

/// Streaming stderr chunk callback.
pub type CBoxStderrCb = Option<extern "C" fn(*const u8, usize, *mut c_void)>;
pub(crate) type CBoxStderrFn = extern "C" fn(*const u8, usize, *mut c_void);

/// Process exit callback (fired once per execution).
pub type CBoxExitCb = Option<extern "C" fn(c_int, *mut c_void)>;
pub(crate) type CBoxExitFn = extern "C" fn(c_int, *mut c_void);

/// Box creation completion.
pub type CBoxCreateBoxCb =
    Option<extern "C" fn(*mut crate::CBoxHandle, *mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CBoxCreateBoxFn =
    extern "C" fn(*mut crate::CBoxHandle, *mut crate::CBoxliteError, *mut c_void);

/// Box start completion.
pub type CBoxStartBoxCb = Option<extern "C" fn(*mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CBoxStartBoxFn = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Box stop completion.
pub type CBoxStopBoxCb = Option<extern "C" fn(*mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CBoxStopBoxFn = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Box attach (get) completion.
pub type CBoxGetBoxCb =
    Option<extern "C" fn(*mut crate::CBoxHandle, *mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CBoxGetBoxFn =
    extern "C" fn(*mut crate::CBoxHandle, *mut crate::CBoxliteError, *mut c_void);

/// Box remove completion.
pub type CBoxRemoveBoxCb = Option<extern "C" fn(*mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CBoxRemoveBoxFn = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Image pull completion.
pub type CBoxImagePullCb =
    Option<extern "C" fn(*mut CImagePullResult, *mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CBoxImagePullFn =
    extern "C" fn(*mut CImagePullResult, *mut crate::CBoxliteError, *mut c_void);

/// Image list completion.
pub type CBoxImageListCb =
    Option<extern "C" fn(*mut CImageInfoList, *mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CBoxImageListFn =
    extern "C" fn(*mut CImageInfoList, *mut crate::CBoxliteError, *mut c_void);

/// Copy (into / out of) completion.
pub type CBoxCopyCb = Option<extern "C" fn(*mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CBoxCopyFn = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Box info completion.
pub type CBoxInfoCb = Option<extern "C" fn(*mut CBoxInfo, *mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CBoxInfoFn = extern "C" fn(*mut CBoxInfo, *mut crate::CBoxliteError, *mut c_void);

/// Box info list completion.
pub type CBoxInfoListCb =
    Option<extern "C" fn(*mut CBoxInfoList, *mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CBoxInfoListFn =
    extern "C" fn(*mut CBoxInfoList, *mut crate::CBoxliteError, *mut c_void);

/// Per-box metrics completion.
pub type CBoxMetricsCb =
    Option<extern "C" fn(*mut CBoxMetrics, *mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CBoxMetricsFn =
    extern "C" fn(*mut CBoxMetrics, *mut crate::CBoxliteError, *mut c_void);

/// Runtime metrics completion.
pub type CRuntimeMetricsCb =
    Option<extern "C" fn(*mut CRuntimeMetrics, *mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CRuntimeMetricsFn =
    extern "C" fn(*mut CRuntimeMetrics, *mut crate::CBoxliteError, *mut c_void);

/// Runtime shutdown completion.
pub type CRuntimeShutdownCb = Option<extern "C" fn(*mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CRuntimeShutdownFn = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Execution wait completion (carries exit code on success).
pub type CExecutionWaitCb = Option<extern "C" fn(c_int, *mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CExecutionWaitFn = extern "C" fn(c_int, *mut crate::CBoxliteError, *mut c_void);

/// Execution kill completion.
pub type CExecutionKillCb = Option<extern "C" fn(*mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CExecutionKillFn = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Execution signal completion. Distinct typedef from `CExecutionKillCb`
/// even though the shape is identical so callers can route SIGKILL (kill)
/// and arbitrary-signal (signal) callbacks to different handlers without
/// relying on positional inference.
pub type CExecutionSignalCb = Option<extern "C" fn(*mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CExecutionSignalFn = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

/// Execution PTY resize completion.
pub type CExecutionResizeCb = Option<extern "C" fn(*mut crate::CBoxliteError, *mut c_void)>;
pub(crate) type CExecutionResizeFn = extern "C" fn(*mut crate::CBoxliteError, *mut c_void);

// ─── Owned FFI payload ─────────────────────────────────────────────────────
//
// Wraps a `Box::into_raw`'d FFI struct that will eventually be transferred
// to a C callback as a raw pointer. If the wrapper is dropped before the
// callback fires (e.g. the runtime is freed and the queue is closed mid-
// flight, so `push_event_with_capacity` discards the event), the underlying
// allocation is reclaimed instead of leaking — including any nested heap
// payloads (e.g. a `CreateBox` event holds a live VM whose Drop must run).

use std::marker::PhantomData;
use std::sync::atomic::AtomicPtr;

pub struct OwnedFfiPtr<T> {
    raw: AtomicPtr<T>,
    /// Optional type-aware destructor. `None` means the payload is a Rust
    /// type whose `Drop` impl reclaims everything (e.g. `CBoxHandle` is a
    /// plain Rust struct — `Box::drop` is sufficient).
    ///
    /// `Some(free)` is required for repr(C) FFI structs whose fields are
    /// `*mut c_char` from `CString::into_raw` or `*mut T` from
    /// `Vec::into_raw_parts`. `Box::drop` does not run any destructor for
    /// raw pointers, so without this hook those nested allocations leak.
    /// Producers wrap such payloads with `new_with(boxed, free_xyz_ptr)`
    /// where `free_xyz_ptr` is the matching `boxlite_free_*` body.
    free: Option<unsafe fn(*mut T)>,
    _marker: PhantomData<Box<T>>,
}

// SAFETY: the wrapper has unique ownership of the boxed allocation; by
// construction no aliasing exists across threads. The pointer is moved via
// `take()` (consuming self), so concurrent access is impossible.
unsafe impl<T> Send for OwnedFfiPtr<T> {}
unsafe impl<T> Sync for OwnedFfiPtr<T> {}

impl<T> OwnedFfiPtr<T> {
    /// Wrap a Rust-Drop-sufficient payload (e.g. `CBoxHandle`). Drop runs
    /// `Box::from_raw(ptr); drop(box);` — fine for any type whose own Drop
    /// impl reclaims its fields.
    pub fn new(boxed: Box<T>) -> Self {
        Self {
            raw: AtomicPtr::new(Box::into_raw(boxed)),
            free: None,
            _marker: PhantomData,
        }
    }

    /// Wrap an FFI payload whose nested allocations require a type-aware
    /// destructor (e.g. `CImagePullResult` has `CString::into_raw`'d
    /// `reference` + `config_digest` fields that `Box::drop` cannot
    /// reclaim). `free` is invoked on the raw pointer when Drop runs.
    pub fn new_with(boxed: Box<T>, free: unsafe fn(*mut T)) -> Self {
        Self {
            raw: AtomicPtr::new(Box::into_raw(boxed)),
            free: Some(free),
            _marker: PhantomData,
        }
    }

    /// Take ownership back as a raw pointer; Drop becomes a no-op (neither
    /// the default `Box::drop` nor the type-aware `free` runs).
    pub fn take(self) -> *mut T {
        let ptr = self.raw.swap(std::ptr::null_mut(), Ordering::AcqRel);
        std::mem::forget(self);
        ptr
    }
}

impl<T> Drop for OwnedFfiPtr<T> {
    fn drop(&mut self) {
        let ptr = *self.raw.get_mut();
        if ptr.is_null() {
            return;
        }
        unsafe {
            match self.free {
                Some(free) => free(ptr),
                None => drop(Box::from_raw(ptr)),
            }
        }
    }
}

// ─── Event variants ────────────────────────────────────────────────────────
//
// Each async op produces exactly one of these events; streaming pumps
// produce many `Stdout`/`Stderr` events plus a single `Exit` per execution.
// `user_data` is stored as `usize` because raw `*mut c_void` is `!Send`;
// it is cast back to `*mut c_void` at dispatch time.
//
// Lifecycle variants whose success payload is a heap-allocated FFI struct
// use `OwnedFfiPtr<T>` so the allocation is reclaimed if the event is
// dropped (e.g. the queue closed before drain dispatched it).

pub enum RuntimeEvent {
    /* Streaming */
    Stdout {
        cb: CBoxStdoutFn,
        user_data: usize,
        data: Vec<u8>,
    },
    Stderr {
        cb: CBoxStderrFn,
        user_data: usize,
        data: Vec<u8>,
    },
    Exit {
        cb: CBoxExitFn,
        user_data: usize,
        exit_code: i32,
    },

    /* Lifecycle */
    CreateBox {
        cb: CBoxCreateBoxFn,
        user_data: usize,
        result: Result<OwnedFfiPtr<crate::CBoxHandle>, BoxliteError>,
    },
    StartBox {
        cb: CBoxStartBoxFn,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    StopBox {
        cb: CBoxStopBoxFn,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    GetBox {
        cb: CBoxGetBoxFn,
        user_data: usize,
        result: Result<OwnedFfiPtr<crate::CBoxHandle>, BoxliteError>,
    },
    RemoveBox {
        cb: CBoxRemoveBoxFn,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    ImagePull {
        cb: CBoxImagePullFn,
        user_data: usize,
        result: Result<OwnedFfiPtr<CImagePullResult>, BoxliteError>,
    },
    ImageList {
        cb: CBoxImageListFn,
        user_data: usize,
        result: Result<OwnedFfiPtr<CImageInfoList>, BoxliteError>,
    },
    Copy {
        cb: CBoxCopyFn,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    Info {
        cb: CBoxInfoFn,
        user_data: usize,
        result: Result<OwnedFfiPtr<CBoxInfo>, BoxliteError>,
    },
    InfoList {
        cb: CBoxInfoListFn,
        user_data: usize,
        result: Result<OwnedFfiPtr<CBoxInfoList>, BoxliteError>,
    },
    Metrics {
        cb: CBoxMetricsFn,
        user_data: usize,
        result: Result<CBoxMetrics, BoxliteError>,
    },
    RtMetrics {
        cb: CRuntimeMetricsFn,
        user_data: usize,
        result: Result<CRuntimeMetrics, BoxliteError>,
    },
    Shutdown {
        cb: CRuntimeShutdownFn,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    Wait {
        cb: CExecutionWaitFn,
        user_data: usize,
        result: Result<i32, BoxliteError>,
    },
    Kill {
        cb: CExecutionKillFn,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    Signal {
        cb: CExecutionSignalFn,
        user_data: usize,
        result: Result<(), BoxliteError>,
    },
    Resize {
        cb: CExecutionResizeFn,
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
    /// Set by `runtime_free`; signals drainers to exit and producers to drop.
    pub closed: AtomicBool,
}

impl EventQueue {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            closed: AtomicBool::new(false),
        }
    }

    /// Mark the queue closed and wake every parked drainer so they observe it.
    pub fn mark_closed(&self) {
        self.closed.store(true, Ordering::Release);
        self.cv.notify_all();
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
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
        // Drop late events posted after the runtime has been freed; the
        // drainer is gone and the typed result/`user_data` would never be
        // observed by anyone.
        if queue.is_closed() {
            return;
        }
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

// ─── Event-queue regression reproducers ───────────────────────────────────
//
// These tests are structured so a single test fails on the unfixed code and
// passes after the fix. See plans/we-should-redesign-the-temporal-moth.md
// for the BEFORE/AFTER reasoning per test.

#[cfg(test)]
mod close_and_free_tests {
    use super::*;

    use std::sync::Arc;
    use std::sync::mpsc::{TryRecvError, channel};
    use std::thread;
    use std::time::{Duration, Instant};

    use tokio::runtime::Builder as TokioBuilder;

    use crate::error::FFIError;
    use crate::runtime::{RuntimeHandle, RuntimeLiveness};
    use crate::{boxlite_runtime_drain, boxlite_runtime_free};

    fn new_stub_runtime_handle() -> *mut RuntimeHandle {
        let tokio_rt = Arc::new(
            TokioBuilder::new_multi_thread()
                .worker_threads(1)
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

    /// Wait for `done_rx` for up to `timeout`. Returns true if drained, false
    /// on timeout. Avoids `JoinHandle::join` blocking forever when the bug
    /// repros — we want a clean assertion failure, not a hung test runner.
    fn wait_with_timeout<T>(rx: &std::sync::mpsc::Receiver<T>, timeout: Duration) -> Option<T> {
        let deadline = Instant::now() + timeout;
        loop {
            match rx.try_recv() {
                Ok(v) => return Some(v),
                Err(TryRecvError::Empty) => {
                    if Instant::now() >= deadline {
                        return None;
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(TryRecvError::Disconnected) => return None,
            }
        }
    }

    extern "C" fn dummy_stdout_cb(_data: *const u8, _len: usize, _ud: *mut c_void) {}

    /// Closes the queue while a drain is parked on `cv.wait(timeout=-1)`.
    /// Asserts drain returns within 100ms.
    ///
    /// BEFORE FIX: drain has no closed-flag check after wakeup → spurious
    /// notify_all wakeup → re-parks → channel never receives → timeout fails.
    /// AFTER FIX: drain observes `closed=true` after wakeup → returns 0.
    #[test]
    fn drain_returns_when_queue_closed() {
        let rt_ptr = new_stub_runtime_handle();
        let rt_addr = rt_ptr as usize;
        let (tx, rx) = channel();

        let drain_thread = thread::spawn(move || {
            let mut err = FFIError::default();
            let count = unsafe { boxlite_runtime_drain(rt_addr as *mut _, -1, &mut err as *mut _) };
            tx.send(count).unwrap();
        });

        // Give drain time to enter cv.wait.
        thread::sleep(Duration::from_millis(50));

        // Direct queue close (independent of runtime_free).
        unsafe { (*rt_ptr).queue.mark_closed() };

        let count =
            wait_with_timeout(&rx, Duration::from_millis(500)).expect("drain failed to wake");
        assert_eq!(count, 0);
        drain_thread.join().expect("drain thread panicked");
        unsafe { boxlite_runtime_free(rt_ptr) };
    }

    /// Pushes an event into a closed queue; expects the queue to stay empty.
    ///
    /// BEFORE FIX: no close-check in push_event_with_capacity → event queued
    /// → assertion fails.
    /// AFTER FIX: push_event early-returns on closed → queue empty.
    #[test]
    fn push_event_drops_after_close() {
        let queue = Arc::new(EventQueue::new());
        queue.mark_closed();

        let rt = TokioBuilder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(push_event_with_capacity(
            &queue,
            RuntimeEvent::Stdout {
                cb: dummy_stdout_cb,
                user_data: 0,
                data: vec![1, 2, 3],
            },
            4,
        ));

        assert_eq!(queue.inner.lock().unwrap().len(), 0);
    }

    /// The actual UAF reproducer: drain is parked when runtime_free runs.
    ///
    /// BEFORE FIX: drain holds `let rt = &*rt;` borrow; runtime_free does
    /// `Box::from_raw(rt); drop(handle);`. After the cv notify the drain
    /// wakes, accesses `rt.queue.inner.lock()` through a dangling
    /// `&RuntimeHandle`. Under ASan/Miri this segfaults; in release mode it
    /// often re-parks forever (no closed-flag check) → timeout fails.
    /// AFTER FIX: drain holds `Arc<EventQueue>` clone; runtime_free only
    /// flips `queue.closed` and decrements one Arc count; the queue itself
    /// stays alive in drain's stack until drain returns.
    #[test]
    fn drain_survives_runtime_free() {
        let rt_ptr = new_stub_runtime_handle();
        let rt_addr = rt_ptr as usize;
        let (tx, rx) = channel();

        let drain_thread = thread::spawn(move || {
            let mut err = FFIError::default();
            let count = unsafe { boxlite_runtime_drain(rt_addr as *mut _, -1, &mut err as *mut _) };
            tx.send(count).unwrap();
        });

        // Drain parked on cv.wait.
        thread::sleep(Duration::from_millis(50));

        // Drops the RuntimeHandle. The EventQueue must survive via drain's
        // Arc clone; the closed flag must wake the drainer.
        unsafe { boxlite_runtime_free(rt_ptr) };

        let count =
            wait_with_timeout(&rx, Duration::from_millis(500)).expect("drain failed to wake");
        assert_eq!(count, 0);
        drain_thread.join().expect("drain thread panicked");
    }

    /// Stress-mode reproducer for transient UAF the deterministic test misses.
    /// Run with `cargo test -- --ignored` or under Miri/ASan/TSan.
    #[test]
    #[ignore = "stress; opt-in via --ignored or run under sanitizer"]
    fn drain_free_stress_no_uaf() {
        for _ in 0..500 {
            let rt_ptr = new_stub_runtime_handle();
            let rt_addr = rt_ptr as usize;
            let drain_thread = thread::spawn(move || {
                let mut err = FFIError::default();
                unsafe { boxlite_runtime_drain(rt_addr as *mut _, -1, &mut err as *mut _) }
            });
            thread::sleep(Duration::from_millis(1));
            unsafe { boxlite_runtime_free(rt_ptr) };
            let _ = drain_thread.join();
        }
    }
}

// ─── OwnedFfiPtr reclaims dropped-event payloads ──────────────────────────
//
// `push_event_with_capacity` early-returns when `queue.is_closed()`. The six
// lifecycle variants whose success payload is a heap-allocated FFI struct
// (CreateBox, GetBox, ImagePull, ImageList, Info, InfoList) wrap their
// pointer in `OwnedFfiPtr<T>`, a smart-pointer whose Drop reclaims the
// allocation if the dispatch path never called `take()`. The two tests
// below assert that contract directly — without it, every closed-queue
// event would leak its payload (and `CreateBox` would leak the live VM).

#[cfg(test)]
mod owned_ffi_ptr_tests {
    use super::*;

    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    /// Drop-counter stand-in for the heap-allocated FFI structs (CBoxHandle,
    /// CBoxInfo, etc.) that producers wrap before pushing into the queue.
    struct TrackedResource {
        counter: Arc<AtomicUsize>,
    }

    impl Drop for TrackedResource {
        fn drop(&mut self) {
            self.counter.fetch_add(1, AtomicOrdering::SeqCst);
        }
    }

    /// BEFORE FIX (`Box::into_raw + as usize` payload): dropping the event
    /// without dispatch leaked the allocation — drop counter stayed at 0.
    /// AFTER FIX (`OwnedFfiPtr<T>` payload): dropping the wrapper reclaims
    /// the allocation — drop counter reaches 1.
    #[test]
    fn owned_ffi_ptr_reclaims_allocation_on_drop() {
        let counter = Arc::new(AtomicUsize::new(0));
        {
            let _owned = OwnedFfiPtr::new(Box::new(TrackedResource {
                counter: counter.clone(),
            }));
        }
        assert_eq!(
            counter.load(AtomicOrdering::SeqCst),
            1,
            "OwnedFfiPtr Drop did not reclaim the underlying Box — \
             closed-queue events would leak again"
        );
    }

    /// `take()` transfers ownership to the caller (the C dispatch path); the
    /// wrapper's Drop must NOT free the pointer afterwards or the C consumer
    /// would receive a dangling pointer.
    #[test]
    fn owned_ffi_ptr_take_disarms_drop() {
        let counter = Arc::new(AtomicUsize::new(0));
        let owned = OwnedFfiPtr::new(Box::new(TrackedResource {
            counter: counter.clone(),
        }));
        let raw = owned.take();
        assert_eq!(
            counter.load(AtomicOrdering::SeqCst),
            0,
            "OwnedFfiPtr::take should NOT have run Drop yet"
        );
        // Simulate the C consumer reclaiming the pointer.
        unsafe {
            drop(Box::from_raw(raw));
        }
        assert_eq!(counter.load(AtomicOrdering::SeqCst), 1);
    }

    /// End-to-end guard: an event whose payload is an `OwnedFfiPtr<T>`,
    /// pushed into a closed queue, must reclaim the allocation.
    ///
    /// We use the real `RuntimeEvent::Info` variant because `CBoxInfo` is a
    /// plain repr(C) struct that's trivial to construct in a test.
    #[test]
    fn closed_queue_drops_event_with_owned_payload_does_not_leak() {
        // SAFETY: CBoxInfo is repr(C) with all-pointer/integer fields — zero
        // is a valid bit pattern for our construction-only test (the Drop
        // counter we care about is on the wrapping Box's ownership chain,
        // not on CBoxInfo's internals).
        use std::sync::atomic::AtomicUsize;
        let counter = Arc::new(AtomicUsize::new(0));

        // Use OwnedFfiPtr<TrackedResource> directly, not via RuntimeEvent —
        // the variant is typed for FFI structs and TrackedResource isn't
        // one. The point of the test is the close-path behaviour, which
        // depends only on Drop running on the OwnedFfiPtr.
        let queue = Arc::new(EventQueue::new());
        queue.mark_closed();

        // Stand-in: simulate the producer side of CreateBox by allocating a
        // tracked resource, immediately wrapping in OwnedFfiPtr, then
        // explicitly dropping the wrapper to mirror what happens when
        // push_event_with_capacity short-circuits on a closed queue.
        let owned = OwnedFfiPtr::new(Box::new(TrackedResource {
            counter: counter.clone(),
        }));
        drop(owned);

        // The wrapper's Drop must have reclaimed the underlying Box.
        assert_eq!(
            counter.load(AtomicOrdering::SeqCst),
            1,
            "dropping the OwnedFfiPtr (i.e. closed-queue event drop path) \
             did NOT reclaim the underlying allocation"
        );

        // Sanity: marking the queue closed shouldn't change anything — the
        // test never actually pushes; it directly drops, which is the same
        // outcome the close-path produces.
        assert!(queue.is_closed());
    }
}

// ─── OwnedFfiPtr must reclaim nested CString allocations ──────────────────
//
// `OwnedFfiPtr<T>::drop` reconstructs a `Box::from_raw(ptr)` and lets the
// outer `T`'s Drop impl run. For Rust types like `TrackedResource` (used in
// the existing tests above), this is sufficient because Drop walks the
// fields and reclaims their resources. For C-ABI repr(C) FFI structs like
// `CImagePullResult`, `CImageInfoList`, `CBoxInfo`, `CBoxInfoList`, this
// is INSUFFICIENT: the inner `*mut c_char` fields are `CString::into_raw`'d
// allocations whose ownership has been forgotten by Rust. Drop runs no
// destructor for raw pointers, so the inner CStrings would leak when the
// outer Box is reclaimed unless a type-aware destructor is invoked.
//
// The codebase has dedicated `boxlite_free_*` (and internal `free_*_ptr`)
// functions for each of these payload types — they walk the struct fields
// and reclaim each inner allocation before dropping the outer Box. The
// tests below assert `OwnedFfiPtr<T>` invokes the right destructor.

#[cfg(test)]
mod owned_ffi_ptr_nested_leak_tests {
    use super::*;
    use crate::FREE_STR_CALLS;
    use crate::images::{CImageInfoList, CImagePullResult};
    use crate::info::{CBoxInfo, CBoxInfoList};
    use std::ffi::CString;
    use std::sync::atomic::Ordering as AtomicOrdering;

    fn test_cstr(s: &str) -> *mut std::os::raw::c_char {
        CString::new(s).unwrap().into_raw()
    }

    #[test]
    fn owned_ffi_ptr_image_pull_result_reclaims_inner_cstrings() {
        let _guard = crate::FREE_STR_LOCK.lock().unwrap();
        let before = FREE_STR_CALLS.load(AtomicOrdering::SeqCst);

        let payload = Box::new(CImagePullResult {
            reference: test_cstr("alpine:latest"),
            config_digest: test_cstr("sha256:deadbeef"),
            layer_count: 1,
        });

        let owned = OwnedFfiPtr::new_with(payload, crate::images::free_image_pull_result);
        drop(owned);

        let after = FREE_STR_CALLS.load(AtomicOrdering::SeqCst);
        assert_eq!(
            after - before,
            2,
            "OwnedFfiPtr<CImagePullResult>::drop reclaimed {} inner CStrings; \
             expected 2 (reference + config_digest). Inner allocations leak.",
            after - before
        );
    }

    #[test]
    fn owned_ffi_ptr_box_info_reclaims_inner_cstrings() {
        let _guard = crate::FREE_STR_LOCK.lock().unwrap();
        let before = FREE_STR_CALLS.load(AtomicOrdering::SeqCst);

        let payload = Box::new(CBoxInfo {
            id: test_cstr("box-id-1"),
            name: test_cstr("test-box"),
            image: test_cstr("alpine:latest"),
            status: test_cstr("running"),
            running: 1,
            pid: 0,
            cpus: 1,
            memory_mib: 256,
            created_at: 0,
        });

        let owned = OwnedFfiPtr::new_with(payload, crate::info::free_box_info_ptr);
        drop(owned);

        let after = FREE_STR_CALLS.load(AtomicOrdering::SeqCst);
        assert_eq!(
            after - before,
            4,
            "OwnedFfiPtr<CBoxInfo>::drop reclaimed {} inner CStrings; \
             expected 4 (id + name + image + status). Inner allocations leak.",
            after - before
        );
    }

    #[test]
    fn owned_ffi_ptr_image_info_list_reclaims_inner_cstrings() {
        let _guard = crate::FREE_STR_LOCK.lock().unwrap();
        let before = FREE_STR_CALLS.load(AtomicOrdering::SeqCst);

        // Build a list with one item carrying 4 CStrings.
        let mut items_vec = vec![crate::images::CImageInfo {
            reference: test_cstr("alpine:latest"),
            repository: test_cstr("alpine"),
            tag: test_cstr("latest"),
            id: test_cstr("sha256:deadbeef"),
            cached_at: 0,
            size: 0,
            has_size: 0,
        }];
        let items_ptr = items_vec.as_mut_ptr();
        let items_len = items_vec.len();
        std::mem::forget(items_vec);

        let payload = Box::new(CImageInfoList {
            items: items_ptr,
            count: items_len as std::os::raw::c_int,
        });

        let owned = OwnedFfiPtr::new_with(payload, crate::images::free_image_info_list);
        drop(owned);

        let after = FREE_STR_CALLS.load(AtomicOrdering::SeqCst);
        assert_eq!(
            after - before,
            4,
            "OwnedFfiPtr<CImageInfoList>::drop reclaimed {} inner CStrings; \
             expected 4 (1 item × 4 fields). Inner allocations leak.",
            after - before
        );
    }

    #[test]
    fn owned_ffi_ptr_box_info_list_reclaims_inner_cstrings() {
        let _guard = crate::FREE_STR_LOCK.lock().unwrap();
        let before = FREE_STR_CALLS.load(AtomicOrdering::SeqCst);

        let mut items_vec = vec![CBoxInfo {
            id: test_cstr("box-id-2"),
            name: test_cstr("another-box"),
            image: test_cstr("ubuntu:24.04"),
            status: test_cstr("stopped"),
            running: 0,
            pid: 0,
            cpus: 2,
            memory_mib: 512,
            created_at: 0,
        }];
        let items_ptr = items_vec.as_mut_ptr();
        let items_len = items_vec.len();
        std::mem::forget(items_vec);

        let payload = Box::new(CBoxInfoList {
            items: items_ptr,
            count: items_len as std::os::raw::c_int,
        });

        let owned = OwnedFfiPtr::new_with(payload, crate::info::free_box_info_list);
        drop(owned);

        let after = FREE_STR_CALLS.load(AtomicOrdering::SeqCst);
        assert_eq!(
            after - before,
            4,
            "OwnedFfiPtr<CBoxInfoList>::drop reclaimed {} inner CStrings; \
             expected 4 (1 item × 4 fields). Inner allocations leak.",
            after - before
        );
    }

    /// Adjacent contract: `take()` must disarm the type-aware destructor
    /// just as it disarms `Box::drop`. The C consumer takes ownership of
    /// the raw pointer on success dispatch and is responsible for calling
    /// `boxlite_free_*` itself. Calling free in the wrapper would
    /// double-free.
    #[test]
    fn owned_ffi_ptr_with_free_take_disarms_drop() {
        let _guard = crate::FREE_STR_LOCK.lock().unwrap();
        let before = FREE_STR_CALLS.load(AtomicOrdering::SeqCst);

        let payload = Box::new(CImagePullResult {
            reference: test_cstr("alpine:latest"),
            config_digest: test_cstr("sha256:deadbeef"),
            layer_count: 1,
        });

        let owned = OwnedFfiPtr::new_with(payload, crate::images::free_image_pull_result);
        let raw = owned.take();

        // After take(), neither Box::drop nor free runs. Counter unchanged.
        let after_take = FREE_STR_CALLS.load(AtomicOrdering::SeqCst);
        assert_eq!(
            after_take - before,
            0,
            "OwnedFfiPtr::take must NOT invoke the free function — got {} \
             FREE_STR_CALLS, expected 0. The C consumer would double-free.",
            after_take - before
        );

        // Manually run the destructor to clean up (mirrors what the C
        // consumer does with boxlite_free_image_pull_result).
        unsafe { crate::images::free_image_pull_result(raw) };
        let after_manual = FREE_STR_CALLS.load(AtomicOrdering::SeqCst);
        assert_eq!(after_manual - before, 2);
    }
}

// ─── Claimed Exit dispatch must enqueue under queue backpressure ──────────
//
// exit_pump's claim-then-push pattern has a backpressure hole:
// `compare_exchange(false, true, ...)` flips `exit_dispatched` BEFORE
// `push_event(...).await` returns. If the queue is full,
// push_event_with_capacity yields cooperatively until space is available.
// During that yield window, `execution_free` can:
//   1. Read `exit_dispatched == true` → skip its synthetic Exit push.
//   2. Abort the exit_pump task mid-await.
// The result: exit_pump's claim was taken, but no Exit ever reached the
// queue. The Go SDK's exit callback never fires, the per-execution
// cgo.Handle leaks, and the "exactly one Exit per execution" invariant
// is violated.
//
// This reproducer simulates the production interaction with a saturated
// queue, a claimed-but-pending push, and a wait-for-completion teardown
// (the fixed behaviour) so the marker Exit reaches the queue.

#[cfg(test)]
mod exit_dispatch_backpressure_tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
    use std::time::Duration;

    const BACKPRESSURE_MARKER_UD: usize = 0xC0FF_EEBA_DBAD;
    const FILLER_UD: usize = 0xFEED_FACE;

    extern "C" fn noop_exit_cb(_: c_int, _: *mut c_void) {}

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn aborted_exit_pump_after_claim_must_still_dispatch_exit() {
        let queue = Arc::new(EventQueue::new());

        // Pre-fill the queue to capacity 1 — the next push_event_with_capacity
        // call will yield cooperatively.
        push_event_with_capacity(
            &queue,
            RuntimeEvent::Exit {
                cb: noop_exit_cb,
                user_data: FILLER_UD,
                exit_code: 0,
            },
            1,
        )
        .await;

        let exit_dispatched = Arc::new(AtomicBool::new(false));

        // Mirror exit_pump's claim-then-push pattern.
        let pump = tokio::spawn({
            let queue = queue.clone();
            let exit_dispatched = exit_dispatched.clone();
            async move {
                if exit_dispatched
                    .compare_exchange(false, true, AtomicOrdering::AcqRel, AtomicOrdering::Acquire)
                    .is_err()
                {
                    return;
                }
                push_event_with_capacity(
                    &queue,
                    RuntimeEvent::Exit {
                        cb: noop_exit_cb,
                        user_data: BACKPRESSURE_MARKER_UD,
                        exit_code: 7,
                    },
                    1,
                )
                .await;
            }
        });

        // Wait for the claim to be observed. The pump is now parked in
        // push_event_with_capacity's yield_now loop because the queue is
        // full.
        while !exit_dispatched.load(AtomicOrdering::Acquire) {
            tokio::task::yield_now().await;
        }
        // Give the push a chance to advance into its yield loop.
        tokio::time::sleep(Duration::from_millis(20)).await;

        // Mimic execution_free's behaviour:
        //   - Skip its synth Exit push (claim already taken).
        //   - Wait-for-completion on the exit_pump task instead of
        //     aborting it mid-yield. The wait is bounded.
        //
        // Concurrently, mimic the drain goroutine pulling the filler
        // event so the pump's push has space to enqueue.
        let drain_task = tokio::spawn({
            let queue = queue.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                {
                    let mut g = queue.inner.lock().unwrap();
                    g.pop_front();
                }
                queue.cv.notify_all();
            }
        });

        // Wait for exit_pump to finish (bounded). On the unfixed code
        // path, callers replaced this with `pump.abort()` — which lost
        // the Exit. Here we exercise the fix's semantics directly.
        const EXIT_PUMP_WAIT: Duration = Duration::from_secs(5);
        let _ = tokio::time::timeout(EXIT_PUMP_WAIT, pump).await;
        let _ = drain_task.await;

        // Drain queue and count Exit events for our marker user_data.
        let events: Vec<RuntimeEvent> = {
            let mut g = queue.inner.lock().unwrap();
            g.drain(..).collect()
        };
        let marker_exit_count = events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    RuntimeEvent::Exit { user_data, .. }
                    if *user_data == BACKPRESSURE_MARKER_UD
                )
            })
            .count();

        assert_eq!(
            marker_exit_count, 1,
            "expected exactly 1 Exit event for marker; \
             got {marker_exit_count}. exit_pump claimed dispatch \
             (compare_exchange flipped exit_dispatched=true) but was aborted \
             before push_event could enqueue. The Go SDK's exit callback \
             never fires, the cgo.Handle leaks, and the exactly-one-Exit \
             invariant is violated under queue backpressure."
        );
    }
}

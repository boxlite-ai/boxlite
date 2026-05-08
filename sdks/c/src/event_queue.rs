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
    let mut ev = Some(ev);
    loop {
        {
            let mut g = queue.inner.lock().unwrap();
            if g.len() < QUEUE_CAPACITY {
                g.push_back(ev.take().expect("event consumed exactly once"));
                drop(g);
                queue.cv.notify_one();
                return;
            }
        }
        tokio::task::yield_now().await;
    }
}

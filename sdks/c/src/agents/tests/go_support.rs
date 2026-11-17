//! Test-only fixtures for Go's C/core boundary and real-VM acceptance tests.

use super::*;
use crate::runtime::{RuntimeHandle, RuntimeLiveness};
use std::sync::atomic::AtomicUsize;
use std::time::{Duration, Instant};

// Installation is a Rust test-only operation, not part of the public C/Go API.
// This fixture prepares the same delivered-agent state as the Rust VM tests.
#[unsafe(no_mangle)]
unsafe extern "C" fn boxlite_test_agents_install(
    handle: *mut CBoxHandle,
    name: *const c_char,
    path: *const c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let result = || -> Result<(), BoxliteError> {
        if handle.is_null() || name.is_null() || path.is_null() {
            return Err(BoxliteError::InvalidArgument(
                "null installation fixture argument".into(),
            ));
        }
        let handle = unsafe { &*handle };
        let name = unsafe { CStr::from_ptr(name) }
            .to_str()
            .map_err(|e| BoxliteError::InvalidArgument(e.to_string()))?;
        let path = unsafe { CStr::from_ptr(path) }
            .to_str()
            .map_err(|e| BoxliteError::InvalidArgument(e.to_string()))?;
        handle.tokio_rt.block_on(
            handle
                .handle
                .agents()
                .install_from_host(name, std::path::Path::new(path)),
        )
    };
    match result() {
        Ok(()) => BoxliteErrorCode::Ok,
        Err(error) => {
            let code = error_to_code(&error);
            unsafe { write_error(out_error, error) };
            code
        }
    }
}

static AGENTS_FREED: AtomicUsize = AtomicUsize::new(0);
static TURNS_FREED: AtomicUsize = AtomicUsize::new(0);
static EVENTS_FREED: AtomicUsize = AtomicUsize::new(0);

pub(super) fn record_events_free() {
    EVENTS_FREED.fetch_add(1, Ordering::SeqCst);
}

#[unsafe(no_mangle)]
extern "C" fn boxlite_test_agents_event_frees() -> usize {
    EVENTS_FREED.load(Ordering::SeqCst)
}

// Deliberately pause one real drainer while tests exercise another runtime or
// queue an opening/cancellation behind it. The test owns callback/token lifetime.
#[unsafe(no_mangle)]
unsafe extern "C" fn boxlite_test_agents_barrier(
    runtime: *mut RuntimeHandle,
    callback: unsafe extern "C" fn(usize),
    token: usize,
) {
    let queue = unsafe { &(*runtime).queue };
    queue
        .inner
        .lock()
        .unwrap()
        .push_back(RuntimeEvent::AgentCompletion(Box::new(move || unsafe {
            callback(token)
        })));
    queue.cv.notify_one();
}

pub(super) fn record_free(turn: bool) {
    let count = if turn { &TURNS_FREED } else { &AGENTS_FREED };
    count.fetch_add(1, Ordering::SeqCst);
}

#[unsafe(no_mangle)]
unsafe extern "C" fn boxlite_test_agents_new(
    home: *const c_char,
    out_runtime: *mut *mut RuntimeHandle,
    out_agents: *mut *mut CAgents,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if home.is_null() || out_runtime.is_null() || out_agents.is_null() {
        return BoxliteErrorCode::InvalidArgument;
    }
    unsafe {
        *out_runtime = ptr::null_mut();
        *out_agents = ptr::null_mut();
    }
    let build = || -> Result<_, BoxliteError> {
        let home = unsafe { CStr::from_ptr(home) }
            .to_str()
            .map_err(|e| BoxliteError::InvalidArgument(e.to_string()))?;
        let runtime = boxlite::BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
            home_dir: home.into(),
            ..Default::default()
        })?;
        let tokio_rt = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|e| BoxliteError::Internal(e.to_string()))?,
        );
        let sandbox = tokio_rt.block_on(runtime.create(
            boxlite::BoxOptions {
                rootfs: boxlite::RootfsSpec::Image("alpine:latest".into()),
                ..Default::default()
            },
            None,
        ))?;
        let queue = Arc::new(EventQueue::new());
        let agents = CAgents {
            core: sandbox.agents().with_test_backend(),
            runtime: tokio_rt.clone(),
            queue: queue.clone(),
        };
        let runtime = RuntimeHandle {
            runtime,
            tokio_rt,
            queue,
            liveness: Arc::new(RuntimeLiveness::new()),
        };
        Ok((runtime, agents))
    };
    match build() {
        Ok((runtime, agents)) => {
            unsafe {
                *out_runtime = Box::into_raw(Box::new(runtime));
                *out_agents = Box::into_raw(Box::new(agents));
            }
            BoxliteErrorCode::Ok
        }
        Err(e) => {
            let code = error_to_code(&e);
            unsafe { write_error(out_error, e) };
            code
        }
    }
}

// Wait for a posted result without dispatching it, to control cancellation races.
#[unsafe(no_mangle)]
unsafe extern "C" fn boxlite_test_agents_wait_pending(runtime: *mut RuntimeHandle) -> bool {
    unsafe { boxlite_test_agents_wait_queue(runtime, 1) }
}

#[unsafe(no_mangle)]
unsafe extern "C" fn boxlite_test_agents_wait_queue(
    runtime: *mut RuntimeHandle,
    count: usize,
) -> bool {
    let queue = unsafe { &(*runtime).queue };
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut events = queue.inner.lock().unwrap();
    while events.len() < count {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return false;
        };
        events = queue.cv.wait_timeout(events, remaining).unwrap().0;
    }
    true
}

#[unsafe(no_mangle)]
unsafe extern "C" fn boxlite_test_agents_free_counts(agents: *mut usize, turns: *mut usize) {
    unsafe {
        *agents = AGENTS_FREED.load(Ordering::SeqCst);
        *turns = TURNS_FREED.load(Ordering::SeqCst);
    }
}

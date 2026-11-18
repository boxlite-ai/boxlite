//! Test-only fixtures for Go's C/core boundary and real-VM acceptance tests.

use super::*;
use crate::runtime::{RuntimeHandle, RuntimeLiveness};
use std::sync::atomic::AtomicUsize;
use std::time::{Duration, Instant};

static AGENTS_FREED: AtomicUsize = AtomicUsize::new(0);
static TURNS_FREED: AtomicUsize = AtomicUsize::new(0);
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

//! Python bindings for the EventListener trait.
//!
//! Bridges Python callback objects to the Rust `EventListener` trait.
//! Python users pass an object with optional `on_*` methods; only implemented
//! methods are called.

use std::time::Duration;

use boxlite::BoxID;
use boxlite::event_listener::EventListener;
use pyo3::prelude::*;

/// Python-side event listener that delegates to a Python object.
///
/// The Python object can implement any subset of the callback methods:
///
/// ```python
/// class MyListener:
///     def on_box_created(self, box_id: str) -> None: ...
///     def on_box_started(self, box_id: str) -> None: ...
///     def on_box_stopped(self, box_id: str, exit_code: int | None) -> None: ...
///     def on_box_removed(self, box_id: str) -> None: ...
///     def on_exec_started(self, box_id: str, command: str, args: list[str]) -> None: ...
///     def on_exec_completed(self, box_id: str, command: str, exit_code: int, duration_secs: float) -> None: ...
///     def on_file_copied_in(self, box_id: str, host_src: str, container_dst: str) -> None: ...
///     def on_file_copied_out(self, box_id: str, container_src: str, host_dst: str) -> None: ...
/// ```
///
/// Missing methods are silently skipped (no-op).
pub(crate) struct PyEventListener {
    callback: Py<PyAny>,
}

// SAFETY: `Py<PyAny>` is `Send` in PyO3 0.27 but not `Sync`. We need `Sync`
// because `EventListener: Send + Sync` (listeners are shared across async tasks
// via `Arc`). This `impl Sync` is sound because:
//
// 1. The only field (`callback: Py<PyAny>`) is never accessed outside
//    `Python::attach` blocks, which acquire the GIL before any interaction.
// 2. `Py::call_method1` with a valid `Python<'_>` token is safe to invoke
//    from multiple threads — the GIL serializes all Python execution.
// 3. The `Py<PyAny>` is never cloned or dropped outside GIL-protected contexts
//    (only `Arc<PyEventListener>` is cloned, which is an atomic refcount op).
//
// INVARIANT: Do NOT access `self.callback` outside a `Python::attach` closure.
// Violating this invariant would be undefined behavior.
//
// NOTE: This assumes CPython's GIL. Free-threaded Python (PEP 703) would
// require revisiting this safety argument.
unsafe impl Sync for PyEventListener {}

impl PyEventListener {
    pub(crate) fn new(callback: Py<PyAny>) -> Self {
        Self { callback }
    }
}

/// Log non-AttributeError callback failures. AttributeError means the Python
/// object didn't implement that particular method, which is expected.
fn log_callback_err(py: Python<'_>, method: &str, err: &PyErr) {
    if !err.is_instance_of::<pyo3::exceptions::PyAttributeError>(py) {
        tracing::warn!("EventListener.{} callback error: {}", method, err);
    }
}

impl EventListener for PyEventListener {
    fn on_box_created(&self, box_id: &BoxID) {
        let id = box_id.to_string();
        Python::attach(|py| {
            if let Err(ref e) = self.callback.call_method1(py, "on_box_created", (id,)) {
                log_callback_err(py, "on_box_created", e);
            }
        });
    }

    fn on_box_started(&self, box_id: &BoxID) {
        let id = box_id.to_string();
        Python::attach(|py| {
            if let Err(ref e) = self.callback.call_method1(py, "on_box_started", (id,)) {
                log_callback_err(py, "on_box_started", e);
            }
        });
    }

    fn on_box_stopped(&self, box_id: &BoxID, exit_code: Option<i32>) {
        let id = box_id.to_string();
        Python::attach(|py| {
            if let Err(ref e) = self
                .callback
                .call_method1(py, "on_box_stopped", (id, exit_code))
            {
                log_callback_err(py, "on_box_stopped", e);
            }
        });
    }

    fn on_box_removed(&self, box_id: &BoxID) {
        let id = box_id.to_string();
        Python::attach(|py| {
            if let Err(ref e) = self.callback.call_method1(py, "on_box_removed", (id,)) {
                log_callback_err(py, "on_box_removed", e);
            }
        });
    }

    fn on_exec_started(&self, box_id: &BoxID, command: &str, args: &[String]) {
        let id = box_id.to_string();
        let cmd = command.to_string();
        let a = args.to_vec();
        Python::attach(|py| {
            if let Err(ref e) = self
                .callback
                .call_method1(py, "on_exec_started", (id, cmd, a))
            {
                log_callback_err(py, "on_exec_started", e);
            }
        });
    }

    fn on_exec_completed(&self, box_id: &BoxID, command: &str, exit_code: i32, duration: Duration) {
        let id = box_id.to_string();
        let cmd = command.to_string();
        let secs = duration.as_secs_f64();
        Python::attach(|py| {
            if let Err(ref e) =
                self.callback
                    .call_method1(py, "on_exec_completed", (id, cmd, exit_code, secs))
            {
                log_callback_err(py, "on_exec_completed", e);
            }
        });
    }

    fn on_file_copied_in(&self, box_id: &BoxID, host_src: &str, container_dst: &str) {
        let id = box_id.to_string();
        let src = host_src.to_string();
        let dst = container_dst.to_string();
        Python::attach(|py| {
            if let Err(ref e) = self
                .callback
                .call_method1(py, "on_file_copied_in", (id, src, dst))
            {
                log_callback_err(py, "on_file_copied_in", e);
            }
        });
    }

    fn on_file_copied_out(&self, box_id: &BoxID, container_src: &str, host_dst: &str) {
        let id = box_id.to_string();
        let src = container_src.to_string();
        let dst = host_dst.to_string();
        Python::attach(|py| {
            if let Err(ref e) = self
                .callback
                .call_method1(py, "on_file_copied_out", (id, src, dst))
            {
                log_callback_err(py, "on_file_copied_out", e);
            }
        });
    }
}

//! Runtime management for BoxLite FFI
//!
//! Provides Tokio runtime, BoxliteRuntime handle management, and the
//! per-runtime event queue + drain that drives the post-and-drain callback API.

use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxliteError;
use boxlite::runtime::BoxliteRuntime;
use boxlite::runtime::options::{
    BoxliteOptions, ImageRegistry, ImageRegistryAuth, RegistryTransport,
};

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{CRuntimeShutdownCb, EventQueue, RuntimeEvent, push_event};
use crate::images::ImageHandle;
use crate::util::c_str_to_string;
use crate::{CBoxliteError, CBoxliteImageHandle, CBoxliteRuntime};

/// Opaque handle to a BoxliteRuntime instance with its Tokio runtime and the
/// per-runtime event queue used by the post-and-drain callback API.
pub struct RuntimeHandle {
    pub runtime: BoxliteRuntime,
    pub tokio_rt: Arc<TokioRuntime>,
    pub liveness: Arc<RuntimeLiveness>,
    pub queue: Arc<EventQueue>,
}

/// Shared runtime liveness for FFI-owned handles.
///
/// Image handles use this to honor the runtime shutdown/free boundary even
/// though they retain their own core handle internally.
pub struct RuntimeLiveness {
    alive: AtomicBool,
}

impl RuntimeLiveness {
    pub fn new() -> Self {
        Self {
            alive: AtomicBool::new(true),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub fn mark_closed(&self) {
        self.alive.store(false, Ordering::Release);
    }
}

impl Default for RuntimeLiveness {
    fn default() -> Self {
        Self::new()
    }
}

/// Create a new Tokio runtime
pub fn create_tokio_runtime() -> Result<Arc<TokioRuntime>, String> {
    TokioRuntime::new()
        .map(Arc::new)
        .map_err(|e| format!("Failed to create async runtime: {}", e))
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoxliteRegistryTransport {
    BoxliteRegistryTransportHttps = 0,
    BoxliteRegistryTransportHttp = 1,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BoxliteImageRegistry {
    pub host: *const c_char,
    pub transport: BoxliteRegistryTransport,
    pub skip_verify: c_int,
    pub search: c_int,
    pub username: *const c_char,
    pub password: *const c_char,
    pub bearer_token: *const c_char,
}

#[unsafe(no_mangle)]
pub extern "C" fn boxlite_version() -> *const c_char {
    version()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_new(
    home_dir: *const c_char,
    image_registries: *const BoxliteImageRegistry,
    image_registries_count: c_int,
    out_runtime: *mut *mut CBoxliteRuntime,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    runtime_new(
        home_dir,
        image_registries,
        image_registries_count,
        out_runtime,
        out_error,
    )
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_images(
    runtime: *mut CBoxliteRuntime,
    out_handle: *mut *mut CBoxliteImageHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    runtime_images(runtime, out_handle, out_error)
}

/// Async + callback variant of runtime shutdown.
///
/// Spawns a Tokio task that calls `BoxliteRuntime::shutdown` and posts a
/// `RuntimeEvent::Shutdown` to the runtime queue. Marks liveness as closed
/// synchronously so subsequent ops fail fast.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_shutdown(
    runtime: *mut CBoxliteRuntime,
    timeout_secs: c_int,
    cb: CRuntimeShutdownCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let timeout_opt = if timeout_secs == 0 {
        None
    } else {
        Some(timeout_secs)
    };
    shutdown_runtime(runtime, timeout_opt, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_free(runtime: *mut CBoxliteRuntime) {
    runtime_free(runtime)
}

/// Drain pending callbacks for `runtime`, dispatching them on the calling
/// thread. The queue lock is released before any user code runs.
///
/// `timeout_ms`:
///   - `0`  : non-blocking poll
///   - `< 0`: block indefinitely until at least one event is available
///   - `> 0`: block up to that many milliseconds
///
/// Returns the number of dispatched events, or `-1` on error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_drain(
    runtime: *mut CBoxliteRuntime,
    timeout_ms: c_int,
    out_error: *mut CBoxliteError,
) -> c_int {
    drain(runtime, timeout_ms, out_error)
}

unsafe fn runtime_new(
    home_dir: *const c_char,
    image_registries: *const BoxliteImageRegistry,
    image_registries_count: c_int,
    out_runtime: *mut *mut RuntimeHandle,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if out_runtime.is_null() {
            write_error(out_error, null_pointer_error("out_runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let tokio_rt = match create_tokio_runtime() {
            Ok(rt) => rt,
            Err(e) => {
                let err = BoxliteError::Internal(e);
                write_error(out_error, err);
                return BoxliteErrorCode::Internal;
            }
        };

        let mut options = BoxliteOptions::default();
        if !home_dir.is_null() {
            match c_str_to_string(home_dir) {
                Ok(path) => options.home_dir = path.into(),
                Err(e) => {
                    write_error(out_error, e);
                    return BoxliteErrorCode::InvalidArgument;
                }
            }
        }

        options.image_registries =
            match parse_image_registry_array(image_registries, image_registries_count) {
                Ok(image_registries) => image_registries,
                Err(e) => {
                    let code = error_to_code(&e);
                    write_error(out_error, e);
                    return code;
                }
            };

        let runtime = match BoxliteRuntime::new(options) {
            Ok(rt) => rt,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                return code;
            }
        };

        *out_runtime = Box::into_raw(Box::new(RuntimeHandle {
            runtime,
            tokio_rt,
            liveness: Arc::new(RuntimeLiveness::new()),
            queue: Arc::new(EventQueue::new()),
        }));
        BoxliteErrorCode::Ok
    }
}

unsafe fn parse_image_registry_array(
    image_registries: *const BoxliteImageRegistry,
    image_registries_count: c_int,
) -> Result<Vec<ImageRegistry>, BoxliteError> {
    if image_registries_count < 0 {
        return Err(BoxliteError::InvalidArgument(
            "image_registries_count must not be negative".to_string(),
        ));
    }
    if image_registries_count == 0 {
        return Ok(Vec::new());
    }
    if image_registries.is_null() {
        return Err(BoxliteError::InvalidArgument(
            "image_registries must not be null when image_registries_count is positive".to_string(),
        ));
    }

    let mut parsed = Vec::with_capacity(image_registries_count as usize);
    unsafe {
        for idx in 0..image_registries_count {
            let registry = &*image_registries.add(idx as usize);
            let host = c_string_field(registry.host, "registry host")?;
            let transport = match registry.transport {
                BoxliteRegistryTransport::BoxliteRegistryTransportHttps => RegistryTransport::Https,
                BoxliteRegistryTransport::BoxliteRegistryTransportHttp => RegistryTransport::Http,
            };
            let auth = registry_auth(registry)?;

            parsed.push(ImageRegistry {
                host,
                transport,
                skip_verify: registry.skip_verify != 0,
                search: registry.search != 0,
                auth,
            });
        }
    }
    Ok(parsed)
}

unsafe fn registry_auth(
    registry: &BoxliteImageRegistry,
) -> Result<ImageRegistryAuth, BoxliteError> {
    unsafe {
        if !registry.bearer_token.is_null() {
            let token = c_string_field(registry.bearer_token, "registry bearer token")?;
            if !token.is_empty() {
                return Ok(ImageRegistryAuth::Bearer { token });
            }
        }

        match (registry.username.is_null(), registry.password.is_null()) {
            (true, true) => Ok(ImageRegistryAuth::Anonymous),
            (false, false) => {
                let username = c_string_field(registry.username, "registry username")?;
                let password = c_string_field(registry.password, "registry password")?;
                Ok(ImageRegistryAuth::Basic { username, password })
            }
            _ => Err(BoxliteError::InvalidArgument(
                "registry username and password must be provided together".to_string(),
            )),
        }
    }
}

unsafe fn c_string_field(value: *const c_char, field_name: &str) -> Result<String, BoxliteError> {
    unsafe {
        if value.is_null() {
            return Err(BoxliteError::InvalidArgument(format!(
                "{field_name} must not be null"
            )));
        }
        c_str_to_string(value)
            .map_err(|e| BoxliteError::InvalidArgument(format!("invalid {field_name}: {e}")))
    }
}

unsafe fn runtime_images(
    runtime: *mut RuntimeHandle,
    out_handle: *mut *mut ImageHandle,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_handle.is_null() {
            write_error(out_error, null_pointer_error("out_handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &*runtime;
        if let Err(e) = crate::util::ensure_runtime_live(&runtime_ref.liveness, "access images") {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return code;
        }

        match runtime_ref.runtime.images() {
            Ok(handle) => {
                *out_handle = Box::into_raw(Box::new(ImageHandle {
                    handle,
                    tokio_rt: runtime_ref.tokio_rt.clone(),
                    liveness: runtime_ref.liveness.clone(),
                    queue: runtime_ref.queue.clone(),
                }));
                BoxliteErrorCode::Ok
            }
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

unsafe fn shutdown_runtime(
    runtime: *mut RuntimeHandle,
    timeout: Option<i32>,
    cb: CRuntimeShutdownCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let runtime_ref = &*runtime;
        runtime_ref.liveness.mark_closed();

        let queue = runtime_ref.queue.clone();
        let tokio_rt = runtime_ref.tokio_rt.clone();
        let user_data_addr = user_data as usize;
        let runtime_clone = runtime_ref.runtime.clone();

        tokio_rt.spawn(async move {
            let result = runtime_clone.shutdown(timeout).await;
            push_event(
                &queue,
                RuntimeEvent::Shutdown {
                    cb,
                    user_data: user_data_addr,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

unsafe fn runtime_free(runtime: *mut RuntimeHandle) {
    if !runtime.is_null() {
        unsafe {
            let handle = Box::from_raw(runtime);
            handle.liveness.mark_closed();
            // Close the queue: blocked drainers wake and exit on the closed
            // flag, late events from in-flight Tokio tasks are dropped. The
            // queue itself stays alive via any drainer's Arc clone until that
            // drainer returns — no UAF on the queue's mutex/condvar.
            handle.queue.mark_closed();
            drop(handle);
        }
    }
}

unsafe fn drain(rt: *mut RuntimeHandle, timeout_ms: c_int, out_error: *mut FFIError) -> c_int {
    if rt.is_null() {
        unsafe { write_error(out_error, null_pointer_error("runtime")) };
        return -1;
    }

    // Clone the queue Arc once at entry so the queue's Mutex/Condvar stay
    // valid for the rest of the call even if `runtime_free` drops the
    // RuntimeHandle concurrently. After this line we never re-deref `rt`.
    let queue = unsafe { (*rt).queue.clone() };

    let deadline = if timeout_ms < 0 {
        None
    } else {
        Some(Instant::now() + Duration::from_millis(timeout_ms as u64))
    };

    let mut count: c_int = 0;
    loop {
        // ─── Pop one event ───
        let event_opt: Option<RuntimeEvent> = {
            let mut g = queue.inner.lock().unwrap();
            let mut popped: Option<RuntimeEvent> = None;
            while popped.is_none() {
                // Honour close — `runtime_free` set this and signalled the cv.
                if queue.is_closed() {
                    return count;
                }
                if let Some(ev) = g.pop_front() {
                    popped = Some(ev);
                    break;
                }
                match deadline {
                    None => g = queue.cv.wait(g).unwrap(),
                    Some(d) => {
                        let now = Instant::now();
                        if now >= d {
                            return count;
                        }
                        let (new_g, _timeout) = queue.cv.wait_timeout(g, d - now).unwrap();
                        g = new_g;
                        if g.is_empty() && Instant::now() >= d {
                            return count;
                        }
                    }
                }
            }
            popped
        };

        let Some(event) = event_opt else {
            return count;
        };

        // ─── Lock RELEASED — dispatch to user callback ───
        unsafe { dispatch_event(event) };
        count = count.saturating_add(1);
    }
}

unsafe fn dispatch_event(event: RuntimeEvent) {
    unsafe {
        match event {
            RuntimeEvent::Stdout {
                cb,
                user_data,
                data,
            } => cb(data.as_ptr(), data.len(), user_data as *mut c_void),
            RuntimeEvent::Stderr {
                cb,
                user_data,
                data,
            } => cb(data.as_ptr(), data.len(), user_data as *mut c_void),
            RuntimeEvent::Exit {
                cb,
                user_data,
                exit_code,
            } => cb(exit_code, user_data as *mut c_void),
            RuntimeEvent::CreateBox {
                cb,
                user_data,
                result,
            } => dispatch_handle_event::<crate::CBoxHandle>(result, user_data, cb),
            RuntimeEvent::StartBox {
                cb,
                user_data,
                result,
            } => dispatch_unit_event(result, user_data, cb),
            RuntimeEvent::StopBox {
                cb,
                user_data,
                result,
            } => dispatch_unit_event(result, user_data, cb),
            RuntimeEvent::GetBox {
                cb,
                user_data,
                result,
            } => dispatch_handle_event::<crate::CBoxHandle>(result, user_data, cb),
            RuntimeEvent::RemoveBox {
                cb,
                user_data,
                result,
            } => dispatch_unit_event(result, user_data, cb),
            RuntimeEvent::ImagePull {
                cb,
                user_data,
                result,
            } => dispatch_handle_event::<crate::CImagePullResult>(result, user_data, cb),
            RuntimeEvent::ImageList {
                cb,
                user_data,
                result,
            } => dispatch_handle_event::<crate::CImageInfoList>(result, user_data, cb),
            RuntimeEvent::Copy {
                cb,
                user_data,
                result,
            } => dispatch_unit_event(result, user_data, cb),
            RuntimeEvent::Info {
                cb,
                user_data,
                result,
            } => dispatch_handle_event::<crate::CBoxInfo>(result, user_data, cb),
            RuntimeEvent::InfoList {
                cb,
                user_data,
                result,
            } => dispatch_handle_event::<crate::CBoxInfoList>(result, user_data, cb),
            RuntimeEvent::Metrics {
                cb,
                user_data,
                result,
            } => dispatch_value_event::<crate::CBoxMetrics>(result, user_data, cb),
            RuntimeEvent::RtMetrics {
                cb,
                user_data,
                result,
            } => dispatch_value_event::<crate::CRuntimeMetrics>(result, user_data, cb),
            RuntimeEvent::Shutdown {
                cb,
                user_data,
                result,
            } => dispatch_unit_event(result, user_data, cb),
            RuntimeEvent::Wait {
                cb,
                user_data,
                result,
            } => {
                let mut err = FFIError::default();
                let exit_code = match result {
                    Ok(code) => code,
                    Err(e) => {
                        err = crate::error::error_to_c_error(e);
                        -1
                    }
                };
                cb(exit_code, &mut err, user_data as *mut c_void);
                if !err.message.is_null() {
                    crate::boxlite_error_free(&mut err);
                }
            }
            RuntimeEvent::Kill {
                cb,
                user_data,
                result,
            } => dispatch_unit_event(result, user_data, cb),
            RuntimeEvent::Signal {
                cb,
                user_data,
                result,
            } => dispatch_unit_event(result, user_data, cb),
            RuntimeEvent::Resize {
                cb,
                user_data,
                result,
            } => dispatch_unit_event(result, user_data, cb),
        }
    }
}

/// Callback shape for events that carry only a possible error: `(err, ud)`.
type UnitCb = extern "C" fn(*mut FFIError, *mut c_void);

/// Callback shape for events carrying an owned out-pointer + possible error.
type HandleCb<T> = extern "C" fn(*mut T, *mut FFIError, *mut c_void);

unsafe fn dispatch_unit_event(result: Result<(), BoxliteError>, user_data: usize, cb: UnitCb) {
    unsafe {
        let mut err = FFIError::default();
        if let Err(e) = result {
            err = crate::error::error_to_c_error(e);
        }
        cb(&mut err as *mut _, user_data as *mut c_void);
        if !err.message.is_null() {
            crate::boxlite_error_free(&mut err);
        }
    }
}

/// Dispatch a "handle pointer + error" event. The `result` carries an
/// `OwnedFfiPtr<T>` (so the event is `Send` and the underlying allocation
/// is reclaimed if the event is dropped before dispatch); on success the
/// callback receives the unwrapped raw pointer (Drop disarmed via `take`)
/// and a zeroed error; on failure it receives a null pointer and a
/// populated error.
unsafe fn dispatch_handle_event<T>(
    result: Result<crate::event_queue::OwnedFfiPtr<T>, BoxliteError>,
    user_data: usize,
    cb: HandleCb<T>,
) {
    unsafe {
        let mut err = FFIError::default();
        let ptr = match result {
            Ok(owned) => owned.take(),
            Err(e) => {
                err = crate::error::error_to_c_error(e);
                ptr::null_mut()
            }
        };
        cb(ptr, &mut err as *mut _, user_data as *mut c_void);
        if !err.message.is_null() {
            crate::boxlite_error_free(&mut err);
        }
    }
}

/// Dispatch a "value-by-pointer + error" event for events whose success
/// payload is a value-typed C struct (e.g. CBoxMetrics). Stack-allocates
/// the value, hands a pointer to it to the callback, then drops it.
unsafe fn dispatch_value_event<T>(
    result: Result<T, BoxliteError>,
    user_data: usize,
    cb: HandleCb<T>,
) {
    unsafe {
        let mut err = FFIError::default();
        match result {
            Ok(mut value) => {
                cb(
                    &mut value as *mut T,
                    &mut err as *mut _,
                    user_data as *mut c_void,
                );
            }
            Err(e) => {
                err = crate::error::error_to_c_error(e);
                cb(
                    ptr::null_mut(),
                    &mut err as *mut _,
                    user_data as *mut c_void,
                );
            }
        }
        if !err.message.is_null() {
            crate::boxlite_error_free(&mut err);
        }
    }
}

pub extern "C" fn version() -> *const c_char {
    // Static string, safe to return pointer
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr() as *const c_char
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::ptr;

    fn registry(host: *const c_char) -> BoxliteImageRegistry {
        BoxliteImageRegistry {
            host,
            transport: BoxliteRegistryTransport::BoxliteRegistryTransportHttps,
            skip_verify: 0,
            search: 0,
            username: ptr::null(),
            password: ptr::null(),
            bearer_token: ptr::null(),
        }
    }

    fn test_registry_password() -> String {
        String::from_utf8(vec![115, 101, 99, 114, 101, 116]).unwrap()
    }

    fn test_bearer_token() -> String {
        String::from_utf8(vec![111, 112, 97, 113, 117, 101]).unwrap()
    }

    #[test]
    fn parse_image_registry_array_maps_all_fields() {
        let anonymous_host = CString::new("anonymous.local").unwrap();
        let basic_host = CString::new("basic.local").unwrap();
        let basic_username = CString::new("alice").unwrap();
        let password = test_registry_password();
        let basic_password = CString::new(password.as_str()).unwrap();
        let bearer_host = CString::new("bearer.local").unwrap();
        let token = test_bearer_token();
        let bearer_token = CString::new(token.as_str()).unwrap();

        let registries = [
            registry(anonymous_host.as_ptr()),
            BoxliteImageRegistry {
                host: basic_host.as_ptr(),
                transport: BoxliteRegistryTransport::BoxliteRegistryTransportHttp,
                skip_verify: 1,
                search: 1,
                username: basic_username.as_ptr(),
                password: basic_password.as_ptr(),
                bearer_token: ptr::null(),
            },
            BoxliteImageRegistry {
                host: bearer_host.as_ptr(),
                bearer_token: bearer_token.as_ptr(),
                ..registry(bearer_host.as_ptr())
            },
        ];

        let parsed =
            unsafe { parse_image_registry_array(registries.as_ptr(), registries.len() as c_int) }
                .unwrap();

        assert_eq!(
            parsed,
            vec![
                ImageRegistry::https("anonymous.local"),
                ImageRegistry::http("basic.local")
                    .with_skip_verify(true)
                    .with_search(true)
                    .with_basic_auth("alice", password),
                ImageRegistry::https("bearer.local").with_bearer_auth(token),
            ]
        );
    }

    #[test]
    fn parse_image_registry_array_rejects_invalid_arguments() {
        let host = CString::new("registry.local").unwrap();
        let username = CString::new("alice").unwrap();
        let missing_password = BoxliteImageRegistry {
            username: username.as_ptr(),
            ..registry(host.as_ptr())
        };
        let null_host = registry(ptr::null());

        let cases = [
            unsafe { parse_image_registry_array(ptr::null(), -1) },
            unsafe { parse_image_registry_array(ptr::null(), 1) },
            unsafe { parse_image_registry_array(&null_host as *const _, 1) },
            unsafe { parse_image_registry_array(&missing_password as *const _, 1) },
        ];

        for result in cases {
            assert!(result.is_err());
        }
    }
}

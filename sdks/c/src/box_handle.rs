//! Box handle operations for the BoxLite C SDK.
//!
//! All async lifecycle operations follow the post-and-drain pattern: each C
//! function spawns a Tokio task that performs the underlying async Rust call
//! and pushes a typed `RuntimeEvent` to the runtime's queue. Callbacks fire
//! later from `boxlite_runtime_drain` on the user's thread.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxID;
use boxlite::BoxliteError;
use boxlite::litebox::LiteBox;
use boxlite::net::{CompleteOutboundPolicy, PreparedOutboundCreate};

use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxCreateBoxCb, CBoxGetBoxCb, CBoxGetOrCreateBoxCb, CBoxRemoveBoxCb, CBoxStartBoxCb,
    CBoxStopBoxCb, EventQueue, RuntimeEvent, push_event,
};
use crate::options::OptionsHandle;
use crate::runtime::RuntimeHandle;
use crate::util::c_str_to_string;
use crate::{CBoxHandle, CBoxliteError, CBoxliteOptions, CBoxliteRuntime};

/// Opaque handle to a running box.
///
/// `handle` is wrapped in `Arc` so it can be cloned into Tokio tasks for
/// async lifecycle ops.
pub struct BoxHandle {
    pub handle: Arc<LiteBox>,
    #[allow(dead_code)]
    pub box_id: BoxID,
    pub tokio_rt: Arc<TokioRuntime>,
    pub queue: Arc<EventQueue>,
}

enum AdoptPolicy {
    Prepared(PreparedOutboundCreate),
    Complete(CompleteOutboundPolicy),
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_create_box(
    runtime: *mut CBoxliteRuntime,
    opts: *mut CBoxliteOptions,
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    create_box(runtime, opts, None, cb, user_data, out_error)
}

/// Create with complete outbound policy JSON. Policy bytes are copied before
/// return. On success, consumes opts and dispatches cb through runtime_drain.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_create_box_with_outbound_policy(
    runtime: *mut CBoxliteRuntime,
    opts: *mut CBoxliteOptions,
    policy_json: *const c_char,
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    match unsafe { read_complete_create_policy(opts, policy_json) } {
        Ok(policy) => create_box(runtime, opts, Some(policy), cb, user_data, out_error),
        Err(error) => {
            let code = crate::error::error_to_code(&error);
            unsafe { write_error(out_error, error) };
            code
        }
    }
}

/// Get an existing box by name, or create a new one if it does not exist.
///
/// When a box with the given name already exists it returns that box instead
/// of failing with "already exists". The callback receives an extra `created`
/// flag: `true` when a new box was created, `false` when an existing box was
/// adopted — letting callers distinguish the two (e.g. skip re-initialization
/// for an adopted box).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get_or_create_box(
    runtime: *mut CBoxliteRuntime,
    opts: *mut CBoxliteOptions,
    cb: CBoxGetOrCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    get_or_create_box(runtime, opts, None, cb, user_data, out_error)
}

/// Create or adopt a named Box with the exact prepared outbound identity.
/// The prepared JSON is copied before return. On success, consumes `opts`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get_or_create_box_with_prepared_outbound(
    runtime: *mut CBoxliteRuntime,
    opts: *mut CBoxliteOptions,
    prepared_json: *const c_char,
    cb: CBoxGetOrCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let prepared = unsafe { c_str_to_string(prepared_json) }.and_then(|json| {
        serde_json::from_str::<PreparedOutboundCreate>(&json).map_err(|error| {
            BoxliteError::InvalidArgument(format!("invalid prepared outbound create: {error}"))
        })
    });
    match prepared {
        Ok(prepared) => get_or_create_box(
            runtime,
            opts,
            Some(AdoptPolicy::Prepared(prepared)),
            cb,
            user_data,
            out_error,
        ),
        Err(error) => {
            unsafe { write_error(out_error, error) };
            BoxliteErrorCode::InvalidArgument
        }
    }
}

/// Create or adopt a named Box with the same committed complete policy. On
/// success, consumes opts. The policy JSON is copied before return.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get_or_create_box_with_outbound_policy(
    runtime: *mut CBoxliteRuntime,
    opts: *mut CBoxliteOptions,
    policy_json: *const c_char,
    cb: CBoxGetOrCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    match unsafe { read_complete_create_policy(opts, policy_json) } {
        Ok(policy) => get_or_create_box(
            runtime,
            opts,
            Some(AdoptPolicy::Complete(policy)),
            cb,
            user_data,
            out_error,
        ),
        Err(error) => {
            let code = crate::error::error_to_code(&error);
            unsafe { write_error(out_error, error) };
            code
        }
    }
}

unsafe fn read_complete_create_policy(
    opts: *mut CBoxliteOptions,
    policy_json: *const c_char,
) -> boxlite::BoxliteResult<CompleteOutboundPolicy> {
    let options = unsafe { opts.as_ref() }.ok_or_else(|| null_pointer_error("opts"))?;
    if options.legacy_outbound_selected {
        return Err(BoxliteError::InvalidArgument(
            "complete policy cannot be combined with legacy outbound options".into(),
        ));
    }
    let json = unsafe { c_str_to_string(policy_json) }?;
    let policy: CompleteOutboundPolicy = serde_json::from_str(&json).map_err(|error| {
        BoxliteError::InvalidArgument(format!("invalid complete outbound policy: {error}"))
    })?;
    policy.validate()?;
    Ok(policy)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_stop_box(
    handle: *mut CBoxHandle,
    cb: CBoxStopBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    stop_box(handle, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    cb: CBoxGetBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    attach_box(runtime, id_or_name, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_remove(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    force: c_int,
    cb: CBoxRemoveBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    remove_box(runtime, id_or_name, force != 0, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_start_box(
    handle: *mut CBoxHandle,
    cb: CBoxStartBoxCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    start_box(handle, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_id(handle: *mut CBoxHandle) -> *mut c_char {
    box_id(handle)
}

/// Return an owned name string, or null for an unnamed/invalid handle.
/// Release the returned string with boxlite_free_string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_name(handle: *mut CBoxHandle) -> *mut c_char {
    if handle.is_null() {
        return ptr::null_mut();
    }
    unsafe { &*handle }
        .handle
        .name()
        .and_then(|name| CString::new(name).ok())
        .map_or(ptr::null_mut(), CString::into_raw)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_free(handle: *mut CBoxHandle) {
    box_free(handle)
}

/// Validate caller options before transferring ownership to asynchronous create.
unsafe fn create_box(
    runtime: *mut RuntimeHandle,
    opts: *mut OptionsHandle,
    policy: Option<CompleteOutboundPolicy>,
    cb: CBoxCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if opts.is_null() {
            write_error(out_error, null_pointer_error("opts"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);
        if let Err(error) = (*opts).validate_checkpoint() {
            write_error(out_error, error);
            return BoxliteErrorCode::InvalidArgument;
        }

        // Security is applied to the options object directly by the
        // enable/disable setters (two-state, nothing to validate), so there is
        // no deferred preset to resolve here.
        let runtime_ref = &*runtime;
        let opts_handle = Box::from_raw(opts);
        let runtime_clone = runtime_ref.runtime.clone();
        let tokio_rt = runtime_ref.tokio_rt.clone();
        let queue = runtime_ref.queue.clone();
        let user_data_addr = user_data as usize;
        let task_tokio_rt = tokio_rt.clone();
        let task_queue = queue.clone();

        tokio_rt.spawn(async move {
            let result = match policy {
                Some(policy) => {
                    runtime_clone
                        .create_with_complete_outbound_policy(
                            opts_handle.options,
                            opts_handle.name,
                            policy,
                        )
                        .await
                }
                None => runtime_clone
                    .create(opts_handle.options, opts_handle.name)
                    .await
                    .map_err(Into::into),
            }
            .map(|handle| {
                let box_id = handle.id().clone();
                let boxed = Box::new(BoxHandle {
                    handle: Arc::new(handle),
                    box_id,
                    tokio_rt: task_tokio_rt,
                    queue: task_queue.clone(),
                });
                crate::event_queue::OwnedFfiPtr::new(boxed)
            });
            push_event(
                &queue,
                RuntimeEvent::CreateBox {
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

/// Refuse checkpoint overrides before adopting a named Box or transferring options.
unsafe fn get_or_create_box(
    runtime: *mut RuntimeHandle,
    opts: *mut OptionsHandle,
    policy: Option<AdoptPolicy>,
    cb: CBoxGetOrCreateBoxCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if opts.is_null() {
            write_error(out_error, null_pointer_error("opts"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);
        if let Err(error) = (*opts).validate_checkpoint() {
            write_error(out_error, error);
            return BoxliteErrorCode::InvalidArgument;
        }

        if matches!(policy, Some(AdoptPolicy::Prepared(_)))
            && (*opts).name.as_deref().is_none_or(str::is_empty)
        {
            write_error(
                out_error,
                BoxliteError::InvalidArgument(
                    "prepared outbound create requires a Box name".into(),
                ),
            );
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &*runtime;
        let opts_handle = Box::from_raw(opts);
        let runtime_clone = runtime_ref.runtime.clone();
        let tokio_rt = runtime_ref.tokio_rt.clone();
        let queue = runtime_ref.queue.clone();
        let user_data_addr = user_data as usize;
        let task_tokio_rt = tokio_rt.clone();
        let task_queue = queue.clone();

        tokio_rt.spawn(async move {
            let result = match (policy, opts_handle.name) {
                (Some(AdoptPolicy::Prepared(prepared)), Some(name)) => runtime_clone
                    .get_or_create_with_prepared_outbound(opts_handle.options, name, prepared)
                    .await
                    .map_err(Into::into),
                (Some(AdoptPolicy::Complete(policy)), name) => {
                    runtime_clone
                        .get_or_create_with_complete_outbound_policy(
                            opts_handle.options,
                            name,
                            policy,
                        )
                        .await
                }
                (None, name) => runtime_clone
                    .get_or_create(opts_handle.options, name)
                    .await
                    .map_err(Into::into),
                (Some(AdoptPolicy::Prepared(_)), None) => Err(BoxliteError::InvalidArgument(
                    "prepared outbound create requires a Box name".into(),
                )
                .into()),
            };
            let result = result.map(|(handle, created)| {
                let box_id = handle.id().clone();
                let boxed = Box::new(BoxHandle {
                    handle: Arc::new(handle),
                    box_id,
                    tokio_rt: task_tokio_rt,
                    queue: task_queue.clone(),
                });
                (crate::event_queue::OwnedFfiPtr::new(boxed), created)
            });
            push_event(
                &queue,
                RuntimeEvent::GetOrCreateBox {
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

unsafe fn stop_box(
    handle: *mut BoxHandle,
    cb: CBoxStopBoxCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite.stop().await;
            push_event(
                &queue,
                RuntimeEvent::StopBox {
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

unsafe fn attach_box(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    cb: CBoxGetBoxCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let id_str = match c_str_to_string(id_or_name) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let runtime_ref = &*runtime;
        let runtime_clone = runtime_ref.runtime.clone();
        let tokio_rt = runtime_ref.tokio_rt.clone();
        let queue = runtime_ref.queue.clone();
        let user_data_addr = user_data as usize;
        let task_tokio_rt = tokio_rt.clone();
        let task_queue = queue.clone();

        tokio_rt.spawn(async move {
            let result = match runtime_clone.get(&id_str).await {
                Ok(Some(handle)) => {
                    let box_id = handle.id().clone();
                    let boxed = Box::new(BoxHandle {
                        handle: Arc::new(handle),
                        box_id,
                        tokio_rt: task_tokio_rt,
                        queue: task_queue.clone(),
                    });
                    Ok(crate::event_queue::OwnedFfiPtr::new(boxed))
                }
                Ok(None) => Err(BoxliteError::NotFound(format!("Box not found: {id_str}"))),
                Err(e) => Err(e),
            };
            push_event(
                &queue,
                RuntimeEvent::GetBox {
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

unsafe fn remove_box(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    force: bool,
    cb: CBoxRemoveBoxCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let id_str = match c_str_to_string(id_or_name) {
            Ok(s) => s,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let runtime_ref = &*runtime;
        let runtime_clone = runtime_ref.runtime.clone();
        let queue = runtime_ref.queue.clone();
        let user_data_addr = user_data as usize;

        runtime_ref.tokio_rt.spawn(async move {
            let result = runtime_clone.remove(&id_str, force).await.map(|_| ());
            push_event(
                &queue,
                RuntimeEvent::RemoveBox {
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

unsafe fn start_box(
    handle: *mut BoxHandle,
    cb: CBoxStartBoxCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = lite.start().await;
            push_event(
                &queue,
                RuntimeEvent::StartBox {
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

unsafe fn box_id(handle: *mut BoxHandle) -> *mut c_char {
    unsafe {
        if handle.is_null() {
            return ptr::null_mut();
        }

        let handle_ref = &*handle;
        let id_str = handle_ref.handle.id().to_string();

        match CString::new(id_str) {
            Ok(s) => s.into_raw(),
            Err(_) => ptr::null_mut(),
        }
    }
}

unsafe fn box_free(handle: *mut BoxHandle) {
    if !handle.is_null() {
        unsafe {
            drop(Box::from_raw(handle));
        }
    }
}

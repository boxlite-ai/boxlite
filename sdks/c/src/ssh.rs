//! Guest SSH control over a box handle.
//!
//! All three operations follow the post-and-drain pattern: each spawns a Tokio
//! task that runs the Rust `SshHandle` call and posts one `RuntimeEvent`;
//! callbacks fire later on the thread calling `boxlite_runtime_drain`. Only
//! `configure` may implicitly start the box (core-owned policy); `status` and
//! `disable` never start it.

use std::ffi::{CStr, CString, c_char, c_void};
use std::os::raw::c_int;

use boxlite::{SshConfig, SshStatus};

use crate::CBoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxSshConfigureCb, CBoxSshDisableCb, CBoxSshStatusCb, OwnedFfiPtr, RuntimeEvent, push_event,
};

/// A rejected configure body reports this constant, mirroring the REST
/// handler: serde's message can quote the caller's key material.
const INVALID_CONFIG: &str = "invalid SSH configuration";

/// Guest SSH listener state as observed by one call; carries no credentials.
///
/// The callback that receives it by pointer owns it, nested strings included,
/// and releases it once with `boxlite_free_ssh_status`. `enabled` is non-zero
/// while the guest listener runs. Disabling a running listener preserves its
/// generation; a never-enabled one reports zero, as Configured and Stopped
/// boxes do.
#[repr(C)]
pub struct CSshStatus {
    pub enabled: c_int,
    pub generation: u64,
    pub listen_address: *mut c_char,
    pub host_public_key: *mut c_char,
    pub host_key_fingerprint: *mut c_char,
}

fn to_c_str(s: &str) -> *mut c_char {
    // Guest-produced fields contain no interior NUL; fall back to the empty
    // string rather than panic across the FFI.
    CString::new(s).unwrap_or_default().into_raw()
}

/// Move a status into an owned FFI payload; dropping it without dispatch
/// (closed queue) reclaims the nested strings.
pub(crate) fn owned_ssh_status(status: SshStatus) -> OwnedFfiPtr<CSshStatus> {
    let status = CSshStatus {
        enabled: c_int::from(status.enabled),
        generation: status.generation,
        listen_address: to_c_str(&status.listen_address),
        host_public_key: to_c_str(&status.host_public_key),
        host_key_fingerprint: to_c_str(&status.host_key_fingerprint),
    };
    OwnedFfiPtr::new_with(Box::new(status), free_ssh_status)
}

/// Reclaim a status with its strings.
///
/// # Safety
///
/// `status` must be null or a live `Box::into_raw` pointer to a `CSshStatus`,
/// as built by [`owned_ssh_status`], that is not yet freed, uniquely owned by
/// the caller, and not accessed concurrently; it is invalid after this call.
/// Each of its three string fields must be null or a `CString::into_raw`
/// allocation not previously freed, with its original NUL position preserved;
/// they are reclaimed with it.
pub unsafe fn free_ssh_status(status: *mut CSshStatus) {
    if !status.is_null() {
        unsafe {
            let status = Box::from_raw(status);
            free_str(status.listen_address);
            free_str(status.host_public_key);
            free_str(status.host_key_fingerprint);
        }
    }
}

fn free_str(s: *mut c_char) {
    if !s.is_null() {
        #[cfg(test)]
        crate::FREE_STR_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        unsafe {
            drop(CString::from_raw(s));
        }
    }
}

/// Queue SSH configuration replacement. The caller's JSON is copied and
/// deserialized into the runtime's `SshConfig` at entry — a malformed or
/// non-UTF-8 body returns `InvalidArgument` with a constant message before
/// anything is queued, so key material never reaches the error. The core
/// applies its own startup policy: with an explicit main command a Configured
/// or Stopped box fails the callback with `InvalidState`.
///
/// # Safety
///
/// `handle`, `config_json`, and `cb` must be non-null; `config_json` must be
/// UTF-8 and only needs to stay valid for this call. A successful callback
/// owns the status and must release it with `boxlite_free_ssh_status`; the
/// error pointer is borrowed for the callback only.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_ssh_configure(
    handle: *mut CBoxHandle,
    config_json: *const c_char,
    cb: CBoxSshConfigureCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    match unsafe { copy_ssh_config(config_json) } {
        Ok(config) => unsafe { spawn_configure(handle, config, cb, user_data, out_error) },
        Err(error) => {
            unsafe { write_error(out_error, error) };
            BoxliteErrorCode::InvalidArgument
        }
    }
}

/// Queue a read of SSH state. Never starts the VM or its main command: a
/// Configured or Stopped box completes with disabled status, generation zero,
/// and empty fields.
///
/// # Safety
///
/// `handle` and `cb` must be non-null. Ownership is as for
/// [`boxlite_box_ssh_configure`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_ssh_status(
    handle: *mut CBoxHandle,
    cb: CBoxSshStatusCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    spawn_op(handle, SshOp::Status, cb, user_data, out_error)
}

/// Queue SSH shutdown, disconnecting clients. Repeated calls are supported and
/// never start the box.
///
/// # Safety
///
/// As for [`boxlite_box_ssh_status`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_ssh_disable(
    handle: *mut CBoxHandle,
    cb: CBoxSshDisableCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    spawn_op(handle, SshOp::Disable, cb, user_data, out_error)
}

/// Release a status handed to an SSH callback.
///
/// # Safety
///
/// `status` must be null or a pointer from an SSH callback that has not
/// already been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_ssh_status(status: *mut CSshStatus) {
    unsafe { free_ssh_status(status) }
}

/// The pending operation; `Configure` carries the parsed configuration.
enum SshOp {
    Configure(SshConfig),
    Status,
    Disable,
}

/// Copy and deserialize the caller's JSON; errors use the constant message.
///
/// # Safety
///
/// `config_json` must be null or point to a NUL-terminated string that stays
/// readable and unchanged for this call. The result owns its data, so nothing
/// borrowed from `config_json` outlives the call.
unsafe fn copy_ssh_config(config_json: *const c_char) -> Result<SshConfig, boxlite::BoxliteError> {
    if config_json.is_null() {
        return Err(null_pointer_error("config_json"));
    }
    let text = unsafe { CStr::from_ptr(config_json) }
        .to_str()
        .map_err(|_| invalid_config())?;
    serde_json::from_str(text).map_err(|_| invalid_config())
}

fn invalid_config() -> boxlite::BoxliteError {
    boxlite::BoxliteError::InvalidArgument(INVALID_CONFIG.to_owned())
}

/// Queue a parsed configuration; a null `cb` is refused before `handle` is
/// read.
///
/// # Safety
///
/// As for [`spawn_op`].
unsafe fn spawn_configure(
    handle: *mut CBoxHandle,
    config: SshConfig,
    cb: CBoxSshConfigureCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    spawn_op(handle, SshOp::Configure(config), cb, user_data, out_error)
}

/// Dispatch-time callback: validated non-null at the FFI boundary. The three
/// public typedefs share one ABI, so one alias serves `spawn_op`.
pub(crate) type SshFn = extern "C" fn(*mut CSshStatus, *mut FFIError, *mut c_void);

/// Validate the box handle, then run `op` on the box's Tokio runtime and post
/// one completion event to the box's queue.
///
/// # Safety
///
/// `handle` must be null or point to a live `CBoxHandle` that is not freed
/// during this call; the queued task holds its own clones, so the handle is
/// borrowed for the call only. `out_error` must be null or writable for the
/// duration of this call. `user_data` is never dereferenced here: it is handed
/// back to `cb` on the thread calling `boxlite_runtime_drain`, so it, and `cb`,
/// must stay valid until that callback completes or the event is discarded. A
/// successful callback owns the status and releases it with
/// `boxlite_free_ssh_status`; the error pointer is borrowed only during the
/// callback.
unsafe fn spawn_op(
    handle: *mut CBoxHandle,
    op: SshOp,
    cb: SshFn,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;
        let lite = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data_addr = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let event = match op {
                SshOp::Configure(config) => RuntimeEvent::SshConfigure {
                    cb,
                    user_data: user_data_addr,
                    result: lite.ssh().configure(config).await.map(owned_ssh_status),
                },
                SshOp::Status => RuntimeEvent::SshStatus {
                    cb,
                    user_data: user_data_addr,
                    result: lite.ssh().status().await.map(owned_ssh_status),
                },
                SshOp::Disable => RuntimeEvent::SshDisable {
                    cb,
                    user_data: user_data_addr,
                    result: lite.ssh().disable().await.map(owned_ssh_status),
                },
            };
            push_event(&queue, event).await;
        });

        BoxliteErrorCode::Ok
    }
}

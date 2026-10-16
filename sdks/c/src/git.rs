//! Git operations for the BoxLite C SDK.

use std::ffi::CString;
use std::os::raw::{c_char, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::GitHandle as CoreGitHandle;

use crate::error::{BoxliteErrorCode, null_pointer_error, write_error};
use crate::event_queue::{CGitJsonCb, EventQueue, RuntimeEvent, push_event};
use crate::util::c_str_to_string;
use crate::{CBoxGitHandle, CBoxHandle, CBoxliteError};

/// Opaque handle for git operations on a box.
pub struct BoxGitHandle {
    handle: CoreGitHandle,
    tokio_rt: Arc<TokioRuntime>,
    queue: Arc<EventQueue>,
}

/// Borrow the box's git capability into a new owned handle.
///
/// On success, `*out_git` must be released with `boxlite_git_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_git(
    handle: *mut CBoxHandle,
    out_git: *mut *mut CBoxGitHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_git.is_null() {
            write_error(out_error, null_pointer_error("out_git"));
            return BoxliteErrorCode::InvalidArgument;
        }

        *out_git = ptr::null_mut();
        let handle_ref = &*handle;
        *out_git = Box::into_raw(Box::new(BoxGitHandle {
            handle: handle_ref.handle.git(),
            tokio_rt: handle_ref.tokio_rt.clone(),
            queue: handle_ref.queue.clone(),
        }));
        BoxliteErrorCode::Ok
    }
}

/// Release a git handle. Accepts NULL and does not affect the box handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_git_free(git: *mut CBoxGitHandle) {
    if !git.is_null() {
        unsafe { drop(Box::from_raw(git)) };
    }
}

/// Status of the repository at `path` as a JSON object (fields match the
/// Rust `GitStatus`). The callback owns the string; free it with
/// `boxlite_free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_git_status(
    git: *mut CBoxGitHandle,
    path: *const c_char,
    cb: CGitJsonCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { git_json(git, path, cb, user_data, out_error, true) }
}

/// Local branches as a JSON object (`current`, `names`). Same ownership as
/// `boxlite_git_status`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_git_branches(
    git: *mut CBoxGitHandle,
    path: *const c_char,
    cb: CGitJsonCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { git_json(git, path, cb, user_data, out_error, false) }
}

unsafe fn git_json(
    git: *mut CBoxGitHandle,
    path: *const c_char,
    cb: CGitJsonCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
    status: bool,
) -> BoxliteErrorCode {
    unsafe {
        if git.is_null() {
            write_error(out_error, null_pointer_error("git"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let path = match c_str_to_string(path) {
            Ok(path) => path,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);
        let git_ref = &*git;
        let (handle, queue) = (git_ref.handle.clone(), git_ref.queue.clone());
        let user_data = user_data as usize;
        git_ref.tokio_rt.spawn(async move {
            let json = match status {
                true => handle
                    .status(&path)
                    .await
                    .map(|v| serde_json::to_string(&v)),
                false => handle
                    .branches(&path)
                    .await
                    .map(|v| serde_json::to_string(&v)),
            };
            let internal = |m: String| boxlite::BoxliteError::Internal(format!("git json: {m}"));
            let result = json.and_then(|j| {
                let j = j.map_err(|e| internal(e.to_string()))?;
                CString::new(j).map_err(|e| internal(e.to_string()))
            });
            let event = RuntimeEvent::GitJson {
                cb,
                user_data,
                result,
            };
            push_event(&queue, event).await;
        });
        BoxliteErrorCode::Ok
    }
}

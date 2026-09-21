//! Git operations for the BoxLite C SDK.

use std::ffi::CString;
use std::os::raw::{c_char, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::GitHandle as CoreGitHandle;

use crate::error::{BoxliteErrorCode, null_pointer_error, write_error};
use crate::event_queue::{CGitGetConfigCb, CGitWriteCb, EventQueue, RuntimeEvent, push_event};
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

/// Set `user.name` and `user.email`. Null `scope`/`path` use Rust defaults.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_git_configure_user(
    git: *mut CBoxGitHandle,
    name: *const c_char,
    email: *const c_char,
    scope: *const c_char,
    path: *const c_char,
    cb: CGitWriteCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if git.is_null() {
            write_error(out_error, null_pointer_error("git"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let name = match c_str_to_string(name) {
            Ok(name) => name,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let email = match c_str_to_string(email) {
            Ok(email) => email,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let scope = match optional_c_string(scope) {
            Ok(scope) => scope,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let path = match optional_c_string(path) {
            Ok(path) => path,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let git_ref = &*git;
        let handle = git_ref.handle.clone();
        let queue = git_ref.queue.clone();
        let user_data = user_data as usize;

        git_ref.tokio_rt.spawn(async move {
            let result = handle
                .configure_user(&name, &email, scope.as_deref(), path.as_deref())
                .await;
            push_event(
                &queue,
                RuntimeEvent::GitWrite {
                    cb,
                    user_data,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

/// Write a git config value. Null `scope`/`path` use Rust defaults.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_git_set_config(
    git: *mut CBoxGitHandle,
    key: *const c_char,
    value: *const c_char,
    scope: *const c_char,
    path: *const c_char,
    cb: CGitWriteCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if git.is_null() {
            write_error(out_error, null_pointer_error("git"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let key = match c_str_to_string(key) {
            Ok(key) => key,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let value = match c_str_to_string(value) {
            Ok(value) => value,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let scope = match optional_c_string(scope) {
            Ok(scope) => scope,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let path = match optional_c_string(path) {
            Ok(path) => path,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let git_ref = &*git;
        let handle = git_ref.handle.clone();
        let queue = git_ref.queue.clone();
        let user_data = user_data as usize;

        git_ref.tokio_rt.spawn(async move {
            let result = handle
                .set_config(&key, &value, scope.as_deref(), path.as_deref())
                .await;
            push_event(
                &queue,
                RuntimeEvent::GitWrite {
                    cb,
                    user_data,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

/// Read a git config value. On success the callback owns the string and must
/// release it with `boxlite_free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_git_get_config(
    git: *mut CBoxGitHandle,
    key: *const c_char,
    scope: *const c_char,
    path: *const c_char,
    cb: CGitGetConfigCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if git.is_null() {
            write_error(out_error, null_pointer_error("git"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let key = match c_str_to_string(key) {
            Ok(key) => key,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let scope = match optional_c_string(scope) {
            Ok(scope) => scope,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let path = match optional_c_string(path) {
            Ok(path) => path,
            Err(error) => {
                write_error(out_error, error);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);

        let git_ref = &*git;
        let handle = git_ref.handle.clone();
        let queue = git_ref.queue.clone();
        let user_data = user_data as usize;

        git_ref.tokio_rt.spawn(async move {
            let result = match handle
                .get_config(&key, scope.as_deref(), path.as_deref())
                .await
            {
                Ok(value) => CString::new(value).map_err(|_| {
                    boxlite::BoxliteError::Internal(
                        "git config value contains an interior NUL".into(),
                    )
                }),
                Err(error) => Err(error),
            };
            push_event(
                &queue,
                RuntimeEvent::GitGetConfig {
                    cb,
                    user_data,
                    result,
                },
            )
            .await;
        });

        BoxliteErrorCode::Ok
    }
}

unsafe fn optional_c_string(value: *const c_char) -> Result<Option<String>, boxlite::BoxliteError> {
    if value.is_null() {
        return Ok(None);
    }
    unsafe { c_str_to_string(value) }.map(Some)
}

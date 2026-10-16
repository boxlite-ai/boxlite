//! Registry logins for the BoxLite C SDK.
//!
//! `boxlite_registry_list`, `boxlite_registry_create` and
//! `boxlite_registry_remove` follow the post-and-drain pattern: each queues its
//! work, and the callback runs on the thread calling `boxlite_runtime_drain`.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxliteError;
use boxlite::runtime::{
    NewRegistryCredential, RegistryCredential, RegistryHandle as CoreRegistryHandle,
};

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{
    CBoxRegistryCreateCb, CBoxRegistryListCb, CBoxRegistryRemoveCb, EventQueue, OwnedFfiPtr,
    RuntimeEvent, push_event,
};
use crate::info::{free_raw_slice, into_raw_slice};
use crate::runtime::RuntimeLiveness;
use crate::{CBoxliteError, CBoxliteRegistryHandle};

/// Opaque handle to a REST runtime's registry logins, released with
/// `boxlite_registry_free`.
pub struct RegistryHandle {
    pub handle: CoreRegistryHandle,
    pub tokio_rt: Arc<TokioRuntime>,
    pub liveness: Arc<RuntimeLiveness>,
    pub queue: Arc<EventQueue>,
}

/// A registry login the server pulls private images with. It has no
/// password field: the server never returns one.
///
/// Every string is heap-owned and non-null except `created_by`, which is null
/// when the server does not know who added the login. `created_at` is in Unix
/// seconds (UTC). A standalone value is released with
/// `boxlite_free_registry_credential`; list entries belong to their list.
#[repr(C)]
pub struct CRegistryCredential {
    /// UUID that `boxlite_registry_remove` takes.
    pub id: *mut c_char,
    pub registry_host: *mut c_char,
    /// Whole path segments ending in "/"; empty for the whole registry.
    pub repository_prefix: *mut c_char,
    pub username: *mut c_char,
    pub created_by: *mut c_char,
    pub created_at: i64,
}

/// `count` logins at `items`, which is null only when `count` is zero.
/// Released, entries included, with `boxlite_free_registry_credential_list`.
#[repr(C)]
pub struct CRegistryCredentialList {
    pub items: *mut CRegistryCredential,
    pub count: c_int,
}

fn credential_string(value: &str, field: &str) -> Result<CString, BoxliteError> {
    CString::new(value).map_err(|_| {
        BoxliteError::Internal(format!("registry credential {field} contains a NUL byte"))
    })
}

impl CRegistryCredential {
    fn from_credential(credential: &RegistryCredential) -> Result<Self, BoxliteError> {
        // Keep ownership until every field is valid, so partial conversion cannot leak.
        let id = credential_string(&credential.id, "id")?;
        let registry_host = credential_string(&credential.registry_host, "registry_host")?;
        let repository_prefix =
            credential_string(&credential.repository_prefix, "repository_prefix")?;
        let username = credential_string(&credential.username, "username")?;
        let created_by = credential
            .created_by
            .as_deref()
            .map(|value| credential_string(value, "created_by"))
            .transpose()?;
        Ok(Self {
            id: id.into_raw(),
            registry_host: registry_host.into_raw(),
            repository_prefix: repository_prefix.into_raw(),
            username: username.into_raw(),
            created_by: created_by.map_or(ptr::null_mut(), CString::into_raw),
            created_at: credential.created_at.timestamp(),
        })
    }
}

unsafe fn free_str(s: *mut c_char) {
    if !s.is_null() {
        #[cfg(test)]
        crate::FREE_STR_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        unsafe {
            drop(CString::from_raw(s));
        }
    }
}

impl Drop for CRegistryCredential {
    fn drop(&mut self) {
        unsafe {
            free_str(self.id);
            free_str(self.registry_host);
            free_str(self.repository_prefix);
            free_str(self.username);
            free_str(self.created_by);
        }
    }
}

pub unsafe fn free_registry_credential(credential: *mut CRegistryCredential) {
    unsafe {
        if credential.is_null() {
            return;
        }
        drop(Box::from_raw(credential));
    }
}

pub unsafe fn free_registry_credential_list(list: *mut CRegistryCredentialList) {
    unsafe {
        if list.is_null() {
            return;
        }
        let list = Box::from_raw(list);
        free_raw_slice(list.items, list.count);
    }
}

/// Queue a read of every login the organization holds, oldest first.
///
/// `Ok` means the request was queued; the callback runs later on the thread
/// calling `boxlite_runtime_drain`. `user_data` is passed through unchanged
/// and must stay usable until the callback runs.
///
/// # Safety
///
/// `handle` and `cb` must be non-null. `out_error` may be null and otherwise
/// receives synchronous queueing failures only. A successful callback owns the
/// list and must release it with `boxlite_free_registry_credential_list`; the
/// error pointer is borrowed for the callback only.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_registry_list(
    handle: *mut CBoxliteRegistryHandle,
    cb: CBoxRegistryListCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe { registry_list(handle, cb, user_data, out_error) }
}

/// Queue adding a login, with the same dispatch contract as
/// [`boxlite_registry_list`].
///
/// `repository_prefix` is whole path segments ending in "/", such as "acme/",
/// or null for the whole registry. The strings are copied before this returns;
/// the password is sent once and never returned. A login already held for the
/// same registry and prefix reaches the callback as `AlreadyExists`.
///
/// # Safety
///
/// `handle`, `registry_host`, `username`, `password` and `cb` must be
/// non-null and UTF-8; `repository_prefix` may be null. `out_error` may be
/// null. A successful callback owns the login and must release it with
/// `boxlite_free_registry_credential`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_registry_create(
    handle: *mut CBoxliteRegistryHandle,
    registry_host: *const c_char,
    repository_prefix: *const c_char,
    username: *const c_char,
    password: *const c_char,
    cb: CBoxRegistryCreateCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        let login = match copy_login(registry_host, repository_prefix, username, password) {
            Ok(login) => login,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        registry_create(handle, login, cb, user_data, out_error)
    }
}

/// Queue removing a login by id, with the same dispatch contract as
/// [`boxlite_registry_list`].
///
/// An id that is not a UUID reaches the callback as `InvalidArgument` without
/// a request; a login a box still pulls through as `InvalidState`, naming the
/// boxes; an unknown id as `NotFound`.
///
/// # Safety
///
/// `handle`, `id` and `cb` must be non-null; `id` must be UTF-8 and only needs
/// to stay valid for this call. `out_error` may be null. The callback receives
/// only a borrowed error and has nothing to free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_registry_remove(
    handle: *mut CBoxliteRegistryHandle,
    id: *const c_char,
    cb: CBoxRegistryRemoveCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        let id = match copy_str(id, "id") {
            Ok(id) => id,
            Err(e) => {
                write_error(out_error, e);
                return BoxliteErrorCode::InvalidArgument;
            }
        };
        registry_remove(handle, id, cb, user_data, out_error)
    }
}

/// Free a handle returned by `boxlite_image_registries`.
///
/// # Safety
///
/// `handle` must be null or a pointer from `boxlite_image_registries` that
/// has not been freed. It must not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_registry_free(handle: *mut CBoxliteRegistryHandle) {
    if !handle.is_null() {
        unsafe { drop(Box::from_raw(handle)) };
    }
}

/// Free a login a create callback received.
///
/// # Safety
///
/// `credential` must be null or a pointer this library handed out that has
/// not been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_registry_credential(credential: *mut CRegistryCredential) {
    unsafe { free_registry_credential(credential) }
}

/// Free a list a list callback received, and every login in it.
///
/// # Safety
///
/// `list` must be null or a pointer this library handed out that has not been
/// freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_registry_credential_list(list: *mut CRegistryCredentialList) {
    unsafe { free_registry_credential_list(list) }
}

unsafe fn copy_str(value: *const c_char, what: &str) -> Result<String, BoxliteError> {
    if value.is_null() {
        return Err(null_pointer_error(what));
    }
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map(str::to_owned)
        // The error names the argument, never its bytes: one is a password.
        .map_err(|_| BoxliteError::InvalidArgument(format!("{what} is not UTF-8")))
}

unsafe fn copy_login(
    registry_host: *const c_char,
    repository_prefix: *const c_char,
    username: *const c_char,
    password: *const c_char,
) -> Result<NewRegistryCredential, BoxliteError> {
    unsafe {
        Ok(NewRegistryCredential {
            registry_host: copy_str(registry_host, "registry_host")?,
            repository_prefix: if repository_prefix.is_null() {
                None
            } else {
                Some(copy_str(repository_prefix, "repository_prefix")?)
            },
            username: copy_str(username, "username")?,
            password: copy_str(password, "password")?,
        })
    }
}

/// The handle behind `handle`, once it is non-null and its runtime is live.
unsafe fn live_handle<'a>(
    handle: *mut RegistryHandle,
    operation: &str,
    out_error: *mut FFIError,
) -> Result<&'a RegistryHandle, BoxliteErrorCode> {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return Err(BoxliteErrorCode::InvalidArgument);
        }
        let handle_ref = &*handle;
        if let Err(e) = crate::util::ensure_runtime_live(&handle_ref.liveness, operation) {
            let code = error_to_code(&e);
            write_error(out_error, e);
            return Err(code);
        }
        Ok(handle_ref)
    }
}

unsafe fn registry_list(
    handle: *mut RegistryHandle,
    cb: CBoxRegistryListCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        let handle_ref = match live_handle(handle, "list registry logins", out_error) {
            Ok(handle_ref) => handle_ref,
            Err(code) => return code,
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);
        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.list().await.and_then(|logins| {
                let (items, count) = into_raw_slice(
                    logins
                        .iter()
                        .map(CRegistryCredential::from_credential)
                        .collect::<Result<Vec<_>, _>>()?,
                );
                Ok(OwnedFfiPtr::new_with(
                    Box::new(CRegistryCredentialList { items, count }),
                    free_registry_credential_list,
                ))
            });
            push_event(
                &queue,
                RuntimeEvent::RegistryList {
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

unsafe fn registry_create(
    handle: *mut RegistryHandle,
    login: NewRegistryCredential,
    cb: CBoxRegistryCreateCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        let handle_ref = match live_handle(handle, "add a registry login", out_error) {
            Ok(handle_ref) => handle_ref,
            Err(code) => return code,
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);
        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.create(&login).await.and_then(|created| {
                Ok(OwnedFfiPtr::new_with(
                    Box::new(CRegistryCredential::from_credential(&created)?),
                    free_registry_credential,
                ))
            });
            push_event(
                &queue,
                RuntimeEvent::RegistryCreate {
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

unsafe fn registry_remove(
    handle: *mut RegistryHandle,
    id: String,
    cb: CBoxRegistryRemoveCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        let handle_ref = match live_handle(handle, "remove a registry login", out_error) {
            Ok(handle_ref) => handle_ref,
            Err(code) => return code,
        };
        let cb = crate::unwrap_cb_or_return!(cb, out_error);
        let core_handle = handle_ref.handle.clone();
        let queue = handle_ref.queue.clone();
        let user_data = user_data as usize;

        handle_ref.tokio_rt.spawn(async move {
            let result = core_handle.remove(&id).await;
            push_event(
                &queue,
                RuntimeEvent::RegistryRemove {
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::*;

    fn login(created_by: Option<&str>) -> RegistryCredential {
        RegistryCredential {
            id: "0aaa0000-0000-4000-8000-000000000001".into(),
            registry_host: "ghcr.io".into(),
            repository_prefix: "acme/".into(),
            username: "acme-bot".into(),
            created_by: created_by.map(str::to_string),
            created_at: Default::default(),
        }
    }

    #[test]
    fn registry_strings_reject_interior_nul() {
        let _guard = crate::FREE_STR_LOCK.lock().unwrap();
        let mut accepted = Vec::new();
        for field in [
            "id",
            "registry_host",
            "repository_prefix",
            "username",
            "created_by",
        ] {
            let mut credential = login(Some("user-1"));
            let value = match field {
                "id" => &mut credential.id,
                "registry_host" => &mut credential.registry_host,
                "repository_prefix" => &mut credential.repository_prefix,
                "username" => &mut credential.username,
                _ => credential.created_by.as_mut().unwrap(),
            };
            value.push('\0');
            match CRegistryCredential::from_credential(&credential) {
                Ok(converted) => {
                    accepted.push(field);
                    unsafe { free_registry_credential(Box::into_raw(Box::new(converted))) };
                }
                Err(error) => {
                    assert!(matches!(error, BoxliteError::Internal(_)));
                    assert!(error.to_string().contains(field));
                }
            }
        }
        assert!(accepted.is_empty(), "accepted invalid fields: {accepted:?}");

        let before = crate::FREE_STR_CALLS.load(Ordering::SeqCst);
        let logins = [login(Some("user-1")), login(Some("invalid\0actor"))];
        let result = logins
            .iter()
            .map(CRegistryCredential::from_credential)
            .collect::<Result<Vec<_>, _>>();
        assert!(
            result.is_err(),
            "a malformed list entry must fail the whole list"
        );
        assert_eq!(crate::FREE_STR_CALLS.load(Ordering::SeqCst) - before, 5);
    }

    /// An event dropped before dispatch, as on shutdown, frees every string
    /// it holds, the optional `created_by` included.
    #[test]
    fn undelivered_logins_free_every_string() {
        let _guard = crate::FREE_STR_LOCK.lock().unwrap();
        let before = crate::FREE_STR_CALLS.load(Ordering::SeqCst);

        drop(OwnedFfiPtr::new_with(
            Box::new(CRegistryCredential::from_credential(&login(Some("user-1"))).unwrap()),
            free_registry_credential,
        ));
        let logins = [login(None), login(Some("user-1"))];
        let (items, count) = into_raw_slice(
            logins
                .iter()
                .map(CRegistryCredential::from_credential)
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
        );
        drop(OwnedFfiPtr::new_with(
            Box::new(CRegistryCredentialList { items, count }),
            free_registry_credential_list,
        ));

        let freed = crate::FREE_STR_CALLS.load(Ordering::SeqCst) - before;
        assert_eq!(freed, 5 + 4 + 5, "freed {freed} strings");
    }
}

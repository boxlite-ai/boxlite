//! Additive C ABI for guarded Cloud proxy management.

use std::{ffi::CString, os::raw::c_char, ptr, sync::Arc};

use boxlite::{
    BoxliteError, BoxliteResult, ManagedCreateAdmission, ProxyCredential, ProxyCredentialChange,
    ProxyMutation, ProxyMutationState,
};

use crate::{
    CBoxHandle, CBoxNetworkHandle, CBoxliteError, CBoxliteOptions, CBoxliteRuntime,
    box_handle::BoxHandle,
    error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error},
    util::{c_str_to_string, ensure_runtime_live},
};

#[allow(clippy::enum_variant_names, reason = "C enumerators share a namespace")]
#[repr(C)]
pub enum CProxyMutationState {
    ProxyRejected = 0,
    ProxyAccepted = 1,
    ProxyUnknown = 2,
    ProxyAcceptedReleaseUnconfirmed = 3,
}

/// Outcome of a single registry or binding write. Free revision with boxlite_free_string.
#[repr(C)]
pub struct CProxyMutation {
    pub state: CProxyMutationState,
    pub http_status: u16,
    pub revision: *mut c_char,
}

impl From<ProxyMutation> for CProxyMutation {
    fn from(result: ProxyMutation) -> Self {
        let state = match result.state {
            ProxyMutationState::Rejected => CProxyMutationState::ProxyRejected,
            ProxyMutationState::Accepted => CProxyMutationState::ProxyAccepted,
            ProxyMutationState::Unknown => CProxyMutationState::ProxyUnknown,
            ProxyMutationState::AcceptedReleaseUnconfirmed => {
                CProxyMutationState::ProxyAcceptedReleaseUnconfirmed
            }
        };
        let revision = result.revision.as_ref().map(|value| value.as_str());
        Self {
            state,
            http_status: result.http_status.unwrap_or(0),
            revision: owned_string(revision),
        }
    }
}

#[allow(clippy::enum_variant_names, reason = "C enumerators share a namespace")]
#[repr(C)]
pub enum CManagedCreateAdmission {
    ManagedCreateRejected = 0,
    ManagedCreateAdmitted = 1,
    ManagedCreateUnknown = 2,
}

/// Admission evidence on a failed create. Free box_id with boxlite_free_string.
#[repr(C)]
pub struct CManagedCreateOutcome {
    pub admission: CManagedCreateAdmission,
    pub http_status: u16,
    pub box_id: *mut c_char,
}

fn owned_string(value: Option<&str>) -> *mut c_char {
    value
        .and_then(|value| CString::new(value).ok())
        .map_or(ptr::null_mut(), CString::into_raw)
}

fn complete(result: BoxliteResult<()>, out_error: *mut CBoxliteError) -> BoxliteErrorCode {
    match result {
        Ok(()) => BoxliteErrorCode::Ok,
        Err(error) => {
            let code = error_to_code(&error);
            unsafe { write_error(out_error, error) };
            code
        }
    }
}

unsafe fn optional_string(value: *const c_char) -> BoxliteResult<Option<String>> {
    (!value.is_null())
        .then(|| unsafe { c_str_to_string(value) })
        .transpose()
}

unsafe fn credential(
    username: *const c_char,
    password: *const c_char,
) -> BoxliteResult<Option<ProxyCredential>> {
    if username.is_null() && password.is_null() {
        return Ok(None);
    }
    let username = unsafe { c_str_to_string(username) }?;
    let password = unsafe { c_str_to_string(password) }?;
    ProxyCredential::new(username, password).map(Some)
}

fn json_string(value: &impl serde::Serialize) -> BoxliteResult<*mut c_char> {
    let json = serde_json::to_vec(value)
        .map_err(|_| BoxliteError::Internal("serialize public proxy response".into()))?;
    CString::new(json)
        .map(CString::into_raw)
        .map_err(|_| BoxliteError::Internal("invalid public proxy response".into()))
}

/// Read a public registry item, or list when name is NULL. Free *out_json with boxlite_free_string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_outbound_proxy_read(
    runtime: *mut CBoxliteRuntime,
    name: *const c_char,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let result = (|| unsafe {
        let out_json = out_json
            .as_mut()
            .ok_or_else(|| null_pointer_error("out_json"))?;
        *out_json = ptr::null_mut();
        let runtime = runtime
            .as_ref()
            .ok_or_else(|| null_pointer_error("runtime"))?;
        ensure_runtime_live(&runtime.liveness, "read outbound proxies")?;
        let registry = runtime.runtime.outbound_proxies()?;
        *out_json = match optional_string(name)? {
            Some(name) => json_string(&runtime.tokio_rt.block_on(registry.get(&name))?)?,
            None => json_string(&runtime.tokio_rt.block_on(registry.list())?)?,
        };
        Ok(())
    })();
    complete(result, out_error)
}

unsafe fn mutate_registry(
    runtime: *mut CBoxliteRuntime,
    out: *mut CProxyMutation,
    mutate: impl FnOnce(&CBoxliteRuntime, boxlite::OutboundProxyHandle) -> BoxliteResult<ProxyMutation>,
) -> BoxliteResult<()> {
    let out = unsafe { out.as_mut() }.ok_or_else(|| null_pointer_error("out"))?;
    *out = CProxyMutation {
        state: CProxyMutationState::ProxyRejected,
        http_status: 0,
        revision: ptr::null_mut(),
    };
    let runtime = unsafe { runtime.as_ref() }.ok_or_else(|| null_pointer_error("runtime"))?;
    ensure_runtime_live(&runtime.liveness, "modify outbound proxies")?;
    *out = mutate(runtime, runtime.runtime.outbound_proxies()?)?.into();
    Ok(())
}

/// Register an endpoint. Username and password must both be NULL or both be set.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_outbound_proxy_create(
    runtime: *mut CBoxliteRuntime,
    name: *const c_char,
    url: *const c_char,
    username: *const c_char,
    password: *const c_char,
    out: *mut CProxyMutation,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let result = unsafe {
        mutate_registry(runtime, out, |runtime, registry| {
            let name = c_str_to_string(name)?;
            let url = c_str_to_string(url)?;
            let credential = credential(username, password)?;
            runtime
                .tokio_rt
                .block_on(registry.create(&name, &url, credential.as_ref()))
        })
    };
    complete(result, out_error)
}

/// PATCH an endpoint. NULL url preserves it. Set clear_credential to 1 to clear both fields.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_outbound_proxy_update(
    runtime: *mut CBoxliteRuntime,
    name: *const c_char,
    url: *const c_char,
    username: *const c_char,
    password: *const c_char,
    clear_credential: u8,
    out: *mut CProxyMutation,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let result = unsafe {
        mutate_registry(runtime, out, |runtime, registry| {
            let name = c_str_to_string(name)?;
            let url = optional_string(url)?;
            let replacement = credential(username, password)?;
            let change = match (clear_credential, replacement) {
                (0, None) => ProxyCredentialChange::Keep,
                (0, Some(credential)) => ProxyCredentialChange::Set(credential),
                (1, None) => ProxyCredentialChange::Clear,
                _ => {
                    return Err(BoxliteError::InvalidArgument(
                        "choose either to clear or replace the proxy credential".into(),
                    ));
                }
            };
            runtime
                .tokio_rt
                .block_on(registry.update(&name, url.as_deref(), change))
        })
    };
    complete(result, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_outbound_proxy_delete(
    runtime: *mut CBoxliteRuntime,
    name: *const c_char,
    out: *mut CProxyMutation,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let result = unsafe {
        mutate_registry(runtime, out, |runtime, registry| {
            let name = c_str_to_string(name)?;
            runtime.tokio_rt.block_on(registry.remove(&name))
        })
    };
    complete(result, out_error)
}

/// Bind by name; NULL requests unbind. The outcome retains the acknowledged revision.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_network_set_managed_proxy(
    network: *mut CBoxNetworkHandle,
    name: *const c_char,
    out: *mut CProxyMutation,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let result = (|| unsafe {
        let out = out.as_mut().ok_or_else(|| null_pointer_error("out"))?;
        *out = CProxyMutation {
            state: CProxyMutationState::ProxyRejected,
            http_status: 0,
            revision: ptr::null_mut(),
        };
        let network = network
            .as_ref()
            .ok_or_else(|| null_pointer_error("network"))?;
        let name = optional_string(name)?;
        *out = network
            .tokio_rt
            .block_on(network.handle.set_managed_proxy(name.as_deref()))?
            .into();
        Ok(())
    })();
    complete(result, out_error)
}

/// Read public binding status. Free *out_json with boxlite_free_string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_network_managed_proxy_status(
    network: *mut CBoxNetworkHandle,
    out_json: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let result = (|| unsafe {
        let out_json = out_json
            .as_mut()
            .ok_or_else(|| null_pointer_error("out_json"))?;
        *out_json = ptr::null_mut();
        let network = network
            .as_ref()
            .ok_or_else(|| null_pointer_error("network"))?;
        *out_json = json_string(
            &network
                .tokio_rt
                .block_on(network.handle.managed_proxy_status())?,
        )?;
        Ok(())
    })();
    complete(result, out_error)
}

/// Blocking Cloud create with explicit selection. NULL proxy is explicit unbound.
/// Options remain caller-owned. Free a returned box ID with boxlite_free_string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_create_box_with_managed_proxy(
    runtime: *mut CBoxliteRuntime,
    options: *const CBoxliteOptions,
    proxy: *const c_char,
    out_box: *mut *mut CBoxHandle,
    out: *mut CManagedCreateOutcome,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    let result = (|| unsafe {
        if let Some(handle) = out_box.as_mut() {
            *handle = ptr::null_mut();
        }
        if let Some(outcome) = out.as_mut() {
            *outcome = CManagedCreateOutcome {
                admission: CManagedCreateAdmission::ManagedCreateRejected,
                http_status: 0,
                box_id: ptr::null_mut(),
            };
        }
        let out_box = out_box
            .as_mut()
            .ok_or_else(|| null_pointer_error("out_box"))?;
        let out = out.as_mut().ok_or_else(|| null_pointer_error("out"))?;
        let runtime = runtime
            .as_ref()
            .ok_or_else(|| null_pointer_error("runtime"))?;
        ensure_runtime_live(&runtime.liveness, "create a Box with a managed proxy")?;
        let options = options
            .as_ref()
            .ok_or_else(|| null_pointer_error("options"))?;
        options.validate_checkpoint()?;
        let proxy = optional_string(proxy)?;
        match runtime
            .tokio_rt
            .block_on(runtime.runtime.create_with_managed_outbound_proxy(
                options.options.clone(),
                options.name.clone(),
                proxy.as_deref(),
            )) {
            Ok(handle) => {
                out.admission = CManagedCreateAdmission::ManagedCreateAdmitted;
                *out_box = Box::into_raw(Box::new(BoxHandle {
                    box_id: handle.id().clone(),
                    handle: Arc::new(handle),
                    tokio_rt: runtime.tokio_rt.clone(),
                    queue: runtime.queue.clone(),
                }));
                Ok(())
            }
            Err(error) => {
                out.admission = match error.admission {
                    ManagedCreateAdmission::Rejected => {
                        CManagedCreateAdmission::ManagedCreateRejected
                    }
                    ManagedCreateAdmission::Admitted => {
                        CManagedCreateAdmission::ManagedCreateAdmitted
                    }
                    ManagedCreateAdmission::Unknown => {
                        CManagedCreateAdmission::ManagedCreateUnknown
                    }
                };
                out.http_status = error.http_status.unwrap_or(0);
                out.box_id = owned_string(error.box_id.as_ref().map(|id| id.as_str()));
                Err(error.source)
            }
        }
    })();
    complete(result, out_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event_queue::EventQueue;
    use crate::runtime::{RuntimeLiveness, create_tokio_runtime};
    use std::ffi::c_void;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};

    extern "C" fn shutdown_completed(_: *mut CBoxliteError, _: *mut c_void) {}

    #[test]
    fn c_managed_outbound_fails_after_runtime_shutdown_without_dispatch() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let origin = format!("https://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let tokio_rt = create_tokio_runtime().unwrap();
        let listener = {
            let _guard = tokio_rt.enter();
            tokio::net::TcpListener::from_std(listener).unwrap()
        };
        let accepted = Arc::new(AtomicUsize::new(0));
        let observed = accepted.clone();
        let observer = tokio_rt.spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                observed.fetch_add(1, Ordering::Relaxed);
                drop(stream);
            }
        });
        let mut runtime = CBoxliteRuntime {
            runtime: boxlite::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(origin))
                .unwrap(),
            tokio_rt,
            liveness: Arc::new(RuntimeLiveness::new()),
            queue: Arc::new(EventQueue::new()),
        };
        let mut options = ptr::null_mut();
        let mut json = ptr::null_mut();
        let mut outcome = CProxyMutation {
            state: CProxyMutationState::ProxyAccepted,
            http_status: 200,
            revision: ptr::null_mut(),
        };
        let mut creation = CManagedCreateOutcome {
            admission: CManagedCreateAdmission::ManagedCreateAdmitted,
            http_status: 201,
            box_id: ptr::null_mut(),
        };
        let mut handle = ptr::null_mut();
        let name = c"build-egress".as_ptr();
        let endpoint = c"https://proxy.example".as_ptr();
        let statuses = unsafe {
            assert_eq!(
                crate::boxlite_options_new(
                    c"alpine:latest".as_ptr(),
                    &mut options,
                    ptr::null_mut()
                ),
                BoxliteErrorCode::Ok
            );
            assert_eq!(
                crate::boxlite_runtime_shutdown(
                    &mut runtime,
                    0,
                    Some(shutdown_completed),
                    ptr::null_mut(),
                    ptr::null_mut(),
                ),
                BoxliteErrorCode::Ok
            );
            let statuses = [
                boxlite_outbound_proxy_read(&mut runtime, name, &mut json, ptr::null_mut()),
                boxlite_outbound_proxy_create(
                    &mut runtime,
                    name,
                    endpoint,
                    ptr::null(),
                    ptr::null(),
                    &mut outcome,
                    ptr::null_mut(),
                ),
                boxlite_outbound_proxy_update(
                    &mut runtime,
                    name,
                    endpoint,
                    ptr::null(),
                    ptr::null(),
                    0,
                    &mut outcome,
                    ptr::null_mut(),
                ),
                boxlite_outbound_proxy_delete(&mut runtime, name, &mut outcome, ptr::null_mut()),
                boxlite_create_box_with_managed_proxy(
                    &mut runtime,
                    options,
                    name,
                    &mut handle,
                    &mut creation,
                    ptr::null_mut(),
                ),
            ];
            crate::boxlite_options_free(options);
            statuses
        };
        observer.abort();
        assert_eq!(statuses, [BoxliteErrorCode::Stopped; 5]);
        assert_eq!(accepted.load(Ordering::Relaxed), 0);
        assert!(json.is_null());
        assert!(matches!(outcome.state, CProxyMutationState::ProxyRejected));
        assert_eq!(outcome.http_status, 0);
        assert!(outcome.revision.is_null());
        assert!(matches!(
            creation.admission,
            CManagedCreateAdmission::ManagedCreateRejected
        ));
        assert_eq!(creation.http_status, 0);
        assert!(creation.box_id.is_null());
        assert!(handle.is_null());
    }
}

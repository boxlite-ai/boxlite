//! The organization's domains for the BoxLite C SDK.
//!
//! `boxlite_domain_list`, `boxlite_domain_bind` and `boxlite_domain_unbind`
//! run synchronously on the runtime's Tokio runtime, like
//! `boxlite_network_tunnel`: each is one REST request, so the post-and-drain
//! callbacks the registry calls use would add three event kinds for nothing.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxliteError;
use boxlite::runtime::{Domain, DomainHandle as CoreDomainHandle, DomainList, DomainTarget};

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::info::{free_raw_slice, into_raw_slice};
use crate::runtime::{RuntimeHandle, RuntimeLiveness};
use crate::{CBoxliteDomainHandle, CBoxliteError, CBoxliteRuntime};

/// Opaque handle to a REST runtime's domains, released with
/// `boxlite_free_domain_handle`.
pub struct DomainHandle {
    pub handle: CoreDomainHandle,
    pub tokio_rt: Arc<TokioRuntime>,
    pub liveness: Arc<RuntimeLiveness>,
}

/// The kinds of target a domain can route to; `CDomainTarget.type` holds one.
/// `type` is an `int32_t` there because a C caller can pass any value.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoxliteDomainTargetType {
    BoxliteDomainTargetBox = 0,
}

/// What a domain routes to. For `BoxliteDomainTargetBox`, `box` is a box id or
/// name and `port` a guest port. Passed in, the strings are borrowed for the
/// call; inside a `CDomain`, they belong to it.
///
/// cbindgen:field-names=[type, box, port]
#[repr(C)]
pub struct CDomainTarget {
    pub kind: i32,
    pub box_ref: *const c_char,
    pub port: u16,
}

/// A domain the organization holds. Strings are heap-owned and non-null,
/// except `target.box`, which is null while the domain is unbound. Released
/// with `boxlite_free_domain`; list entries belong to their list.
#[repr(C)]
pub struct CDomain {
    /// What the domain is bound by: the label of a platform name.
    pub name: *mut c_char,
    pub hostname: *mut c_char,
    pub url: *mut c_char,
    pub target: CDomainTarget,
}

/// `count` domains at `items` (null only when `count` is zero), with the
/// allowance they count against. Released, entries included, with
/// `boxlite_free_domain_list`.
#[repr(C)]
pub struct CDomainList {
    pub items: *mut CDomain,
    pub count: c_int,
    pub limit: u32,
    pub used: u32,
    pub remaining: u32,
    /// The shortest platform name a new claim may use.
    pub min_length: u32,
}

fn owned(value: &str, field: &str) -> Result<CString, BoxliteError> {
    CString::new(value)
        .map_err(|_| BoxliteError::Internal(format!("domain {field} contains a NUL byte")))
}

impl CDomain {
    fn from_domain(domain: Domain) -> Result<Self, BoxliteError> {
        // Keep ownership until every field is valid, so a failure cannot leak.
        let name = owned(&domain.name, "name")?;
        let hostname = owned(&domain.hostname, "hostname")?;
        let url = owned(&domain.url, "url")?;
        let (box_ref, port) = match domain.target {
            Some(DomainTarget::Box { box_ref, port }) => (Some(owned(&box_ref, "box")?), port),
            Some(other) => {
                return Err(BoxliteError::Unsupported(format!(
                    "domain target {other:?} is newer than this SDK"
                )));
            }
            None => (None, 0),
        };
        Ok(Self {
            name: name.into_raw(),
            hostname: hostname.into_raw(),
            url: url.into_raw(),
            target: CDomainTarget {
                kind: BoxliteDomainTargetType::BoxliteDomainTargetBox as i32,
                box_ref: box_ref.map_or(ptr::null(), |value| value.into_raw().cast_const()),
                port,
            },
        })
    }
}

unsafe fn free_str(value: *mut c_char) {
    if !value.is_null() {
        #[cfg(test)]
        crate::FREE_STR_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        unsafe { drop(CString::from_raw(value)) };
    }
}

impl Drop for CDomain {
    fn drop(&mut self) {
        unsafe {
            free_str(self.name);
            free_str(self.hostname);
            free_str(self.url);
            free_str(self.target.box_ref.cast_mut());
        }
    }
}

impl CDomainList {
    fn from_list(held: DomainList) -> Result<Self, BoxliteError> {
        let items = held
            .domains
            .into_iter()
            .map(CDomain::from_domain)
            .collect::<Result<Vec<_>, _>>()?;
        let (items, count) = into_raw_slice(items);
        Ok(Self {
            items,
            count,
            limit: held.limit,
            used: held.used,
            remaining: held.remaining,
            min_length: held.min_length,
        })
    }
}

unsafe fn copy_str(value: *const c_char, what: &str) -> Result<String, BoxliteError> {
    if value.is_null() {
        return Err(null_pointer_error(what));
    }
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map(str::to_owned)
        .map_err(|_| BoxliteError::InvalidArgument(format!("{what} is not UTF-8")))
}

unsafe fn copy_target(target: *const CDomainTarget) -> Result<DomainTarget, BoxliteError> {
    if target.is_null() {
        return Err(null_pointer_error("target"));
    }
    let target = unsafe { &*target };
    if target.kind != BoxliteDomainTargetType::BoxliteDomainTargetBox as i32 {
        return Err(BoxliteError::InvalidArgument(format!(
            "unsupported domain target type {}",
            target.kind
        )));
    }
    Ok(DomainTarget::Box {
        box_ref: unsafe { copy_str(target.box_ref, "target.box") }?,
        port: target.port,
    })
}

/// Run `operation` on the handle's runtime, writing any error out. `out` is
/// checked and cleared before the call so a failure never leaves a stale value.
unsafe fn run<T>(
    handle: *mut DomainHandle,
    out_error: *mut FFIError,
    operation: impl FnOnce(&DomainHandle) -> Result<T, BoxliteError>,
) -> Result<T, BoxliteErrorCode> {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return Err(BoxliteErrorCode::InvalidArgument);
        }
        let handle = &*handle;
        let result = crate::util::ensure_runtime_live(&handle.liveness, "access domains")
            .and_then(|()| operation(handle));
        result.map_err(|error| {
            let code = error_to_code(&error);
            write_error(out_error, error);
            code
        })
    }
}

/// Get the organization's domains from a REST runtime. A local runtime
/// answers `Unsupported`. Release the handle with `boxlite_free_domain_handle`.
///
/// # Safety
///
/// `runtime` and `out_handle` must be non-null; `out_error` may be null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_domains(
    runtime: *mut CBoxliteRuntime,
    out_handle: *mut *mut CBoxliteDomainHandle,
    out_error: *mut CBoxliteError,
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
        *out_handle = ptr::null_mut();
        let runtime_ref: &RuntimeHandle = &*runtime;
        let handle = crate::util::ensure_runtime_live(&runtime_ref.liveness, "access domains")
            .and_then(|()| runtime_ref.runtime.domains());
        match handle {
            Ok(handle) => {
                *out_handle = Box::into_raw(Box::new(DomainHandle {
                    handle,
                    tokio_rt: runtime_ref.tokio_rt.clone(),
                    liveness: runtime_ref.liveness.clone(),
                }));
                BoxliteErrorCode::Ok
            }
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                code
            }
        }
    }
}

/// List every domain the organization holds, unbound ones included, with the
/// allowance. On `Ok`, `*out_list` must be released with
/// `boxlite_free_domain_list`.
///
/// # Safety
///
/// `handle` and `out_list` must be non-null; `out_error` may be null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_domain_list(
    handle: *mut CBoxliteDomainHandle,
    out_list: *mut *mut CDomainList,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if out_list.is_null() {
            write_error(out_error, null_pointer_error("out_list"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_list = ptr::null_mut();
        match run(handle, out_error, |handle| {
            let held = handle.tokio_rt.block_on(handle.handle.list())?;
            CDomainList::from_list(held)
        }) {
            Ok(list) => {
                *out_list = Box::into_raw(Box::new(list));
                BoxliteErrorCode::Ok
            }
            Err(code) => code,
        }
    }
}

/// Route `domain` (a platform name such as "demo", or its full hostname) to
/// `target`, claiming it if new. A domain bound elsewhere in the organization
/// moves. On `Ok`, `*out_domain` must be released with `boxlite_free_domain`.
///
/// # Safety
///
/// `handle`, `domain`, `target`, `target->box` and `out_domain` must be
/// non-null and the strings UTF-8; they only need to stay valid for this
/// call. `out_error` may be null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_domain_bind(
    handle: *mut CBoxliteDomainHandle,
    domain: *const c_char,
    target: *const CDomainTarget,
    out_domain: *mut *mut CDomain,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if out_domain.is_null() {
            write_error(out_error, null_pointer_error("out_domain"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_domain = ptr::null_mut();
        match run(handle, out_error, |handle| {
            let domain = copy_str(domain, "domain")?;
            let target = copy_target(target)?;
            let bound = handle
                .tokio_rt
                .block_on(handle.handle.bind(&domain, &target))?;
            CDomain::from_domain(bound)
        }) {
            Ok(bound) => {
                *out_domain = Box::into_raw(Box::new(bound));
                BoxliteErrorCode::Ok
            }
            Err(code) => code,
        }
    }
}

/// Stop routing `domain`, keeping it for the organization. Safe to repeat; a
/// domain the organization does not hold is `NotFound`.
///
/// # Safety
///
/// `handle` and `domain` must be non-null; `domain` must be UTF-8 and only
/// needs to stay valid for this call. `out_error` may be null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_domain_unbind(
    handle: *mut CBoxliteDomainHandle,
    domain: *const c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        match run(handle, out_error, |handle| {
            let domain = copy_str(domain, "domain")?;
            handle.tokio_rt.block_on(handle.handle.unbind(&domain))
        }) {
            Ok(()) => BoxliteErrorCode::Ok,
            Err(code) => code,
        }
    }
}

/// Free the local management handle returned by `boxlite_runtime_domains`.
/// Existing domain bindings are unaffected.
///
/// # Safety
///
/// `handle` must be null or a pointer from `boxlite_runtime_domains` that has
/// not been freed. It must not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_domain_handle(handle: *mut CBoxliteDomainHandle) {
    if !handle.is_null() {
        unsafe { drop(Box::from_raw(handle)) };
    }
}

/// Free a domain `boxlite_domain_bind` returned.
///
/// # Safety
///
/// `domain` must be null or a pointer this library handed out that has not
/// been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_domain(domain: *mut CDomain) {
    if !domain.is_null() {
        unsafe { drop(Box::from_raw(domain)) };
    }
}

/// Free a list `boxlite_domain_list` returned, and every domain in it.
///
/// # Safety
///
/// `list` must be null or a pointer this library handed out that has not been
/// freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_domain_list(list: *mut CDomainList) {
    if !list.is_null() {
        let list = unsafe { Box::from_raw(list) };
        unsafe { free_raw_slice(list.items, list.count) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unbound_domain_has_a_null_target_box_and_frees_cleanly() {
        let domain = CDomain::from_domain(Domain {
            name: "spare".into(),
            hostname: "spare.app.test".into(),
            url: "https://spare.app.test".into(),
            target: None,
        })
        .unwrap();
        assert!(domain.target.box_ref.is_null());
        assert_eq!(domain.target.port, 0);
        unsafe { boxlite_free_domain(Box::into_raw(Box::new(domain))) };
    }

    #[test]
    fn a_target_of_unknown_type_is_refused_before_any_request() {
        let box_ref = CString::new("web-a").unwrap();
        let target = CDomainTarget {
            kind: 7,
            box_ref: box_ref.as_ptr(),
            port: 3000,
        };
        assert!(matches!(
            unsafe { copy_target(&target) },
            Err(BoxliteError::InvalidArgument(_))
        ));
        let target = CDomainTarget {
            kind: BoxliteDomainTargetType::BoxliteDomainTargetBox as i32,
            ..target
        };
        assert_eq!(
            unsafe { copy_target(&target) }.unwrap(),
            DomainTarget::Box {
                box_ref: "web-a".into(),
                port: 3000
            }
        );
    }

    #[test]
    fn null_arguments_are_invalid_and_clear_the_output() {
        let mut out = ptr::dangling_mut::<CDomainList>();
        let code = unsafe { boxlite_domain_list(ptr::null_mut(), &mut out, ptr::null_mut()) };
        assert_eq!(code, BoxliteErrorCode::InvalidArgument);
        assert!(out.is_null());
    }
}

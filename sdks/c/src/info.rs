//! Box information types and operations for the BoxLite C SDK.
//!
//! All info operations are async and use the runtime's post-and-drain callback
//! queue.

use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;

use boxlite::BoxliteError;
use boxlite::runtime::options::{NetworkMode, PortProtocol};
use boxlite::runtime::types::{BoxStatus, PublishedPort};

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::event_queue::{CBoxInfoCb, CBoxInfoListCb, RuntimeEvent, push_event};
use crate::options::BoxlitePortProtocol;
use crate::runtime::RuntimeHandle;
use crate::{CBoxHandle, CBoxliteError, CBoxliteRuntime};

/// Network mode exposed by [`CNetworkInfo`].
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoxliteNetworkMode {
    BoxliteNetworkModeEnabled = 0,
    BoxliteNetworkModeDisabled = 1,
}

/// A concrete host listener published to a guest port.
///
/// `host_ip` is owned by the enclosing [`CBoxInfo`].
#[repr(C)]
pub struct CPublishedPort {
    pub guest_port: u16,
    pub host_ip: *mut c_char,
    pub host_port: u16,
    pub protocol: BoxlitePortProtocol,
}

/// Owned list of concrete published ports.
///
/// A non-null list with `count == 0` means publication metadata was resolved
/// and no listeners are active. The list is owned by its enclosing
/// [`CNetworkInfo`].
#[repr(C)]
pub struct CPublishedPortList {
    pub items: *mut CPublishedPort,
    pub count: c_int,
}

/// Typed network metadata owned by an enclosing [`CBoxInfo`].
///
/// `allow_net` points to `allow_net_count` owned strings. `published_ports`
/// is null when the current handle does not know the bindings, non-null and
/// empty when there are no active publications, and otherwise contains
/// concrete bindings.
#[repr(C)]
pub struct CNetworkInfo {
    pub mode: BoxliteNetworkMode,
    pub allow_net: *mut *mut c_char,
    pub allow_net_count: c_int,
    pub published_ports: *mut CPublishedPortList,
}

#[repr(C)]
pub struct CBoxInfo {
    pub id: *mut c_char,
    pub name: *mut c_char,
    pub image: *mut c_char,
    pub status: *mut c_char,
    pub running: c_int,
    pub pid: c_int,
    pub cpus: c_int,
    pub memory_mib: c_int,
    pub auto_stop: u32,
    pub auto_delete: u32,
    pub auto_resume: c_int,
    pub created_at: i64,
    /// Owned typed network metadata; null when network metadata is unavailable.
    pub network: *mut CNetworkInfo,
    /// Unix milliseconds of the most recently recorded successful guest
    /// `Container.Start`; `0` when none was recorded. Preserved after stop or
    /// reboot; when [`Self::pid`] is nonzero, the timestamp describes that live
    /// PID. Milliseconds — not `created_at`'s seconds — preserve sub-second
    /// ordering against a job's timeline.
    pub started_at: i64,
    /// Init exit code, when the box stopped because its command exited. Read it
    /// only when [`Self::has_exit_code`] is nonzero — `0` is a valid exit code,
    /// so it cannot double as "none recorded" the way [`Self::pid`] does.
    pub exit_code: c_int,
    /// Nonzero when [`Self::exit_code`] holds a recorded exit code.
    pub has_exit_code: c_int,
}

#[repr(C)]
pub struct CBoxInfoList {
    pub items: *mut CBoxInfo,
    pub count: c_int,
}

fn to_c_str(s: &str) -> *mut c_char {
    CString::new(s)
        .map(|c| c.into_raw())
        .unwrap_or(ptr::null_mut())
}

fn into_raw_slice<T>(items: Vec<T>) -> (*mut T, c_int) {
    let count = c_int::try_from(items.len()).expect("C metadata list exceeds c_int::MAX");
    if items.is_empty() {
        return (ptr::null_mut(), 0);
    }

    let mut items = items.into_boxed_slice();
    let items_ptr = items.as_mut_ptr();
    std::mem::forget(items);
    (items_ptr, count)
}

unsafe fn free_raw_slice<T>(items: *mut T, count: c_int) {
    if items.is_null() || count < 0 {
        return;
    }
    unsafe {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
            items,
            count as usize,
        )));
    }
}

impl CPublishedPort {
    fn from_published_port(port: &PublishedPort) -> Self {
        Self {
            guest_port: port.guest_port,
            host_ip: to_c_str(&port.host_ip),
            host_port: port.host_port,
            protocol: match port.protocol {
                PortProtocol::Tcp => BoxlitePortProtocol::BoxlitePortProtocolTcp,
                PortProtocol::Udp => BoxlitePortProtocol::BoxlitePortProtocolUdp,
            },
        }
    }
}

impl CPublishedPortList {
    fn from_published_ports(ports: &[PublishedPort]) -> Self {
        let (items, count) = into_raw_slice(
            ports
                .iter()
                .map(CPublishedPort::from_published_port)
                .collect(),
        );
        Self { items, count }
    }
}

impl CNetworkInfo {
    fn from_network_info(network: &boxlite::NetworkInfo) -> Self {
        let (allow_net, allow_net_count) = into_raw_slice(
            network
                .allow_net
                .iter()
                .map(|host| to_c_str(host))
                .collect(),
        );
        let published_ports = network
            .published_ports
            .as_deref()
            .map(CPublishedPortList::from_published_ports)
            .map(Box::new)
            .map(Box::into_raw)
            .unwrap_or(ptr::null_mut());

        Self {
            mode: match network.mode {
                NetworkMode::Enabled => BoxliteNetworkMode::BoxliteNetworkModeEnabled,
                NetworkMode::Disabled => BoxliteNetworkMode::BoxliteNetworkModeDisabled,
            },
            allow_net,
            allow_net_count,
            published_ports,
        }
    }
}

pub(crate) fn network_to_c_ptr(network: &Option<boxlite::NetworkInfo>) -> *mut CNetworkInfo {
    network
        .as_ref()
        .map(CNetworkInfo::from_network_info)
        .map(Box::new)
        .map(Box::into_raw)
        .unwrap_or(ptr::null_mut())
}

unsafe fn free_published_port_list(list: *mut CPublishedPortList) {
    if list.is_null() {
        return;
    }
    unsafe {
        let list = Box::from_raw(list);
        if !list.items.is_null() && list.count >= 0 {
            for index in 0..list.count as usize {
                free_str((*list.items.add(index)).host_ip);
            }
        }
        free_raw_slice(list.items, list.count);
    }
}

pub(crate) unsafe fn free_network_info(network: *mut CNetworkInfo) {
    if network.is_null() {
        return;
    }
    unsafe {
        let network = Box::from_raw(network);
        if !network.allow_net.is_null() && network.allow_net_count >= 0 {
            for index in 0..network.allow_net_count as usize {
                free_str(*network.allow_net.add(index));
            }
        }
        free_raw_slice(network.allow_net, network.allow_net_count);
        free_published_port_list(network.published_ports);
    }
}

fn status_to_str(status: BoxStatus) -> &'static str {
    match status {
        BoxStatus::Unknown => "unknown",
        BoxStatus::Configured => "configured",
        BoxStatus::Running => "running",
        BoxStatus::Stopping => "stopping",
        BoxStatus::Stopped => "stopped",
        BoxStatus::Paused => "paused",
        BoxStatus::Failed => "failed",
    }
}

impl CBoxInfo {
    pub fn from_box_info(info: &boxlite::runtime::types::BoxInfo) -> Self {
        CBoxInfo {
            id: to_c_str(info.id.as_ref()),
            name: info
                .name
                .as_deref()
                .map(to_c_str)
                .unwrap_or(ptr::null_mut()),
            image: to_c_str(&info.image),
            status: to_c_str(status_to_str(info.status)),
            running: if info.status.is_running() { 1 } else { 0 },
            pid: info.pid.map(|p| p as c_int).unwrap_or(0),
            cpus: info.cpus as c_int,
            memory_mib: info.memory_mib as c_int,
            auto_stop: info.auto_stop,
            auto_delete: info.auto_delete,
            auto_resume: if info.auto_resume { 1 } else { 0 },
            created_at: info.created_at.timestamp(),
            network: network_to_c_ptr(&info.network),
            started_at: info.started_at.map(|at| at.timestamp_millis()).unwrap_or(0),
            exit_code: info.exit_code.unwrap_or(0) as c_int,
            has_exit_code: if info.exit_code.is_some() { 1 } else { 0 },
        }
    }
}

pub unsafe fn free_box_info(info: *mut CBoxInfo) {
    unsafe {
        if info.is_null() {
            return;
        }
        let info_ref = &mut *info;
        free_str(info_ref.id);
        free_str(info_ref.name);
        free_str(info_ref.image);
        free_str(info_ref.status);
        free_network_info(info_ref.network);
    }
}

pub unsafe fn free_box_info_ptr(info: *mut CBoxInfo) {
    unsafe {
        if info.is_null() {
            return;
        }
        free_box_info(info);
        drop(Box::from_raw(info));
    }
}

pub unsafe fn free_box_info_list(list: *mut CBoxInfoList) {
    unsafe {
        if list.is_null() {
            return;
        }
        let list_ref = &mut *list;
        for idx in 0..list_ref.count {
            free_box_info(list_ref.items.add(idx as usize));
        }
        if !list_ref.items.is_null() {
            drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
                list_ref.items,
                list_ref.count as usize,
            )));
        }
        drop(Box::from_raw(list));
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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_info(
    handle: *mut CBoxHandle,
    cb: CBoxInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_info(handle, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_get_info(
    runtime: *mut CBoxliteRuntime,
    id_or_name: *const c_char,
    cb: CBoxInfoCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_info_by_id(runtime, id_or_name, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_list_info(
    runtime: *mut CBoxliteRuntime,
    cb: CBoxInfoListCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_list(runtime, cb, user_data, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_box_info(info: *mut CBoxInfo) {
    free_box_info_ptr(info)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_free_box_info_list(list: *mut CBoxInfoList) {
    free_box_info_list(list)
}

unsafe fn box_info(
    handle: *mut BoxHandle,
    cb: CBoxInfoCb,
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
            let result = lite.info().await.map(|info| {
                crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CBoxInfo::from_box_info(&info)),
                    free_box_info_ptr,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::Info {
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

unsafe fn box_info_by_id(
    runtime: *mut RuntimeHandle,
    id_or_name: *const c_char,
    cb: CBoxInfoCb,
    user_data: *mut c_void,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let id_or_name = match crate::util::c_str_to_string(id_or_name) {
            Ok(value) => value,
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
            let result = match runtime_clone.get_info(&id_or_name).await {
                Ok(Some(info)) => Ok(crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CBoxInfo::from_box_info(&info)),
                    free_box_info_ptr,
                )),
                Ok(None) => Err(BoxliteError::NotFound(format!(
                    "Box not found: {id_or_name}"
                ))),
                Err(e) => Err(e),
            };
            push_event(
                &queue,
                RuntimeEvent::Info {
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

unsafe fn box_list(
    runtime: *mut RuntimeHandle,
    cb: CBoxInfoListCb,
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
        let runtime_clone = runtime_ref.runtime.clone();
        let queue = runtime_ref.queue.clone();
        let user_data_addr = user_data as usize;

        runtime_ref.tokio_rt.spawn(async move {
            let result = runtime_clone.list_info().await.map(|boxes| {
                let mut items = boxes
                    .iter()
                    .map(CBoxInfo::from_box_info)
                    .collect::<Vec<_>>()
                    .into_boxed_slice();
                let count = items.len() as c_int;
                let ptr = if items.is_empty() {
                    ptr::null_mut()
                } else {
                    let ptr = items.as_mut_ptr();
                    Box::leak(items);
                    ptr
                };
                crate::event_queue::OwnedFfiPtr::new_with(
                    Box::new(CBoxInfoList { items: ptr, count }),
                    free_box_info_list,
                )
            });
            push_event(
                &queue,
                RuntimeEvent::InfoList {
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

#[cfg(test)]
mod tests {
    use std::ffi::CStr;
    use std::ptr::NonNull;

    use boxlite::runtime::options::PortProtocol;
    use boxlite::{NetworkInfo, NetworkMode, PublishedPort};

    use crate::options::BoxlitePortProtocol;
    use crate::{FREE_STR_CALLS, FREE_STR_LOCK};

    use super::{BoxliteNetworkMode, free_network_info, network_to_c_ptr};

    #[test]
    fn typed_network_info_preserves_network_and_publication_state() {
        let _guard = FREE_STR_LOCK.lock().unwrap();
        let before = FREE_STR_CALLS.load(std::sync::atomic::Ordering::SeqCst);

        assert!(network_to_c_ptr(&None).is_null());

        let unresolved = NonNull::new(network_to_c_ptr(&Some(NetworkInfo {
            mode: NetworkMode::Enabled,
            allow_net: vec!["api.example.com".to_string()],
            published_ports: None,
        })))
        .expect("Some network metadata must allocate CNetworkInfo");
        let unresolved_ref = unsafe { unresolved.as_ref() };
        assert_eq!(
            unresolved_ref.mode,
            BoxliteNetworkMode::BoxliteNetworkModeEnabled
        );
        assert_eq!(unresolved_ref.allow_net_count, 1);
        assert_eq!(
            unsafe { CStr::from_ptr(*unresolved_ref.allow_net) }
                .to_str()
                .unwrap(),
            "api.example.com"
        );
        assert!(unresolved_ref.published_ports.is_null());
        unsafe { free_network_info(unresolved.as_ptr()) };

        let resolved_empty = NonNull::new(network_to_c_ptr(&Some(NetworkInfo {
            mode: NetworkMode::Disabled,
            allow_net: Vec::new(),
            published_ports: Some(Vec::new()),
        })))
        .expect("Some network metadata must allocate CNetworkInfo");
        let resolved_empty_ref = unsafe { resolved_empty.as_ref() };
        assert_eq!(
            resolved_empty_ref.mode,
            BoxliteNetworkMode::BoxliteNetworkModeDisabled
        );
        assert!(!resolved_empty_ref.published_ports.is_null());
        let resolved_empty_ports = unsafe { &*resolved_empty_ref.published_ports };
        assert!(resolved_empty_ports.items.is_null());
        assert_eq!(resolved_empty_ports.count, 0);
        unsafe { free_network_info(resolved_empty.as_ptr()) };

        let resolved = NonNull::new(network_to_c_ptr(&Some(NetworkInfo {
            mode: NetworkMode::Enabled,
            allow_net: Vec::new(),
            published_ports: Some(vec![PublishedPort {
                guest_port: 3000,
                host_ip: "127.0.0.1".to_string(),
                host_port: 49152,
                protocol: PortProtocol::Tcp,
            }]),
        })))
        .expect("Some network metadata must allocate CNetworkInfo");
        let resolved_ref = unsafe { resolved.as_ref() };
        assert!(!resolved_ref.published_ports.is_null());
        let resolved_ports = unsafe { &*resolved_ref.published_ports };
        assert_eq!(resolved_ports.count, 1);
        let port = unsafe { &*resolved_ports.items };
        assert_eq!(port.host_port, 49152);
        assert_eq!(port.guest_port, 3000);
        assert_eq!(port.protocol, BoxlitePortProtocol::BoxlitePortProtocolTcp);
        assert_eq!(
            unsafe { CStr::from_ptr(port.host_ip) }.to_str().unwrap(),
            "127.0.0.1"
        );
        unsafe { free_network_info(resolved.as_ptr()) };

        let after = FREE_STR_CALLS.load(std::sync::atomic::Ordering::SeqCst);
        assert_eq!(after - before, 2, "nested network strings must be freed");
    }
}

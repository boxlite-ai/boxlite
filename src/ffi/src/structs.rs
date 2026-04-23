use std::ffi::CString;
use std::os::raw::{c_char, c_int};
use std::ptr;

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
    pub created_at: i64,
}

#[repr(C)]
pub struct CBoxInfoList {
    pub items: *mut CBoxInfo,
    pub count: c_int,
}

#[repr(C)]
pub struct CBoxMetrics {
    pub cpu_percent: f64,
    pub memory_bytes: i64,
    pub commands_executed: c_int,
    pub exec_errors: c_int,
    pub bytes_sent: i64,
    pub bytes_received: i64,
    pub create_duration_ms: i64,
    pub boot_duration_ms: i64,
    pub network_bytes_sent: i64,
    pub network_bytes_received: i64,
    pub network_tcp_connections: c_int,
    pub network_tcp_errors: c_int,
}

#[repr(C)]
pub struct CRuntimeMetrics {
    pub boxes_created_total: c_int,
    pub boxes_failed_total: c_int,
    pub num_running_boxes: c_int,
    pub total_commands_executed: c_int,
    pub total_exec_errors: c_int,
}

#[repr(C)]
pub struct CImageInfo {
    pub reference: *mut c_char,
    pub repository: *mut c_char,
    pub tag: *mut c_char,
    pub id: *mut c_char,
    pub cached_at: i64,
    pub size: u64,
    pub has_size: c_int,
}

#[repr(C)]
pub struct CImageInfoList {
    pub items: *mut CImageInfo,
    pub count: c_int,
}

fn to_c_str(s: &str) -> *mut c_char {
    CString::new(s)
        .map(|c| c.into_raw())
        .unwrap_or(ptr::null_mut())
}

impl CBoxInfo {
    pub fn from_box_info(info: &boxlite::runtime::types::BoxInfo) -> Self {
        use crate::json::status_to_string;
        let running = matches!(info.status, boxlite::runtime::types::BoxStatus::Running);
        CBoxInfo {
            id: to_c_str(info.id.as_ref()),
            name: info
                .name
                .as_deref()
                .map(to_c_str)
                .unwrap_or(ptr::null_mut()),
            image: to_c_str(&info.image),
            status: to_c_str(status_to_string(info.status)),
            running: if running { 1 } else { 0 },
            pid: info.pid.map(|p| p as c_int).unwrap_or(0),
            cpus: info.cpus as c_int,
            memory_mib: info.memory_mib as c_int,
            created_at: info.created_at.timestamp(),
        }
    }

    pub fn str_to_c(s: &str) -> *mut c_char {
        to_c_str(s)
    }
}

pub unsafe fn free_box_info(info: *mut CBoxInfo) {
    unsafe {
        if info.is_null() {
            return;
        }
        let i = &mut *info;
        free_str(i.id);
        free_str(i.name);
        free_str(i.image);
        free_str(i.status);
    }
}

pub unsafe fn free_box_info_list(list: *mut CBoxInfoList) {
    unsafe {
        if list.is_null() {
            return;
        }
        let l = &mut *list;
        for idx in 0..l.count {
            free_box_info(l.items.add(idx as usize));
        }
        if !l.items.is_null() {
            drop(Vec::from_raw_parts(
                l.items,
                l.count as usize,
                l.count as usize,
            ));
        }
        drop(Box::from_raw(list));
    }
}

pub unsafe fn free_image_info_list(list: *mut CImageInfoList) {
    unsafe {
        if list.is_null() {
            return;
        }
        let l = &mut *list;
        for idx in 0..l.count {
            let item = &mut *l.items.add(idx as usize);
            free_str(item.reference);
            free_str(item.repository);
            free_str(item.tag);
            free_str(item.id);
        }
        if !l.items.is_null() {
            drop(Vec::from_raw_parts(
                l.items,
                l.count as usize,
                l.count as usize,
            ));
        }
        drop(Box::from_raw(list));
    }
}

unsafe fn free_str(s: *mut c_char) {
    if !s.is_null() {
        unsafe {
            drop(CString::from_raw(s));
        }
    }
}

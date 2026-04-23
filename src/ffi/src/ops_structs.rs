use std::os::raw::c_int;

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::runtime::{BoxHandle, RuntimeHandle};
use crate::structs::*;

pub unsafe fn box_info_struct(
    handle: *mut BoxHandle,
    out_info: *mut *mut CBoxInfo,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_info.is_null() {
            write_error(out_error, null_pointer_error("out_info"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;
        let info = handle_ref.handle.info();
        *out_info = Box::into_raw(Box::new(CBoxInfo::from_box_info(&info)));
        BoxliteErrorCode::Ok
    }
}

pub unsafe fn box_metrics_struct(
    handle: *mut BoxHandle,
    out_metrics: *mut CBoxMetrics,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_metrics.is_null() {
            write_error(out_error, null_pointer_error("out_metrics"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &*handle;
        let result = handle_ref.tokio_rt.block_on(handle_ref.handle.metrics());

        match result {
            Ok(m) => {
                *out_metrics = CBoxMetrics {
                    cpu_percent: m.cpu_percent.unwrap_or(0.0) as f64,
                    memory_bytes: m.memory_bytes.unwrap_or(0) as i64,
                    commands_executed: m.commands_executed_total as c_int,
                    exec_errors: m.exec_errors_total as c_int,
                    bytes_sent: m.bytes_sent_total as i64,
                    bytes_received: m.bytes_received_total as i64,
                    create_duration_ms: m.total_create_duration_ms.unwrap_or(0) as i64,
                    boot_duration_ms: m.guest_boot_duration_ms.unwrap_or(0) as i64,
                    network_bytes_sent: m.network_bytes_sent.unwrap_or(0) as i64,
                    network_bytes_received: m.network_bytes_received.unwrap_or(0) as i64,
                    network_tcp_connections: m.network_tcp_connections.unwrap_or(0) as c_int,
                    network_tcp_errors: m.network_tcp_errors.unwrap_or(0) as c_int,
                };
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

pub unsafe fn runtime_metrics_struct(
    runtime: *mut RuntimeHandle,
    out_metrics: *mut CRuntimeMetrics,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_metrics.is_null() {
            write_error(out_error, null_pointer_error("out_metrics"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &*runtime;
        let result = runtime_ref.tokio_rt.block_on(runtime_ref.runtime.metrics());

        match result {
            Ok(m) => {
                *out_metrics = CRuntimeMetrics {
                    boxes_created_total: m.boxes_created_total() as c_int,
                    boxes_failed_total: m.boxes_failed_total() as c_int,
                    num_running_boxes: m.num_running_boxes() as c_int,
                    total_commands_executed: m.total_commands_executed() as c_int,
                    total_exec_errors: m.total_exec_errors() as c_int,
                };
                BoxliteErrorCode::Ok
            }
            Err(e) => {
                write_error(out_error, e);
                BoxliteErrorCode::Internal
            }
        }
    }
}

pub unsafe fn box_list_struct(
    runtime: *mut RuntimeHandle,
    out_list: *mut *mut CBoxInfoList,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_list.is_null() {
            write_error(out_error, null_pointer_error("out_list"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &*runtime;
        let result = runtime_ref
            .tokio_rt
            .block_on(runtime_ref.runtime.list_info());

        match result {
            Ok(boxes) => {
                let mut items: Vec<CBoxInfo> = boxes.iter().map(CBoxInfo::from_box_info).collect();
                let count = items.len() as c_int;
                let ptr = items.as_mut_ptr();
                std::mem::forget(items);

                *out_list = Box::into_raw(Box::new(CBoxInfoList { items: ptr, count }));
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

pub unsafe fn image_list_struct(
    runtime: *mut RuntimeHandle,
    out_list: *mut *mut CImageInfoList,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if runtime.is_null() {
            write_error(out_error, null_pointer_error("runtime"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_list.is_null() {
            write_error(out_error, null_pointer_error("out_list"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let runtime_ref = &*runtime;
        let images_handle = match runtime_ref.runtime.images() {
            Ok(h) => h,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                return code;
            }
        };

        let result = runtime_ref.tokio_rt.block_on(images_handle.list());

        match result {
            Ok(image_list) => {
                let mut items: Vec<CImageInfo> = image_list
                    .iter()
                    .map(|img| {
                        let (size, has_size) = match &img.size {
                            Some(s) => (s.0, 1),
                            None => (0, 0),
                        };
                        CImageInfo {
                            reference: crate::structs::CBoxInfo::str_to_c(&img.reference),
                            repository: crate::structs::CBoxInfo::str_to_c(&img.repository),
                            tag: crate::structs::CBoxInfo::str_to_c(&img.tag),
                            id: crate::structs::CBoxInfo::str_to_c(&img.id),
                            cached_at: img.cached_at.timestamp(),
                            size,
                            has_size,
                        }
                    })
                    .collect();
                let count = items.len() as c_int;
                let ptr = items.as_mut_ptr();
                std::mem::forget(items);

                *out_list = Box::into_raw(Box::new(CImageInfoList { items: ptr, count }));
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

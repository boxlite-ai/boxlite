//! Metrics types and operations for the BoxLite C SDK.

use std::os::raw::c_int;

use crate::box_handle::BoxHandle;
use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::runtime::RuntimeHandle;
use crate::{CBoxHandle, CBoxliteError, CBoxliteRuntime};

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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_metrics(
    handle: *mut CBoxHandle,
    out_metrics: *mut CBoxMetrics,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_metrics(handle, out_metrics, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_runtime_metrics(
    runtime: *mut CBoxliteRuntime,
    out_metrics: *mut CRuntimeMetrics,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    runtime_metrics(runtime, out_metrics, out_error)
}

unsafe fn box_metrics(
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

unsafe fn runtime_metrics(
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
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

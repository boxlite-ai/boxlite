//! Runtime and per-box metrics endpoints.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};

use super::super::types::{BootTimingResponse, BoxMetricsResponse, RuntimeMetricsResponse};
use super::super::{AppState, classify_boxlite_error, error_response, get_or_fetch_box};

pub(in crate::commands::serve) async fn runtime_metrics(
    State(state): State<Arc<AppState>>,
) -> Response {
    let m = state.runtime.metrics().await;
    match m {
        Ok(metrics) => Json(RuntimeMetricsResponse {
            boxes_created_total: metrics.boxes_created_total(),
            boxes_failed_total: metrics.boxes_failed_total(),
            boxes_stopped_total: metrics.boxes_stopped_total(),
            num_running_boxes: metrics.num_running_boxes(),
            total_commands_executed: metrics.total_commands_executed(),
            total_exec_errors: metrics.total_exec_errors(),
        })
        .into_response(),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

pub(in crate::commands::serve) async fn box_metrics(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    match litebox.metrics().await {
        Ok(m) => {
            let has_timing = m.total_create_duration_ms.is_some();
            let boot_timing = if has_timing {
                Some(BootTimingResponse {
                    total_create_ms: m.total_create_duration_ms.map(|v| v as u64),
                    guest_boot_ms: m.guest_boot_duration_ms.map(|v| v as u64),
                    filesystem_setup_ms: m.stage_filesystem_setup_ms.map(|v| v as u64),
                    image_prepare_ms: m.stage_image_prepare_ms.map(|v| v as u64),
                    guest_rootfs_ms: m.stage_guest_rootfs_ms.map(|v| v as u64),
                    box_config_ms: m.stage_box_config_ms.map(|v| v as u64),
                    box_spawn_ms: m.stage_box_spawn_ms.map(|v| v as u64),
                    container_init_ms: m.stage_container_init_ms.map(|v| v as u64),
                })
            } else {
                None
            };

            Json(BoxMetricsResponse {
                commands_executed_total: m.commands_executed_total,
                exec_errors_total: m.exec_errors_total,
                bytes_sent_total: m.bytes_sent_total,
                bytes_received_total: m.bytes_received_total,
                cpu_percent: m.cpu_percent,
                memory_bytes: m.memory_bytes,
                network_bytes_sent: m.network_bytes_sent,
                network_bytes_received: m.network_bytes_received,
                network_tcp_connections: m.network_tcp_connections,
                network_tcp_errors: m.network_tcp_errors,
                boot_timing,
            })
            .into_response()
        }
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

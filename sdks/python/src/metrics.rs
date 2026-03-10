use boxlite::metrics::{BoxMetrics, RuntimeMetrics};
use pyo3::prelude::*;

#[pyclass(name = "RuntimeMetrics")]
#[derive(Clone)]
pub(crate) struct PyRuntimeMetrics {
    #[pyo3(get)]
    pub(crate) boxes_created_total: u64,
    #[pyo3(get)]
    pub(crate) boxes_failed_total: u64,
    #[pyo3(get)]
    pub(crate) num_running_boxes: u64,
    #[pyo3(get)]
    pub(crate) total_commands_executed: u64,
    #[pyo3(get)]
    pub(crate) total_exec_errors: u64,
}

#[pymethods]
impl PyRuntimeMetrics {
    fn __repr__(&self) -> String {
        format!(
            "RuntimeMetrics(boxes_created={}, boxes_failed={}, running={}, commands={}, errors={})",
            self.boxes_created_total,
            self.boxes_failed_total,
            self.num_running_boxes,
            self.total_commands_executed,
            self.total_exec_errors
        )
    }
}

impl From<RuntimeMetrics> for PyRuntimeMetrics {
    fn from(metrics: RuntimeMetrics) -> Self {
        PyRuntimeMetrics {
            boxes_created_total: metrics.boxes_created_total(),
            boxes_failed_total: metrics.boxes_failed_total(),
            num_running_boxes: metrics.num_running_boxes(),
            total_commands_executed: metrics.total_commands_executed(),
            total_exec_errors: metrics.total_exec_errors(),
        }
    }
}

#[pyclass(name = "BoxMetrics")]
#[derive(Clone)]
pub(crate) struct PyBoxMetrics {
    #[pyo3(get)]
    pub(crate) commands_executed_total: u64,
    #[pyo3(get)]
    pub(crate) exec_errors_total: u64,
    #[pyo3(get)]
    pub(crate) bytes_sent_total: u64,
    #[pyo3(get)]
    pub(crate) bytes_received_total: u64,
    #[pyo3(get)]
    pub(crate) total_create_duration_ms: Option<u128>,
    #[pyo3(get)]
    pub(crate) guest_boot_duration_ms: Option<u128>,
    #[pyo3(get)]
    pub(crate) cpu_percent: Option<f32>,
    #[pyo3(get)]
    pub(crate) memory_bytes: Option<u64>,
    #[pyo3(get)]
    pub(crate) network_bytes_sent: Option<u64>,
    #[pyo3(get)]
    pub(crate) network_bytes_received: Option<u64>,
    #[pyo3(get)]
    pub(crate) network_tcp_connections: Option<u64>,
    #[pyo3(get)]
    pub(crate) network_tcp_errors: Option<u64>,
    // Stage-level timing breakdown
    #[pyo3(get)]
    pub(crate) stage_filesystem_setup_ms: Option<u128>,
    #[pyo3(get)]
    pub(crate) stage_image_prepare_ms: Option<u128>,
    #[pyo3(get)]
    pub(crate) stage_guest_rootfs_ms: Option<u128>,
    #[pyo3(get)]
    pub(crate) stage_box_config_ms: Option<u128>,
    #[pyo3(get)]
    pub(crate) stage_box_spawn_ms: Option<u128>,
    #[pyo3(get)]
    pub(crate) stage_container_init_ms: Option<u128>,
}

#[pymethods]
impl PyBoxMetrics {
    fn __repr__(&self) -> String {
        format!(
            "BoxMetrics(commands={}, errors={}, total_create_ms={:?}, guest_boot_ms={:?}, cpu={:?}, mem={:?})",
            self.commands_executed_total,
            self.exec_errors_total,
            self.total_create_duration_ms,
            self.guest_boot_duration_ms,
            self.cpu_percent,
            self.memory_bytes
        )
    }
}

impl From<BoxMetrics> for PyBoxMetrics {
    fn from(metrics: BoxMetrics) -> Self {
        PyBoxMetrics {
            commands_executed_total: metrics.commands_executed_total(),
            exec_errors_total: metrics.exec_errors_total(),
            bytes_sent_total: metrics.bytes_sent_total(),
            bytes_received_total: metrics.bytes_received_total(),
            total_create_duration_ms: metrics.total_create_duration_ms(),
            guest_boot_duration_ms: metrics.guest_boot_duration_ms(),
            cpu_percent: metrics.cpu_percent(),
            memory_bytes: metrics.memory_bytes(),
            network_bytes_sent: metrics.network_bytes_sent(),
            network_bytes_received: metrics.network_bytes_received(),
            network_tcp_connections: metrics.network_tcp_connections(),
            network_tcp_errors: metrics.network_tcp_errors(),
            stage_filesystem_setup_ms: metrics.stage_filesystem_setup_ms(),
            stage_image_prepare_ms: metrics.stage_image_prepare_ms(),
            stage_guest_rootfs_ms: metrics.stage_guest_rootfs_ms(),
            stage_box_config_ms: metrics.stage_box_config_ms(),
            stage_box_spawn_ms: metrics.stage_box_spawn_ms(),
            stage_container_init_ms: metrics.stage_container_init_ms(),
        }
    }
}

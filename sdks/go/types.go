package boxlite

import "time"

// State represents the lifecycle state of a box.
type State string

const (
	StateConfigured State = "configured"
	StateRunning    State = "running"
	StateStopping   State = "stopping"
	StateStopped    State = "stopped"
)

// BoxInfo holds information about a box.
type BoxInfo struct {
	ID        string
	Name      string
	Image     string
	State     State
	Running   bool
	PID       int
	CPUs      int
	MemoryMiB int
	CreatedAt time.Time
}

// ExecResult contains the result of a buffered command execution.
type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

// RuntimeMetrics holds aggregate runtime metrics.
type RuntimeMetrics struct {
	BoxesCreatedTotal     int `json:"boxes_created_total"`
	BoxesFailedTotal      int `json:"boxes_failed_total"`
	RunningBoxes          int `json:"num_running_boxes"`
	TotalCommandsExecuted int `json:"total_commands_executed"`
	TotalExecErrors       int `json:"total_exec_errors"`
}

// BoxMetrics holds per-box metrics.
type BoxMetrics struct {
	CPUPercent           float64 `json:"cpu_percent"`
	MemoryBytes          int64   `json:"memory_bytes"`
	CommandsExecuted     int     `json:"commands_executed_total"`
	ExecErrors           int     `json:"exec_errors_total"`
	BytesSent            int64   `json:"bytes_sent_total"`
	BytesReceived        int64   `json:"bytes_received_total"`
	CreateDurationMs     int64   `json:"total_create_duration_ms"`
	BootDurationMs       int64   `json:"guest_boot_duration_ms"`
	NetworkBytesSent     int64   `json:"network_bytes_sent"`
	NetworkBytesReceived int64   `json:"network_bytes_received"`
	NetworkTCPConns      int     `json:"network_tcp_connections"`
	NetworkTCPErrors     int     `json:"network_tcp_errors"`
}

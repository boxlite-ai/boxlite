package boxlite

import "time"

type State string

const (
	StateConfigured State = "configured"
	StateRunning    State = "running"
	StateStopping   State = "stopping"
	StateStopped    State = "stopped"
)

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

type ImageInfo struct {
	Reference  string
	Repository string
	Tag        string
	ID         string
	CachedAt   time.Time
	Size       *uint64
}

type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

type RuntimeMetrics struct {
	BoxesCreatedTotal     int
	BoxesFailedTotal      int
	RunningBoxes          int
	TotalCommandsExecuted int
	TotalExecErrors       int
}

type BoxMetrics struct {
	CPUPercent           float64
	MemoryBytes          int64
	CommandsExecuted     int
	ExecErrors           int
	BytesSent            int64
	BytesReceived        int64
	CreateDurationMs     int64
	BootDurationMs       int64
	NetworkBytesSent     int64
	NetworkBytesReceived int64
	NetworkTCPConns      int
	NetworkTCPErrors     int
}

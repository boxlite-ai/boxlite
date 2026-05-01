package boxlite

/*
#include "boxlite.h"
*/
import "C"
import "context"

// RuntimeMetrics holds aggregate runtime metrics.
type RuntimeMetrics struct {
	BoxesCreatedTotal     int
	BoxesFailedTotal      int
	RunningBoxes          int
	TotalCommandsExecuted int
	TotalExecErrors       int
}

// BoxMetrics holds per-box metrics.
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

// Metrics returns aggregate runtime metrics.
func (r *Runtime) Metrics(_ context.Context) (*RuntimeMetrics, error) {
	var cm C.CRuntimeMetrics
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_metrics(r.handle, &cm, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	return &RuntimeMetrics{
		BoxesCreatedTotal:     int(cm.boxes_created_total),
		BoxesFailedTotal:      int(cm.boxes_failed_total),
		RunningBoxes:          int(cm.num_running_boxes),
		TotalCommandsExecuted: int(cm.total_commands_executed),
		TotalExecErrors:       int(cm.total_exec_errors),
	}, nil
}

// Metrics returns real-time metrics for this box.
func (b *Box) Metrics(_ context.Context) (*BoxMetrics, error) {
	var cm C.CBoxMetrics
	var cerr C.CBoxliteError
	code := C.boxlite_box_metrics(b.handle, &cm, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &BoxMetrics{
		CPUPercent:           float64(cm.cpu_percent),
		MemoryBytes:          int64(cm.memory_bytes),
		CommandsExecuted:     int(cm.commands_executed),
		ExecErrors:           int(cm.exec_errors),
		BytesSent:            int64(cm.bytes_sent),
		BytesReceived:        int64(cm.bytes_received),
		CreateDurationMs:     int64(cm.create_duration_ms),
		BootDurationMs:       int64(cm.boot_duration_ms),
		NetworkBytesSent:     int64(cm.network_bytes_sent),
		NetworkBytesReceived: int64(cm.network_bytes_received),
		NetworkTCPConns:      int(cm.network_tcp_connections),
		NetworkTCPErrors:     int(cm.network_tcp_errors),
	}, nil
}

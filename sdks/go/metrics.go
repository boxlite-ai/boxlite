package boxlite

/*
#include "bridge.h"
*/
import "C"
import (
	"context"
	"runtime/cgo"
)

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
func (r *Runtime) Metrics(ctx context.Context) (*RuntimeMetrics, error) {
	r.ensureDrainRunning()

	ch := make(chan runtimeMetricsResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_runtime_metrics(r.handle, C.cbRuntimeMetrics(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		if res.err != nil {
			return nil, res.err
		}
		return res.value, nil
	case <-ctx.Done():
		drainAndDelete(ch, h, r.closing)
		return nil, ctx.Err()
	case <-r.closing:
		drainAndDelete(ch, h, r.closing)
		return nil, ErrRuntimeClosed
	}
}

// Metrics returns real-time metrics for this box.
func (b *Box) Metrics(ctx context.Context) (*BoxMetrics, error) {
	b.runtime.ensureDrainRunning()

	ch := make(chan boxMetricsResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_box_metrics(b.handle, C.cbBoxMetrics(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		if res.err != nil {
			return nil, res.err
		}
		return res.value, nil
	case <-ctx.Done():
		drainAndDelete(ch, h, b.runtime.closing)
		return nil, ctx.Err()
	case <-b.runtime.closing:
		drainAndDelete(ch, h, b.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// cBoxMetricsToGo converts the C struct to its Go counterpart.
func cBoxMetricsToGo(cm *C.CBoxMetrics) BoxMetrics {
	return BoxMetrics{
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
	}
}

// cRuntimeMetricsToGo converts the C struct to its Go counterpart.
func cRuntimeMetricsToGo(cm *C.CRuntimeMetrics) RuntimeMetrics {
	return RuntimeMetrics{
		BoxesCreatedTotal:     int(cm.boxes_created_total),
		BoxesFailedTotal:      int(cm.boxes_failed_total),
		RunningBoxes:          int(cm.num_running_boxes),
		TotalCommandsExecuted: int(cm.total_commands_executed),
		TotalExecErrors:       int(cm.total_exec_errors),
	}
}

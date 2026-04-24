package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>

extern void goBoxliteOutputCallback(char* text, int is_stderr, void* user_data);
*/
import "C"
import (
	"context"
	"encoding/json"
	"unsafe"
)

// Box is a handle to a BoxLite box (virtual machine).
type Box struct {
	handle *C.CBoxHandle
	id     string
	name   string
}

func (b *Box) ID() string   { return b.id }
func (b *Box) Name() string { return b.name }

func (b *Box) Start(_ context.Context) error {
	var cerr C.CBoxliteError
	code := C.boxlite_start_box(b.handle, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

func (b *Box) Stop(_ context.Context) error {
	var cerr C.CBoxliteError
	code := C.boxlite_stop_box(b.handle, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

func (b *Box) Close() error {
	if b.handle != nil {
		C.boxlite_box_free(b.handle)
		b.handle = nil
	}
	return nil
}

// Info returns information about the box using C struct (no JSON).
func (b *Box) Info(_ context.Context) (*BoxInfo, error) {
	var cInfo *C.CBoxInfo
	var cerr C.CBoxliteError
	code := C.boxlite_box_info_struct(b.handle, &cInfo, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_free_box_info(cInfo)

	info := cBoxInfoToGo(cInfo)
	if info.Name != "" && b.name == "" {
		b.name = info.Name
	}
	return &info, nil
}

// Metrics returns real-time metrics using C struct (no JSON).
func (b *Box) Metrics(_ context.Context) (*BoxMetrics, error) {
	var cm C.CBoxMetrics
	var cerr C.CBoxliteError
	code := C.boxlite_box_metrics_struct(b.handle, &cm, &cerr)
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

// Exec executes a command and returns the buffered result.
func (b *Box) Exec(ctx context.Context, name string, arg ...string) (*ExecResult, error) {
	cmd := b.Command(name, arg...)

	var stdoutBuf, stderrBuf []byte

	cCmd := toCString(cmd.Path)
	defer C.free(unsafe.Pointer(cCmd))

	// Pass args as C string array via BoxliteCommand, not JSON
	var cArgs *C.char
	if len(cmd.Args) > 0 {
		argsJSON, err := json.Marshal(cmd.Args)
		if err != nil {
			return nil, err
		}
		cArgs = toCString(string(argsJSON))
		defer C.free(unsafe.Pointer(cArgs))
	}

	var exitCode C.int
	var cerr C.CBoxliteError

	writers := &callbackWriters{
		stdout: &bytesCollector{buf: &stdoutBuf},
		stderr: &bytesCollector{buf: &stderrBuf},
	}
	h := cgo_NewHandle(writers)
	defer cgo_DeleteHandle(h)

	code := C.boxlite_execute(
		b.handle,
		cCmd,
		cArgs,
		(*[0]byte)(C.goBoxliteOutputCallback),
		handleToPtr(h),
		&exitCode,
		&cerr,
	)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &ExecResult{
		ExitCode: int(exitCode),
		Stdout:   string(stdoutBuf),
		Stderr:   string(stderrBuf),
	}, nil
}

// CopyInto copies a file or directory from the host into the box.
func (b *Box) CopyInto(_ context.Context, hostSrc, guestDst string) error {
	cSrc := toCString(hostSrc)
	defer C.free(unsafe.Pointer(cSrc))
	cDst := toCString(guestDst)
	defer C.free(unsafe.Pointer(cDst))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_into(b.handle, cSrc, cDst, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// CopyOut copies a file or directory from the box to the host.
func (b *Box) CopyOut(_ context.Context, guestSrc, hostDst string) error {
	cSrc := toCString(guestSrc)
	defer C.free(unsafe.Pointer(cSrc))
	cDst := toCString(hostDst)
	defer C.free(unsafe.Pointer(cDst))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_out(b.handle, cSrc, cDst, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Command creates a Cmd for streaming execution, mirroring os/exec.Cmd.
func (b *Box) Command(name string, arg ...string) *Cmd {
	return &Cmd{
		Path: name,
		Args: arg,
		box:  b,
	}
}

type bytesCollector struct {
	buf *[]byte
}

func (w *bytesCollector) Write(p []byte) (int, error) {
	*w.buf = append(*w.buf, p...)
	return len(p), nil
}

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
// Call Close to release the handle when done. Closing does not destroy the box.
type Box struct {
	handle *C.CBoxHandle
	id     string
	name   string
}

// ID returns the unique identifier of the box.
func (b *Box) ID() string { return b.id }

// Name returns the user-defined name of the box, if set.
func (b *Box) Name() string { return b.name }

// Start starts (or restarts) the box.
func (b *Box) Start(_ context.Context) error {
	var cerr C.CBoxliteError
	code := C.boxlite_start_box(b.handle, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Stop stops the box.
func (b *Box) Stop(_ context.Context) error {
	var cerr C.CBoxliteError
	code := C.boxlite_stop_box(b.handle, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Close releases the box handle. The box itself continues to exist in the runtime.
// Implements io.Closer.
func (b *Box) Close() error {
	if b.handle != nil {
		C.boxlite_box_free(b.handle)
		b.handle = nil
	}
	return nil
}

// Info returns information about the box.
func (b *Box) Info(_ context.Context) (*BoxInfo, error) {
	var cJSON *C.char
	var cerr C.CBoxliteError
	code := C.boxlite_box_info(b.handle, &cJSON, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	jsonStr := C.GoString(cJSON)
	freeBoxliteString(cJSON)

	var info boxInfoWire
	if err := json.Unmarshal([]byte(jsonStr), &info); err != nil {
		return nil, err
	}

	// Update cached name if we got one from the server.
	if info.Name != "" && b.name == "" {
		b.name = info.Name
	}

	boxInfo := info.toBoxInfo()
	return &boxInfo, nil
}

// Metrics returns real-time metrics for this box.
func (b *Box) Metrics(_ context.Context) (*BoxMetrics, error) {
	var cJSON *C.char
	var cerr C.CBoxliteError
	code := C.boxlite_box_metrics(b.handle, &cJSON, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	jsonStr := C.GoString(cJSON)
	freeBoxliteString(cJSON)

	var m BoxMetrics
	if err := json.Unmarshal([]byte(jsonStr), &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// Exec executes a command and returns the buffered result.
// This is the simple path — for streaming, use Command.
func (b *Box) Exec(ctx context.Context, name string, arg ...string) (*ExecResult, error) {
	cmd := b.Command(name, arg...)

	// Use callback to capture stdout/stderr.
	var stdoutBuf, stderrBuf []byte

	argsJSON, err := json.Marshal(cmd.Args)
	if err != nil {
		return nil, err
	}

	cCmd := toCString(cmd.Path)
	defer C.free(unsafe.Pointer(cCmd))
	cArgs := toCString(string(argsJSON))
	defer C.free(unsafe.Pointer(cArgs))

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

// Command creates a Cmd for streaming execution, mirroring os/exec.Cmd.
func (b *Box) Command(name string, arg ...string) *Cmd {
	return &Cmd{
		Path: name,
		Args: arg,
		box:  b,
	}
}

// bytesCollector is a simple io.Writer that appends to a byte slice.
type bytesCollector struct {
	buf *[]byte
}

func (w *bytesCollector) Write(p []byte) (int, error) {
	*w.buf = append(*w.buf, p...)
	return len(p), nil
}

package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>

extern void goBoxliteOutputCallback(char* text, int is_stderr, void* user_data);
*/
import "C"
import (
	"bytes"
	"context"
	"io"
	"runtime/cgo"
	"unsafe"
)

// ExecResult contains the result of a buffered command execution.
type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

// Exec executes a command and returns the buffered result.
func (b *Box) Exec(ctx context.Context, name string, arg ...string) (*ExecResult, error) {
	cmd := b.Command(name, arg...)

	var stdoutBuf, stderrBuf []byte

	cCmd := toCString(cmd.Path)
	defer C.free(unsafe.Pointer(cCmd))

	cArgs, argc := toCStringArray(cmd.Args)
	defer freeCStringArray(cArgs, argc)

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
		C.int(argc),
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

// Cmd represents a command to execute inside a box.
// It mirrors the os/exec.Cmd pattern.
type Cmd struct {
	Path   string
	Args   []string
	Stdout io.Writer
	Stderr io.Writer

	box      *Box
	exitCode int
	done     bool
}

// Run executes the command. If Stdout/Stderr are set, output is streamed to them.
func (c *Cmd) Run(_ context.Context) error {
	cCmd := toCString(c.Path)
	defer C.free(unsafe.Pointer(cCmd))

	cArgs, argc := toCStringArray(c.Args)
	defer freeCStringArray(cArgs, argc)

	var exitCode C.int
	var cerr C.CBoxliteError

	var callback *[0]byte
	var userData unsafe.Pointer
	if c.Stdout != nil || c.Stderr != nil {
		writers := &callbackWriters{stdout: c.Stdout, stderr: c.Stderr}
		h := cgo.NewHandle(writers)
		defer h.Delete()
		callback = (*[0]byte)(C.goBoxliteOutputCallback)
		userData = handleToPtr(h)
	}

	code := C.boxlite_execute(
		c.box.handle,
		cCmd,
		cArgs,
		C.int(argc),
		callback,
		userData,
		&exitCode,
		&cerr,
	)
	if code != C.Ok {
		return freeError(&cerr)
	}

	c.exitCode = int(exitCode)
	c.done = true
	return nil
}

// Output runs the command and returns its standard output.
func (c *Cmd) Output(ctx context.Context) ([]byte, error) {
	var buf bytes.Buffer
	c.Stdout = &buf
	err := c.Run(ctx)
	return buf.Bytes(), err
}

// CombinedOutput runs the command and returns combined stdout and stderr.
func (c *Cmd) CombinedOutput(ctx context.Context) ([]byte, error) {
	var buf bytes.Buffer
	c.Stdout = &buf
	c.Stderr = &buf
	err := c.Run(ctx)
	return buf.Bytes(), err
}

// ExitCode returns the exit code of the command. Only valid after Run completes.
func (c *Cmd) ExitCode() int {
	return c.exitCode
}

func cgo_NewHandle(v any) cgo.Handle { return cgo.NewHandle(v) }
func cgo_DeleteHandle(h cgo.Handle)  { h.Delete() }

func handleToPtr(h cgo.Handle) unsafe.Pointer {
	return *(*unsafe.Pointer)(unsafe.Pointer(&h))
}

type bytesCollector struct {
	buf *[]byte
}

func (w *bytesCollector) Write(p []byte) (int, error) {
	*w.buf = append(*w.buf, p...)
	return len(p), nil
}

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
	"encoding/json"
	"io"
	"runtime/cgo"
	"unsafe"
)

// Cmd represents a command to execute inside a box.
// It mirrors the os/exec.Cmd pattern.
type Cmd struct {
	// Path is the command to execute.
	Path string

	// Args are the command arguments (not including the command itself).
	Args []string

	// Stdout specifies the writer for standard output.
	// If nil, output is discarded.
	Stdout io.Writer

	// Stderr specifies the writer for standard error.
	// If nil, output is discarded.
	Stderr io.Writer

	box      *Box
	exitCode int
	done     bool
}

// Run executes the command. If Stdout/Stderr are set, output is streamed to them.
func (c *Cmd) Run(_ context.Context) error {
	argsJSON, err := json.Marshal(c.Args)
	if err != nil {
		return err
	}

	cCmd := toCString(c.Path)
	defer C.free(unsafe.Pointer(cCmd))
	cArgs := toCString(string(argsJSON))
	defer C.free(unsafe.Pointer(cArgs))

	var exitCode C.int
	var cerr C.CBoxliteError

	if c.Stdout != nil || c.Stderr != nil {
		writers := &callbackWriters{stdout: c.Stdout, stderr: c.Stderr}
		h := cgo.NewHandle(writers)
		defer h.Delete()

		code := C.boxlite_execute(
			c.box.handle,
			cCmd,
			cArgs,
			(*[0]byte)(C.goBoxliteOutputCallback),
			handleToPtr(h),
			&exitCode,
			&cerr,
		)
		if code != C.Ok {
			return freeError(&cerr)
		}
	} else {
		code := C.boxlite_execute(
			c.box.handle,
			cCmd,
			cArgs,
			nil,
			nil,
			&exitCode,
			&cerr,
		)
		if code != C.Ok {
			return freeError(&cerr)
		}
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

// cgo handle helpers — wrapper for runtime/cgo.Handle to share with box.go.
func cgo_NewHandle(v any) cgo.Handle { return cgo.NewHandle(v) }
func cgo_DeleteHandle(h cgo.Handle)  { h.Delete() }

// handleToPtr converts a cgo.Handle to unsafe.Pointer for passing to C.
// Uses indirect conversion to avoid a go vet false positive, since
// cgo.Handle (uintptr) is specifically designed for this purpose.
func handleToPtr(h cgo.Handle) unsafe.Pointer {
	return *(*unsafe.Pointer)(unsafe.Pointer(&h))
}

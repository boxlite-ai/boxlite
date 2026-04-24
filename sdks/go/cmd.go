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

type Cmd struct {
	Path     string
	Args     []string
	Stdout   io.Writer
	Stderr   io.Writer
	box      *Box
	exitCode int
	done     bool
}

func (c *Cmd) Run(_ context.Context) error {
	cCmd := toCString(c.Path)
	defer C.free(unsafe.Pointer(cCmd))

	var cArgs **C.char
	var argc int
	if len(c.Args) > 0 {
		cArgs, argc = toCStringArray(c.Args)
		defer freeCStringArray(cArgs, argc)
	}

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
			C.int(argc),
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
			C.int(argc),
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

func (c *Cmd) Output(ctx context.Context) ([]byte, error) {
	var buf bytes.Buffer
	c.Stdout = &buf
	err := c.Run(ctx)
	return buf.Bytes(), err
}

func (c *Cmd) CombinedOutput(ctx context.Context) ([]byte, error) {
	var buf bytes.Buffer
	c.Stdout = &buf
	c.Stderr = &buf
	err := c.Run(ctx)
	return buf.Bytes(), err
}

func (c *Cmd) ExitCode() int {
	return c.exitCode
}

func cgo_NewHandle(v any) cgo.Handle { return cgo.NewHandle(v) }
func cgo_DeleteHandle(h cgo.Handle)  { h.Delete() }

func handleToPtr(h cgo.Handle) unsafe.Pointer {
	return *(*unsafe.Pointer)(unsafe.Pointer(&h))
}

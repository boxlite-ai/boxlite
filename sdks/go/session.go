package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>

extern void goBoxliteOutputCallback(char* text, int is_stderr, void* user_data);
*/
import "C"
import (
	"context"
	"io"
	"runtime/cgo"
	"unsafe"
)

// Session is an interactive TTY session inside a box.
// Stdout/stderr are streamed to the provided writers.
// Write to stdin via Write().
type Session struct {
	handle *C.CSessionHandle
}

// StartSession starts an interactive TTY session in the box.
// Output is streamed to stdout/stderr writers.
func (b *Box) StartSession(_ context.Context, command string, args []string, stdout, stderr io.Writer) (*Session, error) {
	cCmd := toCString(command)
	defer C.free(unsafe.Pointer(cCmd))

	var cArgs **C.char
	var argc int
	if len(args) > 0 {
		cArgs, argc = toCStringArray(args)
		defer freeCStringArray(cArgs, argc)
	}

	writers := &callbackWriters{stdout: stdout, stderr: stderr}
	h := cgo.NewHandle(writers)
	// Note: handle is NOT deleted here — it lives for the session lifetime

	var sessionHandle *C.CSessionHandle
	var cerr C.CBoxliteError

	code := C.boxlite_session_start(
		b.handle,
		cCmd,
		cArgs,
		C.int(argc),
		(*[0]byte)(C.goBoxliteOutputCallback),
		handleToPtr(h),
		&sessionHandle,
		&cerr,
	)
	if code != C.Ok {
		h.Delete()
		return nil, freeError(&cerr)
	}

	return &Session{handle: sessionHandle}, nil
}

// Write sends data to the session's stdin.
func (s *Session) Write(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	var cerr C.CBoxliteError
	code := C.boxlite_session_write(
		s.handle,
		(*C.char)(unsafe.Pointer(&data[0])),
		C.int(len(data)),
		&cerr,
	)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Close ends the session.
func (s *Session) Close() {
	if s.handle != nil {
		C.boxlite_session_free(s.handle)
		s.handle = nil
	}
}

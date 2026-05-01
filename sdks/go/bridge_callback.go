package boxlite

/*
#include <stdlib.h>
*/
import "C"
import (
	"io"
	"runtime/cgo"
	"unsafe"
)

// callbackWriters holds the io.Writers for streaming exec output.
type callbackWriters struct {
	stdout   io.Writer
	stderr   io.Writer
	onStdout func([]byte)
	onStderr func([]byte)
}

//export goBoxliteOutputCallback
func goBoxliteOutputCallback(text *C.char, isStderr C.int, userData unsafe.Pointer) {
	h := cgo.Handle(userData)
	w := h.Value().(*callbackWriters)
	data := []byte(C.GoString(text))
	if isStderr != 0 {
		if w.onStderr != nil {
			w.onStderr(data)
		}
		if w.stderr != nil {
			_, _ = w.stderr.Write(data)
		}
	} else {
		if w.onStdout != nil {
			w.onStdout(data)
		}
		if w.stdout != nil {
			_, _ = w.stdout.Write(data)
		}
	}
}

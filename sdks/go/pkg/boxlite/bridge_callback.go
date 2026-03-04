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
	stdout io.Writer
	stderr io.Writer
}

//export goBoxliteOutputCallback
func goBoxliteOutputCallback(text *C.char, isStderr C.int, userData unsafe.Pointer) {
	h := cgo.Handle(userData)
	w := h.Value().(*callbackWriters)
	goText := C.GoString(text)
	if isStderr != 0 {
		if w.stderr != nil {
			_, _ = w.stderr.Write([]byte(goText))
		}
	} else {
		if w.stdout != nil {
			_, _ = w.stdout.Write([]byte(goText))
		}
	}
}

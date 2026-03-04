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
			w.stderr.Write([]byte(goText))
		}
	} else {
		if w.stdout != nil {
			w.stdout.Write([]byte(goText))
		}
	}
}

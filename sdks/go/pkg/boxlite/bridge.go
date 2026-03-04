package boxlite

/*
#cgo CFLAGS: -I${SRCDIR}/../../../c/include

// Static linking against libboxlite.a. The build step (make dev:go) runs
// localize-go-symbols.sh to hide Go runtime symbols from embedded libgvproxy,
// preventing duplicate symbol conflicts with the Go binary's own runtime.
#cgo darwin LDFLAGS: ${SRCDIR}/../../../../target/debug/libboxlite.a
#cgo darwin LDFLAGS: -framework CoreFoundation -framework Security -framework IOKit
#cgo darwin LDFLAGS: -framework Hypervisor -framework vmnet -lresolv

#cgo linux LDFLAGS: ${SRCDIR}/../../../../target/debug/libboxlite.a
#cgo linux LDFLAGS: -lresolv -lpthread -ldl -lm

#include "boxlite.h"
#include <stdlib.h>
*/
import "C"

// freeError extracts an Error from CBoxliteError and returns it.
// Returns nil if the error code is Ok.
func freeError(cerr *C.CBoxliteError) error {
	if cerr.code == C.Ok {
		return nil
	}
	code := ErrorCode(cerr.code)
	msg := ""
	if cerr.message != nil {
		msg = C.GoString(cerr.message)
	}
	C.boxlite_error_free(cerr)
	return &Error{Code: code, Message: msg}
}

// toCString converts a Go string to a C string. Caller must free with C.free.
func toCString(s string) *C.char {
	return C.CString(s)
}

// freeBoxliteString frees a string allocated by the Rust FFI.
func freeBoxliteString(s *C.char) {
	C.boxlite_free_string(s)
}

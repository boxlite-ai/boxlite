package boxlite

// CGO library paths are in bridge_cgo_dev.go (local development) and
// bridge_cgo_prebuilt.go (prebuilt library from GitHub Releases).
// Default: uses prebuilt library from lib/{platform}/.
// For local development: go build -tags boxlite_dev ./...

/*
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

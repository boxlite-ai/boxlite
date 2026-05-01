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
import "unsafe"

func cString(ptr *C.char) string {
	if ptr == nil {
		return ""
	}
	return C.GoString(ptr)
}

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

// toCStringArray converts a Go string slice to a C array of strings.
func toCStringArray(strs []string) (**C.char, int) {
	if len(strs) == 0 {
		return nil, 0
	}
	cArray := C.malloc(C.size_t(len(strs)) * C.size_t(unsafe.Sizeof(uintptr(0))))
	goSlice := unsafe.Slice((**C.char)(cArray), len(strs))
	for i, s := range strs {
		goSlice[i] = C.CString(s)
	}
	return (**C.char)(cArray), len(strs)
}

func freeCStringArray(arr **C.char, count int) {
	if arr == nil {
		return
	}
	goSlice := unsafe.Slice(arr, count)
	for _, s := range goSlice {
		C.free(unsafe.Pointer(s))
	}
	C.free(unsafe.Pointer(arr))
}

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
import (
	"fmt"
	"strings"
	"unsafe"
)

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

func toCImageRegistryArray(registries []ImageRegistry) (*C.BoxliteImageRegistry, int, func(), error) {
	if len(registries) == 0 {
		return nil, 0, func() {}, nil
	}

	cArray := C.calloc(C.size_t(len(registries)), C.size_t(unsafe.Sizeof(C.BoxliteImageRegistry{})))
	goSlice := unsafe.Slice((*C.BoxliteImageRegistry)(cArray), len(registries))
	cStrings := make([]*C.char, 0, len(registries)*4)

	free := func() {
		for _, s := range cStrings {
			C.free(unsafe.Pointer(s))
		}
		C.free(cArray)
	}

	for i, registry := range registries {
		host := strings.TrimSpace(registry.Host)
		if host == "" {
			free()
			return nil, 0, nil, fmt.Errorf("boxlite: image registry host is required")
		}
		if strings.Contains(host, "://") || strings.Contains(host, "/") {
			free()
			return nil, 0, nil, fmt.Errorf("boxlite: image registry host must be host[:port], not a URL: %s", registry.Host)
		}

		cHost := C.CString(host)
		cStrings = append(cStrings, cHost)
		transport, err := cRegistryTransport(registry.Transport)
		if err != nil {
			free()
			return nil, 0, nil, err
		}

		goSlice[i].host = cHost
		goSlice[i].transport = transport
		goSlice[i].skip_verify = cBool(registry.SkipVerify)
		goSlice[i].search = cBool(registry.Search)

		if registry.Auth.BearerToken != "" {
			cToken := C.CString(registry.Auth.BearerToken)
			cStrings = append(cStrings, cToken)
			goSlice[i].bearer_token = cToken
			continue
		}

		if registry.Auth.Username != "" || registry.Auth.Password != "" {
			if registry.Auth.Username == "" || registry.Auth.Password == "" {
				free()
				return nil, 0, nil, fmt.Errorf("boxlite: registry username and password must be provided together")
			}
			cUsername := C.CString(registry.Auth.Username)
			cPassword := C.CString(registry.Auth.Password)
			cStrings = append(cStrings, cUsername, cPassword)
			goSlice[i].username = cUsername
			goSlice[i].password = cPassword
		}
	}

	return (*C.BoxliteImageRegistry)(cArray), len(registries), free, nil
}

func cRegistryTransport(transport RegistryTransport) (uint32, error) {
	switch transport {
	case "", RegistryTransportHTTPS:
		return uint32(C.BoxliteRegistryTransportHttps), nil
	case RegistryTransportHTTP:
		return uint32(C.BoxliteRegistryTransportHttp), nil
	default:
		return uint32(C.BoxliteRegistryTransportHttps), fmt.Errorf("boxlite: unsupported registry transport %q", transport)
	}
}

func cBool(value bool) C.int {
	if value {
		return 1
	}
	return 0
}

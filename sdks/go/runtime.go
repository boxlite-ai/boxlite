// Package boxlite provides an idiomatic Go SDK for the BoxLite runtime.
package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"time"
	"unsafe"
)

// Version returns the BoxLite library version string.
func Version() string {
	return C.GoString(C.boxlite_version())
}

// Runtime manages BoxLite boxes. Create one with NewRuntime.
type Runtime struct {
	handle *C.CBoxliteRuntime
}

// NewRuntime creates a new BoxLite runtime.
func NewRuntime(opts ...RuntimeOption) (*Runtime, error) {
	cfg := &runtimeConfig{}
	for _, o := range opts {
		o(cfg)
	}

	var homeDir *C.char
	if cfg.homeDir != "" {
		homeDir = toCString(cfg.homeDir)
		defer C.free(unsafe.Pointer(homeDir))
	}

	cRegistries, registriesCount := toCStringArray(cfg.registries)
	defer freeCStringArray(cRegistries, registriesCount)

	var handle *C.CBoxliteRuntime
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_new(homeDir, cRegistries, C.int(registriesCount), &handle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Runtime{handle: handle}, nil
}

// Close releases the runtime. Implements io.Closer.
func (r *Runtime) Close() error {
	if r.handle != nil {
		C.boxlite_runtime_free(r.handle)
		r.handle = nil
	}
	return nil
}

// Shutdown gracefully stops all boxes in this runtime.
func (r *Runtime) Shutdown(_ context.Context, timeout time.Duration) error {
	secs := int(timeout.Seconds())
	if secs <= 0 {
		secs = 0
	}
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_shutdown(r.handle, C.int(secs), &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Create creates and returns a new box.
func (r *Runtime) Create(_ context.Context, image string, opts ...BoxOption) (*Box, error) {
	cfg := &boxConfig{}
	for _, o := range opts {
		o(cfg)
	}

	cOpts, err := buildCOptions(image, cfg)
	if err != nil {
		return nil, err
	}

	var boxHandle *C.CBoxHandle
	var cerr C.CBoxliteError
	code := C.boxlite_create_box(r.handle, cOpts, &boxHandle, &cerr)
	if code != C.Ok {
		C.boxlite_options_free(cOpts)
		return nil, freeError(&cerr)
	}

	cID := C.boxlite_box_id(boxHandle)
	id := ""
	if cID != nil {
		id = C.GoString(cID)
		freeBoxliteString(cID)
	}

	return &Box{handle: boxHandle, id: id, name: cfg.name}, nil
}

// Get retrieves an existing box by ID or name.
func (r *Runtime) Get(_ context.Context, idOrName string) (*Box, error) {
	cID := toCString(idOrName)
	defer C.free(unsafe.Pointer(cID))

	var boxHandle *C.CBoxHandle
	var cerr C.CBoxliteError
	code := C.boxlite_get(r.handle, cID, &boxHandle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	cBoxID := C.boxlite_box_id(boxHandle)
	id := ""
	if cBoxID != nil {
		id = C.GoString(cBoxID)
		freeBoxliteString(cBoxID)
	}

	return &Box{handle: boxHandle, id: id}, nil
}

// Remove removes a box by ID or name.
func (r *Runtime) Remove(_ context.Context, idOrName string) error {
	cID := toCString(idOrName)
	defer C.free(unsafe.Pointer(cID))

	var cerr C.CBoxliteError
	code := C.boxlite_remove(r.handle, cID, 0, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// ForceRemove forcefully removes a box (stops it first if running).
func (r *Runtime) ForceRemove(_ context.Context, idOrName string) error {
	cID := toCString(idOrName)
	defer C.free(unsafe.Pointer(cID))

	var cerr C.CBoxliteError
	code := C.boxlite_remove(r.handle, cID, 1, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

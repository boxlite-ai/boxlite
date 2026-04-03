// Package boxlite provides an idiomatic Go SDK for the BoxLite runtime.
//
// BoxLite is an embeddable virtual machine runtime for secure, isolated code
// execution. Think "SQLite for sandboxing".
//
// # Quick Start
//
//	rt, err := boxlite.NewRuntime()
//	if err != nil { log.Fatal(err) }
//	defer rt.Close()
//
//	box, err := rt.Create(ctx, "alpine:latest", boxlite.WithName("my-box"))
//	if err != nil { log.Fatal(err) }
//	defer box.Close()
//
//	result, err := box.Exec(ctx, "echo", "hello")
//	fmt.Println(result.Stdout) // "hello\n"
package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"encoding/json"
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

	var registriesJSON *C.char
	if len(cfg.registries) > 0 {
		data, err := json.Marshal(cfg.registries)
		if err != nil {
			return nil, err
		}
		registriesJSON = toCString(string(data))
		defer C.free(unsafe.Pointer(registriesJSON))
	}

	var handle *C.CBoxliteRuntime
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_new(homeDir, registriesJSON, &handle, &cerr)
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
		secs = 0 // 0 = use default (10s)
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

	wire, err := buildOptionsJSON(image, cfg)
	if err != nil {
		return nil, err
	}
	optsJSON, err := json.Marshal(wire)
	if err != nil {
		return nil, err
	}

	cOptsJSON := toCString(string(optsJSON))
	defer C.free(unsafe.Pointer(cOptsJSON))

	var boxHandle *C.CBoxHandle
	var cerr C.CBoxliteError
	code := C.boxlite_create_box(r.handle, cOptsJSON, &boxHandle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	// Read back the assigned ID.
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

// ListInfo lists all boxes.
func (r *Runtime) ListInfo(_ context.Context) ([]BoxInfo, error) {
	var cJSON *C.char
	var cerr C.CBoxliteError
	code := C.boxlite_list_info(r.handle, &cJSON, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	jsonStr := C.GoString(cJSON)
	freeBoxliteString(cJSON)

	var wireInfos []boxInfoWire
	if err := json.Unmarshal([]byte(jsonStr), &wireInfos); err != nil {
		return nil, err
	}

	result := make([]BoxInfo, len(wireInfos))
	for i := range wireInfos {
		result[i] = wireInfos[i].toBoxInfo()
	}
	return result, nil
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

// Metrics returns aggregate runtime metrics.
func (r *Runtime) Metrics(_ context.Context) (*RuntimeMetrics, error) {
	var cJSON *C.char
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_metrics(r.handle, &cJSON, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	jsonStr := C.GoString(cJSON)
	freeBoxliteString(cJSON)

	var m RuntimeMetrics
	if err := json.Unmarshal([]byte(jsonStr), &m); err != nil {
		return nil, err
	}
	return &m, nil
}

package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"runtime/cgo"
	"sync"
	"unsafe"
)

// ImportOptions changes configuration without rewriting the source archive.
// Nil environment values remove keys. Startup preflight may pull image config;
// its zero value preserves ordinary Import's offline behavior.
type ImportOptions struct {
	Image            string             `json:"image,omitempty"`
	Env              map[string]*string `json:"env,omitempty"`
	PreflightStartup bool               `json:"preflight_startup,omitempty"`
}

// ImportArchiveInfo describes the source, before configuration overrides.
type ImportArchiveInfo struct {
	Version         uint32          `json:"version"`
	BoxOptions      json.RawMessage `json:"box_options"`
	HasDiskChecksum bool            `json:"has_disk_checksum"`
}

// PreparedImport owns validated staging until Commit or Close. It is local-only.
// Commit/Close are serialized; an accepted commit keeps its own staging alive.
type PreparedImport struct {
	mu      sync.Mutex
	handle  *C.CPreparedImport
	runtime *Runtime
}

func preparedImportUnavailable() error {
	return &Error{Code: ErrInvalidState, Message: "prepared import is closed or already committed"}
}

func (a *PreparedImport) Info() (ImportArchiveInfo, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.handle == nil {
		return ImportArchiveInfo{}, preparedImportUnavailable()
	}
	var info ImportArchiveInfo
	err := json.Unmarshal([]byte(C.GoString(C.boxlite_prepared_import_info_json(a.handle))), &info)
	return info, err
}

// Close releases uncommitted staging; it never removes a committed box.
func (a *PreparedImport) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.handle != nil {
		C.boxlite_prepared_import_free(a.handle)
		a.handle = nil
	}
	return nil
}

// PrepareImport extracts and validates once without creating or removing a box.
// After success the source may be removed; Commit uses the owned staging.
// Canceling the wait disposes a late successful result. Retain the source until
// accepted preparation actually completes, including after cancellation.
func (r *Runtime) PrepareImport(ctx context.Context, path string, options ImportOptions) (*PreparedImport, error) {
	if err := validateArchiveArgument(path, "archive path", false); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if r == nil || r.handle == nil {
		return nil, ErrRuntimeClosed
	}
	select {
	case <-r.closing:
		return nil, ErrRuntimeClosed
	default:
	}
	encoded, err := json.Marshal(options)
	if err != nil {
		return nil, err
	}
	cPath, cOptions := toCString(path), toCString(string(encoded))
	defer C.free(unsafe.Pointer(cPath))
	defer C.free(unsafe.Pointer(cOptions))
	r.ensureDrainRunning()
	result := make(chan handleResult[*C.CPreparedImport], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))
	if err := ctx.Err(); err != nil {
		deleteHandleForDispatch(handle)
		return nil, err
	}
	var cError C.CBoxliteError
	code := C.boxlite_runtime_prepare_import(r.handle, cPath, cOptions, C.cbPrepareImport(), handleToPtr(handle), &cError)
	if code != C.Ok {
		deleteHandleForDispatch(handle)
		return nil, freeError(&cError)
	}
	dispose := func(handle *C.CPreparedImport) {
		if handle != nil {
			C.boxlite_prepared_import_free(handle)
		}
	}
	select {
	case completed := <-result:
		if completed.err != nil {
			dispose(completed.value)
			return nil, completed.err
		}
		return &PreparedImport{handle: completed.value, runtime: r}, nil
	case <-ctx.Done():
		abandonOwnedResult(result, handle, dispose)
		return nil, ctx.Err()
	case <-r.closing:
		abandonOwnedResult(result, handle, dispose)
		return nil, ErrRuntimeClosed
	}
}

// Commit consumes this owner once native work is accepted. Argument/context or
// synchronous submission errors keep it available. Cancellation after acceptance
// stops waiting, but the box may still be created; query its name before retrying.
func (a *PreparedImport) Commit(ctx context.Context, name string) (*Box, error) {
	if err := validateArchiveArgument(name, "import name", true); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	a.mu.Lock()
	if a.handle == nil {
		a.mu.Unlock()
		return nil, preparedImportUnavailable()
	}
	r := a.runtime
	select {
	case <-r.closing:
		a.mu.Unlock()
		return nil, ErrRuntimeClosed
	default:
	}
	cName, freeName := archiveNameCString(name)
	defer freeName()
	r.ensureDrainRunning()
	result := make(chan handleResult[*C.CBoxHandle], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))
	if err := ctx.Err(); err != nil {
		deleteHandleForDispatch(handle)
		a.mu.Unlock()
		return nil, err
	}
	var cError C.CBoxliteError
	code := C.boxlite_prepared_import_commit(a.handle, cName, C.cbRuntimeImport(), handleToPtr(handle), &cError)
	if code == C.Ok {
		C.boxlite_prepared_import_free(a.handle)
		a.handle = nil
	}
	a.mu.Unlock()
	if code != C.Ok {
		deleteHandleForDispatch(handle)
		return nil, freeError(&cError)
	}
	dispose := func(handle *C.CBoxHandle) {
		if handle != nil {
			C.boxlite_box_free(handle)
		}
	}
	select {
	case completed := <-result:
		if completed.err != nil {
			dispose(completed.value)
			return nil, completed.err
		}
		return newBoxFromHandle(r, completed.value, name), nil
	case <-ctx.Done():
		abandonOwnedResult(result, handle, dispose)
		return nil, ctx.Err()
	case <-r.closing:
		abandonOwnedResult(result, handle, dispose)
		return nil, ErrRuntimeClosed
	}
}

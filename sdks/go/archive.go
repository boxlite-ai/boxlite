package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"runtime/cgo"
	"strings"
	"unsafe"
)

func validateArchiveArgument(value, parameter string, allowEmpty bool) error {
	if value == "" && !allowEmpty {
		return &Error{
			Code:    ErrInvalidArgument,
			Message: parameter + " must not be empty",
		}
	}
	if strings.IndexByte(value, 0) >= 0 {
		return &Error{
			Code:    ErrInvalidArgument,
			Message: parameter + " must not contain NUL bytes",
		}
	}
	return nil
}

func archiveNameCString(name string) (*C.char, func()) {
	if name == "" {
		return nil, func() {}
	}
	cName := toCString(name)
	return cName, func() {
		C.free(unsafe.Pointer(cName))
	}
}

func abandonOwnedResult[T any](result <-chan handleResult[T], handle cgo.Handle, dispose func(T)) {
	if claimHandleForDispatch(handle) {
		handle.Delete()
		return
	}

	go func() {
		completed := <-result
		dispose(completed.value)
	}()
}

// Export exports the box to a portable .boxlite archive.
//
// If dest is a directory, Export creates the archive inside it and returns the
// actual archive file path selected by the backend.
//
// Export never deletes the archive. The caller owns the returned file and is
// responsible for retaining, moving, or deleting it.
func (b *Box) Export(ctx context.Context, dest string) (string, error) {
	if err := validateArchiveArgument(dest, "export destination", false); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	b.runtime.ensureDrainRunning()

	cDest := toCString(dest)
	defer C.free(unsafe.Pointer(cDest))

	result := make(chan handleResult[*C.char], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))

	if err := ctx.Err(); err != nil {
		deleteHandleForDispatch(handle)
		return "", err
	}

	var cError C.CBoxliteError
	code := C.boxlite_box_export(
		b.handle,
		cDest,
		C.cbBoxExport(),
		handleToPtr(handle),
		&cError,
	)
	if code != C.Ok {
		deleteHandleForDispatch(handle)
		return "", freeError(&cError)
	}

	dispose := func(path *C.char) {
		if path != nil {
			freeBoxliteString(path)
		}
	}
	select {
	case completed := <-result:
		defer dispose(completed.value)
		if completed.err != nil {
			return "", completed.err
		}
		return cString(completed.value), nil
	case <-ctx.Done():
		abandonOwnedResult(result, handle, dispose)
		return "", ctx.Err()
	case <-b.runtime.closing:
		abandonOwnedResult(result, handle, dispose)
		return "", ErrRuntimeClosed
	}
}

// ImportOptions selects a managed checkpoint instead of an archive file.
// BoxID replaces an idle Box and cannot be combined with a name.
type ImportOptions struct {
	CheckpointID string
	BoxID        string
}

// Import imports a .boxlite archive and returns a new, stopped box.
//
// Local runtimes treat caller-provided archives as trusted and preserve their
// complete configuration. REST runtimes upload the archive, and the server
// applies its untrusted-upload policy.
//
// An empty name leaves the imported box unnamed, matching Create without
// WithName. Import assigns a new box ID.
//
// Import never consumes or deletes archivePath. The caller owns the archive
// and is responsible for retaining, moving, or deleting it.
func (r *Runtime) Import(ctx context.Context, archivePath, name string) (*Box, error) {
	return r.ImportWithOptions(ctx, archivePath, name, ImportOptions{})
}

// ImportWithOptions imports an archive or managed checkpoint through the runtime.
func (r *Runtime) ImportWithOptions(ctx context.Context, archivePath, name string, opts ImportOptions) (*Box, error) {
	if (archivePath == "") == (opts.CheckpointID == "") || (opts.BoxID != "" && (opts.CheckpointID == "" || name != "")) {
		return nil, &Error{Code: ErrInvalidArgument, Message: "specify archive path or checkpoint ID; box ID requires a checkpoint and no name"}
	}
	if err := validateArchiveArgument(opts.CheckpointID, "checkpoint ID", true); err != nil {
		return nil, err
	}
	if err := validateArchiveArgument(opts.BoxID, "box ID", true); err != nil {
		return nil, err
	}
	if err := validateArchiveArgument(archivePath, "archive path", opts.CheckpointID != ""); err != nil {
		return nil, err
	}
	if err := validateArchiveArgument(name, "import name", true); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if r == nil || r.handle == nil {
		return nil, ErrRuntimeClosed
	}
	r.ensureDrainRunning()

	cArchivePath, freePath := archiveNameCString(archivePath)
	defer freePath()
	cCheckpoint, freeCheckpoint := archiveNameCString(opts.CheckpointID)
	defer freeCheckpoint()
	cTarget, freeTarget := archiveNameCString(opts.BoxID)
	defer freeTarget()
	cName, freeName := archiveNameCString(name)
	defer freeName()

	result := make(chan handleResult[*C.CBoxHandle], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))

	if err := ctx.Err(); err != nil {
		deleteHandleForDispatch(handle)
		return nil, err
	}

	var cError C.CBoxliteError
	source := C.CBoxImportOptions{archive_path: cArchivePath, name: cName, checkpoint_id: cCheckpoint, box_id: cTarget}
	code := C.boxlite_runtime_import_with_options(r.handle, &source, C.cbRuntimeImport(), handleToPtr(handle), &cError)
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
		return importedBoxFromHandle(r, completed.value)
	case <-ctx.Done():
		abandonOwnedResult(result, handle, dispose)
		return nil, ctx.Err()
	case <-r.closing:
		abandonOwnedResult(result, handle, dispose)
		return nil, ErrRuntimeClosed
	}
}

func importedBoxFromHandle(runtime *Runtime, native *C.CBoxHandle) (*Box, error) {
	if native == nil {
		return nil, &Error{Code: ErrInternal, Message: "import callback returned no Box"}
	}
	box := newBoxFromHandle(runtime, native, "")
	name := C.boxlite_box_name(native)
	if name != nil {
		box.name = cString(name)
		freeBoxliteString(name)
	}
	return box, nil
}

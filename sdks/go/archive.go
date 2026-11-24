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
	"strings"
	"unsafe"
)

// CheckpointExportPolicy identifies the finalized snapshot and image of a managed capture.
type CheckpointExportPolicy struct {
	Snapshot    json.RawMessage `json:"snapshot"`
	PinnedImage string          `json:"pinned_image"`
}

// CheckpointImportPolicy identifies the prepared snapshot and platform environment of a restore.
type CheckpointImportPolicy struct {
	CheckpointExportPolicy
	PlatformEnv map[string]string `json:"platform_env"`
}

// ValidateLegacyArchive checks archive metadata without installing a Box.
func ValidateLegacyArchive(path string) error {
	if err := validateArchiveArgument(path, "archive path", false); err != nil {
		return err
	}
	cPath := toCString(path)
	defer C.free(unsafe.Pointer(cPath))
	var cError C.CBoxliteError
	if C.boxlite_archive_validate_legacy(cPath, &cError) != C.Ok {
		return freeError(&cError)
	}
	return nil
}

func managedArchiveTransport[T any](policy T) (string, error) {
	encoded, err := json.Marshal(struct {
		Managed T `json:"managed"`
	}{Managed: policy})
	return string(encoded), err
}

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
	return b.exportArchive(ctx, dest, "")
}

// ExportLegacy exports an archive for a legacy managed transport.
func (b *Box) ExportLegacy(ctx context.Context, dest string) (string, error) {
	return b.exportArchive(ctx, dest, `"legacy_only"`)
}

// ExportManagedCheckpoint exports a finalized managed policy and image with the disk.
func (b *Box) ExportManagedCheckpoint(ctx context.Context, dest string, policy CheckpointExportPolicy) (string, error) {
	transport, err := managedArchiveTransport(policy)
	if err != nil {
		return "", err
	}
	return b.exportArchive(ctx, dest, transport)
}

func (b *Box) exportArchive(ctx context.Context, dest, transport string) (string, error) {
	if err := validateArchiveArgument(dest, "export destination", false); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}

	b.runtime.ensureDrainRunning()

	cDest := toCString(dest)
	defer C.free(unsafe.Pointer(cDest))

	if err := ctx.Err(); err != nil {
		return "", err
	}

	boxHandle, unlock, err := b.acquire()
	if err != nil {
		return "", err
	}

	result := make(chan handleResult[*C.char], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))

	var cError C.CBoxliteError
	var code C.enum_BoxliteErrorCode
	if transport == "" {
		code = C.boxlite_box_export(boxHandle, cDest, C.cbBoxExport(), handleToPtr(handle), &cError)
	} else {
		cTransport := toCString(transport)
		defer C.free(unsafe.Pointer(cTransport))
		code = C.boxlite_box_export_controlled(boxHandle, cDest, cTransport, C.cbBoxExport(), handleToPtr(handle), &cError)
	}
	unlock()
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
	return r.importArchive(ctx, archivePath, name, "")
}

// ImportLegacy imports through a legacy managed transport.
func (r *Runtime) ImportLegacy(ctx context.Context, archivePath, name string) (*Box, error) {
	return r.importArchive(ctx, archivePath, name, `"legacy_only"`)
}

// ImportManagedCheckpoint validates a managed archive and persists its prepared target policy.
func (r *Runtime) ImportManagedCheckpoint(ctx context.Context, archivePath, name string, policy CheckpointImportPolicy) (*Box, error) {
	transport, err := managedArchiveTransport(policy)
	if err != nil {
		return nil, err
	}
	return r.importArchive(ctx, archivePath, name, transport)
}

func (r *Runtime) importArchive(ctx context.Context, archivePath, name, transport string) (*Box, error) {
	if err := validateArchiveArgument(archivePath, "archive path", false); err != nil {
		return nil, err
	}
	if err := validateArchiveArgument(name, "import name", true); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	r.ensureDrainRunning()

	cArchivePath := toCString(archivePath)
	defer C.free(unsafe.Pointer(cArchivePath))
	cName, freeName := archiveNameCString(name)
	defer freeName()

	result := make(chan handleResult[*C.CBoxHandle], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))

	if err := ctx.Err(); err != nil {
		deleteHandleForDispatch(handle)
		return nil, err
	}

	var cError C.CBoxliteError
	var code C.enum_BoxliteErrorCode
	if transport == "" {
		code = C.boxlite_runtime_import(r.handle, cArchivePath, cName, C.cbRuntimeImport(), handleToPtr(handle), &cError)
	} else {
		cTransport := toCString(transport)
		defer C.free(unsafe.Pointer(cTransport))
		code = C.boxlite_runtime_import_controlled(r.handle, cArchivePath, cName, cTransport, C.cbRuntimeImport(), handleToPtr(handle), &cError)
	}
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

package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"runtime/cgo"
	"unsafe"
)

// CloneBox creates a new box that's a copy of the receiver's disk state.
// `name` may be empty to leave the clone unnamed.
func (b *Box) CloneBox(ctx context.Context, name string) (*Box, error) {
	b.runtime.ensureDrainRunning()

	var cName *C.char
	if name != "" {
		cName = toCString(name)
		defer C.free(unsafe.Pointer(cName))
	}

	ch := make(chan handleResult[*C.CBoxHandle], 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_box_clone_box(b.handle, cName, C.cbCloneBox(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		if res.err != nil {
			return nil, res.err
		}
		return newBoxFromHandle(b.runtime, res.value, name), nil
	case <-ctx.Done():
		abandonAsync(ch, h, b.runtime.closing, b.runtime.forceRemoveOrphanBox)
		return nil, ctx.Err()
	case <-b.runtime.closing:
		abandonAsync(ch, h, b.runtime.closing, b.runtime.forceRemoveOrphanBox)
		return nil, ErrRuntimeClosed
	}
}

// Export writes the box's disks to a portable `.boxlite` archive at `dest`.
func (b *Box) Export(ctx context.Context, dest string) error {
	b.runtime.ensureDrainRunning()

	cDest := toCString(dest)
	defer C.free(unsafe.Pointer(cDest))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_box_export(b.handle, cDest, C.cbExportBox(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, b.runtime.closing)
		return ctx.Err()
	case <-b.runtime.closing:
		abandonAsyncErr(ch, h, b.runtime.closing)
		return ErrRuntimeClosed
	}
}

// ImportBox reads a `.boxlite` archive from `archivePath` and returns the
// newly-imported box. `name` may be empty to leave it unnamed.
func (r *Runtime) ImportBox(ctx context.Context, archivePath, name string) (*Box, error) {
	r.ensureDrainRunning()

	cPath := toCString(archivePath)
	defer C.free(unsafe.Pointer(cPath))
	var cName *C.char
	if name != "" {
		cName = toCString(name)
		defer C.free(unsafe.Pointer(cName))
	}

	ch := make(chan handleResult[*C.CBoxHandle], 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_runtime_import_box(
		r.handle,
		cPath,
		cName,
		C.cbCreateBox(),
		handleToPtr(h),
		&cerr,
	)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		if res.err != nil {
			return nil, res.err
		}
		return newBoxFromHandle(r, res.value, name), nil
	case <-ctx.Done():
		abandonAsync(ch, h, r.closing, r.forceRemoveOrphanBox)
		return nil, ctx.Err()
	case <-r.closing:
		abandonAsync(ch, h, r.closing, r.forceRemoveOrphanBox)
		return nil, ErrRuntimeClosed
	}
}

// ─── Cgo callback exports ─────────────────────────────────────────────────

//export goBoxliteOnCloneBox
func goBoxliteOnCloneBox(box *C.CBoxHandle, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	if !claimOrFreePayload(h, &box, func(b **C.CBoxHandle) {
		if b != nil && *b != nil {
			C.boxlite_box_free(*b)
		}
	}) {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan handleResult[*C.CBoxHandle])
	if !ok {
		return
	}
	if err := errorFromCError(errPtr); err != nil {
		ch <- handleResult[*C.CBoxHandle]{err: err}
		return
	}
	ch <- handleResult[*C.CBoxHandle]{value: box}
}

//export goBoxliteOnExportBox
func goBoxliteOnExportBox(errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	if !claimHandleForDispatch(h) {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan error)
	if !ok {
		return
	}
	ch <- errorFromCError(errPtr)
}

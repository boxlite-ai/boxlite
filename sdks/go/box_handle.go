package boxlite

/*
#include "bridge.h"
*/
import "C"
import (
	"context"
	"runtime/cgo"
)

// Box is a handle to a BoxLite box (virtual machine).
// Call Close to release the handle when done. Closing does not destroy the box.
type Box struct {
	runtime *Runtime
	handle  *C.CBoxHandle
	id      string
	name    string
}

// newBoxFromHandle wraps a freshly-returned C.CBoxHandle into the Go Box
// type. The box keeps a reference to its parent Runtime so the same drain
// loop services its async lifecycle ops.
func newBoxFromHandle(r *Runtime, handle *C.CBoxHandle, name string) *Box {
	id := ""
	if handle != nil {
		cID := C.boxlite_box_id(handle)
		if cID != nil {
			id = C.GoString(cID)
			freeBoxliteString(cID)
		}
	}
	return &Box{runtime: r, handle: handle, id: id, name: name}
}

// ID returns the unique identifier of the box.
func (b *Box) ID() string { return b.id }

// Name returns the user-defined name of the box, if set.
func (b *Box) Name() string { return b.name }

// PulledImage reports the registry digest and declared size of the image this
// box was started from, and whether this process is the one that resolved it.
//
// For a caller that started a box from a mutable tag and needs to know which
// build it actually got. ok is false for a box this process only reattached to
// and for one booted from a local rootfs path. Nothing is resolved until the
// box starts, so read this after Start rather than after create.
func (b *Box) PulledImage() (digest string, sizeBytes int64, ok bool) {
	if b.handle == nil {
		return "", 0, false
	}
	cDigest := C.boxlite_box_pulled_image_digest(b.handle)
	if cDigest == nil {
		return "", 0, false
	}
	digest = C.GoString(cDigest)
	freeBoxliteString(cDigest)
	return digest, int64(C.boxlite_box_pulled_image_size(b.handle)), true
}

// Start starts (or restarts) the box.
func (b *Box) Start(ctx context.Context) error {
	b.runtime.ensureDrainRunning()

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_start_box(b.handle, C.cbStartBox(), handleToPtr(h), &cerr)
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

// Stop stops the box.
func (b *Box) Stop(ctx context.Context) error {
	b.runtime.ensureDrainRunning()

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_stop_box(b.handle, C.cbStopBox(), handleToPtr(h), &cerr)
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

// Close releases the box handle. The box itself continues to exist in the runtime.
func (b *Box) Close() error {
	if b.handle != nil {
		C.boxlite_box_free(b.handle)
		b.handle = nil
	}
	return nil
}

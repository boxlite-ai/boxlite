package boxlite

/*
#include "boxlite.h"
*/
import "C"
import "context"

// Box is a handle to a BoxLite box (virtual machine).
// Call Close to release the handle when done. Closing does not destroy the box.
type Box struct {
	handle *C.CBoxHandle
	id     string
	name   string
}

// ID returns the unique identifier of the box.
func (b *Box) ID() string { return b.id }

// Name returns the user-defined name of the box, if set.
func (b *Box) Name() string { return b.name }

// Start starts (or restarts) the box.
func (b *Box) Start(_ context.Context) error {
	var cerr C.CBoxliteError
	code := C.boxlite_start_box(b.handle, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Stop stops the box.
func (b *Box) Stop(_ context.Context) error {
	var cerr C.CBoxliteError
	code := C.boxlite_stop_box(b.handle, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// Close releases the box handle. The box itself continues to exist in the runtime.
func (b *Box) Close() error {
	if b.handle != nil {
		C.boxlite_box_free(b.handle)
		b.handle = nil
	}
	return nil
}

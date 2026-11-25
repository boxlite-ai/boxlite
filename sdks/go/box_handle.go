package boxlite

/*
#include "bridge.h"
*/
import "C"
import (
	"context"
	"runtime/cgo"
	"sync"
)

// errBoxClosed is returned by every Box method once Close has released the
// native handle.
var errBoxClosed = &Error{Code: ErrInvalidState, Message: "box is closed"}

// Box is a handle to a BoxLite box (virtual machine).
//
// A Box is safe for concurrent use. Native calls share-lock the handle for
// the duration of their synchronous C submission; Close exclusively locks
// it, waits for those submissions to finish, then frees the handle exactly
// once. Call Close to release the handle when done. Closing does not
// destroy the box.
type Box struct {
	runtime *Runtime

	// mu guards handle. RLock is held only across the synchronous C
	// submission — the window in which the native side dereferences the
	// pointer and clones its shared state — never across the async
	// completion wait.
	mu     sync.RWMutex
	handle *C.CBoxHandle

	id   string
	name string
}

// acquire returns the live handle for one synchronous C call plus the
// matching unlock. After unlock the native side holds its own clones and no
// longer reads the wrapper pointer, so the caller may wait on completions
// without holding anything.
func (b *Box) acquire() (*C.CBoxHandle, func(), error) {
	b.mu.RLock()
	if b.handle == nil {
		b.mu.RUnlock()
		return nil, nil, errBoxClosed
	}
	return b.handle, b.mu.RUnlock, nil
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
func (b *Box) Name() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.name
}

// Start starts (or restarts) the box.
func (b *Box) Start(ctx context.Context) error {
	handle, unlock, err := b.acquire()
	if err != nil {
		return err
	}

	b.runtime.ensureDrainRunning()

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_start_box(handle, C.cbStartBox(), handleToPtr(h), &cerr)
	unlock()
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
	handle, unlock, err := b.acquire()
	if err != nil {
		return err
	}

	b.runtime.ensureDrainRunning()

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_stop_box(handle, C.cbStopBox(), handleToPtr(h), &cerr)
	unlock()
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

// Close releases the box handle. It waits for in-flight native submissions
// to finish, then frees the handle exactly once. Later calls return
// errBoxClosed; repeat Close is a no-op. The box itself continues to exist
// in the runtime.
func (b *Box) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.handle == nil {
		return nil
	}
	C.boxlite_box_free(b.handle)
	b.handle = nil
	return nil
}

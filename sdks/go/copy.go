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

// CopyInto copies a host file or directory into the box.
func (b *Box) CopyInto(ctx context.Context, hostSrc, guestDst string) error {
	b.runtime.ensureDrainRunning()

	cSrc := toCString(hostSrc)
	defer C.free(unsafe.Pointer(cSrc))
	cDst := toCString(guestDst)
	defer C.free(unsafe.Pointer(cDst))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_into(b.handle, cSrc, cDst, C.cbCopy(), handleToPtr(h), &cerr)
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

// CopyOut copies a file or directory from the box to the host.
func (b *Box) CopyOut(ctx context.Context, guestSrc, hostDst string) error {
	b.runtime.ensureDrainRunning()

	cSrc := toCString(guestSrc)
	defer C.free(unsafe.Pointer(cSrc))
	cDst := toCString(hostDst)
	defer C.free(unsafe.Pointer(cDst))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_out(b.handle, cSrc, cDst, C.cbCopy(), handleToPtr(h), &cerr)
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

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

// CopyIntoOptions controls per-call copy behaviour. The Go SDK exposes
// only `Overwrite` for now — the other CopyOptions bits (recursive,
// follow_symlinks, include_parent) are interpreted at host-tarball
// creation time by callers above this layer and don't need to cross
// the FFI seam.
type CopyIntoOptions struct {
	// Overwrite, when false, causes copy_into to refuse to clobber
	// destination paths that already exist in the guest. Defaults to
	// true to preserve the historical "overwrite everything" behaviour
	// of `CopyInto`.
	Overwrite bool
}

func defaultCopyIntoOptions() CopyIntoOptions {
	return CopyIntoOptions{Overwrite: true}
}

// CopyInto copies a host file or directory into the box, overwriting
// any existing guest destination. For the `Overwrite=false` variant
// use CopyIntoWithOptions.
func (b *Box) CopyInto(ctx context.Context, hostSrc, guestDst string) error {
	return b.CopyIntoWithOptions(ctx, hostSrc, guestDst, defaultCopyIntoOptions())
}

// CopyIntoWithOptions is the option-bearing form of CopyInto. The runner
// uses this so REST `copy_in(..., overwrite=False)` reaches the guest
// with O_EXCL semantics enforced inside libboxlite.
func (b *Box) CopyIntoWithOptions(ctx context.Context, hostSrc, guestDst string, opts CopyIntoOptions) error {
	b.runtime.ensureDrainRunning()

	cSrc := toCString(hostSrc)
	defer C.free(unsafe.Pointer(cSrc))
	cDst := toCString(guestDst)
	defer C.free(unsafe.Pointer(cDst))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_into_with_options(
		b.handle,
		cSrc,
		cDst,
		C.bool(opts.Overwrite),
		C.cbCopy(),
		handleToPtr(h),
		&cerr,
	)
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

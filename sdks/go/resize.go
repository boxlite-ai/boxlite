package boxlite

/*
#include "bridge.h"
*/
import "C"

import (
	"context"
	"runtime/cgo"
)

// ResizeOptions specifies absolute resource targets. Zero leaves a resource unchanged.
type ResizeOptions struct {
	CPUs      uint8
	MemoryMiB uint32
}

// BoxResources reports the allocation and ceilings fixed at the current boot.
type BoxResources struct {
	CPUs         uint8
	MemoryMiB    uint32
	MaxCPUs      uint8
	MaxMemoryMiB uint32
}

type resizeResult struct {
	value *BoxResources
	err   error
}

// Resize grows a running box without restarting it. Empty options query its
// allocation. Cancelling ctx stops waiting; the submitted resize can still complete.
func (b *Box) Resize(ctx context.Context, opts ResizeOptions) (*BoxResources, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if b == nil || b.handle == nil {
		return nil, &Error{Code: ErrInvalidState, Message: "box handle is closed"}
	}
	b.runtime.ensureDrainRunning()
	ch := make(chan resizeResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	code := C.boxlite_resize_box(b.handle, C.uint8_t(opts.CPUs), C.uint32_t(opts.MemoryMiB), C.cbResizeBox(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}
	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, b.runtime.closing)
		return nil, ctx.Err()
	case <-b.runtime.closing:
		drainAndDelete(ch, h, b.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

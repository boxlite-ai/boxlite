//go:build boxlite_runner

package boxlite

/*
#include "bridge.h"
*/
import "C"

import (
	"context"
	"runtime/cgo"
)

// StartRunner applies this Cloud cold-start choice without persisting it.
// Ordinary local SDK builds do not expose this entry point.
func (b *Box) StartRunner(ctx context.Context, nestedVirtualization bool) error {
	b.runtime.ensureDrainRunning()
	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	code := C.boxlite_internal_runner_start_box(b.handle, boolToCInt(nestedVirtualization), C.cbStartBox(), handleToPtr(h), &cerr)
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

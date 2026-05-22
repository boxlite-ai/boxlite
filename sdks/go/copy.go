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

// CopyInto/CopyOut delegate to the Rust core via CGO; the runner /files
// wire shape (PUT/GET octet-stream, POST bulk-upload/bulk-download
// multipart) lives in the Rust REST backend at
// src/boxlite/src/rest/litebox.rs — this SDK carries no /files HTTP code.

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

// CopyOutPair is one source/destination pair for Box.CopyOutMany.
type CopyOutPair struct {
	ContainerSrc string
	HostDst      string
}

// CopyOutOutcome is the per-pair result returned by Box.CopyOutMany.
// Err is empty when the pair succeeded; populated with a server-side
// or local disk-write message otherwise. The batch continues either way —
// per-pair failures do NOT cause Box.CopyOutMany to return an error.
type CopyOutOutcome struct {
	ContainerSrc string
	HostDst      string
	Err          string
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

// CopyOutMany copies multiple files out of the box in one round-trip, hitting
// the runner's bulk-download endpoint via the Rust REST backend. Outcomes are
// returned in input order; per-pair failures land in Outcome.Err. The
// returned error is non-nil only for transport-level failures (request
// failed before the server emitted any parts).
func (b *Box) CopyOutMany(ctx context.Context, pairs []CopyOutPair) ([]CopyOutOutcome, error) {
	b.runtime.ensureDrainRunning()

	cPairs, cPairsLen := toCCopyOutPairs(pairs)
	defer freeCCopyOutPairs(cPairs, cPairsLen)

	ch := make(chan copyOutManyResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_out_many(
		b.handle,
		cPairs,
		C.size_t(cPairsLen),
		C.cbCopyOutMany(),
		handleToPtr(h),
		&cerr,
	)
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

// toCCopyOutPairs marshals []CopyOutPair into a C array of CCopyOutPair.
// The returned pointer + length must be freed via freeCCopyOutPairs once
// boxlite_copy_out_many has returned control (Rust copies the strings
// before spawning, so they can be freed as soon as the call returns).
func toCCopyOutPairs(pairs []CopyOutPair) (*C.CCopyOutPair, int) {
	if len(pairs) == 0 {
		return nil, 0
	}
	bytes := C.size_t(len(pairs)) * C.size_t(unsafe.Sizeof(C.CCopyOutPair{}))
	cArray := (*C.CCopyOutPair)(C.malloc(bytes))
	goSlice := unsafe.Slice(cArray, len(pairs))
	for i, p := range pairs {
		goSlice[i].container_src = C.CString(p.ContainerSrc)
		goSlice[i].host_dst = C.CString(p.HostDst)
	}
	return cArray, len(pairs)
}

func freeCCopyOutPairs(arr *C.CCopyOutPair, count int) {
	if arr == nil || count == 0 {
		return
	}
	goSlice := unsafe.Slice(arr, count)
	for i := range goSlice {
		if goSlice[i].container_src != nil {
			C.free(unsafe.Pointer(goSlice[i].container_src))
		}
		if goSlice[i].host_dst != nil {
			C.free(unsafe.Pointer(goSlice[i].host_dst))
		}
	}
	C.free(unsafe.Pointer(arr))
}

// convertCopyOutOutcomeList materialises a CCopyOutOutcomeList* into a Go
// slice. Caller frees the C list via boxlite_free_copy_out_outcome_list.
func convertCopyOutOutcomeList(list *C.CCopyOutOutcomeList) []CopyOutOutcome {
	if list == nil || list.count == 0 || list.items == nil {
		return nil
	}
	items := unsafe.Slice(list.items, int(list.count))
	out := make([]CopyOutOutcome, len(items))
	for i := range items {
		out[i] = CopyOutOutcome{
			ContainerSrc: cString(items[i].container_src),
			HostDst:      cString(items[i].host_dst),
			Err:          cString(items[i].error),
		}
	}
	return out
}

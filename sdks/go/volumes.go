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

// VolumeInfo holds metadata about a named volume.
//
// CreatedAt is an RFC 3339 timestamp string (the C side formats the creation
// time as a string, mirroring the Node/Python SDKs). SizeBytes is nil when the
// payload size could not be computed.
type VolumeInfo struct {
	Name       string
	Mountpoint string
	CreatedAt  string
	SizeBytes  *uint64
}

// Volumes is a runtime-scoped handle for named-volume operations.
type Volumes struct {
	runtime *Runtime
	handle  *C.CBoxliteVolumeHandle
}

func closedVolumesError() error {
	return &Error{Code: ErrInvalidState, Message: "volume handle is closed"}
}

// Volumes returns a runtime-scoped handle for named-volume operations.
//
// The C-side volume handle is created synchronously; async operations
// (Create, List, Get, Remove) post events into the parent runtime's event
// queue and are dispatched by the runtime drain goroutine.
func (r *Runtime) Volumes() (*Volumes, error) {
	var handle *C.CBoxliteVolumeHandle
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_volumes(r.handle, &handle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Volumes{runtime: r, handle: handle}, nil
}

// Create creates a named volume and returns its metadata. sizeGb is an
// advisory size hint; pass nil to leave it unset.
func (v *Volumes) Create(ctx context.Context, name string, sizeGb *uint64) (*VolumeInfo, error) {
	if v == nil || v.handle == nil {
		return nil, closedVolumesError()
	}
	v.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))

	var cSizeGb C.uint64_t
	var cHasSizeGb C.int
	if sizeGb != nil {
		cSizeGb = C.uint64_t(*sizeGb)
		cHasSizeGb = 1
	}

	ch := make(chan volumeResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_volume_create(v.handle, cName, cSizeGb, cHasSizeGb, C.cbVolumeCreate(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ctx.Err()
	case <-v.runtime.closing:
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// List lists named volumes for this runtime, sorted by name.
func (v *Volumes) List(ctx context.Context) ([]VolumeInfo, error) {
	if v == nil || v.handle == nil {
		return nil, closedVolumesError()
	}
	v.runtime.ensureDrainRunning()

	ch := make(chan volumeListResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_volume_list(v.handle, C.cbVolumeList(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ctx.Err()
	case <-v.runtime.closing:
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// Get returns metadata for a single named volume.
func (v *Volumes) Get(ctx context.Context, name string) (*VolumeInfo, error) {
	if v == nil || v.handle == nil {
		return nil, closedVolumesError()
	}
	v.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))

	ch := make(chan volumeResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_volume_get(v.handle, cName, C.cbVolumeGet(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ctx.Err()
	case <-v.runtime.closing:
		drainAndDelete(ch, h, v.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// Remove removes a named volume. With force, a missing volume is a no-op.
func (v *Volumes) Remove(ctx context.Context, name string, force bool) error {
	if v == nil || v.handle == nil {
		return closedVolumesError()
	}
	v.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))

	forceFlag := C.int(0)
	if force {
		forceFlag = 1
	}

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_volume_remove(v.handle, cName, forceFlag, C.cbVolumeRemove(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, v.runtime.closing)
		return ctx.Err()
	case <-v.runtime.closing:
		abandonAsyncErr(ch, h, v.runtime.closing)
		return ErrRuntimeClosed
	}
}

// Close releases the volume handle.
func (v *Volumes) Close() error {
	if v != nil && v.handle != nil {
		C.boxlite_volume_free(v.handle)
		v.handle = nil
	}
	return nil
}

// cVolumeInfoToGo materialises a single CVolumeInfo into a Go VolumeInfo. It
// does not free the C struct; the caller owns that.
func cVolumeInfoToGo(info *C.CVolumeInfo) VolumeInfo {
	var size *uint64
	if info.has_size != 0 {
		v := uint64(info.size_bytes)
		size = &v
	}
	return VolumeInfo{
		Name:       cString(info.name),
		Mountpoint: cString(info.mountpoint),
		CreatedAt:  cString(info.created_at),
		SizeBytes:  size,
	}
}

// convertVolumeInfoList materialises a CVolumeInfoList* into a Go VolumeInfo
// slice. The caller is responsible for freeing the C list afterwards.
func convertVolumeInfoList(list *C.CVolumeInfoList) []VolumeInfo {
	if list == nil || list.count == 0 || list.items == nil {
		return nil
	}
	items := unsafe.Slice(list.items, int(list.count))
	volumes := make([]VolumeInfo, len(items))
	for idx := range items {
		volumes[idx] = cVolumeInfoToGo(&items[idx])
	}
	return volumes
}

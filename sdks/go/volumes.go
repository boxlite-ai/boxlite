package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"runtime/cgo"
	"sync"
	"unsafe"
)

// VolumeInfo holds metadata about a volume.
//
// CreatedAt is an RFC 3339 timestamp string (the C side formats the creation
// time as a string, mirroring the Node/Python SDKs). SizeBytes is nil when the
// payload size could not be computed.
type VolumeInfo struct {
	Id        string
	CreatedAt string
	SizeBytes *uint64
}

// Volumes is a runtime-scoped handle for named-volume operations.
type Volumes struct {
	mu      sync.RWMutex
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

// Create creates a volume and returns its metadata.
func (v *Volumes) Create(ctx context.Context) (*VolumeInfo, error) {
	if v == nil {
		return nil, closedVolumesError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return nil, closedVolumesError()
	}
	v.runtime.ensureDrainRunning()

	ch := make(chan volumeResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_volume_create(v.handle, C.cbVolumeCreate(), handleToPtr(h), &cerr)
	v.mu.RUnlock()
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

// List lists named volumes for this runtime.
func (v *Volumes) List(ctx context.Context) ([]VolumeInfo, error) {
	if v == nil {
		return nil, closedVolumesError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return nil, closedVolumesError()
	}
	v.runtime.ensureDrainRunning()

	ch := make(chan volumeListResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_volume_list(v.handle, C.cbVolumeList(), handleToPtr(h), &cerr)
	v.mu.RUnlock()
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

// Get returns metadata for a single volume by id.
func (v *Volumes) Get(ctx context.Context, id string) (*VolumeInfo, error) {
	if v == nil {
		return nil, closedVolumesError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return nil, closedVolumesError()
	}
	v.runtime.ensureDrainRunning()

	cID := toCString(id)
	defer C.free(unsafe.Pointer(cID))

	ch := make(chan volumeResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_volume_get(v.handle, cID, C.cbVolumeGet(), handleToPtr(h), &cerr)
	v.mu.RUnlock()
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

// Remove removes a volume by id. With force, a missing volume is a no-op.
func (v *Volumes) Remove(ctx context.Context, id string, force bool) error {
	if v == nil {
		return closedVolumesError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return closedVolumesError()
	}
	v.runtime.ensureDrainRunning()

	cID := toCString(id)
	defer C.free(unsafe.Pointer(cID))

	forceFlag := C.int(0)
	if force {
		forceFlag = 1
	}

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_volume_remove(v.handle, cID, forceFlag, C.cbVolumeRemove(), handleToPtr(h), &cerr)
	v.mu.RUnlock()
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
	if v != nil {
		v.mu.Lock()
		defer v.mu.Unlock()
		if v.handle != nil {
			C.boxlite_volume_free(v.handle)
			v.handle = nil
		}
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
		Id:        cString(info.id),
		CreatedAt: cString(info.created_at),
		SizeBytes: size,
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

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

// SnapshotInfo describes a disk snapshot. CreatedAt is Unix seconds.
type SnapshotInfo struct {
	Id                 string
	BoxId              string
	Name               string
	Status             string
	Error              string
	CreatedAt          int64
	ContainerDiskBytes uint64
	SizeBytes          uint64
}

// Snapshots manages one source box or the runtime organization. Close releases the handle.
type Snapshots struct {
	mu      sync.RWMutex
	runtime *Runtime
	handle  *C.CBoxliteSnapshotHandle
}

func closedSnapshotsError() error {
	return &Error{Code: ErrInvalidState, Message: "snapshot handle is closed"}
}

// Snapshots returns the cloud organization catalog, including snapshots of deleted boxes.
//
// The C-side snapshot handle is created synchronously; async operations
// (Create, List, Get, Remove) post events into the parent runtime's event
// queue and are dispatched by the runtime drain goroutine.
func (r *Runtime) Snapshots() (*Snapshots, error) {
	var handle *C.CBoxliteSnapshotHandle
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_snapshots(r.handle, &handle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Snapshots{runtime: r, handle: handle}, nil
}

// Create captures this handle's box and waits for a ready snapshot.
// Pass "" for a generated name. Organization-scoped handles reject capture.
func (v *Snapshots) Create(ctx context.Context, name string) (*SnapshotInfo, error) {
	if v == nil {
		return nil, closedSnapshotsError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return nil, closedSnapshotsError()
	}
	v.runtime.ensureDrainRunning()

	ch := make(chan snapshotResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cName *C.char
	if name != "" {
		cName = toCString(name)
		defer C.free(unsafe.Pointer(cName))
	}

	var cerr C.CBoxliteError
	code := C.boxlite_snapshot_create(v.handle, cName, C.cbSnapshotInfo(), handleToPtr(h), &cerr)
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

// List lists named snapshots for this runtime.
func (v *Snapshots) List(ctx context.Context) ([]SnapshotInfo, error) {
	if v == nil {
		return nil, closedSnapshotsError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return nil, closedSnapshotsError()
	}
	v.runtime.ensureDrainRunning()

	ch := make(chan snapshotListResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_snapshot_list(v.handle, C.cbSnapshotList(), handleToPtr(h), &cerr)
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

// Get accepts a cloud snapshot ID or name (local snapshots require a name).
// Missing box-scoped snapshots return nil; organization lookups return ErrNotFound.
func (v *Snapshots) Get(ctx context.Context, id string) (*SnapshotInfo, error) {
	if v == nil {
		return nil, closedSnapshotsError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return nil, closedSnapshotsError()
	}
	v.runtime.ensureDrainRunning()

	cID := toCString(id)
	defer C.free(unsafe.Pointer(cID))

	ch := make(chan snapshotResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_snapshot_get(v.handle, cID, C.cbSnapshotInfo(), handleToPtr(h), &cerr)
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

// Remove removes a snapshot by id. With force, a missing snapshot is a no-op.
func (v *Snapshots) Remove(ctx context.Context, id string, force bool) error {
	if v == nil {
		return closedSnapshotsError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return closedSnapshotsError()
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
	code := C.boxlite_snapshot_remove(v.handle, cID, forceFlag, C.cbSnapshotOp(), handleToPtr(h), &cerr)
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

// Close releases the snapshot handle.
func (v *Snapshots) Close() error {
	if v != nil {
		v.mu.Lock()
		defer v.mu.Unlock()
		if v.handle != nil {
			C.boxlite_snapshot_free(v.handle)
			v.handle = nil
		}
	}
	return nil
}

// cSnapshotInfoToGo materialises a single CSnapshotInfo into a Go SnapshotInfo. It
// does not free the C struct; the caller owns that.
func cSnapshotInfoToGo(info *C.CSnapshotInfo) SnapshotInfo {
	return SnapshotInfo{
		Id: cString(info.id), BoxId: cString(info.box_id), Name: cString(info.name),
		Status: cString(info.status), Error: cString(info.error),
		CreatedAt: int64(info.created_at), ContainerDiskBytes: uint64(info.container_disk_bytes),
		SizeBytes: uint64(info.size_bytes),
	}
}

// convertSnapshotInfoList materialises a CSnapshotInfoList* into a Go SnapshotInfo
// slice. The caller is responsible for freeing the C list afterwards.
func convertSnapshotInfoList(list *C.CSnapshotInfoList) []SnapshotInfo {
	if list == nil || list.count == 0 || list.items == nil {
		return nil
	}
	items := unsafe.Slice(list.items, int(list.count))
	snapshots := make([]SnapshotInfo, len(items))
	for idx := range items {
		snapshots[idx] = cSnapshotInfoToGo(&items[idx])
	}
	return snapshots
}

// Snapshots returns a handle for snapshots taken from this box. Restore targets
// this box. The handle retains the native box until Close is called.
func (b *Box) Snapshots() (*Snapshots, error) {
	if b == nil || b.handle == nil {
		return nil, &Error{Code: ErrInvalidState, Message: "box handle is closed"}
	}
	var handle *C.CBoxliteSnapshotHandle
	var cerr C.CBoxliteError
	if code := C.boxlite_box_snapshots(b.handle, &handle, &cerr); code != C.Ok {
		return nil, freeError(&cerr)
	}
	return &Snapshots{runtime: b.runtime, handle: handle}, nil
}

// Restore replaces this handle's target box disk and waits for completion.
// Cloud targets must be stopped and remain stopped after restore.
func (v *Snapshots) Restore(ctx context.Context, snapshot string) error {
	if v == nil {
		return closedSnapshotsError()
	}
	v.mu.RLock()
	if v.handle == nil {
		v.mu.RUnlock()
		return closedSnapshotsError()
	}
	v.runtime.ensureDrainRunning()
	cID := toCString(snapshot)
	defer C.free(unsafe.Pointer(cID))
	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	code := C.boxlite_snapshot_restore(v.handle, cID, C.cbSnapshotOp(), handleToPtr(h), &cerr)
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

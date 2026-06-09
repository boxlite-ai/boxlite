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

// SnapshotInfo describes a box state snapshot.
type SnapshotInfo struct {
	ID                  string
	BoxID               string
	Name                string
	CreatedAt           int64
	ContainerDiskBytes  uint64
	SizeBytes           uint64
}

type snapshotCreateResult struct {
	value *SnapshotInfo
	err   error
}

type snapshotListResult struct {
	value []SnapshotInfo
	err   error
}

// SnapshotCreate creates a snapshot of the box's current disk state with the
// given name.
func (b *Box) SnapshotCreate(ctx context.Context, name string) (*SnapshotInfo, error) {
	b.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))

	ch := make(chan snapshotCreateResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_box_snapshot_create(b.handle, cName, C.cbSnapshotCreate(), handleToPtr(h), &cerr)
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

// SnapshotList returns every snapshot belonging to this box.
func (b *Box) SnapshotList(ctx context.Context) ([]SnapshotInfo, error) {
	b.runtime.ensureDrainRunning()

	ch := make(chan snapshotListResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_box_snapshot_list(b.handle, C.cbSnapshotList(), handleToPtr(h), &cerr)
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

// SnapshotGet looks up a snapshot by name. Returns (nil, nil) when the
// snapshot is not present (404).
func (b *Box) SnapshotGet(ctx context.Context, name string) (*SnapshotInfo, error) {
	b.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))

	ch := make(chan snapshotCreateResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_box_snapshot_get(b.handle, cName, C.cbSnapshotCreate(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		if res.err != nil {
			// "snapshot not found" surfaces from libboxlite as NotFound; the
			// caller-friendly shape is (nil, nil).
			if be, ok := res.err.(*Error); ok && be.Code == ErrNotFound {
				return nil, nil
			}
			return nil, res.err
		}
		return res.value, nil
	case <-ctx.Done():
		drainAndDelete(ch, h, b.runtime.closing)
		return nil, ctx.Err()
	case <-b.runtime.closing:
		drainAndDelete(ch, h, b.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// SnapshotRemove deletes the named snapshot.
func (b *Box) SnapshotRemove(ctx context.Context, name string) error {
	b.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_box_snapshot_remove(b.handle, cName, C.cbSnapshotRemove(), handleToPtr(h), &cerr)
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

// SnapshotRestore reverts the box's disks to the named snapshot.
func (b *Box) SnapshotRestore(ctx context.Context, name string) error {
	b.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_box_snapshot_restore(b.handle, cName, C.cbSnapshotRestore(), handleToPtr(h), &cerr)
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

// ─── Conversions ──────────────────────────────────────────────────────────

func cSnapshotInfoToGo(info *C.CSnapshotInfo) SnapshotInfo {
	if info == nil {
		return SnapshotInfo{}
	}
	return SnapshotInfo{
		ID:                 C.GoString(info.id),
		BoxID:              C.GoString(info.box_id),
		Name:               C.GoString(info.name),
		CreatedAt:          int64(info.created_at),
		ContainerDiskBytes: uint64(info.container_disk_bytes),
		SizeBytes:          uint64(info.size_bytes),
	}
}

func convertSnapshotInfoList(list *C.CSnapshotInfoList) []SnapshotInfo {
	if list == nil || list.count == 0 {
		return nil
	}
	items := unsafe.Slice(list.items, int(list.count))
	out := make([]SnapshotInfo, 0, len(items))
	for i := range items {
		out = append(out, cSnapshotInfoToGo(&items[i]))
	}
	return out
}

// ─── Cgo callback exports ─────────────────────────────────────────────────

//export goBoxliteOnSnapshotCreate
func goBoxliteOnSnapshotCreate(info *C.CSnapshotInfo, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	if !claimOrFreePayload(h, &info, func(i **C.CSnapshotInfo) {
		if i != nil && *i != nil {
			C.boxlite_free_snapshot_info(*i)
		}
	}) {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan snapshotCreateResult)
	if !ok {
		return
	}
	if err := errorFromCError(errPtr); err != nil {
		ch <- snapshotCreateResult{err: err}
		return
	}
	if info == nil {
		ch <- snapshotCreateResult{}
		return
	}
	v := cSnapshotInfoToGo(info)
	C.boxlite_free_snapshot_info(info)
	ch <- snapshotCreateResult{value: &v}
}

//export goBoxliteOnSnapshotList
func goBoxliteOnSnapshotList(list *C.CSnapshotInfoList, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	if !claimOrFreePayload(h, &list, func(l **C.CSnapshotInfoList) {
		if l != nil && *l != nil {
			C.boxlite_free_snapshot_info_list(*l)
		}
	}) {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan snapshotListResult)
	if !ok {
		return
	}
	if err := errorFromCError(errPtr); err != nil {
		ch <- snapshotListResult{err: err}
		return
	}
	out := convertSnapshotInfoList(list)
	if list != nil {
		C.boxlite_free_snapshot_info_list(list)
	}
	ch <- snapshotListResult{value: out}
}

//export goBoxliteOnSnapshotRemove
func goBoxliteOnSnapshotRemove(errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	if !claimHandleForDispatch(h) {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan error)
	if !ok {
		return
	}
	ch <- errorFromCError(errPtr)
}

//export goBoxliteOnSnapshotRestore
func goBoxliteOnSnapshotRestore(errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	if !claimHandleForDispatch(h) {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan error)
	if !ok {
		return
	}
	ch <- errorFromCError(errPtr)
}

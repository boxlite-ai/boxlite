package boxlite

/*
#include "bridge.h"
*/
import "C"
import (
	"context"
	"runtime/cgo"
	"time"
	"unsafe"
)

// State represents the lifecycle state of a box.
type State string

const (
	StateConfigured State = "configured"
	StateRunning    State = "running"
	StateStopping   State = "stopping"
	StateStopped    State = "stopped"
)

// BoxInfo holds information about a box.
type BoxInfo struct {
	ID        string
	Name      string
	Image     string
	State     State
	Running   bool
	PID       int
	CPUs      int
	MemoryMiB int
	CreatedAt time.Time
}

// Info returns information about the box.
//
// boxlite_box_info is synchronous on the C side (it reads cached fields on
// the handle), so no drain participation is required.
func (b *Box) Info(_ context.Context) (*BoxInfo, error) {
	var cInfo *C.CBoxInfo
	var cerr C.CBoxliteError
	code := C.boxlite_box_info(b.handle, &cInfo, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_free_box_info(cInfo)

	info := cBoxInfoToGo(cInfo)
	if info.Name != "" && b.name == "" {
		b.name = info.Name
	}
	return &info, nil
}

// ListInfo lists all boxes.
func (r *Runtime) ListInfo(ctx context.Context) ([]BoxInfo, error) {
	r.ensureDrainRunning()

	ch := make(chan infoListResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_list_info(r.handle, C.cbInfoList(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, r.closing)
		return nil, ctx.Err()
	case <-r.closing:
		drainAndDelete(ch, h, r.closing)
		return nil, ErrRuntimeClosed
	}
}

// GetInfo retrieves info for a box by ID or name without attaching a handle.
func (r *Runtime) GetInfo(ctx context.Context, idOrName string) (*BoxInfo, error) {
	r.ensureDrainRunning()

	cID := toCString(idOrName)
	defer C.free(unsafe.Pointer(cID))

	ch := make(chan infoResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_get_info(r.handle, cID, C.cbInfo(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, r.closing)
		return nil, ctx.Err()
	case <-r.closing:
		drainAndDelete(ch, h, r.closing)
		return nil, ErrRuntimeClosed
	}
}

func cBoxInfoToGo(info *C.CBoxInfo) BoxInfo {
	pid := int(info.pid)
	return BoxInfo{
		ID:        cString(info.id),
		Name:      cString(info.name),
		Image:     cString(info.image),
		State:     State(cString(info.status)),
		Running:   info.running != 0,
		PID:       pid,
		CPUs:      int(info.cpus),
		MemoryMiB: int(info.memory_mib),
		CreatedAt: time.Unix(int64(info.created_at), 0),
	}
}

// convertBoxInfoList materialises a CBoxInfoList* into Go BoxInfo slice.
// The caller is responsible for freeing the C list afterwards.
func convertBoxInfoList(list *C.CBoxInfoList) []BoxInfo {
	if list == nil || list.count == 0 || list.items == nil {
		return nil
	}
	items := unsafe.Slice(list.items, int(list.count))
	out := make([]BoxInfo, len(items))
	for i := range items {
		out[i] = cBoxInfoToGo(&items[i])
	}
	return out
}

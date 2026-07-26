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
type BoxAdvancedInfo struct {
	Capabilities ContainerCapabilities
}

type BoxInfo struct {
	ID         string
	Name       string
	Image      string
	State      State
	Running    bool
	PID        int
	CPUs       int
	MemoryMiB  int
	AutoPause  uint32
	AutoDelete uint32
	AutoResume bool
	Advanced   BoxAdvancedInfo
	CreatedAt  time.Time
}

// Info returns information about the box.
//
// boxlite_box_info is synchronous on the C side (it reads cached fields on
// the handle), so no drain participation is required.
func (b *Box) Info(_ context.Context) (*BoxInfo, error) {
	var cInfo *C.CBoxInfoV2
	var cerr C.CBoxliteError
	code := C.boxlite_box_info_v2(b.handle, &cInfo, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_free_box_info_v2(cInfo)

	info := cBoxInfoV2ToGo(cInfo)
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
	code := C.boxlite_list_info_v2(r.handle, C.cbInfoListV2(), handleToPtr(h), &cerr)
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
	code := C.boxlite_get_info_v2(r.handle, cID, C.cbInfoV2(), handleToPtr(h), &cerr)
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

func cBoxInfoV2ToGo(info *C.CBoxInfoV2) BoxInfo {
	base := &info.base
	pid := int(base.pid)
	return BoxInfo{
		ID:         cString(base.id),
		Name:       cString(base.name),
		Image:      cString(base.image),
		State:      State(cString(base.status)),
		Running:    base.running != 0,
		PID:        pid,
		CPUs:       int(base.cpus),
		MemoryMiB:  int(base.memory_mib),
		AutoPause:  uint32(base.auto_pause),
		AutoDelete: uint32(base.auto_delete),
		AutoResume: base.auto_resume != 0,
		Advanced: BoxAdvancedInfo{
			Capabilities: ContainerCapabilities{
				Add: cStringList(
					info.advanced.capabilities.add,
					int(info.advanced.capabilities.add_count),
				),
				Drop: cStringList(
					info.advanced.capabilities.drop,
					int(info.advanced.capabilities.drop_count),
				),
			},
		},
		CreatedAt: time.Unix(int64(base.created_at), 0),
	}
}

func cStringList(values **C.char, count int) []string {
	if values == nil || count == 0 {
		return nil
	}
	cValues := unsafe.Slice(values, count)
	result := make([]string, len(cValues))
	for index, value := range cValues {
		result[index] = cString(value)
	}
	return result
}

// convertBoxInfoListV2 materialises a CBoxInfoListV2* into Go BoxInfo slice.
// The caller is responsible for freeing the C list afterwards.
func convertBoxInfoListV2(list *C.CBoxInfoListV2) []BoxInfo {
	if list == nil || list.count == 0 || list.items == nil {
		return nil
	}
	items := unsafe.Slice(list.items, int(list.count))
	out := make([]BoxInfo, len(items))
	for i := range items {
		out[i] = cBoxInfoV2ToGo(&items[i])
	}
	return out
}

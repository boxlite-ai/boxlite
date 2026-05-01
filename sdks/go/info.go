package boxlite

/*
#include "boxlite.h"
*/
import "C"
import (
	"context"
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
func (r *Runtime) ListInfo(_ context.Context) ([]BoxInfo, error) {
	var cList *C.CBoxInfoList
	var cerr C.CBoxliteError
	code := C.boxlite_list_info(r.handle, &cList, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_free_box_info_list(cList)

	items := unsafe.Slice(cList.items, int(cList.count))
	result := make([]BoxInfo, len(items))
	for i := range items {
		result[i] = cBoxInfoToGo(&items[i])
	}
	return result, nil
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

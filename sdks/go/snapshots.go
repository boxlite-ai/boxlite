package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"runtime/cgo"
	"unsafe"
)

// SnapshotInfo excludes RAM, runtime boot disks and external volumes.
type SnapshotInfo struct {
	ID                 string `json:"id"`
	BoxID              string `json:"box_id"`
	Name               string `json:"name"`
	CreatedAt          int64  `json:"created_at"`
	SnapshotType       string `json:"snapshot_type"`
	IsMock             bool   `json:"is_mock"`
	ContainerDiskBytes uint64 `json:"container_disk_bytes"`
	SizeBytes          uint64 `json:"size_bytes"`
}

type SnapshotHandle struct{ box *Box }

func (b *Box) Snapshots() *SnapshotHandle { return &SnapshotHandle{box: b} }

func (s *SnapshotHandle) Create(ctx context.Context, name, snapshotType string) (*SnapshotInfo, error) {
	if snapshotType == "" {
		snapshotType = "filesystem"
	}
	var info SnapshotInfo
	err := s.request(ctx, "create", name, snapshotType, &info)
	return &info, err
}

func (s *SnapshotHandle) Get(ctx context.Context, name string) (*SnapshotInfo, error) {
	var info SnapshotInfo
	err := s.request(ctx, "get", name, "filesystem", &info)
	return &info, err
}

func (s *SnapshotHandle) List(ctx context.Context) ([]SnapshotInfo, error) {
	var infos []SnapshotInfo
	err := s.request(ctx, "list", "", "filesystem", &infos)
	return infos, err
}

func (s *SnapshotHandle) Remove(ctx context.Context, name string) error {
	return s.request(ctx, "remove", name, "filesystem", nil)
}

func (s *SnapshotHandle) Restore(ctx context.Context, name string) error {
	return s.request(ctx, "restore", name, "filesystem", nil)
}

func (s *SnapshotHandle) request(ctx context.Context, operation, name, snapshotType string, output any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	body, err := json.Marshal(map[string]string{"operation": operation, "name": name, "snapshot_type": snapshotType})
	if err != nil {
		return err
	}
	request := C.CString(string(body))
	defer C.free(unsafe.Pointer(request))
	s.box.runtime.ensureDrainRunning()
	result := make(chan handleResult[*C.char], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))
	var ffiError C.CBoxliteError
	code := C.boxlite_box_snapshot(s.box.handle, request, C.cbSnapshot(), handleToPtr(handle), &ffiError)
	if code != C.Ok {
		deleteHandleForDispatch(handle)
		return freeError(&ffiError)
	}
	dispose := func(value *C.char) {
		if value != nil {
			freeBoxliteString(value)
		}
	}
	select {
	case completed := <-result:
		defer dispose(completed.value)
		if completed.err != nil {
			return completed.err
		}
		if output == nil {
			return nil
		}
		return json.Unmarshal([]byte(cString(completed.value)), output)
	case <-ctx.Done():
		abandonOwnedResult(result, handle, dispose)
		return ctx.Err()
	case <-s.box.runtime.closing:
		abandonOwnedResult(result, handle, dispose)
		return ErrRuntimeClosed
	}
}

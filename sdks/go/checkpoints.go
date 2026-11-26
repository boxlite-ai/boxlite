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

// CheckpointKind specifies the contents of a managed checkpoint.
type CheckpointKind string

const (
	CheckpointKindDisk CheckpointKind = "disk"
	CheckpointKindFull CheckpointKind = "full"
	// CheckpointKindUnknown represents a server-reported kind the SDK does not recognize.
	CheckpointKindUnknown CheckpointKind = "unknown"
)

// CheckpointOptions selects the archive kind. An empty Kind selects disk.
type CheckpointOptions struct{ Kind CheckpointKind }

// CheckpointInfo describes an independent managed checkpoint archive.
type CheckpointInfo struct {
	ID          string
	Name        string
	SourceBoxID string
	CreatedAt   string
	SizeBytes   uint64
	State       string
	ErrorReason string
	Kind        CheckpointKind
	// MemorySizeBytes is nil when the server does not report a memory size.
	MemorySizeBytes *uint64
}

// Checkpoints manages organization-scoped checkpoints through REST. Its lifetime
// follows the parent Runtime; it allocates no separate native handle.
type Checkpoints struct{ runtime *Runtime }

func (r *Runtime) Checkpoints() *Checkpoints { return &Checkpoints{runtime: r} }

func (c *Checkpoints) ready(ctx context.Context) (*Runtime, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if c == nil || c.runtime == nil || c.runtime.handle == nil {
		return nil, ErrRuntimeClosed
	}
	select {
	case <-c.runtime.closing:
		return nil, ErrRuntimeClosed
	default:
	}
	c.runtime.ensureDrainRunning()
	return c.runtime, nil
}

// Create captures a disk checkpoint of a stopped box. An empty name lets the backend choose a name.
// Cloud capture can initially report creating; query until ready before use.
func (c *Checkpoints) Create(ctx context.Context, source, name string) (*CheckpointInfo, error) {
	return c.CreateWithOptions(ctx, source, name, CheckpointOptions{})
}

// CreateWithOptions captures a disk checkpoint of a stopped box or a full
// checkpoint of a running box on a REST server that supports full capture.
// An empty name lets the backend choose a name.
func (c *Checkpoints) CreateWithOptions(ctx context.Context, source, name string, opts CheckpointOptions) (*CheckpointInfo, error) {
	if err := validateArchiveArgument(source, "checkpoint source", false); err != nil {
		return nil, err
	}
	if err := validateArchiveArgument(name, "checkpoint name", true); err != nil {
		return nil, err
	}
	switch opts.Kind {
	case "", CheckpointKindDisk, CheckpointKindFull:
	default:
		return nil, &Error{Code: ErrInvalidArgument, Message: "checkpoint kind must be disk or full"}
	}
	runtime, err := c.ready(ctx)
	if err != nil {
		return nil, err
	}
	cSource := toCString(source)
	defer C.free(unsafe.Pointer(cSource))
	cName, freeName := archiveNameCString(name)
	defer freeName()
	var cKind *C.char
	if opts.Kind != "" {
		cKind = toCString(string(opts.Kind))
		defer C.free(unsafe.Pointer(cKind))
	}
	result := make(chan handleResult[*C.CCheckpointInfo], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))
	var nativeError C.CBoxliteError
	code := C.boxlite_checkpoint_create_with_options(runtime.handle, cSource, cName, cKind, C.cbCheckpointInfo(), handleToPtr(handle), &nativeError)
	if code != C.Ok {
		deleteHandleForDispatch(handle)
		return nil, freeError(&nativeError)
	}
	return checkpointInfoResult(ctx, runtime, result, handle)
}

func (c *Checkpoints) Get(ctx context.Context, key string) (*CheckpointInfo, error) {
	if err := validateArchiveArgument(key, "checkpoint key", false); err != nil {
		return nil, err
	}
	runtime, err := c.ready(ctx)
	if err != nil {
		return nil, err
	}
	cKey := toCString(key)
	defer C.free(unsafe.Pointer(cKey))
	result := make(chan handleResult[*C.CCheckpointInfo], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))
	var nativeError C.CBoxliteError
	code := C.boxlite_checkpoint_get(runtime.handle, cKey, C.cbCheckpointInfo(), handleToPtr(handle), &nativeError)
	if code != C.Ok {
		deleteHandleForDispatch(handle)
		return nil, freeError(&nativeError)
	}
	return checkpointInfoResult(ctx, runtime, result, handle)
}

func (c *Checkpoints) List(ctx context.Context) ([]CheckpointInfo, error) {
	runtime, err := c.ready(ctx)
	if err != nil {
		return nil, err
	}
	result := make(chan handleResult[*C.CCheckpointList], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))
	var nativeError C.CBoxliteError
	code := C.boxlite_checkpoint_list(runtime.handle, C.cbCheckpointList(), handleToPtr(handle), &nativeError)
	if code != C.Ok {
		deleteHandleForDispatch(handle)
		return nil, freeError(&nativeError)
	}
	list, err := waitCheckpointResult(ctx, runtime, result, handle, func(value *C.CCheckpointList) { C.boxlite_free_checkpoint_list(value) })
	if err != nil {
		return nil, err
	}
	defer C.boxlite_free_checkpoint_list(list)
	if list == nil {
		return nil, &Error{Code: ErrInternal, Message: "checkpoint list callback returned no result"}
	}
	infos := make([]CheckpointInfo, int(list.count))
	for i, info := range unsafe.Slice(list.items, int(list.count)) {
		infos[i] = checkpointInfoFromC(&info)
	}
	return infos, nil
}

// Remove never removes boxes previously created from the checkpoint. Force
// ignores absence only and does not bypass an unfinished use operation.
func (c *Checkpoints) Remove(ctx context.Context, key string, force bool) error {
	if err := validateArchiveArgument(key, "checkpoint key", false); err != nil {
		return err
	}
	runtime, err := c.ready(ctx)
	if err != nil {
		return err
	}
	cKey := toCString(key)
	defer C.free(unsafe.Pointer(cKey))
	result := make(chan error, 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))
	var nativeError C.CBoxliteError
	forceFlag := C.int(0)
	if force {
		forceFlag = 1
	}
	code := C.boxlite_checkpoint_remove(runtime.handle, cKey, forceFlag, C.cbRemoveBox(), handleToPtr(handle), &nativeError)
	if code != C.Ok {
		deleteHandleForDispatch(handle)
		return freeError(&nativeError)
	}
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		abandonAsyncErr(result, handle, runtime.closing)
		return ctx.Err()
	case <-runtime.closing:
		abandonAsyncErr(result, handle, runtime.closing)
		return ErrRuntimeClosed
	}
}

func checkpointInfoFromC(info *C.CCheckpointInfo) CheckpointInfo {
	checkpoint := CheckpointInfo{
		ID:          cString(info.id),
		Name:        cString(info.name),
		SourceBoxID: cString(info.source_box_id),
		CreatedAt:   cString(info.created_at),
		SizeBytes:   uint64(info.size_bytes),
		State:       cString(info.state),
		ErrorReason: cString(info.error_reason),
		Kind:        CheckpointKind(cString(info.kind)),
	}
	if info.has_memory_size_bytes != 0 {
		size := uint64(info.memory_size_bytes)
		checkpoint.MemorySizeBytes = &size
	}
	return checkpoint
}

func checkpointInfoResult(ctx context.Context, runtime *Runtime, result <-chan handleResult[*C.CCheckpointInfo], handle cgo.Handle) (*CheckpointInfo, error) {
	native, err := waitCheckpointResult(ctx, runtime, result, handle, func(value *C.CCheckpointInfo) { C.boxlite_free_checkpoint_info(value) })
	if err != nil {
		return nil, err
	}
	defer C.boxlite_free_checkpoint_info(native)
	if native == nil {
		return nil, &Error{Code: ErrInternal, Message: "checkpoint metadata callback returned no result"}
	}
	info := checkpointInfoFromC(native)
	return &info, nil
}

// Cancellation abandons only the result; accepted native work owns its own
// staging and target reservation until it actually finishes.
func waitCheckpointResult[T any](ctx context.Context, runtime *Runtime, result <-chan handleResult[T], handle cgo.Handle, dispose func(T)) (T, error) {
	var zero T
	select {
	case completed := <-result:
		if completed.err != nil {
			dispose(completed.value)
			return zero, completed.err
		}
		return completed.value, nil
	case <-ctx.Done():
		abandonOwnedResult(result, handle, dispose)
		return zero, ctx.Err()
	case <-runtime.closing:
		abandonOwnedResult(result, handle, dispose)
		return zero, ErrRuntimeClosed
	}
}

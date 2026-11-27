package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"encoding/json"
	"fmt"
	"runtime/cgo"
	"strings"
	"unicode/utf8"
	"unsafe"
)

// MountRequest delivers Source from the runtime host at Target in the box.
type MountRequest struct {
	Source   string
	Target   string
	ReadOnly bool
}

// MountState reports the progress of a runtime mount.
type MountState string

const (
	// MountConfigured is saved for delivery when the box next starts.
	MountConfigured MountState = "configured"
	MountPreparing  MountState = "preparing"
	MountMounted    MountState = "mounted"
	MountDetaching  MountState = "detaching"
)

// MountInfo describes one directory mount of a box.
type MountInfo struct {
	Source   string     `json:"source"`
	Target   string     `json:"target"`
	ReadOnly bool       `json:"read_only"`
	State    MountState `json:"state"`
}

// Mount controls runtime directory mounts of one box. It refers to its Box,
// so it stays usable until the box is closed and has no Close of its own.
type Mount struct{ box *Box }

// Mount returns the mount namespace without starting the box.
func (b *Box) Mount() *Mount { return &Mount{box: b} }

// Add delivers a directory and reports the mount for that request, confirmed
// as MountMounted by a running box. A stopped box is never started: it saves
// the mount and reports MountConfigured.
func (m *Mount) Add(ctx context.Context, request MountRequest) (MountInfo, error) {
	if err := validateMountPath(request.Source); err != nil {
		return MountInfo{}, err
	}
	if err := validateMountPath(request.Target); err != nil {
		return MountInfo{}, err
	}
	return callMounts[MountInfo](ctx, m.box, func(box *C.CBoxHandle, data unsafe.Pointer, cerr *C.CBoxliteError) C.enum_BoxliteErrorCode {
		source := toCString(request.Source)
		defer C.free(unsafe.Pointer(source))
		target := toCString(request.Target)
		defer C.free(unsafe.Pointer(target))
		return C.boxlite_box_mount_add(box, source, target, C.bool(request.ReadOnly), C.cbMount(), data, cerr)
	})
}

// Remove lazily detaches a runtime mount, so existing references stay usable.
// On a stopped box it discards the saved mount instead. The box is never started.
func (m *Mount) Remove(ctx context.Context, target string) error {
	if err := validateMountPath(target); err != nil {
		return err
	}
	// The C side reports a completed removal as the JSON text null.
	_, err := callMounts[struct{}](ctx, m.box, func(box *C.CBoxHandle, data unsafe.Pointer, cerr *C.CBoxliteError) C.enum_BoxliteErrorCode {
		path := toCString(target)
		defer C.free(unsafe.Pointer(path))
		return C.boxlite_box_mount_remove(box, path, C.cbMount(), data, cerr)
	})
	return err
}

// List returns the mounts of the box without starting it. A mount saved for
// the next start has state MountConfigured.
func (m *Mount) List(ctx context.Context) ([]MountInfo, error) {
	return callMounts[[]MountInfo](ctx, m.box, func(box *C.CBoxHandle, data unsafe.Pointer, cerr *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_box_mount_list(box, C.cbMount(), data, cerr)
	})
}

// Get reports the mount at target, or nil when the target has no mount.
func (m *Mount) Get(ctx context.Context, target string) (*MountInfo, error) {
	if err := validateMountPath(target); err != nil {
		return nil, err
	}
	return callMounts[*MountInfo](ctx, m.box, func(box *C.CBoxHandle, data unsafe.Pointer, cerr *C.CBoxliteError) C.enum_BoxliteErrorCode {
		path := toCString(target)
		defer C.free(unsafe.Pointer(path))
		return C.boxlite_box_mount_get(box, path, C.cbMount(), data, cerr)
	})
}

// validateMountPath refuses a path that would not cross the C boundary
// unchanged: C.CString stops at a NUL byte, and Rust rejects invalid UTF-8.
func validateMountPath(path string) error {
	if !utf8.ValidString(path) || strings.IndexByte(path, 0) >= 0 {
		return &Error{Code: ErrInvalidArgument, Message: "mount path must be valid UTF-8 without NUL"}
	}
	return nil
}

func callMounts[T any](ctx context.Context, box *Box, submit func(*C.CBoxHandle, unsafe.Pointer, *C.CBoxliteError) C.enum_BoxliteErrorCode) (T, error) {
	var result T
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if box == nil || box.runtime == nil {
		return result, errBoxClosed
	}
	select {
	case <-box.runtime.closing:
		return result, ErrRuntimeClosed
	default:
	}
	handle, unlock, err := box.acquire()
	if err != nil {
		return result, err
	}
	box.runtime.ensureDrainRunning()
	ch := make(chan handleResult[string], 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	// A late callback can only claim a handle that its caller still owns.
	defer deleteHandleForDispatch(h)
	var cerr C.CBoxliteError
	code := submit(handle, handleToPtr(h), &cerr)
	unlock()
	if code != C.Ok {
		return result, freeError(&cerr)
	}
	select {
	case response := <-ch:
		if response.err != nil {
			return result, response.err
		}
		if err := json.Unmarshal([]byte(response.value), &result); err != nil {
			return result, fmt.Errorf("decode mount result: %w", err)
		}
		return result, nil
	case <-ctx.Done():
		return result, ctx.Err()
	case <-box.runtime.closing:
		return result, ErrRuntimeClosed
	}
}

//export goBoxliteOnMount
func goBoxliteOnMount(payload *C.char, cerr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 || !claimHandleForDispatch(h) {
		return
	}
	defer h.Delete()
	// Borrowed C data is needed only while the caller is still waiting.
	ch := h.Value().(chan handleResult[string])
	ch <- handleResult[string]{value: cString(payload), err: borrowedAgentError(cerr)}
}

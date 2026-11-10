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
	"sync"
	"unsafe"
)

// CheckpointArchiveSource identifies the immutable archive downloaded from
// checkpoint storage, including its recorded SHA-256 and original OCI build.
type CheckpointArchiveSource struct {
	Path        string
	SHA256      string
	PinnedImage string
}

// PreparedCheckpointArchive owns a validated, private derived archive. Keep it
// open until native Import has finished; Close removes only its temporary files.
type PreparedCheckpointArchive struct {
	mu     sync.Mutex
	handle *C.CPreparedCheckpointArchive
}

func (a *PreparedCheckpointArchive) Path() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.handle == nil {
		return ""
	}
	return C.GoString(C.boxlite_prepared_checkpoint_archive_path(a.handle))
}

func (a *PreparedCheckpointArchive) SHA256() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.handle == nil {
		return ""
	}
	return C.GoString(C.boxlite_prepared_checkpoint_archive_sha256(a.handle))
}

func (a *PreparedCheckpointArchive) SizeBytes() uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.handle == nil {
		return 0
	}
	return uint64(C.boxlite_prepared_checkpoint_archive_size_bytes(a.handle))
}

func (a *PreparedCheckpointArchive) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.handle != nil {
		C.boxlite_prepared_checkpoint_archive_free(a.handle)
		a.handle = nil
	}
	return nil
}

// PrepareCheckpointArchive validates archive bytes, disk/configuration and the
// pinned OCI startup image before a caller removes a recovery target. Optional
// platformEnv replaces only reserved BoxLite identity keys; user settings are
// inherited. It requires a local runtime and neither creates nor removes a box.
// The caller retains the source file until preparation actually finishes.
func (r *Runtime) PrepareCheckpointArchive(ctx context.Context, source CheckpointArchiveSource, platformEnv map[string]string) (*PreparedCheckpointArchive, error) {
	for _, argument := range []struct{ value, name string }{{source.Path, "archive path"}, {source.SHA256, "archive SHA-256"}, {source.PinnedImage, "pinned image"}} {
		if err := validateArchiveArgument(argument.value, argument.name, false); err != nil {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if r == nil || r.handle == nil {
		return nil, ErrRuntimeClosed
	}
	select {
	case <-r.closing:
		return nil, ErrRuntimeClosed
	default:
	}
	cPath, cSHA, cImage := toCString(source.Path), toCString(source.SHA256), toCString(source.PinnedImage)
	defer C.free(unsafe.Pointer(cPath))
	defer C.free(unsafe.Pointer(cSHA))
	defer C.free(unsafe.Pointer(cImage))
	var cEnv *C.char
	if platformEnv != nil {
		encoded, err := json.Marshal(platformEnv)
		if err != nil {
			return nil, err
		}
		cEnv = toCString(string(encoded))
		defer C.free(unsafe.Pointer(cEnv))
	}
	r.ensureDrainRunning()
	result := make(chan handleResult[*C.CPreparedCheckpointArchive], 1)
	handle := registerHandleForDispatch(cgo.NewHandle(result))
	if err := ctx.Err(); err != nil {
		deleteHandleForDispatch(handle)
		return nil, err
	}
	var cError C.CBoxliteError
	code := C.boxlite_runtime_prepare_checkpoint_archive(r.handle, cPath, cSHA, cImage, cEnv, C.cbCheckpointArchive(), handleToPtr(handle), &cError)
	if code != C.Ok {
		deleteHandleForDispatch(handle)
		return nil, freeError(&cError)
	}
	dispose := func(handle *C.CPreparedCheckpointArchive) {
		if handle != nil {
			C.boxlite_prepared_checkpoint_archive_free(handle)
		}
	}
	select {
	case completed := <-result:
		if completed.err != nil {
			dispose(completed.value)
			return nil, completed.err
		}
		return &PreparedCheckpointArchive{handle: completed.value}, nil
	case <-ctx.Done():
		abandonOwnedResult(result, handle, dispose)
		return nil, ctx.Err()
	case <-r.closing:
		abandonOwnedResult(result, handle, dispose)
		return nil, ErrRuntimeClosed
	}
}

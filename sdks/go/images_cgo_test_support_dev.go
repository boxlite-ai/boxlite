//go:build boxlite_dev

package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"time"
	"unsafe"
)

// Go does not support importing C from a _test.go file, so these drive the
// native image calls for images_cgo_dev_test.go. Development builds only.

// lateImageGet runs a Get whose completion reaches the callback after
// Runtime.Close claimed the call, and reports whether the callback delivered
// a result anyway. See lateImageCompletion.
func lateImageGet(images *Images, name string) (bool, error) {
	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))
	return lateImageCompletion[imageDetailResult](images, func(userData unsafe.Pointer, cerr *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_image_get(images.handle, cName, C.cbImageGet(), userData, cerr)
	})
}

// lateImageRemove is lateImageGet for Remove.
func lateImageRemove(images *Images, name string) (bool, error) {
	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))
	return lateImageCompletion[error](images, func(userData unsafe.Pointer, cerr *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_image_remove(images.handle, cName, C.cbImageRemove(), userData, cerr)
	})
}

// lateImageUsage is lateImageGet for Usage.
func lateImageUsage(images *Images) (bool, error) {
	return lateImageCompletion[imageUsageResult](images, func(userData unsafe.Pointer, cerr *C.CBoxliteError) C.enum_BoxliteErrorCode {
		return C.boxlite_image_usage(images.handle, C.cbImageUsage(), userData, cerr)
	})
}

// lateImageCompletion submits a call through the production callback with a
// dispatch handle already claimed, as drainAndDelete's closing branch claims
// it when Runtime.Close fires, then drains the runtime on this goroutine until
// the native side dispatches the completion. That is the order Close loses to
// a completion already queued: the callback must deliver nothing, leave the
// handle to its claimer, and free whatever the native side handed it.
//
// T must be the result type the callback sends, or a callback that ignored the
// claim would fail its type check and look correct. The runtime's own drain
// goroutine must not be running, or it could dispatch the completion instead.
func lateImageCompletion[T any](images *Images, submit func(unsafe.Pointer, *C.CBoxliteError) C.enum_BoxliteErrorCode) (bool, error) {
	results := make(chan T, 1)
	h := registerHandleForDispatch(cgo.NewHandle(results))
	claimHandleForDispatch(h)

	var cerr C.CBoxliteError
	if code := submit(handleToPtr(h), &cerr); code != C.Ok {
		h.Delete()
		return false, freeError(&cerr)
	}
	if err := drainOneCompletion(images.runtime); err != nil {
		h.Delete()
		return false, err
	}
	if len(results) > 0 {
		// The callback acted on a handle it did not hold, and deleted it.
		return true, nil
	}
	h.Delete()
	return false, nil
}

// drainOneCompletion dispatches queued completions on the calling goroutine
// until at least one has run.
func drainOneCompletion(rt *Runtime) error {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var cerr C.CBoxliteError
		dispatched := C.boxlite_runtime_drain(rt.handle, C.int(drainTimeoutMs), &cerr)
		if dispatched < 0 {
			return freeError(&cerr)
		}
		if dispatched > 0 {
			return nil
		}
	}
	return errors.New("no completion was dispatched within 10s")
}

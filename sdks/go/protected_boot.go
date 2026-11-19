//go:build unix

package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"unsafe"
)

// ProtectedBootOperation belongs to the trusted local Runner protocol.
type ProtectedBootOperation uint8

const (
	ProtectedBootStart ProtectedBootOperation = iota
	ProtectedBootRead
	ProtectedBootRetire
	protectedBootCheck
)

// RunnerProtectedBoot invokes the local bootstrap ABI. Transport authority and
// the deployment resolver pin are checked by the Runner before calling it.
func (b *Box) RunnerProtectedBoot(ctx context.Context, operation ProtectedBootOperation, request any) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	handle, unlock, err := b.acquire()
	if err != nil {
		return nil, err
	}
	defer unlock()
	var input *C.char
	if request != nil {
		data, err := json.Marshal(request)
		if err != nil {
			return nil, err
		}
		data = append(data, 0)
		input = (*C.char)(C.CBytes(data))
		clear(data)
		defer C.free(unsafe.Pointer(input))
	}
	var output *C.char
	var failure C.CBoxliteError
	if C.boxlite_runner_protected_boot(handle, C.uint8_t(operation), input, &output, &failure) != C.Ok {
		return nil, freeError(&failure)
	}
	defer C.boxlite_free_string(output)
	if output == nil {
		return nil, &Error{Code: ErrInvalidState, Message: "protected boot response is missing"}
	}
	return json.RawMessage(C.GoString(output)), nil
}

// HasRunnerProtection guards legacy destructive operations without booting a Guest.
func (b *Box) HasRunnerProtection(ctx context.Context) (bool, error) {
	result, err := b.RunnerProtectedBoot(ctx, protectedBootCheck, nil)
	if err != nil {
		return false, err
	}
	var protected bool
	err = json.Unmarshal(result, &protected)
	return protected, err
}

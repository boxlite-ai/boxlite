package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"runtime/cgo"
	"strings"
	"unsafe"
)

// ExecutionInfo describes a live guest execution, including the main process.
// ExecutionID is the canonical guest ID accepted by Executions.Get.
type ExecutionInfo struct {
	ExecutionID string   `json:"execution_id"`
	Argv        []string `json:"argv"`
	// StartedAt is the start time in Unix milliseconds.
	StartedAt     uint64 `json:"started_at"`
	TTY           bool   `json:"tty"`
	IsMainSession bool   `json:"is_main_session"`
}

type executionInfoListResult struct {
	value []ExecutionInfo
	err   error
}

// Executions namespaces the live execution sessions of one box. It refers to
// its Box, so it stays usable until the box is closed and has no Close of its
// own. Listing and recovery never start or restart the box; attaching output
// still fails on a box that is not running.
type Executions struct {
	box *Box
}

// Executions returns the live execution namespace without starting the box.
func (b *Box) Executions() *Executions { return &Executions{box: b} }

// List queries live guest state without starting a stopped box.
func (e *Executions) List(ctx context.Context) ([]ExecutionInfo, error) {
	b := e.box
	if b == nil || b.handle == nil {
		return nil, &Error{Code: ErrInvalidState, Message: "box is closed"}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	b.runtime.ensureDrainRunning()
	ch := make(chan executionInfoListResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	if code := C.boxlite_box_executions_list(b.handle, C.cbExecutionInfoList(), handleToPtr(h), &cerr); code != C.Ok {
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

// Get recovers a control-only handle for a live execution in this box.
// It does not claim stdout/stderr or stdin. Wait, Signal, Kill, and ResizeTTY
// remain available while another handle consumes output. Close only releases
// the recovered handle and does not terminate the process.
func (e *Executions) Get(ctx context.Context, executionID string) (*Execution, error) {
	return e.box.recoverExecution(ctx, executionID, nil, false)
}

// Attach opens live stdin/output streams for an existing execution.
// It never starts a stopped box and fails if another output reader is active.
// Only the Stdout/Stderr/OnStdout/OnStderr fields of opts configure attachment;
// process launch options do not apply to an already-running execution.
// Closing this handle releases its reader without killing the process.
func (e *Executions) Attach(ctx context.Context, executionID string, opts *ExecutionOptions) (*Execution, error) {
	return e.box.recoverExecution(ctx, executionID, opts, true)
}

func (b *Box) recoverExecution(ctx context.Context, executionID string, opts *ExecutionOptions, attach bool) (*Execution, error) {
	if strings.IndexByte(executionID, 0) >= 0 || executionID == "" {
		return nil, &Error{Code: ErrInvalidArgument, Message: "execution ID must be nonempty and NUL-free"}
	}
	if b == nil || b.handle == nil {
		return nil, &Error{Code: ErrInvalidState, Message: "box is closed"}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case <-b.runtime.closing:
		return nil, ErrRuntimeClosed
	default:
	}
	b.runtime.ensureDrainRunning()
	id := C.CString(executionID)
	defer C.free(unsafe.Pointer(id))
	var handle *C.CExecutionHandle
	var cerr C.CBoxliteError
	var code C.enum_BoxliteErrorCode
	if attach {
		code = C.boxlite_box_executions_attach(b.handle, id, &handle, &cerr)
	} else {
		code = C.boxlite_box_executions_get(b.handle, id, &handle, &cerr)
	}
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	if err := ctx.Err(); err != nil {
		C.boxlite_execution_free(handle)
		return nil, err
	}
	if attach {
		cfg := ExecutionOptions{}
		if opts != nil {
			cfg = *opts
		}
		return b.executionWithCallbacks(handle, cfg)
	}
	return &Execution{handle: handle, id: executionHandleID(handle), closing: b.runtime.closing}, nil
}

func executionHandleID(handle *C.CExecutionHandle) string {
	id := C.boxlite_execution_id(handle)
	if id == nil {
		return ""
	}
	defer C.boxlite_free_string(id)
	return C.GoString(id)
}

func convertExecutionInfoList(list *C.CExecutionInfoList) []ExecutionInfo {
	if list == nil || list.count <= 0 || list.items == nil {
		return []ExecutionInfo{}
	}
	items := unsafe.Slice(list.items, int(list.count))
	out := make([]ExecutionInfo, len(items))
	for i := range items {
		info := &items[i]
		argv := make([]string, 0, int(info.argc))
		if info.argv != nil && info.argc > 0 {
			for _, arg := range unsafe.Slice(info.argv, int(info.argc)) {
				argv = append(argv, cString(arg))
			}
		}
		out[i] = ExecutionInfo{
			ExecutionID:   cString(info.execution_id),
			Argv:          argv,
			StartedAt:     uint64(info.started_at),
			TTY:           bool(info.tty),
			IsMainSession: bool(info.is_main_session),
		}
	}
	return out
}

//export goBoxliteOnExecutionInfoList
func goBoxliteOnExecutionInfoList(list *C.CExecutionInfoList, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		C.boxlite_free_execution_info_list(list)
		return
	}
	if !claimOrFreePayload(h, &list, func(l **C.CExecutionInfoList) {
		if l != nil && *l != nil {
			C.boxlite_free_execution_info_list(*l)
		}
	}) {
		return
	}
	defer h.Delete()
	defer C.boxlite_free_execution_info_list(list)
	ch, ok := h.Value().(chan executionInfoListResult)
	if !ok {
		return
	}
	if err := errorFromCError(errPtr); err != nil {
		ch <- executionInfoListResult{err: err}
		return
	}
	ch <- executionInfoListResult{value: convertExecutionInfoList(list)}
}

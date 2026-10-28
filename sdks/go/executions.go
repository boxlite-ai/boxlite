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
// ExecutionID is the canonical guest ID accepted by GetExecution.
type ExecutionInfo struct {
	ExecutionID string   `json:"execution_id"`
	Argv        []string `json:"argv"`
	PID         uint32   `json:"pid"`
	// StartedAt is the start time in Unix milliseconds.
	StartedAt uint64 `json:"started_at"`
	TTY       bool   `json:"tty"`
	IsMain    bool   `json:"is_main"`
}

type executionInfoListResult struct {
	value []ExecutionInfo
	err   error
}

// ListExecutions queries live guest state without starting a stopped box.
func (b *Box) ListExecutions(ctx context.Context) ([]ExecutionInfo, error) {
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
	if code := C.boxlite_list_executions(b.handle, C.cbExecutionInfoList(), handleToPtr(h), &cerr); code != C.Ok {
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

// GetExecution recovers a control-only handle for a live execution in this box.
// It does not claim stdout/stderr or stdin. Wait, Signal, Kill, and ResizeTTY
// remain available while another handle consumes output. Close only releases
// the recovered handle and does not terminate the process.
func (b *Box) GetExecution(ctx context.Context, executionID string) (*Execution, error) {
	return b.recoverExecution(ctx, executionID, nil, false)
}

// AttachExecution opens live stdin/output streams for an existing execution.
// It never starts a stopped box and fails if another output reader is active.
// Only the Stdout/Stderr/OnStdout/OnStderr fields of opts configure attachment;
// process launch options do not apply to an already-running execution.
// Closing this handle releases its reader without killing the process.
func (b *Box) AttachExecution(ctx context.Context, executionID string, opts *ExecutionOptions) (*Execution, error) {
	return b.recoverExecution(ctx, executionID, opts, true)
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
		code = C.boxlite_box_attach_execution(b.handle, id, &handle, &cerr)
	} else {
		code = C.boxlite_box_get_execution(b.handle, id, &handle, &cerr)
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
			ExecutionID: cString(info.execution_id),
			Argv:        argv,
			PID:         uint32(info.pid),
			StartedAt:   uint64(info.started_at),
			TTY:         bool(info.tty),
			IsMain:      bool(info.is_main),
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

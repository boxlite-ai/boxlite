package boxlite

/*
#include "bridge.h"
*/
import "C"

import (
	"runtime/cgo"
	"unsafe"
)

// handleToPtr converts a cgo.Handle into the unsafe.Pointer expected by the
// C user_data slots. cgo.Handle is a uintptr under the hood; we read its
// representation as an unsafe.Pointer to keep go vet happy (uintptr ->
// unsafe.Pointer conversions are flagged because they typically indicate a
// pointer escape, but here we are simply transporting an opaque
// pointer-sized token through C).
func handleToPtr(h cgo.Handle) unsafe.Pointer {
	return *(*unsafe.Pointer)(unsafe.Pointer(&h))
}

// ptrToHandle reverses handleToPtr.
func ptrToHandle(p unsafe.Pointer) cgo.Handle {
	return *(*cgo.Handle)(unsafe.Pointer(&p))
}

// errorFromCError copies the typed error out of *CBoxliteError (releasing
// the C-allocated message) before returning. Returns nil on success codes.
func errorFromCError(cerr *C.CBoxliteError) error {
	if cerr == nil || cerr.code == C.Ok {
		return nil
	}
	return freeError(cerr)
}

// ─── Streaming callbacks ───────────────────────────────────────────────────

//export goBoxliteOnStdout
func goBoxliteOnStdout(data *C.uint8_t, length C.size_t, userData unsafe.Pointer) {
	dispatchStreamWrite(userData, data, length, false)
}

//export goBoxliteOnStderr
func goBoxliteOnStderr(data *C.uint8_t, length C.size_t, userData unsafe.Pointer) {
	dispatchStreamWrite(userData, data, length, true)
}

//export goBoxliteOnExit
func goBoxliteOnExit(exitCode C.int, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	// Do NOT Delete the handle here. Stream events (stdout/stderr) and the
	// exit event are pushed concurrently from independent Tokio pumps, so
	// drain order between them is not strictly defined: a final stderr
	// chunk can arrive after the exit event. Deleting on exit would make
	// such a chunk panic in cgo.Handle.Value(). The handle is intentionally
	// leaked for the lifetime of the runtime; the overhead per execution
	// is bounded (one small struct + one map entry).
	value := h.Value()
	if value == nil {
		return
	}
	if exec, ok := value.(*executionStreamState); ok {
		exec.deliverExit(int(exitCode))
	}
}

// ─── Box lifecycle callbacks ───────────────────────────────────────────────

//export goBoxliteOnCreateBox
func goBoxliteOnCreateBox(box *C.CBoxHandle, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	deliverHandleResult[*C.CBoxHandle](userData, box, errPtr)
}

//export goBoxliteOnGetBox
func goBoxliteOnGetBox(box *C.CBoxHandle, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	deliverHandleResult[*C.CBoxHandle](userData, box, errPtr)
}

//export goBoxliteOnStartBox
func goBoxliteOnStartBox(errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	deliverUnitResult(userData, errPtr)
}

//export goBoxliteOnStopBox
func goBoxliteOnStopBox(errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	deliverUnitResult(userData, errPtr)
}

//export goBoxliteOnRemoveBox
func goBoxliteOnRemoveBox(errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	deliverUnitResult(userData, errPtr)
}

//export goBoxliteOnCopy
func goBoxliteOnCopy(errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	deliverUnitResult(userData, errPtr)
}

// ─── Image callbacks ───────────────────────────────────────────────────────

//export goBoxliteOnImagePull
func goBoxliteOnImagePull(res *C.CImagePullResult, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan imagePullResult)
	if !ok {
		return
	}
	if err := errorFromCError(errPtr); err != nil {
		ch <- imagePullResult{err: err}
		return
	}
	out := &ImagePullResult{}
	if res != nil {
		out.Reference = cString(res.reference)
		out.ConfigDigest = cString(res.config_digest)
		out.LayerCount = int(res.layer_count)
		C.boxlite_free_image_pull_result(res)
	}
	ch <- imagePullResult{value: out}
}

//export goBoxliteOnImageList
func goBoxliteOnImageList(list *C.CImageInfoList, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan imageListResult)
	if !ok {
		return
	}
	if err := errorFromCError(errPtr); err != nil {
		ch <- imageListResult{err: err}
		return
	}
	images := convertImageInfoList(list)
	if list != nil {
		C.boxlite_free_image_info_list(list)
	}
	ch <- imageListResult{value: images}
}

// ─── Info callbacks ────────────────────────────────────────────────────────

//export goBoxliteOnInfo
func goBoxliteOnInfo(info *C.CBoxInfo, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan infoResult)
	if !ok {
		return
	}
	if err := errorFromCError(errPtr); err != nil {
		ch <- infoResult{err: err}
		return
	}
	if info == nil {
		ch <- infoResult{}
		return
	}
	v := cBoxInfoToGo(info)
	C.boxlite_free_box_info(info)
	ch <- infoResult{value: &v}
}

//export goBoxliteOnInfoList
func goBoxliteOnInfoList(list *C.CBoxInfoList, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan infoListResult)
	if !ok {
		return
	}
	if err := errorFromCError(errPtr); err != nil {
		ch <- infoListResult{err: err}
		return
	}
	out := convertBoxInfoList(list)
	if list != nil {
		C.boxlite_free_box_info_list(list)
	}
	ch <- infoListResult{value: out}
}

// ─── Metrics callbacks ─────────────────────────────────────────────────────

//export goBoxliteOnBoxMetrics
func goBoxliteOnBoxMetrics(m *C.CBoxMetrics, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan boxMetricsResult)
	if !ok {
		return
	}
	if err := errorFromCError(errPtr); err != nil {
		ch <- boxMetricsResult{err: err}
		return
	}
	if m == nil {
		ch <- boxMetricsResult{}
		return
	}
	v := cBoxMetricsToGo(m)
	ch <- boxMetricsResult{value: &v}
}

//export goBoxliteOnRuntimeMetrics
func goBoxliteOnRuntimeMetrics(m *C.CRuntimeMetrics, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan runtimeMetricsResult)
	if !ok {
		return
	}
	if err := errorFromCError(errPtr); err != nil {
		ch <- runtimeMetricsResult{err: err}
		return
	}
	if m == nil {
		ch <- runtimeMetricsResult{}
		return
	}
	v := cRuntimeMetricsToGo(m)
	ch <- runtimeMetricsResult{value: &v}
}

// ─── Runtime shutdown callback ─────────────────────────────────────────────

//export goBoxliteOnRuntimeShutdown
func goBoxliteOnRuntimeShutdown(errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	deliverUnitResult(userData, errPtr)
}

// ─── Execution lifecycle callbacks ─────────────────────────────────────────

//export goBoxliteOnExecutionWait
func goBoxliteOnExecutionWait(exitCode C.int, errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan executionWaitResult)
	if !ok {
		return
	}
	ch <- executionWaitResult{
		exitCode: int(exitCode),
		err:      errorFromCError(errPtr),
	}
}

//export goBoxliteOnExecutionKill
func goBoxliteOnExecutionKill(errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	deliverUnitResult(userData, errPtr)
}

//export goBoxliteOnExecutionResize
func goBoxliteOnExecutionResize(errPtr *C.CBoxliteError, userData unsafe.Pointer) {
	deliverUnitResult(userData, errPtr)
}

// ─── Generic delivery helpers ──────────────────────────────────────────────

// deliverUnitResult sends an error-only result to the channel referenced by
// userData. The cgo.Handle is freed exactly once here.
func deliverUnitResult(userData unsafe.Pointer, errPtr *C.CBoxliteError) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan error)
	if !ok {
		return
	}
	ch <- errorFromCError(errPtr)
}

// deliverHandleResult sends a (handle, error) pair. The handle pointer is
// owned by the receiver after delivery (the C side does not free it).
func deliverHandleResult[T any](userData unsafe.Pointer, value T, errPtr *C.CBoxliteError) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	defer h.Delete()
	ch, ok := h.Value().(chan handleResult[T])
	if !ok {
		return
	}
	ch <- handleResult[T]{value: value, err: errorFromCError(errPtr)}
}

// dispatchStreamWrite forwards a streaming chunk to the executionStreamState
// referenced by userData. The Handle is intentionally never Deleted by any
// stream callback (see goBoxliteOnExit for the rationale), so Value() is
// always safe to call here.
func dispatchStreamWrite(userData unsafe.Pointer, data *C.uint8_t, length C.size_t, isStderr bool) {
	h := ptrToHandle(userData)
	if h == 0 {
		return
	}
	value := h.Value()
	state, ok := value.(*executionStreamState)
	if !ok {
		return
	}
	if length == 0 || data == nil {
		return
	}
	bytes := C.GoBytes(unsafe.Pointer(data), C.int(length))
	if isStderr {
		state.deliverStderr(bytes)
	} else {
		state.deliverStdout(bytes)
	}
}

// ─── Result envelope types ─────────────────────────────────────────────────

type handleResult[T any] struct {
	value T
	err   error
}

type imagePullResult struct {
	value *ImagePullResult
	err   error
}

type imageListResult struct {
	value []ImageInfo
	err   error
}

type infoResult struct {
	value *BoxInfo
	err   error
}

type infoListResult struct {
	value []BoxInfo
	err   error
}

type boxMetricsResult struct {
	value *BoxMetrics
	err   error
}

type runtimeMetricsResult struct {
	value *RuntimeMetrics
	err   error
}

type executionWaitResult struct {
	exitCode int
	err      error
}

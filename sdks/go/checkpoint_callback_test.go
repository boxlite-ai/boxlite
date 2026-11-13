package boxlite

import (
	"context"
	"runtime/cgo"
	"testing"
	"unsafe"
)

// Infer the opaque C result type from the actual callback; Go tests cannot
// import C, and must not introduce a second ABI definition just for fixtures.
func checkpointCallbackChannel[T, E any](_ func(T, E, unsafe.Pointer)) chan handleResult[T] {
	return make(chan handleResult[T], 1)
}

func TestCheckpointCallbacksRefuseMissingStaleAndWrongReceivers(t *testing.T) {
	for _, callback := range []struct {
		name string
		call func(unsafe.Pointer)
	}{
		{"metadata", func(data unsafe.Pointer) { goBoxliteOnCheckpointInfo(nil, nil, data) }},
		{"list", func(data unsafe.Pointer) { goBoxliteOnCheckpointList(nil, nil, data) }},
	} {
		t.Run(callback.name, func(t *testing.T) {
			callback.call(nil)
			wrong := make(chan int, 1)
			handle := registerHandleForDispatch(cgo.NewHandle(wrong))
			callback.call(handleToPtr(handle))
			if len(wrong) != 0 || claimHandleForDispatch(handle) {
				t.Fatal("callback retained or delivered to an incompatible receiver")
			}
			stale := registerHandleForDispatch(cgo.NewHandle(wrong))
			deleteHandleForDispatch(stale)
			callback.call(handleToPtr(stale))
			if len(wrong) != 0 {
				t.Fatal("late callback delivered to an abandoned receiver")
			}
		})
	}
}

func TestCheckpointCallbackEmptySuccessIsRejectedByMetadataDecoder(t *testing.T) {
	runtime := &Runtime{closing: make(chan struct{})}
	metadata := checkpointCallbackChannel(goBoxliteOnCheckpointInfo)
	handle := registerHandleForDispatch(cgo.NewHandle(metadata))
	goBoxliteOnCheckpointInfo(nil, nil, handleToPtr(handle))
	info, err := checkpointInfoResult(context.Background(), runtime, metadata, handle)
	if info != nil || err == nil {
		t.Fatalf("empty native metadata was accepted: %#v %v", info, err)
	}
}

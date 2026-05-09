// Package boxlite provides an idiomatic Go SDK for the BoxLite runtime.
package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"runtime/cgo"
	"sync"
	"time"
	"unsafe"
)

// Version returns the BoxLite library version string.
func Version() string {
	return C.GoString(C.boxlite_version())
}

// drainTimeoutMs caps each blocking call to boxlite_runtime_drain so the
// drain goroutine wakes up periodically to check the stop signal even when
// no events are flowing.
const drainTimeoutMs = 100

// Runtime manages BoxLite boxes. Create one with NewRuntime.
type Runtime struct {
	handle *C.CBoxliteRuntime

	drainOnce sync.Once
	drainStop chan struct{}
	drainDone chan struct{}
}

// NewRuntime creates a new BoxLite runtime.
func NewRuntime(opts ...RuntimeOption) (*Runtime, error) {
	cfg := &runtimeConfig{}
	for _, o := range opts {
		o(cfg)
	}

	var homeDir *C.char
	if cfg.homeDir != "" {
		homeDir = toCString(cfg.homeDir)
		defer C.free(unsafe.Pointer(homeDir))
	}

	cImageRegistries, imageRegistriesCount, freeImageRegistries, err := toCImageRegistryArray(cfg.imageRegistries)
	if err != nil {
		return nil, err
	}
	defer freeImageRegistries()

	var handle *C.CBoxliteRuntime
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_new(
		homeDir,
		cImageRegistries,
		C.int(imageRegistriesCount),
		&handle,
		&cerr,
	)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Runtime{handle: handle}, nil
}

// Close releases the runtime. Implements io.Closer.
//
// Stops the drain goroutine and frees the underlying C runtime handle.
// boxlite_runtime_free wakes the drain thread if it is currently blocked
// inside the C drain call, so this returns promptly.
func (r *Runtime) Close() error {
	if r.handle == nil {
		return nil
	}

	r.stopDrain()
	C.boxlite_runtime_free(r.handle)
	r.handle = nil
	return nil
}

// Shutdown gracefully stops all boxes in this runtime.
func (r *Runtime) Shutdown(ctx context.Context, timeout time.Duration) error {
	r.ensureDrainRunning()

	secs := int(timeout.Seconds())
	if secs < 0 {
		secs = 0
	}

	ch := make(chan error, 1)
	h := cgo.NewHandle(ch)

	var cerr C.CBoxliteError
	code := C.boxlite_runtime_shutdown(r.handle, C.int(secs), C.cbRuntimeShutdown(), handleToPtr(h), &cerr)
	if code != C.Ok {
		h.Delete()
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h)
		return ctx.Err()
	}
}

// Create creates and returns a new box.
func (r *Runtime) Create(ctx context.Context, image string, opts ...BoxOption) (*Box, error) {
	r.ensureDrainRunning()

	cfg := &boxConfig{}
	for _, o := range opts {
		o(cfg)
	}

	cOpts, err := buildCOptions(image, cfg)
	if err != nil {
		return nil, err
	}

	ch := make(chan handleResult[*C.CBoxHandle], 1)
	h := cgo.NewHandle(ch)

	var cerr C.CBoxliteError
	code := C.boxlite_create_box(r.handle, cOpts, C.cbCreateBox(), handleToPtr(h), &cerr)
	if code != C.Ok {
		h.Delete()
		// boxlite_create_box consumes opts on success but not on synchronous failure.
		C.boxlite_options_free(cOpts)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		if res.err != nil {
			return nil, res.err
		}
		return newBoxFromHandle(r, res.value, cfg.name), nil
	case <-ctx.Done():
		// Caller's ctx fired before the create completed. The Tokio task is
		// still running on the C side; if it succeeds, abandonAsync force-
		// removes the orphan box so we don't leak a live VM.
		abandonAsync(ch, h, r.forceRemoveOrphanBox)
		return nil, ctx.Err()
	}
}

// Get retrieves an existing box by ID or name.
func (r *Runtime) Get(ctx context.Context, idOrName string) (*Box, error) {
	r.ensureDrainRunning()

	cID := toCString(idOrName)
	defer C.free(unsafe.Pointer(cID))

	ch := make(chan handleResult[*C.CBoxHandle], 1)
	h := cgo.NewHandle(ch)

	var cerr C.CBoxliteError
	code := C.boxlite_get(r.handle, cID, C.cbGetBox(), handleToPtr(h), &cerr)
	if code != C.Ok {
		h.Delete()
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		if res.err != nil {
			return nil, res.err
		}
		return newBoxFromHandle(r, res.value, ""), nil
	case <-ctx.Done():
		// Get attaches to an existing box; if the C side succeeds after
		// cancel, the returned CBoxHandle is just memory we need to free.
		// No live resource to destroy.
		abandonAsync(ch, h, func(handle *C.CBoxHandle) {
			if handle != nil {
				C.boxlite_box_free(handle)
			}
		})
		return nil, ctx.Err()
	}
}

// Remove removes a box by ID or name.
func (r *Runtime) Remove(ctx context.Context, idOrName string) error {
	return r.removeBox(ctx, idOrName, false)
}

// ForceRemove forcefully removes a box (stops it first if running).
func (r *Runtime) ForceRemove(ctx context.Context, idOrName string) error {
	return r.removeBox(ctx, idOrName, true)
}

func (r *Runtime) removeBox(ctx context.Context, idOrName string, force bool) error {
	r.ensureDrainRunning()

	cID := toCString(idOrName)
	defer C.free(unsafe.Pointer(cID))

	ch := make(chan error, 1)
	h := cgo.NewHandle(ch)

	forceFlag := C.int(0)
	if force {
		forceFlag = 1
	}

	var cerr C.CBoxliteError
	code := C.boxlite_remove(r.handle, cID, forceFlag, C.cbRemoveBox(), handleToPtr(h), &cerr)
	if code != C.Ok {
		h.Delete()
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h)
		return ctx.Err()
	}
}

// ensureDrainRunning lazily starts the drain goroutine.
//
// The drain goroutine repeatedly calls boxlite_runtime_drain, which fires
// any pending registered callbacks on the goroutine's OS thread (a Go-owned
// M). Because the M is already a Go thread, callbacks like pipe writes or
// channel sends do not need to hijack a new thread.
func (r *Runtime) ensureDrainRunning() {
	r.drainOnce.Do(func() {
		r.drainStop = make(chan struct{})
		r.drainDone = make(chan struct{})
		go r.drainLoop()
	})
}

func (r *Runtime) drainLoop() {
	defer close(r.drainDone)
	for {
		select {
		case <-r.drainStop:
			return
		default:
		}

		var cerr C.CBoxliteError
		// Block in C up to drainTimeoutMs waiting for events. When the
		// runtime is freed elsewhere, libboxlite signals the queue so this
		// returns immediately.
		_ = C.boxlite_runtime_drain(r.handle, C.int(drainTimeoutMs), &cerr)
		if cerr.code != C.Ok {
			C.boxlite_error_free(&cerr)
		}
	}
}

func (r *Runtime) stopDrain() {
	if r.drainStop == nil {
		return
	}
	select {
	case <-r.drainStop:
		return
	default:
	}
	close(r.drainStop)
	if r.drainDone != nil {
		<-r.drainDone
	}
}

// abandonAsync runs after the caller's context cancelled but the C-side
// Tokio task is still in flight. The Tokio task always completes and posts
// to ch; we wait, free the cgo.Handle to reclaim the table slot, and run
// optional resource cleanup (force-remove orphan VMs, free orphan handles).
// The wait runs in a detached goroutine so the caller returns ctx.Err()
// immediately, honouring Go context norms.
func abandonAsync[T any](ch chan handleResult[T], h cgo.Handle, cleanup func(T)) {
	go func() {
		res := <-ch
		h.Delete()
		if res.err == nil && cleanup != nil {
			cleanup(res.value)
		}
	}()
}

// abandonAsyncErr is the variant for async ops whose channel only carries
// `error` (no resource value).
func abandonAsyncErr(ch chan error, h cgo.Handle) {
	go func() {
		<-ch
		h.Delete()
	}()
}

// drainAndDelete is the generic variant for async ops with a typed result
// channel that has no orphan resource to clean up (info/metrics/etc.). The
// caller's ctx already fired; we just need to drain the result and reclaim
// the cgo.Handle slot when the Tokio task eventually completes.
func drainAndDelete[T any](ch <-chan T, h cgo.Handle) {
	go func() {
		<-ch
		h.Delete()
	}()
}

// forceRemoveOrphanBox best-effort destroys a box that the C side
// successfully created after the caller's ctx had already cancelled. We have
// no caller ctx here, so cap cleanup at 30s with a background context.
func (r *Runtime) forceRemoveOrphanBox(handle *C.CBoxHandle) {
	if handle == nil {
		return
	}
	box := newBoxFromHandle(r, handle, "")
	defer box.Close()
	cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = box.Stop(cctx)
	if id := box.ID(); id != "" {
		_ = r.ForceRemove(cctx, id)
	}
}

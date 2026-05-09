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

	// closing is closed by Close before stopDrain runs. In-flight async
	// operations select on it alongside their result channel and ctx.Done();
	// closing fires waking them up so they return ErrRuntimeClosed instead
	// of blocking forever waiting on the drain goroutine that's about to
	// stop.
	closing     chan struct{}
	closingOnce sync.Once
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

	return &Runtime{
		handle:  handle,
		closing: make(chan struct{}),
	}, nil
}

// Close releases the runtime. Implements io.Closer.
//
// Order matters: closing the `r.closing` channel first wakes every in-flight
// async caller (Create, Pull, Shutdown, etc.) that's parked on its result
// channel. They observe ErrRuntimeClosed and return promptly, releasing
// their cgo.Handles via abandonAsync. Only then do we stop the drain
// goroutine and free the C runtime handle — at that point no Go caller is
// still depending on the drain to deliver a result.
//
// Without this ordering, an in-flight caller with a non-cancellable ctx
// would block forever after stopDrain killed the only goroutine that
// pumps events from C to its result channel.
func (r *Runtime) Close() error {
	if r.handle == nil {
		return nil
	}

	r.closingOnce.Do(func() {
		if r.closing != nil {
			close(r.closing)
		}
	})
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
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_runtime_shutdown(r.handle, C.int(secs), C.cbRuntimeShutdown(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, r.closing)
		return ctx.Err()
	case <-r.closing:
		abandonAsyncErr(ch, h, r.closing)
		return ErrRuntimeClosed
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
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_create_box(r.handle, cOpts, C.cbCreateBox(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
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
		abandonAsync(ch, h, r.closing, r.forceRemoveOrphanBox)
		return nil, ctx.Err()
	case <-r.closing:
		abandonAsync(ch, h, r.closing, r.forceRemoveOrphanBox)
		return nil, ErrRuntimeClosed
	}
}

// Get retrieves an existing box by ID or name.
func (r *Runtime) Get(ctx context.Context, idOrName string) (*Box, error) {
	r.ensureDrainRunning()

	cID := toCString(idOrName)
	defer C.free(unsafe.Pointer(cID))

	ch := make(chan handleResult[*C.CBoxHandle], 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_get(r.handle, cID, C.cbGetBox(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	freeOrphanHandle := func(handle *C.CBoxHandle) {
		if handle != nil {
			C.boxlite_box_free(handle)
		}
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
		abandonAsync(ch, h, r.closing, freeOrphanHandle)
		return nil, ctx.Err()
	case <-r.closing:
		abandonAsync(ch, h, r.closing, freeOrphanHandle)
		return nil, ErrRuntimeClosed
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
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	forceFlag := C.int(0)
	if force {
		forceFlag = 1
	}

	var cerr C.CBoxliteError
	code := C.boxlite_remove(r.handle, cID, forceFlag, C.cbRemoveBox(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, r.closing)
		return ctx.Err()
	case <-r.closing:
		abandonAsyncErr(ch, h, r.closing)
		return ErrRuntimeClosed
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

// activeHandles registers every per-async-op `cgo.Handle` created by
// the SDK. The registry exists to coordinate between the dispatch
// callback path (bridge_callback.go's `defer h.Delete()` after
// receiving the C-side result) and the closing branch in
// `abandonAsync` / `abandonAsyncErr` / `drainAndDelete`. Without
// coordination, during `Runtime.Close` the drain goroutine can still
// be dispatching a queued event whose callback Value/Delete's the
// same handle the closing branch is Deleting in parallel —
// double-Delete or Value-after-Delete would panic the process.
//
// Single-path ownership: each path claims the handle via
// `claimHandleForDispatch`. The first caller's `LoadAndDelete`
// returns true — they own the Value/Delete. Subsequent callers
// receive false and silently no-op. Exactly one Delete per handle,
// regardless of interleaving.
var activeHandles sync.Map

// registerHandleForDispatch records a freshly-created cgo.Handle in
// the active-handles registry. Call this immediately after
// `cgo.NewHandle(...)` at every async-op call site so that dispatch
// callbacks and the closing branch can race for the claim safely.
//
// Returns the handle unchanged for fluent use:
//
//	h := registerHandleForDispatch(cgo.NewHandle(ch))
func registerHandleForDispatch(h cgo.Handle) cgo.Handle {
	activeHandles.Store(uintptr(h), struct{}{})
	return h
}

// claimHandleForDispatch is the single-path ownership gate for a
// per-async-op cgo.Handle. Both the dispatch callback (in
// bridge_callback.go) and `abandonAsync`'s closing/ch branches must
// call this BEFORE doing anything with the handle. The first caller
// to claim wins (returns true); subsequent callers no-op (return
// false).
//
// `LoadAndDelete` is atomic — the registry entry exists exactly once
// per handle, and only one of N concurrent callers receives `loaded
// == true`. The losers exit without touching the handle, so neither
// Value() nor Delete() runs on a freed handle.
func claimHandleForDispatch(h cgo.Handle) bool {
	_, loaded := activeHandles.LoadAndDelete(uintptr(h))
	return loaded
}

// deleteHandleForDispatch claims and deletes the handle. Safe to call from
// any path; idempotent across N concurrent callers (only the claimer's
// h.Delete() runs). Used on synchronous-failure paths (C call returned an
// error code without spawning a Tokio task) and from the abandonAsync /
// abandonAsyncErr / drainAndDelete closing branches.
func deleteHandleForDispatch(h cgo.Handle) {
	if claimHandleForDispatch(h) {
		h.Delete()
	}
}

// claimOrFreePayload is the dispatch-callback gate that ALSO frees the
// C-side payload when the claim has already been taken (e.g. by
// abandonAsync's closing branch during Runtime.Close). Without freeing
// here the payload leaks, because Rust has already transferred
// ownership via `OwnedFfiPtr::take()` before invoking the callback —
// the only Rust-side reclamation path is the Drop on `OwnedFfiPtr`,
// which Rust no longer owns.
//
// Returns true iff the caller wins the claim and should proceed with
// `defer h.Delete()` + `h.Value()`. Returns false otherwise; in the
// false branch the helper has already invoked `free(payload)` and the
// caller MUST NOT touch the handle.
//
// `payload` may be nil (some callbacks have no payload — error-only
// notifications); `free` may be nil if the payload doesn't need
// reclamation.
func claimOrFreePayload[P any](h cgo.Handle, payload *P, free func(*P)) bool {
	if claimHandleForDispatch(h) {
		return true
	}
	if payload != nil && free != nil {
		free(payload)
	}
	return false
}

// abandonAsync runs after the caller's context cancelled but the C-side
// Tokio task is still in flight. The Tokio task always completes and posts
// to ch; we wait, free the cgo.Handle to reclaim the table slot, and run
// optional resource cleanup (force-remove orphan VMs, free orphan handles).
// The wait runs in a detached goroutine so the caller returns ctx.Err()
// immediately, honouring Go context norms.
//
// `closing` is the runtime's close-broadcast channel. If Close fires before
// the Tokio task delivers, the goroutine wakes up and Deletes the handle
// without orphan-cleanup — the runtime is going away, all its boxes/images
// are about to be released by boxlite_runtime_free anyway.
func abandonAsync[T any](ch chan handleResult[T], h cgo.Handle, closing <-chan struct{}, cleanup func(T)) {
	go func() {
		select {
		case res := <-ch:
			// The dispatch callback (in bridge_callback.go) already
			// `defer h.Delete()`'d after sending on ch. claim here is
			// idempotent: if the dispatch claimed first we silently
			// no-op, and if our claim wins (rare — only if the
			// dispatch's claim raced our wakeup), we Delete.
			deleteHandleForDispatch(h)
			if res.err == nil && cleanup != nil {
				cleanup(res.value)
			}
		case <-closing:
			// Dispatch may still race us through the drain goroutine
			// that's running between Close's close(closing) and
			// stopDrain. claim coordinates the single Delete.
			deleteHandleForDispatch(h)
		}
	}()
}

// abandonAsyncErr is the variant for async ops whose channel only carries
// `error` (no resource value).
func abandonAsyncErr(ch chan error, h cgo.Handle, closing <-chan struct{}) {
	go func() {
		select {
		case <-ch:
		case <-closing:
		}
		deleteHandleForDispatch(h)
	}()
}

// drainAndDelete is the generic variant for async ops with a typed result
// channel that has no orphan resource to clean up (info/metrics/etc.). The
// caller's ctx already fired; we just need to drain the result and reclaim
// the cgo.Handle slot when the Tokio task eventually completes.
func drainAndDelete[T any](ch <-chan T, h cgo.Handle, closing <-chan struct{}) {
	go func() {
		select {
		case <-ch:
		case <-closing:
		}
		deleteHandleForDispatch(h)
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

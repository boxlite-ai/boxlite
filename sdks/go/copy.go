package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"io"
	"runtime/cgo"
	"sync"
	"sync/atomic"
	"unsafe"
)

// CopyInto copies a host file or directory into the box.
//
// Copies land owned by the box's exec user, so a non-root workload can read
// them. A destination at or under a mount inside the box (/tmp, /dev/shm,
// volumes, the /etc/{hosts,hostname,resolv.conf} binds), or an archive entry
// that would land on one, is refused: such a write would not be visible to
// anything running in the box. Copy elsewhere, or pipe a tar through Exec.
func (b *Box) CopyInto(ctx context.Context, hostSrc, guestDst string) error {
	b.runtime.ensureDrainRunning()

	cSrc := toCString(hostSrc)
	defer C.free(unsafe.Pointer(cSrc))
	cDst := toCString(guestDst)
	defer C.free(unsafe.Pointer(cDst))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_into(b.handle, cSrc, cDst, C.cbCopy(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, b.runtime.closing)
		return ctx.Err()
	case <-b.runtime.closing:
		abandonAsyncErr(ch, h, b.runtime.closing)
		return ErrRuntimeClosed
	}
}

// CopyOut copies a file or directory from the box to the host.
//
// A source at or under a mount inside the box, or a directory containing one,
// is refused: the archive would carry the underlying files rather than the ones
// processes in the box see.
func (b *Box) CopyOut(ctx context.Context, guestSrc, hostDst string) error {
	b.runtime.ensureDrainRunning()

	cSrc := toCString(guestSrc)
	defer C.free(unsafe.Pointer(cSrc))
	cDst := toCString(hostDst)
	defer C.free(unsafe.Pointer(cDst))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_out(b.handle, cSrc, cDst, C.cbCopy(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, b.runtime.closing)
		return ctx.Err()
	case <-b.runtime.closing:
		abandonAsyncErr(ch, h, b.runtime.closing)
		return ErrRuntimeClosed
	}
}

// copyStreamState is the shared state referenced by the single cgo.Handle that
// services the meta/data/completion callbacks of a streaming copy-out. The
// data and meta callbacks never delete the handle (mirroring the exec stream
// pattern); only the completion callback (goBoxliteOnCopy) deletes it, and
// Rust orders it strictly last.
type copyStreamState struct {
	mu       sync.Mutex
	w        io.Writer
	onMeta   func(bool)
	released atomic.Bool
	done     chan error
}

func newCopyStreamState(w io.Writer, onMeta func(bool)) *copyStreamState {
	return &copyStreamState{w: w, onMeta: onMeta, done: make(chan error, 1)}
}

func (s *copyStreamState) deliverMeta(sourceIsDir bool) {
	if s.released.Load() {
		return
	}
	s.mu.Lock()
	onMeta := s.onMeta
	s.mu.Unlock()
	if onMeta != nil {
		onMeta(sourceIsDir)
	}
}

func (s *copyStreamState) deliverData(data []byte) {
	if s.released.Load() {
		return
	}
	s.mu.Lock()
	w := s.w
	s.mu.Unlock()
	if w != nil {
		_, _ = w.Write(data)
	}
}

func (s *copyStreamState) deliverDone(err error) {
	s.released.Store(true)
	s.done <- err
}

// CopyOutStream streams a tar of guestSrc to w without staging to disk.
//
// onMeta (optional) fires exactly once — before the first write to w — with
// the source-is-directory hint, so callers can set response headers before
// the body. It is never invoked when the guest predates the hint.
func (b *Box) CopyOutStream(ctx context.Context, guestSrc string, w io.Writer, onMeta func(bool)) error {
	b.runtime.ensureDrainRunning()

	cSrc := toCString(guestSrc)
	defer C.free(unsafe.Pointer(cSrc))

	state := newCopyStreamState(w, onMeta)
	h := registerHandleForDispatch(cgo.NewHandle(state))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_out_stream(
		b.handle,
		cSrc,
		C.cbCopyMeta(),
		C.cbCopyData(),
		C.cbCopy(),
		handleToPtr(h),
		&cerr,
	)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-state.done:
		return err
	case <-ctx.Done():
		abandonAsyncErr(state.done, h, b.runtime.closing)
		return ctx.Err()
	case <-b.runtime.closing:
		abandonAsyncErr(state.done, h, b.runtime.closing)
		return ErrRuntimeClosed
	}
}

// CopyInStream streams r (raw tar) into guestDst without staging to disk.
//
// sourceIsDir is the authoritative archive shape (directory tree vs single
// file), carried to the guest so it never has to peek the tar.
func (b *Box) CopyInStream(ctx context.Context, guestDst string, sourceIsDir bool, r io.Reader) error {
	b.runtime.ensureDrainRunning()

	cDst := toCString(guestDst)
	defer C.free(unsafe.Pointer(cDst))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	stream := C.boxlite_copy_in_start(b.handle, cDst, C.bool(sourceIsDir), C.cbCopy(), handleToPtr(h), &cerr)
	if stream == nil {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	var writeErr error
	buf := make([]byte, 1<<20) // 1 MiB chunks
	for {
		n, readErr := r.Read(buf)
		if n > 0 {
			var werr C.CBoxliteError
			if code := C.boxlite_copy_in_write(stream, (*C.uint8_t)(unsafe.Pointer(&buf[0])), C.size_t(n), &werr); code != C.Ok {
				writeErr = freeError(&werr)
				break
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				writeErr = readErr
			}
			break
		}
	}

	var cerrClose C.CBoxliteError
	if code := C.boxlite_copy_in_close(stream, &cerrClose); code != C.Ok && writeErr == nil {
		writeErr = freeError(&cerrClose)
	}
	C.boxlite_copy_in_free(stream)

	if writeErr != nil {
		deleteHandleForDispatch(h)
		return writeErr
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, b.runtime.closing)
		return ctx.Err()
	case <-b.runtime.closing:
		abandonAsyncErr(ch, h, b.runtime.closing)
		return ErrRuntimeClosed
	}
}

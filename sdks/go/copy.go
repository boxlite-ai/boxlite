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
	"unsafe"
)

// CopyInto copies a host file or directory into the box.
//
// A directory lands as docker cp lands it: it becomes a guestDst that does
// not exist, and lands under its own name in one that does. End hostSrc with
// "/." to copy its contents either way. Build that as a string:
// filepath.Join drops the trailing ".".
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
// A directory lands as docker cp lands it: it becomes a hostDst that does
// not exist, and lands under its own name in one that does. End guestSrc with
// "/." to copy its contents either way.
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

const copyStreamBufferSize = 1 << 20 // 1 MiB
const copyInMaxConsecutiveEmptyReads = 100

// copyOutBoundaryError prevents a pull from entering the C ABI after its
// caller has cancelled or the owning runtime has started closing. The same
// check after each blocking read prevents a late chunk from reaching w.
func copyOutBoundaryError(ctx context.Context, closing <-chan struct{}) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	select {
	case <-closing:
		return ErrRuntimeClosed
	default:
		return nil
	}
}

func writeCopyOutChunk(w io.Writer, data []byte) error {
	if w == nil {
		return nil
	}
	n, err := w.Write(data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return io.ErrShortWrite
	}
	return nil
}

// CopyOutStream streams a tar of guestSrc to w without staging to disk. The
// archive's first entry says whether it holds a file or a directory.
//
// Context cancellation and Runtime closure are observed between blocking
// guest reads. They do not interrupt a read or Writer.Write already in
// progress.
func (b *Box) CopyOutStream(ctx context.Context, guestSrc string, w io.Writer) error {
	if err := copyOutBoundaryError(ctx, b.runtime.closing); err != nil {
		return err
	}

	cSrc := toCString(guestSrc)
	defer C.free(unsafe.Pointer(cSrc))

	var cerr C.CBoxliteError
	stream := C.boxlite_copy_out_start(b.handle, cSrc, &cerr)
	if stream == nil {
		return freeError(&cerr)
	}
	defer C.boxlite_copy_out_free(stream)

	if err := copyOutBoundaryError(ctx, b.runtime.closing); err != nil {
		return err
	}

	buf := make([]byte, copyStreamBufferSize)
	for {
		if err := copyOutBoundaryError(ctx, b.runtime.closing); err != nil {
			return err
		}

		var outLen C.size_t
		var readErr C.CBoxliteError
		code := C.boxlite_copy_out_read(
			stream,
			(*C.uint8_t)(unsafe.Pointer(&buf[0])),
			C.size_t(len(buf)),
			&outLen,
			&readErr,
		)
		if code != C.Ok {
			return freeError(&readErr)
		}
		if err := copyOutBoundaryError(ctx, b.runtime.closing); err != nil {
			return err
		}
		if outLen == 0 {
			return nil
		}
		if outLen > C.size_t(len(buf)) {
			return &Error{
				Code:    ErrInternal,
				Message: "copy-out read exceeded the caller buffer",
			}
		}
		if err := writeCopyOutChunk(w, buf[:int(outLen)]); err != nil {
			return err
		}
	}
}

// CopyInStream streams r (raw tar) into guestDst without staging to disk. The
// guest lands it by its first entry, as docker cp lands a copy.
//
// An archive led by one directory becomes a guestDst that does not exist.
// Every later entry must then lie under that directory, or the copy fails
// with ErrInvalidArgument and keeps the entries written before it.
func (b *Box) CopyInStream(ctx context.Context, guestDst string, r io.Reader) error {
	if r == nil {
		return &Error{Code: ErrInvalidArgument, Message: "copy-in reader must not be nil"}
	}

	b.runtime.ensureDrainRunning()

	cDst := toCString(guestDst)
	defer C.free(unsafe.Pointer(cDst))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	stream := C.boxlite_copy_in_start(b.handle, cDst, C.cbCopy(), handleToPtr(h), &cerr)
	if stream == nil {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	var writeErr error
	noProgress := 0
	buf := make([]byte, copyStreamBufferSize)
	for {
		n, readErr := r.Read(buf)
		if n > 0 {
			noProgress = 0
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
		if n == 0 {
			// A reader may return (0, nil) transiently, but never
			// indefinitely — bail instead of spinning forever.
			noProgress++
			if noProgress >= copyInMaxConsecutiveEmptyReads {
				writeErr = io.ErrNoProgress
				break
			}
		}
	}

	var cerrClose C.CBoxliteError
	if writeErr != nil {
		// The source failed mid-transfer: abort rather than close so the
		// guest sees a failed stream, never a clean EOF that it would
		// unpack (and report success) as a truncated archive. The source
		// error is the primary failure; free any C error the abort wrote
		// so it cannot leak.
		if code := C.boxlite_copy_in_abort(stream, &cerrClose); code != C.Ok {
			_ = freeError(&cerrClose)
		}
	} else if code := C.boxlite_copy_in_close(stream, &cerrClose); code != C.Ok {
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

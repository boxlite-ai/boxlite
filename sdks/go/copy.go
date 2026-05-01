package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"unsafe"
)

// CopyInto copies a host file or directory into the box.
func (b *Box) CopyInto(_ context.Context, hostSrc, guestDst string) error {
	cSrc := toCString(hostSrc)
	defer C.free(unsafe.Pointer(cSrc))
	cDst := toCString(guestDst)
	defer C.free(unsafe.Pointer(cDst))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_into(b.handle, cSrc, cDst, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

// CopyOut copies a file or directory from the box to the host.
func (b *Box) CopyOut(_ context.Context, guestSrc, hostDst string) error {
	cSrc := toCString(guestSrc)
	defer C.free(unsafe.Pointer(cSrc))
	cDst := toCString(hostDst)
	defer C.free(unsafe.Pointer(cDst))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_out(b.handle, cSrc, cDst, &cerr)
	if code != C.Ok {
		return freeError(&cerr)
	}
	return nil
}

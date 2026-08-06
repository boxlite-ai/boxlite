package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"unsafe"
)

// Export writes the box archive into dest and returns the archive path.
func (b *Box) Export(ctx context.Context, dest string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}

	cDest := toCString(dest)
	defer C.free(unsafe.Pointer(cDest))

	var outPath *C.char
	var cerr C.CBoxliteError
	code := C.boxlite_box_export(b.handle, cDest, &outPath, &cerr)
	if code != C.Ok {
		return "", freeError(&cerr)
	}
	defer freeBoxliteString(outPath)

	return cString(outPath), ctx.Err()
}

// Import restores an archive into this runtime. If name is empty, the archive's
// recorded box name is used.
func (r *Runtime) Import(ctx context.Context, archivePath, name string) (*Box, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	cArchive := toCString(archivePath)
	defer C.free(unsafe.Pointer(cArchive))
	var cName *C.char
	if name != "" {
		cName = toCString(name)
		defer C.free(unsafe.Pointer(cName))
	}

	var outHandle *C.CBoxHandle
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_import_box(r.handle, cArchive, cName, &outHandle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	if err := ctx.Err(); err != nil {
		if outHandle != nil {
			C.boxlite_box_free(outHandle)
		}
		return nil, err
	}
	return newBoxFromHandle(r, outHandle, name), nil
}

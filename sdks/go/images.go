package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"unsafe"
)

// Images is a runtime-scoped handle for image operations.
type Images struct {
	handle *C.CBoxliteImageHandle
}

func closedImagesError() error {
	return &Error{Code: ErrInvalidState, Message: "image handle is closed"}
}

// Images returns a runtime-scoped handle for image operations.
func (r *Runtime) Images() (*Images, error) {
	var handle *C.CBoxliteImageHandle
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_images(r.handle, &handle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Images{handle: handle}, nil
}

// Pull pulls an image and returns metadata about the cached result.
//
// The context is currently accepted for API symmetry. Once the FFI call starts,
// the underlying operation is not yet cancellable.
func (i *Images) Pull(_ context.Context, reference string) (*ImagePullResult, error) {
	if i == nil || i.handle == nil {
		return nil, closedImagesError()
	}

	cReference := toCString(reference)
	defer C.free(unsafe.Pointer(cReference))

	var cJSON *C.char
	var cerr C.CBoxliteError
	code := C.boxlite_image_pull(i.handle, cReference, &cJSON, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	jsonStr := C.GoString(cJSON)
	freeBoxliteString(cJSON)

	var wire imagePullResultWire
	if err := json.Unmarshal([]byte(jsonStr), &wire); err != nil {
		return nil, err
	}

	result := wire.toImagePullResult()
	return &result, nil
}

// List lists cached images for this runtime.
//
// The context is currently accepted for API symmetry. Once the FFI call starts,
// the underlying operation is not yet cancellable.
func (i *Images) List(_ context.Context) ([]ImageInfo, error) {
	if i == nil || i.handle == nil {
		return nil, closedImagesError()
	}

	var cJSON *C.char
	var cerr C.CBoxliteError
	code := C.boxlite_image_list(i.handle, &cJSON, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	jsonStr := C.GoString(cJSON)
	freeBoxliteString(cJSON)

	var wireInfos []imageInfoWire
	if err := json.Unmarshal([]byte(jsonStr), &wireInfos); err != nil {
		return nil, err
	}

	images := make([]ImageInfo, len(wireInfos))
	for idx := range wireInfos {
		images[idx] = wireInfos[idx].toImageInfo()
	}

	return images, nil
}

// Close releases the image handle.
func (i *Images) Close() error {
	if i != nil && i.handle != nil {
		C.boxlite_image_free(i.handle)
		i.handle = nil
	}
	return nil
}

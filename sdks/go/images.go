package boxlite

/*
#include "boxlite.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"time"
	"unsafe"
)

// ImageInfo holds metadata about a cached image.
type ImageInfo struct {
	Reference  string
	Repository string
	Tag        string
	ID         string
	CachedAt   time.Time
	SizeBytes  *uint64
}

// ImagePullResult contains metadata returned by a pull operation.
type ImagePullResult struct {
	Reference    string
	ConfigDigest string
	LayerCount   int
}

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
func (i *Images) Pull(_ context.Context, reference string) (*ImagePullResult, error) {
	if i == nil || i.handle == nil {
		return nil, closedImagesError()
	}

	cReference := toCString(reference)
	defer C.free(unsafe.Pointer(cReference))

	var cResult *C.CImagePullResult
	var cerr C.CBoxliteError
	code := C.boxlite_image_pull(i.handle, cReference, &cResult, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_free_image_pull_result(cResult)

	return &ImagePullResult{
		Reference:    cString(cResult.reference),
		ConfigDigest: cString(cResult.config_digest),
		LayerCount:   int(cResult.layer_count),
	}, nil
}

// List lists cached images for this runtime.
func (i *Images) List(_ context.Context) ([]ImageInfo, error) {
	if i == nil || i.handle == nil {
		return nil, closedImagesError()
	}

	var cList *C.CImageInfoList
	var cerr C.CBoxliteError
	code := C.boxlite_image_list(i.handle, &cList, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_free_image_info_list(cList)

	items := unsafe.Slice(cList.items, int(cList.count))
	images := make([]ImageInfo, len(items))
	for idx := range items {
		var size *uint64
		if items[idx].has_size != 0 {
			v := uint64(items[idx].size)
			size = &v
		}
		images[idx] = ImageInfo{
			Reference:  cString(items[idx].reference),
			Repository: cString(items[idx].repository),
			Tag:        cString(items[idx].tag),
			ID:         cString(items[idx].id),
			CachedAt:   time.Unix(int64(items[idx].cached_at), 0),
			SizeBytes:  size,
		}
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

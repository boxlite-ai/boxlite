package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"runtime/cgo"
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
	runtime *Runtime
	handle  *C.CBoxliteImageHandle
}

func closedImagesError() error {
	return &Error{Code: ErrInvalidState, Message: "image handle is closed"}
}

// Images returns a runtime-scoped handle for image operations.
//
// The C-side image handle is created synchronously; async operations
// (Pull, List) post events into the parent runtime's event queue and are
// dispatched by the runtime drain goroutine.
func (r *Runtime) Images() (*Images, error) {
	var handle *C.CBoxliteImageHandle
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_images(r.handle, &handle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Images{runtime: r, handle: handle}, nil
}

// Pull pulls an image and returns metadata about the cached result.
func (i *Images) Pull(ctx context.Context, reference string) (*ImagePullResult, error) {
	if i == nil || i.handle == nil {
		return nil, closedImagesError()
	}
	i.runtime.ensureDrainRunning()

	cReference := toCString(reference)
	defer C.free(unsafe.Pointer(cReference))

	ch := make(chan imagePullResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_image_pull(i.handle, cReference, C.cbImagePull(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, i.runtime.closing)
		return nil, ctx.Err()
	case <-i.runtime.closing:
		drainAndDelete(ch, h, i.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// List lists cached images for this runtime.
func (i *Images) List(ctx context.Context) ([]ImageInfo, error) {
	if i == nil || i.handle == nil {
		return nil, closedImagesError()
	}
	i.runtime.ensureDrainRunning()

	ch := make(chan imageListResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_image_list(i.handle, C.cbImageList(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, i.runtime.closing)
		return nil, ctx.Err()
	case <-i.runtime.closing:
		drainAndDelete(ch, h, i.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// Close releases the image handle.
func (i *Images) Close() error {
	if i != nil && i.handle != nil {
		C.boxlite_image_free(i.handle)
		i.handle = nil
	}
	return nil
}

// convertImageInfoList materialises a CImageInfoList* into Go ImageInfo
// slice. The caller is responsible for freeing the C list afterwards.
func convertImageInfoList(list *C.CImageInfoList) []ImageInfo {
	if list == nil || list.count == 0 || list.items == nil {
		return nil
	}
	items := unsafe.Slice(list.items, int(list.count))
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
	return images
}

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

// ImageDetail is an image name and every build of it the runtime holds.
type ImageDetail struct {
	// Name is the registry and repository without a tag, such as
	// "docker.io/library/alpine".
	Name string
	// Aliases are the aliases held for Name.
	Aliases []string
	// Curated reports that the operator provides the image rather than a box
	// having pulled it. Only a REST runtime's catalog has these.
	Curated bool
	// Versions are the builds held under Name, newest first.
	Versions []ImageVersion
	// History holds the latest alias history entries, newest first; a local cache keeps
	// none.
	History []ImageAliasEvent
}

// ImageVersion is one build of an image.
type ImageVersion struct {
	// Digest is the manifest digest, such as "sha256:…".
	Digest string
	// SizeBytes is the sum of the layer sizes the manifest declares; nil when
	// unknown.
	SizeBytes *uint64
	// SourceRef is the reference that was pulled to get this build.
	SourceRef string
	// RecordedAt is when this build was recorded, to the second.
	RecordedAt time.Time
	// Aliases are the image's aliases that point at this build.
	Aliases []string
	// LastUsedAt is when a box last started from this build; nil when unknown.
	LastUsedAt *time.Time
	// UpstreamMissingAt is when a pull found this build gone from its
	// registry; nil while it is not known to be gone.
	UpstreamMissingAt *time.Time
}

// ImageAliasEvent is an alias registration or historical binding change,
// naming versions by digest.
type ImageAliasEvent struct {
	Alias string
	// FromDigest is the build the alias pointed at before; empty when the alias
	// was new.
	FromDigest string
	ToDigest   string
	// Actor is who recorded the alias; empty when a pull recorded it.
	Actor      string
	RecordedAt time.Time
}

// ImageUsage is how much of its image allowance a REST runtime's caller
// holds.
type ImageUsage struct {
	// Count is the images held.
	Count uint64
	// Limit is the images the caller may hold.
	Limit uint64
	// KnownBytes sums the sizes the held builds' manifests declare. A layer two
	// builds share is counted for each, so this is not the bytes stored.
	KnownBytes uint64
}

// Images is a runtime-scoped handle for the images a runtime can boot from:
// the local cache on a runtime from NewRuntime, the server's catalog on one
// from NewRest. Pull is local only (a REST runtime pulls when a box is
// created); Usage, CreateAlias and DeleteAlias are REST only.
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
// (Pull, List, Get, Remove, Usage, CreateAlias, DeleteAlias) post events into the parent runtime's
// event queue and are dispatched by the runtime drain goroutine.
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

// Get returns every build held under an image name, such as
// "docker.io/library/alpine".
//
// A name the runtime does not hold fails with ErrNotFound. A reference with a
// tag or digest ("quay.io/acme/app:v1") fails with ErrInvalidArgument.
func (i *Images) Get(ctx context.Context, name string) (*ImageDetail, error) {
	if i == nil || i.handle == nil {
		return nil, closedImagesError()
	}
	i.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))

	ch := make(chan imageDetailResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_image_get(i.handle, cName, C.cbImageGet(), handleToPtr(h), &cerr)
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

// Remove stops holding an image name, every tag of it. It takes a name as Get
// does and fails the same way.
//
// The layers stay. On a local runtime a box built from the image fetches the
// image's configuration from the registry when it next starts. A REST server
// refuses with ErrInvalidState while a box can still boot from the image.
func (i *Images) Remove(ctx context.Context, name string) error {
	if i == nil || i.handle == nil {
		return closedImagesError()
	}
	i.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_image_remove(i.handle, cName, C.cbImageRemove(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, i.runtime.closing)
		return ctx.Err()
	case <-i.runtime.closing:
		abandonAsyncErr(ch, h, i.runtime.closing)
		return ErrRuntimeClosed
	}
}

// Usage reports how many images are held against the allowance. REST runtimes
// only: a local runtime fails with ErrUnsupported, since a cache has no
// allowance.
func (i *Images) Usage(ctx context.Context) (*ImageUsage, error) {
	if i == nil || i.handle == nil {
		return nil, closedImagesError()
	}
	i.runtime.ensureDrainRunning()

	ch := make(chan imageUsageResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_image_usage(i.handle, C.cbImageUsage(), handleToPtr(h), &cerr)
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

// CreateAlias points a tag of an image name at the version with that digest and
// returns the image as it now is. Boxes already created keep the version they
// have. REST runtimes only: a local runtime, which resolves a tag afresh for
// each new box, fails with ErrUnsupported.
//
// A tag the OCI distribution spec refuses or a digest other than "sha256:"
// and 64 lowercase hex digits fails with ErrInvalidArgument before anything
// is sent.
func (i *Images) CreateAlias(ctx context.Context, name, alias, digest string) (*ImageDetail, error) {
	if i == nil || i.handle == nil {
		return nil, closedImagesError()
	}
	i.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))
	cAlias := toCString(alias)
	defer C.free(unsafe.Pointer(cAlias))
	cDigest := toCString(digest)
	defer C.free(unsafe.Pointer(cDigest))

	ch := make(chan imageDetailResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_image_create_alias(i.handle, cName, cAlias, cDigest, C.cbImageGet(), handleToPtr(h), &cerr)
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

// DeleteAlias removes only the named catalog binding. REST runtimes only.
func (i *Images) DeleteAlias(ctx context.Context, name, alias string) error {
	if i == nil || i.handle == nil {
		return closedImagesError()
	}
	i.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))
	cAlias := toCString(alias)
	defer C.free(unsafe.Pointer(cAlias))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_image_delete_alias(i.handle, cName, cAlias, C.cbImageRemove(), handleToPtr(h), &cerr)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, i.runtime.closing)
		return ctx.Err()
	case <-i.runtime.closing:
		abandonAsyncErr(ch, h, i.runtime.closing)
		return ErrRuntimeClosed
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

// cImageDetailToGo materialises a CImageDetail into a Go ImageDetail. It does
// not free the C struct; the caller owns that.
func cImageDetailToGo(detail *C.CImageDetail) ImageDetail {
	out := ImageDetail{
		Name:    cString(detail.name),
		Curated: detail.curated != 0,
	}
	out.Aliases = cStrings(detail.aliases, detail.aliases_count)
	if detail.versions != nil && detail.versions_count > 0 {
		for _, version := range unsafe.Slice(detail.versions, int(detail.versions_count)) {
			var size *uint64
			if version.has_size != 0 {
				v := uint64(version.size_bytes)
				size = &v
			}
			out.Versions = append(out.Versions, ImageVersion{
				Digest:            cString(version.digest),
				SizeBytes:         size,
				SourceRef:         cString(version.source_ref),
				RecordedAt:        time.Unix(int64(version.recorded_at), 0),
				Aliases:           cStrings(version.aliases, version.aliases_count),
				LastUsedAt:        cTime(version.last_used_at, version.has_last_used_at),
				UpstreamMissingAt: cTime(version.upstream_missing_at, version.has_upstream_missing_at),
			})
		}
	}
	if detail.history != nil && detail.history_count > 0 {
		for _, event := range unsafe.Slice(detail.history, int(detail.history_count)) {
			out.History = append(out.History, ImageAliasEvent{
				Alias:      cString(event.alias),
				FromDigest: cString(event.from_digest),
				ToDigest:   cString(event.to_digest),
				Actor:      cString(event.actor),
				RecordedAt: time.Unix(int64(event.recorded_at), 0),
			})
		}
	}
	return out
}

func cStrings(items **C.char, count C.int) []string {
	if items == nil || count <= 0 {
		return nil
	}
	var out []string
	for _, item := range unsafe.Slice(items, int(count)) {
		out = append(out, cString(item))
	}
	return out
}

// cTime is the time a C field holds, or nil when its has_ flag is zero.
func cTime(seconds C.int64_t, isSet C.int) *time.Time {
	if isSet == 0 {
		return nil
	}
	t := time.Unix(int64(seconds), 0)
	return &t
}

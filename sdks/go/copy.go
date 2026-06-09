package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"
import (
	"context"
	"runtime/cgo"
	"unsafe"
)

// CopyOption configures a CopyInto / CopyOut call. Defaults follow docker-cp
// semantics and match the core, C, Python, and Node SDKs.
type CopyOption func(*copyConfig)

type copyConfig struct {
	recursive      bool
	overwrite      bool
	followSymlinks bool
	includeParent  bool
}

func defaultCopyConfig() copyConfig {
	return copyConfig{recursive: true, overwrite: true, followSymlinks: false, includeParent: true}
}

// WithOverwrite controls whether existing destination files are overwritten
// (default true). When false, copying onto an existing path fails.
func WithOverwrite(v bool) CopyOption { return func(c *copyConfig) { c.overwrite = v } }

// WithIncludeParent keeps the source directory itself in the copy (default
// true); set false to flatten its contents into the destination
// (docker-cp `dir/.` semantics).
func WithIncludeParent(v bool) CopyOption { return func(c *copyConfig) { c.includeParent = v } }

// WithFollowSymlinks copies symlink targets instead of preserving the links
// (default false).
func WithFollowSymlinks(v bool) CopyOption { return func(c *copyConfig) { c.followSymlinks = v } }

// WithRecursive controls recursive directory copies (default true). Directory
// sources require recursive=true.
func WithRecursive(v bool) CopyOption { return func(c *copyConfig) { c.recursive = v } }

// copyCBool converts a Go bool to the cgo `_Bool` used by CBoxCopyOptions.
// (util.go's cBool returns C.int for int-typed FFI params; the copy options
// struct uses C `bool`, so it needs its own converter.)
func copyCBool(b bool) C._Bool {
	return C._Bool(b)
}

func buildCopyCOptions(opts []CopyOption) C.CBoxCopyOptions {
	cfg := defaultCopyConfig()
	for _, o := range opts {
		o(&cfg)
	}
	var c C.CBoxCopyOptions
	c.recursive = copyCBool(cfg.recursive)
	c.overwrite = copyCBool(cfg.overwrite)
	c.follow_symlinks = copyCBool(cfg.followSymlinks)
	c.include_parent = copyCBool(cfg.includeParent)
	return c
}

// CopyInto copies a host file or directory into the box. With no options it
// uses docker-cp defaults (recursive, overwrite, keep the parent directory).
func (b *Box) CopyInto(ctx context.Context, hostSrc, guestDst string, opts ...CopyOption) error {
	b.runtime.ensureDrainRunning()

	cSrc := toCString(hostSrc)
	defer C.free(unsafe.Pointer(cSrc))
	cDst := toCString(guestDst)
	defer C.free(unsafe.Pointer(cDst))

	copts := buildCopyCOptions(opts)

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_into_with_options(b.handle, cSrc, cDst, &copts, C.cbCopy(), handleToPtr(h), &cerr)
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

// CopyOut copies a file or directory from the box to the host. With no options
// it uses docker-cp defaults (recursive, overwrite, keep the parent directory).
func (b *Box) CopyOut(ctx context.Context, guestSrc, hostDst string, opts ...CopyOption) error {
	b.runtime.ensureDrainRunning()

	cSrc := toCString(guestSrc)
	defer C.free(unsafe.Pointer(cSrc))
	cDst := toCString(hostDst)
	defer C.free(unsafe.Pointer(cDst))

	copts := buildCopyCOptions(opts)

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_copy_out_with_options(b.handle, cSrc, cDst, &copts, C.cbCopy(), handleToPtr(h), &cerr)
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

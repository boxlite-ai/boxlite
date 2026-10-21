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

// Git is a box-scoped handle for git config operations.
type Git struct {
	handle  *C.CBoxGitHandle
	runtime *Runtime
}

// GitConfigOptions selects git config scope and repository path.
// An empty Scope defaults to global. Local scope requires Path.
type GitConfigOptions struct {
	Scope string
	Path  string
}

// Git returns the box-scoped handle for git operations.
func (b *Box) Git() (*Git, error) {
	if b == nil || b.handle == nil {
		return nil, ErrRuntimeClosed
	}

	var cGit *C.CBoxGitHandle
	var cerr C.CBoxliteError
	code := C.boxlite_box_git(b.handle, &cGit, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Git{handle: cGit, runtime: b.runtime}, nil
}

// Close releases the git handle.
func (g *Git) Close() error {
	if g != nil && g.handle != nil {
		C.boxlite_git_free(g.handle)
		g.handle = nil
	}
	return nil
}

// ConfigureUser sets user.name and user.email for commits in this box.
func (g *Git) ConfigureUser(ctx context.Context, name, email string, opts *GitConfigOptions) error {
	if g == nil || g.handle == nil || g.runtime == nil {
		return ErrRuntimeClosed
	}
	g.runtime.ensureDrainRunning()

	cName := toCString(name)
	defer C.free(unsafe.Pointer(cName))
	cEmail := toCString(email)
	defer C.free(unsafe.Pointer(cEmail))
	cScope, freeScope := optionalGitCString(gitOptScope(opts))
	defer freeScope()
	cPath, freePath := optionalGitCString(gitOptPath(opts))
	defer freePath()

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_git_configure_user(
		g.handle, cName, cEmail, cScope, cPath, C.cbGitWrite(), handleToPtr(h), &cerr,
	)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	return waitGitWrite(ctx, ch, h, g.runtime)
}

// SetConfig writes a git config value.
func (g *Git) SetConfig(ctx context.Context, key, value string, opts *GitConfigOptions) error {
	if g == nil || g.handle == nil || g.runtime == nil {
		return ErrRuntimeClosed
	}
	g.runtime.ensureDrainRunning()

	cKey := toCString(key)
	defer C.free(unsafe.Pointer(cKey))
	cValue := toCString(value)
	defer C.free(unsafe.Pointer(cValue))
	cScope, freeScope := optionalGitCString(gitOptScope(opts))
	defer freeScope()
	cPath, freePath := optionalGitCString(gitOptPath(opts))
	defer freePath()

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_git_set_config(
		g.handle, cKey, cValue, cScope, cPath, C.cbGitWrite(), handleToPtr(h), &cerr,
	)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	return waitGitWrite(ctx, ch, h, g.runtime)
}

// GetConfig reads a git config value.
func (g *Git) GetConfig(ctx context.Context, key string, opts *GitConfigOptions) (string, error) {
	if g == nil || g.handle == nil || g.runtime == nil {
		return "", ErrRuntimeClosed
	}
	g.runtime.ensureDrainRunning()

	cKey := toCString(key)
	defer C.free(unsafe.Pointer(cKey))
	cScope, freeScope := optionalGitCString(gitOptScope(opts))
	defer freeScope()
	cPath, freePath := optionalGitCString(gitOptPath(opts))
	defer freePath()

	result := make(chan handleResult[*C.char], 1)
	h := registerHandleForDispatch(cgo.NewHandle(result))

	var cerr C.CBoxliteError
	code := C.boxlite_git_get_config(
		g.handle, cKey, cScope, cPath, C.cbGitGetConfig(), handleToPtr(h), &cerr,
	)
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return "", freeError(&cerr)
	}

	dispose := func(value *C.char) {
		if value != nil {
			freeBoxliteString(value)
		}
	}
	select {
	case completed := <-result:
		defer dispose(completed.value)
		if completed.err != nil {
			return "", completed.err
		}
		return cString(completed.value), nil
	case <-ctx.Done():
		abandonOwnedResult(result, h, dispose)
		return "", ctx.Err()
	case <-g.runtime.closing:
		abandonOwnedResult(result, h, dispose)
		return "", ErrRuntimeClosed
	}
}

func waitGitWrite(ctx context.Context, ch chan error, h cgo.Handle, runtime *Runtime) error {
	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, runtime.closing)
		return ctx.Err()
	case <-runtime.closing:
		abandonAsyncErr(ch, h, runtime.closing)
		return ErrRuntimeClosed
	}
}

func gitOptScope(opts *GitConfigOptions) string {
	if opts == nil {
		return ""
	}
	return opts.Scope
}

func gitOptPath(opts *GitConfigOptions) string {
	if opts == nil {
		return ""
	}
	return opts.Path
}

func optionalGitCString(value string) (*C.char, func()) {
	if value == "" {
		return nil, func() {}
	}
	cValue := toCString(value)
	return cValue, func() {
		C.free(unsafe.Pointer(cValue))
	}
}

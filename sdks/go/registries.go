package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"runtime/cgo"
	"sync"
	"time"
	"unsafe"
)

// RegistryCredential is a registry login the server pulls private images
// with. It has no password field: the server never returns one.
type RegistryCredential struct {
	// ID is the UUID Remove takes.
	ID           string
	RegistryHost string
	// RepositoryPrefix is whole path segments ending in "/"; empty for the
	// whole registry.
	RepositoryPrefix string
	Username         string
	// CreatedBy is the user who added it; empty when the server does not know.
	CreatedBy string
	CreatedAt time.Time
}

// NewRegistryCredential is a registry login to add.
type NewRegistryCredential struct {
	// RegistryHost is the registry the login is for, such as "ghcr.io".
	RegistryHost string
	// RepositoryPrefix is whole path segments ending in "/", such as "acme/";
	// empty for the whole registry.
	RepositoryPrefix string
	Username         string
	// Password is the password or access token. It is sent once and never
	// returned.
	Password string
}

// String leaves the password out, so a login printed with %v or %s holds none.
func (c NewRegistryCredential) String() string {
	return "NewRegistryCredential{RegistryHost:" + c.RegistryHost +
		" RepositoryPrefix:" + c.RepositoryPrefix +
		" Username:" + c.Username + " Password:[redacted]}"
}

// GoString keeps %#v from printing the password too.
func (c NewRegistryCredential) GoString() string { return c.String() }

// Registries is the server's registry logins. Only a REST runtime has them.
type Registries struct {
	mu      sync.RWMutex
	runtime *Runtime
	handle  *C.CBoxliteRegistryHandle
}

func closedRegistriesError() error {
	return &Error{Code: ErrInvalidState, Message: "registry handle is closed"}
}

// Registries returns the handle for the server's registry logins.
//
// A local runtime returns ErrUnsupported: it pulls with the logins in its
// options' image registries instead.
func (r *Runtime) Registries() (*Registries, error) {
	var handle *C.CBoxliteRegistryHandle
	var cerr C.CBoxliteError
	code := C.boxlite_runtime_registries(r.handle, &handle, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	return &Registries{runtime: r, handle: handle}, nil
}

// List returns every login the organization holds, oldest first.
func (g *Registries) List(ctx context.Context) ([]RegistryCredential, error) {
	if g == nil {
		return nil, closedRegistriesError()
	}
	g.mu.RLock()
	if g.handle == nil {
		g.mu.RUnlock()
		return nil, closedRegistriesError()
	}
	g.runtime.ensureDrainRunning()

	ch := make(chan registryListResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_registry_list(g.handle, C.cbRegistryList(), handleToPtr(h), &cerr)
	g.mu.RUnlock()
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, g.runtime.closing)
		return nil, ctx.Err()
	case <-g.runtime.closing:
		drainAndDelete(ch, h, g.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// Create adds a login. It fails with ErrAlreadyExists while one is held for
// the same registry and prefix.
func (g *Registries) Create(ctx context.Context, login NewRegistryCredential) (*RegistryCredential, error) {
	if g == nil {
		return nil, closedRegistriesError()
	}
	g.mu.RLock()
	if g.handle == nil {
		g.mu.RUnlock()
		return nil, closedRegistriesError()
	}
	g.runtime.ensureDrainRunning()

	cHost := toCString(login.RegistryHost)
	defer C.free(unsafe.Pointer(cHost))
	var cPrefix *C.char
	if login.RepositoryPrefix != "" {
		cPrefix = toCString(login.RepositoryPrefix)
		defer C.free(unsafe.Pointer(cPrefix))
	}
	cUsername := toCString(login.Username)
	defer C.free(unsafe.Pointer(cUsername))
	cPassword := toCString(login.Password)
	defer C.free(unsafe.Pointer(cPassword))

	ch := make(chan registryResult, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_registry_create(g.handle, cHost, cPrefix, cUsername, cPassword,
		C.cbRegistryCreate(), handleToPtr(h), &cerr)
	g.mu.RUnlock()
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return nil, freeError(&cerr)
	}

	select {
	case res := <-ch:
		return res.value, res.err
	case <-ctx.Done():
		drainAndDelete(ch, h, g.runtime.closing)
		return nil, ctx.Err()
	case <-g.runtime.closing:
		drainAndDelete(ch, h, g.runtime.closing)
		return nil, ErrRuntimeClosed
	}
}

// Remove removes a login by id. It fails with ErrInvalidState, naming the
// boxes, while a box still pulls through it, and with ErrInvalidArgument for
// an id that is not a UUID, before any request.
func (g *Registries) Remove(ctx context.Context, id string) error {
	if g == nil {
		return closedRegistriesError()
	}
	g.mu.RLock()
	if g.handle == nil {
		g.mu.RUnlock()
		return closedRegistriesError()
	}
	g.runtime.ensureDrainRunning()

	cID := toCString(id)
	defer C.free(unsafe.Pointer(cID))

	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))

	var cerr C.CBoxliteError
	code := C.boxlite_registry_remove(g.handle, cID, C.cbRegistryRemove(), handleToPtr(h), &cerr)
	g.mu.RUnlock()
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}

	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, g.runtime.closing)
		return ctx.Err()
	case <-g.runtime.closing:
		abandonAsyncErr(ch, h, g.runtime.closing)
		return ErrRuntimeClosed
	}
}

// Close releases the registry handle.
func (g *Registries) Close() error {
	if g != nil {
		g.mu.Lock()
		defer g.mu.Unlock()
		if g.handle != nil {
			C.boxlite_registry_free(g.handle)
			g.handle = nil
		}
	}
	return nil
}

// cRegistryCredentialToGo copies one CRegistryCredential into Go. It does not
// free the C struct; the caller owns that.
func cRegistryCredentialToGo(login *C.CRegistryCredential) RegistryCredential {
	return RegistryCredential{
		ID:               cString(login.id),
		RegistryHost:     cString(login.registry_host),
		RepositoryPrefix: cString(login.repository_prefix),
		Username:         cString(login.username),
		CreatedBy:        cString(login.created_by),
		CreatedAt:        time.Unix(int64(login.created_at), 0).UTC(),
	}
}

// convertRegistryCredentialList copies a CRegistryCredentialList into Go.
// The caller frees the C list afterwards.
func convertRegistryCredentialList(list *C.CRegistryCredentialList) []RegistryCredential {
	if list == nil || list.count == 0 || list.items == nil {
		return nil
	}
	items := unsafe.Slice(list.items, int(list.count))
	logins := make([]RegistryCredential, len(items))
	for idx := range items {
		logins[idx] = cRegistryCredentialToGo(&items[idx])
	}
	return logins
}

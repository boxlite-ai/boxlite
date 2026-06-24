// AdvancedBoxOptions groups the box-level advanced knobs (currently the
// security toggle) under one handle, mirroring core `BoxOptions.advanced`.
//
// Build it via `NewAdvancedBoxOptions`, toggle the sandbox with
// `SetSecurityEnabled`, and pass it to `runtime.Create(..., WithAdvancedOptions(adv))`.
// Security is reached through this layer (never attached to the box directly),
// matching the core `BoxOptions.advanced.security` model.
//
//	adv, _ := boxlite.NewAdvancedBoxOptions()
//	defer adv.Close()
//	adv.SetSecurityEnabled(false) // opt out of the sandbox
//	box, _ := runtime.Create(ctx, "alpine:latest", boxlite.WithAdvancedOptions(adv))

package boxlite

/*
#include "boxlite.h"
*/
import "C"

import "runtime"

// AdvancedBoxOptions is the Go-side handle for a `CAdvancedBoxOptions`.
// Construct via `NewAdvancedBoxOptions`; release via `Close` once it has
// been attached to a box (or you no longer need it).
type AdvancedBoxOptions struct {
	handle *C.CAdvancedBoxOptions
}

// NewAdvancedBoxOptions allocates an advanced-options handle initialized to
// the defaults (secure-by-default security profile, mount isolation off, no
// health check).
func NewAdvancedBoxOptions() (*AdvancedBoxOptions, error) {
	var raw *C.CAdvancedBoxOptions
	var cerr C.CBoxliteError
	if code := C.boxlite_advanced_options_new(&raw, &cerr); code != C.Ok {
		return nil, errorFromCError(&cerr)
	}
	a := &AdvancedBoxOptions{handle: raw}
	runtime.SetFinalizer(a, func(a *AdvancedBoxOptions) { a.Close() })
	return a, nil
}

// SetSecurityEnabled toggles the box's sandbox. true selects the fully-isolated
// profile (the default when never set); false selects the explicit opt-out
// (master switch off, every sub-protection off — for debugging or environments
// that genuinely can't sandbox). Nil receiver is a no-op.
func (a *AdvancedBoxOptions) SetSecurityEnabled(enabled bool) {
	if a == nil || a.handle == nil {
		return
	}
	C.boxlite_advanced_options_set_security_enabled(a.handle, boolToCInt(enabled))
}

// Close releases the underlying CAdvancedBoxOptions. Idempotent.
func (a *AdvancedBoxOptions) Close() {
	if a == nil || a.handle == nil {
		return
	}
	C.boxlite_advanced_options_free(a.handle)
	a.handle = nil
	runtime.SetFinalizer(a, nil)
}

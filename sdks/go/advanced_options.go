// AdvancedBoxOptions groups box-level capability and security knobs under one
// handle, mirroring core `BoxOptions.advanced`.
//
// Build it via `NewAdvancedBoxOptions`, configure capabilities or security,
// and pass it to `runtime.Create(..., WithAdvancedOptions(adv))`.
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

import (
	"fmt"
	"runtime"
)

// ContainerCapabilities is the requested Linux capability policy.
// Capability names may be written with or without the CAP_ prefix.
type ContainerCapabilities struct {
	Add  []string
	Drop []string
}

// AdvancedBoxOptions is the Go-side handle for a `CAdvancedBoxOptions`.
// Construct via `NewAdvancedBoxOptions`; release via `Close` once it has
// been attached to a box (or you no longer need it).
type AdvancedBoxOptions struct {
	handle       *C.CAdvancedBoxOptions
	capabilities ContainerCapabilities
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

// SetCapabilities replaces advanced.capabilities for subsequently created
// boxes. The input slices are copied; callers may safely reuse or mutate them
// after this method returns.
func (a *AdvancedBoxOptions) SetCapabilities(capabilities ContainerCapabilities) error {
	if a == nil || a.handle == nil {
		return fmt.Errorf("boxlite: advanced options handle is closed")
	}
	if err := validateCapabilities("advanced.capabilities.add", capabilities.Add); err != nil {
		return err
	}
	if err := validateCapabilities("advanced.capabilities.drop", capabilities.Drop); err != nil {
		return err
	}

	add, addCount := toCStringArray(capabilities.Add)
	addCode := C.boxlite_advanced_options_set_capabilities_add(a.handle, add, C.int(addCount))
	freeCStringArray(add, addCount)
	if addCode != C.Ok {
		return fmt.Errorf("boxlite: invalid advanced.capabilities.add")
	}

	drop, dropCount := toCStringArray(capabilities.Drop)
	dropCode := C.boxlite_advanced_options_set_capabilities_drop(a.handle, drop, C.int(dropCount))
	freeCStringArray(drop, dropCount)
	if dropCode != C.Ok {
		return fmt.Errorf("boxlite: invalid advanced.capabilities.drop")
	}

	a.capabilities = ContainerCapabilities{
		Add:  append([]string(nil), capabilities.Add...),
		Drop: append([]string(nil), capabilities.Drop...),
	}
	return nil
}

// Close releases the underlying CAdvancedBoxOptions. Idempotent.
func (a *AdvancedBoxOptions) Close() {
	if a == nil || a.handle == nil {
		return
	}
	C.boxlite_advanced_options_free(a.handle)
	a.handle = nil
	a.capabilities = ContainerCapabilities{}
	runtime.SetFinalizer(a, nil)
}

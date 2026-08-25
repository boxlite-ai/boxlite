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
	privileged   bool
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

// SetPrivileged enables Docker-style privileged mode. Enabling it also
// normalizes the capability policy to cap_add=["ALL"] and an empty cap_drop,
// unless an explicit, non-canonical policy was already set via
// SetCapabilities — then it returns an error, the same conflict
// SetCapabilities itself rejects when called in the other order (privileged
// first, then a conflicting override). Without this check here, calling the
// two setters in reverse order silently kept whatever policy was set first.
func (a *AdvancedBoxOptions) SetPrivileged(enabled bool) error {
	if a == nil || a.handle == nil {
		return fmt.Errorf("boxlite: advanced options handle is closed")
	}
	if enabled && (len(a.capabilities.Add) > 0 || len(a.capabilities.Drop) > 0) &&
		!isPrivilegedCapabilityShape(a.capabilities) {
		return fmt.Errorf("boxlite: privileged mode cannot be combined with cap_add or cap_drop")
	}
	C.boxlite_advanced_options_set_privileged(a.handle, boolToCInt(enabled))
	a.privileged = enabled
	if enabled {
		if len(a.capabilities.Add) == 0 && len(a.capabilities.Drop) == 0 {
			a.capabilities = ContainerCapabilities{Add: []string{"ALL"}}
		}
	} else if isPrivilegedCapabilityShape(a.capabilities) {
		// Mirror the withdrawal the native handle just performed, so the Go
		// view does not keep reporting ALL for a non-privileged box.
		a.capabilities = ContainerCapabilities{}
	}
	return nil
}

// isPrivilegedCapabilityShape reports whether capabilities is exactly the
// canonical shape SetPrivileged(true) installs (add=["ALL"], drop=[]) —
// mirroring the core `ContainerCapabilities::is_privileged_capability_shape`
// this Go type sends over the wire. That shape is not a conflict: it is what
// SetPrivileged itself would produce, whichever order the two setters ran in.
func isPrivilegedCapabilityShape(c ContainerCapabilities) bool {
	return len(c.Drop) == 0 && len(c.Add) == 1 && c.Add[0] == "ALL"
}

// SetCapabilities replaces advanced.capabilities for subsequently created
// boxes. The input slices are copied; callers may safely reuse or mutate them
// after this method returns.
func (a *AdvancedBoxOptions) SetCapabilities(capabilities ContainerCapabilities) error {
	if a == nil || a.handle == nil {
		return fmt.Errorf("boxlite: advanced options handle is closed")
	}
	if a.privileged && (len(capabilities.Add) > 0 || len(capabilities.Drop) > 0) &&
		!isPrivilegedCapabilityShape(capabilities) {
		return fmt.Errorf("boxlite: privileged mode cannot be combined with cap_add or cap_drop")
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

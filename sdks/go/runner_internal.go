//go:build boxlite_runner

package boxlite

/*
#include "bridge.h"
*/
import "C"

import "fmt"

// WithRunnerManagedPolicy is the internal Runner's validated startup policy.
// The control plane supplies each saved box decision; ENV cannot override it.
func WithRunnerManagedPolicy(features ...string) RuntimeOption {
	return func(c *runtimeConfig) {
		c.runnerManaged = true
		c.experimentalFeatures = append([]string(nil), features...)
	}
}

// SetRunnerNestedVirtualization applies the internal control-plane decision.
// This bridge is absent from ordinary SDK builds.
func (a *AdvancedBoxOptions) SetRunnerNestedVirtualization(enabled bool) error {
	if a == nil || a.handle == nil {
		return fmt.Errorf("boxlite: advanced options handle is closed")
	}
	if C.boxlite_internal_advanced_options_set_nested_virtualization(a.handle, boolToCInt(enabled)) != C.Ok {
		return fmt.Errorf("boxlite: could not set Runner nested virtualization")
	}
	return nil
}

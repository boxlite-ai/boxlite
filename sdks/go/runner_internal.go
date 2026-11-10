//go:build boxlite_runner

package boxlite

/*
#include "bridge.h"
*/
import "C"

import (
	"context"
	"fmt"
	"runtime/cgo"
)

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

// StartRunner applies the control plane's sticky cold-start policy.
// It is available only to Runner builds and requires a managed runtime.
func (b *Box) StartRunner(ctx context.Context, nestedVirtualization bool) error {
	b.runtime.ensureDrainRunning()
	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	code := C.boxlite_internal_runner_start_box(b.handle, boolToCInt(nestedVirtualization), C.cbStartBox(), handleToPtr(h), &cerr)
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

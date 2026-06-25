package main

import (
	"errors"
	"testing"
)

// TestInstallTCPOverride_SkipsWhenNoFilterConfigured pins the production
// guard: with neither `allow_net` nor MITM secrets, OverrideTCPHandler
// is NOT called. Critical because a regression that calls it
// unconditionally could break boxes that don't use either feature.
func TestInstallTCPOverride_SkipsWhenNoFilterConfigured(t *testing.T) {
	called := false
	installFn := func() error {
		called = true
		return nil
	}

	if err := installTCPOverride(false, installFn); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if called {
		t.Error("installFn must NOT be called when hasTCPFilter is false")
	}
}

// TestInstallTCPOverride_CallsWhenFilterConfigured is the negative
// control: with `allow_net` or MITM, OverrideTCPHandler IS called.
func TestInstallTCPOverride_CallsWhenFilterConfigured(t *testing.T) {
	called := false
	installFn := func() error {
		called = true
		return nil
	}

	if err := installTCPOverride(true, installFn); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Error("installFn must be called when hasTCPFilter is true")
	}
}

// TestInstallTCPOverride_PropagatesError covers the silent-failure fix:
// pre-#634 the inline `OverrideTCPHandler` call's error was only logged
// and execution continued — allow_net / MITM was silently disabled but
// gvproxy_create returned success. The whole "moved into init phase"
// rewrite hinges on this helper propagating the error so sink.Init
// can fire and box.create can abort.
//
// Two-sided contract: change the body of installTCPOverride to swallow
// the error (e.g. `_ = installFn(); return nil`) and this test reds
// with "expected error, got nil — pre-fix silent install".
//
// This is the SECURITY-shaped half of the larger #634 fix: an
// `allow_net` declared but not installed means the box looks healthy
// AND traffic flows anywhere. The init-phase wiring + this helper
// turn it from silent-bypass into operator-visible fail-fast.
func TestInstallTCPOverride_PropagatesError(t *testing.T) {
	mockErr := errors.New("synthesized OverrideTCPHandler failure")
	installFn := func() error {
		return mockErr
	}

	err := installTCPOverride(true, installFn)
	if err == nil {
		t.Fatal(
			"expected error to propagate; got nil — pre-fix silent install: " +
				"OverrideTCPHandler error swallowed, allow_net/MITM silently " +
				"disabled, box.create reports SUCCESS",
		)
	}
	if !errors.Is(err, mockErr) {
		t.Errorf("error must wrap the underlying cause; got: %v", err)
	}
}

// TestNewTCPFilterFromConfig_EmptyAllowNetReturnsNil pins the MITM-only
// mode: when allow_net is empty but secrets are configured, the filter
// is nil and OverrideTCPHandler runs in MITM-only mode.
func TestNewTCPFilterFromConfig_EmptyAllowNetReturnsNil(t *testing.T) {
	cfg := GvproxyConfig{AllowNet: nil}
	if got := newTCPFilterFromConfig(cfg); got != nil {
		t.Errorf("empty AllowNet must produce nil TCPFilter; got %+v", got)
	}
	cfg = GvproxyConfig{AllowNet: []string{}}
	if got := newTCPFilterFromConfig(cfg); got != nil {
		t.Errorf("empty AllowNet slice must produce nil TCPFilter; got %+v", got)
	}
}

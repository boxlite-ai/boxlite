//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"errors"
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// skipOrFailRuntimeStart skips when the host cannot provide virtualization and
// fails for anything else, so a genuine constructor regression cannot disappear
// into a green skip.
//
// ErrUnsupported is the runtime's own verdict on the host: a hosted Linux runner
// has /dev/kvm but denies the test user access, and a hosted mac cannot check
// Hypervisor.framework. Every other code is a real failure — an unusable HomeDir
// reports ErrStorage, and that must still fail.
//
// Not ErrUnsupportedEngine: sibling SDK tests pair the two codes, but nothing in
// the Rust runtime constructs 19 outside its own error tables, and the safe
// direction for a code that never arrives is to fail rather than skip.
func skipOrFailRuntimeStart(t *testing.T, err error) {
	t.Helper()
	var runtimeErr *boxlite.Error
	if errors.As(err, &runtimeErr) && runtimeErr.Code == boxlite.ErrUnsupported {
		t.Skipf("runtime could not start (infrastructure prerequisite): %v", err)
	}
	t.Fatalf("NewClient: %v", err)
}

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

// The statuses are spelled as the literals the FFI layer emits
// (sdks/c/src/info.rs status_to_str) rather than via the SDK's State constants,
// so this file keeps compiling — and keeps failing behaviorally — if the
// mapping and the constants it depends on are reverted together.
func TestToBoxState(t *testing.T) {
	for _, tc := range []struct {
		core boxlite.State
		want enums.BoxState
	}{
		{"running", enums.BoxStateStarted},
		// A snapshot freeze keeps the VM up, so the box stays started.
		{"paused", enums.BoxStateStarted},
		{"stopping", enums.BoxStateStopping},
		{"stopped", enums.BoxStateStopped},
		{"configured", enums.BoxStateCreating},
		// Failed must not read as Unknown: the API's usage accounting excludes
		// Error from its compute-consuming states but includes Unknown, so a
		// dead box that reports Unknown still reads as occupying compute.
		{"failed", enums.BoxStateError},
		{"unknown", enums.BoxStateUnknown},
		{"a-status-core-gained-later", enums.BoxStateUnknown},
	} {
		if got := ToBoxState(tc.core); got != tc.want {
			t.Errorf("ToBoxState(%q) = %q, want %q", tc.core, got, tc.want)
		}
	}
}

// Every status the runtime can currently report must reach a state other than
// Unknown, which the API bills as compute-consuming. This list is maintained by
// hand, so it catches a mapping that regresses — not a status the core adds.
func TestToBoxStateLeavesNoCurrentStatusUnmapped(t *testing.T) {
	for _, status := range []boxlite.State{"configured", "running", "stopping", "stopped", "paused", "failed"} {
		if got := ToBoxState(status); got == enums.BoxStateUnknown {
			t.Errorf("core status %q fell through to Unknown", status)
		}
	}
}

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// A report is owed from the moment a box starts until a sync tick carries it,
// and only a push that says STARTED can. Destroying the box in between ends
// that: nothing will ever deliver the report, and nothing else drops it, so an
// entry left behind stays for the life of the process — one per box this runner
// ever destroyed without reporting.
//
// Both halves are asserted, because "the handle and the report are one
// decision" is the claim the extraction makes. The handles are zero-value
// wrappers used as identities, which is what keeps this off the FFI: Close
// frees only a non-nil handle, so on one of these it is a no-op.
func TestForgetBoxDropsTheHandleAndTheUndeliveredReport(t *testing.T) {
	t.Run("drops both, and only for the box named", func(t *testing.T) {
		client := &Client{
			boxes: map[string]*boxlite.Box{"box-1": {}, "box-2": {}},
			pendingImageReports: map[string]PulledImage{
				"box-1": {Digest: "sha256:abc", SizeBytes: 4096},
				"box-2": {Digest: "sha256:def", SizeBytes: 8192},
			},
		}

		client.forgetBox("box-1")

		if _, cached := client.boxes["box-1"]; cached {
			t.Error("a destroyed box's handle must not stay cached")
		}
		if _, owed := client.pendingImageReports["box-1"]; owed {
			t.Error("a destroyed box's report must not outlive it")
		}
		if _, cached := client.boxes["box-2"]; !cached {
			t.Error("another box's handle must survive; only the box named is forgotten")
		}
		if _, owed := client.pendingImageReports["box-2"]; !owed {
			t.Error("another box's report must survive; only the box named is forgotten")
		}
	})

	// The handle can be gone before Destroy runs — evictBox unmaps a spent one
	// — while the report is still owed, since nothing evicts that. The report
	// has to go anyway, which is why dropping it does not sit inside the branch
	// that found a handle.
	t.Run("drops the report when the handle was already evicted", func(t *testing.T) {
		client := &Client{
			boxes:               map[string]*boxlite.Box{},
			pendingImageReports: map[string]PulledImage{"box-1": {Digest: "sha256:abc", SizeBytes: 4096}},
		}

		client.forgetBox("box-1")

		if _, owed := client.pendingImageReports["box-1"]; owed {
			t.Error("an evicted box's report must not outlive it either")
		}
	})
}

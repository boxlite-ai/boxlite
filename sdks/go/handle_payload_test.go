package boxlite

// Claim-failure path must reclaim the C-side payload. When
// `abandonAsync`'s closing branch claims the cgo.Handle, a queued
// success callback that fires AFTER the claim sees
// `claimHandleForDispatch == false` and returns. If that path doesn't
// also free the C-side payload, the payload leaks: the Rust dispatch
// path already transferred ownership to the Go callback via
// `OwnedFfiPtr::take()`, so Rust will not reclaim it either. For
// `Runtime.Create` the worst case is a live VM staying alive on the
// host after Runtime.Close (the result-channel branch would have run
// `forceRemoveOrphanBox` to clean it up).

import (
	"runtime/cgo"
	"sync/atomic"
	"testing"
)

// claimAwarePayloadFreer is the post-fix helper that wraps
// `claimHandleForDispatch` and a per-callback payload-free function.
// The fix introduces it (or the equivalent inline pattern) so that
// every dispatch callback frees its received C payload when the
// closing branch already claimed the handle. Today (no helper), this
// test invokes it manually and verifies the contract.
//
// Returns true iff the caller should proceed with Value/Delete
// (claim won). Returns false otherwise; in the false branch the
// caller MUST NOT touch the handle, but the helper has already
// freed the payload via the supplied free function.
func TestClaimOrFreePayload_FreesPayloadWhenClaimAlreadyTaken(t *testing.T) {
	// Pre-claim the handle — simulates abandonAsync's closing branch
	// having won the race.
	ch := make(chan handleResult[int], 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	if !claimHandleForDispatch(h) {
		t.Fatal("test setup: closing-branch simulator failed to claim")
	}

	// Now invoke the dispatch-side flow with a payload that needs freeing.
	// In production this is a *C.CBoxHandle / *C.CImagePullResult / etc.;
	// for the helper-level test we use a synthetic payload + counter.
	var freed atomic.Int64
	dummyPayload := struct{ id int }{42}

	// claimOrFreePayload's expected behaviour: claim fails (already
	// taken) → call free(payload) → return false.
	proceeded := claimOrFreePayload(h, &dummyPayload, func(_ *struct{ id int }) {
		freed.Add(1)
	})

	if proceeded {
		t.Fatal("expected claim to fail (closing branch already claimed); got proceed=true")
	}
	if freed.Load() != 1 {
		t.Fatalf(
			"expected payload free function to run exactly once on claim-failure; "+
				"got %d invocations. The C-owned payload leaks because Rust already "+
				"OwnedFfiPtr::take()'d ownership before the callback ran.",
			freed.Load(),
		)
	}
}

// Adjacent contract: when the claim succeeds, the helper does NOT
// invoke the free function (the caller will use the payload normally
// and the receiving code is responsible for the matching free).
func TestClaimOrFreePayload_DoesNotFreeWhenClaimSucceeds(t *testing.T) {
	ch := make(chan handleResult[int], 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	// No pre-claim — the dispatch path wins.

	var freed atomic.Int64
	dummyPayload := struct{ id int }{99}
	proceeded := claimOrFreePayload(h, &dummyPayload, func(_ *struct{ id int }) {
		freed.Add(1)
	})

	if !proceeded {
		t.Fatal("expected claim to succeed (no prior claim); got proceed=false")
	}
	if freed.Load() != 0 {
		t.Fatalf(
			"expected payload free function NOT to run on claim-success path; "+
				"got %d invocations. The caller will use the payload — freeing "+
				"it here would double-free.",
			freed.Load(),
		)
	}
	// Cleanup: simulate the dispatch path's defer h.Delete().
	h.Delete()
}

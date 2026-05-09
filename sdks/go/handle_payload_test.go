package boxlite

// Codex round-6 finding 2 reproducer: when `abandonAsync`'s closing
// branch claims the cgo.Handle (round-4 #A primitive), a queued success
// callback that fires AFTER the claim sees `claimHandleForDispatch ==
// false` and returns WITHOUT freeing the C-side payload. The Rust
// dispatch path has already transferred ownership of that payload to
// the Go callback via `OwnedFfiPtr::take()`, so Rust will not reclaim
// it either. Net: the payload (CBoxHandle for Create/Get,
// CImagePullResult, CImageInfoList, CBoxInfo, CBoxInfoList) leaks
// across Runtime.Close.
//
// For Create specifically this means a live VM stays alive on the host
// after Runtime.Close — Codex calls this out as the worst-case impact.
// `forceRemoveOrphanBox` (the cleanup the result-channel branch would
// have run) never executes because the goroutine took the closing
// branch instead.
//
// BEFORE FIX: claim-failure path returns silently, payload leaks.
// AFTER FIX: claim-failure path explicitly frees the payload (each
// callback knows its payload type and the matching `boxlite_free_*`).

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
				"OwnedFfiPtr::take()'d ownership before the callback ran (round-6 finding 2).",
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

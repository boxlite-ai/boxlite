package boxlite

// Codex round-4 finding A reproducer: cgo.Handle ownership in the
// round-3 #3 fix has TWO paths that both call h.Delete():
//
//   - The dispatch path (bridge_callback.go): every callback handler
//     calls `h := ptrToHandle(userData); _ = h.Value(); h.Delete()`.
//   - abandonAsync's closing branch (runtime.go): on `<-closing`, the
//     detached cleanup goroutine calls `h.Delete()`.
//
// Runtime.Close fires `r.closing` BEFORE stopDrain returns. During the
// up-to-100ms drain blocking call between close(r.closing) and stopDrain
// completing, the drain goroutine may still dispatch a queued C event
// whose callback calls h.Value() and h.Delete() for the same userData
// that abandonAsync's closing branch is also Deleting. cgo.Handle.Delete
// panics on double-Delete, and Value() panics if Delete already ran.
// Either branch winning the race produces a panic, turning a clean
// shutdown into a process crash.
//
// Stress reproducer: simulate both paths racing on the same handle.
// Each iteration creates a handle, spawns "dispatch" (Value+Delete) and
// "closing-branch" (Delete) goroutines concurrently, and counts panics
// across N iterations.
//
// BEFORE FIX (today): both paths call Delete() unconditionally. With
// enough iterations, the race produces panics deterministically. Test
// fails with "got N panics across M iterations; cgo.Handle ownership
// is not single-path under round-4 fix".
//
// AFTER FIX: a single-path ownership primitive (claim-once on a global
// handle registry) ensures exactly one path proceeds with the
// Value/Delete pair; the loser silently no-ops. Zero panics.

import (
	"runtime/cgo"
	"sync"
	"sync/atomic"
	"testing"
)

func TestHandleOwnership_NoDoubleDeleteRaceDuringClose(t *testing.T) {
	const iterations = 500

	var panics atomic.Int64
	var doubleValueOk atomic.Int64
	var doubleDeleteOk atomic.Int64

	for i := 0; i < iterations; i++ {
		// Each iteration: a fresh handle, two goroutines racing for it.
		// `registerHandleForDispatch` is what every production async-op
		// call site calls after `cgo.NewHandle(...)` so that
		// `claimHandleForDispatch` has the handle in its registry.
		ch := make(chan handleResult[int], 1)
		h := registerHandleForDispatch(cgo.NewHandle(ch))

		var wg sync.WaitGroup
		wg.Add(2)

		// Goroutine A: dispatch path. Mirrors bridge_callback.go's
		// deliverHandleResult — read Value, then Delete.
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					panics.Add(1)
				}
			}()
			if claimed := claimHandleForDispatch(h); !claimed {
				return
			}
			_ = h.Value()
			h.Delete()
			doubleValueOk.Add(1)
		}()

		// Goroutine B: abandonAsync's closing branch. Today calls
		// h.Delete() unconditionally; the fix gates it behind the
		// same claim primitive.
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					panics.Add(1)
				}
			}()
			if claimed := claimHandleForDispatch(h); !claimed {
				return
			}
			h.Delete()
			doubleDeleteOk.Add(1)
		}()

		wg.Wait()
	}

	// Each iteration must produce exactly one Delete (across the two
	// goroutines) — the claim primitive ensures this. Either A wins
	// (doubleValueOk++) or B wins (doubleDeleteOk++); both incrementing
	// the same iteration would mean two claims succeeded, which the
	// primitive must prevent.
	totalSuccessful := doubleValueOk.Load() + doubleDeleteOk.Load()
	if totalSuccessful != int64(iterations) {
		t.Fatalf(
			"expected exactly %d successful claims (one per iteration); "+
				"got %d (A wins: %d, B wins: %d). Some iterations had zero "+
				"or multiple Delete calls — claim primitive is broken.",
			iterations, totalSuccessful, doubleValueOk.Load(), doubleDeleteOk.Load(),
		)
	}

	if c := panics.Load(); c > 0 {
		t.Fatalf(
			"got %d panics across %d iterations; cgo.Handle ownership is "+
				"not single-path. Both the dispatch path (Value+Delete) and "+
				"abandonAsync's closing branch (Delete) call into the same "+
				"handle without coordination, so Runtime.Close racing a "+
				"queued callback can panic the process (round-4 finding A).",
			c, iterations,
		)
	}
}

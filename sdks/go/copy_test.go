package boxlite

import (
	"errors"
	"runtime/cgo"
	"testing"
	"time"
)

type failingWriter struct{ err error }

func (f failingWriter) Write([]byte) (int, error) { return 0, f.err }

// A destination write failure must surface as the copy result, not be
// swallowed — a runner writing a tar to a vanished client has to learn the
// body was not fully delivered. deliverDone must then be a no-op (the first
// error wins, completion is signalled at most once).
func TestCopyOutStreamSurfacesWriterError(t *testing.T) {
	want := errors.New("client gone")
	s := newCopyStreamState(failingWriter{err: want}, nil)

	s.deliverData([]byte("first chunk"))

	select {
	case err := <-s.done:
		if !errors.Is(err, want) {
			t.Fatalf("got %v, want %v", err, want)
		}
	default:
		t.Fatal("destination write error did not surface")
	}

	// The final callback arriving later must not re-signal (which would block
	// on the already-full buffered channel) and must not override the winner.
	s.deliverDone(nil)

	// Once completion is signalled, further data callbacks are ignored.
	s.deliverData([]byte("late chunk"))
}

// Copy-out meta/data callbacks read their shared handle via Value() without
// claiming it. Runtime shutdown must therefore finish draining queued callbacks
// before the abandoned operation reclaims that handle.
func TestAbandonCopyOutStream_CloseBranchWaitsForDrainDone(t *testing.T) {
	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	closing := make(chan struct{})
	drainDone := make(chan struct{})

	abandonCopyOutStream(ch, h, closing, drainDone)
	close(closing)

	time.Sleep(100 * time.Millisecond)
	if _, ok := activeHandles.Load(uintptr(h)); !ok {
		t.Fatal("handle was deleted before the drain finished")
	}

	close(drainDone)
	time.Sleep(100 * time.Millisecond)
	expectAlreadyDeleted(t, h)
}

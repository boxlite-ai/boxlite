package boxlite

import (
	"errors"
	"testing"
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

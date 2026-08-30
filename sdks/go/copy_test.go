package boxlite

import (
	"context"
	"errors"
	"io"
	"testing"
)

type failingWriter struct{ err error }

func (f failingWriter) Write([]byte) (int, error) { return 0, f.err }

type shortWriter struct{}

func (shortWriter) Write(p []byte) (int, error) { return len(p) - 1, nil }

func TestWriteCopyOutChunkSurfacesWriterError(t *testing.T) {
	want := errors.New("client gone")
	if err := writeCopyOutChunk(failingWriter{err: want}, []byte("chunk")); !errors.Is(err, want) {
		t.Fatalf("writeCopyOutChunk() error = %v, want %v", err, want)
	}
}

func TestWriteCopyOutChunkRejectsShortWrite(t *testing.T) {
	if err := writeCopyOutChunk(shortWriter{}, []byte("chunk")); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("writeCopyOutChunk() error = %v, want %v", err, io.ErrShortWrite)
	}
}

func TestDeliverCopyOutMetaMapsKnownKinds(t *testing.T) {
	var got []bool
	onMeta := func(sourceIsDir bool) { got = append(got, sourceIsDir) }

	deliverCopyOutMeta(CopySourceUnknown, onMeta)
	deliverCopyOutMeta(CopySourceFile, onMeta)
	deliverCopyOutMeta(CopySourceDir, onMeta)

	if len(got) != 2 || got[0] || !got[1] {
		t.Fatalf("metadata callbacks = %v, want [false true]", got)
	}
}

func TestCopyOutBoundaryError(t *testing.T) {
	closing := make(chan struct{})
	if err := copyOutBoundaryError(context.Background(), closing); err != nil {
		t.Fatalf("open boundary error = %v, want nil", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := copyOutBoundaryError(ctx, closing); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled boundary error = %v, want %v", err, context.Canceled)
	}

	close(closing)
	if err := copyOutBoundaryError(context.Background(), closing); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("closed boundary error = %v, want %v", err, ErrRuntimeClosed)
	}
}

//go:build boxlite_dev

package boxlite

import (
	"context"
	"errors"
	"io"
	"testing"
)

// failAfterReader yields its bytes once and then fails with err — the shape
// of a client connection severed mid-upload.
type failAfterReader struct {
	data []byte
	pos  int
	err  error
}

func (r *failAfterReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, r.err
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}

// A source that fails mid-transfer must fail the copy: the Go layer takes
// the abort branch (terminal error to the guest, not a clean EOF) and must
// surface the read error to the caller.
func TestCopyInStreamFailedSourceFailsCopy(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBox(t, rt, "alpine:latest")

	reader := &failAfterReader{
		data: make([]byte, 4096), // partial payload, severed upload
		err:  errors.New("client gone"),
	}

	err := box.CopyInStream(context.Background(), "/root/aborted.tar", CopySourceFile, reader)
	if err == nil {
		t.Fatal("a source failure mid-transfer must fail the copy")
	}
}

var _ io.Reader = (*failAfterReader)(nil)

// zeroReader returns (0, nil) forever — the misbehaving-source shape that
// must not spin the copy loop.
type zeroReader struct{}

func (zeroReader) Read([]byte) (int, error) { return 0, nil }

// A source that never makes progress must fail the copy with
// io.ErrNoProgress instead of spinning.
func TestCopyInStreamNoProgressFails(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBox(t, rt, "alpine:latest")

	err := box.CopyInStream(context.Background(), "/root/noprogress.tar", CopySourceFile, zeroReader{})
	if !errors.Is(err, io.ErrNoProgress) {
		t.Fatalf("got %v, want io.ErrNoProgress", err)
	}
}

var _ io.Reader = zeroReader{}

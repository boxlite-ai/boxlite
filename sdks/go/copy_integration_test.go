//go:build boxlite_dev

package boxlite

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type controlledBlockingWriter struct {
	entered     chan struct{}
	release     chan struct{}
	enteredOnce sync.Once
	releaseOnce sync.Once
}

func newControlledBlockingWriter() *controlledBlockingWriter {
	return &controlledBlockingWriter{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (w *controlledBlockingWriter) Write(p []byte) (int, error) {
	w.enteredOnce.Do(func() { close(w.entered) })
	<-w.release
	return len(p), nil
}

func (w *controlledBlockingWriter) unblock() {
	w.releaseOnce.Do(func() { close(w.release) })
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

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

// Into an existing directory, a directory is copied under its own name, and
// "/." copies its contents.
// The C bindings this SDK sits on used to flatten every directory both ways,
// so the directory itself was out of reach from Go.
func TestCopyDirectoryNestsUnlessSourceEndsInDot(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBox(t, rt, "alpine:latest")
	ctx := context.Background()

	src := filepath.Join(t.TempDir(), "tree")
	if err := os.Mkdir(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "a.txt"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := box.CopyInto(ctx, src, "/root"); err != nil {
		t.Fatalf("CopyInto: %v", err)
	}

	nested := t.TempDir()
	if err := box.CopyOut(ctx, "/root/tree", nested); err != nil {
		t.Fatalf("CopyOut: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(nested, "tree", "a.txt")); err != nil || string(got) != "a" {
		t.Fatalf("directory should land under its own name both ways: %q, %v", got, err)
	}

	contents := t.TempDir()
	if err := box.CopyOut(ctx, "/root/tree/.", contents); err != nil {
		t.Fatalf("CopyOut contents: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(contents, "a.txt")); err != nil || string(got) != "a" {
		t.Fatalf("/. should copy the contents: %q, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(contents, "tree")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("/. must not copy the directory itself: %v", err)
	}
}

// The runner's copy-in path: a directory streamed to a missing destination
// becomes it, the way docker cp lands it.
func TestCopyInStreamLandsADirectoryTheWayDockerCpDoes(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBox(t, rt, "alpine:latest")
	ctx := context.Background()
	run := func(script string) string {
		t.Helper()
		result, err := box.Exec(ctx, "sh", "-c", script)
		if err != nil {
			t.Fatalf("%s: %v", script, err)
		}
		if result.ExitCode != 0 {
			t.Fatalf("%s: exit code %d, stderr=%q", script, result.ExitCode, result.Stderr)
		}
		return result.Stdout
	}
	run("mkdir /root/tree && printf a > /root/tree/a.txt")

	// The archive a client sends for directory "tree", as BoxLite packs it.
	var archive bytes.Buffer
	if err := box.CopyOutStream(ctx, "/root/tree", &archive, nil); err != nil {
		t.Fatalf("CopyOutStream: %v", err)
	}

	if err := box.CopyInStream(ctx, "/root/landed", CopySourceDir, &archive); err != nil {
		t.Fatalf("CopyInStream: %v", err)
	}
	if got := run("cat /root/landed/a.txt && test ! -e /root/landed/tree"); got != "a" {
		t.Fatalf("got %q", got)
	}
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

func TestCopyOutStreamDoesNotBlockRuntimeCallbacks(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBox(t, rt, "alpine:latest")

	result, err := box.Exec(context.Background(), "sh", "-c", "printf 'copy-out-hol' > /root/copy-out-hol.txt")
	if err != nil {
		t.Fatalf("prepare copy-out source: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("prepare copy-out source: exit code %d, stderr=%q", result.ExitCode, result.Stderr)
	}

	writer := newControlledBlockingWriter()
	copyDone := make(chan error, 1)
	go func() {
		copyDone <- box.CopyOutStream(context.Background(), "/root/copy-out-hol.txt", writer, nil)
		close(copyDone)
	}()
	t.Cleanup(func() {
		writer.unblock()
		select {
		case <-copyDone:
		case <-time.After(10 * time.Second):
			t.Error("CopyOutStream did not finish after releasing the blocking writer")
		}
	})

	select {
	case <-writer.entered:
	case err := <-copyDone:
		t.Fatalf("CopyOutStream returned before its writer was entered: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("CopyOutStream did not reach its writer")
	}

	infoCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	info, err := box.Info(infoCtx)
	if err != nil {
		t.Fatalf("Info was blocked by CopyOutStream's writer: %v", err)
	}
	if info == nil {
		t.Fatal("Info returned nil without an error")
	}

	select {
	case err := <-copyDone:
		t.Fatalf("CopyOutStream returned while its writer was still blocked: %v", err)
	default:
	}

	writer.unblock()
	select {
	case err := <-copyDone:
		if err != nil {
			t.Fatalf("CopyOutStream: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("CopyOutStream did not finish after releasing the blocking writer")
	}
}

func TestCopyOutStreamPullContract(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBox(t, rt, "alpine:latest")

	const sourcePath = "/root/copy-out-pull-contract.txt"
	result, err := box.Exec(context.Background(), "sh", "-c", "printf 'pull-contract' > "+sourcePath)
	if err != nil {
		t.Fatalf("prepare copy-out source: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("prepare copy-out source: exit code %d, stderr=%q", result.ExitCode, result.Stderr)
	}

	t.Run("file metadata precedes first write", func(t *testing.T) {
		var events []string
		metadataCalls := 0
		writer := writerFunc(func(p []byte) (int, error) {
			events = append(events, "write")
			return len(p), nil
		})
		onMeta := func(sourceIsDir bool) {
			metadataCalls++
			if sourceIsDir {
				events = append(events, "metadata:dir")
				return
			}
			events = append(events, "metadata:file")
		}
		if err := box.CopyOutStream(context.Background(), sourcePath, writer, onMeta); err != nil {
			t.Fatalf("CopyOutStream: %v", err)
		}
		if metadataCalls != 1 {
			t.Fatalf("metadata callback count = %d, want 1", metadataCalls)
		}
		if len(events) < 2 {
			t.Fatalf("events = %v, want metadata followed by at least one write", events)
		}
		if events[0] != "metadata:file" || events[1] != "write" {
			t.Fatalf("first events = %v, want [metadata:file write]", events[:2])
		}
	})

	t.Run("writer error is returned unchanged", func(t *testing.T) {
		want := errors.New("copy-out writer sentinel")
		writeCalls := 0
		writer := writerFunc(func([]byte) (int, error) {
			writeCalls++
			return 0, want
		})
		if got := box.CopyOutStream(context.Background(), sourcePath, writer, nil); got != want {
			t.Fatalf("CopyOutStream error = %v, want identical sentinel %v", got, want)
		}
		if writeCalls != 1 {
			t.Fatalf("writer call count = %d, want 1", writeCalls)
		}
	})

	t.Run("short write returns io ErrShortWrite", func(t *testing.T) {
		writeCalls := 0
		writer := writerFunc(func(p []byte) (int, error) {
			writeCalls++
			return len(p) - 1, nil
		})
		if got := box.CopyOutStream(context.Background(), sourcePath, writer, nil); got != io.ErrShortWrite {
			t.Fatalf("CopyOutStream error = %v, want %v", got, io.ErrShortWrite)
		}
		if writeCalls != 1 {
			t.Fatalf("writer call count = %d, want 1", writeCalls)
		}
	})

	t.Run("missing source fails before write", func(t *testing.T) {
		writeCalls := 0
		writer := writerFunc(func(p []byte) (int, error) {
			writeCalls++
			return len(p), nil
		})
		err := box.CopyOutStream(context.Background(), "/root/copy-out-pull-contract-missing", writer, nil)
		if err == nil {
			t.Fatal("CopyOutStream succeeded for a missing source")
		}
		if writeCalls != 0 {
			t.Fatalf("writer call count = %d, want 0", writeCalls)
		}
	})
}

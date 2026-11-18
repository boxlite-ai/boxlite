// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package timing

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"syscall"
	"testing"
	"time"
)

type writeFunc func([]byte) (int, error)

func (f writeFunc) Write(p []byte) (int, error) { return f(p) }

func TestJSONLine(t *testing.T) {
	lines := make(chan []byte, 2)
	t.Cleanup(SetWriterForTest(writeFunc(func(p []byte) (int, error) {
		lines <- bytes.Clone(p)
		return len(p), nil
	})))
	start := time.Now().Add(-12 * time.Millisecond)
	Emit("exec", "exec.started", OK, start, IDs{BoxID: "box-1", JobID: "job-1", ExecID: "exec-1"})
	Emit("exec", "exec.request", Error, start, IDs{})

	for i, want := range []map[string]string{
		{"op": "exec", "stage": "exec.started", "status": "ok", "box_id": "box-1", "job_id": "job-1", "exec_id": "exec-1"},
		{"op": "exec", "stage": "exec.request", "status": "error"},
	} {
		select {
		case line := <-lines:
			var fields map[string]json.RawMessage
			if bytes.Count(line, []byte{'\n'}) != 1 || line[len(line)-1] != '\n' || json.Unmarshal(line, &fields) != nil {
				t.Fatalf("not a JSON line: %q", line)
			}
			if len(fields) != len(want)+2 {
				t.Fatalf("line %d has unexpected or non-omitted fields: %s", i, line)
			}
			for key, value := range want {
				var got string
				if err := json.Unmarshal(fields[key], &got); err != nil || got != value {
					t.Errorf("%s = %q (%v), want %q", key, got, err, value)
				}
			}
			var ms int64
			if err := json.Unmarshal(fields["dur_ms"], &ms); err != nil || ms < 12 {
				t.Errorf("dur_ms = %s, want integer >= 12", fields["dur_ms"])
			}
			var ts string
			_ = json.Unmarshal(fields["ts"], &ts)
			if _, err := time.Parse(time.RFC3339Nano, ts); err != nil {
				t.Error(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timing writer did not receive a line")
		}
	}
}

func TestConcurrentWritesDoNotTearLines(t *testing.T) {
	const count = 128
	var buf bytes.Buffer
	writes := 0
	done := make(chan struct{})
	t.Cleanup(SetWriterForTest(writeFunc(func(p []byte) (int, error) {
		mid := len(p) / 2
		buf.Write(p[:mid])
		runtime.Gosched()
		buf.Write(p[mid:])
		writes++
		if writes == count {
			close(done)
		}
		return len(p), nil
	})))

	var wg sync.WaitGroup
	for i := range count {
		wg.Go(func() {
			Emit("exec", "exec.started", OK, time.Now(), IDs{BoxID: "box-1", ExecID: fmt.Sprint(i)})
		})
	}
	wg.Wait()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for writes")
	}
	seen := make(map[string]bool)
	scan := bufio.NewScanner(&buf)
	for scan.Scan() {
		var got Event
		if err := json.Unmarshal(scan.Bytes(), &got); err != nil || got.Op != "exec" || got.ExecID == "" || seen[got.ExecID] {
			t.Fatalf("invalid or duplicate line: %s (%v)", scan.Bytes(), err)
		}
		seen[got.ExecID] = true
	}
	if scan.Err() != nil || len(seen) != count {
		t.Fatalf("got %d JSON lines, want %d; scan error: %v", len(seen), count, scan.Err())
	}
}

func TestStdoutShortWriteKeepsJSONLines(t *testing.T) {
	var buf bytes.Buffer
	short := true
	t.Cleanup(SetWriterForTest(&stdoutWriter{write: func(p []byte) (int, error) {
		if short {
			short = false
			return buf.Write(p[:1])
		}
		return buf.Write(p)
	}}))

	stages := []string{"first", "second", "third"}
	for _, stage := range stages {
		Emit("exec", stage, OK, time.Now(), IDs{})
	}
	// A FIFO barrier waits for every Emit, even if a write failed or was dropped.
	done := make(chan struct{})
	process.queue <- pending{writer: writeFunc(func(p []byte) (int, error) {
		close(done)
		return len(p), nil
	})}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for writes")
	}

	stream := buf.Bytes()
	for _, stage := range stages {
		line, rest, ok := bytes.Cut(stream, []byte{'\n'})
		var event Event
		if !ok || json.Unmarshal(line, &event) != nil || event.Stage != stage {
			t.Fatalf("want complete JSON line for %q, got %q", stage, line)
		}
		stream = rest
	}
	if len(stream) != 0 {
		t.Fatalf("unexpected trailing bytes: %q", stream)
	}
}

func TestStdoutFailedPartialLineSuppressesLaterWrites(t *testing.T) {
	var buf bytes.Buffer
	calls := 0
	w := &stdoutWriter{write: func(p []byte) (int, error) {
		calls++
		switch calls {
		case 1:
			return buf.Write(p[:1])
		case 2:
			return -1, syscall.EAGAIN
		default:
			return buf.Write(p)
		}
	}}
	if n, err := w.Write([]byte("{}\n")); n != 1 || !errors.Is(err, syscall.EAGAIN) {
		t.Fatalf("partial write = (%d, %v), want (1, EAGAIN)", n, err)
	}
	if n, err := w.Write([]byte("{}\n")); n != 0 || !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("next write = (%d, %v), want (0, ErrShortWrite)", n, err)
	}
	if got := buf.String(); got != "{" || calls != 2 {
		t.Fatalf("got %q after %d low-level writes, want just the original fragment after 2", got, calls)
	}
}

func TestStdoutBrokenPipeDoesNotTerminate(t *testing.T) {
	const child = "timing-broken-stdout"
	if os.Args[len(os.Args)-1] == child {
		if _, err := (&stdoutWriter{write: writeStdout}).Write([]byte("probe\n")); !errors.Is(err, syscall.EPIPE) {
			os.Exit(1)
		}
		os.Exit(0)
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_ = r.Close()
	defer w.Close()
	cmd := exec.Command(os.Args[0], "-test.run=^TestStdoutBrokenPipeDoesNotTerminate$", "--", child)
	cmd.Stdout = w
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
}

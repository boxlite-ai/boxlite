// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package controllers

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// drainResult is what attachDrainOutcome observed driving one /attach session.
type drainResult struct {
	exitSeen    bool
	stdoutBytes int
	stderrBytes int
	trailing    int // stream bytes that arrived AFTER the exit frame (ordering)
}

// attachDrainOutcome drives the real BoxliteExecAttach handler over a websocket
// with the given stub producer, then reports what the client observed. producer
// performs the stream writes, EOFs, and fires Done. tty selects TTY mode (the
// handler then runs only the stdout pump). Reads stop once the exit frame and
// any trailing frames are seen, or after a hang deadline.
func attachDrainOutcome(t *testing.T, tty bool, exitCode int, producer func(s *stubAttachExec)) drainResult {
	t.Helper()
	const stdoutByte, stderrByte = 0x01, 0x02

	stub := newStubAttachExec()
	stub.exitCode = exitCode
	stub.tty = tty
	cleanup := withStubExec(t, "exec-matrix", stub)
	defer cleanup()
	srv := newAttachServer(t)
	defer srv.Close()
	conn, _, err := dialAttach(t, srv, "exec-matrix")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	go producer(stub)

	var r drainResult
	seenExit := false
	count := func(payload []byte) {
		if len(payload) < 1 {
			return
		}
		n := len(payload) - 1
		switch payload[0] {
		case stdoutByte:
			r.stdoutBytes += n
		case stderrByte:
			r.stderrBytes += n
		}
		if seenExit {
			r.trailing += n
		}
	}

	for {
		_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
		mt, payload, err := conn.ReadMessage()
		if err != nil {
			return r // deadline/close without exit => HANG (exitSeen stays false)
		}
		switch mt {
		case websocket.BinaryMessage:
			count(payload)
		case websocket.TextMessage:
			var ev map[string]any
			if json.Unmarshal(payload, &ev) == nil && ev["type"] == "exit" {
				r.exitSeen = true
				seenExit = true
				// Drain any trailing frames briefly to catch ordering bugs.
				_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
				for {
					mt2, p2, e2 := conn.ReadMessage()
					if e2 != nil {
						return r
					}
					if mt2 == websocket.BinaryMessage {
						count(p2)
					}
				}
			}
		}
	}
}

// TestAttachDrainMatrix locks down PR #812's runner-side drain across the
// (output x stream-termination) matrix: clean exits flush all output with the
// exit frame strictly last; a SIGKILLed never-EOF pipe gives up after the idle
// window and still sends exit instead of hanging.
func TestAttachDrainMatrix(t *testing.T) {
	big := strings.Repeat("a", 64*1024) // 16 chunks < 256 channel buffer: lossless

	// fireDone models Exit-strictly-last: settle so the broadcaster fully fans
	// out everything the producer wrote before exit is observed, otherwise
	// close(done) -> unsubscribe races the fan-out and can drop trailing bytes.
	fireDone := func(s *stubAttachExec) {
		time.Sleep(50 * time.Millisecond)
		close(s.done)
	}

	cases := []struct {
		name       string
		tty        bool
		wantStdout int
		wantStderr int
		producer   func(s *stubAttachExec)
	}{
		{"clean-none", false, 0, 0, func(s *stubAttachExec) {
			s.stdoutW.Close()
			fireDone(s)
		}},
		{"clean-short", false, 2, 0, func(s *stubAttachExec) {
			s.stdoutW.Write([]byte("hi"))
			s.stdoutW.Close()
			fireDone(s)
		}},
		{"clean-long-64k", false, len(big), 0, func(s *stubAttachExec) {
			s.stdoutW.Write([]byte(big))
			s.stdoutW.Close()
			fireDone(s)
		}},
		{"stderr-channel", false, 3, 7, func(s *stubAttachExec) {
			s.stdoutW.Write([]byte("OUT"))
			s.stderrW.Write([]byte("ERRLINE"))
			s.stdoutW.Close()
			s.stderrW.Close()
			fireDone(s)
		}},
		{"tty-merged", true, 9, 0, func(s *stubAttachExec) {
			s.stdoutW.Write([]byte("hello-tty"))
			s.stdoutW.Close()
			s.stderrW.Close()
			fireDone(s)
		}},
		{"stuck-never-eof", false, 2, 0, func(s *stubAttachExec) {
			// SIGKILLed guest: exit is known (Done) but stdout never EOFs.
			// Model Exit-strictly-last: the "hi" the process emitted is fully
			// delivered before its exit is observed. Without the settle the stub
			// races close(done) (-> unsubscribe) against the broadcaster's
			// fan-out and can drop "hi" (in-process delivery is microseconds;
			// the settle is many orders of margin).
			s.stdoutW.Write([]byte("hi"))
			fireDone(s)
			// deliberately never close stdoutW
		}},
	}

	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			r := attachDrainOutcome(t, c.tty, 7, c.producer)
			if !r.exitSeen {
				t.Fatalf("HANG: no exit frame within deadline (%s)", c.name)
			}
			if r.trailing != 0 {
				t.Fatalf("ORDERING: %d stream bytes arrived AFTER the exit frame", r.trailing)
			}
			if r.stdoutBytes != c.wantStdout {
				t.Fatalf("stdout: got %d want %d", r.stdoutBytes, c.wantStdout)
			}
			if r.stderrBytes != c.wantStderr {
				t.Fatalf("stderr: got %d want %d", r.stderrBytes, c.wantStderr)
			}
		})
	}
}

// TestAttachLagWarning verifies FIX #3: when the broadcaster dropped output for
// a slow client (dropped() > 0), the handler surfaces a `warning` frame before
// the exit frame.
func TestAttachLagWarning(t *testing.T) {
	stub := newStubAttachExec()
	stub.exitCode = 0
	stub.droppedN = 42
	cleanup := withStubExec(t, "exec-lag", stub)
	defer cleanup()
	srv := newAttachServer(t)
	defer srv.Close()
	conn, _, err := dialAttach(t, srv, "exec-lag")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	go func() { stub.stdoutW.Close(); close(stub.done) }()

	sawWarning := false
	for {
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		mt, payload, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt != websocket.TextMessage {
			continue
		}
		var ev map[string]any
		if json.Unmarshal(payload, &ev) != nil {
			continue
		}
		switch ev["type"] {
		case "warning":
			if msg, _ := ev["message"].(string); !strings.Contains(msg, "42 bytes dropped") {
				t.Fatalf("warning message = %q, want it to mention 42 bytes dropped", msg)
			}
			sawWarning = true
		case "exit":
			if !sawWarning {
				t.Fatal("exit frame arrived but no lag warning was sent despite dropped()=42")
			}
			return
		}
	}
	t.Fatal("no exit frame seen")
}

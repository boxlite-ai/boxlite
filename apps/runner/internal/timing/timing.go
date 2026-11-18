// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

// Package timing emits best-effort runner phase timings without waiting for I/O.
package timing

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	OK      = "ok"
	Error   = "error"
	Skipped = "skipped"
)

// IDs holds the only operation metadata allowed in a timing event.
type IDs struct {
	BoxID  string `json:"box_id,omitempty"`
	JobID  string `json:"job_id,omitempty"`
	ExecID string `json:"exec_id,omitempty"`
}

// Event contains the phase timing and correlation IDs exposed over HTTP.
type Event struct {
	Op     string `json:"op"`
	Stage  string `json:"stage"`
	Status string `json:"status"`
	DurMS  int64  `json:"dur_ms"`
	IDs
	TS string `json:"ts"`
}

type pending struct {
	event  Event
	writer io.Writer
}

// Emitter serializes JSON lines on a dedicated goroutine. A stalled sink can
// fill the bounded queue, but cannot stall the operation it is observing.
type Emitter struct {
	queue  chan pending
	writer atomic.Pointer[io.Writer]
}

var process = newEmitter(&stdoutWriter{write: writeStdout})

func newEmitter(w io.Writer) *Emitter {
	e := &Emitter{queue: make(chan pending, 1024)}
	e.writer.Store(&w)
	go func() {
		for p := range e.queue {
			e.write(p)
		}
	}()
	return e
}

func (e *Emitter) write(p pending) {
	defer func() { _ = recover() }() // A broken writer must not kill the runner.
	_ = json.NewEncoder(p.writer).Encode(p.event)
}

// Emit observes a phase without waiting for the history lock or stdout.
func Emit(op, stage, status string, start time.Time, ids IDs) {
	e := Event{Op: op, Stage: stage, Status: status, DurMS: time.Since(start).Milliseconds(), IDs: ids}
	if ids.BoxID != "" {
		history.append(&e)
	}
	writer := *process.writer.Load()
	if writer == nil {
		return
	}
	if e.TS == "" {
		e.TS = time.Now().UTC().Format(time.RFC3339Nano)
	}
	p := pending{event: e, writer: writer}
	select {
	case process.queue <- p:
	default:
	}
}

// SetWriterForTest replaces the sink for future events and returns a restore
// function. Queued events retain the sink they were emitted to.
func SetWriterForTest(w io.Writer) (restore func()) {
	previous := process.writer.Swap(&w)
	return func() { process.writer.Store(previous) }
}

func Status(err error) string {
	if err != nil {
		return Error
	}
	return OK
}

type jobIDKey struct{}
type receivedKey struct{}
type destroySkippedKey struct{}

// WithDestroySkipped carries the timing outcome of a synchronous delete without
// changing its error result (deleting an already absent box succeeds).
func WithDestroySkipped(ctx context.Context) (context.Context, *bool) {
	skipped := new(bool)
	return context.WithValue(ctx, destroySkippedKey{}, skipped), skipped
}

func MarkDestroySkipped(ctx context.Context) {
	if skipped, ok := ctx.Value(destroySkippedKey{}).(*bool); ok {
		*skipped = true
	}
}

func WithJobID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, jobIDKey{}, id)
}

func JobID(ctx context.Context) string {
	id, _ := ctx.Value(jobIDKey{}).(string)
	return id
}

func WithReceipt(ctx context.Context, at time.Time) context.Context {
	return context.WithValue(ctx, receivedKey{}, at)
}

func ReceiptOr(ctx context.Context, fallback time.Time) time.Time {
	if at, ok := ctx.Value(receivedKey{}).(time.Time); ok {
		return at
	}
	return fallback
}

type stdoutWriter struct {
	write       func([]byte) (int, error)
	partialLine bool
}

func (w *stdoutWriter) Write(p []byte) (int, error) {
	if w.partialLine {
		return 0, io.ErrShortWrite
	}
	n := 0
	for n < len(p) {
		written, err := w.write(p[n:])
		if written > 0 {
			n += written
		}
		if err != nil || written <= 0 {
			// An unfinished line cannot be rolled back on stdout. Disable
			// this sink rather than append another event to that fragment.
			w.partialLine = n > 0 && n < len(p)
			if err == nil {
				err = io.ErrShortWrite
			}
			return n, err
		}
	}
	return n, nil
}

func writeStdout(p []byte) (n int, err error) {
	// os.Stdout.Write can terminate the process on EPIPE. Write to the same
	// fd without os.File's special SIGPIPE behavior for stdout/stderr.
	raw, err := os.Stdout.SyscallConn()
	if err != nil {
		return 0, err
	}
	if controlErr := raw.Control(func(fd uintptr) {
		n, err = syscall.Write(int(fd), p)
	}); controlErr != nil {
		return 0, controlErr
	}
	return n, err
}

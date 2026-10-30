// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

// Package tcprelay forwards streams while preserving TCP half-close semantics.
package tcprelay

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

const HalfCloseIdleTimeout = 10 * time.Minute

// Relay owns and closes both connections, and returns after both copy workers
// finish. Clean EOF closes only the destination's write side. After the first
// EOF, ten minutes without a successful payload write closes both peers;
// fully open streams have no idle limit. Errors and cancellation close immediately.
// Connections must honor net.Conn's contract that Close unblocks pending I/O.
func Relay(ctx context.Context, left, right net.Conn) error {
	closeBoth := func() { _ = left.Close(); _ = right.Close() }
	defer closeBoth()
	activity := &idleActivity{}
	halfClosed := make(chan struct{}, 1)
	results := make(chan error, 2)
	copyStream := func(dst, src net.Conn) {
		// Wrap the writer so ReaderFrom/WriterTo cannot bypass progress tracking.
		_, err := io.Copy(progressWriter{dst, activity}, src)
		if err == nil {
			if activity.beginHalfClose() {
				halfClosed <- struct{}{}
			}
			// Announce EOF first: a blocked CloseWrite also needs the idle bound.
			err = closeWrite(dst)
		}
		results <- err
	}
	go copyStream(left, right)
	go copyStream(right, left)

	var timer *time.Timer
	var timeout <-chan time.Time
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	ctxDone := ctx.Done()
	var result error
	remaining := 2
	abort := func(err error) {
		if result == nil {
			result = err
		}
		closeBoth()
		ctxDone, timeout = nil, nil
	}
	for remaining > 0 {
		select {
		case <-ctxDone:
			abort(ctx.Err())
		case <-halfClosed:
			if result == nil {
				timer = time.NewTimer(activity.remaining())
				timeout = timer.C
			}
		case <-timeout:
			if wait := activity.remaining(); wait > 0 {
				timer.Reset(wait)
			} else {
				abort(fmt.Errorf("half-closed relay idle for %s: %w", HalfCloseIdleTimeout, context.DeadlineExceeded))
			}
		case err := <-results:
			remaining--
			if err != nil {
				abort(err)
			}
		}
	}
	return result
}

func closeWrite(conn net.Conn) error {
	if writer, ok := conn.(interface{ CloseWrite() error }); ok {
		if err := writer.CloseWrite(); !errors.Is(err, errors.ErrUnsupported) {
			return err
		}
	}
	return conn.Close()
}

type idleActivity struct {
	mu           sync.Mutex
	halfClosed   bool
	expired      bool
	lastProgress time.Time
}

func (a *idleActivity) beginHalfClose() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.halfClosed {
		return false
	}
	a.halfClosed = true
	a.lastProgress = time.Now()
	return true
}

// Serialize expiry with completed writes. Once expired, later write completion
// cannot reopen the stream; before expiry, progress extends the same idle window.
func (a *idleActivity) remaining() time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	wait := HalfCloseIdleTimeout - time.Since(a.lastProgress)
	if wait <= 0 {
		a.expired = true
	}
	return wait
}

type progressWriter struct {
	io.Writer
	activity *idleActivity
}

func (w progressWriter) Write(p []byte) (int, error) {
	n, err := w.Writer.Write(p)
	if n > 0 {
		w.activity.mu.Lock()
		if !w.activity.expired {
			w.activity.lastProgress = time.Now()
		}
		w.activity.mu.Unlock()
	}
	return n, err
}

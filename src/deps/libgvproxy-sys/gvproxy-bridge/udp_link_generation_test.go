package main

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func TestGuestLinkDropsSealedReplyQueuedBehindAnUnmarkedFrame(t *testing.T) {
	inner, guest := net.Pipe()
	link := newShapedConn(inner, 0, &RateLimitConfig{RX: bucketCfg(65536, 100)}, nil)
	t.Cleanup(func() { _ = link.Close(); _ = guest.Close() })
	old := newUDPLinkGeneration()

	send := func(frame string, generation *udpLinkGeneration) {
		t.Helper()
		if generation == nil {
			if _, err := link.Write([]byte(frame)); err != nil {
				t.Fatal(err)
			}
			return
		}
		if _, err := link.WriteGuestFrame([]byte(frame), generation); err != nil {
			t.Fatal(err)
		}
	}
	send("first", nil)
	send("stale", old)
	old.seal()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := old.wait(ctx); err != nil {
		t.Fatalf("sealed queue became a write in progress: %v", err)
	}
	send("local", nil)
	_ = guest.SetReadDeadline(time.Now().Add(time.Second))
	data := make([]byte, len("firstlocal"))
	if _, err := io.ReadFull(guest, data); err != nil || string(data) != "firstlocal" {
		t.Fatalf("guest read %q, error %v", data, err)
	}
	if got := link.stats.rxDroppedFrames.Load(); got != 1 {
		t.Fatalf("dropped %d frames, want one", got)
	}
}

func TestGuestLinkPartialWritePreventsGenerationConfirmation(t *testing.T) {
	inner, guest := net.Pipe()
	link, ok := wrapGuestConn(inner, 4, nil, true).(*shapedConn)
	if !ok {
		t.Fatal("unlimited managed QEMU link discarded the frame owner")
	}
	t.Cleanup(func() { _ = link.Close(); _ = guest.Close() })
	generation := newUDPLinkGeneration()
	payload := []byte("complete frame")
	frame := binary.BigEndian.AppendUint32(nil, uint32(len(payload)))
	frame = append(frame, payload...)
	type writeResult struct {
		accepted int
		err      error
	}
	written := make(chan writeResult, 1)
	go func() {
		accepted, err := link.WriteGuestFrame(frame, generation)
		written <- writeResult{accepted, err}
	}()
	_ = guest.SetReadDeadline(time.Now().Add(time.Second))
	header := make([]byte, 4)
	if _, err := io.ReadFull(guest, header); err != nil {
		t.Fatal(err)
	}
	if got := binary.BigEndian.Uint32(header); got != uint32(len(payload)) {
		t.Fatalf("declared payload length = %d, want %d", got, len(payload))
	}
	generation.seal()
	blocked, cancelBlocked := context.WithCancel(context.Background())
	cancelBlocked()
	if err := generation.wait(blocked); !errors.Is(err, context.Canceled) {
		t.Fatalf("old generation unexpectedly drained: %v", err)
	}
	// Close owns the guest-link socket and must interrupt the write even
	// while the peer refuses to read the rest of the frame.
	_ = link.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := generation.wait(ctx); !errors.Is(err, errUDPGuestLinkUncertain) {
		t.Fatalf("partial frame allowed confirmation: %v", err)
	}
	select {
	case result := <-written:
		if result.err == nil || result.accepted != len(header) {
			t.Fatalf("partial write accepted %d bytes with error %v", result.accepted, result.err)
		}
	case <-ctx.Done():
		t.Fatal("closing the guest link did not interrupt its write")
	}
}

func TestGuestLinkDropsSealedVFKitDatagramWithoutRateLimit(t *testing.T) {
	inner, guest := net.Pipe()
	t.Cleanup(func() { _ = inner.Close(); _ = guest.Close() })
	link, ok := wrapGuestConn(inner, 0, nil, true).(*shapedConn)
	if !ok {
		t.Fatal("unlimited managed VFKit link discarded the frame owner")
	}
	t.Cleanup(func() { _ = link.Close() })
	if err := link.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	old := newUDPLinkGeneration()
	old.seal()
	frame := []byte("stale datagram")
	if n, err := link.WriteGuestFrame(frame, old); err != nil || n != len(frame) {
		t.Fatalf("sealed datagram reached the blocking guest socket: %d, %v", n, err)
	}
}

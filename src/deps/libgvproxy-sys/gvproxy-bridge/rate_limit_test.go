package main

import (
	"bytes"
	"io"
	"net"
	"testing"
	"time"
)

func u64ptr(v uint64) *uint64 { return &v }

func TestNewNetRateLimiter(t *testing.T) {
	if newNetRateLimiter(nil) != nil {
		t.Fatal("nil config should yield a nil limiter")
	}
	zero := uint64(0)
	if newNetRateLimiter(&RateLimitConfig{UploadBytesPerSec: &zero, DownloadBytesPerSec: &zero}) != nil {
		t.Fatal("all-zero config should yield a nil limiter")
	}
	if newNetRateLimiter(&RateLimitConfig{UploadBytesPerSec: u64ptr(1000)}) == nil {
		t.Fatal("upload-only config should yield a limiter")
	}
	if newNetRateLimiter(&RateLimitConfig{DownloadBytesPerSec: u64ptr(1000)}) == nil {
		t.Fatal("download-only config should yield a limiter")
	}
}

func TestLimiterFor(t *testing.T) {
	if limiterFor(nil) != nil {
		t.Fatal("nil rate should be unlimited")
	}
	zero := uint64(0)
	if limiterFor(&zero) != nil {
		t.Fatal("0 rate should be unlimited")
	}
	if limiterFor(u64ptr(1000)) == nil {
		t.Fatal("positive rate should yield a limiter")
	}
}

// TestThrottledConnShapesRead proves the download (read) bucket actually shapes
// traffic: net.Pipe is in-memory and effectively unbounded, so the limiter is
// the only bottleneck. 2 MiB at 1 MiB/s with a 1 MiB burst ≈ 1 s.
func TestThrottledConnShapesRead(t *testing.T) {
	const bytesPerSec = 1 << 20 // 1 MiB/s
	const total = 2 << 20       // 2 MiB

	client, server := net.Pipe()
	defer server.Close()
	limited := throttleConn(server, limiterFor(u64ptr(bytesPerSec)), nil)

	go func() {
		defer client.Close()
		_, _ = io.CopyN(client, bytes.NewReader(make([]byte, total)), int64(total))
	}()

	start := time.Now()
	n, err := io.Copy(io.Discard, limited)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}
	if n != total {
		t.Fatalf("copied %d bytes, want %d", n, total)
	}
	if elapsed < 500*time.Millisecond {
		t.Fatalf("read was not throttled: %d bytes in %v", n, elapsed)
	}
}

// TestThrottledConnShapesWrite proves the upload (write) bucket actually shapes
// traffic, independently of the read direction.
func TestThrottledConnShapesWrite(t *testing.T) {
	const bytesPerSec = 1 << 20
	const total = 2 << 20

	client, server := net.Pipe()
	defer server.Close()
	limited := throttleConn(client, nil, limiterFor(u64ptr(bytesPerSec)))

	go func() {
		defer server.Close()
		_, _ = io.Copy(io.Discard, server)
	}()

	start := time.Now()
	n, err := io.Copy(limited, bytes.NewReader(make([]byte, total)))
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}
	if n != total {
		t.Fatalf("copied %d bytes, want %d", n, total)
	}
	if elapsed < 500*time.Millisecond {
		t.Fatalf("write was not throttled: %d bytes in %v", n, elapsed)
	}
}

// TestThrottledConnUnlimitedPassesThrough guards the no-op path: with no limit,
// the same transfer completes at in-memory speed.
func TestThrottledConnUnlimitedPassesThrough(t *testing.T) {
	const total = 1 << 20 // 1 MiB

	client, server := net.Pipe()
	defer server.Close()
	limited := throttleConn(server, nil, nil)

	go func() {
		defer client.Close()
		_, _ = io.CopyN(client, bytes.NewReader(make([]byte, total)), int64(total))
	}()

	start := time.Now()
	n, err := io.Copy(io.Discard, limited)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}
	if n != total {
		t.Fatalf("copied %d bytes, want %d", n, total)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("unlimited transfer should be fast, took %v", elapsed)
	}
}

// TestThrottleInboundShapesReadAsUpload proves throttleInbound maps upload to
// the read direction: with only the upload bucket set, reads are throttled
// while writes pass through. If the mapping were inverted (upload → write),
// this test would not throttle.
func TestThrottleInboundShapesReadAsUpload(t *testing.T) {
	const bytesPerSec = 1 << 20 // 1 MiB/s
	const total = 2 << 20       // 2 MiB

	rl := &netRateLimiter{upload: limiterFor(u64ptr(bytesPerSec))}
	client, server := net.Pipe()
	defer server.Close()
	limited := rl.throttleInbound(server)

	go func() {
		defer client.Close()
		_, _ = io.CopyN(client, bytes.NewReader(make([]byte, total)), int64(total))
	}()

	start := time.Now()
	n, err := io.Copy(io.Discard, limited)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}
	if n != total {
		t.Fatalf("copied %d bytes, want %d", n, total)
	}
	if elapsed < 500*time.Millisecond {
		t.Fatalf("read was not throttled by the upload bucket: %d bytes in %v", n, elapsed)
	}
}

// TestThrottleInboundShapesWriteAsDownload proves throttleInbound maps download
// to the write direction: with only the download bucket set, writes are
// throttled while reads pass through.
func TestThrottleInboundShapesWriteAsDownload(t *testing.T) {
	const bytesPerSec = 1 << 20
	const total = 2 << 20

	rl := &netRateLimiter{download: limiterFor(u64ptr(bytesPerSec))}
	client, server := net.Pipe()
	defer server.Close()
	limited := rl.throttleInbound(client)

	go func() {
		defer server.Close()
		_, _ = io.Copy(io.Discard, server)
	}()

	start := time.Now()
	n, err := io.Copy(limited, bytes.NewReader(make([]byte, total)))
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}
	if n != total {
		t.Fatalf("copied %d bytes, want %d", n, total)
	}
	if elapsed < 500*time.Millisecond {
		t.Fatalf("write was not throttled by the download bucket: %d bytes in %v", n, elapsed)
	}
}

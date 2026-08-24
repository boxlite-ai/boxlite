package main

// rate_limit.go — per-direction network I/O rate limiting (token buckets).
//
// Enforced in the gvproxy transport relay, mirroring Firecracker/cloud-hypervisor's
// userspace token bucket at the virtio boundary. Two independent buckets:
//   - upload   (guest → internet)
//   - download (internet → guest)
//
// `golang.org/x/time/rate.Limiter` is the battle-tested token bucket. A nil
// bucket (or a nil/zero config) means "no limit" for that direction.

import (
	"context"
	"net"

	"golang.org/x/time/rate"
)

// minBurstBytes is the token-bucket burst floor. io.Copy relays in ~32 KiB
// chunks, so a burst must never fall below that or a single chunk would exceed
// the bucket and fail to forward. Sustained rate is still the configured limit;
// burst only bounds how much may go out instantly before throttling kicks in.
const minBurstBytes = 64 * 1024

// netRateLimiter holds the two independent token buckets for a box's network
// I/O. Created once per gvproxy instance from the box's config.
type netRateLimiter struct {
	upload   *rate.Limiter // guest → internet
	download *rate.Limiter // internet → guest
}

// newNetRateLimiter builds the limiter from config, or returns nil when neither
// direction is limited.
func newNetRateLimiter(cfg *RateLimitConfig) *netRateLimiter {
	if cfg == nil {
		return nil
	}
	up := limiterFor(cfg.UploadBytesPerSec)
	down := limiterFor(cfg.DownloadBytesPerSec)
	if up == nil && down == nil {
		return nil
	}
	return &netRateLimiter{upload: up, download: down}
}

// limiterFor returns a token bucket for a bytes/sec rate, or nil for unlimited
// (nil pointer or 0). Burst is one second of tokens (the standard default),
// floored at minBurstBytes.
func limiterFor(bytesPerSec *uint64) *rate.Limiter {
	if bytesPerSec == nil || *bytesPerSec == 0 {
		return nil
	}
	burst := int(*bytesPerSec)
	if burst < minBurstBytes {
		burst = minBurstBytes
	}
	return rate.NewLimiter(rate.Limit(*bytesPerSec), burst)
}

// throttleInbound wraps the guest-side conn so that reads (upload, guest →
// internet) and writes (download, internet → guest) are shaped by the matching
// bucket. A nil receiver is a no-op; a nil bucket in one direction leaves that
// direction unthrottled.
//
// This is the single choke point that covers every TCP relay path — standard
// forward, allowlist inspection, and MITM/WebSocket secret substitution —
// because all of them read/write the same guest conn. Wrapping here (instead of
// the internet-side conn) keeps `outbound` a bare *net.TCPConn, so tcpproxy's
// keep-alive / splice optimizations keep working.
func (rl *netRateLimiter) throttleInbound(c net.Conn) net.Conn {
	if rl == nil {
		return c
	}
	return throttleConn(c, rl.upload, rl.download)
}

// throttleConn wraps a net.Conn, throttling reads through `readLimiter`
// (download) and writes through `writeLimiter` (upload). Nil limiters pass
// through untouched.
func throttleConn(c net.Conn, readLimiter, writeLimiter *rate.Limiter) net.Conn {
	if readLimiter == nil && writeLimiter == nil {
		return c
	}
	return &throttledConn{Conn: c, readLimiter: readLimiter, writeLimiter: writeLimiter}
}

// waitN consumes n tokens from the limiter, chunking so a single call never
// exceeds the bucket burst (rate.Limiter.WaitN errors when n > burst, e.g. a
// 2 MiB write against a 1 MiB burst).
func waitN(l *rate.Limiter, n int) error {
	for n > 0 {
		chunk := n
		if chunk > minBurstBytes {
			chunk = minBurstBytes
		}
		if err := l.WaitN(context.Background(), chunk); err != nil {
			return err
		}
		n -= chunk
	}
	return nil
}

type throttledConn struct {
	net.Conn
	readLimiter  *rate.Limiter
	writeLimiter *rate.Limiter
}

func (c *throttledConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 && c.readLimiter != nil {
		// Best-effort: never fail the conn on a limiter error.
		_ = waitN(c.readLimiter, n)
	}
	return n, err
}

func (c *throttledConn) Write(p []byte) (int, error) {
	if c.writeLimiter != nil {
		if err := waitN(c.writeLimiter, len(p)); err != nil {
			return 0, err
		}
	}
	return c.Conn.Write(p)
}

package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// A shaper can only ever be too slow, never too fast: CI load, GC pauses and
// scheduler noise all push measured throughput down, never up. So no test here
// asserts a two-sided band. Where the failure mode is "did not limit at all" we
// assert the floor; where it is "let too much through" we assert the ceiling;
// never both on the same measurement.
//
// Almost everything below avoids the clock entirely instead, by driving
// tokenBucket through an injected `now` and asserting exact durations.
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// fakeConn is a net.Conn whose Write behaviour each test dictates. net.Pipe
// cannot stand in for it: a pipe never returns ENOBUFS, and its synchronous
// Write cannot be made to block independently of a reader.
type fakeConn struct {
	net.Conn
	writeFn   func(p []byte) (int, error)
	closed    atomic.Bool
	closeOnce sync.Once
	closeCh   chan struct{}
	mu        sync.Mutex
	written   [][]byte
}

func newFakeConn(writeFn func(p []byte) (int, error)) *fakeConn {
	return &fakeConn{writeFn: writeFn, closeCh: make(chan struct{})}
}

func (f *fakeConn) Write(p []byte) (int, error) {
	if f.writeFn != nil {
		n, err := f.writeFn(p)
		if err == nil {
			f.mu.Lock()
			f.written = append(f.written, append([]byte(nil), p...))
			f.mu.Unlock()
		}
		return n, err
	}
	f.mu.Lock()
	f.written = append(f.written, append([]byte(nil), p...))
	f.mu.Unlock()
	return len(p), nil
}

func (f *fakeConn) Read(p []byte) (int, error) { <-f.closeCh; return 0, io.EOF }

func (f *fakeConn) Close() error {
	f.closeOnce.Do(func() {
		f.closed.Store(true)
		close(f.closeCh)
	})
	return nil
}

func (f *fakeConn) frames() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]byte(nil), f.written...)
}

// qemuFrame prefixes a body with the 4-byte big-endian length tap.Switch uses
// for the qemu protocol.
func qemuFrame(body []byte) []byte {
	out := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(out[:4], uint32(len(body)))
	copy(out[4:], body)
	return out
}

func bucketCfg(size, refillMs int64) *TokenBucketConfig {
	return &TokenBucketConfig{Size: size, RefillTimeMs: refillMs}
}

// ---------------------------------------------------------------------------
// tier 1: token bucket against an injected clock, exact equality
// ---------------------------------------------------------------------------
func TestBucketReserveReturnsExactDeficitWait(t *testing.T) {
	clk := newFakeClock()
	// Capacity is floored to maxFrameBytes, but the rate must stay the
	// configured one: 100000 B per 1000 ms.
	b := newTokenBucket(bucketCfg(100000, 1000), clk.now)
	if got := b.reserve(b.capacity); got != 0 {
		t.Fatalf("draining a full bucket should not wait, got %v", got)
	}
	// 50000 bytes of deficit at 100000 B/s is exactly 500ms.
	if got := b.reserve(50000); got != 500*time.Millisecond {
		t.Fatalf("reserve wait = %v, want 500ms", got)
	}
	clk.advance(500 * time.Millisecond)
	if got := b.waitNonNegative(); got != 0 {
		t.Fatalf("after sleeping off the deficit the wait should be 0, got %v", got)
	}
}

// The capacity floor must not become a rate increase. A box configured well
// below maxFrameBytes still gets its configured bytes per second; only its
// burst is raised.
func TestBucketCapacityFloorDoesNotChangeTheRate(t *testing.T) {
	clk := newFakeClock()
	b := newTokenBucket(bucketCfg(1000, 1000), clk.now) // 1000 B/s
	if b.capacity != maxFrameBytes {
		t.Fatalf("capacity = %d, want it floored to %d", b.capacity, maxFrameBytes)
	}
	b.reserve(b.capacity) // drain
	// 2000 bytes at the configured 1000 B/s is 2s — not 2000/65550 s, which is
	// what deriving the rate from the floored capacity would have produced.
	if got := b.reserve(2000); got != 2*time.Second {
		t.Fatalf("reserve wait = %v, want 2s (rate must come from the config, not the floor)", got)
	}
}

func TestBucketOneTimeBurstIsSpentFirstAndNeverRefilled(t *testing.T) {
	clk := newFakeClock()
	cfg := bucketCfg(1000, 1000)
	cfg.OneTimeBurst = 5000
	b := newTokenBucket(cfg, clk.now)
	// The burst absorbs the charge, leaving the sustained tokens untouched.
	before := b.tokens
	if got := b.reserve(5000); got != 0 {
		t.Fatalf("one-time burst should absorb the charge, got wait %v", got)
	}
	if b.tokens != before {
		t.Fatalf("sustained tokens = %d, want them untouched at %d", b.tokens, before)
	}
	if b.oneTime != 0 {
		t.Fatalf("one-time burst = %d, want it fully spent", b.oneTime)
	}
	// Refilling never restores it.
	clk.advance(time.Hour)
	b.reserve(0)
	if b.oneTime != 0 {
		t.Fatalf("one-time burst = %d after refill, want it to stay spent", b.oneTime)
	}
}

func TestBucketRefillClampsAtCapacity(t *testing.T) {
	clk := newFakeClock()
	b := newTokenBucket(bucketCfg(100000, 1000), clk.now)
	b.reserve(b.capacity)
	clk.advance(10 * time.Second) // ten refill periods
	b.reserve(0)
	if b.tokens != b.capacity {
		t.Fatalf("tokens = %d after a long idle, want them clamped to capacity %d", b.tokens, b.capacity)
	}
}

// Sub-token calls must not discard the elapsed remainder, or a fast caller
// could starve the bucket forever.
func TestBucketKeepsSubTokenRemainder(t *testing.T) {
	clk := newFakeClock()
	b := newTokenBucket(bucketCfg(1000, 1000), clk.now) // 1 token per ms
	b.reserve(b.capacity)
	for i := 0; i < 100; i++ {
		clk.advance(100 * time.Microsecond) // a tenth of a token each
		b.reserve(0)
	}
	// 100 * 100us = 10ms of accrual = 10 tokens.
	if b.tokens != 10 {
		t.Fatalf("tokens = %d, want 10 (sub-token remainders must accumulate)", b.tokens)
	}
}

func TestRateLimitConfigValidateRejectsBadInput(t *testing.T) {
	for name, cfg := range map[string]*RateLimitConfig{
		"zero refill":     {TX: &TokenBucketConfig{Size: 1000, RefillTimeMs: 0}},
		"negative refill": {TX: &TokenBucketConfig{Size: 1000, RefillTimeMs: -1}},
		"negative burst":  {RX: &TokenBucketConfig{Size: 1000, RefillTimeMs: 100, OneTimeBurst: -1}},
		"size overflow":   {RX: &TokenBucketConfig{Size: 1 << 62, RefillTimeMs: 100}},
	} {
		if err := cfg.Validate(); err == nil {
			t.Errorf("%s: Validate() = nil, want an error", name)
		}
	}
	// Unlimited in either shape is valid and must not be rejected.
	for name, cfg := range map[string]*RateLimitConfig{
		"nil config":    nil,
		"both nil":      {},
		"zero size":     {TX: &TokenBucketConfig{Size: 0}},
		"one direction": {TX: bucketCfg(1000, 100)},
	} {
		if err := cfg.Validate(); err != nil {
			t.Errorf("%s: Validate() = %v, want nil", name, err)
		}
	}
}

// ---------------------------------------------------------------------------
// tier 2: framer, pure and exhaustive
// ---------------------------------------------------------------------------
// Splitting the same stream at every possible offset is the highest-value test
// here: the accounting must not depend on how the reads happen to land.
func TestFramerConsumeSplitAtEveryOffset(t *testing.T) {
	bodies := [][]byte{
		bytes.Repeat([]byte{0xAA}, 60),
		bytes.Repeat([]byte{0xBB}, 1514),
		bytes.Repeat([]byte{0xCC}, 65549),
	}
	var stream []byte
	wantBytes := 0
	for _, b := range bodies {
		stream = append(stream, qemuFrame(b)...)
		wantBytes += len(b)
	}
	for split := 1; split < len(stream); split++ {
		f := &framer{hdrLen: 4}
		gotBytes, gotFrames := 0, 0
		for i := 0; i < len(stream); i += split {
			end := i + split
			if end > len(stream) {
				end = len(stream)
			}
			fb, fr := f.consume(stream[i:end])
			gotBytes += fb
			gotFrames += fr
		}
		if gotBytes != wantBytes {
			t.Fatalf("split %d: frameBytes = %d, want %d", split, gotBytes, wantBytes)
		}
		if gotFrames != len(bodies) {
			t.Fatalf("split %d: frames = %d, want %d", split, gotFrames, len(bodies))
		}
	}
}

// The whole point of the framer: length prefixes are not billed. Charging raw
// socket bytes would bill 4 extra per frame on Linux and none on macOS.
func TestFramerExcludesTheLengthPrefixFromTheCharge(t *testing.T) {
	body := bytes.Repeat([]byte{0x01}, 66) // a bare TCP ACK
	f := &framer{hdrLen: 4}
	frameBytes, frames := f.consume(qemuFrame(body))
	if frameBytes != len(body) {
		t.Fatalf("frameBytes = %d, want %d (the 4-byte prefix must not be charged)", frameBytes, len(body))
	}
	if frames != 1 {
		t.Fatalf("frames = %d, want 1", frames)
	}
}

func TestFramerZeroHeaderIsPassthrough(t *testing.T) {
	f := &framer{hdrLen: 0}
	buf := bytes.Repeat([]byte{0x02}, 1500)
	frameBytes, frames := f.consume(buf)
	if frameBytes != len(buf) || frames != 1 {
		t.Fatalf("consume = (%d, %d), want (%d, 1)", frameBytes, frames, len(buf))
	}
}

// hdrLen is a parameter, not a constant: hyperkit uses a 2-byte little-endian
// prefix. A hardcoded 4 would decode garbage here.
func TestFramerHandlesHyperkitTwoByteHeader(t *testing.T) {
	body := bytes.Repeat([]byte{0x03}, 300)
	frame := make([]byte, 2+len(body))
	binary.LittleEndian.PutUint16(frame[:2], uint16(len(body)))
	copy(frame[2:], body)
	f := &framer{hdrLen: 2}
	frameBytes, frames := f.consume(frame)
	if frameBytes != len(body) || frames != 1 {
		t.Fatalf("consume = (%d, %d), want (%d, 1)", frameBytes, frames, len(body))
	}
}

// ---------------------------------------------------------------------------
// tier 3: shapedConn invariants
// ---------------------------------------------------------------------------
func TestUnlimitedConfigReturnsUnwrappedConn(t *testing.T) {
	c := newFakeConn(nil)
	for name, cfg := range map[string]*RateLimitConfig{
		"nil":       nil,
		"empty":     {},
		"zero size": {TX: &TokenBucketConfig{Size: 0}, RX: &TokenBucketConfig{Size: 0}},
	} {
		if got := wrapConn(c, 4, cfg); got != net.Conn(c) {
			t.Errorf("%s: wrapConn returned a wrapper, want the conn untouched", name)
		}
	}
}

// Guards pkg/tap/switch.go:119-124 (txPkt holds writeLock and connLock across
// the write) and :186 (any non-ENOBUFS error disconnects the VM). Write must
// therefore never block and never fail, whatever the inner conn does.
func TestRxWriteNeverBlocksAndNeverErrors(t *testing.T) {
	blocked := make(chan struct{})
	inner := newFakeConn(func(p []byte) (int, error) {
		<-blocked // never returns for the duration of the test
		return len(p), nil
	})
	defer close(blocked)
	cfg := &RateLimitConfig{RX: bucketCfg(1_000_000, 100)}
	c := newShapedConn(inner, 4, cfg, nil)
	defer c.Close()
	frame := qemuFrame(bytes.Repeat([]byte{0x04}, 1500))
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 10000; i++ {
			n, err := c.Write(frame)
			if err != nil {
				t.Errorf("Write returned error %v; txBuf would disconnect the VM", err)
				return
			}
			if n != len(frame) {
				t.Errorf("Write returned n = %d, want %d", n, len(frame))
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("10000 writes did not complete; Write must never block")
	}
}

// The regression test for the deadlock described on Close: closing runs with the
// switch's writeLock held, so it must not wait for a pacer that may be parked
// inside Conn.Write.
func TestCloseDoesNotBlockWhilePacerIsWriting(t *testing.T) {
	var inner *fakeConn
	inner = newFakeConn(func(p []byte) (int, error) {
		<-inner.closeCh // unblocks only when the conn is closed
		return 0, net.ErrClosed
	})
	cfg := &RateLimitConfig{RX: bucketCfg(1_000_000, 100)}
	c := newShapedConn(inner, 4, cfg, nil)
	if _, err := c.Write(qemuFrame(bytes.Repeat([]byte{0x05}, 1500))); err != nil {
		t.Fatalf("Write: %v", err)
	}
	// Give the pacer a moment to pick the frame up and park in Write.
	time.Sleep(50 * time.Millisecond)
	done := make(chan struct{})
	go func() { _ = c.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close blocked on the pacer; with the switch's writeLock held this deadlocks every TX path")
	}
}

func TestRxQueueFullDropsAndCounts(t *testing.T) {
	blocked := make(chan struct{})
	inner := newFakeConn(func(p []byte) (int, error) {
		<-blocked
		return len(p), nil
	})
	defer close(blocked)
	// Smallest queue the bounds allow: 2 * maxFrameBytes, 16 frames.
	cfg := &RateLimitConfig{RX: bucketCfg(1000, 1000)}
	c := newShapedConn(inner, 4, cfg, nil)
	defer c.Close()
	frame := qemuFrame(bytes.Repeat([]byte{0x06}, 1500))
	for i := 0; i < 200; i++ {
		if _, err := c.Write(frame); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}
	got := c.stats.snapshot()
	if got.RxDroppedFrames == 0 {
		t.Fatal("no frames dropped; a bounded queue must shed load once full")
	}
	if got.RxDroppedBytes == 0 {
		t.Fatal("dropped bytes not counted")
	}
}

func TestRxPacerRetriesOnENOBUFS(t *testing.T) {
	var attempts atomic.Int64
	inner := newFakeConn(func(p []byte) (int, error) {
		if attempts.Add(1) <= 3 {
			return 0, syscall.ENOBUFS
		}
		return len(p), nil
	})
	cfg := &RateLimitConfig{RX: bucketCfg(1_000_000, 100)}
	c := newShapedConn(inner, 4, cfg, nil)
	defer c.Close()
	body := bytes.Repeat([]byte{0x07}, 1500)
	frame := qemuFrame(body)
	if _, err := c.Write(frame); err != nil {
		t.Fatalf("Write: %v", err)
	}
	deadline := time.After(2 * time.Second)
	for {
		if written := inner.frames(); len(written) == 1 {
			if !bytes.Equal(written[0], frame) {
				t.Fatal("frame was altered across the ENOBUFS retries")
			}
			break
		}
		select {
		case <-deadline:
			t.Fatalf("frame never delivered after ENOBUFS; attempts = %d", attempts.Load())
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
	if attempts.Load() < 4 {
		t.Fatalf("attempts = %d, want the write retried past the ENOBUFS runs", attempts.Load())
	}
}

func TestRxPacerClosesConnOnOtherWriteError(t *testing.T) {
	inner := newFakeConn(func(p []byte) (int, error) { return 0, io.ErrClosedPipe })
	cfg := &RateLimitConfig{RX: bucketCfg(1_000_000, 100)}
	c := newShapedConn(inner, 4, cfg, nil)
	defer c.Close()
	if _, err := c.Write(qemuFrame(bytes.Repeat([]byte{0x08}, 1500))); err != nil {
		t.Fatalf("Write: %v", err)
	}
	deadline := time.After(2 * time.Second)
	for !inner.closed.Load() {
		select {
		case <-deadline:
			t.Fatal("pacer did not close the inner conn; rxStream would never unwind and the switch would leak the connection")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
}

func TestFramesSurviveShapingIntactAndInOrder(t *testing.T) {
	inner := newFakeConn(nil)
	cfg := &RateLimitConfig{RX: bucketCfg(100_000_000, 100)} // generous
	c := newShapedConn(inner, 4, cfg, nil)
	defer c.Close()
	const count = 100
	want := make([][]byte, count)
	for i := 0; i < count; i++ {
		body := bytes.Repeat([]byte{byte(i)}, 100+i)
		want[i] = qemuFrame(body)
		if _, err := c.Write(want[i]); err != nil {
			t.Fatalf("Write %d: %v", i, err)
		}
	}
	deadline := time.After(5 * time.Second)
	for len(inner.frames()) < count {
		select {
		case <-deadline:
			t.Fatalf("only %d of %d frames delivered", len(inner.frames()), count)
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
	got := inner.frames()
	for i := range want {
		if !bytes.Equal(got[i], want[i]) {
			t.Fatalf("frame %d differs; the shaper must not reframe or reorder", i)
		}
	}
}

// TX shaping: assert the floor only. Load can only make this slower.
func TestTxShapingTakesAtLeastTheConfiguredTime(t *testing.T) {
	const rate = 64 * 1024 // bytes/sec
	const total = 256 * 1024
	server, client := net.Pipe()
	go func() {
		buf := bytes.Repeat([]byte{0x09}, 4096)
		for sent := 0; sent < total; sent += len(buf) {
			if _, err := server.Write(buf); err != nil {
				return
			}
		}
	}()
	defer server.Close()
	cfg := &RateLimitConfig{TX: bucketCfg(rate, 1000)}
	c := newShapedConn(client, 0, cfg, nil)
	defer c.Close()
	start := time.Now()
	buf := make([]byte, 4096)
	for read := 0; read < total; {
		n, err := c.Read(buf)
		if err != nil {
			t.Fatalf("Read: %v", err)
		}
		read += n
	}
	elapsed := time.Since(start)
	// Lower bound only. total/rate is 4s, minus a full bucket of free burst
	// (~1s), minus the final read: deficit charging bills after the fact, so
	// the last chunk's cost is never slept off. That puts the true minimum
	// near 2.94s. Floor the assertion below it — the failure this guards is
	// "not shaped at all", which would land near zero, so a wide margin costs
	// nothing and load can only push the measurement up.
	if min := 2500 * time.Millisecond; elapsed < min {
		t.Fatalf("elapsed = %v, want at least %v — TX was not shaped", elapsed, min)
	}
}

func TestQueueBoundsFloorAvoidsSecondsOfStandingQueue(t *testing.T) {
	// 1 Mbit/s. An eight-frame floor would be 512KiB here, over four seconds of
	// buffering; the small floor keeps latency usable and drops instead.
	queueBytes, queueFrames := queueBounds(bucketCfg(125_000, 1000))
	if queueBytes != 2*maxFrameBytes {
		t.Fatalf("queueBytes = %d, want the %d floor", queueBytes, 2*maxFrameBytes)
	}
	if queueFrames < 16 {
		t.Fatalf("queueFrames = %d, want at least 16", queueFrames)
	}
	// A fast link gets one refill period of buffering, capped at 4MiB.
	queueBytes, _ = queueBounds(bucketCfg(12_500_000, 1000)) // 100 Mbit/s
	if want := int64(1_250_000); queueBytes != want {
		t.Fatalf("queueBytes = %d, want %d (100ms of buffering)", queueBytes, want)
	}
	queueBytes, _ = queueBounds(bucketCfg(1_250_000_000, 1000)) // 10 Gbit/s
	if want := int64(4 << 20); queueBytes != want {
		t.Fatalf("queueBytes = %d, want it capped at %d", queueBytes, want)
	}
}

// End-to-end on the real switch: with a limit configured, wrapConn sits in the
// data path gvproxy_create builds, and ordinary forwarding must still work.
// This is an integration check, not a rate check — the pacing and drop
// behaviour is covered deterministically above.
func TestShapedConnDoesNotBreakForwarding(t *testing.T) {
	cfg := testGvproxyConfig()
	cfg.RateLimit = &RateLimitConfig{
		TX: bucketCfg(10_000_000, 1000),
		RX: bucketCfg(10_000_000, 1000),
	}
	tap := startNetworkWith(t, cfg)

	conn, port := listenUDP(t)
	defer conn.Close()

	payload := []byte("shaped-but-still-forwarded")
	tap.send(t, udpFrame(t, cfg.HostIP, port, payload))

	buf := make([]byte, 1024)
	if err := conn.SetReadDeadline(time.Now().Add(forwardWindow)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	n, _, err := conn.ReadFrom(buf)
	if err != nil {
		t.Fatalf("shaped conn broke UDP forwarding: %v", err)
	}
	if got := string(buf[:n]); got != string(payload) {
		t.Fatalf("payload = %q, want %q", got, payload)
	}
}

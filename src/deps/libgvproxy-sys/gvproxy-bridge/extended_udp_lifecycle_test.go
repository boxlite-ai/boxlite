package main

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

func TestExtendedUDPConcurrentAdmissionDeliversBothPackets(t *testing.T) {
	type miss struct {
		id     stack.TransportEndpointID
		packet *stack.PacketBuffer
	}
	misses := make(chan miss, 2)
	var forward udpTestHandler
	var received atomic.Uint64
	target, port := newUDPTestTarget(t)
	tap := startNetworkWithSeams(t, testGvproxyConfig(), networkSeams{
		tcp: &trustedTCPRules{}, dial: target.dial,
		wrapUDP: func(handler udpTestHandler) udpTestHandler {
			forward = handler
			return func(id stack.TransportEndpointID, packet *stack.PacketBuffer) bool {
				if received.Add(1) <= 2 {
					misses <- miss{id: id, packet: packet.IncRef()}
					return true
				}
				return handler(id, packet)
			}
		},
	})
	for _, value := range []string{"first", "second"} {
		tap.send(t, udpFrame(t, unlistedIP, port, []byte(value)))
	}

	var both [2]miss
	for index := range both {
		select {
		case both[index] = <-misses:
			defer both[index].packet.DecRef()
		case <-time.After(forwardWindow):
			t.Fatal("both guest packets must miss actual demux")
		}
	}
	if guestUDPEndpoint(t, tap, unlistedIP, guestSrcPort, port) != nil || both[0].id != both[1].id {
		t.Fatal("expected concurrent misses on the same unregistered tuple")
	}
	start := make(chan struct{})
	var workers sync.WaitGroup
	for _, item := range both {
		workers.Go(func() {
			<-start
			forward(item.id, item.packet)
		})
	}
	close(start)
	finished := make(chan struct{})
	go func() {
		workers.Wait()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(forwardWindow):
		t.Fatal("concurrent admissions deadlocked")
	}
	target.requireDial(t, "127.0.0.1", port)
	if err := target.conn.SetReadDeadline(time.Now().Add(forwardWindow)); err != nil {
		t.Fatal(err)
	}
	delivered := make(map[string]bool, 2)
	var peer string
	for range both {
		var buffer [32]byte
		n, source, err := target.conn.ReadFromUDP(buffer[:])
		if err != nil {
			t.Fatal(err)
		}
		if peer != "" && peer != source.String() {
			t.Fatal("different host sockets relayed the two datagrams")
		}
		peer = source.String()
		delivered[string(buffer[:n])] = true
	}
	if !delivered["first"] || !delivered["second"] || target.dials.Load() != 1 ||
		len(tap.policy.udpFlows.slots) != 1 || guestUDPEndpoint(t, tap, unlistedIP, guestSrcPort, port) == nil {
		t.Fatalf("concurrent datagrams = %v, dials = %d, slots = %d",
			delivered, target.dials.Load(), len(tap.policy.udpFlows.slots))
	}
}

func TestExtendedUDPReplacementPreservesOnlyEstablishedTuple(t *testing.T) {
	const idle = 420 * time.Millisecond
	target, port := newUDPTestTarget(t)
	cfg := testGvproxyConfig()
	tap := startNetworkWithSeams(t, cfg, networkSeams{
		tcp: &trustedTCPRules{}, dial: target.dial,
		configureUDP: func(pool *udpFlowPool) { pool.idleTimeout = idle },
	})
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("initial")))
	peer := target.receive(t, "initial")
	target.requireDial(t, "127.0.0.1", port)
	if err := tap.policy.replaceTrustedTCP("enabled", trustedTCPRules{deny: []string{unlistedIP}},
		cfg.OutboundRevision, "udp-denied"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(idle * 2 / 3)
	if _, err := target.conn.WriteToUDP([]byte("host renewal"), peer); err != nil {
		t.Fatal(err)
	}
	if got := string(readGuestUDP(t, tap, unlistedIP, port, guestSrcPort)); got != "host renewal" {
		t.Fatalf("guest received %q", got)
	}
	time.Sleep(idle * 2 / 3)
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("guest renewal")))
	target.receive(t, "guest renewal")
	time.Sleep(idle * 2 / 3)
	if _, err := target.conn.WriteToUDP([]byte("after guest renewal"), peer); err != nil {
		t.Fatal(err)
	}
	if got := string(readGuestUDP(t, tap, unlistedIP, port, guestSrcPort)); got != "after guest renewal" {
		t.Fatalf("guest received %q", got)
	}

	// The positive old-tuple traffic and the log barrier distinguish refusal
	// from a disabled link. The target stays readable across both denials.
	assertUDPPolicyDrop(t, tap, target, unlistedIP, guestSrcPort+1, port, outboundUserDeny)
	waitUDPCondition(t, "the original tuple's idle cleanup", func() bool {
		return guestUDPEndpoint(t, tap, unlistedIP, guestSrcPort, port) == nil && len(tap.policy.udpFlows.slots) == 0
	})
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("reopened tuple")))
	assertDatagramDropped(t, target.conn, "reopened tuple")
	if endpoint := guestUDPEndpoint(t, tap, unlistedIP, guestSrcPort, port); endpoint != nil || target.dials.Load() != 1 {
		t.Fatalf("reopened denied tuple: endpoint=%v dials=%d", endpoint, target.dials.Load())
	}
	for len(tap.frames) != 0 {
		if _, ok := guestUDPPayload(<-tap.frames, unlistedIP, port, guestSrcPort); ok {
			t.Fatal("guest received a reply for the reopened denied tuple")
		}
	}
}

func badUDPLength(frame []byte) []byte {
	ip := header.IPv4(frame[header.EthernetMinimumSize:])
	udp := header.UDP(ip.Payload())
	// The guest link advertises RX checksum offload. Length is always checked.
	udp.SetLength(udp.Length() + 1)
	return frame
}

func TestExtendedUDPSetupTimeoutAndBoxCancellation(t *testing.T) {
	for _, phase := range []string{"first-read", "dial", "relay"} {
		for _, cancelBox := range []bool{false, true} {
			if phase == "relay" && !cancelBox {
				continue // idle expiry is exercised with a policy replacement
			}
			name := phase + "-timeout"
			if cancelBox {
				name = phase + "-destroy"
			}
			t.Run(name, func(t *testing.T) {
				target, port := newUDPTestTarget(t)
				dialEntered := make(chan time.Time, 1)
				dialStopped := make(chan error, 1)
				hostClosed := make(chan struct{})
				dial := target.dial
				if phase == "dial" {
					dial = func(ctx context.Context, _, _ string) (net.Conn, error) {
						deadline, _ := ctx.Deadline()
						dialEntered <- deadline
						<-ctx.Done()
						dialStopped <- ctx.Err()
						return nil, ctx.Err()
					}
				}
				if phase == "relay" {
					dial = func(ctx context.Context, network, address string) (net.Conn, error) {
						host, err := target.dial(ctx, network, address)
						if err != nil {
							return nil, err
						}
						return &observedUDPConn{Conn: host, closed: hostClosed}, nil
					}
				}
				budget := 170 * time.Millisecond
				if cancelBox {
					budget = 30 * time.Second
				}
				tap := startNetworkWithSeams(t, testGvproxyConfig(), networkSeams{
					tcp: &trustedTCPRules{}, dial: dial,
					configureUDP: func(pool *udpFlowPool) { pool.setupTimeout = budget },
				})
				started := time.Now()
				frame := udpFrame(t, unlistedIP, port, []byte(phase))
				if phase == "first-read" {
					frame = badUDPLength(frame)
				}
				tap.send(t, frame)
				waitUDPCondition(t, "a pending or active UDP endpoint", func() bool {
					return len(tap.policy.udpFlows.slots) == 1 && guestUDPEndpoint(t, tap, unlistedIP, guestSrcPort, port) != nil
				})
				deadline := started.Add(budget)
				if phase == "dial" {
					select {
					case deadline = <-dialEntered:
					case <-time.After(forwardWindow):
						t.Fatal("UDP dial did not start")
					}
				}
				if phase == "relay" {
					target.echo(t, tap, unlistedIP, guestSrcPort, port, phase)
				}
				if cancelBox {
					if !time.Now().Before(deadline) {
						t.Fatal("setup deadline elapsed before Box cancellation")
					}
					tap.cancel()
				}
				waitUDPCondition(t, "slot and endpoint release", func() bool {
					return len(tap.policy.udpFlows.slots) == 0 && guestUDPEndpoint(t, tap, unlistedIP, guestSrcPort, port) == nil
				})
				if cancelBox && !time.Now().Before(deadline) {
					t.Fatal("resources outlived the original deadline")
				}
				if phase == "dial" {
					var want error = context.DeadlineExceeded
					if cancelBox {
						want = context.Canceled
					}
					if got := <-dialStopped; !errors.Is(got, want) {
						t.Fatalf("dial woke with %v, want %v", got, want)
					}
				}
				if phase == "first-read" && target.dials.Load() != 0 {
					t.Fatal("invalid first datagram opened a host socket")
				}
				if phase == "first-read" && tap.policy.stack.Stats().UDP.MalformedPacketsReceived.Value() != 1 {
					t.Fatal("the malformed packet did not reach UDP validation")
				}
				if phase == "relay" {
					select {
					case <-hostClosed:
					default:
						t.Fatal("relay slot released before closing the host socket")
					}
				}
			})
		}
	}
}

type observedUDPConn struct {
	net.Conn
	closeOnce sync.Once
	closed    chan struct{}
}

func (conn *observedUDPConn) Close() error {
	err := conn.Conn.Close()
	conn.closeOnce.Do(func() { close(conn.closed) })
	return err
}

func TestExtendedUDPSlotCapIncludesPendingDials(t *testing.T) {
	target, port := newUDPTestTarget(t)
	var attempts atomic.Uint64
	releaseFirst := make(chan struct{})
	tap := startNetworkWithSeams(t, testGvproxyConfig(), networkSeams{
		tcp: &trustedTCPRules{},
		dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
			if attempts.Add(1) == 1 {
				select {
				case <-releaseFirst:
					return nil, errors.New("test ended first dial")
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			<-ctx.Done()
			return nil, ctx.Err()
		},
	})
	for offset := range maxExtendedUDPFlows {
		tap.send(t, udpFrameFrom(t, testGvproxyConfig().GuestIP, unlistedIP, guestSrcPort+uint16(offset), port, []byte("pending")))
	}
	waitUDPCondition(t, "the full UDP pool", func() bool { return attempts.Load() == maxExtendedUDPFlows })
	const excess uint16 = guestSrcPort + maxExtendedUDPFlows
	assertUDPPolicyDrop(t, tap, target, unlistedIP, excess, port, "flow-capacity")
	if attempts.Load() != maxExtendedUDPFlows {
		t.Fatalf("attempts exceeded capacity: %d", attempts.Load())
	}
	close(releaseFirst)
	waitUDPCondition(t, "one free UDP slot", func() bool { return len(tap.policy.udpFlows.slots) == maxExtendedUDPFlows-1 })
	tap.send(t, udpFrameFrom(t, testGvproxyConfig().GuestIP, unlistedIP, excess, port, []byte("now admitted")))
	waitUDPCondition(t, "a new dial after releasing capacity", func() bool { return attempts.Load() == maxExtendedUDPFlows+1 })
	tap.cancel()
	waitUDPCondition(t, "all canceled UDP slots", func() bool { return len(tap.policy.udpFlows.slots) == 0 })
}

func TestExtendedUDPBackpressureReleasesFlow(t *testing.T) {
	for _, name := range []string{"idle", "destroy"} {
		t.Run(name, func(t *testing.T) {
			target, port := newUDPTestTarget(t)
			link := &backpressuredGuestLink{entered: make(chan struct{}), release: make(chan struct{})}
			tap := startNetworkWithSeams(t, testGvproxyConfig(), networkSeams{
				tcp: &trustedTCPRules{}, dial: target.dial,
				configureUDP: func(pool *udpFlowPool) {
					if name == "idle" {
						pool.idleTimeout = 300 * time.Millisecond
					}
				},
				wrapGuestLink: func(conn net.Conn) net.Conn {
					link.Conn = conn
					return link
				},
			})
			t.Cleanup(func() { link.Close() })
			tap.send(t, udpFrame(t, unlistedIP, port, []byte("establish")))
			target.echo(t, tap, unlistedIP, guestSrcPort, port, "establish")
			tap.send(t, udpFrame(t, unlistedIP, port, []byte("link probe")))
			peer := target.receive(t, "link probe")

			link.block.Store(true)
			if _, err := target.conn.WriteToUDP([]byte("blocked reply"), peer); err != nil {
				t.Fatal(err)
			}
			select {
			case <-link.entered:
			case <-time.After(forwardWindow):
				t.Fatal("reply must be blocked in the guest link")
			}
			if name == "destroy" {
				tap.cancel()
			}
			waitUDPCondition(t, "UDP release while guest link is backpressured", func() bool {
				return guestUDPEndpoint(t, tap, unlistedIP, guestSrcPort, port) == nil && len(tap.policy.udpFlows.slots) == 0
			})
			if name == "destroy" {
				select {
				case <-link.release:
				case <-time.After(forwardWindow):
					t.Fatal("Box cancellation left the accepted link open")
				}
			} else {
				select {
				case <-link.release:
					t.Fatal("idle expiry must not close the Box link")
				default:
				}
			}
		})
	}
}

func TestExtendedUDPBackpressureBoundsReplyQueue(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	guest, peer := net.Pipe()
	defer peer.Close()
	link := &backpressuredGuestLink{Conn: guest, entered: make(chan struct{}), release: make(chan struct{})}
	defer link.Close()
	link.block.Store(true)
	pool := newUDPFlowPool(ctx)
	pool.queueReply(ctx, link, []byte("in-flight"), func() {})
	select {
	case <-link.entered:
	case <-time.After(forwardWindow):
		t.Fatal("reply writer did not reach the stalled guest link")
	}
	for range maxQueuedUDPReplies * 2 {
		pool.queueReply(ctx, link, []byte("queued"), func() {})
	}
	if got := len(pool.replies); got != maxQueuedUDPReplies {
		t.Fatalf("expected %d queued replies plus one blocked write, got %d queued", maxQueuedUDPReplies, got)
	}
	cancel()
	link.Close()
	waitUDPCondition(t, "discarded replies after Box cancellation", func() bool { return len(pool.replies) == 0 })
}

type backpressuredGuestLink struct {
	net.Conn
	block     atomic.Bool
	enterOnce sync.Once
	closeOnce sync.Once
	entered   chan struct{}
	release   chan struct{}
}

func (link *backpressuredGuestLink) Write(frame []byte) (int, error) {
	if link.block.Load() {
		link.enterOnce.Do(func() { close(link.entered) })
		<-link.release
		return 0, net.ErrClosed
	}
	return link.Conn.Write(frame)
}

func (link *backpressuredGuestLink) Close() error {
	link.closeOnce.Do(func() { close(link.release) })
	return link.Conn.Close()
}

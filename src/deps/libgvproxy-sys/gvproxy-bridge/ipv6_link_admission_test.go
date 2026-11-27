package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv6"
)

func (l *ipv6TestLink) noWrite(t *testing.T) {
	t.Helper()
	if err := l.peer.SetReadDeadline(time.Now().Add(30 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	n, err := l.peer.Read(make([]byte, 2048))
	if n != 0 || !os.IsTimeout(err) {
		t.Fatalf("unexpected guest write or closed link: %d bytes, %v", n, err)
	}
}

func (l *ipv6TestLink) dad(t *testing.T, gateway tcpip.Address) {
	t.Helper()
	group := header.SolicitedNodeAddr(gateway)
	l.send(t, icmp6Frame(l.guestMAC, header.EthernetAddressFromMulticastIPv6Address(group), header.IPv6Any, group, solicitation(gateway, "")))
}

func (l *ipv6TestLink) checkDisabled(t *testing.T, gateway, guest tcpip.Address) {
	t.Helper()
	before := l.received()
	message := make(header.ICMPv6, header.ICMPv6EchoMinimumSize)
	message.SetType(header.ICMPv6EchoRequest)
	l.send(t, icmp6Frame(l.guestMAC, l.gatewayMAC, guest, gateway, message))
	route, err := l.policy.stack.FindRoute(l.policy.nic, gateway, guest, ipv6.ProtocolNumber, false)
	if err != nil {
		t.Fatalf("underlying NIC cannot send while testing the snapshot gate: %s", err)
	}
	defer route.Release()
	if err := route.ResolvedFields(nil); err == nil {
		t.Fatal("test destination already had a resolved link address")
	}
	l.noWrite(t)
	if l.received() != before {
		t.Fatal("IPv6 reached the stack under a disabled snapshot")
	}
	if _, learned := l.cam(t)[l.guestMAC.String()]; learned {
		t.Fatal("disabled link learned a guest MAC")
	}
}

func TestIPv6LinkModeTransitions(t *testing.T) {
	for _, protocol := range []types.Protocol{types.QemuProtocol, types.VfkitProtocol} {
		t.Run(string(protocol), func(t *testing.T) {
			link := openIPv6TestLink(t, protocol, optInIPv6(t), outboundPolicy{Mode: "disabled"}, nil)
			gateway := linkIPv6("fd12:3456:789a:1::1")
			policy := link.policy
			if err := policy.stack.EnableNIC(policy.nic); err != nil {
				t.Fatalf("make underlying NIC usable: %s", err)
			}
			link.checkDisabled(t, gateway, linkIPv6("fd12:3456:789a:1::8"))
			if err := policy.apply(outboundPolicy{Mode: "enabled"}, "started"); err != nil {
				t.Fatal(err)
			}
			link.dad(t, gateway)
			link.receive(t, header.ICMPv6NeighborAdvert)

			pause := &pausedNICOperations{nicOperations: policy.stack, entered: make(chan string, 1), resume: make(chan struct{}, 1)}
			policy.nicOps = pause
			runTransition := func(mode, revision, operation, guest string) {
				t.Helper()
				result := make(chan error, 1)
				go func() { result <- policy.apply(outboundPolicy{Mode: mode}, revision) }()
				defer func() {
					pause.resume <- struct{}{}
					select {
					case err := <-result:
						if err != nil {
							t.Error(err)
						}
					case <-time.After(2 * time.Second):
						t.Error("NIC operation did not finish")
					}
				}()
				select {
				case got := <-pause.entered:
					if got != operation {
						t.Fatalf("unexpected NIC operation: %s", got)
					}
				case <-time.After(2 * time.Second):
					t.Fatal("NIC operation did not enter")
				}
				link.checkDisabled(t, gateway, linkIPv6(guest))
			}
			runTransition("disabled", "paused-disable", "disable", "fd12:3456:789a:1::9")
			link.dad(t, gateway)
			link.noWrite(t)
			runTransition("enabled", "paused-enable", "enable", "fd12:3456:789a:1::a")
			link.dad(t, gateway)
			link.receive(t, header.ICMPv6NeighborAdvert)

			policy.nicOps = failedTCPDisable{policy.stack}
			if err := policy.apply(outboundPolicy{Mode: "disabled"}, "uncertain-disable"); err == nil {
				t.Fatal("expected a NIC error")
			}
			link.checkDisabled(t, gateway, linkIPv6("fd12:3456:789a:1::b"))
			policy.nicOps = failedTCPEnable{policy.stack}
			if err := policy.apply(outboundPolicy{Mode: "enabled"}, "uncertain-enable"); err == nil {
				t.Fatal("expected a NIC enable error")
			}
			link.checkDisabled(t, gateway, linkIPv6("fd12:3456:789a:1::c"))
		})
	}
}

func holdIPv6Pacer(t *testing.T, shaper *shapedConn) (<-chan struct{}, func()) {
	t.Helper()
	if shaper == nil || shaper.rxTokenBucket == nil {
		t.Fatal("production link did not install receive shaping")
	}
	reached, proceed := make(chan struct{}), make(chan struct{})
	var arrived, released sync.Once
	release := func() { released.Do(func() { close(proceed) }) }
	t.Cleanup(release)
	bucket := shaper.rxTokenBucket
	bucket.mu.Lock()
	now := bucket.now
	bucket.now = func() time.Time {
		arrived.Do(func() {
			close(reached)
			<-proceed
		})
		return now()
	}
	bucket.mu.Unlock()
	return reached, release
}

func awaitIPv6Test(t *testing.T, ready func() bool, description string) {
	t.Helper()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(2 * time.Second)
	defer timeout.Stop()
	for !ready() {
		select {
		case <-ticker.C:
		case <-timeout.C:
			t.Fatal(description)
		}
	}
}

func TestIPv6LinkShapedAdmission(t *testing.T) {
	for _, protocol := range []types.Protocol{types.QemuProtocol, types.VfkitProtocol} {
		t.Run(string(protocol), func(t *testing.T) {
			config := optInIPv6(t)
			config.RateLimit = &RateLimitConfig{RX: bucketCfg(65536, 1)}
			link := openIPv6TestLink(t, protocol, config, outboundPolicy{Mode: "enabled"}, nil)
			gateway := linkIPv6("fd12:3456:789a:1::1")
			if link.shaper == nil || link.shaper.rxTokenBucket == nil {
				t.Fatal("real link did not install the pacer")
			}
			clock := newFakeClock()
			bucket := link.shaper.rxTokenBucket
			bucket.mu.Lock()
			bucket.now = clock.now
			bucket.lastRefill = clock.now()
			initialTokens := bucket.tokens
			bucket.mu.Unlock()
			reached, release := holdIPv6Pacer(t, link.shaper)
			before := link.shaper.stats.snapshot()
			link.dad(t, gateway)
			select {
			case <-reached:
			case <-time.After(2 * time.Second):
				t.Fatal("stack-generated IPv6 frame did not reach the pacer")
			}
			link.policy.nicOps = failedTCPDisable{link.policy.stack}
			if err := link.policy.apply(outboundPolicy{Mode: "disabled"}, "pace-disable"); err == nil {
				t.Fatal("expected the NIC to remain up")
			}
			release()
			awaitIPv6Test(t, func() bool {
				return link.shaper.stats.snapshot().RxDroppedFrames == before.RxDroppedFrames+1
			}, "the pacer did not account for the rejected frame")
			link.noWrite(t)
			const frameSize = header.EthernetMinimumSize + header.IPv6MinimumSize + header.ICMPv6NeighborAdvertMinimumSize + 8
			var framedSize int64 = frameSize
			if link.stream {
				framedSize += 4
			}
			after := link.shaper.stats.snapshot()
			if after.RxDroppedBytes != before.RxDroppedBytes+framedSize || after.RxDeliveredBytes != before.RxDeliveredBytes {
				t.Fatalf("unexpected drop or delivery accounting: %+v", after)
			}
			link.checkDisabled(t, gateway, linkIPv6("fd12:3456:789a:1::9"))
			bucket.mu.Lock()
			tokensAfterDrop := bucket.tokens
			bucket.mu.Unlock()
			if spent := initialTokens - tokensAfterDrop; spent != frameSize {
				t.Fatalf("only the denial after pacing may consume tokens: used %d, want %d", spent, frameSize)
			}

			if err := link.policy.apply(outboundPolicy{Mode: "enabled"}, "pace-enable"); err != nil {
				t.Fatal(err)
			}
			link.dad(t, gateway)
			link.receive(t, header.ICMPv6NeighborAdvert)
			awaitIPv6Test(t, func() bool {
				return link.shaper.stats.snapshot().RxDeliveredBytes == before.RxDeliveredBytes+frameSize
			}, "the enabled control did not deliver a frame")
			if got := link.shaper.stats.snapshot(); got.RxDroppedFrames != after.RxDroppedFrames || got.RxDroppedBytes != after.RxDroppedBytes {
				t.Fatalf("the enabled control was also counted as a drop: %+v", got)
			}
			clock.advance(time.Millisecond)
			link.requireIPv4ARP(t, config)
		})
	}
}

func (l *ipv6TestLink) requireIPv4ARP(t *testing.T, config GvproxyConfig) {
	t.Helper()
	request := make([]byte, header.EthernetMinimumSize+header.ARPSize)
	header.Ethernet(request).Encode(&header.EthernetFields{
		SrcAddr: l.guestMAC, DstAddr: header.EthernetBroadcastAddress, Type: header.ARPProtocolNumber,
	})
	arp := header.ARP(request[header.EthernetMinimumSize:])
	arp.SetIPv4OverEthernet()
	arp.SetOp(header.ARPRequest)
	copy(arp.HardwareAddressSender(), l.guestMAC)
	copy(arp.ProtocolAddressSender(), net.ParseIP(config.GuestIP).To4())
	copy(arp.ProtocolAddressTarget(), net.ParseIP(config.GatewayIP).To4())
	l.send(t, request)
	if err := l.peer.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	answer, err := l.readFrame()
	if err != nil {
		t.Fatal(err)
	}
	if len(answer) != len(request) || header.Ethernet(answer).Type() != header.ARPProtocolNumber {
		t.Fatalf("unexpected frame while waiting for IPv4 ARP: %x", answer)
	}
	arp = header.ARP(answer[header.EthernetMinimumSize:])
	if arp.Op() != header.ARPReply || !net.IP(arp.ProtocolAddressSender()).Equal(net.ParseIP(config.GatewayIP)) {
		t.Fatal("gateway did not answer IPv4 ARP after re-enable")
	}
}

func TestIPv6LinkIPv4MappedRules(t *testing.T) {
	const deniedPort = 8080
	for _, mode := range []string{"IPv4-only", "IPv6-opt-in"} {
		for _, spelling := range []string{"IPv4", "mapped"} {
			t.Run(mode+"/"+spelling, func(t *testing.T) {
				config := udpServiceConfig()
				if mode == "IPv6-opt-in" {
					config = optInIPv6(t)
				}
				allow := unlistedIP
				deny := fmt.Sprintf("198.51.100.0/24:%d", deniedPort)
				if spelling == "mapped" {
					allow = "::ffff:" + unlistedIP
					deny = fmt.Sprintf("[::ffff:198.51.100.0/120]:%d", deniedPort)
				}

				udpTarget, port := newUDPTestTarget(t)
				if port == deniedPort {
					t.Fatal("UDP listener unexpectedly selected the denied port")
				}
				var tcpRequests atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					tcpRequests.Add(1)
					_, _ = io.Copy(w, r.Body)
				}))
				t.Cleanup(server.Close)
				tap := startNetworkWithSeams(t, config, networkSeams{
					tcp:  &trustedTCPRules{allow: []string{allow}, deny: []string{deny}},
					dial: udpTarget.dial,
					connect: func(ctx context.Context, target egressTarget) (net.Conn, error) {
						return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
					},
				})
				if mode == "IPv6-opt-in" {
					if tap.policy.stack.NetworkProtocolInstance(ipv6.ProtocolNumber) == nil {
						t.Fatal("IPv4 compatibility test did not enable IPv6")
					}
					requireUDPServiceReplies(t, tap, config)
				}
				tap.send(t, udpFrame(t, unlistedIP, port, []byte("allowed mapped policy")))
				udpTarget.echo(t, tap, unlistedIP, guestSrcPort, port, "allowed mapped policy")
				udpTarget.requireDial(t, "127.0.0.1", port)
				assertUDPPolicyDrop(t, tap, udpTarget, unlistedIP, guestSrcPort, deniedPort, outboundUserDeny)

				dial := startGuestStack(t, tap, config)
				const wire = "POST / HTTP/1.0\r\nContent-Length: 5\r\n\r\nhello"
				if body, err := extendedGuestHTTP(dial, port, wire); err != nil || body != "hello" || tcpRequests.Load() != 1 {
					t.Fatalf("allowed IPv4 TCP flow: %q, %v", body, err)
				}
				if _, err := extendedGuestHTTP(dial, deniedPort, wire); err == nil || tcpRequests.Load() != 1 {
					t.Fatalf("denied IPv4 TCP flow reached the target: %v", err)
				}
			})
		}
	}
}

type ipv6LinkWriter struct {
	net.Conn
	write func(net.Conn, []byte) (int, error)
}

func (conn *ipv6LinkWriter) Write(data []byte) (int, error) {
	return conn.write(conn.Conn, data)
}

func TestIPv6LinkPartialStreamWrite(t *testing.T) {
	for _, mode := range []string{"unshaped", "shaped"} {
		for label, injectedError := range map[string]error{"short": nil, "retryable error": syscall.ENOBUFS} {
			t.Run(mode+"/"+label, func(t *testing.T) {
				config := optInIPv6(t)
				if mode == "shaped" {
					config.RateLimit = &RateLimitConfig{RX: bucketCfg(65536, 1)}
				}
				const partialSize = 6
				var attempts atomic.Int32
				wrap := func(conn net.Conn) net.Conn {
					return &ipv6LinkWriter{Conn: conn, write: func(conn net.Conn, data []byte) (int, error) {
						if attempts.Add(1) != 1 {
							return conn.Write(data)
						}
						n, err := conn.Write(data[:partialSize])
						if err != nil {
							return n, err
						}
						return n, injectedError
					}}
				}
				link := openIPv6TestLink(t, types.QemuProtocol, config, outboundPolicy{Mode: "enabled"}, wrap)
				link.dad(t, linkIPv6("fd12:3456:789a:1::1"))
				if err := link.peer.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(link.peer)
				if err != nil || len(data) != partialSize || attempts.Load() != 1 {
					t.Fatalf("partial write must close without replay: bytes=%d attempts=%d err=%v", len(data), attempts.Load(), err)
				}
				if binary.BigEndian.Uint32(data[:4]) <= partialSize-4 {
					t.Fatal("fixture did not observe part of a real framed packet")
				}
			})
		}
	}
}

func TestIPv6LinkRetryChecksMode(t *testing.T) {
	for _, protocol := range []types.Protocol{types.QemuProtocol, types.VfkitProtocol} {
		for _, mode := range []string{"unshaped", "shaped"} {
			t.Run(string(protocol)+"/"+mode, func(t *testing.T) {
				config := optInIPv6(t)
				if mode == "shaped" {
					config.RateLimit = &RateLimitConfig{RX: bucketCfg(65536, 1)}
				}
				attempted, proceed := make(chan struct{}), make(chan struct{})
				var attempts atomic.Int32
				var release sync.Once
				proceedOnce := func() { release.Do(func() { close(proceed) }) }
				wrap := func(conn net.Conn) net.Conn {
					return &ipv6LinkWriter{Conn: conn, write: func(conn net.Conn, data []byte) (int, error) {
						if attempts.Add(1) == 1 {
							close(attempted)
							<-proceed
							return 0, syscall.ENOBUFS
						}
						return conn.Write(data)
					}}
				}
				link := openIPv6TestLink(t, protocol, config, outboundPolicy{Mode: "enabled"}, wrap)
				t.Cleanup(proceedOnce)
				gateway := linkIPv6("fd12:3456:789a:1::1")
				link.dad(t, gateway)
				select {
				case <-attempted:
				case <-time.After(2 * time.Second):
					t.Fatal("the enabled first write was never attempted")
				}
				link.policy.nicOps = failedTCPDisable{link.policy.stack}
				if err := link.policy.apply(outboundPolicy{Mode: "disabled"}, "before-retry"); err == nil {
					t.Fatal("expected the NIC to remain up")
				}
				proceedOnce()
				link.noWrite(t)
				if got := attempts.Load(); got != 1 {
					t.Fatalf("disabled frame retried at the underlying writer: %d attempts", got)
				}
				if err := link.policy.apply(outboundPolicy{Mode: "enabled"}, "after-retry"); err != nil {
					t.Fatal(err)
				}
				link.dad(t, gateway)
				link.receive(t, header.ICMPv6NeighborAdvert)
				if got := attempts.Load(); got != 2 {
					t.Fatalf("the enabled control did not write exactly once: %d attempts", got)
				}
			})
		}
	}
}

type ipv6ReadObserver struct {
	net.Conn
	readStarted chan struct{}
}

func (conn *ipv6ReadObserver) Read(data []byte) (int, error) {
	select {
	case conn.readStarted <- struct{}{}:
	default:
	}
	return conn.Conn.Read(data)
}

func TestIPv6LinkDisablesWhileReadPending(t *testing.T) {
	for _, protocol := range []types.Protocol{types.QemuProtocol, types.VfkitProtocol} {
		t.Run(string(protocol), func(t *testing.T) {
			readStarted := make(chan struct{}, 1)
			wrap := func(conn net.Conn) net.Conn {
				return &ipv6ReadObserver{Conn: conn, readStarted: readStarted}
			}
			link := openIPv6TestLink(t, protocol, optInIPv6(t), outboundPolicy{Mode: "enabled"}, wrap)
			select {
			case <-readStarted:
			case <-time.After(2 * time.Second):
				t.Fatal("guest read did not start while outbound was enabled")
			}

			link.policy.nicOps = failedTCPDisable{link.policy.stack}
			if err := link.policy.apply(outboundPolicy{Mode: "disabled"}, "disable-during-read"); err == nil {
				t.Fatal("expected the NIC to remain up")
			}
			gateway := linkIPv6("fd12:3456:789a:1::1")
			link.checkDisabled(t, gateway, linkIPv6("fd12:3456:789a:1::2"))

			if err := link.policy.apply(outboundPolicy{Mode: "enabled"}, "enable-after-read"); err != nil {
				t.Fatal(err)
			}
			link.dad(t, gateway)
			link.receive(t, header.ICMPv6NeighborAdvert)
		})
	}
}

func triggerIPv6Solicitation(t *testing.T, link *ipv6TestLink, target tcpip.Address) {
	t.Helper()
	route, err := link.policy.stack.FindRoute(link.policy.nic, linkIPv6("fd12:3456:789a:1::1"), target, ipv6.ProtocolNumber, false)
	if err != nil {
		t.Fatalf("find route for solicitation: %s", err)
	}
	defer route.Release()
	if _, pending := route.ResolvedFields(nil).(*tcpip.ErrWouldBlock); !pending {
		t.Fatal("test peer was already resolved")
	}
}

func TestIPv6LinkSwitchQueue(t *testing.T) {
	for _, protocol := range []types.Protocol{types.QemuProtocol, types.VfkitProtocol} {
		for _, disabled := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/disable-%t", protocol, disabled), func(t *testing.T) {
				started, release := make(chan struct{}), make(chan struct{})
				var oneWrite, unblock sync.Once
				resume := func() { unblock.Do(func() { close(release) }) }
				wrap := func(conn net.Conn) net.Conn {
					return &ipv6LinkWriter{Conn: conn, write: func(conn net.Conn, payload []byte) (int, error) {
						oneWrite.Do(func() {
							close(started)
							<-release
						})
						return conn.Write(payload)
					}}
				}
				link := openIPv6TestLink(t, protocol, optInIPv6(t), outboundPolicy{Mode: "enabled"}, wrap)
				t.Cleanup(resume)
				first, second := linkIPv6("fd12:3456:789a:1::40"), linkIPv6("fd12:3456:789a:1::41")
				triggerIPv6Solicitation(t, link, first)
				select {
				case <-started:
				case <-time.After(2 * time.Second):
					t.Fatal("first solicitation did not reach the writer")
				}
				triggerIPv6Solicitation(t, link, second)
				if disabled {
					link.policy.nicOps = failedTCPDisable{link.policy.stack}
					if err := link.policy.apply(outboundPolicy{Mode: "disabled"}, "queued-disable"); err == nil {
						t.Fatal("expected the NIC to remain up")
					}
				}
				resume()
				requireSolicitation := func(want tcpip.Address) {
					t.Helper()
					_, ip := link.receive(t, header.ICMPv6NeighborSolicit)
					if got := header.NDPNeighborSolicit(header.ICMPv6(ip.Payload()).MessageBody()).TargetAddress(); got != want {
						t.Fatalf("solicitation target = %s, want %s", got, want)
					}
				}
				requireSolicitation(first)
				if disabled {
					link.noWrite(t)
				} else {
					requireSolicitation(second)
				}
			})
		}
	}
}

func TestIPv6LinkMulticastRechecksMode(t *testing.T) {
	for _, protocol := range []types.Protocol{types.QemuProtocol, types.VfkitProtocol} {
		for _, disabled := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/disable-%t", protocol, disabled), func(t *testing.T) {
				started, proceed := make(chan struct{}), make(chan struct{})
				var writes atomic.Int32
				var resumed sync.Once
				resume := func() { resumed.Do(func() { close(proceed) }) }
				wrap := func(conn net.Conn) net.Conn {
					return &ipv6LinkWriter{Conn: conn, write: func(conn net.Conn, payload []byte) (int, error) {
						if writes.Add(1) == 1 {
							close(started)
							<-proceed
						}
						return conn.Write(payload)
					}}
				}
				link := openIPv6TestLink(t, protocol, optInIPv6(t), outboundPolicy{Mode: "enabled"}, wrap)
				t.Cleanup(resume)

				ctx, cancel := context.WithCancel(context.Background())
				otherPeer, previous := net.Pipe()
				attached := &linkReadyConn{Conn: wrap(previous), ready: make(chan struct{})}
				prefix, accept := 0, link.network.AcceptVfkit
				if link.stream {
					prefix, accept = 4, link.network.AcceptQemu
				}
				otherStopped := make(chan struct{})
				go func() {
					defer close(otherStopped)
					_ = link.policy.runGuestLink(ctx, attached, prefix, nil, accept)
				}()
				t.Cleanup(func() {
					resume()
					cancel()
					_ = otherPeer.Close()
					select {
					case <-otherStopped:
					case <-time.After(2 * time.Second):
						t.Error("second guest link did not stop")
					}
				})
				select {
				case <-attached.ready:
				case <-time.After(2 * time.Second):
					t.Fatal("second guest link did not enter receive")
				}
				target := linkIPv6("fd12:3456:789a:1::42")
				triggerIPv6Solicitation(t, link, target)
				select {
				case <-started:
				case <-time.After(2 * time.Second):
					t.Fatal("multicast never reached a recipient")
				}
				if disabled {
					link.policy.nicOps = failedTCPDisable{link.policy.stack}
					if err := link.policy.apply(outboundPolicy{Mode: "disabled"}, "multicast-disable"); err == nil {
						t.Fatal("expected the NIC to remain up")
					}
				}
				type readResult struct {
					frame []byte
					err   error
				}
				read := func(peer net.Conn) <-chan readResult {
					result := make(chan readResult, 1)
					go func() {
						if err := peer.SetReadDeadline(time.Now().Add(150 * time.Millisecond)); err != nil {
							result <- readResult{err: err}
							return
						}
						frames := ipv6TestLink{peer: peer, stream: link.stream}
						frame, err := frames.readFrame()
						result <- readResult{frame, err}
					}()
					return result
				}
				first, second := read(link.peer), read(otherPeer)
				resume()
				delivered := 0
				for _, got := range []readResult{<-first, <-second} {
					if os.IsTimeout(got.err) && len(got.frame) == 0 {
						continue
					}
					if got.err != nil || len(got.frame) < header.EthernetMinimumSize+header.IPv6MinimumSize+header.ICMPv6NeighborSolicitMinimumSize {
						t.Fatalf("invalid multicast frame or read: %x, %v", got.frame, got.err)
					}
					ip := header.IPv6(got.frame[header.EthernetMinimumSize:])
					ndp := header.NDPNeighborSolicit(header.ICMPv6(ip.Payload()).MessageBody())
					if ndp.TargetAddress() != target {
						t.Fatalf("multicast target = %s, want %s", ndp.TargetAddress(), target)
					}
					delivered++
				}
				want := 2
				if disabled {
					want = 1
				}
				if delivered != want || writes.Load() != int32(want) {
					t.Fatalf("multicast reached %d peers in %d writes, want %d", delivered, writes.Load(), want)
				}
			})
		}
	}
}

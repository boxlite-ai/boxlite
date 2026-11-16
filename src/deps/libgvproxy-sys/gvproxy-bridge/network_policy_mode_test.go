package main

import (
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
)

func failDisableNIC(t *testing.T, tap *guestTap) {
	t.Helper()
	// A nonexistent controller NIC makes the real stack operation fail while
	// the actual guest NIC remains up. This exercises the production failure
	// path without replacing the controller or simulating its policy logic.
	tap.policy.nic += 1000
	replacePolicy(t, tap, `{"mode":"disabled"}`, http.StatusInternalServerError)
}

func receivePolicyProbe(t *testing.T, upstream *net.UDPConn, want []byte) {
	t.Helper()
	_ = upstream.SetReadDeadline(time.Now().Add(forwardWindow))
	data := make([]byte, 2048)
	n, _, err := upstream.ReadFrom(data)
	if err != nil || string(data[:n]) != string(want) {
		t.Fatalf("control probe: got %q err=%v, want %q", data[:n], err, want)
	}
}

func TestOutboundModeNICFailureBlocksUDP(t *testing.T) {
	cfg := testGvproxyConfig()
	tap := startNetwork(t, []string{cfg.HostIP})
	upstream, port := listenUDP(t)
	tap.send(t, udpFrame(t, cfg.HostIP, port, []byte(probePayload)))
	receivePolicyProbe(t, upstream, []byte(probePayload))
	failDisableNIC(t, tap)
	tap.send(t, udpFrame(t, unlistedIP, port, []byte(probePayload)))
	assertDatagramDropped(t, upstream, "UDP after failed NIC suspension")
}

func TestOutboundModeNICFailureDoesNotConfirmReadback(t *testing.T) {
	tap := startNetwork(t, []string{"api.example.com"})
	failDisableNIC(t, tap)
	response := httptest.NewRecorder()
	tap.policy.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/network/outbound", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("failed application readback: status=%d body=%s", response.Code, response.Body)
	}
}

func TestOutboundModeNICFailureBlocksTCP(t *testing.T) {
	cfg := testGvproxyConfig()
	tap := startNetwork(t, []string{cfg.HostIP})
	listener, port := listenTCP(t)
	accepted := make(chan struct{}, 2)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
			accepted <- struct{}{}
		}
	}()
	tap.send(t, tcpSynFrame(t, cfg.HostIP, port))
	select {
	case <-accepted:
	case <-time.After(forwardWindow):
		t.Fatal("allowed TCP control did not reach its listener")
	}
	failDisableNIC(t, tap)
	tap.send(t, tcpSynFrame(t, unlistedIP, port))
	select {
	case <-accepted:
		t.Fatal("TCP reached upstream after failed NIC suspension")
	case <-time.After(forwardWindow):
	}
}

func modeDNSQuery(t *testing.T, id uint16) []byte {
	t.Helper()
	message := dnsmessage.Message{
		Header: dnsmessage.Header{ID: id, RecursionDesired: true},
		Questions: []dnsmessage.Question{{Name: dnsmessage.MustNewName("control.example."),
			Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}},
	}
	data, err := message.Pack()
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// registeredDNSProbe installs native gVisor endpoints, which bypass default
// TCP/UDP handlers just like the embedded DNS service. Port 5353 avoids its
// existing :53 binding. Received DNS messages are forwarded to a test-owned
// host listener so a missing response cannot hide an upstream DNS leak.
func registeredDNSProbe(t *testing.T, tap *guestTap, protocol string, upstreamPort uint16) func([]byte) error {
	t.Helper()
	cfg := testGvproxyConfig()
	upstream, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: int(upstreamPort)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = upstream.Close() })
	local := tcpip.FullAddress{NIC: tap.policy.nic, Addr: addr(t, cfg.GatewayIP), Port: 5353}
	if protocol == "udp" {
		endpoint, err := gonet.DialUDP(tap.policy.stack, &local, nil, ipv4.ProtocolNumber)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = endpoint.Close() })
		go func() {
			buffer := make([]byte, 2048)
			for {
				n, _, err := endpoint.ReadFrom(buffer)
				if err != nil {
					return
				}
				_, _ = upstream.Write(buffer[:n])
			}
		}()
		return func(query []byte) error {
			tap.send(t, udpFrame(t, cfg.GatewayIP, local.Port, query))
			return nil
		}
	}
	listener, err := gonet.ListenTCP(tap.policy.stack, local, ipv4.ProtocolNumber)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		accepted <- conn
		defer conn.Close()
		for {
			var size [2]byte
			if _, err := io.ReadFull(conn, size[:]); err != nil {
				return
			}
			query := make([]byte, binary.BigEndian.Uint16(size[:]))
			if _, err := io.ReadFull(conn, query); err != nil {
				return
			}
			_, _ = upstream.Write(query)
		}
	}()
	conn, err := startGuestStack(t, tap, cfg)(cfg.GatewayIP, local.Port)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	select {
	case server := <-accepted:
		t.Cleanup(func() { _ = server.Close() })
	case <-time.After(forwardWindow):
		t.Fatal("registered DNS endpoint did not accept the control connection")
	}
	return func(query []byte) error {
		_ = conn.SetWriteDeadline(time.Now().Add(forwardWindow))
		frame := make([]byte, 2+len(query))
		binary.BigEndian.PutUint16(frame, uint16(len(query)))
		copy(frame[2:], query)
		_, err := conn.Write(frame)
		return err
	}
}

func TestOutboundModeNICFailureBlocksRegisteredDNS(t *testing.T) {
	for _, protocol := range []string{"udp", "tcp"} {
		t.Run(protocol, func(t *testing.T) {
			tap := startNetwork(t, []string{"api.example.com"})
			upstream, port := listenUDP(t)
			send := registeredDNSProbe(t, tap, protocol, port)
			control := modeDNSQuery(t, 1)
			if err := send(control); err != nil {
				t.Fatal(err)
			}
			receivePolicyProbe(t, upstream, control)
			failDisableNIC(t, tap)
			_ = send(modeDNSQuery(t, 2))
			assertDatagramDropped(t, upstream, "registered %s DNS after failed NIC suspension", protocol)
		})
	}
}

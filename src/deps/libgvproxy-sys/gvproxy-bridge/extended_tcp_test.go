package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

func TestExtendedTCPGuestRoutes(t *testing.T) {
	const safeIP = "203.0.113.8"
	const hostHeader = "Host: api.example.com:9999\r\n"
	for _, tc := range []struct {
		name       string
		rules      trustedTCPRules
		answers    []string
		headers    string
		port       uint16
		secrets    bool
		connection string
	}{
		{name: "direct-local-NAT", rules: trustedTCPRules{allow: []string{unlistedIP}}, headers: hostHeader, connection: "127.0.0.1"},
		{name: "direct-Cloud-NAT-denied", rules: trustedTCPRules{allow: []string{unlistedIP}, cloud: true}, headers: hostHeader},
		{name: "pre-NAT-deny", rules: trustedTCPRules{deny: []string{unlistedIP}}, headers: hostHeader},
		{name: "deny-only-inspects-unusual-port", rules: trustedTCPRules{deny: []string{"api.example.com:8443"}}, headers: hostHeader, port: 8443},
		{name: "name-allow-mixed-DNS", rules: trustedTCPRules{allow: []string{"api.example.com:8443"}, deny: []string{"192.0.2.0/24:8443"}},
			headers: hostHeader, port: 8443, answers: []string{"192.0.2.8", "::ffff:" + safeIP}, connection: safeIP},
		{name: "IPv6-only-DNS", rules: trustedTCPRules{allow: []string{"api.example.com"}}, headers: hostHeader, answers: []string{"2001:db8::8"}},
		{name: "hard-candidate-deny", rules: trustedTCPRules{allow: []string{"api.example.com", "0.0.0.0/8", "224.0.0.0/4", "169.254.0.0/16"}},
			headers: hostHeader, answers: []string{"169.254.169.254", "224.0.0.1", "0.8.2.1"}},
		{name: "Cloud-private-candidate-deny", rules: trustedTCPRules{allow: []string{"api.example.com", "127.0.0.1"}, cloud: true},
			headers: hostHeader, answers: []string{"127.0.0.1"}},
		{name: "extended-allow-independent-of-UDP", rules: trustedTCPRules{allow: []string{"api.example.com", "127.0.0.1"}},
			headers: hostHeader, answers: []string{"127.0.0.1"}, connection: "127.0.0.1"},
		{name: "missing-name-blocks-broad-IP", rules: trustedTCPRules{allow: []string{unlistedIP}, deny: []string{"blocked.example.com:8080"}}},
		{name: "other-port-deny-preserves-IP", rules: trustedTCPRules{allow: []string{unlistedIP}, deny: []string{"blocked.example.com:8443"}},
			connection: "127.0.0.1"},
		{name: "matching-observation-of-other-address", rules: trustedTCPRules{allow: []string{unlistedIP}, deny: []string{"blocked.example.com"}},
			headers: hostHeader, answers: []string{unlistedIP}},
		{name: "matching-translated-address", rules: trustedTCPRules{allow: []string{unlistedIP}, deny: []string{"blocked.example.com"}},
			headers: hostHeader, answers: []string{"127.0.0.1"}, connection: "127.0.0.1"},
		{name: "plaintext-443-is-not-MITM", rules: trustedTCPRules{allow: []string{"api.example.com:443"}},
			headers: hostHeader, answers: []string{safeIP}, port: 443, secrets: true, connection: safeIP},
		{name: "conflicting-authorities", rules: trustedTCPRules{allow: []string{"api.example.com"}},
			headers: hostHeader + "Host: other.example.com\r\n", answers: []string{safeIP}},
		{name: "header-over-inspection-limit", rules: trustedTCPRules{allow: []string{"api.example.com"}},
			headers: "X-Large: " + strings.Repeat("a", tcpInspectionBytes) + "\r\n" + hostHeader, answers: []string{safeIP}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var connectorCalls, requests atomic.Int32
			targets := make(chan egressTarget, 2)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				_, _ = io.Copy(w, r.Body)
			}))
			defer server.Close()

			cfg := testGvproxyConfig()
			cfg.AllowNet = []string{"192.0.2.77"}
			seams := networkSeams{
				tcp: &tc.rules, resolve: staticResolve(tc.answers...), dial: refuseDial,
				connect: func(ctx context.Context, target egressTarget) (net.Conn, error) {
					if connectorCalls.Add(1) <= 2 {
						targets <- target
					}
					return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
				},
			}
			if tc.secrets {
				seams.ca = newTestCA(t)
				seams.secretMatcher = NewSecretHostMatcher(testSecrets())
			}
			tap := startNetworkWithSeams(t, cfg, seams)
			port := tc.port
			if port == 0 {
				port = 8080
			}
			wire := "POST / HTTP/1.0\r\n" + tc.headers + "Content-Length: 5\r\n\r\nhello"
			body, err := extendedGuestHTTP(startGuestStack(t, tap, cfg), port, wire)
			if tc.connection == "" {
				if err == nil || connectorCalls.Load() != 0 || requests.Load() != 0 {
					t.Fatalf("denied guest: err=%v, calls=%d, requests=%d", err, connectorCalls.Load(), requests.Load())
				}
				return
			}
			if err != nil || body != "hello" || connectorCalls.Load() != 1 || requests.Load() != 1 {
				t.Fatalf("allowed guest: body=%q err=%v, calls=%d, requests=%d", body, err, connectorCalls.Load(), requests.Load())
			}
			target := <-targets
			if target.ConnectionIP != netip.MustParseAddr(tc.connection) || target.PolicyIP.String() != unlistedIP ||
				target.Port != port || target.PolicyRevision != cfg.OutboundRevision {
				t.Fatalf("wrong socket target: %+v", target)
			}
		})
	}
}

func extendedGuestHTTP(dial guestDialer, port uint16, wire string) (string, error) {
	conn, err := dial(unlistedIP, port)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(conn, wire); err != nil {
		return "", err
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodPost})
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	return string(body), err
}

func TestExtendedTCPInspectionSlotsReleaseBeforeRelay(t *testing.T) {
	timeout := upstreamDialTimeout
	const setupBudget = 5 * time.Second
	const excessWait = time.Second
	upstreamDialTimeout = setupBudget
	t.Cleanup(func() { upstreamDialTimeout = timeout })
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()

	cfg := testGvproxyConfig()
	var dials atomic.Int32
	deadlines := make(chan time.Time, 1)
	tap := startNetworkWithSeams(t, cfg, networkSeams{
		tcp:     &trustedTCPRules{allow: []string{"api.example.com:8080"}},
		resolve: staticResolve("203.0.113.8"), dial: refuseDial,
		connect: func(ctx context.Context, _ egressTarget) (net.Conn, error) {
			if dials.Add(1) == 1 {
				deadline, _ := ctx.Deadline()
				deadlines <- deadline
			}
			return (&net.Dialer{}).DialContext(ctx, "tcp4", listener.Addr().String())
		},
	})
	dial := startGuestStack(t, tap, cfg)
	open := func() net.Conn {
		t.Helper()
		conn, err := dial(unlistedIP, 8080)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		_ = conn.SetDeadline(time.Now().Add(2 * setupBudget))
		return conn
	}
	guests := make([]net.Conn, 10)
	started := time.Now()
	for i := range guests {
		guests[i] = open()
	}
	slots := tap.policy.tcpInspectionSlots
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	saturation := time.NewTimer(time.Until(started.Add(setupBudget - excessWait)))
	defer saturation.Stop()
	for len(slots) != len(guests) {
		select {
		case <-saturation.C:
			t.Fatalf("only %d/%d guests reached inspection before the cutoff", len(slots), len(guests))
		case <-tick.C:
		}
	}
	excess := open()
	if time.Since(started)+excessWait >= setupBudget {
		t.Fatal("guest setup exhausted the budget before inspection saturation could be verified")
	}
	_ = excess.SetReadDeadline(time.Now().Add(excessWait))
	if _, err := excess.Read(make([]byte, 1)); err == nil {
		t.Fatal("eleventh inspection was admitted")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("excess inspection did not close immediately")
	}

	relay := func(conn net.Conn, payload string) {
		t.Helper()
		if _, err := io.WriteString(conn, payload); err != nil {
			t.Fatal(err)
		}
		actual := make([]byte, len(payload))
		if _, err := io.ReadFull(conn, actual); err != nil || string(actual) != payload {
			t.Fatalf("relay: got %q err=%v want %q", actual, err, payload)
		}
	}
	relay(guests[0], "POST / HTTP/1.1\r\nHost: api.example.com\r\nContent-Length: 4\r\n\r\nbody")
	deadline := <-deadlines
	if len(slots) != len(guests)-1 {
		t.Fatalf("relay still occupies an inspection slot: %d occupied", len(slots))
	}
	next := open()
	relay(next, "GET / HTTP/1.1\r\nHost: api.example.com\r\n\r\n")
	// The silent connection closes at its setup deadline, independently of the
	// shorter test wait used to distinguish the excess connection.
	if _, err := guests[1].Read(make([]byte, 1)); err == nil {
		t.Fatal("idle inspection remained open")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("idle inspection reached the client's deadline")
	}
	<-time.After(time.Until(deadline) + time.Millisecond)
	relay(guests[0], "still relaying after setup expiry")
	if dials.Load() != 2 {
		t.Fatalf("idle or excess flow reached the connector: dials=%d", dials.Load())
	}
}

func TestExtendedTCPTrustedModeAndWireProjection(t *testing.T) {
	cfg := testGvproxyConfig()
	cfg.AllowNet = []string{unlistedIP}
	rules := trustedTCPRules{deny: []string{"blocked.example.com"}}
	tap := startNetworkWithSeams(t, cfg, networkSeams{tcp: &rules})
	upstream, port := listenUDP(t)
	send := registeredDNSProbe(t, tap, "udp", port)
	checkWire := func(path, method, revision, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		if revision != "" {
			request.Header.Set("If-Match", outboundETag(revision))
			request.Header.Set(outboundRevisionHeader, "wire-next")
		}
		response := httptest.NewRecorder()
		tap.policy.ServeHTTP(response, request)
		if response.Code != want {
			t.Fatalf("%s %s: got %d %s, want %d", method, path, response.Code, response.Body, want)
		}
		return response
	}

	control := modeDNSQuery(t, 1)
	if err := send(control); err != nil {
		t.Fatal(err)
	}
	receivePolicyProbe(t, upstream, control)
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("UDP before transition")))
	receivePolicyProbe(t, upstream, []byte("UDP before transition"))

	for i, step := range []struct {
		mode, operation, previous, revision string
	}{
		{"disabled", "disable", cfg.OutboundRevision, "disabled"},
		{"enabled", "enable", "disabled", "enabled"},
	} {
		paused := &pausedNICOperations{nicOperations: tap.policy.stack,
			entered: make(chan string, 1), resume: make(chan struct{})}
		release := sync.OnceFunc(func() { close(paused.resume) })
		t.Cleanup(release)
		tap.policy.nicOps = paused
		done := make(chan error, 1)
		go func() { done <- tap.policy.replaceTrustedTCP(step.mode, rules, step.previous, step.revision) }()
		select {
		case got := <-paused.entered:
			if got != step.operation {
				t.Fatalf("NIC operation %q, want %q", got, step.operation)
			}
		case <-time.After(forwardWindow):
			t.Fatal("trusted transition did not call NIC")
		}
		checkWire("/network/outbound", http.MethodGet, "", "", http.StatusServiceUnavailable)
		_ = send(modeDNSQuery(t, uint16(i+2)))
		assertDatagramDropped(t, upstream, "registered DNS while %s pending", step.operation)
		release()
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		allow := "[]"
		if step.mode == "enabled" {
			allow = fmt.Sprintf("[%q]", unlistedIP)
		}
		want := fmt.Sprintf(`{"mode":%q,"allow_net":%s}`, step.mode, allow)
		policy := checkWire("/network/outbound", http.MethodGet, "", "", http.StatusOK)
		status := checkWire(outboundStatusPath, http.MethodGet, "", "", http.StatusOK)
		if strings.TrimSpace(policy.Body.String()) != want || !strings.Contains(status.Body.String(), want) {
			t.Fatalf("mode projection: policy=%s status=%s", policy.Body, status.Body)
		}
		checkWire("/network/outbound", http.MethodPut, "", `{"mode":"enabled"}`, http.StatusConflict)
		checkWire(outboundSnapshotPath, http.MethodPut, step.revision, `{"mode":"enabled"}`, http.StatusConflict)
		if snapshot := tap.policy.active.Load(); snapshot.revision != step.revision || len(snapshot.tcpPolicy.deny) != 1 {
			t.Fatalf("wire PUT changed extended policy: revision=%s", snapshot.revision)
		}
	}

	control = modeDNSQuery(t, 4)
	if err := send(control); err != nil {
		t.Fatal(err)
	}
	receivePolicyProbe(t, upstream, control)
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("UDP after transition")))
	receivePolicyProbe(t, upstream, []byte("UDP after transition"))

	tap.policy.nicOps = failedTCPDisable{nicOperations: tap.policy.stack}
	if err := tap.policy.replaceTrustedTCP("disabled", rules, "enabled", "failed-disable"); err == nil {
		t.Fatal("failed NIC suspension was acknowledged")
	}
	checkWire("/network/outbound", http.MethodGet, "", "", http.StatusServiceUnavailable)
	status := checkWire(outboundStatusPath, http.MethodGet, "", "", http.StatusOK)
	if !strings.Contains(status.Body.String(), `"application_state":"uncertain"`) {
		t.Fatalf("failed disable status: %s", status.Body)
	}
	_ = send(modeDNSQuery(t, 5))
	assertDatagramDropped(t, upstream, "registered DNS after failed NIC suspension")
	tap.policy.nicOps = failedTCPEnable{nicOperations: tap.policy.stack}
	if err := tap.policy.replaceTrustedTCP("enabled", rules, "failed-disable", "failed-enable"); err == nil {
		t.Fatal("failed NIC enable was acknowledged")
	}
	checkWire("/network/outbound", http.MethodGet, "", "", http.StatusServiceUnavailable)
	if active := tap.policy.active.Load(); active.state != "uncertain" || active.policy.Mode != "disabled" || active.revision != "failed-disable" {
		t.Fatalf("failed enable published a replacement: %+v", active.policy)
	}
	_ = send(modeDNSQuery(t, 6))
	assertDatagramDropped(t, upstream, "registered DNS after failed NIC enable")
}

type failedTCPDisable struct{ nicOperations }

func (failedTCPDisable) DisableNIC(tcpip.NICID) tcpip.Error { return &tcpip.ErrNotSupported{} }

type failedTCPEnable struct{ nicOperations }

func (n failedTCPEnable) EnableNIC(id tcpip.NICID) tcpip.Error {
	if err := n.nicOperations.EnableNIC(id); err != nil {
		return err
	}
	return &tcpip.ErrNotSupported{}
}

func TestExtendedTCPLateGuestHandshakeNeverDials(t *testing.T) {
	previousTimeout := upstreamDialTimeout
	const budget = 700 * time.Millisecond
	upstreamDialTimeout = budget
	t.Cleanup(func() { upstreamDialTimeout = previousTimeout })

	for _, late := range []bool{false, true} {
		t.Run(fmt.Sprintf("late=%t", late), func(t *testing.T) {
			listener, port := listenTCP(t)
			cfg := testGvproxyConfig()
			connects := make(chan egressTarget, 2)
			tap := startNetworkWithSeams(t, cfg, networkSeams{
				tcp: &trustedTCPRules{allow: []string{unlistedIP}}, dial: refuseDial,
				connect: func(ctx context.Context, target egressTarget) (net.Conn, error) {
					connects <- target
					return (&net.Dialer{}).DialContext(ctx, "tcp4", listener.Addr().String())
				},
			})
			tap.send(t, tcpSynFrame(t, unlistedIP, port))
			synACK := awaitExtendedTCPFrame(t, tap, port, header.TCPFlagSyn|header.TCPFlagAck)
			if late {
				// Start the wait after the SYN-ACK proves the forwarder has
				// entered its setup budget and is waiting for this ACK.
				<-time.After(budget + 10*time.Millisecond)
			}
			src, dst := addr(t, cfg.GuestIP), addr(t, unlistedIP)
			segment := header.TCP(make([]byte, header.TCPMinimumSize))
			segment.Encode(&header.TCPFields{
				SrcPort: guestSrcPort, DstPort: port, SeqNum: synACK.AckNumber(),
				AckNum: synACK.SequenceNumber() + 1, DataOffset: header.TCPMinimumSize,
				Flags: header.TCPFlagAck, WindowSize: 65535,
			})
			segment.SetChecksum(^segment.CalculateChecksum(header.PseudoHeaderChecksum(tcp.ProtocolNumber, src, dst, header.TCPMinimumSize)))
			tap.send(t, ipv4Frame(t, src, dst, tcp.ProtocolNumber, segment))
			if !late {
				select {
				case target := <-connects:
					if target.ConnectionIP.String() != "127.0.0.1" {
						t.Fatalf("timely handshake reached wrong socket: %+v", target)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("timely handshake did not reach the connector")
				}
				return
			}

			awaitExtendedTCPFrame(t, tap, port, header.TCPFlagFin)
			select {
			case target := <-connects:
				t.Fatalf("late handshake reached connector: %+v", target)
			default:
			}
		})
	}
}

func awaitExtendedTCPFrame(t *testing.T, tap *guestTap, port uint16, flags header.TCPFlags) header.TCP {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case frame := <-tap.frames:
			if len(frame) < header.EthernetMinimumSize+header.IPv4MinimumSize+header.TCPMinimumSize ||
				header.Ethernet(frame).Type() != header.IPv4ProtocolNumber {
				continue
			}
			ip := header.IPv4(frame[header.EthernetMinimumSize:])
			if ip.Protocol() != uint8(tcp.ProtocolNumber) || int(ip.HeaderLength())+header.TCPMinimumSize > len(ip) {
				continue
			}
			segment := header.TCP(ip[ip.HeaderLength():])
			if segment.DestinationPort() == guestSrcPort && segment.SourcePort() == port && segment.Flags()&flags == flags {
				return segment
			}
		case <-timer.C:
			t.Fatalf("guest did not receive TCP flags %s", flags)
		}
	}
}

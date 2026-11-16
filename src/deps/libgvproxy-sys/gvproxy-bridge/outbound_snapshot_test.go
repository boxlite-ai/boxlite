package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

// Disable pauses before suspension; enable pauses after the real NIC has
// enabled. Both expose a live NIC while the policy's disabled gate is required.
type pausedNICOperations struct {
	nicOperations
	entered chan string
	resume  chan struct{}
}

func (n *pausedNICOperations) DisableNIC(id tcpip.NICID) tcpip.Error {
	n.entered <- "disable"
	<-n.resume
	return n.nicOperations.DisableNIC(id)
}

func (n *pausedNICOperations) EnableNIC(id tcpip.NICID) tcpip.Error {
	if err := n.nicOperations.EnableNIC(id); err != nil {
		return err
	}
	n.entered <- "enable"
	<-n.resume
	return nil
}

func snapshotRequest(policy *outboundPolicyController, method, body string) <-chan *httptest.ResponseRecorder {
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		policy.ServeHTTP(response, httptest.NewRequest(method, "/network/outbound", strings.NewReader(body)))
		done <- response
	}()
	return done
}

func TestOutboundSnapshot_ModeTransitionGatesBeforeNICCompletion(t *testing.T) {
	tap := startNetwork(t, []string{"api.example.com"})
	upstream, port := listenUDP(t)
	send := registeredDNSProbe(t, tap, "udp", port)
	control := modeDNSQuery(t, 1)
	if err := send(control); err != nil {
		t.Fatal(err)
	}
	receivePolicyProbe(t, upstream, control)
	for index, step := range []struct{ action, body string }{
		{"disable", `{"mode":"disabled"}`},
		{"enable", `{"mode":"enabled"}`},
	} {
		paused := &pausedNICOperations{nicOperations: tap.policy.stack,
			entered: make(chan string, 1), resume: make(chan struct{})}
		var once sync.Once
		release := func() { once.Do(func() { close(paused.resume) }) }
		t.Cleanup(release)
		tap.policy.nicOps = paused
		updated := snapshotRequest(tap.policy, http.MethodPut, step.body)
		select {
		case action := <-paused.entered:
			if action != step.action {
				t.Fatalf("NIC operation: %s, want %s", action, step.action)
			}
		case <-time.After(forwardWindow):
			t.Fatal("NIC transition was not entered")
		}
		select {
		case response := <-updated:
			t.Fatalf("premature application acknowledgement: %d", response.Code)
		default:
		}
		select {
		case response := <-snapshotRequest(tap.policy, http.MethodGet, ""):
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("pending application readback: %d %s", response.Code, response.Body)
			}
		case <-time.After(forwardWindow):
			t.Fatal("pending readback blocked behind the update lock")
		}
		_ = send(modeDNSQuery(t, uint16(index+2)))
		assertDatagramDropped(t, upstream, "DNS during paused %s", step.action)
		release()
		select {
		case response := <-updated:
			if response.Code != http.StatusOK {
				t.Fatalf("completed application: %d %s", response.Code, response.Body)
			}
		case <-time.After(forwardWindow):
			t.Fatal("released NIC operation did not finish")
		}
	}
	control = modeDNSQuery(t, 4)
	if err := send(control); err != nil {
		t.Fatal(err)
	}
	receivePolicyProbe(t, upstream, control)
}

func TestOutboundSnapshot_DelayedResolutionKeepsCapturedTransport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "captured snapshot")
	}))
	t.Cleanup(server.Close)
	entered, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(resume) }) }
	t.Cleanup(release)
	var oldCalls, newCalls atomic.Int32
	cfg := testGvproxyConfig()
	cfg.AllowNet = []string{"api.example.com"}
	tap := startNetworkWithSeams(t, cfg, networkSeams{
		resolve: func(ctx context.Context, _ string) ([]net.IP, error) {
			close(entered)
			select {
			case <-resume:
				return []net.IP{net.ParseIP("198.51.100.8")}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
		dial: refuseDial,
		connect: func(ctx context.Context, _ egressTarget) (net.Conn, error) {
			oldCalls.Add(1)
			return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
		},
	})
	dial := startGuestStack(t, tap, cfg)
	conn, err := dial("192.0.2.99", 80)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	request := "GET / HTTP/1.1\r\nHost: api.example.com\r\nConnection: close\r\n\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(forwardWindow):
		t.Fatal("old flow did not enter controlled resolution")
	}
	replacePolicy(t, tap, `{"mode":"enabled","allow_net":["other.example.com"]}`, http.StatusOK)
	// Configure the new snapshot's network seams without changing its compiled
	// policy. An old flow must retain the prior resolver and connector.
	current := *tap.policy.active.Load()
	nextDialer := *current.dialer
	nextDialer.resolve = refuseResolve
	nextDialer.connect = func(context.Context, egressTarget) (net.Conn, error) {
		newCalls.Add(1)
		return nil, fmt.Errorf("new transport must not serve the old flow")
	}
	current.dialer = &nextDialer
	tap.policy.publish(&current, "confirmed")
	release()
	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != "captured snapshot" {
		t.Fatalf("captured flow: %q err=%v", body, err)
	}
	newConn, err := dial("192.0.2.99", 80)
	if err != nil {
		t.Fatal(err)
	}
	defer newConn.Close()
	_ = newConn.SetDeadline(time.Now().Add(forwardWindow))
	_, _ = io.WriteString(newConn, request)
	if _, err := http.ReadResponse(bufio.NewReader(newConn), &http.Request{Method: http.MethodGet}); err == nil {
		t.Fatal("new flow bypassed the replacement policy")
	}
	if oldCalls.Load() != 1 || newCalls.Load() != 0 {
		t.Fatalf("transport ownership: old=%d new=%d", oldCalls.Load(), newCalls.Load())
	}
}

func TestOutboundSnapshot_ModeGatePreservesInputUnderflow(t *testing.T) {
	tap := startNetwork(t, nil)
	tables := tap.policy.stack.IPTables()
	table := tables.GetTable(stack.FilterID, false)
	inputGate, forwardGate := table.BuiltinChains[stack.Input], table.BuiltinChains[stack.Forward]
	input := table.Rules[inputGate].Target.(*outboundModeTarget).next
	forward := table.Rules[forwardGate].Target.(*outboundModeTarget).next
	table.Rules = append([]stack.Rule(nil), table.Rules[:inputGate]...)
	table.BuiltinChains[stack.Input], table.BuiltinChains[stack.Forward] = input, forward
	table.Underflows[stack.Input] = table.BuiltinChains[stack.Output]
	table.Rules[input].Target = &stack.ReturnTarget{NetworkProtocol: header.IPv4ProtocolNumber}
	table.Rules[forward].Target = &stack.DropTarget{NetworkProtocol: header.IPv4ProtocolNumber}
	tables.ReplaceTable(stack.FilterID, table, false)
	upstream, port := listenUDP(t)
	// Native input RETURN uses its own ACCEPT underflow, not the forward
	// chain's DROP. Verify that behavior before installing the project gate.
	tap.send(t, udpFrame(t, unlistedIP, port, []byte(probePayload)))
	receivePolicyProbe(t, upstream, []byte(probePayload))
	if err := installOutboundModeGate(tap.policy.stack, tap.policy.active.Load); err != nil {
		t.Fatal(err)
	}
	tap.send(t, udpFrame(t, unlistedIP, port, []byte(probePayload)))
	receivePolicyProbe(t, upstream, []byte(probePayload))
}

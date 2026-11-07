package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/tcpproxy"
	"github.com/containers/gvisor-tap-vsock/pkg/types"
)

func forwarderRequest(handler http.Handler, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.RemoteAddr = "192.168.127.2:1234"
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func freeForwardAddress(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().String()
}

func TestPortForwarderInstanceCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	handler, err := newPortForwarder(ctx, newControlTestNetwork(t))
	if err != nil {
		t.Fatal(err)
	}
	local := freeForwardAddress(t)
	body := fmt.Sprintf(`{"local":%q,"remote":"192.168.127.2:18081"}`, local)
	if w := forwarderRequest(handler, "/expose", body); w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	defer forwarderRequest(handler, "/unexpose", body)
	client, err := net.Dial("tcp", local)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	cancel()
	client.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := client.Read(make([]byte, 1)); err == nil || isTimeout(err) {
		t.Fatalf("instance cancellation did not close accepted connection: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		w := forwarderRequest(handler, "/all", "")
		if strings.TrimSpace(w.Body.String()) == "[]" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("instance cancellation left listeners registered: %s", w.Body.String())
		}
		runtime.Gosched()
	}
	if w := forwarderRequest(handler, "/expose", body); w.Code == http.StatusOK {
		t.Fatal("canceled instance accepted a new mapping")
	}
}

func isTimeout(err error) bool { e, ok := err.(net.Error); return ok && e.Timeout() }

func TestPortForwarderCompatibility(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h, err := newPortForwarder(ctx, newControlTestNetwork(t))
	if err != nil {
		t.Fatal(err)
	}
	local := freeForwardAddress(t)
	body := fmt.Sprintf(`{"local":%q,"remote":":18081"}`, local)
	if w := forwarderRequest(h, "/all", ""); strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatal(w.Body.String())
	}
	if w := forwarderRequest(h, "/expose", body); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	defer forwarderRequest(h, "/unexpose", body)
	if w := forwarderRequest(h, "/expose", body); w.Code != 500 || !strings.Contains(w.Body.String(), "proxy already running") {
		t.Fatal(w.Code, w.Body.String())
	}
	udp := fmt.Sprintf(`{"protocol":"udp","local":%q,"remote":"192.168.127.2:53"}`, local)
	if w := forwarderRequest(h, "/expose", udp); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	defer forwarderRequest(h, "/unexpose", udp)
	var mappings []types.ExposeRequest
	w := forwarderRequest(h, "/all", "")
	if err := json.Unmarshal(w.Body.Bytes(), &mappings); err != nil {
		t.Fatal(err)
	}
	if len(mappings) != 2 || mappings[0].Protocol != types.TCP || mappings[0].Remote != "192.168.127.2:18081" || mappings[1].Protocol != types.UDP {
		t.Fatalf("unexpected mapping list: %+v", mappings)
	}
	// Unexpose ignores unknown fields, as upstream's UnexposeRequest does.
	unexpose := fmt.Sprintf(`{"local":%q,"remote":123}`, local)
	if w := forwarderRequest(h, "/unexpose", unexpose); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := forwarderRequest(h, "/unexpose", body); w.Code != 500 || !strings.Contains(w.Body.String(), "proxy not found") {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := forwarderRequest(h, "/expose", body); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for _, bad := range []string{`{`, `{"local":"127.0.0.1:0","remote":"missing-port"}`} {
		if w := forwarderRequest(h, "/expose", bad); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	conflict := fmt.Sprintf(`{"local":%q,"remote":"192.168.127.2:80"}`, occupied.Addr().String())
	if w := forwarderRequest(h, "/expose", conflict); w.Code != 500 || !strings.Contains(w.Body.String(), "address already in use") {
		t.Fatal(w.Code, w.Body.String())
	}
	badMethod := httptest.NewRecorder()
	h.ServeHTTP(badMethod, httptest.NewRequest(http.MethodGet, "/expose", nil))
	if badMethod.Code != 400 {
		t.Fatal(badMethod.Code)
	}
}

func TestRelayTargetCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		client, left := idleTestPair()
		right, guest := idleTestPair()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		defer func() {
			cancel()
			client.Close()
			guest.Close()
			left.Close()
			right.Close()
			synctest.Wait()
		}()
		target := &relayTarget{ctx: ctx, dial: func(context.Context, string) (net.Conn, error) { return right, nil }}
		go func() { target.HandleConn(left); close(done) }()
		synctest.Wait()
		cancel()
		synctest.Wait()
		select {
		case <-done:
		default:
			t.Fatal("canceled target left copy tasks running")
		}
	})
}

func TestRelayTargetBufferedHalfClose(t *testing.T) {
	client, left := tunnelTCPPair(t)
	right, guest := tunnelTCPPair(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	target := &relayTarget{ctx: ctx, dial: func(context.Context, string) (net.Conn, error) { return right, nil }}
	go func() { target.HandleConn(&tcpproxy.Conn{Conn: left, Peeked: []byte("prefix-")}); close(done) }()
	client.Write([]byte("suffix"))
	client.CloseWrite()
	guest.SetDeadline(time.Now().Add(time.Second))
	got, err := io.ReadAll(guest)
	if err != nil || string(got) != "prefix-suffix" {
		t.Fatalf("guest read = %q, %v", got, err)
	}
	guest.Write([]byte("reply"))
	guest.CloseWrite()
	client.SetDeadline(time.Now().Add(time.Second))
	got, err = io.ReadAll(client)
	if err != nil || string(got) != "reply" {
		t.Fatalf("client reply = %q, %v", got, err)
	}
	awaitTunnelClosed(t, done)
}

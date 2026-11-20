package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func managedSocketConfig(t *testing.T) GvproxyConfig {
	t.Helper()
	dir, err := os.MkdirTemp("", "gv-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	cfg := testGvproxyConfig()
	cfg.SocketPath = filepath.Join(dir, "guest")
	cfg.ControlSocketPath = filepath.Join(dir, "control")
	cfg.OutboundRevision = "startup"
	return cfg
}

func TestManagedStartupBindsAndUpdatesThroughHostSocket(t *testing.T) {
	cfg := managedSocketConfig(t)
	managed := &managedNetworkStartup{route: &managedRouteConfig{
		Scheme: "https", Host: "8.8.8.8", Port: 443,
		DoHURL: "https://cloudflare-dns.com/dns-query", DoHAddress: netip.MustParseAddrPort("1.1.1.1:443"),
	}}
	id, err := startGvproxy(cfg, managed)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { destroyGvproxy(id) })

	dialer := &net.Dialer{}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, "unix", cfg.ControlSocketPath)
	}}
	t.Cleanup(transport.CloseIdleConnections)
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	request := func(method, path, body, nextRevision string, want int) string {
		t.Helper()
		req, err := http.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if nextRevision != "" {
			req.Header.Set("If-Match", outboundETag("startup"))
			req.Header.Set(outboundRevisionHeader, nextRevision)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != want {
			t.Fatalf("%s %s got HTTP %d and %v, want HTTP %d", method, path, response.StatusCode, err, want)
		}
		return string(data)
	}
	request(http.MethodPut, "/network/outbound", `{"mode":"enabled"}`, "", http.StatusConflict)
	request(http.MethodPost, "/services/dns/add", `{"name":"tenant.test."}`, "", http.StatusOK)
	if all := request(http.MethodGet, "/services/dns/all", "", "", http.StatusOK); !strings.Contains(all, "tenant.test.") {
		t.Fatal("DNS control did not use the managed zone store")
	}
	request(http.MethodPut, outboundSnapshotPath, `{"mode":"enabled","proxy_route":null}`, "unbound", http.StatusOK)
	request(http.MethodPut, "/network/outbound", `{"mode":"enabled"}`, "", http.StatusOK)

	// 100 Continue proves the server entered the PUT handler and is reading
	// the body. Stop the instance without sending the rest of the request.
	control, err := net.Dial("unix", cfg.ControlSocketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	if err := control.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprint(control, "PUT /network/outbound HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	status, err := bufio.NewReader(control).ReadString('\n')
	if err != nil || !strings.Contains(status, "100 Continue") {
		t.Fatalf("PUT did not reach body reading: %q, %v", status, err)
	}
	done := make(chan bool, 1)
	go func() { done <- destroyGvproxy(id) }()
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("managed instance was not destroyed")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("managed shutdown waited for the client to send the request body")
	}
	if _, err := os.Stat(cfg.SocketPath); !os.IsNotExist(err) {
		t.Fatalf("guest socket still exists after shutdown: %v", err)
	}
}

func TestManagedStartupRemovesGuestSocketOnControlBindFailure(t *testing.T) {
	cfg := managedSocketConfig(t)
	// A nonempty directory survives stale-socket removal and cannot be bound.
	if err := os.Mkdir(cfg.ControlSocketPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg.ControlSocketPath, "keep"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := startGvproxy(cfg, &managedNetworkStartup{}); err == nil || !strings.Contains(err.Error(), "services socket") {
		t.Fatalf("expected the managed startup to fail at the control socket, got %v", err)
	}
	if _, err := os.Stat(cfg.SocketPath); !os.IsNotExist(err) {
		t.Fatalf("guest socket survived the startup rollback: %v", err)
	}
}

func TestManagedStartupAllowsDisabledNetwork(t *testing.T) {
	cfg := managedSocketConfig(t)
	cfg.OutboundDisabled = true
	id, err := startGvproxy(cfg, &managedNetworkStartup{})
	if err != nil {
		t.Fatal(err)
	}
	if !destroyGvproxy(id) {
		t.Fatal("managed instance was not destroyed")
	}
}

func TestManagedStartupRejectsInvalidRoute(t *testing.T) {
	cfg := managedSocketConfig(t)
	managed := &managedNetworkStartup{route: &managedRouteConfig{
		Scheme: "https", Host: "127.0.0.1", Port: 443,
		DoHURL: "https://cloudflare-dns.com/dns-query", DoHAddress: netip.MustParseAddrPort("1.1.1.1:443"),
	}}
	if _, err := startGvproxy(cfg, managed); err == nil || !strings.Contains(err.Error(), "invalid registered proxy address") {
		t.Fatalf("expected the managed startup to reject the proxy address, got %v", err)
	}
	for _, path := range []string{cfg.SocketPath, cfg.ControlSocketPath} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("managed startup left a socket after rejection: %v", err)
		}
	}
}

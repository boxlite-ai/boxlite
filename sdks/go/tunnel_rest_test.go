//go:build unix

package boxlite

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// localhost is a tunnel target as callers write it.
func localhost(port int) *net.TCPAddr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port}
}

// newTunnelCloud fakes the cloud API for one box and records each tunnel
// prepare body. CONNECT requests are accepted and held open, so a tunnel
// whose URI names this server can be consumed.
func newTunnelCloud(t *testing.T) (*httptest.Server, chan string) {
	t.Helper()
	bodies := make(chan string, 8)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodConnect:
			conn, buffered, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.Close()
			_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
			_, _ = io.Copy(io.Discard, buffered)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/box1":
			_, _ = io.WriteString(w, `{"box_id":"box1","status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","image":"alpine","cpus":1,"memory_mib":256}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/config":
			_, _ = io.WriteString(w, `{"capabilities":{"private_tunnels_enabled":true}}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/boxes/box1/network/tunnel" && r.URL.RawQuery == "port=3000":
			body, _ := io.ReadAll(r.Body)
			bodies <- string(body)
			w.Header().Set("Content-Type", "application/json")
			if strings.Contains(string(body), `"isPublic":false`) {
				_, _ = fmt.Fprintf(w, `{"uri":%q,"isPublic":false,"token":"blt_created_token"}`, server.URL)
				return
			}
			_, _ = fmt.Fprintf(w, `{"uri":%q,"isPublic":true,"token":null}`, server.URL)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server, bodies
}

// isPublic is a new optional request field: omitted or at its default it must
// stay off the wire; only a private tunnel sends it.
func TestTunnelSendsIsPublicOnlyWhenPrivate(t *testing.T) {
	server, bodies := newTunnelCloud(t)
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	box, err := rt.Get(context.Background(), "box1")
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	network, err := box.Network()
	if err != nil {
		t.Fatal(err)
	}
	defer network.Close()
	for _, test := range []struct {
		name string
		opts TunnelOptions
		body string
	}{
		{"default", DefaultTunnelOptions(), ""},
		{"private", TunnelOptions{IsPublic: false}, `{"isPublic":false}`},
	} {
		tunnel, err := network.Tunnel(context.Background(), localhost(3000), test.opts)
		if err != nil {
			t.Fatalf("%s: %v", test.name, err)
		}
		if body := <-bodies; body != test.body {
			t.Fatalf("%s: prepare body = %q, want %q", test.name, body, test.body)
		}
		_ = tunnel.Close()
	}
	tunnel, err := network.Tunnel(context.Background(), &net.TCPAddr{IP: net.IPv6loopback, Port: 3000}, DefaultTunnelOptions())
	if err != nil {
		t.Fatal(err)
	}
	if body := <-bodies; body != "" {
		t.Fatalf("IPv6 public tunnel sent body %q", body)
	}
	_ = tunnel.Close()
	for _, target := range []*net.TCPAddr{
		nil,
		(*net.TCPAddr)(nil),
		&net.TCPAddr{Port: 0},
		&net.TCPAddr{Port: -1},
		&net.TCPAddr{Port: 65536},
		&net.TCPAddr{Port: 3000, Zone: "eth0"},
		&net.TCPAddr{IP: net.IP{1, 2}, Port: 3000},
		&net.TCPAddr{IP: net.IPv4(10, 0, 0, 5), Port: 3000},
	} {
		if _, err := network.Tunnel(context.Background(), target, DefaultTunnelOptions()); err == nil {
			t.Fatalf("Tunnel accepted target %v outside the box", target)
		}
	}
	select {
	case body := <-bodies:
		t.Fatalf("rejected Tunnel call sent prepare body %q", body)
	default:
	}
}

// The token is shown once, so it must stay readable after Connect consumes
// the tunnel and frees its native handle.
func TestConsumedTunnelStillReportsDescriptor(t *testing.T) {
	server, bodies := newTunnelCloud(t)
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	box, err := rt.Get(context.Background(), "box1")
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	network, err := box.Network()
	if err != nil {
		t.Fatal(err)
	}
	defer network.Close()
	tunnel, err := network.Tunnel(context.Background(), localhost(3000), TunnelOptions{IsPublic: false})
	if err != nil {
		t.Fatal(err)
	}
	<-bodies
	conn, err := tunnel.Connect(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := tunnel.Connect(context.Background()); err == nil {
		t.Fatal("tunnel was not consumed by Connect")
	}
	got, err := tunnel.Descriptor()
	if err != nil || got.URI != server.URL || got.IsPublic || got.Token == nil || *got.Token != "blt_created_token" {
		t.Fatalf("Descriptor() after Connect = %+v, %v", got, err)
	}
	if uri, err := tunnel.URI(); err != nil || uri != server.URL {
		t.Fatalf("URI() after Connect = %q, %v; want %q", uri, err, server.URL)
	}
}

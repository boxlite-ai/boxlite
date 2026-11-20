package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
)

func platformGuardTestConfig(t *testing.T, protected []string) GvproxyConfig {
	t.Helper()
	cfg := testGvproxyConfig()
	cfg.AllowNet = []string{unlistedIP}
	startup := struct {
		GvproxyConfig
		Protected []string `json:"platform_protected_cidrs"`
	}{cfg, protected}
	raw, err := json.Marshal(startup)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _, err := decodeGvproxyStartup(raw)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}

func TestPlatformGuardTCPTranslatedDestination(t *testing.T) {
	for _, tt := range []struct {
		name      string
		protected []string
		cloud     bool
	}{
		{name: "local default"},
		{name: "operator denies translated endpoint", protected: []string{"::ffff:127.0.0.1/128"}},
		{name: "Cloud denies translated loopback", cloud: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var dials atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(w, r.Body)
			}))
			defer server.Close()

			cfg := platformGuardTestConfig(t, tt.protected)
			tap := startNetworkWithSeams(t, cfg, networkSeams{
				cloud: tt.cloud,
				connect: func(ctx context.Context, _ egressTarget) (net.Conn, error) {
					dials.Add(1)
					return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
				},
			})
			body, err := extendedGuestHTTP(startGuestStack(t, tap, cfg), 8080,
				"POST / HTTP/1.0\r\nHost: test.example\r\nContent-Length: 5\r\n\r\nhello")
			if tt.cloud || len(tt.protected) != 0 {
				if err == nil || dials.Load() != 0 {
					t.Fatalf("protected translated endpoint: guest error=%v, host dials=%d", err, dials.Load())
				}
				return
			}
			if err != nil || body != "hello" || dials.Load() != 1 {
				t.Fatalf("local guest: body=%q, error=%v, host dials=%d", body, err, dials.Load())
			}
		})
	}
}

func TestPlatformGuardUDPOriginalDestination(t *testing.T) {
	for _, tt := range []struct {
		name      string
		protected []string
		cloud     bool
		denied    bool
	}{
		{name: "local default"},
		{name: "guarded permitted endpoint", protected: []string{"192.0.2.0/24"}},
		{name: "operator denies original endpoint", protected: []string{unlistedIP + "/32"}, denied: true},
		{name: "Cloud denies translated loopback", cloud: true, denied: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			target, port := newUDPTestTarget(t)
			cfg := platformGuardTestConfig(t, tt.protected)
			tap := startNetworkWithSeams(t, cfg, networkSeams{cloud: tt.cloud, dial: target.dial})
			tap.send(t, udpFrameFrom(t, cfg.GuestIP, unlistedIP, guestSrcPort, port, []byte("hello")))
			if tt.denied {
				assertDatagramDropped(t, target.conn, "protected original endpoint")
				if target.dials.Load() != 0 {
					t.Fatalf("protected original endpoint reached the dial hook")
				}
				return
			}
			if len(tt.protected) != 0 {
				target.requireDial(t, "127.0.0.1", port)
			}
			target.echo(t, tap, unlistedIP, guestSrcPort, port, "hello")
		})
	}
}

func TestPlatformGuardTCPDNSCandidates(t *testing.T) {
	for _, tt := range []struct {
		name  string
		rules *trustedTCPRules
		cloud bool
	}{
		{name: "legacy"},
		{name: "extended", rules: &trustedTCPRules{allow: []string{"api.example.com"}}},
		{name: "Cloud legacy", cloud: true},
		{name: "Cloud extended", cloud: true, rules: &trustedTCPRules{allow: []string{"api.example.com", "10.0.0.0/8"}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(w, r.Body)
			}))
			defer server.Close()
			dials := make(chan netip.Addr, 2)
			cfg := platformGuardTestConfig(t, []string{"192.0.2.0/24"})
			cfg.AllowNet = []string{"api.example.com"}
			if tt.cloud {
				cfg.AllowNet = append(cfg.AllowNet, "10.0.0.0/8")
			}
			tap := startNetworkWithSeams(t, cfg, networkSeams{
				cloud:   tt.cloud,
				tcp:     tt.rules,
				resolve: staticResolve("::ffff:192.0.2.8", "::ffff:10.0.0.8", "203.0.113.16"),
				connect: func(ctx context.Context, target egressTarget) (net.Conn, error) {
					dials <- target.ConnectionIP
					return (&net.Dialer{}).DialContext(ctx, "tcp", server.Listener.Addr().String())
				},
			})
			body, err := extendedGuestHTTP(startGuestStack(t, tap, cfg), 80,
				"POST / HTTP/1.0\r\nHost: api.example.com\r\nContent-Length: 5\r\n\r\nhello")
			if err != nil || body != "hello" || len(dials) != 1 {
				t.Fatalf("guest: body=%q, error=%v, host dials=%d", body, err, len(dials))
			}
			if got := <-dials; got != netip.MustParseAddr("203.0.113.16") {
				t.Fatalf("host dial = %s, want 203.0.113.16", got)
			}
		})
	}
}

func TestPlatformGuardStartupValidation(t *testing.T) {
	for _, complete := range []bool{false, true} {
		for _, tt := range []struct {
			name  string
			cidr  string
			valid bool
		}{
			{name: "mapped IPv4", cidr: "::ffff:192.0.2.3/120", valid: true},
			{name: "native IPv6", cidr: "2001:db8::/32"},
			{name: "non-mapped IPv6 prefix", cidr: "::ffff:192.0.2.3/95"},
			{name: "malformed CIDR", cidr: "192.0.2.0/33"},
		} {
			name := "flat"
			if complete {
				name = "complete"
			}
			t.Run(name+"/"+tt.name, func(t *testing.T) {
				cfg := testGvproxyConfig()
				cfg.PlatformProtectedCIDRs = []string{tt.cidr}
				var startup any = cfg
				if complete {
					startup = map[string]any{
						"config": cfg,
						"outbound_v1": completeOutboundStartup{Snapshot: completeOutboundSnapshot{
							Policy:    completeOutboundPolicy{Mode: "enabled", AllowNet: []string{}, DenyNet: []string{}},
							Revision:  "initial",
							Admission: legacyAdmission,
						}},
					}
				}
				raw, err := json.Marshal(startup)
				if err != nil {
					t.Fatal(err)
				}
				decoded, _, err := decodeGvproxyStartup(raw)
				if !tt.valid {
					if err == nil {
						t.Fatalf("invalid platform CIDR %q accepted", tt.cidr)
					}
					return
				}
				if err != nil || !decoded.guard.denies(netip.MustParseAddr("192.0.2.8")) ||
					decoded.guard.denies(netip.MustParseAddr("192.0.3.8")) {
					t.Fatalf("invalid matched range: CIDRs=%v, error=%v", decoded.guard.protected, err)
				}
			})
		}
	}
}

func TestPlatformGuardSurvivesPolicyReplacement(t *testing.T) {
	t.Run("local protected range", func(t *testing.T) {
		checkGuardSurvivesReplacement(t, []string{"127.0.0.0/8"}, false)
	})
	t.Run("Cloud built-in range", func(t *testing.T) {
		checkGuardSurvivesReplacement(t, nil, true)
	})
}

func checkGuardSurvivesReplacement(t *testing.T, protected []string, cloud bool) {
	t.Helper()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
	}))
	defer server.Close()
	port := uint16(server.Listener.Addr().(*net.TCPAddr).Port)
	cfg := platformGuardTestConfig(t, protected)
	tap := startNetworkWithSeams(t, cfg, networkSeams{cloud: cloud})
	dial := startGuestStack(t, tap, cfg)

	for _, body := range []string{
		`{"mode":"enabled","allow_net":[]}`,
		`{"mode":"enabled","allow_net":["` + unlistedIP + `"]}`,
	} {
		response := httptest.NewRecorder()
		tap.policy.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/network/outbound", strings.NewReader(body)))
		if response.Code != http.StatusOK {
			t.Fatalf("replace Box policy: status=%d, body=%s", response.Code, response.Body)
		}
		_, err := extendedGuestHTTP(dial, port, "GET / HTTP/1.0\r\nHost: test.example\r\n\r\n")
		if err == nil || requests.Load() != 0 {
			t.Fatalf("replacement admitted protected socket: guest error=%v, host requests=%d", err, requests.Load())
		}
	}

	response := httptest.NewRecorder()
	body := `{"mode":"enabled","allow_net":[],"platform_protected_cidrs":[]}`
	tap.policy.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/network/outbound", strings.NewReader(body)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("Box policy replaced operator settings: status=%d", response.Code)
	}
}

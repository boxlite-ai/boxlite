package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
)

func TestManagedCloudScopeAtStartup(t *testing.T) {
	for _, format := range []string{"legacy", "complete"} {
		t.Run(format, func(t *testing.T) { testCloudScopeAtStartup(t, format) })
	}
}

func testCloudScopeAtStartup(t *testing.T, format string) {
	scope := map[string]any{
		"version": 1, "stage": "dev", "box": "test-box",
		"instance": "00112233445566778899aabbccddeeff",
		"runner":   "192.0.2.0/26", "cloud_run": "192.0.2.64/26",
		"managed_proxy": "192.0.2.128/26", "gke_pods": "192.0.2.192/26",
		"gke_services": "198.51.100.192/26", "private_services": "203.0.113.192/26",
	}
	for _, tc := range []struct {
		name, field string
		value       any
		valid       bool
	}{
		{name: "complete", valid: true},
		{name: "public Runner IPv6 range", field: "runner_ipv6", value: "2600:1900:4000::/64", valid: true},
		{name: "unique-local Runner IPv6 range", field: "runner_ipv6", value: "fd12:3456::/64"},
		{name: "noncanonical Runner IPv6 range", field: "runner_ipv6", value: "2600:1900:4000::1/64"},
		{name: "documentation IPv6 range", field: "runner_ipv6", value: "2001:db8:4000::/64"},
		{name: "missing managed subnet", field: "managed_proxy"},
		{name: "invalid range", field: "gke_services", value: "198.51.100.1/26"},
		{name: "unknown version", field: "version", value: 2},
		{name: "missing instance", field: "instance"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate := make(map[string]any)
			for k, v := range scope {
				candidate[k] = v
			}
			if tc.field != "" {
				delete(candidate, tc.field)
				if tc.value != nil {
					candidate[tc.field] = tc.value
				}
			}
			wire := cloudScopeStartupWire(t, format, map[string]any{"subnet": "192.168.65.0/24", "cloud_scope": candidate})
			cfg, _, err := decodeGvproxyStartup(wire)
			if !tc.valid {
				if err == nil {
					t.Fatal("incomplete managed scope was accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, address := range []string{"192.0.2.13", "192.0.2.69", "192.0.2.145", "192.0.2.210", "198.51.100.201", "203.0.113.210", "::ffff:169.254.169.254", "199.36.153.9"} {
				if !cfg.guard.denies(netip.MustParseAddr(address)) {
					t.Errorf("managed address %s was allowed", address)
				}
			}
			if cfg.guard.denies(netip.MustParseAddr("203.0.113.50")) {
				t.Error("public address was denied")
			}
			if cfg.guard.supportsIPv6() {
				t.Error("an IPv6 declaration alone qualified the forwarding interface")
			}
		})
	}
}

func TestManagedCloudIPv6RequiresRouteBeforeGuestLinkStart(t *testing.T) {
	config := testGvproxyConfig()
	config.CloudScope = &cloudScope{
		Version: 1, Stage: "dev", Box: "test-box", Instance: "00112233445566778899aabbccddeeff",
		Runner: "192.0.2.0/26", CloudRun: "192.0.2.64/26", ManagedProxy: "192.0.2.128/26",
		GKEPods: "192.0.2.192/26", GKEServices: "198.51.100.192/26", PrivateServices: "203.0.113.192/26",
	}
	if err := config.preparePlatformScope(); err != nil {
		t.Fatal(err)
	}
	ipv4 := completeOutboundSnapshot{
		Policy:    completeOutboundPolicy{Mode: "enabled", AllowNet: []string{}, DenyNet: []string{}},
		Admission: extendedAdmission, Revision: "test-cloud-link",
	}
	initial, _, err := ipv4.prepare(false)
	if err != nil {
		t.Fatal(err)
	}
	tap := buildTapConfig(config, types.QemuProtocol)
	_, policy, err := newGvproxyNetwork(t.Context(), tap, config, nil, nil, initial)
	if err != nil {
		t.Fatalf("IPv4 policy failed on an IPv4-only Runner: %v", err)
	}
	t.Cleanup(policy.stack.Close)
	response := httptest.NewRecorder()
	config.CloudScope.status(response, httptest.NewRequest(http.MethodGet, cloudScopeStatus, nil), policy)
	var readback struct {
		Scope         cloudScope `json:"scope"`
		IPv6Qualified bool       `json:"ipv6_qualified"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &readback); err != nil || readback.Scope != *config.CloudScope || readback.IPv6Qualified {
		t.Fatalf("IPv4 readback did not report the active scope alone: %s (%v)", response.Body, err)
	}

	ipv6 := ipv4
	ipv6.Admission = dualStackAdmission
	ipv6.IPv6 = &ipv6LinkPlan{Interface: "eth0",
		Guest: netip.MustParseAddr("fd12:3456:789a:1::2"), Gateway: netip.MustParseAddr("fd12:3456:789a:1::1")}
	candidate, _, err := ipv6.prepare(false)
	if err != nil {
		t.Fatal(err)
	}
	network, policy, err := newGvproxyNetwork(t.Context(), tap, config, nil, nil, candidate)
	if err == nil || !strings.Contains(err.Error(), "no public IPv6 declaration") || network != nil || policy != nil {
		t.Fatalf("Cloud started a Guest IPv6 link on an IPv4-only Runner: %v", err)
	}
}

func TestDisabledGuestIPv6ReadbackRequiresAcknowledgement(t *testing.T) {
	config := optInIPv6(t)
	plan := &ipv6LinkPlan{Interface: "eth0", Guest: netip.MustParseAddr("fd12:3456:789a:1::2"),
		Gateway: config.ipv6Gateway.Addr()}
	initial, _, err := (completeOutboundSnapshot{
		Policy:    completeOutboundPolicy{Mode: "disabled", AllowNet: []string{}, DenyNet: []string{}},
		Admission: dualStackAdmission, Revision: "test-disabled-link", IPv6: plan,
	}).prepare(false)
	if err != nil {
		t.Fatal(err)
	}
	_, policy, err := newGvproxyNetwork(t.Context(), buildTapConfig(config, types.QemuProtocol), config, nil, nil, initial)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(policy.stack.Close)
	scope := cloudScope{Version: 1, Box: "test-box"}
	assertReady := func(want bool) {
		t.Helper()
		response := httptest.NewRecorder()
		scope.status(response, httptest.NewRequest(http.MethodGet, cloudScopeStatus, nil), policy)
		var report struct {
			IPv6          *ipv6LinkPlan `json:"ipv6"`
			IPv6Qualified bool          `json:"ipv6_qualified"`
			IPv6Ready     bool          `json:"ipv6_ready"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &report); err != nil ||
			!sameIPv6Plan(report.IPv6, plan) || !report.IPv6Qualified || report.IPv6Ready != want {
			t.Fatalf("disabled Guest readiness must be %t: %s (%v)", want, response.Body, err)
		}
	}
	assertReady(false)
	challenge := httptest.NewRecorder()
	policy.serveIPv6Readiness(challenge, httptest.NewRequest(http.MethodGet, ipv6ReadinessPath, nil))
	if challenge.Code != http.StatusOK {
		t.Fatalf("challenge: %s", challenge.Body)
	}
	reply := httptest.NewRecorder()
	policy.serveIPv6Readiness(reply, httptest.NewRequest(http.MethodPost, ipv6ReadinessPath, bytes.NewReader(challenge.Body.Bytes())))
	if reply.Code != http.StatusNoContent {
		t.Fatalf("acknowledgement: %s", reply.Body)
	}
	assertReady(true)
}

func TestManagedCloudScopeDoesNotFallBackToLocal(t *testing.T) {
	for _, format := range []string{"legacy", "complete"} {
		t.Run(format, func(t *testing.T) {
			for _, key := range []string{"cloud_guard", "cloud_scope"} {
				wire := cloudScopeStartupWire(t, format, map[string]any{key: nil})
				if _, _, err := decodeGvproxyStartup(wire); err == nil {
					t.Errorf("explicit null %s must fail closed", key)
				}
			}
		})
	}
}

func cloudScopeStartupWire(t *testing.T, format string, config map[string]any) []byte {
	t.Helper()
	input := config
	if format == "complete" {
		input = map[string]any{
			"config": config,
			"outbound_v1": completeOutboundStartup{Snapshot: completeOutboundSnapshot{
				Policy:   completeOutboundPolicy{Mode: "enabled", AllowNet: []string{}, DenyNet: []string{}},
				Revision: "test", Admission: legacyAdmission,
			}},
		}
	}
	wire, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return wire
}

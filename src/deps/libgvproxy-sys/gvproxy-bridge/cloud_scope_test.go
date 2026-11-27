package main

import (
	"encoding/json"
	"net/netip"
	"testing"
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
	}{
		{name: "complete"},
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
			if tc.field != "" {
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
		})
	}
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

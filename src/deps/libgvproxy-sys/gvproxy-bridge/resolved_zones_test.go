package main

import (
	"net"
	"testing"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
)

// TestResolvedHostIPsFromZones verifies the glue that feeds the SNI↔IP binding:
// it extracts the concrete A-record IPs the allow_net sinkhole resolved, while
// ignoring wildcard regexp records and the 0.0.0.0 sinkhole default.
func TestResolvedHostIPsFromZones(t *testing.T) {
	zones := []types.Zone{
		{
			Name: "openai.com.",
			Records: []types.Record{
				{Name: "api", IP: net.ParseIP("203.0.113.10").To4()},
				{Name: "api", IP: net.ParseIP("203.0.113.11").To4()},
			},
		},
		{
			Name:      "example.com.",
			Records:   []types.Record{{IP: net.IPv4zero}}, // sinkhole default — must be ignored
			DefaultIP: net.IPv4zero,
		},
		{Name: ""}, // catch-all sinkhole zone, no records
	}

	got := resolvedHostIPsFromZones(zones)
	want := map[string]bool{"203.0.113.10": true, "203.0.113.11": true}
	if len(got) != len(want) {
		t.Fatalf("got %d IPs (%v), want %d", len(got), got, len(want))
	}
	for _, ip := range got {
		if !want[ip.String()] {
			t.Errorf("unexpected extracted IP %s (0.0.0.0 / wildcard records must be excluded)", ip)
		}
	}
}

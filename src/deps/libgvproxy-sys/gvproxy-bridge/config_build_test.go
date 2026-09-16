package main

import (
	"net"
	"reflect"
	"testing"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
)

func testGvproxyConfig() GvproxyConfig {
	return GvproxyConfig{
		SocketPath: "/tmp/test-gvproxy.sock",
		Subnet:     "192.168.127.0/24",
		GatewayIP:  "192.168.127.1",
		GatewayMac: "5a:94:ef:e4:0c:dd",
		GuestIP:    "192.168.127.2",
		HostIP:     "192.168.127.254",
		GuestMac:   "5a:94:ef:e4:0c:ee",
		MTU:        1500,
		DNSZones: []DNSZone{
			{
				Name: "boxlite.internal.",
				Records: []DNSRecord{
					{
						Name: "host",
						IP:   "192.168.127.254",
					},
				},
			},
		},
	}
}

func TestBuildTapConfig_UsesHostAliasDNSZone(t *testing.T) {
	tapConfig := buildTapConfig(testGvproxyConfig(), types.QemuProtocol)

	if len(tapConfig.DNS) == 0 {
		t.Fatal("expected at least one DNS zone")
	}

	zone := tapConfig.DNS[0]
	if zone.Name != "boxlite.internal." {
		t.Fatalf("expected first DNS zone to be boxlite.internal., got %q", zone.Name)
	}
	if len(zone.Records) != 1 {
		t.Fatalf("expected one DNS record, got %d", len(zone.Records))
	}
	if zone.Records[0].Name != "host" {
		t.Fatalf("expected host record, got %q", zone.Records[0].Name)
	}
	if !zone.Records[0].IP.Equal(net.ParseIP("192.168.127.254")) {
		t.Fatalf("expected host alias to resolve to 192.168.127.254, got %v", zone.Records[0].IP)
	}
}

// allow_net does not touch DNS. It is enforced when the gateway dials
// (forked_tcp.go, egress_dialer.go), so the zones the box serves are the
// built-ins whatever the allowlist says. An earlier design appended a root
// sinkhole here; a zone with an empty Name suffix-matches every query, so this
// asserts against that shape specifically and fails if it is reintroduced in
// any form.
func TestBuildDNSZones_DNSIsNeverFilteredByAllowNet(t *testing.T) {
	open := buildDNSZones(testGvproxyConfig())

	config := testGvproxyConfig()
	config.AllowNet = []string{"example.com", "*.example.net"}
	closed := buildDNSZones(config)

	if !reflect.DeepEqual(open, closed) {
		t.Fatalf("allow_net must not change the served zones:\n without = %+v\n with    = %+v", open, closed)
	}
	for _, zone := range closed {
		if zone.Name == "" {
			t.Fatalf("a zone with an empty name is a sinkhole over every query; allow_net must not add one: %+v", zone)
		}
	}
}

func TestBuildTapConfig_RoutesHostAliasToLoopback(t *testing.T) {
	tapConfig := buildTapConfig(testGvproxyConfig(), types.QemuProtocol)

	if got := tapConfig.NAT["192.168.127.254"]; got != "127.0.0.1" {
		t.Fatalf("expected host IP NAT to loopback, got %q", got)
	}

	foundHostIP := false
	for _, ip := range tapConfig.GatewayVirtualIPs {
		if ip == "192.168.127.254" {
			foundHostIP = true
			break
		}
	}
	if !foundHostIP {
		t.Fatal("expected host IP in GatewayVirtualIPs")
	}
}

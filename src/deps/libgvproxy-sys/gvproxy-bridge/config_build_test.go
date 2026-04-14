package main

import (
	"net"
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

func TestBuildTapConfig_KeepsBuiltinZonesBeforeAllowNet(t *testing.T) {
	config := testGvproxyConfig()
	config.AllowNet = []string{"example.com"}

	tapConfig := buildTapConfig(config, types.QemuProtocol)

	if len(tapConfig.DNS) < 2 {
		t.Fatalf("expected built-in and allowlist DNS zones, got %d", len(tapConfig.DNS))
	}
	if tapConfig.DNS[0].Name != "boxlite.internal." {
		t.Fatalf("expected built-in zone first, got %q", tapConfig.DNS[0].Name)
	}
	lastZone := tapConfig.DNS[len(tapConfig.DNS)-1]
	if lastZone.Name != "" {
		t.Fatalf("expected allowlist root sinkhole zone last, got %q", lastZone.Name)
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

package main

import (
	"reflect"
	"testing"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
)

// TestStackFieldExists validates that VirtualNetwork has a "stack" field.
// If gvisor-tap-vsock renames or removes this field, this test fails fast
// instead of a silent runtime panic in OverrideTCPHandler.
func TestStackFieldExists(t *testing.T) {
	config := &types.Configuration{
		Subnet:            "192.168.127.0/24",
		GatewayIP:         "192.168.127.1",
		GatewayMacAddress: "5a:94:ef:e4:0c:dd",
		DHCPStaticLeases: map[string]string{
			"192.168.127.2": "5a:94:ef:e4:0c:ee",
		},
		NAT:               map[string]string{},
		Forwards:          map[string]string{},
		GatewayVirtualIPs: []string{"192.168.127.1"},
		Protocol:          types.VfkitProtocol,
	}

	vn, err := virtualnetwork.New(config)
	if err != nil {
		t.Fatalf("virtualnetwork.New() failed: %v", err)
	}

	v := reflect.ValueOf(vn).Elem()
	stackField := v.FieldByName("stack")
	if !stackField.IsValid() {
		t.Fatal("VirtualNetwork has no 'stack' field — " +
			"gvisor-tap-vsock API changed. Update OverrideTCPHandler.")
	}
	if stackField.Kind() != reflect.Ptr {
		t.Fatalf("expected stack to be a pointer, got %s", stackField.Kind())
	}
}

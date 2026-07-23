package main

// forked_network.go — Override gvproxy's TCP handler after creation.
//
// After virtualnetwork.New() creates the network stack with the default
// TCP forwarder, we replace it with our filtered version.
//
// stack.SetTransportProtocolHandler() is a public gVisor API.
// The only use of reflect+unsafe is to access VirtualNetwork's private
// `stack` field. This is guarded by forked_network_test.go.

import (
	"fmt"
	"net"
	"reflect"
	"sync"
	"unsafe"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
	logrus "github.com/sirupsen/logrus"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

// OverrideTCPHandler replaces the default TCP protocol handler on an
// existing VirtualNetwork with our filtered version.
func OverrideTCPHandler(
	vn *virtualnetwork.VirtualNetwork,
	config *types.Configuration,
	ec2MetadataAccess bool,
	filter *TCPFilter,
	ca *BoxCA,
	secretMatcher *SecretHostMatcher,
) error {
	// Access private stack field via reflect
	v := reflect.ValueOf(vn).Elem()
	stackField := v.FieldByName("stack")
	if !stackField.IsValid() {
		return fmt.Errorf("VirtualNetwork has no 'stack' field (gvisor-tap-vsock API changed?)")
	}

	// #nosec G103 — accessing private field to override TCP handler
	s := (*stack.Stack)(unsafe.Pointer(stackField.Pointer()))

	// Rebuild NAT table (same logic as upstream parseNATTable in services.go)
	nat := make(map[tcpip.Address]tcpip.Address)
	for source, destination := range config.NAT {
		nat[tcpip.AddrFrom4Slice(net.ParseIP(source).To4())] =
			tcpip.AddrFrom4Slice(net.ParseIP(destination).To4())
	}

	// Replace TCP handler with our filtered version
	var natLock sync.Mutex
	tcpFwd := TCPWithFilter(s, nat, &natLock, ec2MetadataAccess, filter, ca, secretMatcher)
	s.SetTransportProtocolHandler(tcp.ProtocolNumber, tcpFwd.HandlePacket)

	logrus.Info("allowNet TCP: handler overridden with SNI-inspecting forwarder")
	return nil
}

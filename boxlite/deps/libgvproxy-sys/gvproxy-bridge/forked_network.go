package main

// forked_network.go — Override gvproxy's TCP handler after creation.
//
// Kubernetes-style approach: instead of patching vendored gvisor-tap-vsock
// code, we use reflect+unsafe to access the private stack field and replace
// the TCP protocol handler with our own version that routes through a proxy.
//
// This keeps all vendored code unmodified. Running `go mod vendor` is safe.

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

// OverrideTCPHandler replaces the TCP protocol handler on an existing
// VirtualNetwork with our custom forwarder that routes through a proxy.
//
// This uses reflect+unsafe to access VirtualNetwork's private `stack` field.
// The trade-off is accepted: it avoids patching vendored code while giving
// us full control over outbound TCP connections.
func OverrideTCPHandler(vn *virtualnetwork.VirtualNetwork, config *types.Configuration, dialFn DialFunc) error {
	// Access private stack field via reflect
	v := reflect.ValueOf(vn).Elem()
	stackField := v.FieldByName("stack")

	if !stackField.IsValid() {
		return fmt.Errorf("VirtualNetwork has no 'stack' field (gvisor-tap-vsock API changed?)")
	}

	// Get the *stack.Stack pointer
	// #nosec G103 — accessing private field for TCP handler override
	s := (*stack.Stack)(unsafe.Pointer(stackField.Pointer()))

	// Build NAT table (same logic as upstream parseNATTable)
	nat := make(map[tcpip.Address]tcpip.Address)
	for source, destination := range config.NAT {
		nat[tcpip.AddrFrom4Slice(net.ParseIP(source).To4())] =
			tcpip.AddrFrom4Slice(net.ParseIP(destination).To4())
	}

	// Replace TCP handler with our version that uses dialFunc
	var natLock sync.Mutex
	tcpFwd := TCPWithDial(s, nat, &natLock, config.Ec2MetadataAccess, dialFn)
	s.SetTransportProtocolHandler(tcp.ProtocolNumber, tcpFwd.HandlePacket)

	logrus.Info("TCP handler overridden with proxy-aware forwarder")
	return nil
}

package main

// forked_network.go — Install BoxLite's filtered transport handlers on an
// existing VirtualNetwork.
//
// virtualnetwork.New() registers upstream's unfiltered TCP and UDP forwarders
// (gvisor-tap-vsock services.go:27-30). installAllowNetHandlers replaces both
// from one place, so a transport cannot be quietly left on the unfiltered
// default — that gap is what made allow_net a TCP-only control.
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
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

// installAllowNetHandlers replaces the default TCP and UDP protocol handlers
// with BoxLite's filtered versions.
//
// A returned error must be fatal to box creation: the handlers left in place
// are upstream's, which forward every destination.
func installAllowNetHandlers(
	vn *virtualnetwork.VirtualNetwork,
	config *types.Configuration,
	ec2MetadataAccess bool,
	filter *AllowNetFilter,
	ca *BoxCA,
	secretMatcher *SecretHostMatcher,
) error {
	s, err := stackOf(vn)
	if err != nil {
		return err
	}

	// One NAT table and one lock shared by both transports, matching
	// upstream's addServices (services.go:23-30).
	nat := natTable(config)
	var natLock sync.Mutex

	tcpFwd := TCPWithFilter(s, nat, &natLock, ec2MetadataAccess, filter, ca, secretMatcher)
	s.SetTransportProtocolHandler(tcp.ProtocolNumber, tcpFwd.HandlePacket)
	logrus.Info("allowNet TCP: handler overridden with SNI-inspecting forwarder")

	s.SetTransportProtocolHandler(udp.ProtocolNumber, UDPWithFilter(s, nat, &natLock, filter))
	logrus.Info("allowNet UDP: handler overridden with allowlist-checking forwarder")

	return nil
}

// stackOf reaches VirtualNetwork's unexported gVisor stack, the only handle
// that allows replacing transport handlers after construction.
func stackOf(vn *virtualnetwork.VirtualNetwork) (*stack.Stack, error) {
	v := reflect.ValueOf(vn).Elem()
	stackField := v.FieldByName("stack")
	if !stackField.IsValid() {
		return nil, fmt.Errorf("VirtualNetwork has no 'stack' field (gvisor-tap-vsock API changed?)")
	}

	// #nosec G103 — accessing private field to override transport handlers
	return (*stack.Stack)(unsafe.Pointer(stackField.Pointer())), nil
}

// natTable rebuilds gvproxy's address translation map (same logic as upstream
// parseNATTable in services.go).
func natTable(config *types.Configuration) map[tcpip.Address]tcpip.Address {
	nat := make(map[tcpip.Address]tcpip.Address)
	for source, destination := range config.NAT {
		nat[tcpip.AddrFrom4Slice(net.ParseIP(source).To4())] =
			tcpip.AddrFrom4Slice(net.ParseIP(destination).To4())
	}
	return nat
}

package main

// forked_network.go — Install BoxLite's filtered transport handlers on an
// existing VirtualNetwork.
//
// virtualnetwork.New() registers upstream's unfiltered TCP and UDP forwarders
// (gvisor-tap-vsock services.go:27-30). installOutboundHandlers replaces both
// from one place, so a transport cannot be quietly left on the unfiltered
// default — that gap is what made allow_net a TCP-only control.
//
// stack.SetTransportProtocolHandler() is a public gVisor API.
// The only use of reflect+unsafe is to access VirtualNetwork's private
// `stack` field. This is guarded by forked_network_test.go.

import (
	"context"
	"encoding/hex"
	"fmt"
	"net"
	"net/netip"
	"reflect"
	"sync"
	"unsafe"

	"github.com/boxlite/gvproxy-bridge/internal/guardinventory"
	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
	logrus "github.com/sirupsen/logrus"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

func newGvproxyNetwork(ctx context.Context, config *types.Configuration, startup GvproxyConfig, ca *BoxCA, secrets *SecretHostMatcher, initial outboundPolicy) (*virtualnetwork.VirtualNetwork, *outboundPolicyController, error) {
	var vn *virtualnetwork.VirtualNetwork
	var resolve resolveFunc
	var inventory guardinventory.Observation
	var err error
	if startup.guard.cloud {
		inventory, err = guardinventory.Sample(ctx, startup.cloudInventoryDirectory)
		if err != nil {
			return nil, nil, err
		}
		if launch := startup.CloudGuard; launch != nil {
			if launch.Revision != inventory.Revision || launch.Digest != hex.EncodeToString(inventory.Digest[:]) {
				return nil, nil, fmt.Errorf("Cloud inventory does not match the launch identity")
			}
			if err := launch.hostOperation(ctx, "check", nil); err != nil {
				return nil, nil, err
			}
		}
		startup.guard.protected = append(append([]netip.Prefix(nil), startup.guard.protected...), inventory.Protected...)
		startup.guard.epoch = newCloudGuardEpoch(ctx, inventory)
		resolver := &cloudDNSResolver{endpoints: inventory.Resolvers, epoch: startup.guard.epoch}
		resolve = resolver.lookupHost
		network, err := virtualnetwork.NewWithDNSResolver(startup.guard.epoch.ctx, config, resolver)
		if err != nil {
			startup.guard.epoch.retire()
			return nil, nil, fmt.Errorf("initialize Cloud virtual network: %w", err)
		}
		vn = network
	} else {
		vn, err = virtualnetwork.New(config)
		if err != nil {
			return nil, nil, fmt.Errorf("initialize virtual network: %w", err)
		}
	}
	policy, err := newOutboundPolicyController(startup.guard.trafficContext(ctx), vn, config, startup, ca, secrets, initial, resolve)
	if err != nil {
		if startup.guard.epoch != nil {
			startup.guard.epoch.retire()
		}
		return nil, nil, fmt.Errorf("initialize outbound policy: %w", err)
	}
	if startup.guard.epoch != nil {
		if !startup.guard.active() {
			startup.guard.epoch.retire()
			policy.stack.Close()
			return nil, nil, fmt.Errorf("Cloud inventory expired during network initialization")
		}
		policy.inventory = inventory
		go func() {
			startup.guard.epoch.watch(startup.cloudInventoryDirectory, inventory)
			if launch := startup.CloudGuard; launch != nil {
				if err := launch.hostOperation(context.Background(), "revoke", nil); err != nil {
					logrus.WithError(err).Warn("Cloud guard revocation notification failed")
				}
			}
		}()
	}
	return vn, policy, nil
}

// installOutboundHandlers installs both snapshot-aware transport handlers
// before guest traffic starts.
func installOutboundHandlers(
	s *stack.Stack,
	config *types.Configuration,
	snapshot snapshotSource,
	tcpInspectionSlots chan struct{},
	udpFlows *udpFlowPool,
	ca *BoxCA,
	secretMatcher *SecretHostMatcher,
) {
	// One NAT table and one lock shared by both transports, matching
	// upstream's addServices (services.go:23-30).
	nat := natTable(config)
	var natLock sync.Mutex

	tcpFwd := TCPWithFilter(s, nat, &natLock, config.Ec2MetadataAccess, snapshot, tcpInspectionSlots, ca, secretMatcher)
	s.SetTransportProtocolHandler(tcp.ProtocolNumber, tcpFwd.HandlePacket)
	logrus.Info("allowNet TCP: handler overridden with SNI-inspecting forwarder")

	s.SetTransportProtocolHandler(udp.ProtocolNumber, outboundUDPHandler(s, nat, &natLock, snapshot, udpFlows))
	logrus.Info("outbound UDP: installed policy-aware forwarder")
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

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
	"golang.org/x/sys/unix"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv6"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

func TestGuestLinkDropsTruncatedEthernet(t *testing.T) {
	config := udpServiceConfig()
	link := startNetworkWith(t, config)

	link.send(t, []byte{0x02})
	requireUDPServiceReplies(t, link, config)
}

type ipv6TestLink struct {
	peer       net.Conn
	stream     bool
	network    *virtualnetwork.VirtualNetwork
	policy     *outboundPolicyController
	guestMAC   tcpip.LinkAddress
	gatewayMAC tcpip.LinkAddress
	shaper     *shapedConn
}

type linkReadyConn struct {
	net.Conn
	once  sync.Once
	ready chan struct{}
}

func (conn *linkReadyConn) Read(data []byte) (int, error) {
	conn.once.Do(func() { close(conn.ready) })
	return conn.Conn.Read(data)
}

func openIPv6TestLink(t *testing.T, protocol types.Protocol, config GvproxyConfig, initial outboundPolicy, wrap func(net.Conn) net.Conn) *ipv6TestLink {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	network, policy, err := newGvproxyNetwork(ctx, buildTapConfig(config, protocol), config, nil, nil, initial)
	if err != nil {
		t.Fatal(err)
	}
	stream := protocol == types.QemuProtocol
	socketType, prefix := unix.SOCK_DGRAM, 0
	accept := network.AcceptVfkit
	if stream {
		socketType, prefix = unix.SOCK_STREAM, 4
		accept = network.AcceptQemu
	}
	fds, err := unix.Socketpair(unix.AF_UNIX, socketType, 0)
	if err != nil {
		t.Fatal(err)
	}
	var sockets [2]net.Conn
	for i, fd := range fds {
		file := os.NewFile(uintptr(fd), "test-guest-link")
		conn, err := net.FileConn(file)
		_ = file.Close()
		if err != nil {
			if i == 0 {
				_ = unix.Close(fds[1])
			}
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		sockets[i] = conn
	}
	stopped := make(chan struct{})
	connection := sockets[1]
	if wrap != nil {
		connection = wrap(connection)
	}
	attached := &linkReadyConn{Conn: connection, ready: make(chan struct{})}
	var shaper *shapedConn
	go func() {
		defer close(stopped)
		_ = policy.runGuestLink(ctx, attached, prefix, config.RateLimit, func(ctx context.Context, conn net.Conn) error {
			shaper, _ = conn.(*shapedConn)
			return accept(ctx, conn)
		})
	}()
	t.Cleanup(func() {
		_ = policy.stack.DisableNIC(policy.nic)
		cancel()
		_ = sockets[0].Close()
		select {
		case <-stopped:
		case <-time.After(2 * time.Second):
			t.Error("guest link did not stop")
		}
		policy.stack.Close()
		policy.stack.Wait()
	})
	select {
	case <-attached.ready:
	case <-stopped:
		t.Fatal("guest link stopped before reading")
	case <-time.After(2 * time.Second):
		t.Fatal("guest link did not start reading")
	}
	return &ipv6TestLink{
		peer: sockets[0], stream: stream, network: network, policy: policy,
		guestMAC: mac(t, config.GuestMac), gatewayMAC: mac(t, config.GatewayMac),
		shaper: shaper,
	}
}

func optInIPv6(t *testing.T) GvproxyConfig {
	t.Helper()
	config := udpServiceConfig()
	gateway := netip.MustParsePrefix("fd12:3456:789a:1::1/64")
	config.ipv6Gateway = &gateway
	return config
}

func (l *ipv6TestLink) send(t *testing.T, frame []byte) {
	t.Helper()
	if l.stream {
		frame = append(binary.BigEndian.AppendUint32(nil, uint32(len(frame))), frame...)
	}
	if err := l.peer.SetWriteDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := l.peer.Write(frame); err != nil {
		t.Fatal(err)
	}
}

func (l *ipv6TestLink) receive(t *testing.T, kind header.ICMPv6Type) (header.Ethernet, header.IPv6) {
	t.Helper()
	if err := l.peer.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	for {
		frame, err := l.readFrame()
		if err != nil {
			t.Fatalf("read ICMPv6 type %d: %v", kind, err)
		}
		if len(frame) < header.EthernetMinimumSize || header.Ethernet(frame).Type() != ipv6.ProtocolNumber {
			continue
		}
		ip := header.IPv6(frame[header.EthernetMinimumSize:])
		if ip.IsValid(len(ip)) && ip.TransportProtocol() == header.ICMPv6ProtocolNumber &&
			ip.PayloadLength() >= header.ICMPv6MinimumSize && header.ICMPv6(ip.Payload()).Type() == kind {
			return header.Ethernet(frame), ip
		}
	}
}

func (l *ipv6TestLink) readFrame() ([]byte, error) {
	if l.stream {
		var size [4]byte
		if _, err := io.ReadFull(l.peer, size[:]); err != nil {
			return nil, err
		}
		frame := make([]byte, binary.BigEndian.Uint32(size[:]))
		_, err := io.ReadFull(l.peer, frame)
		return frame, err
	}
	frame := make([]byte, 2048)
	n, err := l.peer.Read(frame)
	return frame[:n], err
}

func (l *ipv6TestLink) cam(t *testing.T) map[string]int {
	t.Helper()
	response := httptest.NewRecorder()
	l.network.ServicesMux().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/cam", nil))
	var table map[string]int
	if err := json.Unmarshal(response.Body.Bytes(), &table); err != nil {
		t.Fatal(err)
	}
	return table
}

func (l *ipv6TestLink) received() uint64 {
	return l.policy.stack.NICInfo()[l.policy.nic].NetworkStats[ipv6.ProtocolNumber].(*ipv6.Stats).IPStats().PacketsReceived.Value()
}

func linkIPv6(text string) tcpip.Address {
	return tcpip.AddrFrom16(netip.MustParseAddr(text).As16())
}

func ipv6Frame(sourceMAC, destinationMAC tcpip.LinkAddress, src, dst tcpip.Address, next tcpip.TransportProtocolNumber, body []byte) []byte {
	frame := make([]byte, header.EthernetMinimumSize+header.IPv6MinimumSize+len(body))
	header.Ethernet(frame).Encode(&header.EthernetFields{SrcAddr: sourceMAC, DstAddr: destinationMAC, Type: ipv6.ProtocolNumber})
	ip := header.IPv6(frame[header.EthernetMinimumSize:])
	ip.Encode(&header.IPv6Fields{SrcAddr: src, DstAddr: dst, HopLimit: 255, TransportProtocol: next, PayloadLength: uint16(len(body))})
	copy(ip.Payload(), body)
	return frame
}

func icmp6Frame(sourceMAC, destinationMAC tcpip.LinkAddress, src, dst tcpip.Address, message header.ICMPv6) []byte {
	message.SetChecksum(header.ICMPv6Checksum(header.ICMPv6ChecksumParams{Header: message, Src: src, Dst: dst}))
	return ipv6Frame(sourceMAC, destinationMAC, src, dst, header.ICMPv6ProtocolNumber, message)
}

func solicitation(target tcpip.Address, hardware tcpip.LinkAddress) header.ICMPv6 {
	var options header.NDPOptionsSerializer
	if hardware != "" {
		options = append(options, header.NDPSourceLinkLayerAddressOption(hardware))
	}
	message := make(header.ICMPv6, header.ICMPv6NeighborSolicitMinimumSize+options.Length())
	message.SetType(header.ICMPv6NeighborSolicit)
	body := header.NDPNeighborSolicit(message.MessageBody())
	body.SetTargetAddress(target)
	body.Options().Serialize(options)
	return message
}

func advertisement(target tcpip.Address, hardware tcpip.LinkAddress) header.ICMPv6 {
	options := header.NDPOptionsSerializer{header.NDPTargetLinkLayerAddressOption(hardware)}
	message := make(header.ICMPv6, header.ICMPv6NeighborAdvertMinimumSize+options.Length())
	message.SetType(header.ICMPv6NeighborAdvert)
	body := header.NDPNeighborAdvert(message.MessageBody())
	body.SetTargetAddress(target)
	body.SetSolicitedFlag(true)
	body.SetOverrideFlag(true)
	body.Options().Serialize(options)
	return message
}

func (l *ipv6TestLink) echo(t *testing.T, source, gateway tcpip.Address) {
	t.Helper()
	payload := []byte("boxlite ipv6")
	message := make(header.ICMPv6, header.ICMPv6EchoMinimumSize+len(payload))
	message.SetType(header.ICMPv6EchoRequest)
	message.SetIdent(1)
	copy(message[header.ICMPv6EchoMinimumSize:], payload)
	l.send(t, icmp6Frame(l.guestMAC, l.gatewayMAC, source, gateway, message))
	frame, ip := l.receive(t, header.ICMPv6EchoReply)
	if frame.SourceAddress() != l.gatewayMAC || frame.DestinationAddress() != l.guestMAC ||
		ip.SourceAddress() != gateway || ip.DestinationAddress() != source ||
		!bytes.Equal(ip.Payload()[header.ICMPv6EchoMinimumSize:], payload) {
		t.Fatalf("unexpected echo reply: %s to %s, payload %x", ip.SourceAddress(), ip.DestinationAddress(), ip.Payload())
	}
}

func TestIPv6LinkNeighborDiscovery(t *testing.T) {
	for _, protocol := range []types.Protocol{types.QemuProtocol, types.VfkitProtocol} {
		t.Run(string(protocol), func(t *testing.T) {
			link := openIPv6TestLink(t, protocol, optInIPv6(t), outboundPolicy{Mode: "enabled"}, nil)
			gateway, guest := linkIPv6("fd12:3456:789a:1::1"), linkIPv6("fd12:3456:789a:1::2")
			link.requireRoutes(t, gateway)
			route, err := link.policy.stack.FindRoute(link.policy.nic, gateway, guest, ipv6.ProtocolNumber, false)
			if err != nil {
				t.Fatalf("find route: %s", err)
			}
			defer route.Release()
			if _, learned := link.cam(t)[link.guestMAC.String()]; learned {
				t.Fatal("guest MAC was learned before any frame")
			}
			resolved := make(chan stack.ResolvedFieldsResult, 1)
			route.ResolvedFields(func(result stack.ResolvedFieldsResult) { resolved <- result })
			frame, ip := link.receive(t, header.ICMPv6NeighborSolicit)
			target := header.NDPNeighborSolicit(header.ICMPv6(ip.Payload()).MessageBody()).TargetAddress()
			if target != guest || frame.DestinationAddress() != header.EthernetAddressFromMulticastIPv6Address(header.SolicitedNodeAddr(guest)) {
				t.Fatalf("gateway did not multicast a solicitation for %s", guest)
			}
			link.send(t, icmp6Frame(link.guestMAC, link.gatewayMAC, guest, gateway, advertisement(guest, link.guestMAC)))
			select {
			case result := <-resolved:
				if result.Err != nil || result.RouteInfo.RemoteLinkAddress != link.guestMAC {
					t.Fatalf("resolve neighbor: %+v", result)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("gateway did not learn from neighbor advertisement")
			}
			group := header.SolicitedNodeAddr(gateway)
			link.send(t, icmp6Frame(link.guestMAC, header.EthernetAddressFromMulticastIPv6Address(group), guest, group, solicitation(gateway, link.guestMAC)))
			na, ip := link.receive(t, header.ICMPv6NeighborAdvert)
			if na.SourceAddress() != link.gatewayMAC || ip.SourceAddress() != gateway {
				t.Fatalf("neighbor advertisement did not come from the gateway")
			}
			link.echo(t, guest, gateway)

			localGateway, localGuest := header.LinkLocalAddr(link.gatewayMAC), header.LinkLocalAddr(link.guestMAC)
			link.policy.stack.AddStaticNeighbor(link.policy.nic, ipv6.ProtocolNumber, localGuest, link.guestMAC)
			link.echo(t, localGuest, localGateway)
		})
	}
}

func (l *ipv6TestLink) requireRoutes(t *testing.T, gateway tcpip.Address) {
	t.Helper()
	nic := l.policy.stack.NICInfo()[l.policy.nic]
	addresses := make(map[tcpip.Address]int)
	for _, address := range nic.ProtocolAddresses {
		if address.Protocol == ipv6.ProtocolNumber {
			addresses[address.AddressWithPrefix.Address] = address.AddressWithPrefix.PrefixLen
		}
	}
	wantAddresses := map[tcpip.Address]int{gateway: 64, header.LinkLocalAddr(l.gatewayMAC): 64}
	if !reflect.DeepEqual(addresses, wantAddresses) || nic.Forwarding[ipv6.ProtocolNumber] {
		t.Fatalf("unexpected IPv6 addresses or forwarding: %v, %v", addresses, nic.Forwarding)
	}
	routes := make(map[string]bool)
	for _, route := range l.policy.stack.GetRouteTable() {
		if route.NIC != l.policy.nic || route.Gateway.BitLen() != 0 {
			t.Fatalf("unexpected routed interface or gateway: %+v", route)
		}
		routes[route.Destination.String()] = true
	}
	wantRoutes := map[string]bool{"192.168.127.0/24": true, "fd12:3456:789a:1::/64": true, "fe80::/64": true}
	if !reflect.DeepEqual(routes, wantRoutes) {
		t.Fatalf("unexpected on-link routes: %v", routes)
	}
}

func TestIPv6LinkSourceAndProtocolBoundary(t *testing.T) {
	for _, protocol := range []types.Protocol{types.QemuProtocol, types.VfkitProtocol} {
		t.Run(string(protocol), func(t *testing.T) {
			link := openIPv6TestLink(t, protocol, optInIPv6(t), outboundPolicy{Mode: "enabled"}, nil)
			gateway, guest := linkIPv6("fd12:3456:789a:1::1"), linkIPv6("fd12:3456:789a:1::2")
			link.policy.stack.AddStaticNeighbor(link.policy.nic, ipv6.ProtocolNumber, guest, link.guestMAC)
			group := header.SolicitedNodeAddr(gateway)
			groupMAC := header.EthernetAddressFromMulticastIPv6Address(group)
			testMAC := mac(t, "02:60:50:40:30:20")

			before := link.received()
			link.send(t, icmp6Frame(testMAC, groupMAC, header.IPv6Any, group, solicitation(gateway, "")))
			ad, ip := link.receive(t, header.ICMPv6NeighborAdvert)
			if ip.DestinationAddress() != header.IPv6AllNodesMulticastAddress ||
				ad.DestinationAddress() != header.EthernetAddressFromMulticastIPv6Address(ip.DestinationAddress()) ||
				link.received() != before+1 {
				t.Fatal("DAD did not reach gVisor or return an all-nodes advertisement")
			}
			if _, learned := link.cam(t)[testMAC.String()]; learned {
				t.Fatal("DAD learned a MAC from an unspecified-source frame")
			}

			echo := func(from, to tcpip.Address) []byte {
				message := make(header.ICMPv6, header.ICMPv6EchoMinimumSize)
				message.SetType(header.ICMPv6EchoRequest)
				return icmp6Frame(testMAC, link.gatewayMAC, from, to, message)
			}
			routerAd := make(header.ICMPv6, 16)
			routerAd.SetType(header.ICMPv6RouterAdvert)
			for name, frame := range map[string][]byte{
				"off-link source":        echo(linkIPv6("fd12:3456:789a:2::2"), gateway),
				"off-link destination":   echo(guest, linkIPv6("fd12:3456:789a:2::1")),
				"mapped source":          echo(linkIPv6("::ffff:192.168.127.2"), gateway),
				"multicast source":       echo(header.IPv6AllNodesMulticastAddress, gateway),
				"unspecified echo":       echo(header.IPv6Any, gateway),
				"unspecified advert":     icmp6Frame(testMAC, link.gatewayMAC, header.IPv6Any, gateway, advertisement(guest, testMAC)),
				"unspecified unicast":    icmp6Frame(testMAC, link.gatewayMAC, header.IPv6Any, gateway, solicitation(gateway, "")),
				"unspecified mismatched": icmp6Frame(testMAC, groupMAC, header.IPv6Any, group, solicitation(guest, "")),
				"wrong multicast MAC":    icmp6Frame(testMAC, link.gatewayMAC, guest, group, solicitation(gateway, testMAC)),
				"router advertisement":   icmp6Frame(testMAC, link.gatewayMAC, header.LinkLocalAddr(testMAC), gateway, routerAd),
				"hop-by-hop options":     ipv6Frame(testMAC, link.gatewayMAC, guest, gateway, 0, []byte{58, 0, 0, 0, 0, 0, 0, 0}),
				"fragment":               ipv6Frame(testMAC, link.gatewayMAC, guest, gateway, 44, []byte{58, 0, 0, 1, 0, 0, 0, 1}),
				"UDP":                    ipv6Frame(testMAC, link.gatewayMAC, guest, gateway, header.UDPProtocolNumber, make([]byte, 8)),
				"TCP":                    ipv6Frame(testMAC, link.gatewayMAC, guest, gateway, header.TCPProtocolNumber, make([]byte, 20)),
				"truncated IPv6":         echo(guest, gateway)[:header.EthernetMinimumSize+header.IPv6MinimumSize-1],
			} {
				t.Run(name, func(t *testing.T) {
					before := link.received()
					link.send(t, frame)
					link.echo(t, guest, gateway)
					if link.received() != before+1 {
						t.Fatal("rejected frame reached the IPv6 endpoint")
					}
					if _, learned := link.cam(t)[testMAC.String()]; learned {
						t.Fatal("rejected frame populated the switch CAM")
					}
				})
			}
			link.requireRoutes(t, gateway)
		})
	}
}

func TestIPv6LinkStartupContract(t *testing.T) {
	const option = `"ipv6_gateway":"fd12:3456:789a:1::1/64"`
	flat, initial, err := decodeGvproxyStartup([]byte("{" + option + "}"))
	if err != nil || flat.ipv6Gateway != nil {
		t.Fatalf("flat startup opted in or failed: %v", err)
	}
	envelope := `{"config":{` + option + `},"outbound_v1":{}}`
	if _, _, err := decodeGvproxyStartup([]byte(envelope)); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("versioned startup accepted the private field: %v", err)
	}
	link := openIPv6TestLink(t, types.QemuProtocol, udpServiceConfig(), initial, nil)
	if link.policy.stack.NetworkProtocolInstance(ipv6.ProtocolNumber) != nil {
		t.Fatal("default startup installed IPv6")
	}
	for _, route := range link.policy.stack.GetRouteTable() {
		if route.Destination.ID().BitLen() == 128 {
			t.Fatalf("default startup installed an IPv6 route: %+v", route)
		}
	}
	gateway := linkIPv6("fd12:3456:789a:1::1")
	group := header.SolicitedNodeAddr(gateway)
	link.send(t, icmp6Frame(link.guestMAC, header.EthernetAddressFromMulticastIPv6Address(group), header.IPv6Any, group, solicitation(gateway, "")))
	if err := link.peer.SetReadDeadline(time.Now().Add(30 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := link.peer.Read(make([]byte, 4)); !os.IsTimeout(err) {
		t.Fatalf("default startup did not ignore IPv6 solicitation: %v", err)
	}
	candidate := completeTestSnapshot("native-ipv6", extendedAdmission)
	candidate.Policy.AllowNet = []string{"2001:db8::8"}
	if _, _, err := candidate.prepare(true); err == nil || !strings.Contains(err.Error(), "native IPv6") {
		t.Fatalf("native IPv6 rule was not explicitly rejected: %v", err)
	}

	for name, change := range map[string]func(*GvproxyConfig){
		"non-ULA":       func(c *GvproxyConfig) { *c.ipv6Gateway = netip.MustParsePrefix("2001:db8::1/64") },
		"wrong prefix":  func(c *GvproxyConfig) { *c.ipv6Gateway = netip.MustParsePrefix("fd12:3456:789a:1::1/65") },
		"zero host":     func(c *GvproxyConfig) { *c.ipv6Gateway = netip.MustParsePrefix("fd12:3456:789a:1::/64") },
		"zero MAC":      func(c *GvproxyConfig) { c.GatewayMac = "00:00:00:00:00:00" },
		"multicast MAC": func(c *GvproxyConfig) { c.GatewayMac = "01:00:5e:00:00:01" },
		"small MTU":     func(c *GvproxyConfig) { c.MTU = 1279 },
	} {
		t.Run(name, func(t *testing.T) {
			config := optInIPv6(t)
			change(&config)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			_, policy, err := newGvproxyNetwork(ctx, buildTapConfig(config, types.QemuProtocol), config, nil, nil, initial)
			if policy != nil {
				policy.stack.Close()
				policy.stack.Wait()
			}
			if err == nil || !strings.Contains(err.Error(), "IPv6 link requires") {
				t.Fatalf("invalid opt-in did not fail at construction: %v", err)
			}
		})
	}
}

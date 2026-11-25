package main

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"testing"
	"time"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
)

type observedGuestLink struct {
	*shapedConn
	owners chan tcpip.PacketOwner
}

func (l observedGuestLink) WriteGuestFrame(frame []byte, owner tcpip.PacketOwner) (int, error) {
	n, err := l.shapedConn.WriteGuestFrame(frame, owner)
	l.owners <- owner
	return n, err
}

func TestManagedLinkFragmentOwnerThroughRealTap(t *testing.T) {
	route, _ := startProxyDNSFixture(t, http.NotFoundHandler())
	cfg := testGvproxyConfig()
	// 2,100 bytes of UDP payload produce three IPv4 fragments at this MTU.
	cfg.MTU = 900
	owners := make(chan tcpip.PacketOwner, 8)
	tap := startNetworkWithSeams(t, cfg, networkSeams{
		beforeAttach: func(ctx context.Context, policy *outboundPolicyController) {
			gateway, err := policy.installManagedNetwork(ctx, route.work, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(gateway.server.close)
		},
		wrapGuestLink: func(conn net.Conn) net.Conn {
			link := newShapedConn(conn, 4, &RateLimitConfig{RX: bucketCfg(65536, 100)}, nil)
			return observedGuestLink{shapedConn: link, owners: owners}
		},
	})

	upstream, port := listenUDP(t)
	generation := tap.policy.active.Load().udpRelay.generation
	tap.send(t, udpFrame(t, unlistedIP, port, []byte("first managed datagram")))
	if err := upstream.SetReadDeadline(time.Now().Add(forwardWindow)); err != nil {
		t.Fatal(err)
	}
	var scratch [64]byte
	_, peer, err := upstream.ReadFrom(scratch[:])
	if err != nil {
		t.Fatal(err)
	}
	if _, err := upstream.WriteTo(bytes.Repeat([]byte{0xbb}, 2100), peer); err != nil {
		t.Fatal(err)
	}

	wait, cancel := context.WithTimeout(context.Background(), forwardWindow)
	defer cancel()
	for range 3 {
		select {
		case owner := <-owners:
			if owner != generation {
				t.Fatal("IPv4 fragment lost its UDP generation")
			}
		case <-wait.Done():
			t.Fatal("IPv4 fragment reached tap without a managed packet owner")
		}
	}
	for received := 0; received < 3; {
		select {
		case frame := <-tap.frames:
			if len(frame) < header.EthernetMinimumSize+header.IPv4MinimumSize || header.Ethernet(frame).Type() != header.IPv4ProtocolNumber {
				continue
			}
			ip := header.IPv4(frame[header.EthernetMinimumSize:])
			if ip.SourceAddress().String() == unlistedIP && (ip.More() || ip.FragmentOffset() != 0) {
				received++
			}
		case <-wait.Done():
			t.Fatal("tagged IPv4 fragments did not reach the guest link")
		}
	}
}

package main

import (
	"context"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/services/forwarder"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
	"gvisor.dev/gvisor/pkg/waiter"
)

const managedUDPRelayLimit = 256

// managedUDP owns setup, both UDP endpoints, and the generation that follows
// replies to the guest link. The legacy forwarding path has its own lifetime.
type managedUDP struct {
	ctx        context.Context
	cancel     context.CancelFunc
	generation *udpLinkGeneration
	forwarder  *udp.Forwarder
	slots      chan struct{}
}

func newManagedUDP(ctx context.Context, s *stack.Stack, nat map[tcpip.Address]tcpip.Address, natLock *sync.Mutex, dial dialFunc) *managedUDP {
	ctx, cancel := context.WithCancel(ctx)
	relay := &managedUDP{
		ctx: ctx, cancel: cancel, generation: newUDPLinkGeneration(),
		slots: make(chan struct{}, managedUDPRelayLimit),
	}
	relay.forwarder = udp.NewForwarder(s, func(request *udp.ForwarderRequest) {
		select {
		case relay.slots <- struct{}{}:
		default:
			return
		}
		if !relay.generation.admit() {
			<-relay.slots
			return
		}
		var queue waiter.Queue
		endpoint, err := request.CreateEndpoint(&queue)
		if err != nil {
			relay.finishFlow()
			return
		}
		endpoint.SetOwner(relay.generation)
		id := request.ID()
		destination := id.LocalAddress
		natLock.Lock()
		if translated, ok := nat[destination]; ok {
			destination = translated
		}
		natLock.Unlock()
		address := net.JoinHostPort(destination.String(), strconv.Itoa(int(id.LocalPort)))
		go relay.runFlow(gonet.NewUDPConn(&queue, endpoint), address, dial)
	})
	return relay
}

func (r *managedUDP) handle(id stack.TransportEndpointID, packet *stack.PacketBuffer) bool {
	if r.ctx.Err() != nil || r.generation.isSealed() {
		return true
	}
	handled := r.forwarder.HandlePacket(id, packet)
	// The pinned Forwarder takes a separate request reference. CreateEndpoint
	// takes its own reference for the endpoint queue, and the request has no
	// release API. Drop only the request's reference here.
	packet.DecRef()
	return handled
}

func (r *managedUDP) seal() {
	r.generation.seal()
	r.cancel()
}

func (r *managedUDP) finishFlow() {
	<-r.slots
	r.generation.finish(false)
}

func (r *managedUDP) runFlow(guest net.Conn, address string, dial dialFunc) {
	defer r.finishFlow()
	closeGuest := sync.OnceFunc(func() { _ = guest.Close() })
	defer closeGuest()
	stopGuest := context.AfterFunc(r.ctx, closeGuest)
	defer stopGuest()

	setup, cancel := context.WithTimeout(r.ctx, upstreamDialTimeout)
	defer cancel()
	if err := guest.SetReadDeadline(time.Now().Add(upstreamDialTimeout)); err != nil {
		return
	}
	first := make([]byte, forwarder.UDPBufSize)
	size, err := guest.Read(first)
	if err != nil || setup.Err() != nil {
		return
	}
	host, err := dial(setup, "udp4", address)
	expired := setup.Err() != nil
	cancel()
	if host == nil {
		return
	}
	closeHost := sync.OnceFunc(func() { _ = host.Close() })
	defer closeHost()
	if err != nil || expired || r.ctx.Err() != nil {
		return
	}
	closeFlow := func() { closeHost(); closeGuest() }
	stopFlow := context.AfterFunc(r.ctx, closeFlow)
	defer stopFlow()

	var idleMu sync.Mutex
	send := func(destination net.Conn, payload []byte) bool {
		if !r.generation.admit() {
			return false
		}
		defer r.generation.finish(false)
		idleMu.Lock()
		deadline := time.Now().Add(forwarder.UDPConnTrackTimeout)
		deadlinesOK := guest.SetDeadline(deadline) == nil && host.SetDeadline(deadline) == nil
		idleMu.Unlock()
		if !deadlinesOK {
			return false
		}
		n, err := destination.Write(payload)
		return err == nil && n == len(payload)
	}
	if !send(host, first[:size]) {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		copyManagedDatagrams(host, guest, make([]byte, forwarder.UDPBufSize), send)
		closeFlow()
	}()
	copyManagedDatagrams(guest, host, first, send)
	closeFlow()
	<-done
}

func copyManagedDatagrams(source, destination net.Conn, scratch []byte, send func(net.Conn, []byte) bool) {
	for {
		n, err := source.Read(scratch)
		if err != nil || !send(destination, scratch[:n]) {
			return
		}
	}
}

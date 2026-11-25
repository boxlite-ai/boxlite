package main

import (
	"context"
	"net"
	"sync"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/services/forwarder"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
	"gvisor.dev/gvisor/pkg/waiter"
)

const maxExtendedUDPFlows = 256
const maxQueuedUDPReplies = 32

type udpFlowPool struct {
	ctx          context.Context
	slots        chan struct{}
	setupTimeout time.Duration
	idleTimeout  time.Duration
	replyWriter  sync.Once
	replyMu      sync.Mutex
	replies      chan udpGuestReply
}

func newUDPFlowPool(ctx context.Context) *udpFlowPool {
	return &udpFlowPool{
		ctx: ctx, slots: make(chan struct{}, maxExtendedUDPFlows),
		setupTimeout: 30 * time.Second, idleTimeout: forwarder.UDPConnTrackTimeout,
		replies: make(chan udpGuestReply, maxQueuedUDPReplies),
	}
}

// admit registers synchronously so a later datagram joins the same endpoint.
// The slot covers setup and both relay directions until cleanup completes.
func (p *udpFlowPool) admit(s *stack.Stack, id stack.TransportEndpointID, pkt *stack.PacketBuffer,
	target egressTarget, dial dialFunc) bool {
	if p.ctx.Err() != nil {
		return false
	}
	select {
	case p.slots <- struct{}{}:
	default:
		return false
	}
	deadline := time.Now().Add(p.setupTimeout)
	fwd := udp.NewForwarder(s, func(request *udp.ForwarderRequest) {
		var queue waiter.Queue
		endpoint, err := request.CreateEndpoint(&queue)
		if err != nil {
			<-p.slots
			return
		}
		go p.relay(gonet.NewUDPConn(&queue, endpoint), target, dial, deadline)
	})
	fwd.HandlePacket(id, pkt)
	// The pinned forwarder retains a request reference without releasing it.
	// CreateEndpoint queues a separate reference for the endpoint reader.
	pkt.DecRef()
	return true
}

func (p *udpFlowPool) relay(guest net.Conn, target egressTarget, dial dialFunc, deadline time.Time) {
	defer func() { <-p.slots }()
	closeGuest := sync.OnceFunc(func() { guest.Close() })
	defer closeGuest()
	stopGuest := context.AfterFunc(p.ctx, closeGuest)
	defer stopGuest()

	setup, cancel := context.WithDeadline(p.ctx, deadline)
	defer cancel()
	// Wait for a readable datagram before opening the external socket.
	buffer := make([]byte, forwarder.UDPBufSize)
	if guest.SetReadDeadline(deadline) != nil {
		return
	}
	n, err := guest.Read(buffer)
	if err != nil || setup.Err() != nil || !time.Now().Before(deadline) {
		return
	}
	host, err := dial(setup, socketFamily("udp", target.ConnectionIP), target.address())
	expired := setup.Err() != nil || !time.Now().Before(deadline)
	cancel()
	if host == nil {
		return
	}
	closeHost := sync.OnceFunc(func() { host.Close() })
	defer closeHost()
	if err != nil || expired {
		return
	}
	stopHost := context.AfterFunc(p.ctx, closeHost)
	defer stopHost()
	flow, stopFlow := context.WithCancel(p.ctx)
	closeFlow := func() {
		stopFlow()
		closeGuest()
		closeHost()
	}
	defer closeFlow()

	relay := udpDatagramRelay{guest: guest, host: host, idleTimeout: p.idleTimeout}
	if !relay.send(host, buffer[:n]) {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		copyUDPDatagrams(host, make([]byte, forwarder.UDPBufSize), func(datagram []byte) bool {
			return relay.refreshDeadline() && p.queueReply(flow, guest, datagram, closeFlow)
		})
		closeFlow()
	}()
	copyUDPDatagrams(guest, buffer, func(datagram []byte) bool { return relay.send(host, datagram) })
	closeFlow()
	<-done
}

type udpGuestReply struct {
	flow      context.Context
	guest     net.Conn
	datagram  []byte
	closeFlow func()
}

// gVisor writes synchronously through the Box link, which can be blocked by
// guest backpressure. One Box-owned writer keeps that wait out of the flow.
func (p *udpFlowPool) queueReply(flow context.Context, guest net.Conn, datagram []byte, closeFlow func()) bool {
	p.replyMu.Lock()
	defer p.replyMu.Unlock()
	if p.ctx.Err() != nil || flow.Err() != nil {
		return false
	}
	p.replyWriter.Do(func() { go p.writeGuestReplies() })
	if len(p.replies) == cap(p.replies) {
		return true // UDP drops during guest-link congestion.
	}
	p.replies <- udpGuestReply{flow: flow, guest: guest, datagram: append([]byte(nil), datagram...), closeFlow: closeFlow}
	return true
}

func (p *udpFlowPool) writeGuestReplies() {
	defer p.discardGuestReplies()
	for p.ctx.Err() == nil {
		select {
		case <-p.ctx.Done():
			return
		case reply := <-p.replies:
			if reply.flow.Err() != nil {
				continue
			}
			n, err := reply.guest.Write(reply.datagram)
			if err != nil || n != len(reply.datagram) {
				reply.closeFlow()
			}
		}
	}
}

func (p *udpFlowPool) discardGuestReplies() {
	p.replyMu.Lock()
	defer p.replyMu.Unlock()
	for len(p.replies) != 0 {
		<-p.replies
	}
}

// One idle deadline is renewed by datagrams in either direction.
type udpDatagramRelay struct {
	guest, host net.Conn
	idleTimeout time.Duration
	mu          sync.Mutex
	deadline    time.Time
}

func copyUDPDatagrams(src net.Conn, buffer []byte, send func([]byte) bool) {
	for {
		n, err := src.Read(buffer)
		if err != nil || !send(buffer[:n]) {
			return
		}
	}
}

func (r *udpDatagramRelay) send(dst net.Conn, datagram []byte) bool {
	if !r.refreshDeadline() {
		return false
	}
	n, err := dst.Write(datagram)
	return err == nil && n == len(datagram)
}

func (r *udpDatagramRelay) refreshDeadline() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	if !r.deadline.IsZero() && !now.Before(r.deadline) {
		return false
	}
	r.deadline = now.Add(r.idleTimeout)
	return r.guest.SetDeadline(r.deadline) == nil && r.host.SetDeadline(r.deadline) == nil
}

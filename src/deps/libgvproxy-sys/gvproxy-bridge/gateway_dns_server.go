package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/miekg/dns"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
)

const (
	gatewayDNSTCPSessions  = 32
	gatewayDNSMessageLimit = 10 * time.Second
)

type gatewayDNSAnswer func(context.Context, *dns.Msg) *dns.Msg

type gatewayDNSServer struct {
	ctx       context.Context
	cancel    context.CancelFunc
	udp       net.PacketConn
	tcp       net.Listener
	answer    gatewayDNSAnswer
	ioLimit   time.Duration
	workers   sync.WaitGroup
	closeOnce sync.Once
	mu        sync.Mutex
	sessions  map[net.Conn]struct{}
}

// replaceGatewayDNS takes ownership of both port 53 sockets before Guest attach.
// Resolve both old endpoints first, so a missing service cannot leave a partial
// replacement behind.
func replaceGatewayDNS(ctx context.Context, s *stack.Stack, nic tcpip.NICID, ip net.IP, answer gatewayDNSAnswer) (*gatewayDNSServer, error) {
	if ip.To4() == nil {
		return nil, fmt.Errorf("gateway DNS requires an IPv4 gateway address")
	}
	local := tcpip.FullAddress{NIC: nic, Addr: tcpip.AddrFrom4Slice(ip.To4()), Port: 53}
	id := stack.TransportEndpointID{LocalAddress: local.Addr, LocalPort: local.Port}
	find := func(protocol tcpip.TransportProtocolNumber) (tcpip.Endpoint, error) {
		endpoint, ok := s.FindTransportEndpoint(ipv4.ProtocolNumber, protocol, id, nic).(tcpip.Endpoint)
		if !ok {
			return nil, fmt.Errorf("missing gateway DNS endpoint for protocol %d", protocol)
		}
		address, err := endpoint.GetLocalAddress()
		if err != nil || address.Addr != local.Addr || address.Port != local.Port {
			return nil, fmt.Errorf("unexpected gateway DNS endpoint for protocol %d", protocol)
		}
		return endpoint, nil
	}
	oldUDP, err := find(udp.ProtocolNumber)
	if err != nil {
		return nil, err
	}
	oldTCP, err := find(tcp.ProtocolNumber)
	if err != nil {
		return nil, err
	}
	oldUDP.Close()
	oldTCP.Close()
	packet, err := gonet.DialUDP(s, &local, nil, ipv4.ProtocolNumber)
	if err != nil {
		return nil, fmt.Errorf("bind gateway DNS UDP: %w", err)
	}
	listener, err := gonet.ListenTCP(s, local, ipv4.ProtocolNumber)
	if err != nil {
		_ = packet.Close()
		return nil, fmt.Errorf("bind gateway DNS TCP: %w", err)
	}
	return serveGatewayDNS(ctx, packet, listener, answer, gatewayDNSMessageLimit), nil
}

func serveGatewayDNS(ctx context.Context, packet net.PacketConn, listener net.Listener, answer gatewayDNSAnswer, ioLimit time.Duration) *gatewayDNSServer {
	ctx, cancel := context.WithCancel(ctx)
	server := &gatewayDNSServer{
		ctx: ctx, cancel: cancel, udp: packet, tcp: listener, answer: answer, ioLimit: ioLimit,
		sessions: make(map[net.Conn]struct{}),
	}
	server.workers.Add(2)
	go server.serveUDP()
	go server.serveTCP()
	go func() {
		<-ctx.Done()
		server.close()
	}()
	return server
}

func (s *gatewayDNSServer) close() {
	s.closeOnce.Do(func() {
		s.cancel()
		_ = s.udp.Close()
		_ = s.tcp.Close()
		s.mu.Lock()
		for conn := range s.sessions {
			_ = conn.Close()
		}
		s.mu.Unlock()
		s.workers.Wait()
	})
}

func (s *gatewayDNSServer) serveUDP() {
	defer s.workers.Done()
	active := make(chan struct{}, dnsConcurrentLookups)
	buffer := make([]byte, dns.MaxMsgSize)
	for s.ctx.Err() == nil {
		n, peer, err := s.udp.ReadFrom(buffer)
		if err != nil {
			return
		}
		select {
		case active <- struct{}{}:
		default:
			continue
		}
		query := new(dns.Msg)
		if err := query.Unpack(buffer[:n]); err != nil {
			<-active
			continue
		}
		s.workers.Add(1)
		go func() {
			defer s.workers.Done()
			defer func() { <-active }()
			reply := s.answer(s.ctx, query)
			if reply == nil || s.ctx.Err() != nil {
				return
			}
			limit := dns.MinMsgSize
			if edns := query.IsEdns0(); edns != nil {
				limit = max(limit, int(edns.UDPSize()))
			}
			reply.Truncate(limit)
			if wire, err := reply.Pack(); err == nil {
				_, _ = s.udp.WriteTo(wire, peer)
			}
		}()
	}
}

func (s *gatewayDNSServer) serveTCP() {
	defer s.workers.Done()
	for s.ctx.Err() == nil {
		conn, err := s.tcp.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.ctx.Err() != nil || len(s.sessions) == gatewayDNSTCPSessions {
			s.mu.Unlock()
			_ = conn.Close()
			continue
		}
		s.sessions[conn] = struct{}{}
		s.mu.Unlock()
		s.workers.Add(1)
		go s.serveSession(conn)
	}
}

func (s *gatewayDNSServer) serveSession(conn net.Conn) {
	defer s.workers.Done()
	defer func() {
		_ = conn.Close()
		s.mu.Lock()
		delete(s.sessions, conn)
		s.mu.Unlock()
	}()
	var size [2]byte
	for s.ctx.Err() == nil {
		if conn.SetReadDeadline(time.Now().Add(s.ioLimit)) != nil {
			return
		}
		if _, err := io.ReadFull(conn, size[:]); err != nil {
			return
		}
		wire := make([]byte, binary.BigEndian.Uint16(size[:]))
		if _, err := io.ReadFull(conn, wire); err != nil {
			return
		}
		query := new(dns.Msg)
		if err := query.Unpack(wire); err != nil {
			return
		}
		reply := s.answer(s.ctx, query)
		if reply == nil || s.ctx.Err() != nil {
			return
		}
		frame, err := reply.Pack()
		if err != nil || len(frame) > dns.MaxMsgSize || conn.SetWriteDeadline(time.Now().Add(s.ioLimit)) != nil {
			return
		}
		binary.BigEndian.PutUint16(size[:], uint16(len(frame)))
		if _, err := conn.Write(append(size[:], frame...)); err != nil {
			return
		}
	}
}

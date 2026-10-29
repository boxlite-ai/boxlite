package tap

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
	"github.com/pkg/errors"
	log "github.com/sirupsen/logrus"
	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
)

type VirtualDevice interface {
	DeliverNetworkPacket(protocol tcpip.NetworkProtocolNumber, pkt *stack.PacketBuffer)
	LinkAddress() tcpip.LinkAddress
	IP() string
}

type NetworkSwitch interface {
	DeliverNetworkPacket(protocol tcpip.NetworkProtocolNumber, pkt *stack.PacketBuffer)
}

type Switch struct {
	Sent     uint64
	Received uint64

	debug               bool
	maxTransmissionUnit int

	nextConnID int
	conns      map[int]protocolConn
	connLock   sync.Mutex

	cam     map[tcpip.LinkAddress]int
	camLock sync.RWMutex

	writeLock sync.Mutex

	gateway VirtualDevice
}

func NewSwitch(debug bool, mtu int) *Switch {
	return &Switch{
		debug:               debug,
		maxTransmissionUnit: mtu,
		conns:               make(map[int]protocolConn),
		cam:                 make(map[tcpip.LinkAddress]int),
	}
}

func (e *Switch) CAM() map[string]int {
	e.camLock.RLock()
	defer e.camLock.RUnlock()
	ret := make(map[string]int)
	for address, port := range e.cam {
		ret[address.String()] = port
	}
	return ret
}

func (e *Switch) Connect(ep VirtualDevice) {
	e.gateway = ep
}

func (e *Switch) DeliverNetworkPacket(_ tcpip.NetworkProtocolNumber, pkt *stack.PacketBuffer) {
	if err := e.tx(pkt); err != nil {
		log.Error(err)
	}
}

func (e *Switch) Accept(ctx context.Context, rawConn net.Conn, protocol types.Protocol) error {
	conn := protocolConn{Conn: rawConn, protocolImpl: protocolImplementation(protocol)}
	log.Debugf("new connection from %s to %s", conn.RemoteAddr().String(), conn.LocalAddr().String())
	id, failed := e.connect(conn)
	if failed {
		log.Error("connection failed")
		return conn.Close()

	}

	defer func() {
		e.connLock.Lock()
		defer e.connLock.Unlock()
		e.disconnect(id, conn)
	}()
	if err := e.rx(ctx, id, conn); err != nil {
		log.Error(errors.Wrapf(err, "cannot receive packets from %s, disconnecting", conn.RemoteAddr().String()))
		return err
	}
	return nil
}

func (e *Switch) connect(conn protocolConn) (int, bool) {
	e.connLock.Lock()
	defer e.connLock.Unlock()

	id := e.nextConnID
	e.nextConnID++

	e.conns[id] = conn
	return id, false
}

func (e *Switch) tx(pkt *stack.PacketBuffer) error {
	return e.txPkt(pkt)
}

func (e *Switch) txPkt(pkt *stack.PacketBuffer) error {
	e.writeLock.Lock()
	defer e.writeLock.Unlock()

	e.connLock.Lock()
	defer e.connLock.Unlock()

	buf := pkt.ToView().AsSlice()
	eth := header.Ethernet(buf)
	dst := eth.DestinationAddress()
	src := eth.SourceAddress()

	size := pkt.Size()
	if size < 0 {
		return fmt.Errorf("packet size out of range")
	}
	if dst == header.EthernetBroadcastAddress {
		e.camLock.RLock()
		srcID, ok := e.cam[src]
		if !ok {
			srcID = -1
		}
		e.camLock.RUnlock()
		for id, conn := range e.conns {
			if id == srcID {
				continue
			}

			err := e.txBuf(id, conn, buf)
			if err != nil {
				return err
			}

			atomic.AddUint64(&e.Sent, uint64(size))
		}
	} else {
		e.camLock.RLock()
		id, ok := e.cam[dst]
		if !ok {
			e.camLock.RUnlock()
			return nil
		}
		e.camLock.RUnlock()
		conn := e.conns[id]
		err := e.txBuf(id, conn, buf)
		if err != nil {
			return err
		}
		atomic.AddUint64(&e.Sent, uint64(size))
	}
	return nil
}

func (e *Switch) txBuf(id int, conn protocolConn, buf []byte) error {
	if conn.protocolImpl.Stream() {
		size := conn.protocolImpl.(streamProtocol).Buf()
		conn.protocolImpl.(streamProtocol).Write(size, len(buf))
		buf = append(size, buf...)
	}
	for {
		if _, err := conn.Write(buf); err != nil {
			if errors.Is(err, syscall.ENOBUFS) {
				// socket buffer can be full keep retrying sending the same data
				// again until it works or we get a different error
				// https://github.com/containers/gvisor-tap-vsock/issues/367
				continue
			}
			e.disconnect(id, conn)
			return err
		}
		return nil
	}
}

func (e *Switch) disconnect(id int, conn net.Conn) {
	e.camLock.Lock()
	defer e.camLock.Unlock()

	for address, targetConn := range e.cam {
		if targetConn == id {
			delete(e.cam, address)
		}
	}
	_ = conn.Close()
	delete(e.conns, id)
}

func (e *Switch) rx(ctx context.Context, id int, conn protocolConn) error {
	if conn.protocolImpl.Stream() {
		return e.rxStream(ctx, id, conn, conn.protocolImpl.(streamProtocol))
	}
	return e.rxNonStream(ctx, id, conn)
}

func (e *Switch) rxNonStream(ctx context.Context, id int, conn net.Conn) error {
	bufSize := 1024 * 128
	buf := make([]byte, bufSize)
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		default:
			// passthrough
		}
		n, err := conn.Read(buf)
		if err != nil {
			return errors.Wrap(err, "cannot read size from socket")
		}
		e.rxBuf(ctx, id, buf[:n])
	}
	return nil
}

func (e *Switch) rxStream(ctx context.Context, id int, conn net.Conn, sProtocol streamProtocol) error {
	reader := bufio.NewReader(conn)
	sizeBuf := sProtocol.Buf()
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		default:
			// passthrough
		}
		_, err := io.ReadFull(reader, sizeBuf)
		if err != nil {
			return errors.Wrap(err, "cannot read size from socket")
		}
		size := sProtocol.Read(sizeBuf)

		buf := make([]byte, size)
		_, err = io.ReadFull(reader, buf)
		if err != nil {
			return errors.Wrap(err, "cannot read packet from socket")
		}
		e.rxBuf(ctx, id, buf)
	}
	return nil
}

func (e *Switch) rxBuf(_ context.Context, id int, buf []byte) {
	if e.debug {
		packet := gopacket.NewPacket(buf, layers.LayerTypeEthernet, gopacket.Default)
		log.Info(packet.String())
	}

	eth := header.Ethernet(buf)

	e.camLock.Lock()
	e.cam[eth.SourceAddress()] = id
	e.camLock.Unlock()

	if eth.DestinationAddress() != e.gateway.LinkAddress() {
		pkt := stack.NewPacketBuffer(stack.PacketBufferOptions{
			Payload: buffer.MakeWithData(buf),
		})
		if err := e.tx(pkt); err != nil {
			log.Error(err)
		}
		pkt.DecRef()
	}
	if eth.DestinationAddress() == e.gateway.LinkAddress() || eth.DestinationAddress() == header.EthernetBroadcastAddress {
		data := buffer.MakeWithData(buf)
		data.TrimFront(header.EthernetMinimumSize)
		pkt := stack.NewPacketBuffer(stack.PacketBufferOptions{
			Payload: data,
		})
		e.gateway.DeliverNetworkPacket(eth.Type(), pkt)
		pkt.DecRef()
	}

	atomic.AddUint64(&e.Received, uint64(len(buf)))
}

func protocolImplementation(protocol types.Protocol) protocol {
	switch protocol {
	case types.QemuProtocol:
		return &qemuProtocol{}
	case types.BessProtocol:
		return &bessProtocol{}
	case types.VfkitProtocol:
		return &vfkitProtocol{}
	default:
		return &hyperkitProtocol{}
	}
}

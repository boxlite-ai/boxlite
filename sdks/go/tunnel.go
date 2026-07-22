//go:build unix

package boxlite

/*
#include "bridge.h"
*/
import "C"
import (
	"context"
	"fmt"
	"net"
	"os"
)

// EndpointType identifies how clients can reach a box service tunnel.
type EndpointType int

const (
	EndpointTypeURL EndpointType = iota
	EndpointTypeFileDescriptor
)

// Endpoint describes the URI or prepared descriptor for a box service tunnel.
type Endpoint struct {
	Type EndpointType
	URI  string
	FD   int
}

// Network is a box-scoped handle for network operations.
type Network struct {
	handle *C.CBoxNetworkHandle
}

// Tunnel is a reusable connection target for a service inside a box.
type Tunnel struct {
	handle *C.CBoxTunnelHandle
}

// Network returns the box-scoped handle for network operations.
func (b *Box) Network() (*Network, error) {
	if b == nil || b.handle == nil {
		return nil, ErrRuntimeClosed
	}

	var cNetwork *C.CBoxNetworkHandle
	var cerr C.CBoxliteError
	code := C.boxlite_box_network(b.handle, &cNetwork, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	return &Network{handle: cNetwork}, nil
}

// Close releases the network handle.
func (n *Network) Close() error {
	if n != nil && n.handle != nil {
		C.boxlite_network_free(n.handle)
		n.handle = nil
	}
	return nil
}

// Tunnel prepares a one-shot endpoint for a service port inside the box.
func (n *Network) Tunnel(ctx context.Context, port uint16) (*Tunnel, error) {
	if n == nil || n.handle == nil {
		return nil, ErrRuntimeClosed
	}
	if port == 0 {
		return nil, fmt.Errorf("invalid tunnel port %d", port)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	var cTunnel *C.CBoxTunnelHandle
	var cerr C.CBoxliteError
	code := C.boxlite_network_tunnel(n.handle, C.uint16_t(port), &cTunnel, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	return &Tunnel{handle: cTunnel}, nil
}

// Close releases the tunnel handle.
func (t *Tunnel) Close() error {
	if t != nil && t.handle != nil {
		C.boxlite_tunnel_free(t.handle)
		t.handle = nil
	}
	return nil
}

// Endpoint returns the remote URI or borrowed local file descriptor.
func (t *Tunnel) Endpoint() (Endpoint, error) {
	if t == nil || t.handle == nil {
		return Endpoint{}, ErrRuntimeClosed
	}

	var endpointType C.enum_BoxliteEndpointType
	var uri *C.char
	var fd C.int32_t
	var cerr C.CBoxliteError
	code := C.boxlite_tunnel_endpoint(t.handle, &endpointType, &uri, &fd, &cerr)
	if code != C.Ok {
		return Endpoint{}, freeError(&cerr)
	}

	switch endpointType {
	case C.BoxliteEndpointTypeUri:
		defer C.boxlite_free_string(uri)
		return Endpoint{Type: EndpointTypeURL, URI: C.GoString(uri), FD: -1}, nil
	case C.BoxliteEndpointTypeFileDescriptor:
		return Endpoint{Type: EndpointTypeFileDescriptor, FD: int(fd)}, nil
	default:
		return Endpoint{}, fmt.Errorf("boxlite returned unknown endpoint type %d", endpointType)
	}
}

// Connect consumes the tunnel's single raw byte stream.
func (t *Tunnel) Connect(ctx context.Context) (net.Conn, error) {
	if t == nil || t.handle == nil {
		return nil, ErrRuntimeClosed
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	var cerr C.CBoxliteError
	var cFD C.int32_t
	code := C.boxlite_tunnel_connect(t.handle, &cFD, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}
	if cFD < 0 {
		return nil, fmt.Errorf("boxlite tunnel returned invalid fd")
	}
	file := os.NewFile(uintptr(cFD), "boxlite-tunnel")
	if file == nil {
		return nil, fmt.Errorf("boxlite tunnel returned invalid fd")
	}
	defer file.Close()
	conn, err := net.FileConn(file)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

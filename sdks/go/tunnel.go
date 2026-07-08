package boxlite

/*
#include <stdlib.h>
#include "bridge.h"
*/
import "C"
import (
	"context"
	"fmt"
	"net"
	"os"
	"unsafe"
)

// Tunnel opens a raw byte stream to target inside the box's guest network.
func (b *Box) Tunnel(ctx context.Context, target string) (net.Conn, error) {
	host, portText, err := net.SplitHostPort(target)
	if err != nil {
		return nil, err
	}
	port, err := net.LookupPort("tcp", portText)
	if err != nil {
		return nil, err
	}
	if port < 0 || port > 65535 {
		return nil, fmt.Errorf("invalid tunnel port %d", port)
	}
	return b.TunnelTCP(ctx, host, uint16(port))
}

// TunnelTCP opens a raw byte stream to host:port inside the box's guest network.
func (b *Box) TunnelTCP(ctx context.Context, targetIP string, targetPort uint16) (net.Conn, error) {
	return b.openTunnel(ctx, targetIP, targetPort)
}

// TunnelGuestPort opens a raw byte stream to port on the box's guest IP.
func (b *Box) TunnelGuestPort(ctx context.Context, targetPort uint16) (net.Conn, error) {
	return b.openTunnel(ctx, "", targetPort)
}

func (b *Box) openTunnel(ctx context.Context, targetIP string, targetPort uint16) (net.Conn, error) {
	if b.handle == nil {
		return nil, ErrRuntimeClosed
	}

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	var fd C.int
	var cerr C.CBoxliteError
	var code C.enum_BoxliteErrorCode
	if targetIP == "" {
		code = C.boxlite_box_tunnel_guest_port(b.handle, C.uint16_t(targetPort), &fd, &cerr)
	} else {
		cIP := C.CString(targetIP)
		defer C.free(unsafe.Pointer(cIP))
		code = C.boxlite_box_tunnel(b.handle, cIP, C.uint16_t(targetPort), &fd, &cerr)
	}
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	name := fmt.Sprintf("boxlite-tunnel-%d", targetPort)
	if targetIP != "" {
		name = fmt.Sprintf("boxlite-tunnel-%s-%d", targetIP, targetPort)
	}
	file := os.NewFile(uintptr(fd), name)
	if file == nil {
		_ = closeFd(int(fd))
		return nil, fmt.Errorf("boxlite tunnel returned invalid fd %d", int(fd))
	}
	defer file.Close()

	conn, err := net.FileConn(file)
	if err != nil {
		return nil, err
	}

	select {
	case <-ctx.Done():
		_ = conn.Close()
		return nil, ctx.Err()
	default:
		return conn, nil
	}
}

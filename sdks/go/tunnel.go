//go:build unix

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
	"syscall"
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
	return b.openTunnel(ctx, host, uint16(port))
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
	if targetIP == "" {
		return nil, fmt.Errorf("tunnel target IP is required")
	}
	cIP := C.CString(targetIP)
	defer C.free(unsafe.Pointer(cIP))
	code := C.boxlite_box_tunnel(b.handle, cIP, C.uint16_t(targetPort), &fd, &cerr)
	if code != C.Ok {
		return nil, freeError(&cerr)
	}

	name := fmt.Sprintf("boxlite-tunnel-%d", targetPort)
	if targetIP != "" {
		name = fmt.Sprintf("boxlite-tunnel-%s-%d", targetIP, targetPort)
	}
	file := os.NewFile(uintptr(fd), name)
	if file == nil {
		_ = syscall.Close(int(fd))
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

//go:build unix

package boxlite

/*
#include "bridge.h"
#include <stdlib.h>
#include <unistd.h>
*/
import "C"
import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"runtime/cgo"
	"strings"
	"sync"
	"unsafe"
)

// Network is a box-scoped handle for network operations.
type Network struct {
	handle  *C.CBoxNetworkHandle
	runtime *Runtime
}

type socketAddress struct {
	kind C.BoxliteSocketAddressKind
	host string
	port uint16
	path string
}

func TCPListenAddress(host string, port uint16) (net.Addr, error) {
	if host == "" {
		host = "127.0.0.1"
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil, fmt.Errorf("tunnel listener host must be a numeric IP: %q", host)
	}
	return &net.TCPAddr{IP: append(net.IP(nil), ip...), Port: int(port)}, nil
}

func UnixListenAddress(path string) (net.Addr, error) {
	if err := validateUnixListenPath(path); err != nil {
		return nil, err
	}
	return &net.UnixAddr{Name: path, Net: "unix"}, nil
}

func validateUnixListenPath(path string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("tunnel Unix socket path must be absolute: %q", path)
	}
	if strings.ContainsRune(path, '\x00') {
		return fmt.Errorf("tunnel Unix socket path must not contain NUL")
	}
	return nil
}

func parseListenAddress(listen net.Addr) (socketAddress, error) {
	switch address := listen.(type) {
	case *net.TCPAddr:
		if address == nil || address.Port < 0 || address.Port > 65535 {
			return socketAddress{}, fmt.Errorf("invalid TCP tunnel listener address")
		}
		if address.Zone != "" {
			return socketAddress{}, fmt.Errorf("TCP tunnel listener zones are not supported")
		}
		ip := address.IP
		if len(ip) == 0 {
			ip = net.IPv4(127, 0, 0, 1)
		}
		if ip.To4() == nil && ip.To16() == nil {
			return socketAddress{}, fmt.Errorf("TCP tunnel listener must use a numeric IP")
		}
		return socketAddress{
			kind: C.BoxliteSocketTcp,
			host: ip.String(),
			port: uint16(address.Port),
		}, nil
	case *net.UnixAddr:
		if address == nil || address.Net != "unix" {
			return socketAddress{}, fmt.Errorf("tunnel Unix listener must be an absolute filesystem stream socket")
		}
		if err := validateUnixListenPath(address.Name); err != nil {
			return socketAddress{}, err
		}
		return socketAddress{kind: C.BoxliteSocketUnix, path: address.Name}, nil
	default:
		return socketAddress{}, fmt.Errorf("tunnel listener must be *net.TCPAddr or *net.UnixAddr")
	}
}

type TunnelForwarder struct {
	mu      sync.Mutex
	handle  *C.CTunnelForwarderHandle
	runtime *Runtime
	address net.Addr
}

// BoxTunnel is a prepared one-shot tunnel to a service inside a box.
type BoxTunnel struct {
	mu      sync.Mutex
	handle  *C.CBoxTunnelHandle
	runtime *Runtime
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

	return &Network{handle: cNetwork, runtime: b.runtime}, nil
}

func (f *TunnelForwarder) Addr() net.Addr {
	if f == nil {
		return nil
	}
	defer runtime.KeepAlive(f)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.handle == nil {
		return nil
	}
	return cloneAddr(f.address)
}

func (f *TunnelForwarder) Wait(ctx context.Context) error {
	if f == nil {
		return ErrRuntimeClosed
	}
	defer runtime.KeepAlive(f)
	f.mu.Lock()
	if f.handle == nil || f.runtime == nil {
		f.mu.Unlock()
		return ErrRuntimeClosed
	}
	runtimeHandle := f.runtime
	select {
	case <-runtimeHandle.closing:
		f.mu.Unlock()
		return ErrRuntimeClosed
	default:
	}
	runtimeHandle.ensureDrainRunning()
	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	code := C.boxlite_tunnel_forwarder_wait(f.handle, C.cbTunnelForwarderWait(), handleToPtr(h), &cerr)
	f.mu.Unlock()
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}
	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		abandonAsyncErr(ch, h, runtimeHandle.closing, runtimeHandle.drainDone)
		return ctx.Err()
	case <-runtimeHandle.closing:
		abandonAsyncErr(ch, h, runtimeHandle.closing, runtimeHandle.drainDone)
		return ErrRuntimeClosed
	}
}

func (f *TunnelForwarder) Close() error {
	if f == nil {
		return nil
	}
	defer runtime.KeepAlive(f)
	f.mu.Lock()
	if f.handle == nil || f.runtime == nil {
		f.mu.Unlock()
		return nil
	}
	runtimeHandle := f.runtime
	select {
	case <-runtimeHandle.closing:
		f.mu.Unlock()
		return ErrRuntimeClosed
	default:
	}
	runtimeHandle.ensureDrainRunning()
	ch := make(chan error, 1)
	h := registerHandleForDispatch(cgo.NewHandle(ch))
	var cerr C.CBoxliteError
	code := C.boxlite_tunnel_forwarder_close(f.handle, C.cbTunnelForwarderClose(), handleToPtr(h), &cerr)
	f.mu.Unlock()
	if code != C.Ok {
		deleteHandleForDispatch(h)
		return freeError(&cerr)
	}
	select {
	case err := <-ch:
		return err
	case <-runtimeHandle.closing:
		abandonAsyncErr(ch, h, runtimeHandle.closing, runtimeHandle.drainDone)
		return ErrRuntimeClosed
	}
}

func (f *TunnelForwarder) free() {
	if f == nil {
		return
	}
	runtime.SetFinalizer(f, nil)
	f.mu.Lock()
	handle := f.handle
	f.handle = nil
	f.mu.Unlock()
	if handle != nil {
		C.boxlite_tunnel_forwarder_free(handle)
	}
}

// Close releases the network handle.
func (n *Network) Close() error {
	if n != nil && n.handle != nil {
		C.boxlite_network_free(n.handle)
		n.handle = nil
	}
	return nil
}

// Tunnel prepares a one-shot tunnel to a service port inside the box.
func (n *Network) Tunnel(ctx context.Context, port uint16) (*BoxTunnel, error) {
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
	tunnel := &BoxTunnel{handle: cTunnel, runtime: n.runtime}
	runtime.SetFinalizer(tunnel, (*BoxTunnel).Close)
	return tunnel, nil
}

func (t *BoxTunnel) take() (*C.CBoxTunnelHandle, error) {
	if t == nil {
		return nil, ErrRuntimeClosed
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.handle == nil {
		return nil, ErrRuntimeClosed
	}
	runtime.SetFinalizer(t, nil)
	handle := t.handle
	t.handle = nil
	return handle, nil
}

// Close releases an unconsumed tunnel.
func (t *BoxTunnel) Close() error {
	if t == nil {
		return nil
	}
	runtime.SetFinalizer(t, nil)
	t.mu.Lock()
	if t.handle == nil {
		t.mu.Unlock()
		return nil
	}
	handle := t.handle
	t.handle = nil
	t.mu.Unlock()
	if handle != nil {
		C.boxlite_tunnel_free(handle)
	}
	return nil
}

// URI returns the prepared tunnel's public URL. An empty string means local.
func (t *BoxTunnel) URI() (string, error) {
	if t == nil {
		return "", ErrRuntimeClosed
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.handle == nil {
		return "", ErrRuntimeClosed
	}
	var uri *C.char
	var cerr C.CBoxliteError
	if code := C.boxlite_tunnel_uri(t.handle, &uri, &cerr); code != C.Ok {
		return "", freeError(&cerr)
	}
	if uri == nil {
		return "", nil
	}
	defer C.boxlite_free_string(uri)
	return C.GoString(uri), nil
}

// Connect consumes the tunnel's single raw byte stream.
func (t *BoxTunnel) Connect(ctx context.Context) (net.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	handle, err := t.take()
	if err != nil {
		return nil, err
	}
	defer C.boxlite_tunnel_free(handle)
	var cerr C.CBoxliteError
	var cFD C.int32_t
	if code := C.boxlite_tunnel_connect(handle, &cFD, &cerr); code != C.Ok {
		return nil, freeError(&cerr)
	}
	if cFD < 0 {
		return nil, fmt.Errorf("boxlite tunnel returned invalid fd")
	}
	file := os.NewFile(uintptr(cFD), "boxlite-tunnel")
	if file == nil {
		_ = C.close(C.int(cFD))
		return nil, fmt.Errorf("boxlite tunnel returned invalid fd")
	}
	connection, err := net.FileConn(file)
	_ = file.Close()
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		_ = connection.Close()
		return nil, err
	}
	return connection, nil
}

func tunnelForwarderAddress(handle *C.CTunnelForwarderHandle) (net.Addr, error) {
	var address *C.char
	var cerr C.CBoxliteError
	if C.boxlite_tunnel_forwarder_address(handle, &address, &cerr) != C.Ok {
		return nil, freeError(&cerr)
	}
	defer C.boxlite_free_string(address)
	value := C.GoString(address)
	if strings.HasPrefix(value, "unix:") {
		return &net.UnixAddr{Name: strings.TrimPrefix(value, "unix:"), Net: "unix"}, nil
	}
	parsed, err := net.ResolveTCPAddr("tcp", strings.TrimPrefix(value, "tcp://"))
	if err != nil {
		return nil, fmt.Errorf("parse tunnel listener address %q: %w", value, err)
	}
	return parsed, nil
}

func cloneAddr(address net.Addr) net.Addr {
	switch address := address.(type) {
	case *net.TCPAddr:
		clone := *address
		clone.IP = append(net.IP(nil), address.IP...)
		return &clone
	case *net.UnixAddr:
		clone := *address
		return &clone
	default:
		return nil
	}
}

// Forward binds a local listener and forwards each client through a fresh connection.
func (t *BoxTunnel) Forward(ctx context.Context, listen net.Addr) (*TunnelForwarder, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	address, err := parseListenAddress(listen)
	if err != nil {
		return nil, err
	}
	handle, err := t.take()
	if err != nil {
		return nil, err
	}
	defer C.boxlite_tunnel_free(handle)
	var host, path *C.char
	if address.host != "" {
		host = C.CString(address.host)
		defer C.free(unsafe.Pointer(host))
	}
	if address.path != "" {
		path = C.CString(address.path)
		defer C.free(unsafe.Pointer(path))
	}
	cAddress := C.BoxliteSocketAddress{
		kind: address.kind,
		host: host,
		port: C.uint16_t(address.port),
		path: path,
	}
	var forwarderHandle *C.CTunnelForwarderHandle
	var cerr C.CBoxliteError
	if code := C.boxlite_tunnel_forward(handle, &cAddress, &forwarderHandle, &cerr); code != C.Ok {
		return nil, freeError(&cerr)
	}
	canonical, err := tunnelForwarderAddress(forwarderHandle)
	if err != nil {
		C.boxlite_tunnel_forwarder_free(forwarderHandle)
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		C.boxlite_tunnel_forwarder_free(forwarderHandle)
		return nil, err
	}
	forwarder := &TunnelForwarder{handle: forwarderHandle, runtime: t.runtime, address: canonical}
	runtime.SetFinalizer(forwarder, (*TunnelForwarder).free)
	return forwarder, nil
}

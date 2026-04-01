//go:build darwin
// +build darwin

package transport

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"net"
	"syscall"
)

type connectedUnixgramConn struct {
	*net.UnixConn
	remoteAddr *net.UnixAddr
}

func connectListeningUnixgramConn(conn *net.UnixConn, remoteAddr *net.UnixAddr) (*connectedUnixgramConn, error) {
	rawConn, err := conn.SyscallConn()
	if err != nil {
		return nil, err
	}
	err = rawConn.Control(func(fd uintptr) {
		if err = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF, 1*1024*1024); err != nil {
			return
		}
		if err = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, 4*1024*1024); err != nil {
			return
		}
	})
	if err != nil {
		return nil, err
	}

	return &connectedUnixgramConn{
		UnixConn:   conn,
		remoteAddr: remoteAddr,
	}, nil
}

func (conn *connectedUnixgramConn) RemoteAddr() net.Addr {
	return conn.remoteAddr
}

func (conn *connectedUnixgramConn) Write(b []byte) (int, error) {
	return conn.WriteTo(b, conn.remoteAddr)
}

func AcceptVfkit(listeningConn *net.UnixConn) (net.Conn, error) {
	vfkitMagic := make([]byte, 4)
	// the main reason for this magic check is to get the address to use to send data to the vfkit VM
	bytesRead, vfkitAddr, err := listeningConn.ReadFrom(vfkitMagic)
	if bytesRead != len(vfkitMagic) {
		return nil, fmt.Errorf("invalid magic length: %d", len(vfkitMagic))
	}
	if err != nil {
		return nil, err
	}
	if _, ok := vfkitAddr.(*net.UnixAddr); !ok {
		return nil, fmt.Errorf("unexpected type for vfkit unix sockaddr: %t", vfkitAddr)
	}
	if !bytes.Equal(vfkitMagic, []byte("VFKT")) {
		return nil, fmt.Errorf("invalid magic from the vfkit process: %s", hex.EncodeToString(vfkitMagic))
	}
	return connectListeningUnixgramConn(listeningConn, vfkitAddr.(*net.UnixAddr))
}

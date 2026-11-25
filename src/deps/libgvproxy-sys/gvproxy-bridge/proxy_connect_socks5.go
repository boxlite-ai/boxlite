package main

import (
	"encoding/binary"
	"io"
	"net/netip"
)

func connectSOCKS5(conn io.ReadWriter, target netip.AddrPort, credential *proxyCredentials) error {
	method := byte(0)
	if credential != nil {
		method = 2
	}
	var selection [2]byte
	if _, err := conn.Write([]byte{5, 1, method}); err != nil {
		return proxyHandshakeFailed
	}
	if _, err := io.ReadFull(conn, selection[:]); err != nil || selection[0] != 5 {
		return proxyHandshakeFailed
	}
	if selection[1] != method {
		return proxyAuthFailed
	}
	if credential != nil {
		if err := authenticateSOCKS5(conn, *credential); err != nil {
			return err
		}
	}

	ip := target.Addr().As4()
	request := [10]byte{5, 1, 0, 1, ip[0], ip[1], ip[2], ip[3]}
	binary.BigEndian.PutUint16(request[8:], target.Port())
	if _, err := conn.Write(request[:]); err != nil {
		return proxyHandshakeFailed
	}
	return readSOCKS5Reply(conn)
}

func authenticateSOCKS5(conn io.ReadWriter, credential proxyCredentials) error {
	request := []byte{1, byte(len(credential.username))}
	request = append(request, credential.username...)
	request = append(request, byte(len(credential.password)))
	request = append(request, credential.password...)
	if _, err := conn.Write(request); err != nil {
		return proxyHandshakeFailed
	}
	var response [2]byte
	if _, err := io.ReadFull(conn, response[:]); err != nil || response[0] != 1 {
		return proxyHandshakeFailed
	}
	if response[1] != 0 {
		return proxyAuthFailed
	}
	return nil
}

func readSOCKS5Reply(conn io.Reader) error {
	var header [4]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil || header[0] != 5 || header[2] != 0 {
		return proxyHandshakeFailed
	}
	var addressLen int64
	switch header[3] {
	case 1:
		addressLen = 4
	case 4:
		addressLen = 16
	case 3:
		var size [1]byte
		if _, err := io.ReadFull(conn, size[:]); err != nil || size[0] == 0 {
			return proxyHandshakeFailed
		}
		addressLen = int64(size[0])
	default:
		return proxyHandshakeFailed
	}
	if _, err := io.CopyN(io.Discard, conn, addressLen+2); err != nil {
		return proxyHandshakeFailed
	}
	switch header[1] {
	case 0:
		return nil
	case 4, 5: // Host unreachable or connection refused for this destination.
		return errProxyCandidate
	default:
		return proxyHandshakeFailed
	}
}

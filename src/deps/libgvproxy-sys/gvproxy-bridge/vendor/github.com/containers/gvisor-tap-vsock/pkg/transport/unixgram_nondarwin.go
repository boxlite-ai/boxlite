//go:build !darwin
// +build !darwin

package transport

import (
	"errors"
	"net"
)

func ListenUnixgram(_ string) (net.Conn, error) {
	return nil, errors.New("unsupported 'unixgram' scheme")
}

func AcceptVfkit(_ net.Conn) (net.Conn, error) {
	return nil, errors.New("vfkit is unsupported on this platform")
}
